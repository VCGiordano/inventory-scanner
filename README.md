# Bernie's Scanner v34 - Idle Re-arm, No Keyboard Hide

Built from v33.

Changes:
- Keeps idle re-arm after about 45 seconds.
- Removes keyboard-hide calls that caused keyboard popups every re-arm cycle.
- No barcode input architecture changes.
- Keeps stable scanner behavior.

Goal:
- Prevent stale scanner focus after idle.
- Stop automatic keyboard popups every 45 seconds.
