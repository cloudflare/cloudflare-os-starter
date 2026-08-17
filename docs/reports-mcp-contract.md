# Reports MCP contract (query-only)

A **Reports** OS workspace is allowed only after this Worker exists and the tools below pass smoke. Do not publish an empty Reports persona.

This document is the written SQL/API contract for implementing `query_dash` and `query_ets_ers`. It does not authorize Mini / touchless-bot edits. Sources: bot `workspace-touchlessBOT/skills/NEON.md`, `scripts/reports/README.md`, `scripts/reports/lib/neon.py`, `scripts/reports/run_report.py` (GitHub `touchlesscode/touchless-bot`).

---

## Worker host and named tools

| Item | Value |
|---|---|
| Worker name (intended) | `reports-mcp` (new app; not `revenue-agent`, not Mini ngrok) |
| Public host | `https://os.touchless.io/reports` (dual-run `https://reports.os.touchless.io` until gadget rebind) |
| MCP endpoint | `https://os.touchless.io/reports/mcp` |
| Health | `https://os.touchless.io/reports/healthz` (also `/v1/health`); CI `https://reports-mcp.touchless.workers.dev/healthz` |
| Auth | Cloudflare Access JWT (`cf-access-jwt-assertion`), own Access app AUD (do **not** reuse Revenue AUD) |
| IdP allowlist | `@touchless.io` + `@autogenius.io` |

### Workshop grant URLs (Reports workspace only)

v1 published tool is **`query_dash` only**:

```text
https://os.touchless.io/reports/mcp#tool=query_dash
```

`query_ets_ers` stays in the SQL contract (below) but is **hidden** from `tools/list` and `/v1/mcp/info` until `ETS_SCHEMA_ALLOWLIST` is non-empty. Do not grant it in Workshop v1.

Never grant bare `/mcp` (all tools), GitHub, Jira, Gmail, OpenClaw `exec`, or Revenue tools into the Reports workspace.

---

## Hard policy (non-negotiable)

Copied and hardened from bot `NEON.md`:

1. **Queries only.** Accept `SELECT` / `WITH … SELECT` only. Reject INSERT, UPDATE, DELETE, TRUNCATE, DDL, GRANT/REVOKE, `COPY`, `CALL`, multi-statement batches, and anything that acquires write locks.
2. Connect as a **read-only DB role** and force session/transaction read-only:
   - Prefer role `touchless-core-read-only` for Dash (`touchless-core` / `iam`).
   - On every connection / transaction: `SET default_transaction_read_only = on` **and** `SET TRANSACTION READ ONLY` (belt and braces; writes must fail with `cannot execute … in a read-only transaction`).
3. **Never fabricate** rows, counts, or metrics. If a query fails or returns empty, report the error / empty result.
4. Mutations / backfills → human operator (not the agent).
5. Do not dump raw PII into chat; aggregate where possible.
6. Do not mint Neon connection URIs via the Neon API key inside the Worker (see Connectivity).

---

## Connectivity (Worker)

| Concern | Contract |
|---|---|
| Transport | **Cloudflare Hyperdrive** → Neon Postgres (region placement `aws:us-east-1` preferred) |
| Dash binding | Hyperdrive config → Neon project `touchless-core`, database `iam`, role `touchless-core-read-only` |
| ETS/ERS binding | Second Hyperdrive → Neon project `rudderstack`, read-only role (provision/confirm in Track B4) |
| Secrets | Wrangler secrets / Hyperdrive connection string only |
| **Forbidden** | Neon API key (`napi_…`), Mini path `~/.config/touchlessbot/neon.txt`, ephemeral URI minting in the Worker |

Mini `scripts/reports/lib/neon.py` still mints URIs with the Neon API key for cron on the Mini. That pattern is **out of scope** for this Worker.

---

## SQL safety defaults

Align with `core-db/apps/mcp-codex-db/src/db.ts`, with exploratory LIMIT tightened per bot `NEON.md`:

| Knob | Default | Max / notes |
|---|---|---|
| Exploratory / tool `rowLimit` | **50** | Cap hard at **500** (client-requested) |
| `statement_timeout` | **5000 ms** | Also set `idle_in_transaction_session_timeout` to the same |
| Statement shape | Single `SELECT` or `WITH … SELECT` | Wrap as `SELECT * FROM (<sql>) AS mcp_query LIMIT $n` |
| Multi-statement | Reject | No `;`-separated batches |
| Schema enforcement | Allowlist only | Reject any relation outside the tool’s allowlist (including `fusionauth*`, `hdb_catalog`, `pg_catalog` for data tools) |

Catalog introspection for **allowlisted schemas only** may be exposed as separate list/describe helpers later; until then, agents discover via documented table map + failed-query errors.

---

## Schema allowlists

### `query_dash` → `touchless-core` / `iam`

| Rule | Detail |
|---|---|
| **Allowed schema** | `context` only (`context.*` tables and views) |
| **Database** | `iam` on Neon project `touchless-core`, production (default) branch |
| **Blocked** | FusionAuth-owned schemas/tables in the same DB; `hdb_catalog`; `pg_catalog` / `information_schema` as query targets for the data tool; any non-`context` user schema |
| **Rationale** | Despite DB name `iam` and owner role `fusionauth`, Dash analytics live in `context` (confirmed 2026-07-07). FusionAuth auth schemas remain off-limits. |

Implement as: parse/qualify identifiers → require `context.<name>`; reject unqualified names that resolve outside `search_path` to non-`context`; reject cross-schema joins.

### `query_ets_ers` → `rudderstack`

| Rule | Detail |
|---|---|
| **Allowed schemas / tables** | **TBD** — see [ETS/ERS discovery](#etsers--rudderstack-allowlist-tbd) |
| **Until discovery lands** | Ship tool with a **configurable empty or staging allowlist**; refuse queries with a clear “schema not yet allowlisted” error rather than opening the whole project |
| **Blocked by default** | System catalogs, Hasura `hdb_catalog` if present, write-capable roles |

---

## Dash table map (`query_dash`)

Project / branch / db: **touchless-core / production / `iam`**, schema **`context`**.

| Area | Relation | Notes / known columns |
|---|---|---|
| Workspaces | `context.workspace` | `uuid`, `name`, `external_uuid`, `id` (short nano-style, sparse), `partner_uuid`, `created_at`, `deleted_at`. ~174 rows (2026-07-07); filter `deleted_at IS NULL` for live. |
| Tags | `context.tag` | `uuid`, `id` (nanoID — “nanoId”), `owner_workspace_uuid`, `brand`, `extra1`–`extra4`, `is_deleted`. |
| Hosts / domains | `context.tag_host` | License facts: `host`, `license_status`, `price`, `licensed_at`, `license_end_at`, `trial_*`, `pilot_*`, `is_deleted`. FK `tag_uuid` → `tag.uuid`; `workspace_uuid` → `workspace.uuid` (**can dangle**). |
| Hosts (views) | `context.tag_host_active`, `context.tag_host_not_deleted` | Prefer these for live host lists (reports runner uses `tag_host_active`). |
| GA4 | `context.ga4_engagement` | Used by Mini reports: `host`, `segment`, `users`, `sessions`, `engaged_sessions`, `avg_session_duration`, `key_events`, `conversions`, `metric_date`. |
| GA4 meta | `context.ga_connection_check`, `context.tag_host_ga_property` | Connection / property mapping; not yet queried in depth in bot skill. |
| RUM / CWV | `context.rum_run` | Field vitals: `host`, `mode` (`active`/`control`), `report_date`, `has_data`, `sample_count`, `*_p75` (lcp, inp, cls, fcp, ttfb). |
| PSI | `context.psi_run` | Lab: `host`, `mode`, `strategy`, `performance_score`, `lcp`, `fcp`, `cls`, `inp`, `ttfb`, `tbt`, `si`, `workflow_started_at`. |
| CrUX | `context.crux_run` | Origin CrUX runs; not yet queried in depth in bot skill — allowlist the table; columns via describe on first use. |

Canonical Mini report layers (`scripts/reports/run_report.py`): CWV ← `rum_run`, PSI ← `psi_run`, GA4 ← `ga4_engagement`; host resolve via `workspace` + `tag_host_active`.

`neondb` on touchless-core production has **no** user tables — do not point Hyperdrive at it.

---

## ETS/ERS / rudderstack (allowlist TBD)

Bot skill status (2026-07-07 / still current in NEON.md):

| area | project / branch / db | schema.table | notes |
|---|---|---|---|
| ETS/ERS analytics | `rudderstack` / ? / ? | **_tbd_** | Event volumes, speed-layer metrics, experiment activity, per-dealer rollout |

### Discovery plan (Track B4 / first live connect)

1. Provision (or confirm) a **read-only** Neon role on project `rudderstack`; wire Hyperdrive `ETS_DB` (name TBD in Worker bindings).
2. With `default_transaction_read_only=on`, run:

   ```sql
   SELECT table_schema, table_name
   FROM information_schema.tables
   WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
   ORDER BY 1, 2;
   ```

3. For each candidate analytics table, capture columns via `information_schema.columns`.
4. Update this contract’s ETS/ERS table map and the Worker’s **configurable schema/table allowlist** (deny-by-default).
5. Re-smoke `query_ets_ers` with LIMIT 50; refuse anything outside the allowlist.

Until steps 2–4 complete, `query_ets_ers` is **hidden from the MCP catalog** (not registered, not in `/v1/mcp/info`). The SQL helper stays in-tree and fail-closed on an empty allowlist. Do not grant the tool in Workshop until the catalog shows it.

---

## MCP tool API

### Shared input/output shape

**Input (both tools):**

| Field | Type | Required | Description |
|---|---|---|---|
| `sql` | string | yes | Single `SELECT` / `WITH … SELECT` |
| `rowLimit` | integer | no | Default **50**, max **500** |

**Output:**

| Field | Type | Description |
|---|---|---|
| `rows` | object[] | Result rows (never fabricated) |
| `rowCount` | number | Rows returned after LIMIT |
| `truncated` | boolean | True if underlying result may have exceeded LIMIT |
| `error` | string? | On failure: Postgres / validation message; no invented data |

### `query_dash`

- Binding: Dash Hyperdrive (`iam` / `touchless-core-read-only`).
- Enforce schema allowlist: **`context` only**.
- Typical questions: GA4 sessions, RUM/CrUX/PSI vitals, workspace ↔ tag ↔ host joins.

### `query_ets_ers` (later / hidden until allowlist)

- Binding: ETS Hyperdrive (`rudderstack` read-only role).
- Enforce **configurable** allowlist (initially empty / TBD until discovery).
- Not advertised in `tools/list` or `/v1/mcp/info` while `ETS_SCHEMA_ALLOWLIST` is empty. Calling it by name should be unknown-tool, not a SQL error.
- Typical questions: event volumes, experiment activity, dealer rollout (once tables are known).

---



## Deploy status (B4/B5)

| Item | Status |
|---|---|
| Worker | Deployed `reports-mcp` → `https://os.touchless.io/reports*` (+ dual-run `reports.os.touchless.io`, `reports-mcp.touchless.workers.dev`) |
| `DASH_DB` | Hyperdrive `78c0e67707bb4339862a04299cf551c4` (temporary; not `touchless-core-read-only`) |
| `ETS_DB` | Same ID stub; allowlist empty (fail closed). No rudderstack URI yet |
| Access app | **Reports MCP** `b7fcc174-…` AUD `91cf79fc…`. Path dests `os.touchless.io/reports*` plus dual-run nested host. Never apex `/mcp` or `/v1`. |
| Secrets | `CF_ACCESS_AUD` set; `CF_ACCESS_TEAM_DOMAIN` = `touchless.cloudflareaccess.com` |
| Unauth smoke | `/v1/health` **401** Access wrap; `/mcp` **401** (2026-08-14) |

## Auth and workspace publishing

1. Access application **Reports MCP** exists for `reports.os.touchless.io` (+ `/mcp`, OAuth `.well-known`). Separate AUD from Revenue / OS.
2. Deploy Worker; smoke `/v1/health` and `query_dash` with a read-only SELECT against `context.*`.
3. Admin-publish Reports blueprint / workspace with **only** the `query_dash` grant URL above. Do not grant `query_ets_ers`.
4. Excel CWV/PSI/GA4 workbooks and Mini `reports-dispatch` cron may stay on the Mini until this Worker (or R2) owns artifacts — do not store full customer workbooks in Workshop DO storage beyond accepted tool results.

---

## Exit criteria (before Reports workspace)

- [x] Written SQL/API contract (this doc)
- [x] Access app on `reports.os.touchless.io` — **Reports MCP** `b7fcc174-d382-42a2-a52e-714bb9aa2c97`, AUD `91cf79fc3a218e078e5add1cb8954135e187ae97f43e00cd07bb8839c3877c6b` (≠ Revenue `9d266edc…` / OS `a617bd75…`). Secret `CF_ACCESS_AUD` on Worker. See `apps/reports-mcp/README.md`.
- [~] Hyperdrive Dash: temporarily `78c0e67707bb4339862a04299cf551c4` (`core-db-production` / `hyperdrive-touchless-core-user` → `iam`). SQL layer enforces READ ONLY + `context` allowlist. **Ideal still:** dedicated Hyperdrive with `touchless-core-read-only`. ETS: no rudderstack URI — stub same ID; `ETS_SCHEMA_ALLOWLIST` empty → fail closed.
- [x] Worker implements `query_dash` / `query_ets_ers` with SELECT-only, read-only txn, timeout, LIMIT, schema allowlists (scaffold B2+B3; deployed B4/B5)
- [x] Catalog hide: `query_ets_ers` omitted from `tools/list` and `/v1/mcp/info` while `ETS_SCHEMA_ALLOWLIST` is empty (2026-08-14)
- [~] Endpoint smoke: unauthenticated `/mcp` 401. Authenticated tool smoke + Workshop Any-MCP bind still blocked on BCM Gatekeepers popup + dedicated read-only Hyperdrive / ETS discovery. Grant **`query_dash` only** when the bind lands.

---

## Open gaps

| Gap | Status |
|---|---|
| Rudderstack branch / database / schema.table map | **Unresolved** — discovery plan above; allowlist TBD |
| Rudderstack read-only role name | Confirm in Neon console (B4) |
| `context.crux_run` / GA4 meta column depth | Tables allowlisted; columns not fully documented in bot skill |
| FusionAuth schema name enumeration | Deny-by-default via `context`-only allowlist; no need to list every FA schema if enforcement is allowlist-based |
