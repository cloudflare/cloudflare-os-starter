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
- `scripts/deploy.mjs`
- `cloudflare-os/`
- `packages/custom-gatekeeper/`

Do not assume the current working directory or this skill's directory is the starter root. If the markers are absent, stop and ask for the starter checkout. Do not apply this workflow directly to a standalone Cloudflare OS checkout.

## Read Current Sources First

Before any mutation, always read the current checkout's:

1. `README.md`
2. `deployment.jsonc`
3. `scripts/deploy.mjs`
4. `package.json`
5. `.gitmodules`
6. Available relevant upstream files under `cloudflare-os/`

Load `docs/customization.md`, `docs/observability.md`, package guides, and reference files from this skill only when their subject is relevant. If the submodule is unavailable, inspect all available wrapper sources and defer upstream-dependent advice until provenance is resolved.

Inspect the deploy script rather than assuming its validation, generated paths, build steps, or deployment order. Consult current Cloudflare documentation before relying on product behavior, permissions, CLI syntax, limits, or rollback support. Repository code is authoritative for what this checkout does; current Cloudflare documentation is authoritative for the platform it calls. Surface conflicts instead of silently choosing one.

Expected baseline commands are:

```sh
git submodule update --init
pnpm install
pnpm --dir cloudflare-os install
pnpm exec wrangler login
pnpm check
pnpm deploy
```

Confirm them against the checkout before running them. Always use `pnpm`, never `npm` or `yarn`.

## Operating Rules

- Start read-only. Inventory before mutation.
- Ask for all missing operator decisions in one concise batch.
- Explain why each requested value is needed and where to find it.
- Never guess an account ID, resource ID, hostname, Access issuer, audience, administrator, Worker name, provider, or existing-resource ownership.
- Never expose a token, cookie, JWT, secret, prompt, request body, response body, or private log content in chat, tracked files, command arguments, or reports. For local development only, use Wrangler's supported local-secret mechanism after proving the file is ignored and the credential is non-production.
- Use the project-pinned Wrangler through `pnpm exec wrangler`.
- Run only one `pnpm check` or `pnpm deploy` per checkout at a time. Use separate worktrees for concurrency.
- Change one root cause at a time. Re-run the narrow check, then the complete check.
- Do not broaden permissions, disable security controls, recreate resources, or retry deployments blindly to make an error disappear.
- Keep a sanitized operation record: root commit, submodule commit, target account, intended route, Worker names, resource identities, deployment/version IDs, decisions, verification, and rollback limits.

## Classify The Operation

Choose one mode before acting:

- **Research:** read-only explanation or design.
- **Evaluation:** a non-production deployment, usually on an explicitly protected `workers.dev` hostname.
- **Production:** a custom domain and production data or users.
- **Incident:** restore safety and service while preserving evidence.
- **Upgrade:** move the pinned `cloudflare-os` gitlink to a reviewed commit.

Also classify the deployment as a first deploy, continuation of an existing deployment, or replacement. If this is unclear, remain read-only.

## Hard Stops

### Secrets

Never ask the operator to paste a secret. Never read or print a secret to confirm it. Never put production secrets in `deployment.jsonc`, Wrangler vars, repository-local environment files, tracked files, shell history, or chat.

When AI is enabled, a human enters `CF_AI_GATEWAY_API_TOKEN` interactively for the exact Workshop Worker:

```sh
CLOUDFLARE_ACCOUNT_ID=<account-id> pnpm exec wrangler secret put CF_AI_GATEWAY_API_TOKEN --name <workshop-worker>
```

Confirm this account selector against current Wrangler documentation. Confirm the account, existing Worker ownership, and Worker name immediately before presenting or running the interactive command. `secret put` immediately deploys a new Worker version; require production approval, record its version ID, and verify it like any other deployment. Verify only that the secret name exists, never its value. If exposure is suspected, stop deployment and rotate or revoke the credential first.

### Trust Boundary

Require explicit operator approval before changing any of these:

- Cloudflare account, Worker identity, route, DNS, or Access application.
- Access issuer, audience, sign-in method, policy, administrator list, or allowed population.
- Existing KV/R2 bindings, `context.sharingDomain`, data ownership, or service bindings.
- AI provider, billing, token scope, model logging, retention, or external observability export.
- Gatekeeper authority, OAuth scopes, writes, observer policy, auto-provisioning, or ambience.
- Reporter visibility, browser reporting, retention, or destination.
- Durable Object migrations or storage schema.

Show the authority before and after, affected users/data, cost and privacy implications, verification plan, and rollback limitations.

### Production Mutation

Do not run `pnpm deploy`, install or delete secrets, modify Access/DNS, adopt resources, or roll back production until the operator approves a mutation summary containing:

- Exact account ID and hostname.
- Root and submodule commits.
- Every Worker to create or update.
- Every resource to provision or adopt.
- Access application and administrator policy.
- AI, observability, Reporter, and Gatekeeper modes.
- Last-known-good deployment IDs and rollback limitations.
- Evidence that `pnpm check` passed.

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
route and hostname:
Worker names and whether each is new, owned, or conflicting:
storage choice and ownership for each binding:
AI mode:
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

1. Evaluation or production, target account, exact hostname, and zone for a custom domain.
2. Access application, intended users, identity provider requirements, administrators, and denied test identity.
3. Stable names for Workshop, Context, Custom Gatekeeper, and Error Reporter.
4. New auto-provisioned or existing resource for each of Context KV, Blueprints KV, Avatars KV, and Blueprint Content R2.
5. AI disabled, Workers AI direct, or AI Gateway; providers, billing, budget, prompt/response logging, and retention.
6. Error Reporter enabled state, environment/release metadata, telemetry sampling, and retention/export policy.
7. Custom Gatekeeper disabled, optional, or enabled, and whether its code still matches the low-stakes example.
8. Rollback tolerance and the person authorized to approve production mutation.

Default recommendations for a first evaluation are AI disabled, Context Artifacts disabled, new storage, Error Reporter enabled and private, Custom Gatekeeper disabled until reviewed, narrow Access policy, and operators-only access until verification completes. Do not ask first-time operators about Context Artifacts; discuss it only when the existing configuration enables it or the operator explicitly requests Git-backed Context collections.

### 3. Prepare The Workspace

Require Node.js major 24 and pnpm major 11 unless the current repository says otherwise. Confirm account access to every enabled product, including Workers, KV, R2, Browser Rendering, Dynamic Worker Loaders, and optional AI or Artifacts products.

Run the repository's documented setup commands. Stop if installation unexpectedly changes lockfiles, the submodule gitlink, or tracked files. Resolve provenance or version drift; do not normalize it away.

Temporary `wrangler.prod.jsonc` files are generated implementation details. Never edit, commit, or deploy them directly. If one remains after interruption, first prove that no check/deploy process is active, preserve the original failure, and then remove only the stale generated file.

### 4. Configure Cloudflare Access And Routing

Treat routing, authentication, and `/admin` authorization as separate controls.

For production:

1. Confirm the hostname belongs to an active zone in the target account.
2. Stop on an existing DNS record, Worker route, custom domain, or Access application collision. Never delete a conflicting record automatically.
3. Create or identify a self-hosted Access application covering the exact hostname.
4. Use a narrow policy for intended identities. Broad `Everyone`, `Bypass`, or weak bootstrap policies require an explicit risk acceptance.
5. Copy the exact HTTPS team-origin issuer and exact application audience tag.
6. Make administrators an explicit subset of users allowed by Access.

For evaluation, using `workersDev: true` does not itself add authentication. Protect the exact evaluation hostname with Access and use that application's audience. Inspect current Wrangler defaults and the generated config for Preview URLs; disable them in wrapper source or protect and test them explicitly. Never patch the generated file.

For a first `workers.dev` deployment, determine whether the Access application can be created for the predictable hostname before the Worker exists. If the platform requires the Worker first, present a controlled two-stage bootstrap for approval: pre-create only a reserved Workshop Worker identity with no sensitive application or data, enable Access and obtain its audience, then configure and run the wrapper deployment. Do not use `pnpm deploy` for the identity bootstrap because it deploys the whole stack. Record and minimize any temporary public route, and do not proceed if the bootstrap cannot be contained.

Initially allow only deployment operators. Widen access only after `/admin` policy and all post-deploy checks pass.

Verification must include an unauthenticated/incognito request, one intended administrator, one authenticated non-administrator when applicable, and one denied identity. Verify there is no unintended alternate route that bypasses Access.

### 5. Configure `deployment.jsonc`

Edit only the annotated, non-secret control surface unless the requested feature cannot be expressed there.

- Account IDs are exact 32-character hexadecimal IDs.
- Active Worker names are unique, stable, lowercase account-level service identities.
- Set exactly one Workshop route: `customDomain` or `workersDev: true`.
- The Access issuer is an HTTPS origin without a path; the audience is exact and unpadded.
- Administrator emails must match the verified identity representation expected by the current backend.
- Keep `context.sharingDomain` stable unless intentionally creating a new data-isolation boundary.
- Context Artifacts defaults to disabled when `enabled` is omitted; when enabled, keep its namespace stable. Omitting the namespace selects `gatekeeper-context-collections`, while `null` is invalid.
- `customGatekeeper.message` is tracked and agent-readable. It is not a secret store.
- Set release metadata only to a real deployment identifier; use `null` otherwise.

Account IDs, administrator emails, hostnames, resource identifiers, and organization guidance are non-secret but potentially sensitive repository metadata. Confirm the repository audience before committing them.

Choose storage separately for all four bindings. `null` requests Wrangler automatic provisioning. An explicit value adopts an existing resource and therefore requires proof of account ownership, data classification, compatibility, and backup status. Similar names are not proof.

Context Artifacts is separate from those KV/R2 resources. Enabling it creates the namespace implicitly with the first repository. Disabling it later stops repository refresh and token management but does not delete repositories or cached Context content. Treat repository write tokens as credentials and record the namespace in the deployment inventory.

After first production provisioning, inventory the actual resource identities. Consider pinning explicit IDs/names when reproducible binding is required. Treat Worker renames as migration work because they can create new service identities, provision empty resources, or orphan old mappings.

### 6. Configure Optional AI

Keep `aiGateway.enabled` false unless a deployment-funded model catalog is required.

Before enabling AI:

1. Reconcile the current upstream model transport with current Cloudflare docs.
2. Choose direct Workers AI or Gateway routing, providers, billing/BYOK, budget, and alerts.
3. Review least-privilege token permissions and account scope.
4. Decide whether prompts/responses are logged, where, for how long, and who can access them.
5. Confirm the AI account ID intentionally differs from or matches the Worker account.
6. Install the required secret interactively without exposing its value.

For a new deployment, avoid discovering a missing secret after downstream Workers have deployed. Prefer a reviewed bootstrap with an approval at each mutation boundary: deploy with AI disabled; verify the live Access, bindings, and provisioned resource identities; install the secret on the existing exact Workshop identity and record the version it deploys; enable AI; run `pnpm check`; approve; and redeploy. The first mutation summary records automatic-provisioning intent, then the operation record adds actual resource identities before the next phase.

A secret existing does not prove its scope, billing, or account is correct. One approved, non-sensitive, low-cost request proves only the runtime inference path. Verify token configuration, billing ownership, Gateway/provider logs, prompt collection, retention, and access policy through their authoritative control surfaces. Disabling AI does not delete an existing secret.

### 7. Review The Custom Gatekeeper

The starter example is credential-free, read-only, auto-provisioned, and permissive to observers because it returns identical low-stakes text to every authenticated user. Those choices are unsafe defaults for account-specific, tenant-specific, or confidential data.

Keep the Custom Gatekeeper disabled in `/admin` until its provenance and authority are reviewed. If it has been customized, load the upstream `write-gatekeeper` skill and stop for operator approval of the agent-facing API before implementation or enablement. Review:

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
pnpm check
```

Expect wrapper tests, selected package builds, generated Wrangler configs, and Wrangler dry-runs as defined by the current script. Confirm generated files are removed afterward. An upgrade also requires the separate relevant upstream checks described in the upgrade reference.

Passing `pnpm check` does not prove remote resource ownership, secret scope, Access policy, custom-domain availability, billing, live service compatibility, or data preservation. Fix failures one cause at a time, run the narrow package/test where useful, then rerun the complete check.

### 10. Approve And Deploy

Before requesting approval, inventory current deployed version IDs for all affected Workers and verify downstream RPC changes remain compatible with both the old and new Workshop. The deployment is not atomic. The expected baseline order is:

1. Error Reporter, when enabled.
2. Context.
3. Custom Gatekeeper.
4. Workshop.

If current `scripts/deploy.mjs` differs, use its order. Breaking cross-Worker contracts need parallel identities and a controlled binding switch, not an in-place sequential deploy.

Present the production mutation summary from the hard stop. After explicit approval, run:

```sh
pnpm deploy
```

Record each successful stage and resulting deployment/version ID. On the first failure, stop and inventory actual remote state before deciding to resume or roll back. Never assume the script is transactional or retry-safe.

### 11. Verify The Live Deployment

Success requires evidence for every applicable item:

- The intended hostname serves valid TLS and is the only intended public route.
- Access redirects/denies unauthenticated users, allows the intended identity, and denies the negative test identity.
- `/admin` allows an administrator and denies an authenticated non-administrator.
- Signup, connector, Context, and Gatekeeper policies match the approved decisions.
- Context, Custom Gatekeeper, and Error Reporter have no unintended public routes.
- Existing data remains visible; newly created data persists across a safe reload or redeploy test.
- Context Artifacts is absent when disabled, or an approved Git-backed collection can be populated and refreshed in the intended stable namespace when enabled.
- Each Workshop service binding targets the intended service, entrypoint, and props.
- The Custom Gatekeeper is disabled or behaves according to its reviewed policy; approved reads appear as observations.
- AI is intentionally disabled or one approved low-cost request proves the runtime path, with separate evidence for token scope, billing ownership, provider/Gateway selection, prompt collection, retention, and log access.
- Workshop, Context, Custom Gatekeeper, and Reporter logs are available with the expected sampling.
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
7. Rerun `pnpm check`.
8. Re-enter the approval gate if production or a trust boundary changed.
9. Deploy and repeat the full live verification.

After two identical failed attempts, stop and escalate with sanitized evidence. Do not widen permissions or recreate infrastructure as an experiment.

## Rollback

Rollback is a coordinated system operation, not one command. Read [references/upgrade-and-rollback.md](references/upgrade-and-rollback.md), produce the per-Worker rollback matrix, require approval, and repeat the full live verification. Never delete or downgrade storage as an automatic rollback step.

## Pinned Submodule Upgrade

Never advance the submodule blindly. Read and follow [references/upgrade-and-rollback.md](references/upgrade-and-rollback.md). An evaluation worktree prevents local file races but is not staging isolation; use separate Worker identities, route, storage, bindings, and data. Stop for specialist review before any migration, deleted/renamed Durable Object class, irreversible data change, auth boundary change, or incompatible RPC change.
