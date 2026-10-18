# Google Sheets Guard

Wrapper-owned P3 Gatekeeper for one deployment-approved synthetic Google Spreadsheet range.

It reuses the pinned Cloudflare OS Google OAuth and Sheets implementation, but replaces the
agent-visible session with `readApprovedRange()`. The spreadsheet ID and A1 range are deployment
secrets, so callers cannot select or expand them. Cloudflare OS `ApprovalQueue` authorization
completes before the agent-visible range read reaches the upstream Google API; the upstream
post-read observation record remains as defense in depth. This is not an OM OS Canonical Runtime
Authorization connection and does not grant OM OS Authority or Permission.

## Enforced boundary

- Only `https://docs.google.com/spreadsheets/d/<P3_SPREADSHEET_ID>/edit` is accepted.
- Only one quoted-sheet, bounded A1 range in `P3_ALLOWED_RANGE` can be read.
- The approved range is limited to 1,000 cells.
- Arbitrary range reads, batch reads, spreadsheet discovery, writes, actions, and Google sign-in
  are rejected.
- The Worker has no public route, `workers.dev` address, or Preview URL. The router forwards only
  `/gatekeeper/google-sheets-guard`; Workshop discovers it internally as `google_sheets_guard`.
- The integration is absent while `googleSheetsGuard.enabled` is false.

## OAuth residual boundary

The pinned upstream OAuth implementation requests identity scopes,
`spreadsheets.readonly`, and `drive.metadata.readonly` for the Sheets resource. The wrapper narrows
what its API can execute, but it does not narrow the OAuth token itself to one spreadsheet.
Therefore P3 requires a dedicated Google account that can access only the approved synthetic
spreadsheet. Do not connect a personal or production Workspace account.

The inherited OAuth/identity flow and observer ACL verification are control-plane operations. They
may contact Google without the per-range `ApprovalQueue` check described above. The wrapper's
pre-authorization guarantee applies to the agent-visible `readApprovedRange()` data-plane call,
not to every HTTP request in the inherited Google integration.

## Required Worker secrets

- `CLIENT_ID`
- `CLIENT_SECRET`
- `P3_SPREADSHEET_ID`
- `P3_ALLOWED_RANGE`

This package does not authorize deployment, OAuth client creation, secret installation, account
connection, or runtime reads. Those remain separate Human Gates.
