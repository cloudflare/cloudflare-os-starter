# Workspaces — one kernel, many grants

Touchless OS is **one** Cloudflare OS deploy. Agents are **workspaces** (instructions + MCP grants), not extra OS Workers.

## v1 (through Phase 2)

| Workspace | Backend | Grant |
|---|---|---|
| **Revenue** (shared team) | `revenue-agent` | `https://os.touchless.io/mcp#tool=search_revenue_agent` only |
| **Reports** (shared team) | `reports-mcp` | `https://os.touchless.io/reports/mcp#tool=query_dash` only — Access app **Reports MCP** AUD `91cf79fc…`; dual-run `reports.os.touchless.io` until gadget rebind; do not grant bare `/mcp`, `gmail_*`, `query_ets_ers`, or revenue-agent tools |
| **Cost** (shared ops) | `cf-cost-os` | Dashboard `https://os.touchless.io/cost/`; MCP five `get_*` tools at `https://os.touchless.io/cost/mcp` — OS Access cookie (no fourth app). See [cost-workspace.md](cost-workspace.md). |

Workshop at `https://os.touchless.io` is the only Revenue UI. Thin chat (`chat.os.touchless.io` / `revenue-chat`) is parked — not a required dest.

Default model: **one shared-team Revenue workspace** (ops simplicity). Switch to per-rep blueprint copies if chat history must be private.

### Live shared workspaces (owner: Remi)

**Revenue:** `https://os.touchless.io/workspace/269d9f98fe2041e972f5083b716ede02c0e2f2a1fd36c9ae78499757843fb2ec`
Title: **Touchless Revenue Sales Workspace**. Prefer `search_revenue_agent` / `lane=sales-meta`; forbid Gmail tools.

**Reports:** `https://os.touchless.io/workspace/479d99984cda6a4584b86a460c4686dbbb02b19b9f95ef7d182242b5d8abad50`
Title: **Touchless Reports Workspace**. Shell gadget **Reports Shell** accepted. Model **GLM 5.2**. Query-only instructions; never fabricate. Gadget connection **MCP_REPORTS** (`reports-mcp`) with **Choose tools** `query_dash` only. Canonical MCP URL is `https://os.touchless.io/reports/mcp` (reconnect from `reports.os.touchless.io` after path-share deploy). Owner smoke: approved `query_dash` returned `Hanania Auto Group`. Build-role share minted out of band — do not commit `#share=`.

**Cost:** create via [cost-workspace.md](cost-workspace.md). Dashboard `https://os.touchless.io/cost/`.

**Do not** publish Eng until exo-rag MCP is validated. A persona with no tools is costume.

## Pre-provision for reps (minimal setup)

OS cannot complete Access OAuth on a rep’s behalf. Gatekeeper stores a **per-user** MCP token. What you *can* do beforehand:

1. Create the shared Revenue workspace (done) and set sales-meta instructions (done).
2. On **Gatekeepers / Connectors**, disconnect Cloudflare Observability MCP (`workers-observability` / `https://observability.mcp.cloudflare.com/mcp`) so it is not the default Any-MCP account. Keep the `revenue-agent` account at `https://os.touchless.io/mcp`.
3. In the shared Revenue workspace, ensure there is at least one gadget (Connections are gadget-scoped). Then open **Connections → Connect resource** (or composer **Add resource**) → Any MCP → existing `https://os.touchless.io/mcp` account → **Choose tools → `search_revenue_agent` only**. Do not paste a new Any-MCP URL. Do not grant `gmail_*`, `search_company_brain`, or bare `/mcp` all-tools.
4. With a chat open, the bind is provisional until you click **Accept changes** on the pending-changes banner — otherwise it stays a chat draft and new chats will not see the MCP binding in `env`.
5. Pin **GLM 5.2 (Workers AI)** (or another non-Code chat model), not `Kimi K2.7 Code`.
6. Admin: site name **Touchless OS**; agent instructions = sales-meta (not touchless-sf). Context Library and Custom Gatekeeper ambient modes **Disabled** so sales chats do not get `env.CONTEXT` / `env.CUSTOM`.
7. Mint a **build**-role share link (Share → Access to grant → **Workspace** / “Edit gadgets, use chat, and manage access” → Create link). Send the `#share=…` URL out of band — do not commit the fragment to git.
8. Optional: invite by email after they have signed in once (`addCollaborator` requires an existing OS account).

What each rep still does (once):

1. Open `https://os.touchless.io` and complete Cloudflare Access (Google / OTP). `@touchless.io` and `@autogenius.io` are allowed on the OS app.
2. Open the share link. The workspace appears on their home after first open.
3. Complete the Revenue Agent MCP OAuth popup when Gatekeeper asks (same Google identity). After that, chat should call `search_revenue_agent`.

If chat history must stay private, publish this workspace as a **blueprint** and have each rep instantiate their own copy. They still do Access + MCP OAuth; they do not paste MCP URLs.

## Admin policy

- Site name: **Touchless OS**
- MCP URL pasting: **admin-only**. Users must not connect arbitrary MCP servers.
- Never grant `gmail_*` or bare `https://os.touchless.io/mcp` (S1).
- Never grant OpenClaw / Mini `exec` / GitHub App PEM into a workspace.

## After OS validated (Phase 3+)

See [eng-workspace.md](eng-workspace.md) then [reports-mcp-contract.md](reports-mcp-contract.md). Later domains: [later-capability-workers.md](later-capability-workers.md).

Slack stays OpenClaw (`@Touchless Bot`). Hybrid: Slack for mentions; Workshop for grant-scoped work.
