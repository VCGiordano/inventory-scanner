# Bernie's Scanner v33 - Idle Re-arm + Keyboard Hide

Built from stable v31/v30 path.

Changes:
- Adds idle re-arm timer.
- If idle for about 45 seconds, barcode field blurs then refocuses.
- Attempts to hide soft keyboard after re-arm/focus.
- Does not change barcode input architecture.
- Keeps stable scanner behavior.

Purpose:
- Fixes issue where scanner beeps but does not input after sitting idle.
- Keyboard hide remains a best-effort bonus.
