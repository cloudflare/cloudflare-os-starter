# Admin checklist — Touchless OS Workshop

Sign in at the live company Workshop: `https://os.touchless.io` (Worker `cloudflareos`). Do not deploy this starter over that hostname. Inference uses AI Gateway `cloudflareos-ai` on `cloudflareos-backend`.

## Site

- Site name: **Touchless OS** (not “Revenue Agent only”)
- Accent / logo as desired
- Admins: `remi@touchless.io` (`deployment.jsonc` `access.admins`)

## Default agent instructions (Revenue)

Paste from [connect-revenue-agent.md](connect-revenue-agent.md). Sales-meta only; no Gmail tools.

## MCP grant (S1)

Connect **only**:

```text
https://os.touchless.io/mcp#tool=search_revenue_agent
```

Do not grant bare `/mcp`. Do not grant `gmail_*`. Restrict who can paste arbitrary MCP URLs (admin-only).

On Gatekeepers, disconnect `workers-observability` so Any-MCP defaults to `revenue-agent` (`https://os.touchless.io/mcp`). After binding tools in the workspace, **Accept changes** if a pending-changes banner appears.

## Pre-provision reps

See [workspaces.md](workspaces.md). Shared workspace + **build**-role (**Workspace**) share link + named-tool bind. Each rep still does Access login and one MCP OAuth. Do not put the `#share=` fragment in git.

## Smoke

1. Access login with a `@touchless.io` (or permitted) Google account.
2. Open the shared-team **Revenue** workspace (see [workspaces.md](workspaces.md)).
3. Confirm model is **GLM 5.2 (Workers AI)** (not Code).
4. Ask a sales-meta question (opportunity / interest / pricing pointer). Expect a `search_revenue_agent` tool call and citations from retrieval only.
5. Ask something out of scope or empty. Expect “do not have access” / no guess.
6. Confirm the workspace has no Gmail tools.

MCP origin is `https://os.touchless.io/mcp` (named-tool grant only). `revenue.touchless.io` is retired. Workshop is the only Revenue UI. See [hostname-cutover.md](hostname-cutover.md).

## DeepSeek V4 Flash (Workers AI)

Official hosted id: `@cf/deepseek-ai/deepseek-v4-flash-0731`. Not unified-catalog `deepseek/deepseek-v4-pro` and not R1 Distill. Routed through AI Gateway `cloudflareos-ai` on the `workers-ai` provider. GLM 5.2 stays the Revenue default.

1. Open `https://os.touchless.io` Home composer.
2. Confirm the picker lists **DeepSeek V4 Flash (Workers AI)** next to **GLM 5.2 (Workers AI)** and **Kimi K2.7 Code (Workers AI)**.
3. Select Flash only in a non-Revenue test chat. Do not change the Revenue workspace default unless you intend to.

If the picker still says Neuralwatt, the live `cloudflareos-backend` catalog has not picked up this patch. Do not `pnpm deploy` this starter onto `os.touchless.io`. The Neuralwatt custom-provider key is unused for Flash after this change.
