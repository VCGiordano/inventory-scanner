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
const recentScans = new Map();
const scanLog = [];
const MAX_LOG_ENTRIES = 200;

function addLogEntry(entry) {
  scanLog.unshift({ id: crypto.randomUUID(), timestamp: new Date().toLocaleString("en-US", { timeZone: "America/New_York" }), ...entry });
  if (scanLog.length > MAX_LOG_ENTRIES) scanLog.length = MAX_LOG_ENTRIES;
}

function shopHost() {
  if (!SHOPIFY_STORE) return "";
  return SHOPIFY_STORE.endsWith(".myshopify.com") ? SHOPIFY_STORE : `${SHOPIFY_STORE}.myshopify.com`;
}

function locationGid() {
  if (!SHOPIFY_LOCATION_ID) return "";
  if (SHOPIFY_LOCATION_ID.startsWith("gid://shopify/Location/")) return SHOPIFY_LOCATION_ID;
  return `gid://shopify/Location/${SHOPIFY_LOCATION_ID}`;
}

function htmlEscape(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
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
  if (missing.length) return res.send(renderPage(`Missing Railway variables: ${missing.join(", ")}`));
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
  } catch (error) {
    res.send(renderPage(error.message));
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

function escapeSearchValue(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"').trim();
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
  const data = await gql(query, { q: `barcode:${escapeSearchValue(barcode)}`, locationId: locationGid() });
  const variants = data.productVariants.edges.map((edge) => edge.node);
  if (variants.length === 0) throw new Error(`No product found for barcode: ${barcode}`);
  if (variants.length > 1) throw new Error(`Duplicate barcode found on ${variants.length} variants.`);
  const variant = variants[0];
  if (!variant.inventoryItem.tracked) throw new Error("Product found, but inventory is not tracked.");
  const available = variant.inventoryItem.inventoryLevel?.quantities?.[0]?.quantity;
  if (available === undefined || available === null) throw new Error("No inventory level found at this location.");
  return { variant, available };
}

async function adjustInventory(barcode, delta) {
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
  const errors = data.inventoryAdjustQuantities.userErrors;
  if (errors && errors.length) throw new Error(errors.map((err) => err.message).join("; "));
  return {
    barcode, delta, undoDelta: -delta,
    productTitle: variant.product.title,
    variantTitle: variant.title,
    sku: variant.sku,
    before: available,
    after: available + delta,
    timestamp: new Date().toLocaleTimeString("en-US", { timeZone: "America/New_York" })
  };
}

async function processScan({ barcode, action, pin, addSession }) {
  const cleanBarcode = String(barcode || "").trim();
  const cleanAction = String(action || "remove");
  const cleanPin = String(pin || "");
  const cleanAddSession = String(addSession || "");
  if (!cleanBarcode) throw new Error("No barcode entered.");

  const recentKey = `${cleanBarcode}:${cleanAction}`;
  const now = Date.now();
  const lastScanAt = recentScans.get(recentKey) || 0;
  if (now - lastScanAt < DUPLICATE_SCAN_MS) throw new Error("Duplicate scan blocked. Scan again if intentional.");
  recentScans.set(recentKey, now);

  let delta = -1;
  if (cleanAction === "add") {
    if (!cleanAddSession) throw new Error("ADD MODE session missing. Enter PIN and tap ADD again.");
    if (cleanPin && cleanPin !== APP_PIN) throw new Error("Wrong PIN for ADD MODE.");
    delta = 1;
  }

  const result = await adjustInventory(cleanBarcode, delta);
  addLogEntry({
    type: delta > 0 ? "ADD" : "REMOVE",
    barcode: result.barcode,
    sku: result.sku,
    productTitle: result.productTitle,
    variantTitle: result.variantTitle,
    before: result.before,
    after: result.after,
    delta: result.delta
  });
  return result;
}

app.post("/scan-json", async (req, res) => {
  try {
    const result = await processScan(req.body);
    res.json({ ok: true, result });
  } catch (error) {
    res.json({ ok: false, error: error.message });
  }
});

app.post("/undo-json", async (req, res) => {
  try {
    const barcode = String(req.body.barcode || "").trim();
    const undoDelta = Number(req.body.undoDelta);
    if (!barcode || !undoDelta) throw new Error("Undo data missing.");
    const result = await adjustInventory(barcode, undoDelta);
    addLogEntry({
      type: "UNDO",
      barcode: result.barcode,
      sku: result.sku,
      productTitle: result.productTitle,
      variantTitle: result.variantTitle,
      before: result.before,
      after: result.after,
      delta: result.delta
    });
    res.json({ ok: true, result });
  } catch (error) {
    res.json({ ok: false, error: error.message });
  }
});

app.get("/logs-json", (req, res) => {
  res.json({ ok: true, logs: scanLog });
});

function renderPage(setupError = "") {
  const missing = requireSetup();
  const setupMessages = [];
  if (missing.length) setupMessages.push(`Missing Railway variables: ${missing.join(", ")}`);
  if (setupError) setupMessages.push(setupError);
  const setupHtml = setupMessages.map((msg) => `<div class="installBox"><b>Setup/Error:</b><br>${htmlEscape(msg)}</div>`).join("");
  const authHtml = installedAccessToken ? "" : `<div class="installBox"><b>Shopify not authorized</b><br><a class="button authorize" href="/auth">AUTHORIZE SHOPIFY</a></div>`;

  return `<!doctype html>
<html>
<head>
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
<title>Bernie's Scanner</title>
<style>
*{box-sizing:border-box}
html,body{height:100%;margin:0}
body{font-family:Arial,sans-serif;background:#0b1015;color:white;overflow:hidden}
.screen{height:100dvh;min-height:100vh;display:flex;flex-direction:column;padding:6px 6px 72px 6px;gap:5px}
.top{border-radius:14px;padding:7px 10px;text-align:center;font-weight:900;letter-spacing:.5px;font-size:21px;line-height:1.1;background:#104225;border:2px solid #2fc36b;color:#caffd8}
.top.addActive{background:#4a3510;border-color:#f4c542;color:#ffe7a3}
.top.processing{background:#17314a;border-color:#4da3ff;color:#d7ecff}
.top.errorTop{background:#4a1414;border-color:#ff5757;color:#ffd0d0}
.modeRow{display:grid;grid-template-columns:1fr 1fr;gap:5px}
button,a.button{display:block;text-align:center;text-decoration:none;width:100%;border:0;border-radius:12px;font-weight:900;cursor:pointer;padding:10px 6px;font-size:16px;line-height:1}
.modeBtn{opacity:.42;border:2px solid transparent}
.modeBtn.active{opacity:1;border:2px solid white;box-shadow:0 0 0 2px rgba(255,255,255,.22)}
.remove{background:#ff3b3b;color:white}
.add{background:#2fc36b;color:#07140b}
.authorize{background:#4da3ff;color:#06111f}
.scanBox{background:#141b23;border:1px solid #2f3b47;border-radius:14px;padding:7px}
label{display:block;color:#aab4bf;font-size:12px;margin-bottom:3px}
input{width:100%;font-size:23px;padding:10px;border-radius:10px;border:2px solid #526170;background:#05080b;color:white;outline:none}
input:focus{border-color:#4da3ff;box-shadow:0 0 0 3px rgba(77,163,255,.22)}
.pinBox{margin-top:5px}
.result{flex:1;min-height:54px;border-radius:14px;padding:7px;border:2px solid #2f3b47;overflow:hidden}
.okResult{background:#103d24;border-color:#2fc36b;color:#caffd8}
.errorResult{background:#441616;border-color:#ff5e5e;color:#ffd0d0}
.neutralResult{background:#141b23}
.resultMain{font-size:24px;font-weight:900;line-height:1.05;margin-bottom:3px}
.product{font-size:17px;font-weight:800;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.meta{font-size:12px;color:#d8e0e7;line-height:1.25;margin-top:3px}
.bottomRow{position:fixed;left:6px;right:6px;bottom:6px;display:grid;grid-template-columns:1fr;gap:5px;z-index:50}
.undo{background:#f4c542;color:#171200}
.logBtn{background:#4da3ff;color:#06111f}
.installBox{padding:7px;border-radius:12px;background:#441616;border:1px solid #ff5e5e;text-align:center}
#logOverlay{position:fixed;inset:0;background:rgba(0,0,0,.86);z-index:1000;display:none;padding:10px}
.logPanel{height:100%;display:flex;flex-direction:column;background:#101820;border:1px solid #334150;border-radius:14px;overflow:hidden}
.logHeader{display:flex;gap:8px;align-items:center;justify-content:space-between;padding:10px;border-bottom:1px solid #334150}
.logHeader h2{font-size:22px;margin:0}
.closeLog{background:#ff3b3b;color:white;width:auto;padding:10px 14px}
.logList{overflow:auto;padding:8px}
.logItem{border:1px solid #334150;border-radius:10px;padding:8px;margin-bottom:8px;background:#141b23}
.logItem.addType{border-color:#2fc36b}
.logItem.removeType{border-color:#ff3b3b}
.logItem.undoType{border-color:#f4c542}
.logType{font-weight:900;font-size:16px}
.logProduct{font-size:15px;font-weight:800;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:3px}
.logMeta{font-size:12px;color:#d8e0e7;line-height:1.3;margin-top:3px}

.recentList{display:flex;flex-direction:column;gap:6px;overflow:hidden;height:100%}
.recentItem{border:1px solid #334150;border-radius:10px;padding:6px;background:#101820}
.recentItem.addType{border-color:#2fc36b}
.recentItem.removeType{border-color:#ff3b3b}
.recentItem.undoType{border-color:#f4c542}
.recentTop{font-size:15px;font-weight:900;line-height:1.1}
.recentProduct{font-size:14px;font-weight:800;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px}
.recentMeta{font-size:12px;color:#d8e0e7;line-height:1.2;margin-top:2px}


.recentVariant{font-size:14px;font-weight:900;color:#ffffff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px}
.logVariant{font-size:15px;font-weight:900;color:#ffffff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px}
</style>
</head>
<body>
<div class="screen">
  <div id="statusBar" class="top">READY TO SCAN</div>
  ${setupHtml}
  ${authHtml}

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
    <div id="resultMain" class="resultMain">RECENT SCANS</div>
    <div id="resultDetail" class="recentList">
      <div class="meta">No scans yet.</div>
    </div>
  </div>

  <div class="bottomRow">
    <button class="logBtn" id="logBtn" type="button">LOG</button>
  </div>
</div>

<div id="logOverlay">
  <div class="logPanel">
    <div class="logHeader">
      <h2>Scan Log</h2>
      <button class="closeLog" id="closeLogBtn" type="button">CLOSE</button>
    </div>
    <div id="logList" class="logList"><div class="meta">Loading...</div></div>
  </div>
</div>

<script>
const input=document.getElementById('barcode');
const pin=document.getElementById('pin');
const actionInput=document.getElementById('actionInput');
const addSessionInput=document.getElementById('addSessionInput');
const statusBar=document.getElementById('statusBar');
const removeMode=document.getElementById('removeMode');
const addMode=document.getElementById('addMode');
const undoBtn=null;
const logBtn=document.getElementById('logBtn');
const closeLogBtn=document.getElementById('closeLogBtn');
const logOverlay=document.getElementById('logOverlay');
const logList=document.getElementById('logList');
const resultBox=document.getElementById('resultBox');
const resultMain=document.getElementById('resultMain');
const resultDetail=document.getElementById('resultDetail');

const ADD_TIMEOUT_SECONDS=${ADD_MODE_TIMEOUT_SECONDS};
const AUTO_SUBMIT_DELAY_MS=${AUTO_SUBMIT_DELAY_MS};

let addExpiresAt=0,timerInterval=null,submitTimer=null,isSubmitting=false,lastResult=null;
let lastActivityAt=Date.now();
let recentFeed=[];

function makeSessionToken(){return Math.random().toString(36).slice(2)+Date.now().toString(36)}
function saveAddSession(token,expiresAt){localStorage.setItem('scannerMode','add');localStorage.setItem('addSession',token);localStorage.setItem('addExpiresAt',String(expiresAt))}
function clearAddSession(){localStorage.setItem('scannerMode','remove');localStorage.removeItem('addSession');localStorage.removeItem('addExpiresAt');addSessionInput.value=''}
function updateStatus(text,modeClass){statusBar.className='top'+(modeClass?' '+modeClass:'');statusBar.textContent=text}
function htmlEscapeClient(value){return String(value??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')}

function hideSoftKeyboard(){
  try{
    if(navigator.virtualKeyboard && navigator.virtualKeyboard.hide){
      navigator.virtualKeyboard.hide();
    }
  }catch(e){}
}
function forceFocus(){if(!input||isSubmitting||logOverlay.style.display==='block')return;if(document.activeElement!==pin){input.focus();setTimeout(hideSoftKeyboard,50);setTimeout(hideSoftKeyboard,150);setTimeout(hideSoftKeyboard,300);try{input.setSelectionRange(input.value.length,input.value.length)}catch(e){}}}
function setResult(kind,main,detail){const cls=kind==='ok'?'okResult':kind==='error'?'errorResult':'neutralResult';resultBox.className='result '+cls;resultMain.textContent=main;resultDetail.innerHTML=detail}

function renderRecentFeed(){
  resultBox.className='result neutralResult';
  resultMain.textContent='RECENT SCANS';
  resultDetail.className='recentList';
  if(!recentFeed.length){
    resultDetail.innerHTML='<div class="meta">No scans yet.</div>';
    return;
  }
  resultDetail.innerHTML=recentFeed.slice(0,4).map((item)=>{
    const typeClass=item.type==='ADD'?'addType':item.type==='UNDO'?'undoType':'removeType';
    const variant=item.variantTitle&&item.variantTitle!=='Default Title'?' - '+htmlEscapeClient(item.variantTitle):'';
    return '<div class="recentItem '+typeClass+'">'+
      '<div class="recentTop">'+htmlEscapeClient(item.type)+' | '+htmlEscapeClient(item.timestamp||'')+'</div>'+
      '<div class="recentProduct">'+htmlEscapeClient(item.productTitle||'')+'</div>'+ (variant?'<div class="recentVariant">'+variant.replace(' - ','')+'</div>':'')+
      '<div class="recentMeta">'+item.before+' to '+item.after+'</div>'+
    '</div>';
  }).join('');
}


function markActivity(){
  lastActivityAt=Date.now();
}

function idleRearmScanner(){
  if(isSubmitting || logOverlay.style.display==='block') return;
  if(document.activeElement===pin) return;
  try{ input.blur(); }catch(e){}
  setTimeout(()=>{
    forceFocus();
    setTimeout(hideSoftKeyboard,50);
    setTimeout(hideSoftKeyboard,200);
    setTimeout(hideSoftKeyboard,500);
  },80);
}

function setMode(mode,options={}){markActivity();
  const resetTimer=options.resetTimer!==false;
  const existingToken=options.token||localStorage.getItem('addSession')||'';
  actionInput.value=mode;
  if(mode==='add'){
    const typedPin=pin.value.trim();
    if(!existingToken&&typedPin===''){alert('Enter PIN first, then tap ADD.');pin.focus();return}
    const token=existingToken||makeSessionToken();
    addSessionInput.value=token;
    addMode.classList.add('active');removeMode.classList.remove('active');
    if(resetTimer){addExpiresAt=Date.now()+(ADD_TIMEOUT_SECONDS*1000);saveAddSession(token,addExpiresAt)}
    pin.value='';
    pin.blur();
    forceFocus();
    setTimeout(forceFocus,50);
    startTimer();
  }else{
    removeMode.classList.add('active');addMode.classList.remove('active');
    actionInput.value='remove';
    clearAddSession();
    if(timerInterval){clearInterval(timerInterval);timerInterval=null}
    updateStatus('READY TO SCAN','');
    forceFocus();
    setTimeout(forceFocus,50);
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
  markActivity();
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
      lastResult=data.result;
      const r=data.result;
      const main=r.delta>0?'ADDED 1':'REMOVED 1';
      const variantLine = r.variantTitle && r.variantTitle !== 'Default Title' ? '<br>' + htmlEscapeClient(r.variantTitle) : '';
      const detail=htmlEscapeClient(r.productTitle)+variantLine+'<br><span class="meta">SKU/Barcode: '+htmlEscapeClient(r.sku||'n/a')+'<br>'+r.before+' to '+r.after+' | '+htmlEscapeClient(r.timestamp||'')+'</span>';
      recentFeed.unshift({type:r.delta>0?'ADD':'REMOVE',productTitle:r.productTitle,variantTitle:r.variantTitle,before:r.before,after:r.after,timestamp:r.timestamp});
      if(recentFeed.length>8)recentFeed.length=8;
      renderRecentFeed();
      updateStatus(actionInput.value==='add'?'ADD MODE - '+ADD_TIMEOUT_SECONDS+'s':'READY TO SCAN',actionInput.value==='add'?'addActive':'');

    }
  }catch(error){
    updateStatus('ERROR','errorTop');
    setResult('error','ERROR',error.message);
  }
  input.value='';
  isSubmitting=false;
  setTimeout(forceFocus,20);
  setTimeout(forceFocus,120);
}

function autoSubmitSoon(){
  markActivity();
  if(isSubmitting)return;
  const value=(input.value||'').trim();
  if(value.length<3)return;
  if(submitTimer)clearTimeout(submitTimer);
  submitTimer=setTimeout(submitScan,AUTO_SUBMIT_DELAY_MS);
}

async function openLog(){markActivity();
  logOverlay.style.display='block';
  logList.innerHTML='<div class="meta">Loading...</div>';
  try{
    const response=await fetch('/logs-json');
    const data=await response.json();
    if(!data.ok||!data.logs||data.logs.length===0){logList.innerHTML='<div class="meta">No scans logged yet.</div>';return}
    logList.innerHTML=data.logs.map((item)=>{
      const typeClass=item.type==='ADD'?'addType':item.type==='UNDO'?'undoType':'removeType';
      return '<div class="logItem '+typeClass+'">'+
        '<div class="logType">'+htmlEscapeClient(item.type)+' | '+htmlEscapeClient(item.timestamp)+'</div>'+
        '<div class="logProduct">'+htmlEscapeClient(item.productTitle||'')+'</div>'+
        (item.variantTitle&&item.variantTitle!=='Default Title'?'<div class="logVariant">'+htmlEscapeClient(item.variantTitle)+'</div>':'')+
        '<div class="logMeta">SKU/Barcode: '+htmlEscapeClient(item.sku||'n/a')+'<br>'+htmlEscapeClient(item.barcode||'')+'<br>'+item.before+' to '+item.after+'</div>'+
      '</div>';
    }).join('');
  }catch(error){
    logList.innerHTML='<div class="meta">Could not load log: '+htmlEscapeClient(error.message)+'</div>';
  }
}

function closeLog(){markActivity();window.location.reload()}

removeMode.addEventListener('click',()=>setMode('remove'));
addMode.addEventListener('click',()=>setMode('add'));
logBtn.addEventListener('click',openLog);
closeLogBtn.addEventListener('click',closeLog);


input.addEventListener('input',autoSubmitSoon);
input.addEventListener('change',autoSubmitSoon);
input.addEventListener('keydown',(event)=>{if(event.key==='Enter'){event.preventDefault();submitScan()}});

const savedMode=localStorage.getItem('scannerMode');
const savedExpires=Number(localStorage.getItem('addExpiresAt')||0);
const savedToken=localStorage.getItem('addSession')||'';
if(savedMode==='add'&&savedExpires>Date.now()&&savedToken){addExpiresAt=savedExpires;setMode('add',{resetTimer:false,token:savedToken})}else{setMode('remove')}

window.addEventListener('load',()=>{input.value='';forceFocus();setTimeout(forceFocus,100)});
document.addEventListener('visibilitychange',()=>{if(!document.hidden)setTimeout(forceFocus,100)});
document.addEventListener('click',(event)=>{const tag=event.target.tagName.toLowerCase();if(tag!=='input'&&tag!=='button'&&tag!=='a')forceFocus()});
setInterval(()=>{
  if(Date.now()-lastActivityAt>45000){
    lastActivityAt=Date.now();
    idleRearmScanner();
  }else{
    forceFocus();
  }
},5000);
forceFocus();
</script>
</body>
</html>`;
}

app.get("/", (req, res) => res.send(renderPage()));

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    installed: Boolean(installedAccessToken),
    shop: shopHost(),
    appUrl: APP_URL,
    locationId: SHOPIFY_LOCATION_ID,
    addModeTimeoutSeconds: ADD_MODE_TIMEOUT_SECONDS,
    duplicateScanMs: DUPLICATE_SCAN_MS,
    autoSubmitDelayMs: AUTO_SUBMIT_DELAY_MS,
    noReload: true,
    logEntries: scanLog.length
  });
});

app.listen(PORT, () => {
  console.log(`Bernie's scanner v33 running on port ${PORT}`);
});
