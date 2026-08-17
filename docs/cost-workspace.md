# Touchless Cloudflare Cost workspace

Primary UX is Workshop on `https://os.touchless.io`. The dashboard is a same-tab link to `/cost/` — same Access cookie as Workshop. No `cost.os.touchless.io`. No fourth Access app.

## Create (owner)

1. Open `https://os.touchless.io` (Cloudflare OS Access).
2. Create shared workspace **Touchless Cloudflare Cost**.
3. Gadget **Cost Shell**: README with link `https://os.touchless.io/cost/` (“Opens the Access-gated cap + attribution viewer. Shadow until invoice + publish.”).
4. Pin GLM 5.2. Do not grant Revenue/Reports/Gmail/Observability.
5. Connections → Any MCP → `https://os.touchless.io/cost/mcp` → **Choose tools** the five `get_*` tools only → **Accept changes**.
6. Instructions: answer only from cost tools; if shadow/`invoice_missing`, say so; never guess billed USD; never tell the user to paste `CAP_READ`.
7. Mint **build**-role share out of band. Do not commit `#share=`.

## Grant URLs

```text
https://os.touchless.io/cost/mcp#tool=get_caps_current
https://os.touchless.io/cost/mcp#tool=get_caps_meta
https://os.touchless.io/cost/mcp#tool=get_caps_history
https://os.touchless.io/cost/mcp#tool=get_attribution_current
https://os.touchless.io/cost/mcp#tool=get_attribution_alerts
```

## Smoke

- Open `/cost/` while signed into Workshop: meters load with no pasted bearer.
- Attribution panel shows shadow + `invoice_missing` until a real invoice exists.
- Approved `get_attribution_alerts` returns alerts without calling `/__run`.
