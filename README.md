# Bernie's Inventory Scanner v16 - Log + PIN + No Focus Button

Based on v14 stable scanner behavior.

Changes:
- Adds LOG button
- Adds in-memory scan log viewer
- Logs REMOVE, ADD, and UNDO actions
- Removes FOCUS button
- Bottom row is now only UNDO / LOG
- PIN clears only after ADD mode successfully activates
- Fixes bug where tapping ADD could clear PIN before ADD read it
- More phone-safe layout

Important:
- Log is in-memory only.
- Railway restart/redeploy clears the log.
