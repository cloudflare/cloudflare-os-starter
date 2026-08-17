# Company OS = live `os.touchless.io` (`cloudflareos`)

Do **not** `pnpm deploy` the starter onto `os.touchless.io`. That would detach Worker `cloudflareos` and wipe the hosted Workshop.

Account: `100999ce2892ed4147ecde16eb4c0188` (Touchless). Issuer: `https://touchless.cloudflareaccess.com`.

Access Write via API is **solved** (PUT succeeded 2026-08-14). Do not recreate Access apps.

`os-mcp.touchless.io` stays top-level (`cloudflareos-mcp-edge`, Salesforce portal). Do not nest it to `mcp.os.touchless.io` unless Salesforce OAuth is painful.

## Live (path-share)

| Path | Worker | Access app |
|---|---|---|
| `os.touchless.io` (UI, `/api`, `/gatekeeper`) | `cloudflareos` | Cloudflare OS `8359664e-…` (AUD `a617bd75…`) |
| `os.touchless.io/mcp*`, `/v1*`, OAuth `.well-known` | `revenue-agent` | Revenue Agent `4d9fb7a1-…` (AUD `9d266edc…`) |
| `os.touchless.io/reports*` | `reports-mcp` | Reports MCP `b7fcc174-…` (AUD `91cf79fc…`) — dual-run with `reports.os.touchless.io` until gadget rebind |
| `os.touchless.io/cost*` | `cf-cost-os` | **same OS app** (no fourth Access app) |

Grant: `https://os.touchless.io/mcp#tool=search_revenue_agent` (never bare `/mcp`, never `gmail_*`).

Reports v1 grant: `https://os.touchless.io/reports/mcp#tool=query_dash` only.

Cost grants: `https://os.touchless.io/cost/mcp#tool=get_caps_current` (and the other four `get_*` tools). Dashboard: `https://os.touchless.io/cost/`.

## Retired

**`revenue.touchless.io` is detached** (2026-08-13). No 301. Worker custom domain removed from `touchless-os`. Treat both `revenue.touchless.io` and `os.touchless.io` as forbidden starter deployment targets; this docs-only handoff does not change the starter deployment configuration or scripts.

**`chat.os.touchless.io` is detached** (2026-08-14). Worker `revenue-chat` is parked on `*.workers.dev` (`touchless-ops/apps/revenue-chat`). Not a required dest. Restore only if reps bounce off Workshop: re-add the custom-domain route, deploy, add dest back to the **same** Revenue Access app. Do not attach to apex `os.touchless.io`.

Revenue Agent canonical destinations: `os.touchless.io/mcp` (primary), `/v1`, OAuth `.well-known`.

Cursor / revops `COMPANY_BRAIN_URL` = `https://os.touchless.io`.
