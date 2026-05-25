# Bernie's Scanner v19 - No Undo + Variant Display

Built from v17 path because v18 was not implemented.

Changes:
- Removes visible UNDO button
- Keeps LOG fixed at bottom
- Shows variant/detail information on scan confirmation
- Shows variant/detail information in scan log
- Uses SKU/Barcode label since SKU equals barcode in this store
- Does not touch scanner/focus/keyboard behavior

Important:
- Log is in-memory only.
- Railway restart/redeploy clears the log.
