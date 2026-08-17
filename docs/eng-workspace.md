# Eng workspace (after Phase 0–2 validated)

**No Mini / touchless-bot edits.** Indexing stays on `openclaw-service` (Ollama + Chroma + `exo-rag-sync` cron).

## Grant

Named-tool / server grant to the **existing** remote MCP:

```text
https://exo-rag.ngrok.app/mcp
```

Bearer token: maintainer copy of `~/.config/touchlessbot/rag-mcp-token.txt` (never commit). Setup: [MCP_SETUP.md](https://github.com/touchlesscode/touchless-bot/blob/main/workspace-touchlessBOT/skills/MCP_SETUP.md). Prefer Streamable HTTP `/mcp`, not deprecated `/mcp/sse`.

Tools to expect (do not extend on the bot): `how_to`, `search_exo_*`, `search_core_db_*`, `search_foundation_*`, `search_hasura_sanity_*`, `package_overview`, `list_packages`, `resolve_package_version`, `rag_health`.

## Must not grant into this workspace

GitHub, Jira, Notion, `exec`, browser, Figma, Neon, Cloudflare ops, OpenClaw conversation MCP, `gmail_*`, `revenue-agent` GitHub knowledge ingest.

## Instructions (admin)

You are the Touchless Eng workspace. Answer exo / core-db / exo-foundation / from-hasura-to-sanity questions only from exo-rag tools. Start with `how_to` for “how do I in exo v2?”. Cite retrieval. If the index is empty or the question is out of corpus, say so.

## Cursor smoke (same corpus, client-only)

If Cursor already has `user-exo-rag`, run `rag_health` then one `how_to` / `search_exo_docs`. Gaps in the bot tool list are out of scope.

## Cursor smoke result (2026-08-12)

`user-exo-rag` `rag_health`: status **degraded** (git mirrors not stale). Probes: `core_db.*` and `exo_foundation.*` ok; `exo.code`/`exo.doc` failed (`Error finding id`); `from_hasura_to_sanity.*` failed (HNSW segment missing on disk). Out of scope to fix on touchless-bot. Prefer `how_to` / foundation / core-db until exo collection probes recover.
