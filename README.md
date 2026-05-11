# Bernie's Inventory Scanner v7

Fixes:
- PIN is only required to ENTER ADD MODE
- ADD MODE stays active for receiving inventory
- Each ADD scan resets the timeout
- ADD MODE auto-expires back to REMOVE MODE after inactivity
- REMOVE MODE remains the safe default
- Removed phone camera scanner

Required Railway variables:
- SHOPIFY_STORE
- SHOPIFY_CLIENT_ID
- SHOPIFY_CLIENT_SECRET
- SHOPIFY_LOCATION_ID
- APP_PIN
- APP_URL

Optional Railway variable:
- ADD_MODE_TIMEOUT_SECONDS
