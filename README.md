# Bernie's Inventory Scanner v15 - Log + PIN Clear

Based on v14 live candidate.

Changes:
- Adds LOG button
- Adds in-memory scan log viewer
- Logs REMOVE, ADD, and UNDO actions
- PIN clears after entering ADD mode
- PIN clears when leaving PIN field unless ADD mode is active
- Does NOT touch keyboard/focus architecture beyond preserving existing v14 behavior

Important:
- Log is in-memory only.
- Railway restart/redeploy clears the log.
- This is intended as a simple recent scan log, not permanent audit storage.

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
