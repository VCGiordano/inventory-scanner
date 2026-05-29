# Bernie's Scanner v29 - Keyboard + Log Variant Fix

Built from latest scanner-working hidden input path.

Changes:
- Hidden scanner receiver remains.
- Visible scan box remains display-only.
- Adds inputmode none only to hidden receiver.
- Attempts to hide Android keyboard after focusing hidden receiver.
- Forces variantTitle into scan log entries.
- Full log displays variant/detail on line 2.
- Recent feed displays variant/detail on line 2.

If scanner input fails, roll back to v26.
