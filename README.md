- Scans submit with fetch() to /scan-json
- Page does not reload after each scan
- Barcode field stays alive between scans
- Auto-clear and refocus after every scan
- Remove/Add mode retained
- ADD mode requires PIN once, then session stays active until timeout
- Undo works without page reload
- One-screen C66 layout
- 500ms duplicate protection default
- 100ms auto-submit default

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

Rollback safety:
- If this fails operational testing, roll back to v6 or last known working deployment.
