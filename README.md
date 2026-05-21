None selected

Skip to content
Using Bernie's Bait & Tackle Mail with screen readers

1 of many
(no subject)
External
Inbox

VCGiordano
Attachments
5:42 PM (0 minutes ago)
to me







Thank You,

Vincent Giordano
VCGiordano@gmail.com
ph: (347) 834-2654
 2 Attachments
  •  Scanned by Gmail
# Bernie's Inventory Scanner v13 No Reload

Major fix:
- Scans submit in the background with fetch()
- Page does NOT reload after each scan
- Barcode field stays alive between scans
- Designed to fix C66 issue where second scan needs reselecting field

Includes:
- One-screen C66 layout
- REMOVE / ADD mode
- ADD mode PIN once
- ADD mode timeout
- Undo without page reload
- Auto-clear/refocus after scan
- Duplicate protection

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
README.md
Displaying package.json. 
