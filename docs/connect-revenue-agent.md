# Connect Revenue Agent (named-tool grant)

Sign in at https://os.touchless.io with Google / Access OTP. That is the company Workshop
(Worker `cloudflareos`). Cloudflare OS trusts the Access JWT — no password signup.

MCP stays on path prefixes of https://os.touchless.io (`/mcp`, `/v1`). Do not deploy this starter onto `os.touchless.io`
([hostname-cutover.md](hostname-cutover.md)). `revenue.touchless.io` is retired (detached, no 301). Workshop is the only Revenue UI; thin chat is parked.

## AI inference (already on the live OS)

Workshop talks to AI Gateway `cloudflareos-ai` via env on `cloudflareos-backend`
(`CF_AI_GATEWAY`, `CF_AI_GATEWAY_ACCOUNT_ID`, `CF_AI_GATEWAY_PROVIDERS=cloudflare`, secret
`CF_AI_GATEWAY_API_TOKEN`). Compat URL:

`https://gateway.ai.cloudflare.com/v1/100999ce2892ed4147ecde16eb4c0188/cloudflareos-ai/compat/chat/completions`

The starter’s `touchless-os-ai` gateway is unused for the company kernel.

## S1 — Named-tool grant only

Revenue Agent tools still need a one-time OAuth connect. Access cookies stay in the browser;
the MCP gatekeeper calls `/mcp` from a Durable Object, so it stores its own per-user Access OAuth
token (same identity, same ACL tiers).

1. Open **Admin** → Gatekeepers / Connectors. Disconnect `workers-observability` if connected (it sorts first and steals Any-MCP). Connect the Revenue Agent account once at the user level (Access OAuth) if needed. Prefer the named-tool URL:

```text
https://os.touchless.io/mcp#tool=search_revenue_agent
```

2. In the shared Revenue workspace, **Add resource → MCP Server → Any MCP server**, then pick the existing account `https://os.touchless.io/mcp` (not `https://observability.mcp.cloudflare.com/mcp`). In Tools, choose **Choose tools** and tick **only** `search_revenue_agent` (not `search_company_brain`, not any `gmail_*`). Click **Add connection**.

3. If the workspace shows a pending-changes banner, click **Accept changes**. Without that, the bind stays a chat draft and new chats will not see `env.search_revenue_agent`.

Do **not** grant the bare endpoint with **All tools**. Do **not** grant `gmail_search` / `gmail_get_message` / `gmail_status` (or any `gmail_*` tool). Workspace storage would retain mail content and break S1.

Complete the Access OAuth popup with your Touchless identity (same Google account). Do not open that URL in a normal browser tab — `/mcp` rejects GET.

Reps joining via share link reuse this workspace binding but must complete **their own** MCP OAuth (Gatekeeper checks required permissions per user). See [workspaces.md](workspaces.md) — mint a **build**-role (**Workspace**) share link, not use-role.

## Brand + agent instructions

In **Admin**:

- Site name: **Touchless OS** (Revenue is a workspace, not the whole site)
- Accent / logo as desired
- Default agent instructions (sales-meta framing):

```text
You are the Touchless Revenue Agent. Answer questions about Salesforce opportunities, interest and pricing signals, and interaction pointers scoped to the signed-in user's mailbox — not email bodies. Prefer the search_revenue_agent tool with lane=sales-meta for revenue Q&A. Only cite facts the tool returns. If retrieval is empty or out of scope, say you do not have access rather than guessing. Live Gmail tools are not available in this workspace.
```
