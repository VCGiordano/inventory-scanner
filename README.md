# Bernie's Inventory Scanner v6

Changes:
- ADD MODE now automatically times out and returns to REMOVE MODE
- Default timeout is 120 seconds
- Optional Railway variable:
  ADD_MODE_TIMEOUT_SECONDS=120
- Keeps persistent mode only until timeout expires
- Designed to prevent accidentally adding inventory all day after receiving stock

Required Railway variables:
- SHOPIFY_STORE
- SHOPIFY_CLIENT_ID
- SHOPIFY_CLIENT_SECRET
- SHOPIFY_LOCATION_ID
- APP_PIN
- APP_URL

Optional Railway variable:
- ADD_MODE_TIMEOUT_SECONDS
