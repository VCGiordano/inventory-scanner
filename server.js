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
const DUPLICATE_SCAN_MS = Number(process.env.DUPLICATE_SCAN_MS || 500);
const AUTO_SUBMIT_DELAY_MS = Number(process.env.AUTO_SUBMIT_DELAY_MS || 100);
const SCOPES = "read_products,read_inventory,write_inventory";

let installedAccessToken = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN || null;
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
    state: crypto.randomBytes(16).toString("hex")
  });
  return `https://${shopHost()}/admin/oauth/authorize?${params.toString()}`;
}

app.get("/auth", (req, res) => {
  const missing = requireSetup();
  if (missing.length) return res.send(render({ setupError: `Missing Railway variables: ${missing.join(", ")}` }));
  res.redirect(installUrl());
});

app.get("/auth/callback", async (req, res) => {
  try {
    const { code, shop } = req.query;
    if (!code) throw new Error("Missing authorization code from Shopify.");
    const response = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: SHOPIFY_CLIENT_ID, client_secret: SHOPIFY_CLIENT_SECRET, code })
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`Token exchange failed ${response.status}: ${text}`);
    installedAccessToken = JSON.parse(text).access_token;
    res.redirect("/");
  } catch (e) {
    res.send(render({ setupError: e.message }));
  }
});

async function gql(query, variables = {}) {
  if (!installedAccessToken) throw new Error("App is not authorized yet. Tap AUTHORIZE SHOPIFY once.");

  const response = await fetch(`https://${shopHost()}/admin/api/2025-10/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": installedAccessToken },
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
            id title sku barcode
            product { title vendor }
            inventoryItem {
              id tracked
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
    changes: [{ delta, inventoryItemId: variant.inventoryItem.id, locationId: locationGid() }]
  };

  const data = await gql(mutation, { input });
  const errs = data.inventoryAdjustQuantities.userErrors;
  if (errs && errs.length) throw new Error(errs.map(e => e.message).join("; "));

  return {
    barcode,
    delta,
    undoDelta: -delta,
    productTitle: variant.product.title,
    variantTitle: variant.title,
    sku: variant.sku,
    before: available,
    after: available + delta,
    timestamp: new Date().toLocaleTimeString()
  };
}

function htmlEscape(value) {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

async function handleScan(body) {
  const barcode = String(body.barcode || "").trim();
  const action = String(body.action || "remove");
  const pin = String(body.pin || "");
  const addSession = String(body.addSession || "");

  if (!barcode) throw new Error("No barcode entered.");

  const now = Date.now();
  const lastAt = recent.get(`${barcode}:${action}`) || 0;
  if (now - lastAt < DUPLICATE_SCAN_MS) throw new Error("Duplicate scan blocked. Scan again if intentional.");
  recent.set(`${barcode}:${action}`, now);

  let delta = -1;
  if (action === "add") {
    if (!addSession) throw new Error("ADD MODE session missing. Enter PIN and tap ADD again.");
    if (pin && pin !== APP_PIN) throw new Error("Wrong PIN for ADD MODE.");
    delta = 1;
  }

  return await adjust(barcode, delta);
}

app.post("/scan-json", async (req, res) => {
  try {
    const result = await handleScan(req.body);
    res.json({ ok: true, result });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

app.post("/undo-json", async (req, res) => {
  try {
    const barcode = String(req.body.barcode || "").trim();
    const undoDelta = Number(req.body.undoDelta);
    if (!barcode || !undoDelta) throw new Error("Undo data missing.");
    const result = await adjust(barcode, undoDelta);
    res.json({ ok: true, result });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

function render({ setupError = "" } = {}) {
  const missing = requireSetup();
  const installed = Boolean(installedAccessToken);

  return `<!doctype html>
<html>
<head>
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
<title>Bernie's Scanner</title>
<style>
*{box-sizing:border-box} html,body{height:100%;margin:0}
body{font-family:Arial,sans-serif;background:#0b1015;color:white;overflow:hidden}
.screen{height:100vh;display:flex;flex-direction:column;padding:8px;gap:6px}
.top{border-radius:14px;padding:8px 10px;text-align:center;font-weight:900;letter-spacing:.5px;font-size:22px;line-height:1.1;background:#104225;border:2px solid #2fc36b;color:#caffd8}
.top.addActive{background:#4a3510;border-color:#f4c542;color:#ffe7a3}
.top.processing{background:#17314a;border-color:#4da3ff;color:#d7ecff}
.top.errorTop{background:#4a1414;border-color:#ff5757;color:#ffd0d0}
.modeRow{display:grid;grid-template-columns:1fr 1fr;gap:6px}
button,a.button{display:block;text-align:center;text-decoration:none;width:100%;border:0;border-radius:12px;font-weight:900;cursor:pointer;padding:12px 8px;font-size:18px;line-height:1}
.modeBtn{opacity:.42;border:2px solid transparent}.modeBtn.active{opacity:1;border:2px solid white;box-shadow:0 0 0 2px rgba(255,255,255,.22)}
.remove{background:#ff3b3b;color:white}.add{background:#2fc36b;color:#07140b}.authorize{background:#4da3ff;color:#06111f}
.scanBox{background:#141b23;border:1px solid #2f3b47;border-radius:14px;padding:8px}
label{display:block;color:#aab4bf;font-size:12px;margin-bottom:4px}
input{width:100%;font-size:24px;padding:12px;border-radius:10px;border:2px solid #526170;background:#05080b;color:white;outline:none}
input:focus{border-color:#4da3ff;box-shadow:0 0 0 3px rgba(77,163,255,.22)}
.pinBox{margin-top:6px}
.result{flex:1;min-height:82px;border-radius:14px;padding:10px;border:2px solid #2f3b47;overflow:hidden}
.okResult{background:#103d24;border-color:#2fc36b;color:#caffd8}.errorResult{background:#441616;border-color:#ff5e5e;color:#ffd0d0}.neutralResult{background:#141b23}
.resultMain{font-size:25px;font-weight:900;line-height:1.05;margin-bottom:4px}.product{font-size:18px;font-weight:800;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.meta{font-size:13px;color:#d8e0e7;line-height:1.25;margin-top:3px}.errorText{font-size:14px;line-height:1.25}
.bottomRow{display:grid;grid-template-columns:1fr 1fr;gap:6px}.undo{background:#f4c542;color:#171200}.clear{background:#25313d;color:#d8e0e7}
.installBox{padding:8px;border-radius:12px;background:#441616;border:1px solid #ff5e5e;text-align:center}
code{background:#05080b;padding:2px 4px;border-radius:4px}
</style>
</head>
<body>
<div class="screen">
  <div id="statusBar" class="top">READY TO SCAN</div>
  ${missing.length ? `<div class="installBox"><b>Missing setup:</b><br>${missing.map(x=>`<code>${x}</code>`).join(" ")}</div>` : ""}
  ${setupError ? `<div class="installBox"><b>Error:</b><br>${htmlEscape(setupError)}</div>` : ""}
  ${!installed ? `<div class="installBox"><b>Shopify not authorized</b><br><a class="button authorize" href="/auth">AUTHORIZE SHOPIFY</a></div>` : ""}

  <form id="scanForm">
    <input type="hidden" id="actionInput" value="remove">
    <input type="hidden" id="addSessionInput" value="">
    <div class="modeRow">
      <button class="modeBtn remove active" id="removeMode" type="button">REMOVE</button>
      <button class="modeBtn add" id="addMode" type="button">ADD</button>
    </div>
    <div class="scanBox">
      <label>Barcode</label>
      <input id="barcode" placeholder="Scan barcode" autofocus autocomplete="off">
      <div class="pinBox">
        <label>PIN for ADD only</label>
        <input id="pin" placeholder="PIN" autocomplete="off" inputmode="numeric">
      </div>
    </div>
  </form>

  <div id="resultBox" class="result neutralResult">
    <div id="resultMain" class="resultMain">READY</div>
    <div id="resultDetail" class="meta">Scan barcode. Page no longer reloads between scans.</div>
  </div>

  <div class="bottomRow">
    <button class="undo" id="undoBtn" type="button" disabled>UNDO</button>
    <button class="clear" id="clearBtn" type="button">CLEAR / FOCUS</button>
  </div>
</div>

<script>
const input=document.getElementById('barcode'), pin=document.getElementById('pin'), actionInput=document.getElementById('actionInput'), addSessionInput=document.getElementById('addSessionInput'), statusBar=document.getElementById('statusBar'), removeMode=document.getElementById('removeMode'), addMode=document.getElementById('addMode'), clearBtn=document.getElementById('clearBtn'), undoBtn=document.getElementById('undoBtn'), resultBox=document.getElementById('resultBox'), resultMain=document.getElementById('resultMain'), resultDetail=document.getElementById('resultDetail');
const ADD_TIMEOUT_SECONDS=${ADD_MODE_TIMEOUT_SECONDS}, AUTO_SUBMIT_DELAY_MS=${AUTO_SUBMIT_DELAY_MS};
let addExpiresAt=0, timerInterval=null, submitTimer=null, isSubmitting=false, lastResult=null;

function makeSessionToken(){return Math.random().toString(36).slice(2)+Date.now().toString(36)}
function saveAddSession(token,expiresAt){localStorage.setItem('scannerMode','add');localStorage.setItem('addSession',token);localStorage.setItem('addExpiresAt',String(expiresAt))}
function clearAddSession(){localStorage.setItem('scannerMode','remove');localStorage.removeItem('addSession');localStorage.removeItem('addExpiresAt');addSessionInput.value=''}
function updateStatus(text,modeClass){statusBar.className='top'+(modeClass?' '+modeClass:'');statusBar.textContent=text}
function forceFocus(){if(!input||isSubmitting)return;if(document.activeElement!==pin){input.focus();try{input.setSelectionRange(input.value.length,input.value.length)}catch(e){}}}
function setResult(kind,main,detail){resultBox.className='result '+(kind==='ok'?'okResult':kind==='error'?'errorResult':'neutralResult');resultMain.textContent=main;resultDetail.innerHTML=detail}

function setMode(mode,options={}){
  const resetTimer=options.resetTimer!==false;
  const existingToken=options.token||localStorage.getItem('addSession')||'';
  actionInput.value=mode;
  if(mode==='add'){
    const typedPin=pin.value.trim();
    if(!existingToken && typedPin===''){alert('Enter PIN first, then tap ADD.');pin.focus();return}
    const token=existingToken||makeSessionToken();
    addSessionInput.value=token;
    addMode.classList.add('active');removeMode.classList.remove('active');
    if(resetTimer){addExpiresAt=Date.now()+(ADD_TIMEOUT_SECONDS*1000);saveAddSession(token,addExpiresAt)}
    pin.blur();forceFocus();setTimeout(forceFocus,50);startTimer();
  }else{
    removeMode.classList.add('active');addMode.classList.remove('active');actionInput.value='remove';clearAddSession();
    if(timerInterval){clearInterval(timerInterval);timerInterval=null}
    updateStatus('READY TO SCAN','');forceFocus();setTimeout(forceFocus,50);
  }
}

function startTimer(){
  if(timerInterval)clearInterval(timerInterval);
  timerInterval=setInterval(()=>{
    if(actionInput.value!=='add')return;
    const secondsLeft=Math.ceil((addExpiresAt-Date.now())/1000);
    if(secondsLeft<=0){setMode('remove');return}
    updateStatus('ADD MODE - '+secondsLeft+'s','addActive');
  },200);
}

function prepareAddSessionIfNeeded(){
  if(actionInput.value==='add'){
    const token=addSessionInput.value||localStorage.getItem('addSession')||makeSessionToken();
    addExpiresAt=Date.now()+(ADD_TIMEOUT_SECONDS*1000);
    saveAddSession(token,addExpiresAt);
    addSessionInput.value=token;
  }
}

async function submitScan(){
  if(isSubmitting)return;
  const barcode=(input.value||'').trim();
  if(barcode.length<3)return;
  isSubmitting=true;
  updateStatus('PROCESSING...','processing');
  prepareAddSessionIfNeeded();

  try{
    const response=await fetch('/scan-json',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({barcode,action:actionInput.value,pin:pin.value,addSession:addSessionInput.value})});
    const data=await response.json();
    if(!data.ok){
      updateStatus('ERROR','errorTop');
      setResult('error','ERROR',data.error||'Unknown error');
    }else{
      const r=data.result;
      lastResult=r;
      setResult('ok',r.delta>0?'ADDED 1':'REMOVED 1',`${r.productTitle}<br><span class="meta">SKU: ${r.sku||'n/a'}<br>${r.before} to ${r.after} | ${r.timestamp}</span>`);
      updateStatus(actionInput.value==='add'?'ADD MODE - '+ADD_TIMEOUT_SECONDS+'s':'READY TO SCAN',actionInput.value==='add'?'addActive':'');
      undoBtn.disabled=false;
    }
  }catch(e){
    updateStatus('ERROR','errorTop');
    setResult('error','ERROR',e.message);
  }
  input.value='';
  isSubmitting=false;
  setTimeout(forceFocus,20);setTimeout(forceFocus,120);
}

function autoSubmitSoon(){
  if(isSubmitting)return;
  const value=(input.value||'').trim();
  if(value.length<3)return;
  if(submitTimer)clearTimeout(submitTimer);
  submitTimer=setTimeout(submitScan,AUTO_SUBMIT_DELAY_MS);
}

removeMode.addEventListener('click',()=>setMode('remove'));
addMode.addEventListener('click',()=>setMode('add'));
clearBtn.addEventListener('click',()=>{input.value='';forceFocus()});
undoBtn.addEventListener('click',async()=>{
  if(!lastResult)return;
  isSubmitting=true;updateStatus('UNDOING...','processing');
  try{
    const response=await fetch('/undo-json',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({barcode:lastResult.barcode,undoDelta:lastResult.undoDelta})});
    const data=await response.json();
    if(!data.ok){updateStatus('ERROR','errorTop');setResult('error','ERROR',data.error||'Unknown error')}
    else{const r=data.result;lastResult=r;setResult('ok','UNDO COMPLETE',`${r.productTitle}<br><span class="meta">${r.before} to ${r.after} | ${r.timestamp}</span>`);updateStatus('READY TO SCAN','')}
  }catch(e){updateStatus('ERROR','errorTop');setResult('error','ERROR',e.message)}
  input.value='';isSubmitting=false;setTimeout(forceFocus,50);
});

input.addEventListener('input',autoSubmitSoon);
input.addEventListener('change',autoSubmitSoon);
input.addEventListener('keydown',(e)=>{if(e.key==='Enter'){e.preventDefault();submitScan()}});

const savedMode=localStorage.getItem('scannerMode'), savedExpires=Number(localStorage.getItem('addExpiresAt')||0), savedToken=localStorage.getItem('addSession')||'';
if(savedMode==='add' && savedExpires>Date.now() && savedToken){addExpiresAt=savedExpires;setMode('add',{resetTimer:false,token:savedToken})}else{setMode('remove')}

window.addEventListener('load',()=>{input.value='';forceFocus();setTimeout(forceFocus,100)});
document.addEventListener('visibilitychange',()=>{if(!document.hidden)setTimeout(forceFocus,100)});
document.addEventListener('click',(e)=>{const tag=e.target.tagName.toLowerCase();if(tag!=='input'&&tag!=='button'&&tag!=='a')forceFocus()});
setInterval(forceFocus,500);
forceFocus();
</script>
</body>
</html>`;
}

app.get("/", (req, res) => res.send(render()));

app.get("/health", (req, res) => res.json({
  ok:true, installed:Boolean(installedAccessToken), shop:shopHost(), appUrl:APP_URL,
  locationId: SHOPIFY_LOCATION_ID, addModeTimeoutSeconds: ADD_MODE_TIMEOUT_SECONDS,
  duplicateScanMs: DUPLICATE_SCAN_MS, autoSubmitDelayMs: AUTO_SUBMIT_DELAY_MS, noReload:true
}));

app.listen(PORT, () => console.log(`Bernie's scanner v13 no-reload running on port ${PORT}`));
