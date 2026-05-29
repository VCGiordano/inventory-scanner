# Bernie's Scanner v25 - Log Close Refresh

Built from stable v23, not v24.

Changes:
- Closing LOG now refreshes the scanner page instead of trying blur/focus re-arm.
- This avoids the C66 fake-focus issue after viewing log.
- Variant/detail appears on its own line in recent feed.
- Variant/detail appears on its own line in full log.

Important:
- Since log is in-memory, a page refresh keeps the log as long as Railway process stays running.
- Railway redeploy/restart still clears the in-memory log.
