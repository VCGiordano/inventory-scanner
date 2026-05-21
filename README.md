# Bernie's Inventory Scanner v12 C66 Simple Focus

Changes:
- Simplifies from v11
- Standard editable barcode input
- Removes aggressive global key interception
- Hard refocuses barcode field after mode changes, page load, visibility change, and taps
- No GO button
- Submit on scanner Enter
- Fallback auto-submit after barcode input appears
- Default auto-submit delay: 100ms
- Keeps one-screen layout, ADD mode session, timeout, duplicate protection, undo

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
