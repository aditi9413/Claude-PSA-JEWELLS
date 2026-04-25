/**
 * Bulk-set Search & Discovery "Complementary products" on a Shopify store.
 *
 * Writes the metafield that the free Search & Discovery app reads:
 *   namespace: shopify--discovery--product_recommendation
 *   key:       complementary_products
 *   type:      list.product_reference
 *
 * Once written, those bundles show up everywhere Shopify exposes complementary
 * data — including the bundle-pdp.liquid / bundle-cart.liquid snippets in this
 * repo (they call /recommendations/products.json?intent=complementary).
 *
 * ── Setup (one-time) ────────────────────────────────────────────────────────
 * 1. In Shopify admin: Settings → Apps and sales channels → Develop apps
 *    → Create an app (e.g. "PSA Bulk Complementary")
 *    → Configure Admin API scopes → enable:
 *        read_products
 *        write_products
 *    → Save → Install app → reveal the Admin API access token (starts shpat_)
 *
 * 2. Make sure Node 18+ is installed (built-in fetch). Check: node --version
 *
 * 3. From the repo root:
 *        export SHOPIFY_STORE=psajewels.myshopify.com   # NOT the .com domain
 *        export SHOPIFY_TOKEN=shpat_xxxxxxxxxxxxxxxxxxxx
 *
 * 4. Tweak RULES below to match your product_type values.
 *
 * 5. Preview first (no writes):
 *        node scripts/bulk-complementary.js --dry-run
 *
 * 6. Apply:
 *        node scripts/bulk-complementary.js
 *
 * Re-run any time. It overwrites the complementary list each time, so you can
 * iterate the rules and just re-run.
 * ─────────────────────────────────────────────────────────────────────────── */

const STORE = process.env.SHOPIFY_STORE;
const TOKEN = process.env.SHOPIFY_TOKEN;
const DRY = process.argv.includes('--dry-run');

if (!STORE || !TOKEN) {
  console.error('Missing env vars. Set SHOPIFY_STORE and SHOPIFY_TOKEN. See top of file.');
  process.exit(1);
}

/* ── RULES ─────────────────────────────────────────────────────────────────
 *   Keys = the product_type of the seed product (case-insensitive).
 *   Values = product_type list to pull complementary candidates from.
 *
 *   Edit these to match what you actually use as "Product type" in Shopify
 *   admin. If a seed product's type isn't a key here, it's skipped.
 * ────────────────────────────────────────────────────────────────────────── */
const RULES = {
  'idols':           ['diyas', 'bells', 'pooja thali', 'agarbatti stand', 'pooja samagri'],
  'diyas':           ['idols', 'agarbatti stand', 'pooja thali'],
  'bells':           ['idols', 'pooja thali', 'pooja samagri'],
  'pooja thali':     ['idols', 'diyas', 'bells', 'pooja samagri'],
  'pooja samagri':   ['idols', 'diyas', 'pooja thali'],
  'agarbatti stand': ['idols', 'diyas'],
  'mala':            ['coins', 'pendants', 'idols'],
  'coins':           ['idols', 'mala', 'pooja samagri'],
  'pendants':        ['mala', 'earrings', 'bracelets'],
  'earrings':        ['pendants', 'bracelets'],
  'bracelets':       ['pendants', 'earrings'],
  'gift hampers':    ['idols', 'pooja samagri', 'mala'],
};

const COMP_PER_PRODUCT = 4;        // how many complementary suggestions per product
const RANDOMIZE = true;            // shuffle pool before picking, so re-runs vary
const RATE_LIMIT_MS = 350;         // sleep between writes to stay under API throttle

const ENDPOINT = `https://${STORE}/admin/api/2024-10/graphql.json`;

async function gql(query, variables = {}) {
  const r = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'X-Shopify-Access-Token': TOKEN,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`);
  const j = await r.json();
  if (j.errors) throw new Error(JSON.stringify(j.errors));
  return j.data;
}

async function fetchAllProducts() {
  const products = [];
  let cursor = null;
  while (true) {
    const data = await gql(
      `query($cursor: String) {
        products(first: 100, after: $cursor) {
          edges {
            cursor
            node { id productType title status }
          }
          pageInfo { hasNextPage }
        }
      }`,
      { cursor },
    );
    for (const e of data.products.edges) {
      if (e.node.status === 'ACTIVE') products.push(e.node);
    }
    if (!data.products.pageInfo.hasNextPage) break;
    cursor = data.products.edges[data.products.edges.length - 1].cursor;
  }
  return products;
}

async function setComplementary(productId, comp) {
  const value = JSON.stringify(comp.map(p => p.id));
  return gql(
    `mutation($id: ID!, $metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        userErrors { field message }
      }
    }`,
    {
      id: productId,
      metafields: [{
        ownerId: productId,
        namespace: 'shopify--discovery--product_recommendation',
        key: 'complementary_products',
        type: 'list.product_reference',
        value,
      }],
    },
  );
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  console.log(`Store: ${STORE} | mode: ${DRY ? 'DRY RUN' : 'WRITE'}`);
  console.log('Fetching all active products…');
  const all = await fetchAllProducts();
  console.log(`Found ${all.length} active products`);

  const byType = {};
  for (const p of all) {
    const t = (p.productType || '').toLowerCase().trim();
    if (!t) continue;
    (byType[t] = byType[t] || []).push(p);
  }

  console.log('\nProduct types in store:');
  for (const [t, ps] of Object.entries(byType).sort()) {
    console.log(`  ${t.padEnd(20)} ${ps.length}`);
  }

  const noType = all.filter(p => !(p.productType || '').trim());
  if (noType.length) {
    console.log(`\n⚠  ${noType.length} products have no product_type — they will be skipped.`);
  }

  let updated = 0, skipped = 0, errored = 0;
  console.log('\nProcessing…\n');

  for (const seed of all) {
    const seedType = (seed.productType || '').toLowerCase().trim();
    const targetTypes = RULES[seedType];
    if (!targetTypes) { skipped++; continue; }

    let pool = [];
    for (const t of targetTypes) {
      const list = byType[t.toLowerCase().trim()] || [];
      for (const p of list) if (p.id !== seed.id) pool.push(p);
    }

    if (RANDOMIZE) pool.sort(() => Math.random() - 0.5);
    const picked = pool.slice(0, COMP_PER_PRODUCT);
    if (!picked.length) { skipped++; continue; }

    const titles = picked.map(p => `${p.title} [${p.productType || '-'}]`).join('  ·  ');
    console.log(`✦ ${seed.title} [${seed.productType}]`);
    console.log(`    → ${titles}\n`);

    if (!DRY) {
      try {
        const res = await setComplementary(seed.id, picked);
        const errs = res.metafieldsSet.userErrors;
        if (errs.length) {
          console.error(`    ✗ ${JSON.stringify(errs)}`);
          errored++;
        } else {
          updated++;
        }
      } catch (e) {
        console.error(`    ✗ ${e.message}`);
        errored++;
      }
      await sleep(RATE_LIMIT_MS);
    } else {
      updated++;
    }
  }

  console.log('\n────────────────────────────────────────');
  console.log(`Total products    : ${all.length}`);
  console.log(`Updated           : ${updated}${DRY ? ' (would be)' : ''}`);
  console.log(`Skipped           : ${skipped}  (no rule or empty pool)`);
  if (errored) console.log(`Errors            : ${errored}`);
  console.log(DRY ? '\nThis was a DRY RUN. Drop --dry-run to apply.' : '\nDone. Allow ~1-2 min for Shopify to surface the new recommendations.');
})().catch(e => {
  console.error('\nFatal:', e.message);
  process.exit(1);
});
