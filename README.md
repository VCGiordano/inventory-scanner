# Bernie's Inventory Scanner v10 Auto Submit

Changes:
- Keeps GO button removed
- Adds auto-submit after barcode input settles
- Default auto-submit delay: 250ms
- Works when C66 scanner types barcode but does not send Enter
- Also catches Enter if scanner does send Enter
- Keeps one-screen layout, focus lock, ADD mode session, timeout, undo

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
- AUTO_SUBMIT_DELAY_MS
