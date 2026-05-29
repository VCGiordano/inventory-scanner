# Bernie's Scanner v32 - Global Key Capture Web-Only Keyboard Fix

Built from stable v30.

Goal:
- No editable barcode field, so Android keyboard should not open for scanning.
- Scanner data is captured from page-level keydown events.
- PIN remains the only normal input field.

Keeps:
- Recent feed
- LOG
- Variant/detail display
- No visible UNDO
- New York timestamps

Important:
- If C66 only sends scan data to focused inputs, this will not work.
- If scan data is sent as normal key events to the page, this should fix the keyboard problem.
- Roll back to v30 if scans beep but do not register.
