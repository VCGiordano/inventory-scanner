
const express = require("express");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const SHOPIFY_STORE = process.env.SHOPIFY_STORE || process.env.SHOPIFY_SHOP;
const SHOPIFY_CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const SHOPIFY_CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;
const SHOPIFY_LOCATION_ID = process.env.SHOPIFY_LOCATION_ID;
const APP_PIN = process.env.APP_PIN || "1234";

let cachedToken = null;
let tokenExpiresAt = 0;
let lastScan = null;
let lastScanAtByBarcode = new Map();

function cleanShopHost(raw) {
  if (!raw) return "";
  let shop = raw.trim();
  shop = shop.replace(/^https?:\/\//i, "").replace(/\/.*$/, "");
  if (!shop.endsWith(".myshopify.com")) shop = `${shop}.myshopify.com`;
  return shop;
}

const SHOP_HOST = cleanShopHost(SHOPIFY_STORE);

function requireEnv() {
  const missing = [];
  if (!SHOP_HOST) missing.push("SHOPIFY_STORE");
  if (!SHOPIFY_CLIENT_ID) missing.push("SHOPIFY_CLIENT_ID");
  if (!SHOPIFY_CLIENT_SECRET) missing.push("SHOPIFY_CLIENT_SECRET");
  if (!SHOPIFY_LOCATION_ID) missing.push("SHOPIFY_LOCATION_ID");
  return missing;
}

function locationGid() {
  if (!SHOPIFY_LOCATION_ID) return null;
  if (SHOPIFY_LOCATION_ID.startsWith("gid://shopify/Location/")) return SHOPIFY_LOCATION_ID;
  return `gid://shopify/Location/${SHOPIFY_LOCATION_ID}`;
}

async function getAccessToken() {
  if (cachedToken && Date.now() < tokenExpiresAt - 60_000) return cachedToken;

  const url = `https://${SHOP_HOST}/admin/oauth/access_token`;
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: SHOPIFY_CLIENT_ID,
    client_secret: SHOPIFY_CLIENT_SECRET
  });

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(`Token request failed (${response.status}): ${text}`);
  }

  const data = JSON.parse(text);
  cachedToken = data.access_token;
  tokenExpiresAt = Date.now() + ((data.expires_in || 3600) * 1000);
  return cachedToken;
}

async function shopifyGraphql(query, variables = {}) {
  const token = await getAccessToken();

  const response = await fetch(`https://${SHOP_HOST}/admin/api/2025-10/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": token
    },
    body: JSON.stringify({ query, variables })
  });

  const json = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(`GraphQL HTTP error (${response.status}): ${JSON.stringify(json)}`);
  }

  if (json.errors) {
    throw new Error(`GraphQL error: ${JSON.stringify(json.errors)}`);
  }

  return json.data;
}

function escapeSearchValue(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"').trim();
}

async function findVariantByBarcode(barcode) {
  const queryString = `barcode:${escapeSearchValue(barcode)}`;

  const query = `
    query FindVariant($query: String!, $locationId: ID!) {
      productVariants(first: 5, query: $query) {
        edges {
          node {
            id
            title
            sku
            barcode
            inventoryItem {
              id
              tracked
              inventoryLevel(locationId: $locationId) {
                quantities(names: ["available"]) {
                  name
                  quantity
                }
              }
            }
            product {
              title
              vendor
            }
          }
        }
      }
    }
  `;

  const data = await shopifyGraphql(query, {
    query: queryString,
    locationId: locationGid()
  });

  const variants = data.productVariants.edges.map(e => e.node);

  if (variants.length === 0) {
    throw new Error(`No Shopify variant found for barcode: ${barcode}`);
  }

  if (variants.length > 1) {
    throw new Error(`Duplicate barcode found on ${variants.length} variants. Fix this barcode before using scanner.`);
  }

  const variant = variants[0];

  if (!variant.inventoryItem?.tracked) {
    throw new Error(`Found product, but inventory is not tracked for this variant.`);
  }

  const available = variant.inventoryItem.inventoryLevel?.quantities?.[0]?.quantity;

  if (available === undefined || available === null) {
    throw new Error(`Found product, but no inventory level exists at this Shopify location.`);
  }

  return { variant, available };
}

async function adjustInventory({ barcode, delta }) {
  const { variant, available } = await findVariantByBarcode(barcode);

  if (delta < 0 && available <= 0) {
    throw new Error(`Inventory is already ${available}. Not subtracting.`);
  }

  const mutation = `
    mutation AdjustInventory($input: InventoryAdjustQuantitiesInput!) {
      inventoryAdjustQuantities(input: $input) {
        userErrors {
          field
          message
        }
        inventoryAdjustmentGroup {
          createdAt
          reason
          changes {
            name
            delta
          }
        }
      }
    }
  `;

  const input = {
    reason: "correction",
    name: "available",
    referenceDocumentUri: `bernies-scanner://${Date.now()}-${crypto.randomUUID()}`,
    changes: [
      {
        delta,
        inventoryItemId: variant.inventoryItem.id,
        locationId: locationGid()
      }
    ]
  };

  const data = await shopifyGraphql(mutation, { input });
  const result = data.inventoryAdjustQuantities;

  if (result.userErrors && result.userErrors.length) {
    throw new Error(result.userErrors.map(e => e.message).join("; "));
  }

  const newAvailable = available + delta;

  lastScan = {
    barcode,
    delta,
    undoDelta: -delta,
    productTitle: variant.product.title,
    variantTitle: variant.title,
    sku: variant.sku,
    before: available,
    after: newAvailable,
    at: new Date().toISOString()
  };

  return lastScan;
}

function page({ message = "", error = "", last = null } = {}) {
  const missing = requireEnv();

  return `
<!doctype html>
<html>
<head>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Bernie's Scanner</title>
  <style>
    body { margin:0; font-family: Arial, sans-serif; background:#101418; color:#fff; }
    .wrap { max-width:520px; margin:0 auto; padding:18px; }
    h1 { font-size:26px; margin:10px 0 4px; }
    .sub { opacity:.75; margin-bottom:16px; }
    .card { background:#1b222b; border:1px solid #2e3945; border-radius:16px; padding:16px; margin:14px 0; }
    input, select { width:100%; box-sizing:border-box; font-size:22px; padding:16px; border-radius:12px; border:1px solid #44515f; background:#0e1318; color:white; margin:8px 0 12px; }
    button { width:100%; font-size:20px; font-weight:700; padding:16px; border:0; border-radius:12px; cursor:pointer; margin-top:8px; }
    .minus { background:#ff4d4d; color:white; }
    .plus { background:#2fc36b; color:#07140b; }
    .undo { background:#f4c542; color:#171200; }
    .ok { background:#103d24; border-color:#2fc36b; color:#b9ffd0; }
    .err { background:#441616; border-color:#ff5e5e; color:#ffd0d0; }
    .muted { color:#aab4bf; font-size:14px; line-height:1.4; }
    .big { font-size:22px; font-weight:800; }
    code { background:#0e1318; padding:2px 5px; border-radius:4px; }
  </style>
</head>
<body>
  <div class="wrap">
    <h1>Bernie's Inventory Scanner</h1>
    <div class="sub">Minus mode default. No Shopify orders created.</div>

    ${missing.length ? `<div class="card err"><div class="big">Missing Railway variables</div><p>Add these in Railway:</p><p>${missing.map(x => `<code>${x}</code>`).join("<br>")}</p></div>` : ""}

    ${message ? `<div class="card ok"><div class="big">${message}</div></div>` : ""}
    ${error ? `<div class="card err"><div class="big">Error</div><p>${error}</p></div>` : ""}

    <div class="card">
      <form method="POST" action="/scan">
        <label class="muted">Barcode</label>
        <input id="barcode" name="barcode" placeholder="Scan or type barcode" autofocus autocomplete="off" inputmode="numeric">

        <label class="muted">Mode</label>
        <select name="mode">
          <option value="minus" selected>Minus / Sold item (-1)</option>
          <option value="plus">Plus / Add back (+1) — PIN required</option>
        </select>

        <label class="muted">PIN only for Plus mode</label>
        <input name="pin" placeholder="PIN for plus mode" autocomplete="off">

        <button class="minus" type="submit">SCAN / ADJUST</button>
      </form>
    </div>

    ${last ? `
      <div class="card">
        <div class="muted">Last adjustment</div>
        <div class="big">${last.delta > 0 ? "+" : ""}${last.delta} | ${last.productTitle}</div>
        <p>${last.variantTitle || ""}</p>
        <p class="muted">SKU: ${last.sku || "n/a"}<br>Barcode: ${last.barcode}<br>Before: ${last.before} → After: ${last.after}</p>
        <form method="POST" action="/undo">
          <button class="undo" type="submit">UNDO LAST SCAN</button>
        </form>
      </div>
    ` : ""}

    <div class="card muted">
      <p><b>Status:</b> ${SHOP_HOST || "missing store"} | Location: ${SHOPIFY_LOCATION_ID || "missing"}</p>
      <p>Keep this page bookmarked. Scanner should behave like keyboard input.</p>
    </div>
  </div>

  <script>
    const input = document.getElementById('barcode');
    if (input) input.focus();
    document.addEventListener('click', () => input && input.focus());
  </script>
</body>
</html>`;
}

app.get("/", (req, res) => {
  res.send(page({ last: lastScan }));
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    shop: SHOP_HOST,
    hasClientId: Boolean(SHOPIFY_CLIENT_ID),
    hasClientSecret: Boolean(SHOPIFY_CLIENT_SECRET),
    locationId: SHOPIFY_LOCATION_ID || null
  });
});

app.post("/scan", async (req, res) => {
  try {
    const barcode = String(req.body.barcode || "").trim();
    const mode = String(req.body.mode || "minus");
    const pin = String(req.body.pin || "");

    if (!barcode) throw new Error("No barcode entered.");

    const now = Date.now();
    const lastTime = lastScanAtByBarcode.get(barcode) || 0;
    if (now - lastTime < 2000) {
      throw new Error("Duplicate scan blocked. Wait 2 seconds and scan again if intentional.");
    }
    lastScanAtByBarcode.set(barcode, now);

    let delta = -1;

    if (mode === "plus") {
      if (pin !== APP_PIN) throw new Error("Wrong PIN for plus mode.");
      delta = 1;
    }

    const result = await adjustInventory({ barcode, delta });

    res.send(page({
      message: `${delta > 0 ? "Added" : "Removed"} 1: ${result.productTitle}`,
      last: result
    }));
  } catch (err) {
    res.send(page({ error: err.message, last: lastScan }));
  }
});

app.post("/undo", async (req, res) => {
  try {
    if (!lastScan) throw new Error("Nothing to undo.");

    const undo = lastScan;
    lastScan = null;

    const result = await adjustInventory({
      barcode: undo.barcode,
      delta: undo.undoDelta
    });

    res.send(page({
      message: `Undo complete: ${result.productTitle}`,
      last: result
    }));
  } catch (err) {
    res.send(page({ error: err.message, last: lastScan }));
  }
});

app.listen(PORT, () => {
  console.log(`Bernie's scanner running on port ${PORT}`);
});
