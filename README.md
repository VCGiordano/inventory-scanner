# Bernie's Scanner v27 - Hidden Scanner Input

Built from last scanner-working version.

Changes:
- Visible barcode box is now display-only, not an editable text field.
- Hidden offscreen input receives scanner wedge input.
- This should prevent Android keyboard from covering the scanner screen.
- PIN remains normal and brings up keyboard only when needed.
- After ADD mode activation, PIN blurs and hidden scanner input refocuses.
- Variant/detail displays on its own line in recent feed and full log.

If scanner input fails, roll back to v26.
