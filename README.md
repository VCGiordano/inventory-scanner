
# Bernie's Inventory Scanner - Functional MVP

This is the first functional Railway version.

## Required Railway Variables

Add these in Railway:

- SHOPIFY_CLIENT_ID
- SHOPIFY_CLIENT_SECRET
- SHOPIFY_STORE
- SHOPIFY_LOCATION_ID
- APP_PIN

Example:

SHOPIFY_STORE=bernies-bait-and-tackle.myshopify.com
SHOPIFY_LOCATION_ID=123456789
APP_PIN=1234

## What it does

- Minus mode default: barcode scan subtracts 1 from Shopify inventory
- Plus mode: requires PIN and adds 1
- Undo last scan
- Duplicate scan protection
- No Shopify orders created

## Important

This version uses the Shopify Dev Dashboard client credentials grant.
The Shopify app must have scopes:
- read_products
- read_inventory
- write_inventory
