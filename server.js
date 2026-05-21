const express = require("express");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;
const API_VERSION = process.env.SHOPIFY_API_VERSION || "2026-04";

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const SHOPIFY_STORE = (process.env.SHOPIFY_STORE || "").replace(/^https?:\/\//, "").replace(/\/$/, "");
const SHOPIFY_CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const SHOPIFY_CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;
const SHOPIFY_LOCATION_ID = process.env.SHOPIFY_LOCATION_ID || "";
const APP_PIN = process.env.APP_PIN || "1234";
const APP_URL = (process.env.APP_URL || "").replace(/\/$/, "");
const ADD_MODE_TIMEOUT_SECONDS = Number(process.env.ADD_MODE_TIMEOUT_SECONDS || 120);
const DUPLICATE_SCAN_MS = Number(process.env.DUPLICATE_SCAN_MS || 500);
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
  const params = new URLSearchParams({
    client_id: SHOPIFY_CLIENT_ID || "",
    scope: SCOPES,
    redirect_uri: `${APP_URL}/auth/callback`,
    state: crypto.randomBytes(16).toString("hex"),
  });

  return `https://${shopHost()}/admin/oauth/authorize?${params.toString()}`;
}

function esc(v) {
  return String(v).replace(/\\/g, "\\\\").replace(/"/g, '\\"').trim();
}

function htmlEscape(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function gql(query, variables = {}) {
  if (!installedAccessToken) {
    throw new Error("App is not authorized yet. Tap AUTHORIZE SHOPIFY once.");
  }

  const response = await fetch(`https://${shopHost()}/admin/api/${API_VERSION}/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": installedAccessToken,
    },
    body: JSON.stringify({ query, variables }),
  });

  const json = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(`Shopify HTTP ${response.status}: ${JSON.stringify(json)}`);
  }

  if (json.errors) {
    throw new Error(`Shopify GraphQL error: ${JSON.stringify(json.errors)}`);
  }

  return json.data;
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
            product {
              title
              vendor
            }
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
          }
        }
      }
    }
  `;

  const data = await gql(query, {
    q: `barcode:${esc(barcode)}`,
    locationId: locationGid(),
  });

  const variants = data.productVariants.edges.map((e) => e.node);

  if (!variants.length) throw new Error(`No product found for barcode: ${barcode}`);
  if (variants.length > 1) throw new Error(`Duplicate barcode found on ${variants.length} variants.`);

  const v = variants[0];

  if (!v.inventoryItem.tracked) {
    throw new Error("Product found, but inventory is not tracked.");
  }

  const available = v.inventoryItem.inventoryLevel?.quantities?.[0]?.quantity;

  if (available === undefined || available === null) {
    throw new Error("No inventory level found at this location.");
  }

  return { variant: v, available };
}

async function adjust(barcode, delta) {
  const { variant, available } = await findVariant(barcode);

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
        changeFromQuantity: available,
        inventoryItemId: variant.inventoryItem.id,
        locationId: locationGid(),
      },
    ],
  };

  const data = await gql(mutation, { input });
  const errs = data.inventoryAdjustQuantities.userErrors;

  if (errs && errs.length) {
    throw new Error(errs.map((e) => e.message).join("; "));
  }

  const result = {
    barcode,
    delta,
    undoDelta: -delta,
    productTitle: variant.product.title,
    variantTitle: variant.title,
    sku: variant.sku,
    before: available,
    after: available + delta,
    timestamp: new Date().toLocaleTimeString(),
  };

  lastScan = result;
  return result;
}

function render({ message = "", error = "", last = lastScan, mode = "remove" } = {}) {
  const missing = requireSetup();
  const installed = Boolean(installedAccessToken);

  const resultClass = error
    ? "result errorResult"
    : message
    ? "result okResult"
    : "result neutralResult";

  const resultText = error
    ? "ERROR"
    : last
    ? last.delta > 0
      ? "ADDED 1"
      : "REMOVED 1"
    : "READY";

  return `<!doctype html>
<html>
<head>
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
<title>Bernie's Scanner</title>
<style>
*{box-sizing:border-box}
html,body{height:100%;margin:0}
body{font-family:Arial,sans-serif;background:#0b1015;color:white;overflow:hidden}
.screen{height:100vh;display:flex;flex-direction:column;padding:8px;gap:6px}
.top{border-radius:14px;padding:8px 10px;text-align:center;font-weight:900;letter-spacing:.5px;font-size:22px;line-height:1.1;background:#104225;border:2px solid #2fc36b;color:#caffd8}
.top.addActive{background:#4a3510;border-color:#f4c542;color:#ffe7a3}
.modeRow{display:grid;grid-template-columns:1fr 1fr;gap:6px}
button,a.button{display:block;text-align:center;text-decoration:none;width:100%;border:0;border-radius:12px;font-weight:900;cursor:pointer;padding:12px 8px;font-size:18px;line-height:1}
.modeBtn{opacity:.42;border:2px solid transparent}
.modeBtn.active{opacity:1;border:2px solid white;box-shadow:0 0 0 2px rgba(255,255,255,.22)}
.remove{background:#ff3b3b;color:white}
.add{background:#2fc36b;color:#07140b}
.authorize{background:#4da3ff;color:#06111f}
.scanBox{background:#141b23;border:1px solid #2f3b47;border-radius:14px;padding:8px}
label{display:block;color:#aab4bf;font-size:12px;margin-bottom:4px}
input{width:100%;font-size:24px;padding:12px;border-radius:10px;border:2px solid #526170;background:#05080b;color:white;outline:none}
input:focus{border-color:#4da3ff;box-shadow:0 0 0 3px rgba(77,163,255,.22)}
.pinRow{display:grid;grid-template-columns:1fr 92px;gap:6px;margin-top:6px;align-items:end}
.submit{background:#4da3ff;color:#06111f;padding:13px 8px;font-size:16px}
.result{flex:1;min-height:82px;border-radius:14px;padding:10px;border:2px solid #2f3b47;overflow:hidden}
.okResult{background:#103d24;border-color:#2fc36b;color:#caffd8}
.errorResult{background:#441616;border-color:#ff5e5e;color:#ffd0d0}
.neutralResult{background:#141b23}
.resultMain{font-size:25px;font-weight:900;line-height:1.05;margin-bottom:4px}
.product{font-size:18px;font-weight:800;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.meta{font-size:13px;color:#d8e0e7;line-height:1.25;margin-top:3px}
.errorText{font-size:14px;line-height:1.25}
.bottomRow{display:grid;grid-template-columns:1fr 1fr;gap:6px}
.undo{background:#f4c542;color:#171200}
.clear{background:#25313d;color:#d8e0e7}
.installBox{padding:8px;border-radius:12px;background:#441616;border:1px solid #ff5e5e;text-align:center}
code{background:#05080b;padding:2px 4px;border-radius:4px}
</style>
</head>
<body>
<div class="screen">
  <div id="statusBar" class="top">READY TO SCAN</div>

  ${
    missing.length
      ? `<div class="installBox"><b>Missing setup:</b><br>${missing.map((x) => `<code>${x}</code>`).join(" ")}</div>`
      : ""
  }

  ${
    !installed
      ? `<div class="installBox"><b>Shopify not authorized</b><br><a class="button authorize" href="/auth">AUTHORIZE SHOPIFY</a></div>`
      : ""
  }

  <form id="scanForm" method="POST" action="/scan">
    <input type="hidden" id="actionInput" name="action" value="${mode === "add" ? "add" : "remove"}">
    <input type="hidden" id="addSessionInput" name="addSession" value="">

    <div class="modeRow">
      <button class="modeBtn remove ${mode !== "add" ? "active" : ""}" id="removeMode" type="button">REMOVE</button>
      <button class="modeBtn add ${mode === "add" ? "active" : ""}" id="addMode" type="button">ADD</button>
    </div>

    <div class="scanBox">
      <label>Barcode</label>
      <input id="barcode" name="barcode" placeholder="Scan barcode" autofocus autocomplete="off">

      <div class="pinRow">
        <div>
          <label>PIN for ADD only</label>
          <input id="pin" name="pin" placeholder="PIN" autocomplete="off">
        </div>
        <button class="submit" type="submit">GO</button>
      </div>
    </div>
  </form>

  <div class="${resultClass}">
    <div class="resultMain">${htmlEscape(resultText)}</div>
    ${error ? `<div class="errorText">${htmlEscape(error)}</div>` : ""}
    ${
      last
        ? `<div class="product">${htmlEscape(last.productTitle)}</div>
           <div class="meta">SKU: ${htmlEscape(last.sku || "n/a")}<br>${last.before} to ${last.after} | ${htmlEscape(last.timestamp || "")}</div>`
        : `<div class="meta">Scanner field should stay focused. Tap CLEAR/FOCUS if needed.</div>`
    }
  </div>

  <div class="bottomRow">
    ${
      last
        ? `<form method="POST" action="/undo">
             <input type="hidden" name="barcode" value="${htmlEscape(last.barcode)}">
             <input type="hidden" name="undoDelta" value="${last.undoDelta}">
             <button class="undo" type="submit">UNDO</button>
           </form>`
        : `<button class="undo" type="button" disabled>UNDO</button>`
    }
    <button class="clear" id="clearBtn" type="button">CLEAR / FOCUS</button>
  </div>
</div>

<script>
const input = document.getElementById("barcode");
const pin = document.getElementById("pin");
const actionInput = document.getElementById("actionInput");
const addSessionInput = document.getElementById("addSessionInput");
const statusBar = document.getElementById("statusBar");
const removeMode = document.getElementById("removeMode");
const addMode = document.getElementById("addMode");
const clearBtn = document.getElementById("clearBtn");
const scanForm = document.getElementById("scanForm");

const ADD_TIMEOUT_SECONDS = ${ADD_MODE_TIMEOUT_SECONDS};

let addExpiresAt = 0;
let timerInterval = null;

function makeSessionToken() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function saveAddSession(token, expiresAt) {
  localStorage.setItem("scannerMode", "add");
  localStorage.setItem("addSession", token);
  localStorage.setItem("addExpiresAt", String(expiresAt));
}

function clearAddSession() {
  localStorage.setItem("scannerMode", "remove");
  localStorage.removeItem("addSession");
  localStorage.removeItem("addExpiresAt");
  addSessionInput.value = "";
}

function updateStatus(text, modeClass) {
  statusBar.className = "top" + (modeClass ? " " + modeClass : "");
  statusBar.textContent = text;
}

function focusBarcode() {
  if (input && document.activeElement !== pin) input.focus();
}

function setMode(mode, options = {}) {
  const resetTimer = options.resetTimer !== false;
  const existingToken = options.token || localStorage.getItem("addSession") || "";

  actionInput.value = mode;

  if (mode === "add") {
    const typedPin = pin.value.trim();

    if (!existingToken && typedPin === "") {
      alert("Enter PIN first, then tap ADD.");
      pin.focus();
      return;
    }

    const token = existingToken || makeSessionToken();
    addSessionInput.value = token;

    addMode.classList.add("active");
    removeMode.classList.remove("active");

    if (resetTimer) {
      addExpiresAt = Date.now() + ADD_TIMEOUT_SECONDS * 1000;
      saveAddSession(token, addExpiresAt);
    }

    pin.blur();
    focusBarcode();
    startTimer();
  } else {
    removeMode.classList.add("active");
    addMode.classList.remove("active");
    actionInput.value = "remove";

    clearAddSession();

    if (timerInterval) {
      clearInterval(timerInterval);
      timerInterval = null;
    }

    updateStatus("READY TO SCAN", "");
    focusBarcode();
  }
}

function startTimer() {
  if (timerInterval) clearInterval(timerInterval);

  timerInterval = setInterval(() => {
    if (actionInput.value !== "add") return;

    const secondsLeft = Math.ceil((addExpiresAt - Date.now()) / 1000);

    if (secondsLeft <= 0) {
      setMode("remove");
      return;
    }

    updateStatus("ADD MODE - " + secondsLeft + "s", "addActive");
  }, 200);
}

removeMode.addEventListener("click", () => setMode("remove"));
addMode.addEventListener("click", () => setMode("add"));

clearBtn.addEventListener("click", () => {
  input.value = "";
  focusBarcode();
});

scanForm.addEventListener("submit", () => {
  if (actionInput.value === "add") {
    const token = addSessionInput.value || localStorage.getItem("addSession") || makeSessionToken();
    addExpiresAt = Date.now() + ADD_TIMEOUT_SECONDS * 1000;
    saveAddSession(token, addExpiresAt);
    addSessionInput.value = token;
  }
});

const savedMode = localStorage.getItem("scannerMode");
const savedExpires = Number(localStorage.getItem("addExpiresAt") || 0);
const savedToken = localStorage.getItem("addSession") || "";

if (savedMode === "add" && savedExpires > Date.now() && savedToken) {
  addExpiresAt = savedExpires;
  setMode("add", { resetTimer: false, token: savedToken });
} else {
  setMode("remove");
}

window.addEventListener("load", () => {
  if (input) input.value = "";
  focusBarcode();
});

document.addEventListener("click", (e) => {
  const tag = e.target.tagName.toLowerCase();
  if (tag !== "input" && tag !== "button" && tag !== "a") focusBarcode();
});

setInterval(() => {
  if (document.activeElement !== pin) focusBarcode();
}, 700);

focusBarcode();
</script>
</body>
</html>`;
}

app.get("/", (req, res) => {
  res.send(render());
});

app.get("/scan", (req, res) => {
  res.redirect("/");
});

app.get("/auth", (req, res) => {
  const missing = requireSetup();
  if (missing.length) {
    return res.send(render({ error: `Missing Railway variables: ${missing.join(", ")}` }));
  }

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
        code,
      }),
    });

    const text = await response.text();

    if (!response.ok) {
      throw new Error(`Token exchange failed ${response.status}: ${text}`);
    }

    installedAccessToken = JSON.parse(text).access_token;
    res.redirect("/");
  } catch (e) {
    res.send(render({ error: e.message }));
  }
});

app.post("/scan", async (req, res) => {
  try {
    const barcode = String(req.body.barcode || "").trim();
    const action = String(req.body.action || "remove");
    const pinValue = String(req.body.pin || "");
    const addSession = String(req.body.addSession || "");

    if (!barcode) throw new Error("No barcode entered.");

    const now = Date.now();
    const recentKey = `${barcode}:${action}`;
    const lastAt = recent.get(recentKey) || 0;

    if (now - lastAt < DUPLICATE_SCAN_MS) {
      throw new Error("Duplicate scan blocked. Scan again if intentional.");
    }

    recent.set(recentKey, now);

    let delta = -1;
    let mode = "remove";

    if (action === "add") {
      if (!addSession) throw new Error("ADD MODE session missing. Enter PIN and tap ADD again.");
      if (pinValue && pinValue !== APP_PIN) throw new Error("Wrong PIN for ADD MODE.");

      delta = 1;
      mode = "add";
    }

    const r = await adjust(barcode, delta);

    res.send(
      render({
        message: `${delta > 0 ? "Added" : "Removed"} 1: ${r.productTitle}`,
        last: r,
        mode,
      })
    );
  } catch (e) {
    res.send(render({ error: e.message, mode: String(req.body.action || "remove") }));
  }
});

app.post("/undo", async (req, res) => {
  try {
    const barcode = String(req.body.barcode || "").trim();
    const undoDelta = Number(req.body.undoDelta);

    if (!barcode || !undoDelta) {
      throw new Error("Undo data missing. Perform a new scan first.");
    }

    const r = await adjust(barcode, undoDelta);

    res.send(render({ message: `Undo complete: ${r.productTitle}`, last: r }));
  } catch (e) {
    res.send(render({ error: e.message }));
  }
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    installed: Boolean(installedAccessToken),
    shop: shopHost(),
    appUrl: APP_URL,
    locationId: SHOPIFY_LOCATION_ID,
    apiVersion: API_VERSION,
    addModeTimeoutSeconds: ADD_MODE_TIMEOUT_SECONDS,
    duplicateScanMs: DUPLICATE_SCAN_MS,
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Bernie's scanner running on port ${PORT}`);
});
