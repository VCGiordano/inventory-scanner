const express = require("express");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const SHOPIFY_STORE = (process.env.SHOPIFY_STORE || "").replace(/^https?:\/\//, "").replace(/\/$/, "");
const SHOPIFY_CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const SHOPIFY_CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;
const SHOPIFY_LOCATION_ID = process.env.SHOPIFY_LOCATION_ID || "";
const APP_PIN = process.env.APP_PIN || "1234";
const APP_URL = (process.env.APP_URL || "").replace(/\/$/, "");
const ADD_MODE_TIMEOUT_SECONDS = Number(process.env.ADD_MODE_TIMEOUT_SECONDS || 120);
const SCOPES = "read_products,read_inventory,write_inventory";

let installedAccessToken = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN || null;
let lastScan = null;
let recent = new Map();

function shopHost() {
  if (!SHOPIFY_STORE) return "";
  return SHOPIFY_STORE.endsWith(".myshopify.com") ? SHOPIFY_STORE : `${SHOPIFY_STORE}.myshopify.com`;
}

function locationGid() {
  if (!SHOPIFY_LOCATION_ID) return "";
  if (SHOPIFY_LOCATION_ID.startsWith("gid://shopify/Location/")) return SHOPIFY_LOCATION_ID;
  return `gid://shopify/Location/${SHOPIFY_LOCATION_ID}`;
}

function requireSetup() {
  const missing = [];
  if (!SHOPIFY_STORE) missing.push("SHOPIFY_STORE");
  if (!SHOPIFY_CLIENT_ID) missing.push("SHOPIFY_CLIENT_ID");
  if (!SHOPIFY_CLIENT_SECRET) missing.push("SHOPIFY_CLIENT_SECRET");
  if (!APP_URL) missing.push("APP_URL");
  if (!SHOPIFY_LOCATION_ID) missing.push("SHOPIFY_LOCATION_ID");
  return missing;
}

function installUrl() {
  const shop = shopHost();
  const state = crypto.randomBytes(16).toString("hex");
  const redirectUri = `${APP_URL}/auth/callback`;
  const params = new URLSearchParams({
    client_id: SHOPIFY_CLIENT_ID || "",
    scope: SCOPES,
    redirect_uri: redirectUri,
    state
  });
  return `https://${shop}/admin/oauth/authorize?${params.toString()}`;
}

app.get("/auth", (req, res) => {
  const missing = requireSetup();
  if (missing.length) return res.send(render({ error: `Missing Railway variables: ${missing.join(", ")}` }));
  res.redirect(installUrl());
});

app.get("/auth/callback", async (req, res) => {
  try {
    const { code, shop } = req.query;
    if (!code) throw new Error("Missing authorization code from Shopify.");

    const response = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: SHOPIFY_CLIENT_ID,
        client_secret: SHOPIFY_CLIENT_SECRET,
        code
      })
    });

    const text = await response.text();
    if (!response.ok) throw new Error(`Token exchange failed ${response.status}: ${text}`);

    const data = JSON.parse(text);
    installedAccessToken = data.access_token;
    res.redirect("/");
  } catch (e) {
    res.send(render({ error: e.message }));
  }
});

async function gql(query, variables = {}) {
  if (!installedAccessToken) throw new Error("App is not authorized yet. Click INSTALL / AUTHORIZE SHOPIFY first.");

  const response = await fetch(`https://${shopHost()}/admin/api/2025-10/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": installedAccessToken
    },
    body: JSON.stringify({ query, variables })
  });

  const json = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`Shopify HTTP ${response.status}: ${JSON.stringify(json)}`);
  if (json.errors) throw new Error(`Shopify GraphQL error: ${JSON.stringify(json.errors)}`);
  return json.data;
}

function esc(v) {
  return String(v).replace(/\\/g, "\\\\").replace(/"/g, '\\"').trim();
}

async function findVariant(barcode) {
  const query = `
    query FindVariant($q: String!, $locationId: ID!) {
      productVariants(first: 5, query: $q) {
        edges {
          node {
            id
            title
            sku
            barcode
            product { title vendor }
            inventoryItem {
              id
              tracked
              inventoryLevel(locationId: $locationId) {
                quantities(names: ["available"]) { name quantity }
              }
            }
          }
        }
      }
    }
  `;

  const data = await gql(query, { q: `barcode:${esc(barcode)}`, locationId: locationGid() });
  const variants = data.productVariants.edges.map(e => e.node);

  if (!variants.length) throw new Error(`No product found for barcode: ${barcode}`);
  if (variants.length > 1) throw new Error(`Duplicate barcode found on ${variants.length} variants.`);

  const v = variants[0];
  if (!v.inventoryItem.tracked) throw new Error("Product found, but inventory is not tracked.");
  const available = v.inventoryItem.inventoryLevel?.quantities?.[0]?.quantity;
  if (available === undefined || available === null) throw new Error("No inventory level found at this location.");

  return { variant: v, available };
}

async function adjust(barcode, delta) {
  const { variant, available } = await findVariant(barcode);
  if (delta < 0 && available <= 0) throw new Error(`Inventory is already ${available}. Not subtracting.`);

  const mutation = `
    mutation AdjustInventory($input: InventoryAdjustQuantitiesInput!) {
      inventoryAdjustQuantities(input: $input) {
        userErrors { field message }
        inventoryAdjustmentGroup { createdAt }
      }
    }
  `;

  const input = {
    reason: "correction",
    name: "available",
    referenceDocumentUri: `bernies-scanner://${Date.now()}-${crypto.randomUUID()}`,
    changes: [{
      delta,
      inventoryItemId: variant.inventoryItem.id,
      locationId: locationGid()
    }]
  };

  const data = await gql(mutation, { input });
  const errs = data.inventoryAdjustQuantities.userErrors;
  if (errs && errs.length) throw new Error(errs.map(e => e.message).join("; "));

  const result = {
    barcode,
    delta,
    undoDelta: -delta,
    productTitle: variant.product.title,
    variantTitle: variant.title,
    sku: variant.sku,
    before: available,
    after: available + delta,
    timestamp: new Date().toLocaleString()
  };

  lastScan = result;
  return result;
}

function htmlEscape(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function render({ message = "", error = "", last = lastScan, mode = "remove" } = {}) {
  const missing = requireSetup();
  const installed = Boolean(installedAccessToken);

  return `<!doctype html>
<html>
<head>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Bernie's Inventory Scanner</title>
  <style>
    body{font-family:Arial,sans-serif;background:#101418;color:white;margin:0}
    .wrap{max-width:560px;margin:0 auto;padding:18px}
    h1{font-size:30px;margin:10px 0 6px}
    .card{background:#1b222b;border:1px solid #334150;border-radius:16px;padding:16px;margin:14px 0}
    input{width:100%;box-sizing:border-box;font-size:24px;padding:18px;border-radius:12px;border:1px solid #44515f;background:#0e1318;color:white;margin:8px 0 12px}
    button,a.button{display:block;text-align:center;text-decoration:none;width:100%;box-sizing:border-box;font-size:20px;font-weight:800;padding:16px;border:0;border-radius:12px;cursor:pointer;margin-top:10px}
    .modeRow{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:12px 0}
    .modeBtn{opacity:.45;border:2px solid transparent}
    .modeBtn.active{opacity:1;border-color:white;box-shadow:0 0 0 2px rgba(255,255,255,.25)}
    .remove{background:#ff3b3b;color:white}
    .add{background:#2fc36b;color:#07140b}
    .submit{background:#4da3ff;color:#06111f}
    .undo{background:#f4c542;color:#171200}
    .install{background:#4da3ff;color:#06111f}
    .ok{background:#103d24;border-color:#2fc36b;color:#b9ffd0}
    .err{background:#441616;border-color:#ff5e5e;color:#ffd0d0}
    .warn{background:#4a3510;border-color:#f4c542;color:#ffe7a3}
    .muted{color:#aab4bf;font-size:14px;line-height:1.4}
    .big{font-size:22px;font-weight:800}
    .modeLabel{font-size:20px;font-weight:800;margin:8px 0}
    code{background:#0e1318;padding:2px 5px;border-radius:4px}
  </style>
</head>
<body>
<div class="wrap">
  <h1>Bernie's Inventory Scanner</h1>
  <div class="muted">REMOVE is normal. To receive stock: enter PIN once, tap ADD MODE, then scan. Timer resets after each ADD scan.</div>

  ${missing.length ? `<div class="card err"><div class="big">Missing Railway variables</div><p>${missing.map(x=>`<code>${x}</code>`).join("<br>")}</p></div>` : ""}
  ${!installed ? `<div class="card err"><div class="big">App not authorized yet</div><p>Click this once to install/authorize Shopify.</p><a class="button install" href="/auth">INSTALL / AUTHORIZE SHOPIFY</a></div>` : `<div class="card ok"><div class="big">Shopify authorized</div></div>`}
  ${message ? `<div class="card ok"><div class="big">${htmlEscape(message)}</div></div>` : ""}
  ${error ? `<div class="card err"><div class="big">Error</div><p>${htmlEscape(error)}</p></div>` : ""}

  <div class="card" id="modeWarning" style="display:none;">
    <div class="big">ADD MODE ACTIVE</div>
    <div id="modeTimer" class="muted">Timer running.</div>
  </div>

  <div class="card">
    <form id="scanForm" method="POST" action="/scan">
      <input type="hidden" id="actionInput" name="action" value="${mode === "add" ? "add" : "remove"}">
      <input type="hidden" id="addSessionInput" name="addSession" value="">

      <div class="modeLabel">Current Mode: <span id="modeText">${mode === "add" ? "ADD 1" : "REMOVE 1"}</span></div>
      <div class="modeRow">
        <button class="modeBtn remove ${mode !== "add" ? "active" : ""}" id="removeMode" type="button">REMOVE MODE</button>
        <button class="modeBtn add ${mode === "add" ? "active" : ""}" id="addMode" type="button">ADD MODE</button>
      </div>

      <label class="muted">Barcode</label>
      <input id="barcode" name="barcode" placeholder="Scan or type barcode" autofocus autocomplete="off">

      <label class="muted">PIN required only to enter ADD MODE</label>
      <input id="pin" name="pin" placeholder="PIN for add mode" autocomplete="off">

      <button class="submit" type="submit">SUBMIT SCAN</button>
    </form>
  </div>

  ${last ? `<div class="card">
    <div class="muted">Last adjustment - ${htmlEscape(last.timestamp || "")}</div>
    <div class="big">${last.delta > 0 ? "ADDED" : "REMOVED"} 1 | ${htmlEscape(last.productTitle)}</div>
    <p>${htmlEscape(last.variantTitle || "")}</p>
    <p class="muted">SKU: ${htmlEscape(last.sku || "n/a")}<br>Barcode: ${htmlEscape(last.barcode)}<br>Before: ${last.before}<br>After: ${last.after}</p>

    <form method="POST" action="/undo">
      <input type="hidden" name="barcode" value="${htmlEscape(last.barcode)}">
      <input type="hidden" name="undoDelta" value="${last.undoDelta}">
      <button class="undo" type="submit">UNDO LAST ADJUSTMENT</button>
    </form>
  </div>` : ""}

  <div class="card muted">
    <p><b>Shop:</b> ${htmlEscape(shopHost() || "missing")}<br><b>Location:</b> ${htmlEscape(SHOPIFY_LOCATION_ID || "missing")}<br><b>App URL:</b> ${htmlEscape(APP_URL || "missing")}</p>
  </div>
</div>

<script>
const input = document.getElementById('barcode');
const pin = document.getElementById('pin');
const actionInput = document.getElementById('actionInput');
const addSessionInput = document.getElementById('addSessionInput');
const modeText = document.getElementById('modeText');
const removeMode = document.getElementById('removeMode');
const addMode = document.getElementById('addMode');
const modeWarning = document.getElementById('modeWarning');
const modeTimer = document.getElementById('modeTimer');

const ADD_TIMEOUT_SECONDS = ${ADD_MODE_TIMEOUT_SECONDS};
let addExpiresAt = 0;
let timerInterval = null;

function makeSessionToken() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function saveAddSession(token, expiresAt) {
  localStorage.setItem('scannerMode', 'add');
  localStorage.setItem('addSession', token);
  localStorage.setItem('addExpiresAt', String(expiresAt));
}

function clearAddSession() {
  localStorage.setItem('scannerMode', 'remove');
  localStorage.removeItem('addSession');
  localStorage.removeItem('addExpiresAt');
  addSessionInput.value = "";
}

function setMode(mode, options = {}) {
  const resetTimer = options.resetTimer !== false;
  const existingToken = options.token || localStorage.getItem('addSession') || "";

  actionInput.value = mode;

  if (mode === 'add') {
    const token = existingToken || makeSessionToken();
    addSessionInput.value = token;

    addMode.classList.add('active');
    removeMode.classList.remove('active');
    modeText.textContent = 'ADD 1';
    modeWarning.style.display = 'block';

    if (resetTimer) {
      addExpiresAt = Date.now() + (ADD_TIMEOUT_SECONDS * 1000);
      saveAddSession(token, addExpiresAt);
    }

    startTimer();
  } else {
    removeMode.classList.add('active');
    addMode.classList.remove('active');
    modeText.textContent = 'REMOVE 1';
    modeWarning.style.display = 'none';
    actionInput.value = 'remove';
    clearAddSession();

    if (timerInterval) {
      clearInterval(timerInterval);
      timerInterval = null;
    }
  }

  if (input) input.focus();
}

function startTimer() {
  if (timerInterval) clearInterval(timerInterval);

  timerInterval = setInterval(() => {
    if (actionInput.value !== 'add') return;

    const secondsLeft = Math.ceil((addExpiresAt - Date.now()) / 1000);

    if (secondsLeft <= 0) {
      setMode('remove');
      return;
    }

    modeTimer.textContent = 'ADD MODE expires in ' + secondsLeft + ' seconds. Each ADD scan resets timer.';
  }, 250);
}

removeMode.addEventListener('click', () => setMode('remove'));

addMode.addEventListener('click', () => {
  if (pin.value.trim() === "") {
    alert("Enter PIN first, then tap ADD MODE.");
    pin.focus();
    return;
  }
  setMode('add');
  pin.blur();
});

const savedMode = localStorage.getItem('scannerMode');
const savedExpires = Number(localStorage.getItem('addExpiresAt') || 0);
const savedToken = localStorage.getItem('addSession') || "";

if (savedMode === 'add' && savedExpires > Date.now() && savedToken) {
  addExpiresAt = savedExpires;
  setMode('add', { resetTimer: false, token: savedToken });
} else {
  setMode('remove');
}

document.getElementById('scanForm').addEventListener('submit', () => {
  if (actionInput.value === 'add') {
    const token = addSessionInput.value || localStorage.getItem('addSession') || makeSessionToken();
    addExpiresAt = Date.now() + (ADD_TIMEOUT_SECONDS * 1000);
    saveAddSession(token, addExpiresAt);
    addSessionInput.value = token;
  }
});

if(input) input.focus();
</script>
</body>
</html>`;
}

app.get("/", (req, res) => res.send(render()));

app.post("/scan", async (req, res) => {
  try {
    const barcode = String(req.body.barcode || "").trim();
    const action = String(req.body.action || "remove");
    const pin = String(req.body.pin || "");
    const addSession = String(req.body.addSession || "");
    if (!barcode) throw new Error("No barcode entered.");

    const now = Date.now();
    const lastAt = recent.get(`${barcode}:${action}`) || 0;
    if (now - lastAt < 2000) throw new Error("Duplicate scan blocked. Wait 2 seconds and scan again if intentional.");
    recent.set(`${barcode}:${action}`, now);

    let delta = -1;
    let mode = "remove";

    if (action === "add") {
      if (!addSession) throw new Error("ADD MODE session missing. Enter PIN and tap ADD MODE again.");
      if (pin && pin !== APP_PIN) throw new Error("Wrong PIN for ADD MODE.");
      delta = 1;
      mode = "add";
    }

    const r = await adjust(barcode, delta);
    res.send(render({ message: `${delta > 0 ? "Added" : "Removed"} 1: ${r.productTitle}`, last: r, mode }));
  } catch (e) {
    res.send(render({ error: e.message, mode: String(req.body.action || "remove") }));
  }
});

app.post("/undo", async (req, res) => {
  try {
    const barcode = String(req.body.barcode || "").trim();
    const undoDelta = Number(req.body.undoDelta);

    if (!barcode || !undoDelta) throw new Error("Undo data missing. Perform a new scan first.");

    const r = await adjust(barcode, undoDelta);
    res.send(render({ message: `Undo complete: ${r.productTitle}`, last: r }));
  } catch (e) {
    res.send(render({ error: e.message }));
  }
});

app.get("/health", (req, res) => res.json({
  ok:true,
  installed:Boolean(installedAccessToken),
  shop:shopHost(),
  appUrl:APP_URL,
  locationId: SHOPIFY_LOCATION_ID,
  addModeTimeoutSeconds: ADD_MODE_TIMEOUT_SECONDS
}));

app.listen(PORT, () => console.log(`Bernie's scanner running on port ${PORT}`));
