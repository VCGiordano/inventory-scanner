# Bernie's Scanner v35 - Click Re-arm Test

Built from v34.

Change:
- Idle re-arm no longer calls focus().
- It blurs the barcode input, then dispatches mouse/click events to try to reactivate scanner input without reopening Android keyboard.

Goal:
- Keep scanner from going stale after idle.
- Avoid keyboard popping back up every idle re-arm.

If scans fail after idle, roll back to v30/v31/v34.
