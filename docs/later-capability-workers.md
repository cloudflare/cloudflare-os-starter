# Later capability Workers (not Phase 0–2)

Decompose Touchless bot domains. **Never** one OS workspace with GitHub+Jira+Notion+Neon+CF+RAG+browser.

| Domain | OS shape | Do not use |
|---|---|---|
| GitHub | Dedicated Worker or OS GitHub gatekeeper, **read vs write** split | Org GitHub App `3195153` PEM in Workshop DOs. Stock gatekeeper is **user OAuth App**, not that App. |
| Jira | Dedicated SA Worker + Access allowlist, or stay on OpenClaw | Mini `jira-service.json` copied into OS storage |
| Notion | OS Notion gatekeeper (per-user OAuth) or SA Worker | Bot integration token in DOs |
| Cloudflare ops (DNS/cache/Workers) | **New** ops MCP, ask-first mutations | Stock CF gatekeeper (sign-in + AI Gateway billing only) |
| Slack send, cron, pilot, RAG index, Chrome, Figma local | **Stay OpenClaw / Mini** | OS Slack gatekeeper (read-only); Scheduler is not Mini launchd |

Identity: prefer Access JWT ∩ allowlist over N refresh tokens (same idea as Gmail DWD). Tool results may appear in chat; do not persist mail bodies or SA private keys in Overseer storage.

Do not turn off `@Touchless Bot` until a domain has both an OS workspace and a Slack story. Hybrid end state: Slack OpenClaw for mentions; Workshop for grant-scoped work.
