// Reorders sold-out products to the bottom of every MANUAL-sort collection.
// Runs against the Shopify Admin GraphQL API. Designed to be invoked by a
// scheduled job (GitHub Actions, Cloudflare Workers, etc.) every few minutes.
//
// Required environment variables:
//   SHOPIFY_SHOP        e.g. "psa-jewels-store.myshopify.com"
//   SHOPIFY_ADMIN_TOKEN Admin API access token from your custom app
//
// Optional:
//   SHOPIFY_API_VERSION default "2024-10"
//   COLLECTION_HANDLES  comma-separated handles to limit scope
//                       (otherwise every manual collection is processed)

const SHOP = process.env.SHOPIFY_SHOP;
const TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;
const API_VERSION = process.env.SHOPIFY_API_VERSION || '2024-10';
const HANDLE_FILTER = (process.env.COLLECTION_HANDLES || '')
  .split(',')
  .map((h) => h.trim())
  .filter(Boolean);

if (!SHOP || !TOKEN) {
  console.error('Missing SHOPIFY_SHOP or SHOPIFY_ADMIN_TOKEN');
  process.exit(1);
}

const ENDPOINT = `https://${SHOP}/admin/api/${API_VERSION}/graphql.json`;

async function gql(query, variables = {}) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': TOKEN,
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) {
    throw new Error(`GraphQL: ${JSON.stringify(json.errors)}`);
  }
  return json.data;
}

async function listManualCollections() {
  const out = [];
  let cursor = null;
  while (true) {
    const data = await gql(
      `query($cursor: String) {
        collections(first: 100, after: $cursor) {
          edges {
            cursor
            node { id handle title sortOrder }
          }
          pageInfo { hasNextPage }
        }
      }`,
      { cursor }
    );
    const edges = data.collections.edges;
    out.push(...edges.map((e) => e.node).filter((c) => c.sortOrder === 'MANUAL'));
    if (!data.collections.pageInfo.hasNextPage) break;
    cursor = edges[edges.length - 1].cursor;
  }
  return HANDLE_FILTER.length
    ? out.filter((c) => HANDLE_FILTER.includes(c.handle))
    : out;
}

async function listCollectionProducts(collectionId) {
  const out = [];
  let cursor = null;
  while (true) {
    const data = await gql(
      `query($id: ID!, $cursor: String) {
        collection(id: $id) {
          products(first: 250, after: $cursor) {
            edges { cursor node { id availableForSale } }
            pageInfo { hasNextPage }
          }
        }
      }`,
      { id: collectionId, cursor }
    );
    const edges = data.collection.products.edges;
    out.push(...edges.map((e) => e.node));
    if (!data.collection.products.pageInfo.hasNextPage) break;
    cursor = edges[edges.length - 1].cursor;
  }
  return out;
}

async function reorderCollection(collectionId, moves) {
  const data = await gql(
    `mutation($id: ID!, $moves: [MoveInput!]!) {
      collectionReorderProducts(id: $id, moves: $moves) {
        job { id done }
        userErrors { field message }
      }
    }`,
    { id: collectionId, moves }
  );
  const result = data.collectionReorderProducts;
  if (result.userErrors && result.userErrors.length) {
    throw new Error(`reorder errors: ${JSON.stringify(result.userErrors)}`);
  }
  return result.job;
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function processCollection(col) {
  const products = await listCollectionProducts(col.id);
  const inStock = products.filter((p) => p.availableForSale);
  const soldOut = products.filter((p) => !p.availableForSale);
  const newOrder = [...inStock, ...soldOut];

  const moves = [];
  newOrder.forEach((p, newIndex) => {
    const oldIndex = products.findIndex((q) => q.id === p.id);
    if (oldIndex !== newIndex) {
      moves.push({ id: p.id, newPosition: String(newIndex) });
    }
  });

  if (!moves.length) {
    console.log(`= ${col.handle} (${products.length} products, no change)`);
    return;
  }

  // Shopify caps moves per call. Send in chunks of 250 to be safe.
  for (const batch of chunk(moves, 250)) {
    await reorderCollection(col.id, batch);
  }
  console.log(
    `✓ ${col.handle}: reordered ${moves.length}/${products.length} products`
  );
}

async function main() {
  const collections = await listManualCollections();
  console.log(`Processing ${collections.length} manual collections...`);

  for (const col of collections) {
    try {
      await processCollection(col);
    } catch (err) {
      console.error(`! ${col.handle}: ${err.message}`);
    }
  }

  console.log('Done.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
