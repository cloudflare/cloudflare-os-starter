---
name: cloudflare-os-operator
description: Guides cloudflare/cloudflare-os-starter setup, Cloudflare Access, deployment.jsonc, storage, AI, observability, custom Gatekeepers, deployment, verification, troubleshooting, rollback, and pinned-submodule upgrades. Use only for deployments created from the Cloudflare OS Deployment Starter, not standalone Cloudflare OS checkouts.
compatibility: Requires Git, the checkout-declared Node.js and pnpm versions, project-pinned Wrangler, and a Cloudflare account with the products used by the deployment.
---

# Cloudflare OS Operator

Own the outcome, not just the next command. Guide the operator from an unprepared checkout to a verified deployment, or from a failure to a diagnosed and safe recovery. A provider outage, unavailable product, or incorrect external policy can never be ruled out in advance, so do not promise an issue-free deployment. Prevent avoidable failures and do not call the work complete without evidence.

This skill operates the deployment wrapper, not Cloudflare OS in isolation. The wrapper pins Cloudflare OS as a submodule, derives temporary Wrangler configs, and coordinates several Workers.

## Locate The Starter

Find the repository root containing all of these markers:

- `deployment.jsonc`
- `packages/cf-os/`
- `cloudflare-os/`
- `packages/custom-gatekeeper/`

Do not assume the current working directory or this skill's directory is the starter root. If the markers are absent, stop and ask for the starter checkout. Do not apply this workflow directly to a standalone Cloudflare OS checkout.

Once the submodule is initialized, confirm `cloudflare-os/packages/router/` exists as well. The deploy binds and deploys it, so a pinned commit without it cannot be deployed by this wrapper; treat its absence as a provenance problem, not a missing build step.

## Read Current Sources First

Before any mutation, always read the current checkout's:

1. `README.md`
2. `deployment.jsonc`
3. `packages/cf-os/src/core/deployment.ts` and `packages/cf-os/src/commands/deploy.ts`
4. `package.json`
5. `.gitmodules`
6. Available relevant upstream files under `cloudflare-os/`

Load `docs/customization.md`, `docs/observability.md`, package guides, and reference files from this skill only when their subject is relevant. If the submodule is unavailable, inspect all available wrapper sources and defer upstream-dependent advice until provenance is resolved.

Inspect the deploy code rather than assuming its validation, generated paths, build steps, or deployment order. Consult current Cloudflare documentation before relying on product behavior, permissions, CLI syntax, limits, or rollback support. Repository code is authoritative for what this checkout does; current Cloudflare documentation is authoritative for the platform it calls. Surface conflicts instead of silently choosing one.

Expected baseline commands are:

```sh
git submodule update --init
pnpm install                   # its postinstall (`cf-os install`) installs cloudflare-os/'s workspace too
pnpm exec wrangler login
pnpm exec cf auth login        # optional: account lookups, Access setup, the check's account checks, and `cf-os secrets`
pnpm cf-os import <instance>   # read-only, for an instance ejected from the hosted deploy
pnpm cf-os access --dry-run
pnpm cf-os check
pnpm cf-os deploy
pnpm cf-os api whoami          # after a deploy: the live API answers, as the identity it signed in as
```

Confirm them against the checkout before running them (`pnpm cf-os --help` lists the commands). Always use `pnpm`, never `npm` or `yarn`; the one exception is `npx cf-os@latest update`, which fetches the newest published CLI. `pnpm check` and `pnpm deploy` are aliases for the last two.

Against the account, the commands split as follows:

- **Read-only:** `pnpm cf-os import`, `pnpm cf-os check`, `pnpm cf-os access --dry-run`, and `pnpm exec cf ... list`/`get`. They suit the inventory step.
- **Local writes only:** `pnpm cf-os import --out <path>` writes a local file (pointed at `deployment.jsonc`, it edits that in place), so treat it like any other edit to approved configuration. `npx cf-os@latest update` merges the starter's `main` (a git merge, left conflicted if it conflicts), checks the submodule out at the starter's pin, runs `pnpm install`, regenerates the `cf-os api` files from the pin (unstaged), and writes `.cf-os/update.md`; follow that brief and [references/updating.md](references/updating.md). Its `--upstream` merges the starter's `main` the same way, committed, then stages an unreviewed pin, which needs the upgrade gate in [references/upgrade-and-rollback.md](references/upgrade-and-rollback.md) before it is committed.
- **Against the instance, not the account:** `pnpm cf-os api <command>` calls the running instance's API as the identity it signs in as (by default the operator's Access identity, from `cloudflared access login <origin>`), with commands generated from the pin. `whoami`, `list-*` and `get-*` commands only read, and so do most `subscribe-*` ones, except that a subscription can count as a client being present (while `subscribe-to-notifications` runs, the instance holds back the user's mobile push); others, such as `approve-action`, `send-chat-message` or any `delete-*`, change the instance's data and need approval like any other production mutation. `--dry-run` prints the calls and connects to nothing.
- **Mutating:** `pnpm cf-os access` without `--dry-run` can create an Access application. `pnpm cf-os init` reads the account and writes `deployment.jsonc`, but its Access step can create an Access application and a One-time PIN identity provider when the operator chooses to, and once the file is complete it offers to run `pnpm cf-os deploy`. Outside a project, `cf-os init <dir>` can also create a private GitHub repository and push to it. `pnpm cf-os secrets`, and `init` when credentials are entered, set Gatekeeper secrets, each a new Worker version. `pnpm cf-os deploy` deploys every Worker without asking for confirmation. Each needs approval like any other remote mutation.

`pnpm cf-os init` is interactive and refuses without a terminal. Agents should use `import`, `access`, direct edits to `deployment.jsonc` and an approved `pnpm cf-os deploy` instead, which take every answer as a flag or from the file.

## Operating Rules

- Start read-only. Inventory before mutation.
- Ask for all missing operator decisions in one concise batch.
- Explain why each requested value is needed and where to find it.
- Never guess an account ID, resource ID, hostname, Access issuer, audience, administrator, Worker name, provider, or existing-resource ownership.
- Never expose a token, cookie, JWT, secret, prompt, request body, response body, or private log content in chat, tracked files, command arguments, or reports. For local development only, use Wrangler's supported local-secret mechanism after proving the file is ignored and the credential is non-production.
- Use the project-pinned Wrangler through `pnpm exec wrangler`.
- Run only one `pnpm cf-os check` or `pnpm cf-os deploy` per checkout at a time. Use separate worktrees for concurrency.
- Change one root cause at a time. Re-run the narrow check, then the complete check.
- Do not broaden permissions, disable security controls, recreate resources, or retry deployments blindly to make an error disappear.
- Keep a sanitized operation record: root commit, submodule commit, target account, intended route, Worker names, resource identities, deployment/version IDs, decisions, verification, and rollback limits.

## Classify The Operation

Choose one mode before acting:

- **Research:** read-only explanation or design.
- **Evaluation:** a non-production deployment, usually on an explicitly protected `workers.dev` hostname.
- **Production:** a custom domain and production data or users.
- **Incident:** restore safety and service while preserving evidence.
- **Update:** merge the starter's latest, and with it the starter's pin, with `npx cf-os@latest update`. Follow [references/updating.md](references/updating.md).
- **Upgrade:** move the pinned `cloudflare-os` gitlink to a reviewed commit.

Also classify the deployment as a first deploy, continuation of an existing deployment, or replacement. If this is unclear, remain read-only.

## Hard Stops

### Secrets

Never ask the operator to paste a secret. Never read or print a secret to confirm it. Never put production secrets in `deployment.jsonc`, Wrangler vars, repository-local environment files, tracked files, shell history, or chat.

When AI is enabled, a human enters `CF_AI_GATEWAY_API_TOKEN` interactively for the exact Workshop Worker:

```sh
CLOUDFLARE_ACCOUNT_ID=<account-id> pnpm exec wrangler secret put CF_AI_GATEWAY_API_TOKEN --name <workshop-worker>
```

Each optional Gatekeeper's OAuth secrets go on its own Worker (`gatekeepers.<slug>.name`). A human enters them with `pnpm cf-os secrets <slug>` (or `init`'s deploy), or by hand with `wrangler secret put … --name <gatekeeper-worker>` after the first deploy, since `secret put` on a missing Worker creates a placeholder one. `check` warns while one is missing.

Confirm this account selector against current Wrangler documentation. Confirm the account, existing Worker ownership, and Worker name immediately before presenting or running the interactive command. Setting a secret, with `secret put` or `cf-os secrets`, immediately deploys a new Worker version; require production approval, record its version ID, and verify it like any other deployment. Verify only that the secret name exists, never its value. If exposure is suspected, stop deployment and rotate or revoke the credential first.

### Trust Boundary

Require explicit operator approval before changing any of these:

- Cloudflare account, Worker identity, route, DNS, or Access application.
- Access issuer, audience, sign-in method, policy, administrator list, or allowed population.
- Existing KV/R2 bindings, `publicBaseUrl`, `context.sharingDomain`, data ownership, or service bindings. The public origin is a data boundary as well as an address: `context.sharingDomain: null` derives from it, so moving the hostname moves the Context isolation boundary with it.
- AI provider, billing, token scope, model logging, retention, or external observability export.
- Gatekeeper authority, OAuth scopes, writes, observer policy, auto-provisioning, or ambience.
- Reporter visibility, browser reporting, retention, or destination.
- Durable Object migrations or storage schema.

Show the authority before and after, affected users/data, cost and privacy implications, verification plan, and rollback limitations.

### Production Mutation

Do not run `pnpm cf-os deploy`, install or delete secrets, modify Access/DNS, adopt resources, or roll back production until the operator approves a mutation summary containing:

- Exact account ID and hostname.
- Root and submodule commits.
- Every Worker to create or update.
- Every resource to provision or adopt.
- Access application and administrator policy.
- AI, observability, Reporter, and Gatekeeper modes.
- Last-known-good deployment IDs and rollback limitations.
- Evidence that `pnpm cf-os check` passed.

Never delete Workers, routes, Access applications, KV namespaces, R2 buckets, secrets, or user data as automatic cleanup or troubleshooting.

## End-To-End Workflow

### 1. Establish Provenance And State

Record, without leaking credentials:

```text
operation mode and first/continuation/replacement:
root commit and branch:
root worktree changes:
configured submodule URL:
expected submodule gitlink:
checked-out submodule commit and status:
Node, pnpm, and Wrangler versions:
Wrangler authentication source and target account:
route, hostname, and resolved public origin:
Worker names and whether each is new, owned, or conflicting:
storage choice and ownership for each binding:
AI Gateway name, providers, and whether a token is required:
error-reporting mode:
custom Gatekeeper provenance and intended policy:
last-known-good deployment/version IDs:
```

Inspect `.gitmodules` before initializing. If its URL is private or inaccessible, do not request SSH credentials, accept an unknown host key, rewrite the URL, or substitute a branch head. Offer these choices:

1. Use an already-authorized source.
2. Use a public mirror only after proving the exact pinned commit exists there and receiving approval for the provenance change.
3. Stop.

The checked-out submodule commit must equal the parent gitlink. Never use `git submodule update --remote` or an unreviewed "latest" commit.

Check whether a `CLOUDFLARE_API_TOKEN` environment variable is present without printing it; it may override an expected Wrangler profile. Use sanitized `pnpm exec wrangler whoami` output to prove the account matches `deployment.jsonc.accountId` before mutation. Never run a command that prints the active authentication token.

Inventory remote Worker-name and route collisions. A syntactically valid Worker name can overwrite an unrelated Worker in the same account. Stop on unknown ownership.

### 2. Collect Deployment Decisions

Ask once for any decisions not established by existing approved configuration:

1. Evaluation or production, target account, exact hostname, and zone for a custom domain. On a `workers.dev` route, also the exact `publicBaseUrl` origin, which the operator has to supply because nothing in the checkout can derive it.
2. Access application, intended users, identity provider requirements, administrators, and denied test identity.
3. Stable names for the Router, Workshop, Context, Scheduler, Web Search, Custom Gatekeeper, Error Reporter, and each optional Gatekeeper (`<router>-gk-<slug>` by default, as the hosted flow names them). Only the Router's name appears in the public URL; the Workshop's is the identity every Durable Object belongs to, and Context and Scheduler own Durable Objects of their own — collections and schedules — so renaming either strands its data. An optional Gatekeeper's Durable Objects hold its users' connections, so the same holds for it.
4. New auto-provisioned or existing resource for each of Context KV, Blueprints KV, Avatars KV, and Blueprint Content R2.
5. Which AI Gateway and which providers; billing/BYOK on the gateway, budget, prompt/response logging, and retention. Disabling `aiGateway` at all is the exception, not the default.
6. Error Reporter enabled state, environment/release metadata, telemetry sampling, and retention/export policy.
7. Web Search disabled, optional, or enabled, and who pays for searches: AI Gateway credits on the account, or a Ceramic key on the gateway it actually searches through (`aiGateway.name` when it is in this account, otherwise the account's `default` gateway). The free Workers AI allowance does not cover them, and the mode is set in `/admin` after deploying, not by the deploy.
8. Custom Gatekeeper not deployed (`customGatekeeper.enabled: false`), or deployed and disabled, optional, or enabled in `/admin`, and whether its code still matches the low-stakes example.
9. Which optional Gatekeepers to deploy (`gatekeepers`), and for each OAuth one, who owns its OAuth application and scopes. The MCP portal also needs `gatekeepers.mcpportal.vars.MCP_PORTAL_URL`.
10. Rollback tolerance and the person authorized to approve production mutation.

Default recommendations for a first evaluation are the default AI configuration (enabled, the account's own gateway, `cloudflare` only, no token), Context Artifacts disabled, new storage, Error Reporter enabled and private, Web Search disabled in `/admin` until billing is confirmed, Custom Gatekeeper disabled until reviewed, narrow Access policy, and operators-only access until verification completes. Do not ask first-time operators about Context Artifacts; discuss it only when the existing configuration enables it or the operator explicitly requests Git-backed Context collections.

### 3. Prepare The Workspace

Require Node.js major 24 and pnpm major 11 unless the current repository says otherwise. Confirm account access to every enabled product, including Workers, KV, R2, Browser Rendering, and Dynamic Worker Loaders. Workers AI and AI Gateway belong on that list: the model catalog is enabled by default, and Web Search runs on Workers AI and searches through AI Gateway (the account's `default` gateway when the catalog is off). Only a deployment with the catalog off and Web Search disabled in `/admin` can do without them. Artifacts is optional.

Run the repository's documented setup commands. Stop if installation unexpectedly changes lockfiles, the submodule gitlink, or tracked files. Resolve provenance or version drift; do not normalize it away.

Temporary `wrangler.prod.jsonc` files are generated implementation details. Never edit, commit, or deploy them directly. If one remains after interruption, first prove that no check/deploy process is active, preserve the original failure, and then remove only the stale generated file.

### 4. Configure Cloudflare Access And Routing

Treat routing, authentication, and `/admin` authorization as separate controls.

The route belongs to the Router alone. Every other Worker is generated with `workers_dev: false`, no routes, and Preview URLs off, so the Router's hostname is the single Access-protected entrance. Verify that in the generated configs rather than assuming it, and treat any additional public route on a backend Worker as an Access bypass.

For production:

1. Confirm the hostname belongs to an active zone in the target account.
2. Stop on an existing DNS record, Worker route, custom domain, or Access application collision. Never delete a conflicting record automatically.
3. Create or identify a self-hosted Access application covering the exact hostname. `pnpm cf-os access --dry-run` reports whether one already covers it, and shows the request it would otherwise send. The application it creates admits exactly `access.admins`, by email.
4. Use a narrow policy for intended identities. Broad `Everyone`, `Bypass`, or weak bootstrap policies require an explicit risk acceptance.
5. Copy the exact HTTPS team-origin issuer and exact application audience tag. `pnpm cf-os access` writes both, and `pnpm cf-os check` confirms them against the account when `cf` is signed in.
6. Make administrators an explicit subset of users allowed by Access.

For evaluation, using `workersDev: true` does not itself add authentication. Protect the exact evaluation hostname with Access and use that application's audience. `publicBaseUrl` must name that same hostname: it is what `PUBLIC_BASE_URL` and the Context sharing boundary derive from, and the deploy refuses a `workers.dev` route without it. Confirm Preview URLs are off in every generated config, and never patch a generated file to change one.

For a first `workers.dev` deployment, determine whether the Access application can be created for the predictable hostname before the Worker exists. If it requires the Worker first, present a controlled two-stage bootstrap for approval: pre-create only a reserved Router Worker identity with no sensitive application or data, enable Access and obtain its audience, then configure and run the wrapper deployment. Do not use `pnpm cf-os deploy` for the identity bootstrap because it deploys the whole stack. Record and minimize any temporary public route, and do not proceed if the bootstrap cannot be contained.

Initially allow only deployment operators. Widen access only after `/admin` policy and all post-deploy checks pass.

Verification must include an unauthenticated/incognito request, one intended administrator, one authenticated non-administrator when applicable, and one denied identity. Verify there is no unintended alternate route that bypasses Access.

### 5. Configure `deployment.jsonc`

Edit only the annotated, non-secret control surface unless the requested feature cannot be expressed there.

- Account IDs are exact 32-character hexadecimal IDs.
- Active Worker names are unique, stable, lowercase account-level service identities.
- Set exactly one Router route: `customDomain` or `workersDev: true`. No other Worker takes a route.
- `publicBaseUrl` is an HTTPS origin with no path and no trailing slash, `null` only on a custom domain, and must agree with `customDomain` when both are set.
- The Access issuer is an HTTPS origin without a path; the audience is exact and unpadded.
- Administrator emails must match the verified identity representation expected by the current backend.
- Keep the Context data-isolation boundary stable unless intentionally creating a new one. `context.sharingDomain: null` follows the public origin, so a hostname change moves the boundary; pin the old origin as a literal string to hold it in place.
- Context Artifacts defaults to disabled when `enabled` is omitted; when enabled, keep its namespace stable. Omitting the namespace selects `gatekeeper-context-collections`, while `null` is invalid.
- `customGatekeeper.message` is tracked and agent-readable. It is not a secret store.
- Set release metadata only to a real deployment identifier; use `null` otherwise.

Account IDs, administrator emails, hostnames, resource identifiers, and organization guidance are non-secret but potentially sensitive repository metadata. Confirm the repository audience before committing them.

Choose storage separately for all four bindings. `null` requests Wrangler automatic provisioning. An explicit value adopts an existing resource and therefore requires proof of account ownership, data classification, compatibility, and backup status. Similar names are not proof.

Context Artifacts is separate from those KV/R2 resources. Enabling it creates the namespace implicitly with the first repository. Disabling it later stops repository refresh and token management but does not delete repositories or cached Context content. Treat repository write tokens as credentials and record the namespace in the deployment inventory.

After first production provisioning, inventory the actual resource identities. Consider pinning explicit IDs/names when reproducible binding is required. Treat Worker renames as migration work because they can create new service identities, provision empty resources, or orphan old mappings.

### 6. Configure AI

`aiGateway.enabled` defaults to true, and that is normally the right setting. Every provider, Workers AI included, is reached through AI Gateway over the Workshop's `WORKERS_AI` binding, which is pre-authenticated inside the deployment's own account. The common configuration needs **no `CF_AI_GATEWAY_API_TOKEN`**, so there is no token bootstrap to sequence.

Disabling it is a deliberate choice with a consequence: every user must then supply their own model API keys, and a deployment migrated from the hosted flow shows an empty model picker because `wrangler deploy` replaces `vars` wholesale and drops the hosted `CF_AI_GATEWAY*` values. Confirm the operator wants that before setting it false.

Decisions to confirm:

1. Which gateway. `default` is created on first use; a migration from the hosted deploy must reuse `<instance>-ai` (see `docs/migrate-from-hosted.md`).
2. Which providers, and for `anthropic`/`openai` the billing/BYOK setup and budget on the gateway itself.
3. Whether prompts/responses are logged, where, for how long, and who can access them.
4. Whether `aiGateway.accountId` should stay `null`. A different account is the deploy's way of saying the gateway is out of the binding's reach, and it turns the token back on.

Only two configurations still require the token, and `pnpm cf-os check` names whichever applies before deploying: the `google` provider, whose adapter refuses the binding's fetch, and a gateway in another account. In exactly those cases the generated config declares the secret as required, so wrangler refuses the deploy without it — install it interactively on the exact Workshop identity, after confirming account and Worker ownership, and record the version it deploys.

Never remove the `WORKERS_AI` binding to opt out of gateway transport. It is also what the agent's `webFetch` document-to-Markdown conversion runs on. The supported opt-out is `aiGateway.accountId`, which the deploy translates into `CF_AI_GATEWAY_USE_BINDING: "false"`.

A secret existing does not prove its scope, billing, or account is correct. One approved, non-sensitive, low-cost request proves only the runtime inference path. Verify token configuration, billing ownership, Gateway/provider logs, prompt collection, retention, and access policy through their authoritative control surfaces. Disabling AI does not delete an existing secret.

### 7. Review The Custom Gatekeeper

The starter example is credential-free, read-only, auto-provisioned, and permissive to observers because it returns identical low-stakes text to every authenticated user. Those choices are unsafe defaults for account-specific, tenant-specific, or confidential data.

A deployment that does not want it sets `customGatekeeper.enabled: false`, and no Worker or binding is generated for it. Otherwise, keep the Custom Gatekeeper disabled in `/admin` until its provenance and authority are reviewed. If it has been customized, load the upstream `write-gatekeeper` skill and stop for operator approval of the agent-facing API before implementation or enablement. Review:

- Capability and resource granularity.
- Every observation and side effect.
- Approval, application, rejection, and simulation behavior.
- Observer verification and sharing boundaries.
- OAuth scopes, token storage, revocation, and account isolation.
- SSRF and untrusted external responses.
- Auto-provisioning, optional connection, and ambient authority.

Never enable it for everyone merely to complete a smoke test. If an approved smoke test is needed, use the least-authoritative policy and disable it again unless continued access was approved.

### 8. Configure Observability And Error Reporting

Keep the Error Reporter private with no route. It receives only explicit upstream `reportIssue()` events; it does not catch every exception or `console.error`, cover every Worker automatically, or provide alerting.

Structured logs, invocation logs, traces, browser reports, sampling, source maps, export, retention, and alerts are separate decisions. Sampling can hide individual events. Never put secrets, prompts, headers, bodies, or raw user documents in errors or report attributes.

Browser reporting stays disabled unless rate limiting, origin checks, private source-map handling, data retention, and privacy review are all approved. Do not manufacture a production exception containing user data to test reporting. If no deterministic non-sensitive capture exists, record end-to-end Reporter dispatch as unverified rather than claiming success.

### 9. Validate Locally

Run:

```sh
pnpm cf-os check
```

Expect wrapper tests, selected package builds, generated Wrangler configs, and Wrangler dry-runs as defined by the current `commands/deploy.ts`. Confirm generated files are removed afterward. An upgrade also requires the separate relevant upstream checks described in the upgrade reference.

When `cf` is signed in, `pnpm cf-os check` also confirms the following exist in the account: the Access application with the configured audience, covering the Router's hostname; the team domain matching the issuer; and every explicitly named KV namespace, R2 bucket and non-default AI Gateway. When `cf` is not signed in it skips those checks with one notice line, so read the output rather than the exit code. Existence is not ownership. Passing `pnpm cf-os check` does not prove remote resource ownership, secret scope, Access policy, custom-domain availability, billing, live service compatibility, or data preservation. Fix failures one cause at a time, run the narrow package/test where useful, then rerun the complete check.

### 10. Approve And Deploy

Before requesting approval, inventory current deployed version IDs for all affected Workers and verify downstream RPC changes remain compatible with both the old and new Workshop. The deployment is not atomic. Every build has to pass before anything deploys; the Workers then deploy in three waves, each starting only once the one before has finished:

1. Error Reporter (when enabled), Context, Scheduler, Web Search, Custom Gatekeeper (when enabled) and every optional Gatekeeper, concurrently.
2. Workshop, which binds every one of them.
3. Router, which binds the Workshop and every Gatekeeper.

If `deployWaves()` in the current `packages/cf-os/src/core/deployment.ts` differs, use its waves. A failure inside a wave lets that wave's other deploys finish, then stops before the next wave, so several Workers of one wave can be updated while one is not. The Router going last means a failure before it leaves the previous Router version still serving the public URL over partly-updated backends, so a healthy-looking site is not evidence the deploy completed. Breaking cross-Worker contracts need parallel identities and a controlled binding switch, not an in-place deploy.

Present the production mutation summary from the hard stop. After explicit approval, run:

```sh
pnpm cf-os deploy
```

Each Worker's Wrangler output is printed as one block when it finishes, so read every block in a wave, not just the last. Record each successful stage and resulting deployment/version ID. On the first failure, stop and inventory actual remote state before deciding to resume or roll back. Never assume the script is transactional or retry-safe.

### 11. Verify The Live Deployment

Success requires evidence for every applicable item:

- The intended hostname serves valid TLS on the Router and is the only intended public route.
- The API answers through the Router and Access: `pnpm cf-os api whoami` signs in with the operator's Access token and returns their identity, `pnpm cf-os api am-i-admin` returns true for an administrator and false for a non-administrator, and `pnpm cf-os api list-gadgets` lists the workspaces that existed before (evidence for the data item below). A failure that names `cloudflared access login <origin>` is an Access token problem on this machine, not proof the deployment is broken. These prove the authenticated path only: the negative Access tests still need their own evidence.
- The Router proxies correctly: the frontend loads, `/api` reaches the Workshop, and a Gatekeeper that serves HTTP answers under `/gatekeeper/<name>`.
- Access redirects/denies unauthenticated users, allows the intended identity, and denies the negative test identity.
- `/admin` allows an administrator and denies an authenticated non-administrator.
- Signup, connector, Context, and Gatekeeper policies match the approved decisions.
- Workshop, Context, Scheduler, Web Search, Custom Gatekeeper, every optional Gatekeeper, and Error Reporter have no public routes and no Preview URLs. Each would be an unauthenticated path around the Router's Access application.
- Existing data remains visible; newly created data persists across a safe reload or redeploy test.
- Context Artifacts is absent when disabled, or an approved Git-backed collection can be populated and refreshed in the intended stable namespace when enabled.
- Each Workshop service binding targets the intended service, entrypoint, and props, and each Router service binding targets the intended service with no entrypoint. The Context binding's `sharingDomain` prop matches the boundary the existing collections live under.
- The Custom Gatekeeper is not deployed, disabled, or behaves according to its reviewed policy; approved reads appear as observations.
- Each optional Gatekeeper connects for one approved identity, and `pnpm cf-os check` names none with missing secrets.
- The model picker lists the configured providers' models, and one approved low-cost request proves the runtime path, with separate evidence for billing ownership, provider/Gateway selection, prompt collection, retention, and log access, plus token scope where a token is required. An empty picker is a failure, not an absence of evidence: see `references/troubleshooting.md`.
- Existing schedules are still listed and a newly created one fires. Both come from the Scheduler's own Durable Objects, so an empty list on an upgraded or migrated deployment points at its Worker name, not at its storage.
- An agent's web search returns results. It runs through the configured `aiGateway.name` (the account's `default` gateway when `aiGateway` is disabled or in another account), and needs AI Gateway credits or a Ceramic key on that gateway: the free Workers AI allowance does not cover searches. Who pays, and whether Web Search is enabled, optional or disabled, is an approval decision like any other billing.
- Router, Workshop, Context, Scheduler, Web Search, Custom Gatekeeper, every optional Gatekeeper, and Reporter logs are available with the expected sampling.
- The Reporter query surface exists; absence of events is not a failure without an explicit capture.
- No secrets or generated Wrangler files are tracked.
- Last-known-good deployment IDs and recovery instructions are recorded.

Do not declare success from a passing check, an HTTP 200, Worker existence, or absence of visible errors alone.

### 12. Close Out

Give the operator a concise report:

```text
Outcome: verified / partially verified / failed safely
Account and route:
Root/submodule commits:
Workers changed and deployment IDs:
Resources provisioned or adopted:
Access positive/negative evidence:
AI, Gatekeeper, and Reporter state:
Checks performed:
Unverified items and why:
Rollback path and limits:
Follow-up owners:
```

Redact identifiers when the audience does not need them. Do not include authentication artifacts, private log bodies, or sensitive configuration.

## Failure Recovery

Use [references/troubleshooting.md](references/troubleshooting.md) for symptom-specific checks and recovery. For every failure:

1. Stop further mutation.
2. Preserve the first exact error and identify which deployment stages succeeded.
3. Classify it as provenance, local setup, validation, authentication, authorization, routing, resource, partial deployment, runtime, data, or compatibility.
4. Form one falsifiable root-cause hypothesis.
5. Gather the minimum non-sensitive evidence needed to test it.
6. Correct one cause and run the narrowest relevant check.
7. Rerun `pnpm cf-os check`.
8. Re-enter the approval gate if production or a trust boundary changed.
9. Deploy and repeat the full live verification.

After two identical failed attempts, stop and escalate with sanitized evidence. Do not widen permissions or recreate infrastructure as an experiment.

## Rollback

Rollback is a coordinated system operation, not one command. Read [references/upgrade-and-rollback.md](references/upgrade-and-rollback.md), produce the per-Worker rollback matrix, require approval, and repeat the full live verification. Never delete or downgrade storage as an automatic rollback step.

## Pinned Submodule Upgrade

Never advance the submodule blindly. Taking the starter's pin with `npx cf-os@latest update` is the reviewed path: follow the brief it writes and [references/updating.md](references/updating.md). `update` also regenerates the `cf-os api` files from the new pin, left unstaged for review with it; after the deploy, `pnpm cf-os api whoami` and the API checks in step 11 verify the live API. Moving past it, by `update --upstream` or by hand, is an upgrade: read and follow [references/upgrade-and-rollback.md](references/upgrade-and-rollback.md), and [references/updating.md](references/updating.md) for what an upstream range usually needs here. An evaluation worktree prevents local file races but is not staging isolation; use separate Worker identities, route, storage, bindings, and data. Stop for specialist review before any migration, deleted/renamed Durable Object class, irreversible data change, auth boundary change, or incompatible RPC change.
