# Bernie's Scanner v26 - Remove Keyboard Test

Built from v25.

Changes:
- Removes inputmode="none" from barcode input.
- This restores the normal editable barcode field for the C66 scanner wedge.
- Keeps recent feed.
- Keeps full LOG.
- Keeps variant/detail on its own line.
- Keeps LOG close page refresh from v25.

Reason:
- C66 showed fake focus / no scan input after fresh startup and after closing LOG.
- The keyboard suppression test is the likely cause.
