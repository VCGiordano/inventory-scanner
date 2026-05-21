# Bernie's Inventory Scanner v8 Stable Candidate

Production hardening pass:
- One-screen C66 layout
- Big READY / ADD MODE status bar
- Aggressive barcode focus lock
- Auto-clear barcode field on load
- ADD MODE PIN only to enter mode
- ADD MODE timeout resets after add scan
- Duplicate scan window reduced to 500ms default
- Big success/error feedback
- Debug clutter removed
- Undo retained

Required Railway variables:
- SHOPIFY_STORE
- SHOPIFY_CLIENT_ID
- SHOPIFY_CLIENT_SECRET
- SHOPIFY_LOCATION_ID
- APP_PIN
- APP_URL

Optional Railway variables:
- ADD_MODE_TIMEOUT_SECONDS
- DUPLICATE_SCAN_MS
