require('dotenv').config();
const express = require('express');
const crypto = require('crypto');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const SHOP = (process.env.SHOPIFY_STORE || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
const CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;
const LOCATION_ID_ENV = process.env.SHOPIFY_LOCATION_ID || '';
const APP_PIN = process.env.APP_PIN || '1234';
const API_VERSION = process.env.SHOPIFY_API_VERSION || '2026-04';

let cachedToken = null;
let tokenExpiresAt = 0;
let cachedLocationId = null;
let lastScan = { barcode: null, delta: null, at: 0 };
let lastAdjustment = null;

function requireEnv() {
  const missing = [];
  if (!SHOP) missing.push('SHOPIFY_STORE');
  if (!CLIENT_ID) missing.push('SHOPIFY_CLIENT_ID');
  if (!CLIENT_SECRET) missing.push('SHOPIFY_CLIENT_SECRET');
  if (missing.length) throw new Error(`Missing environment variables: ${missing.join(', ')}`);
}

async function getAccessToken() {
  requireEnv();
  const now = Date.now();
  if (cachedToken && now < tokenExpiresAt - 60_000) return cachedToken;

  const url = `https://${SHOP}/admin/oauth/access_token`;
  const body = new URLSearchParams();
  body.set('grant_type', 'client_credentials');
  body.set('client_id', CLIENT_ID);
  body.set('client_secret', CLIENT_SECRET);

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });

  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }

  if (!res.ok || !data.access_token) {
    throw new Error(`Shopify token failed: ${res.status} ${JSON.stringify(data)}`);
  }

  cachedToken = data.access_token;
  const expiresIn = data.expires_in || 86399;
  tokenExpiresAt = Date.now() + expiresIn * 1000;
  return cachedToken;
}

async function shopifyGraphql(query, variables = {}) {
  const token = await getAccessToken();
  const res = await fetch(`https://${SHOP}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': token
    },
    body: JSON.stringify({ query, variables })
  });

  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }

  if (!res.ok || data.errors) {
    throw new Error(`Shopify GraphQL failed: ${res.status} ${JSON.stringify(data.errors || data)}`);
  }
  return data.data;
}

function normalizeLocationId(id) {
  if (!id) return '';
  if (id.startsWith('gid://')) return id;
  return `gid://shopify/Location/${id}`;
}

async function getLocationId() {
  if (cachedLocationId) return cachedLocationId;
  if (LOCATION_ID_ENV) {
    cachedLocationId = normalizeLocationId(LOCATION_ID_ENV);
    return cachedLocationId;
  }

  const data = await shopifyGraphql(`
    query GetLocations {
      locations(first: 10) {
        nodes { id name }
      }
    }
  `);

  const locations = data.locations.nodes;
  if (!locations.length) throw new Error('No Shopify locations found.');
  cachedLocationId = locations[0].id;
  return cachedLocationId;
}

function cleanBarcode(input) {
  return String(input || '').trim();
}

function quoteSearch(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

async function findVariant(barcode) {
  const value = quoteSearch(barcode);

  const query = `
    query FindVariant($q: String!) {
      productVariants(first: 10, query: $q) {
        nodes {
          id
          title
          sku
          barcode
          inventoryItem { id tracked }
          product { title vendor }
        }
      }
    }
  `;

  let data = await shopifyGraphql(query, { q: `barcode:${value}` });
  let nodes = data.productVariants.nodes || [];

  if (!nodes.length) {
    data = await shopifyGraphql(query, { q: `sku:${value}` });
    nodes = data.productVariants.nodes || [];
  }

  if (!nodes.length) {
    const e = new Error(`No product variant found for barcode/SKU: ${barcode}`);
    e.code = 'NOT_FOUND';
    throw e;
  }

  if (nodes.length > 1) {
    const e = new Error(`Multiple variants found for barcode/SKU: ${barcode}. Fix duplicate barcodes before using this.`);
    e.code = 'DUPLICATE';
    throw e;
  }

  const v = nodes[0];
  if (!v.inventoryItem?.tracked) {
    const e = new Error(`Inventory is not tracked for: ${v.product.title} ${v.title}`);
    e.code = 'NOT_TRACKED';
    throw e;
  }

  return v;
}

async function adjustInventory({ barcode, delta }) {
  const variant = await findVariant(barcode);
  const locationId = await getLocationId();
  const idempotencyKey = crypto.randomUUID();

  const mutation = `
    mutation AdjustInventory($input: InventoryAdjustQuantitiesInput!, $idempotencyKey: String!) {
      inventoryAdjustQuantities(input: $input) @idempotent(key: $idempotencyKey) {
        userErrors { field message }
        inventoryAdjustmentGroup {
          createdAt
          reason
          changes { name delta }
        }
      }
    }
  `;

  const variables = {
    idempotencyKey,
    input: {
      reason: "correction",
      name: "available",
      referenceDocumentUri: `bernies://scanner/${Date.now()}/${crypto.randomUUID()}`,
      changes: [{
        delta,
        inventoryItemId: variant.inventoryItem.id,
        locationId
      }]
    }
  };

  const data = await shopifyGraphql(mutation, variables);
  const result = data.inventoryAdjustQuantities;
  if (result.userErrors && result.userErrors.length) {
    throw new Error(result.userErrors.map(e => e.message).join('; '));
  }

  return { variant, result, locationId };
}

app.get('/health', async (req, res) => {
  try {
    const locationId = await getLocationId();
    res.json({ ok: true, shop: SHOP, locationId });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/scan', async (req, res) => {
  try {
    const barcode = cleanBarcode(req.body.barcode);
    const mode = req.body.mode === 'plus' ? 'plus' : 'minus';
    const pin = String(req.body.pin || '');

    if (!barcode) return res.status(400).json({ ok: false, error: 'Enter or scan a barcode.' });
    if (mode === 'plus' && pin !== APP_PIN) return res.status(403).json({ ok: false, error: 'Wrong PIN for plus mode.' });

    const delta = mode === 'plus' ? 1 : -1;

    const now = Date.now();
    if (lastScan.barcode === barcode && lastScan.delta === delta && now - lastScan.at < 2000) {
      return res.status(429).json({ ok: false, error: 'Duplicate scan blocked. Wait 2 seconds or scan again intentionally.' });
    }

    const adjusted = await adjustInventory({ barcode, delta });

    lastScan = { barcode, delta, at: now };
    lastAdjustment = { barcode, delta, at: now, variant: adjusted.variant };

    res.json({
      ok: true,
      delta,
      barcode,
      productTitle: adjusted.variant.product.title,
      variantTitle: adjusted.variant.title,
      sku: adjusted.variant.sku,
      vendor: adjusted.variant.product.vendor,
      message: `${delta > 0 ? 'Added' : 'Removed'} 1: ${adjusted.variant.product.title} — ${adjusted.variant.title}`
    });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message, code: e.code || 'ERROR' });
  }
});

app.post('/api/undo', async (req, res) => {
  try {
    const pin = String(req.body.pin || '');
    if (pin !== APP_PIN) return res.status(403).json({ ok: false, error: 'Wrong PIN.' });
    if (!lastAdjustment) return res.status(400).json({ ok: false, error: 'Nothing to undo.' });

    const undoDelta = -lastAdjustment.delta;
    const barcode = lastAdjustment.barcode;
    const adjusted = await adjustInventory({ barcode, delta: undoDelta });

    lastAdjustment = null;

    res.json({
      ok: true,
      delta: undoDelta,
      barcode,
      message: `Undid last scan: ${adjusted.variant.product.title} — ${adjusted.variant.title}`
    });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.get('/', (req, res) => {
  res.send(`<!doctype html>
<html>
<head>
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
  <title>Bernie's Inventory Scanner</title>
  <style>
    body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;margin:0;background:#0f172a;color:white}
    .wrap{max-width:680px;margin:0 auto;padding:18px}
    h1{font-size:24px;margin:8px 0 4px}.sub{color:#94a3b8;margin-bottom:18px}
    .card{background:#111827;border:1px solid #334155;border-radius:16px;padding:16px;margin:14px 0}
    input,button{font-size:22px;border-radius:12px;border:0;padding:14px;width:100%;box-sizing:border-box}
    input{background:white;color:#111;margin-top:8px}button{background:#2563eb;color:white;font-weight:800;margin-top:10px}
    button.secondary{background:#475569}button.plus{background:#16a34a}.mode{display:grid;grid-template-columns:1fr 1fr;gap:10px}.mode button{font-size:18px}
    .active{outline:3px solid #facc15}.status{font-size:20px;line-height:1.35;min-height:84px}.good{background:#052e16;border-color:#16a34a}.bad{background:#450a0a;border-color:#ef4444}
    .muted{color:#94a3b8;font-size:14px}.log{font-size:14px;color:#cbd5e1;white-space:pre-wrap;max-height:180px;overflow:auto}
  </style>
</head>
<body>
<div class="wrap">
  <h1>Bernie's Inventory Scanner</h1>
  <div class="sub">Default mode: remove 1 from inventory. No orders are created.</div>
  <div class="card"><div class="mode"><button id="minusBtn" class="active" onclick="setMode('minus')">MINUS -1</button><button id="plusBtn" class="plus" onclick="setMode('plus')">PLUS +1</button></div><input id="pin" inputmode="numeric" placeholder="PIN for plus/undo only" style="display:none"></div>
  <div class="card"><label class="muted">Scan or type barcode / SKU</label><input id="barcode" autofocus autocomplete="off" placeholder="Scan barcode here"><button onclick="submitScan()">SCAN</button><button class="secondary" onclick="undoLast()">UNDO LAST SCAN</button></div>
  <div id="status" class="card status">Ready.</div>
  <div class="card"><div class="muted">Session log</div><div id="log" class="log"></div></div>
</div>
<script>
let mode='minus';const barcodeEl=document.getElementById('barcode'),statusEl=document.getElementById('status'),logEl=document.getElementById('log'),pinEl=document.getElementById('pin');
function setMode(m){mode=m;document.getElementById('minusBtn').classList.toggle('active',m==='minus');document.getElementById('plusBtn').classList.toggle('active',m==='plus');pinEl.style.display=m==='plus'?'block':'none';barcodeEl.focus();}
function setStatus(ok,msg){statusEl.className='card status '+(ok?'good':'bad');statusEl.textContent=msg;if(navigator.vibrate)navigator.vibrate(ok?60:[120,80,120]);}
function addLog(msg){const time=new Date().toLocaleTimeString();logEl.textContent='['+time+'] '+msg+'\n'+logEl.textContent;}
async function submitScan(){const barcode=barcodeEl.value.trim();if(!barcode){setStatus(false,'No barcode entered.');barcodeEl.focus();return;}setStatus(true,'Working...');try{const r=await fetch('/api/scan',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({barcode,mode,pin:pinEl.value})});const data=await r.json();if(!data.ok)throw new Error(data.error||'Scan failed');setStatus(true,data.message);addLog(data.message+' | SKU: '+(data.sku||''));barcodeEl.value='';barcodeEl.focus();}catch(e){setStatus(false,e.message);addLog('ERROR: '+e.message+' | Barcode: '+barcode);barcodeEl.select();}}
async function undoLast(){const pin=pinEl.value||prompt('PIN to undo last scan:');try{const r=await fetch('/api/undo',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pin})});const data=await r.json();if(!data.ok)throw new Error(data.error||'Undo failed');setStatus(true,data.message);addLog('UNDO: '+data.message);}catch(e){setStatus(false,e.message);addLog('UNDO ERROR: '+e.message);}finally{barcodeEl.focus();}}
barcodeEl.addEventListener('keydown',e=>{if(e.key==='Enter')submitScan();});window.addEventListener('load',()=>barcodeEl.focus());
</script>
</body>
</html>`);
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Bernie's Inventory Scanner running on port ${port}`));
