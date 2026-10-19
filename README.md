<p align="center">
  <img src="docs/assets/cloudflareOS.svg" alt="Cloudflare OS" width="480">
</p>

<h1 align="center">Customized for your Company</h1>

<p align="center">
  Deploy a pinned Cloudflare OS release with branding, sign-in, integrations, routes, and upgrades under your control.
</p>

<p align="center">
  <a href="https://developers.cloudflare.com/workers/"><img alt="Cloudflare Workers" src="https://img.shields.io/badge/Cloudflare-Workers-F6821F?logo=cloudflare&logoColor=white"></a>
  <a href="https://nodejs.org/"><img alt="Node.js 24.19+" src="https://img.shields.io/badge/Node.js-24.19+-5FA04E?logo=nodedotjs&logoColor=white"></a>
  <a href="https://pnpm.io/"><img alt="pnpm 11.17" src="https://img.shields.io/badge/pnpm-11.17-F69220?logo=pnpm&logoColor=white"></a>
  <a href="https://www.typescriptlang.org/"><img alt="TypeScript 7" src="https://img.shields.io/badge/TypeScript-7-3178C6?logo=typescript&logoColor=white"></a>
  <a href="https://github.com/cloudflare/cloudflare-os"><img alt="Cloudflare OS upstream" src="https://img.shields.io/badge/upstream-Cloudflare_OS-24292F?logo=github"></a>
</p>

> [!IMPORTANT]
> Cloudflare OS is early-access software. Pin upstream releases, review changes, and verify the trust boundary before every production upgrade.

## Quick start

With [Node.js 24.19 or newer](https://nodejs.org/) and [pnpm 11.17](https://pnpm.io/installation) installed:

```sh
npx cf-os init my-os
```

It clones this starter, installs it, offers to create a private GitHub repository and push there, then configures sign-in, Workers and AI Gateway, writes `deployment.jsonc`, and offers to deploy. [Deploy](#deploy) covers each step and the manual route, and [Customization](#customization) what to change afterwards. Everything else on this page is optional reading.

## Overview

This repository adds deployment controls around a pinned [Cloudflare OS](https://github.com/cloudflare/cloudflare-os) release without modifying the upstream source.

| Control | What you own |
| --- | --- |
| Branding | Site name, logo, and accent color, changed in [`/admin`](docs/customization.md#branding) without a deploy |
| Identity | The sign-in method and administrator allowlist; this starter deploys [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/) mode |
| Routing | A production [Custom Domain](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/) or a `workers.dev` evaluation route |
| Data | Existing KV/R2 resources or [automatic provisioning](https://developers.cloudflare.com/workers/wrangler/configuration/#automatic-provisioning) |
| Integrations | Wrapper-owned Gatekeepers and service bindings without patching upstream |
| AI | A [Workers AI](https://developers.cloudflare.com/workers-ai/) model catalog through [AI Gateway](https://developers.cloudflare.com/ai-gateway/) out of the box, with no API token; which providers and which gateway |
| Operations | [Structured logs, traces, explicit error reports](docs/observability.md), validation, deployment order, and upgrades |

### Architecture

<img src="docs/assets/architecture.svg" alt="Cloudflare OS deployment architecture: users reach one public route, owned by the router Worker, which serves the frontend and proxies /api to the Workshop backend and /gatekeeper/&lt;name&gt; to the matching Gatekeeper. Behind it is the pinned Cloudflare OS release, holding the Workshop kernel, Gadgets, Blueprints, and the default Gatekeepers. Service bindings connect it to the Workers and resources this repository owns: AI Gateway with no API token, custom Gatekeepers, the Error Reporter, and KV and R2 storage.">

The deployment is seven Workers, plus any optional Gatekeepers you choose. A **router** owns the public route and serves the frontend, proxying `/api` to the Workshop backend and `/gatekeeper/<name>` to whichever Gatekeeper the binding name matches; the Workshop, the Context, Scheduler, Web Search and custom Gatekeepers, and the Error Reporter sit behind it with no route of their own, reachable only over service bindings.

The deploy command derives temporary Wrangler files from upstream base configs, builds the frontend in Cloudflare Access mode, deploys the private Error Reporter, the Gatekeepers and the Workshop before the router that binds them, and removes generated files even on failure. Secrets never enter tracked configuration.

### If you only want branding

A hosted flow deploys the same upstream release to your Cloudflare account without this repository. It builds nothing locally, configures sign-in and your admin emails for you, and leaves the whole `/admin` surface intact: site name, logo, accent color, announcements, agent instructions, featured blueprints, and which connectors your users can reach. Built-in Gatekeepers such as GitHub and Google are still yours to connect with your own OAuth credentials.

<a href="https://os.cloudflare.app/deploy"><img src="https://deploy.workers.cloudflare.com/button" alt="Deploy to Cloudflare"></a>

Anything past that needs your own code or settings, which is what this repository is for: custom Gatekeepers, customized error reporting, your own Worker names, reusing storage you already have, choosing how much logging to keep, and a pinned version you upgrade when you decide. Hosted deployments also run on a `workers.dev` address, so deploy from here if you want the app on your own domain, or the email Gatekeeper, which needs a zone. Come back when branding stops being enough.

## Deploy

### 1. Prepare the workspace

Install [Node.js 24.19 or newer](https://nodejs.org/) (the `cf-os` CLI is TypeScript run directly by `node`) and [pnpm 11.17](https://pnpm.io/installation), then create the project:

```sh
npx cf-os init my-os
```

It clones this starter and its submodule, installs, offers to create a private GitHub repository for it, and starts `pnpm cf-os init` (step 2). To clone by hand instead, run `git clone --recurse-submodules https://github.com/cloudflare/cloudflare-os-starter my-os`, then `pnpm install` and `pnpm cf-os init` inside `my-os`. A fork of this public repository has to stay public; for a private one, push the clone to an empty private repository instead. Either way, `deployment.jsonc` belongs in your repository, and `npx cf-os@latest update` brings in starter updates.

`pnpm install` installs the submodule's own workspace too, from a `postinstall` hook. If you install with `--ignore-scripts`, run `pnpm cf-os install` afterwards; `pnpm cf-os check` says so if you forget.

`pnpm cf-os init` offers the [Wrangler](https://developers.cloudflare.com/workers/wrangler/commands/#login) sign-in, which deploys, and the `cf` CLI's, which reads defaults from your account and sets up Access. [`packages/cf-os`](packages/cf-os/README.md) lists every command and flag.

Your account needs [Workers](https://developers.cloudflare.com/workers/), [KV](https://developers.cloudflare.com/kv/), [R2](https://developers.cloudflare.com/r2/), [Browser Rendering](https://developers.cloudflare.com/browser-rendering/), and [Dynamic Worker Loaders](https://developers.cloudflare.com/workers/runtime-apis/bindings/worker-loader/). It also needs [Workers AI](https://developers.cloudflare.com/workers-ai/) and [AI Gateway](https://developers.cloudflare.com/ai-gateway/), which the default model catalog runs on. Web Search needs them too, through the account's `default` gateway when the catalog is off, so they are dispensable only with the catalog off and Web Search disabled in `/admin`. [Artifacts](https://developers.cloudflare.com/artifacts/) is optional.

### 2. Configure sign-in

Cloudflare OS supports several sign-in methods. This starter deploys [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/) mode, which verifies identity before a request reaches the Worker. See [Sign-in methods](docs/customization.md#sign-in-methods) for the alternatives and what switching involves.

`pnpm cf-os init` does all of this: it asks for Worker names, a hostname, admin emails and the AI Gateway, with defaults read from your account, finds or creates the Access application, and writes `deployment.jsonc`. To do it by hand:

1. Choose a public hostname in an [active Cloudflare zone](https://developers.cloudflare.com/dns/zone-setups/), such as `os.example.com`.
2. Create a [self-hosted Access application](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/) for that hostname.
3. Copy its [application audience tag](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/#get-your-aud-tag).
4. Open [`deployment.jsonc`](deployment.jsonc) and replace the active placeholders. Every control is annotated in place.

Or skip steps 2 and 3: fill in every placeholder except `access.issuer` and `access.audience`, then run `pnpm cf-os access` to find or create the application and write those two.

The hostname belongs to the router, the only Worker here with a public route. Wrangler creates its DNS and TLS at deploy time. For an evaluation without a zone, switch the annotated route to `{ "workersDev": true }` and set `publicBaseUrl` to the resulting origin.

### 3. Validate and deploy

```sh
pnpm cf-os check
pnpm cf-os deploy
```

`check` confirms the account has what `deployment.jsonc` names, then builds everything and dry-runs every deploy; `deploy` does the same and deploys for real, without asking for confirmation.

With resource values left as `null`, Wrangler creates the three KV namespaces and R2 bucket automatically and reconnects them on later deploys. Set explicit IDs or a bucket name when the deployment must reuse existing resources.

A Workers AI model catalog is enabled by default and needs no API token: the Workshop reaches AI Gateway over its `WORKERS_AI` binding, which is pre-authenticated inside your account. See [AI models](docs/customization.md#ai-models) to add providers, change the gateway, or turn the catalog off.

Git-backed Context collections are disabled by default. Accounts with Artifacts access can enable them in `context.artifacts`; see [Context Artifacts](docs/customization.md#context-artifacts).

Backend error reporting is enabled without a vendor account. Explicit upstream issue events become structured logs in the private Error Reporter Worker; see [Observability and error reporting](docs/observability.md).

### 4. Verify the deployment

- Open the router's hostname and confirm Access signs in with the expected identity, and that it is the only public route into the deployment.
- Open `/admin`, confirm the email is an administrator, and set Context, Scheduler, Web Search and Custom Gatekeepers to disabled, optional, or enabled.
- If Context Artifacts is enabled, create a Git-backed collection and confirm its repository can be populated and refreshed.
- Enable the Custom Gatekeeper, ask for deployment information, and confirm its read appears as an observation.
- Open the Error Reporter Worker's [Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/) and verify its structured `error_report` query surface.
- Ask an agent to schedule something a few minutes out, and confirm it runs — that exercises the Scheduler Gatekeeper end to end.
- Ask an agent to search the web for something recent, and confirm it returns results. That exercises the Web Search Gatekeeper and the AI Gateway it searches through: `aiGateway.name` when it is in this account, otherwise the account's `default` gateway. Searches need AI Gateway credits or a Ceramic key on that gateway, not just the free Workers AI allowance: see [Workers and routing](docs/customization.md#workers-and-routing).
- Review logs for the router, Workshop, Context, Scheduler, Web Search, custom Gatekeeper, and Error Reporter Workers.

## Customization

| Customize | Best place | Deploy required |
| --- | --- | --- |
| Site name, logo, color, announcements, instructions, connectors | `/admin` | No |
| Sign-in, routes, AI, storage, observability, Worker identities | [`deployment.jsonc`](deployment.jsonc) | Yes |
| Logs, traces, error destinations, browser reporting | [Observability guide](docs/observability.md) | Sometimes |
| Organization APIs and capabilities | [`packages/custom-gatekeeper`](packages/custom-gatekeeper/README.md) | Yes |
| Product behavior unavailable through Worker boundaries | Pinned upstream fork/commit | Yes |

The complete control reference and recipes live in [Customization](docs/customization.md). The upstream [`write-gatekeeper` skill](https://github.com/cloudflare/cloudflare-os/blob/main/.agents/skills/write-gatekeeper/SKILL.md) covers richer integrations.

## Operations and upgrades

- Stream production events with [`wrangler tail`](https://developers.cloudflare.com/workers/observability/logs/real-time-logs/).
- Triage explicit failures and choose export destinations with the [observability guide](docs/observability.md).
- Roll a Worker back from its dashboard deployment history or with [`wrangler rollback`](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/).
- Update with `npx cf-os@latest update`, which merges the starter's `main` and its reviewed pin and writes `.cf-os/update.md` for your coding agent. Follow the [upgrade checklist](docs/customization.md#upgrade) before moving the pinned submodule past the starter's.
- Review the upstream Cloudflare OS documentation and release history before adopting behavior changes.

### Moving here from the hosted deploy (os.cloudflare.app/deploy)

Ejecting an instance created by the hosted flow means redeploying over Workers that already hold your data. Worker names, storage IDs, the public URL, AI Gateway and the Access application all have to be carried across, and each one fails quietly if it is not: the deploy succeeds against empty storage. `pnpm cf-os init`'s **Take over a hosted instance** finds them in your account and fills them in. [Migrating from the hosted deploy](docs/migrate-from-hosted.md) is the checklist.
