# Cloudflare OS Starter Troubleshooting

Use this reference only after reading the current checkout. Commands, validation, and deployment order may have changed.

## Evidence Rules

Collect the smallest useful, sanitized evidence:

- Exact failing command and first error.
- Root commit, submodule gitlink, and checked-out submodule commit.
- Whether the worktree changed before or during the failure.
- Node, pnpm, project-pinned Wrangler versions.
- Boolean presence of `CLOUDFLARE_API_TOKEN`, never its value.
- Sanitized `wrangler whoami` identity and target account ID.
- Which deploy stages completed and their deployment/version IDs.
- Resource names/IDs only when the audience is authorized to see them.
- Narrow log events with secrets, prompts, headers, bodies, JWTs, and user data removed.

Do not paste full production configs or logs by default. Never run a command that prints the active authentication token.

## First Classification

```text
Failure
|- Before submodule checkout: provenance or source access
|- During install/build/test: local setup or compatibility
|- During generated-config validation: deployment.jsonc
|- During Wrangler dry-run: generated configuration, build output, or local validation
|- During live deploy: auth, permission, product, route, provisioning, or resource
|- After one or more Workers deployed: partial deployment
|- Browser cannot reach the Router: route, TLS, Access, or app auth
|- Router answers but a path fails: its service bindings or the Worker behind that path
|- App loads but capability fails: service binding, Gatekeeper, AI, or storage
|- Data is absent: binding identity, sharing boundary, or migration; never provision a replacement first
`- Reports/logs are absent: signal semantics, sampling, time range, or binding
```

## Submodule And Provenance

| Symptom | Check | Safe response |
| --- | --- | --- |
| `cloudflare-os/package.json` is absent | `git submodule status`, parent gitlink, `.gitmodules` | Initialize only from the reviewed configured source. |
| SSH permission denied | Whether `.gitmodules` points to a private host and operator is entitled | Stop. Use authorized access, or approve a public mirror only after proving the exact SHA exists. |
| Host key prompt | Expected source host and organization instructions | Do not accept an unknown key merely to proceed. Verify out of band. |
| Submodule begins with `-` in status | It is not initialized | Run the checkout's documented init after source review. |
| Submodule begins with `+` | Checked-out SHA differs from gitlink | Stop. Restore the pinned commit or review an explicit upgrade. |
| Commit unavailable on proposed mirror | Mirror provenance or incomplete history | Do not substitute a nearby commit or branch head. Escalate. |

Never use `git submodule update --remote` for setup or recovery.

## Toolchain And Install

| Symptom | Check | Safe response |
| --- | --- | --- |
| Unsupported engine or syntax | Node major and repository `packageManager` | Install the documented Node/pnpm versions. Do not regenerate the lockfile with another manager. |
| `pnpm` lockfile changes on install | pnpm version, checkout cleanliness, dependency provenance | Stop and review. A setup operation should not silently become a dependency update. |
| Package missing under submodule, or `cfos install:` says the workspace is not installed or stale | Whether the root `postinstall` ran: `--ignore-scripts`, or a gitlink bump since the last install | Run `pnpm cfos install`, which installs `cloudflare-os/` from its own lockfile, frozen. The packages here `link:` into the submodule, so the root install alone never installs its dependencies. `pnpm cfos install --check` confirms it. |
| `pnpm install` reports a `@cloudflare/*` 401/404 | A global npmrc routing the `@cloudflare` scope to a private registry | The repository `.npmrc` pins the scope to the public registry. Check that it is present and that no environment variable overrides it. |
| Build fails after submodule move | Parent wrapper compatibility, base configs, APIs, dependencies | Treat it as an incomplete upgrade, not an ordinary build issue. |
| `wrangler.prod.jsonc` remains | Active check/deploy process and original failure | Preserve the error, prove no active process, then remove only stale generated files. Never edit/deploy them. |
| Concurrent writes to generated config | Multiple operations in one checkout | Stop both safely and use separate worktrees. |

## `deployment.jsonc` Validation

| Error | Likely cause | Correction |
| --- | --- | --- |
| Missing value or placeholder | An active config branch still has a placeholder | Replace only active required values. Dormant AI/Reporter placeholders may be intentionally ignored by current code; verify the script. |
| Account ID invalid | Not the exact 32-character account ID | Obtain it from an authorized Cloudflare surface. Do not infer it. |
| Worker names not unique | Two active Workers share an identity | Select stable non-conflicting names after remote inventory. |
| Worker name format invalid | Uppercase, punctuation, leading/trailing hyphen, or excessive length | Use a lowercase Cloudflare-compatible service name. |
| Route requires exactly one mode | Both/neither `customDomain` and `workersDev` selected on the Router | Choose one route based on the approved operation mode. No other Worker takes a route. |
| Custom domain invalid | URL/path/uppercase supplied instead of hostname | Use the exact lowercase hostname only. |
| `publicBaseUrl` required on a workersDev route | Nothing in the checkout knows the account's `workers.dev` subdomain, and `PUBLIC_BASE_URL` plus the Context sharing boundary both need an origin | Set it to the exact origin the Router will answer on, scheme included. |
| `publicBaseUrl` does not match `customDomain` | Two different hostnames configured for one origin | Correct one. Leaving them disagreeing would scope Context data to a host the deployment does not answer on. Prefer `null`, which derives the origin from the domain. |
| `publicBaseUrl` must be an HTTPS origin only | Path, query, trailing slash, or `http` | Supply the bare origin, e.g. `https://os.example.com`. |
| `publicBaseUrl` is not a workers.dev origin, or names another Worker | A host other than `https://<router-name>.<subdomain>.workers.dev` on a `workersDev` route | Supply the origin Wrangler actually serves the Router on. Only the account subdomain is unverifiable here; the Worker label and the `workers.dev` suffix are not, and a wrong host would become both `PUBLIC_BASE_URL` and the Context boundary. |
| `sharingDomain` must be null or a non-empty string | Empty string or a non-string pinned boundary | Use `null` to follow the public origin, or the exact literal the existing collections live under. |
| Access issuer invalid | Path, query, non-HTTPS, or malformed team origin | Copy the Access team HTTPS origin, without path. |
| Audience blank/padded | Wrong Access value or whitespace | Copy the exact AUD tag from the matching application. |
| Admin email invalid | Non-email or mismatched identity representation | Use the exact verified email expected by the backend. |
| Storage must be null/string | Empty or malformed resource identifier | Choose automatic provisioning (`null`) or a proven existing ID/name. |
| AI gateway name required | `aiGateway.enabled` is true with no `name` | Supply a reviewed existing or new gateway name, or set `enabled: false` and accept that users must bring their own model keys. |
| `aiGateway.workersAi` does nothing | An older config still carries the key | Delete it. Workers AI rides the same gateway route as every other provider, and leaving the key in place would deploy a Workshop with no models. List `"cloudflare"` in `providers` to keep Workers AI. |
| Sampling outside 0..1 | Percentage entered as 10/100 rather than fraction | Set a value from 0 through 1 based on volume and incident needs. |

## Wrangler Identity And Permissions

| Symptom | Check | Safe response |
| --- | --- | --- |
| Not authenticated | Project-pinned `wrangler whoami` | Use interactive login or the approved credential mechanism. Do not paste tokens. |
| Unexpected account | `CLOUDFLARE_API_TOKEN` presence, Wrangler profile, configured account ID | Stop before mutation. Select the intended credential/account explicitly. |
| Permission denied | Exact API operation and product | Grant only the current documented minimum. Do not switch to broad administrator access as a diagnostic. |
| Product/binding unavailable | Account entitlement for Workers, KV, R2, Browser Rendering, Dynamic Worker Loaders, or enabled AI | Enable/obtain the product or revise the approved design. |
| Worker already exists | Remote owner and deployment history | Continue only if it is the known deployment identity; otherwise choose another name. |
| Secret required during Workshop deploy | Whether `providers` includes `google` or `aiGateway.accountId` names another account | Only those two require a token. Either install it interactively on the exact Workshop identity, or revise the configuration back onto the binding transport. |
| `secret put` targets the wrong account/Worker | Missing account selector or unproven Worker ownership | Stop. It already deploys a version; inventory the mutation, contain if needed, and use an account-bound approved correction. |

## Routing, DNS, TLS, And Access

### Custom-domain deploy fails

1. Confirm the zone is active in the same account.
2. Check for existing DNS records, custom domains, Worker routes, or Access apps on the hostname.
3. Do not delete a collision until ownership and impact are approved.
4. Inspect certificate/domain status before retrying; repeated deploys do not fix an ownership conflict.

### Redirect loop

Check, in order:

1. Capture the sanitized HTTP status and `Location` chain without cookies, JWTs, or query secrets; identify whether Access or the Workshop emits the loop.
2. Access application covers the exact hostname being opened.
3. `access.issuer` is the matching team origin.
4. `access.audience` is the exact AUD for that application.
5. No proxy, alternate hostname, or stale deployment points at a different app.
6. Browser cookies/session belong to the expected Access organization.

Use an incognito session after config correction. Do not bypass Access to prove the Workshop works.

### Access returns 403

- If everyone is denied, test the application policy and IdP mapping.
- If one intended user is denied, test that identity against the policy and exact email claim.
- If Workshop loads but `/admin` is denied, compare the non-sensitive authenticated email claim to `access.admins`, then prove the intended admin list was deployed to the running Workshop; Access policy and admin authorization are separate.
- If an unauthorized user enters, stop exposure and tighten Access before investigating application features.

### Evaluation route is unexpectedly public

`workersDev: true` creates a route; it does not configure Access. Protect the exact `workers.dev` hostname the Router answers on with its own Access application.

`generateConfigs()` (`packages/cfos/src/core/deployment.ts`) writes `preview_urls: false` on all Workers other than the router worker, because a Preview URL is an unauthenticated path around the Access-protected origin. Verify that in the derived config rather than assuming it, check the current Wrangler docs for changed defaults, and never patch the generated config to alter one.

If a Worker other than the Router is publicly reachable, that is an Access bypass, not a routing nicety: the derived config gives the other six `workers_dev: false` and no routes, so an unexpected route means something outside this deploy created it.

### `pnpm cfos check` says `deployment.jsonc` does not match the account

The checks ran through `cf` and found something the file names that the account lacks: no Access application with that audience, an application that does not cover the Router's hostname, an issuer from another team, or a KV namespace, R2 bucket or AI Gateway that is not there. Each line names the config path. Correct the value from the account (`pnpm cfos import <instance>` for a hosted instance, `pnpm cfos access --dry-run` for Access) rather than creating a resource to match a typo.

If `pnpm cfos check` printed `Skipped Cloudflare-side checks`, none of that was verified. `cf` was not signed in, or its token lacks a permission the line names. Treat the run as offline-only.

## Storage And Missing Data

Treat missing data as a possible wrong binding, not an invitation to create storage.

1. Stop writes.
2. Compare current Worker name and binding to the last-known-good deployment.
3. Identify the bound KV namespace or R2 bucket in the target account.
4. Determine whether automatic provisioning created a new empty resource.
5. Confirm the old resource still exists and its ownership/data classification.
6. Restore a known-good binding only after compatibility and approval.
7. Verify reads and writes with non-sensitive test data.

Never copy, merge, delete, or adopt production data automatically. A Worker rename combined with automatic provisioning is a prime suspect when the application appears empty.

### Context collections are missing but the KV namespace is right

Suspect the sharing boundary before the storage. The Workshop's `GATEKEEPER_CONTEXT` binding carries a `sharingDomain` prop, and collections are visible only within it. `context.sharingDomain: null` derives it from the public origin, so a changed hostname silently changes the boundary while every KV binding stays correct.

Compare the deployed binding's prop against the value the collections were written under, and restore it by pinning that exact literal. Do not re-provision the namespace, and do not treat the collections as lost: nothing was deleted.

### Schedules are missing

Suspect the Worker identity, and nothing else. The Scheduler keeps everything in Durable Objects belonging to its own script identity, with no KV, R2 or sharing-boundary prop involved, so a changed `workers.scheduler.name` is the only ordinary way its schedules disappear: the new script starts with empty DO namespaces while the old one keeps running with the data, bound to nothing.

Compare the deployed `GATEKEEPER_SCHEDULER` binding on the Workshop and the Router against the previously deployed Scheduler Worker name, and restore that name. Nothing was deleted; do not delete the old Worker until the binding is proven.

### Automatic provisioning denied

Verify the exact required permission and product availability. If reproducible production binding is needed after provisioning succeeds, inventory the resulting resource IDs/names and plan an explicit binding update. Do not treat temporary generated Wrangler files as the durable inventory.

## AI

| Symptom | Check | Safe response |
| --- | --- | --- |
| Deploy says required secret is missing | Secret name on exact Workshop identity | Human installs it interactively after account/name confirmation. Re-enter approval before redeploy. |
| 401/403 during inference | Token account and current required scopes | Correct least privilege; do not print or replace the token in chat. |
| Gateway not found | Gateway name/account and direct vs gateway mode | Correct configuration after ownership review. |
| Provider authorization/billing error | Unified Billing/BYOK/provider setup | Complete provider setup or disable that provider. |
| Model picker is empty | `aiGateway.enabled`, and whether the deployed Workshop actually carries `CF_AI_GATEWAY*` vars | Most often a migration from the hosted deploy left `aiGateway` disabled: `wrangler deploy` replaces `vars` wholesale, so the hosted values are gone and `getAiGatewayConfig()` returns null. Enable it and point `name` at the instance's own gateway. See `docs/migrate-from-hosted.md`. |
| Deploy demands a token unexpectedly | `aiGateway.accountId` and whether `google` is in `providers` | Those are the only two configurations that need `CF_AI_GATEWAY_API_TOKEN`. `accountId: null` and no `google` uses the pre-authenticated `WORKERS_AI` binding instead. |
| Unexpected logs contain prompts | Gateway/logging configuration and export | Stop sensitive traffic, disable collection where supported, review exposure and retention. |
| Unexpected cost or rate limit | Billing account, provider, model, retries, alerts | Disable funded models if needed, preserve usage evidence, and require cost review. |

Secret existence is not runtime verification. Use only an approved non-sensitive low-cost prompt for an end-to-end connectivity check. Verify scope, billing, prompt collection, retention, and log access separately in their authoritative control surfaces.

## Custom Gatekeeper

| Symptom or finding | Risk | Response |
| --- | --- | --- |
| Gatekeeper still matches starter example | Low-stakes shared text only | Keep disabled until operator chooses policy; optional smoke test may be approved. |
| Example verifier used with tenant/confidential data | Collaborators may observe unauthorized data | Disable immediately and design fail-closed observer verification. |
| External read is not authorized as an observation | Audit/security boundary broken | Disable capability, load `write-gatekeeper`, add authorization and tests. |
| Side effect executes directly | Approval boundary bypassed | Disable writes; redesign around submit/apply/reject/simulation. |
| OAuth/token added to vars or tracked files | Credential exposure | Stop, revoke/rotate, remove from current and historical exposure paths, then redesign secret storage. |
| Auto-provisioned singleton gains broad authority | Ambient capability may reach every user/workspace under policy | Reassess provisioning mode, identity, capability granularity, and admin policy. |

Do not patch a serious Gatekeeper issue during a production deploy. Disable it, preserve evidence, and handle it as a separate security-reviewed change.

## Error Reporter And Logs

| Symptom | Check | Interpretation or response |
| --- | --- | --- |
| No Reporter Worker | `errorReporting.enabled`, configured name, deploy stage output | It may be disabled or its deploy failed. |
| Reporter has no events | Whether a known explicit `reportIssue()` capture occurred | Empty is expected without explicit reports. It is not a catch-all. |
| `error_report.dispatch.failed` | Service name, `ErrorReporter` entrypoint, deployment order/availability | Correct the binding or Reporter deployment; reporting must remain best-effort. |
| Invocation exists but query is empty | Selected Worker, time range, sampling, field filter, export | Narrow the query and confirm retention/sampling. |
| Wrong environment/release | Workshop service-binding props in derived config | Correct config and redeploy affected Workers together. |
| Stack is not symbolicated | Matching source map/release and whether stack is runtime or explicit | Follow destination-specific source-map handling; do not expose maps publicly. |
| Browser endpoint sends nothing | Reporter and rate-limiter bindings, build flag | Expected by default. Do not enable ad hoc. |

The Reporter must have no public route. Its events remain visible to authorized account log readers and configured exports, so private ingress does not remove privacy obligations.

## Partial Deployment

The baseline sequence is three waves: Error Reporter, Context, Scheduler, Web Search and Custom Gatekeeper together; then the Workshop; then the Router. Re-read `deployWaves()` in `packages/cfos/src/core/deployment.ts` for the current waves. A failure inside a wave does not cancel that wave's other deploys -- they finish, and the next wave never starts -- so a failed stage can sit beside completed siblings from the same wave.

The Router is last because it binds every other Worker, which shapes recovery: a failure before it leaves the previous Router version serving the public URL against a partly-updated set of backends, so the live site can look healthy while the stack is mixed. A failure *of* the Router leaves the site on its previous version with new backends behind it.

When deployment stops:

1. Do not rerun immediately.
2. Record the failed stage and deployment/version IDs for every completed stage.
3. Compare new downstream RPC/storage contracts with the still-running old Workshop.
4. Check live errors without exposing user data.
5. Choose one approved path:
   - **Complete:** fix the blocker and deploy the remaining/full compatible stack.
   - **Roll back changed Workers:** only when current bindings, migrations, and data remain compatible.
   - **Contain:** restrict Access or disable an affected Gatekeeper while a safe plan is prepared.
6. Re-run `pnpm cfos check`, re-enter approval, and perform full verification.

For breaking contracts, do not alternate old/new code under the same service names. Use parallel service identities and a controlled binding switch.

## Upgrade Regression

Likely causes after a gitlink update:

- An upstream Wrangler base-config field is overwritten by `generateConfigs()` (`packages/cfos/src/core/deployment.ts`).
- Shared RPC or Gatekeeper interfaces changed.
- Durable Object migrations/classes changed.
- Storage schema changed.
- Authentication or AI environment requirements changed.
- Dependencies or build outputs are no longer wrapper-compatible.

Compare old and new base configs and generated configs section by section, especially `vars`, `services`, KV, R2, assets, migrations, and required secrets. Do not solve incompatibility by copying old generated Wrangler files forward.

## Rollback Decision Matrix

| Change | Version rollback alone? | Required review |
| --- | --- | --- |
| Code-only, same bindings/contracts/storage | Possibly | Current Cloudflare rollback support and post-rollback smoke test. |
| Service binding or entrypoint changed | Usually insufficient | Restore compatible configuration and coordinated service versions. |
| Access/DNS changed | No | Restore separately and retest allowed/denied paths. |
| Secret changed | No | Restore/rotate separately without exposing values. |
| KV/R2 binding changed | No | Restore intended binding; verify data compatibility. |
| Durable Object migration/class changed | Often blocked or unsafe | Specialist migration review; never promise rollback. |
| Data mutated | No | Product-specific data recovery/forward repair. |
| First deployment partially completed | No prior system state | Complete safely or perform separately approved teardown. |

After any rollback, rerun the complete live verification. Do not call rollback successful because a command returned zero.

## Escalation Packet

After two identical failures, provide:

```text
Goal and operation mode:
Root/submodule commits and source provenance:
Target account/route (redacted as appropriate):
Exact failing stage and first sanitized error:
Stages already mutated and deployment IDs:
Expected vs actual behavior:
Checks performed and results:
Single changes attempted:
Current Access/data exposure:
Rollback/containment state:
Specific decision or expertise needed:
```

Do not include secrets, JWTs, full logs, prompts, user data, request/response bodies, or unredacted private configuration.
