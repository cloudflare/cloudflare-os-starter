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

## Four steps

1. Get the project: fork or clone this repository, then run `pnpm install`. If you have not cloned it, `npx @maximoguk/cfos init my-os` does that for you: it clones this starter, installs, offers to create a private GitHub repository for it and push there, and carries on with step 2.
2. Configure and deploy: `pnpm cfos init` offers the sign-ins, asks for the Worker names, hostname, admin emails and AI Gateway with defaults read from your account, sets up the Access application, writes `deployment.jsonc`, and offers to deploy. Commit `deployment.jsonc`: it belongs in your repository.
3. Deploy later changes with `pnpm cfos deploy`. `pnpm cfos check` runs the same checks and dry-runs the deploy.
4. Open `/admin` and set the site name, logo, and accent color; branding needs no redeploy.

[Deploy](#deploy) and [Customization](#customization) expand each step. Everything else on this page is optional reading.

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

The deployment is seven Workers. A **router** owns the public route and serves the frontend, proxying `/api` to the Workshop backend and `/gatekeeper/<name>` to whichever Gatekeeper the binding name matches; the Workshop, the Context, Scheduler, Web Search and custom Gatekeepers, and the Error Reporter sit behind it with no route of their own, reachable only over service bindings.

The deploy command derives temporary Wrangler files from upstream base configs, builds the frontend in Cloudflare Access mode, deploys the private Error Reporter, the Gatekeepers and the Workshop before the router that binds them, and removes generated files even on failure. Secrets never enter tracked configuration.

### If you only want branding

A hosted flow deploys the same upstream release to your Cloudflare account without this repository. It builds nothing locally, configures sign-in and your admin emails for you, and leaves the whole `/admin` surface intact: site name, logo, accent color, announcements, agent instructions, featured blueprints, and which connectors your users can reach. Built-in Gatekeepers such as GitHub and Google are still yours to connect with your own OAuth credentials.

<a href="https://os.cloudflare.app/deploy"><img src="https://deploy.workers.cloudflare.com/button" alt="Deploy to Cloudflare"></a>

Anything past that needs your own code or settings, which is what this repository is for: custom Gatekeepers, customized error reporting, your own Worker names, reusing storage you already have, choosing how much logging to keep, and a pinned version you upgrade when you decide. Hosted deployments also run on a `workers.dev` address, so deploy from here if you want the app on your own domain, or the email Gatekeeper, which needs a zone. Come back when branding stops being enough.

## Deploy

### 1. Prepare the workspace

Install [Node.js 24.19 or newer](https://nodejs.org/) (the `cfos` CLI is TypeScript run directly by `node`) and [pnpm 11.17](https://pnpm.io/installation) (`corepack enable` provides it). Then fork or clone this repository, install, and start step 2:

```sh
git clone --recurse-submodules https://github.com/cloudflare/cloudflare-os-starter my-os
cd my-os
pnpm install
pnpm cfos init
```

`deployment.jsonc` belongs in your repository once it is filled in. A fork of this public repository has to stay public, so for a private one, create an empty private repository and push the clone there: `git remote rename origin starter`, `git remote add origin <url>`, `git push -u origin HEAD`. `git pull starter main` then brings in starter updates.

If you have not cloned it yet, one command does all of that:

```sh
npx @maximoguk/cfos init my-os
```

It clones this starter with its history and its `cloudflare-os` submodule, renames the `origin` remote to `starter`, runs `pnpm install`, offers to create a private GitHub repository with the [GitHub CLI](https://cli.github.com/) (`gh`) and push to it, signing you in to `gh` first if needed, and starts `pnpm cfos init`. Without `gh`, it prints the commands to add a repository by hand. `--template <url|path>` and `--ref <branch>` clone a fork or a branch instead.

`pnpm install` installs the submodule's own workspace too, from a `postinstall` hook. If you install with `--ignore-scripts`, run `pnpm cfos install` afterwards; `pnpm cfos check` says so if you forget.

Two sign-ins, because two tools talk to Cloudflare; `pnpm cfos init` offers each one when it is needed, or run `pnpm exec cf auth login` and `pnpm exec wrangler login` yourself. [Wrangler](https://developers.cloudflare.com/workers/wrangler/commands/#login) deploys the Workers. The `cf` CLI looks things up and sets up Access: `pnpm cfos init` reads your zones, AI Gateways, email and workers.dev subdomain through it to offer defaults, `pnpm cfos access` and `pnpm cfos import` run on it, and `pnpm cfos check` uses it to confirm the Access application and storage IDs in `deployment.jsonc` exist in the account. `cf` is optional. Without it, `init` asks you to type those values, `check` skips the account checks with a one-line notice, and you do the Access steps below by hand. Instead of logging in, you can set `CLOUDFLARE_API_TOKEN` to a token with Access: Apps and Policies Edit, plus Read on Workers Scripts, Workers KV Storage, Workers R2 Storage, AI Gateway, Zone and DNS.

[`packages/cfos`](packages/cfos/README.md) lists every `cfos` command and flag. `pnpm check` and `pnpm deploy` still work as aliases.

Your account needs [Workers](https://developers.cloudflare.com/workers/), [KV](https://developers.cloudflare.com/kv/), [R2](https://developers.cloudflare.com/r2/), [Browser Rendering](https://developers.cloudflare.com/browser-rendering/), and [Dynamic Worker Loaders](https://developers.cloudflare.com/workers/runtime-apis/bindings/worker-loader/). It also needs [Workers AI](https://developers.cloudflare.com/workers-ai/) and [AI Gateway](https://developers.cloudflare.com/ai-gateway/), which the default model catalog runs on; only turning that catalog off makes them dispensable. [Artifacts](https://developers.cloudflare.com/artifacts/) is optional.

### 2. Configure sign-in

Cloudflare OS supports several sign-in methods. This starter deploys [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/) mode, which verifies identity before a request reaches the Worker. See [Sign-in methods](docs/customization.md#sign-in-methods) for the alternatives and what switching involves.

Run `pnpm cfos init` and choose **A new deployment**. It asks, with defaults:

1. A base name. The seven Worker names derive from it the way the hosted deploy names them (`<name>-backend`, `<name>-gk-context`, ...), and it stops if any of them is already taken in the account.
2. Where people reach it: a hostname in one of your [active zones](https://developers.cloudflare.com/dns/zone-setups/), `os.<zone>` by default, or a `workers.dev` evaluation address. It warns if the hostname already has a DNS record, which would block the custom domain.
3. The admin emails, defaulting to the one `cf` is signed in as, then the AI Gateway and model providers, then the example custom Gatekeeper's text.
4. Access. It reuses the [self-hosted Access application](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/) that already covers the hostname, or offers to create one that admits exactly the admins. If the Zero Trust organization has no identity provider, nobody could sign in, so it offers to add a One-time PIN provider.

It writes every answer into `deployment.jsonc` in place, comments intact (`--out <path>` writes a copy instead). Storage, error reporting and observability keep the template's defaults. Every control is annotated in the file, so editing it by hand afterwards is fine. When nothing is left as a placeholder, it offers the Wrangler sign-in if needed and then asks **Deploy now?**; yes runs `pnpm cfos deploy` (step 3) on the file it just wrote.

Without a terminal, or to do it by hand, fill in [`deployment.jsonc`](deployment.jsonc)'s placeholders except `access.issuer` and `access.audience`, then run `pnpm cfos access`. It finds or creates the application the same way and writes the team's issuer and the application's audience into the file. Add `--dry-run` first to see the request without sending it. To admit more people than the admins (an email domain, an identity-provider group), widen the application's policy in the Zero Trust dashboard afterwards.

The account needs a [Zero Trust organization](https://developers.cloudflare.com/cloudflare-one/setup/), and both `init` and `pnpm cfos access` stop with a link if there isn't one. To do it by hand instead, create the application yourself, copy its [audience tag](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/#get-your-aud-tag) into `access.audience`, and set `access.issuer` to `https://<team>.cloudflareaccess.com`.

The hostname belongs to the router, the only Worker here with a public route. Wrangler creates its DNS and TLS at deploy time. For an evaluation without a zone, switch the annotated route to `{ "workersDev": true }` and set `publicBaseUrl` to the resulting origin.

### 3. Validate and deploy

```sh
pnpm cfos check
pnpm cfos deploy
```

Both validate `deployment.jsonc`, then confirm with `cf` that the account has the Access application, team domain, and any KV namespace, R2 bucket or AI Gateway it names. A mismatch stops them before anything builds. `check` then builds everything and dry-runs every deploy; `deploy` deploys for real, without asking for confirmation. Run on the unconfigured template at a terminal, either offers to start `pnpm cfos init` instead of failing, then carries on with the file it writes.

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
- Ask an agent to search the web for something recent, and confirm it returns results. That exercises the Web Search Gatekeeper and the account's `default` AI Gateway it searches through.
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
- Follow the [upgrade checklist](docs/customization.md#upgrade) before changing the pinned submodule.
- Review the upstream Cloudflare OS documentation and release history before adopting behavior changes.

### Moving here from the hosted deploy (os.cloudflare.app/deploy)

Ejecting an instance created by the hosted flow means redeploying over Workers that already hold your data. Worker names, storage IDs, the public URL, AI Gateway and the Access application all have to be carried across, and each one fails quietly if it is not: the deploy succeeds against empty storage. `pnpm cfos init`'s **Take over a hosted instance** finds them in your account, asks for the few values the hosted deploy never had, and fills them into `deployment.jsonc`; `pnpm cfos check` then confirms they exist. `pnpm cfos import` is the same lookup on its own, read-only and scriptable. [Migrating from the hosted deploy](docs/migrate-from-hosted.md) explains each value and what is left to do by hand.
