# Holostaff

**Give your product a "Do this for me" button.**

[![npm](https://img.shields.io/npm/v/@holostaff/cli)](https://www.npmjs.com/package/@holostaff/cli)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue)](./LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](#)

[holostaff.ai](https://www.holostaff.ai) · [Live demo](https://www.holostaff.ai/demo) · [Docs](https://docs.holostaff.ai) · [Pricing](https://www.holostaff.ai/pricing) · [What a computer-use agent is](https://www.holostaff.ai/computer-use-agents)

A workflow autopilot is a computer-use agent that lives inside your product: a "Do this for me" button on a workflow. The user hands over the task, and the autopilot completes it on screen, in the user's own session. This CLI is the front door: one command turns your repo into the journey map autopilots are built from.

Not a chatbot (it never chats; it acts). Not a product tour (a tour explains the task; an autopilot does it). Not an outside browser agent (it is the computer-use agent your product *owns*: same origin, your rules, certified on your builds).

![holostaff /scan demo](assets/demo.gif)

```bash
npm install -g @holostaff/cli
cd your-app
holostaff
```

No model keys. No config files. No YAML. Sign in from the terminal, type `/scan`, and watch your product turn into a map.

Want proof before installing anything? **[Explore a live map](https://www.holostaff.ai/demo)**. It is Documenso, the open-source document signing platform, scanned by this CLI. Everything on that canvas is the unedited output of `/scan`. No sign-up needed.

## Every product has workflows users dread

The expense claim. The bulk import. The seven-field setup form. Users stall there, drop there, and churn there.

Tours explain the task. Chatbots answer questions about it. Analytics counts the bodies. Nobody does the task for the user, and doing the task is exactly what people now expect software to offer.

A workflow autopilot does it. The user clicks the offer, watches the task get done step by step, answers a short question when the autopilot is unsure, and personally approves anything consequential.

## How it works

**1. Map.** `/scan` sends an agent through your codebase and draws your real customer journey: the routes, the workflows, the tasks worth taking over. The skeleton of the map is live about 90 seconds in; the deep pass keeps working while you explore it.

![A scanned workflow on the journey map canvas](assets/journey-map.jpg)

**2. Rehearse.** Synthetic users run your real flows in real browsers: they sign up, fill forms, hesitate, and give up the way real users do. Every run is graded and watchable. They find what breaks before your users do.

![A rehearsal in progress: a synthetic user inside a real browser session, with the run timeline](assets/eval-run.jpg)

**3. Certify.** Every workflow's autopilot must pass two levels: synthetic users complete the workflow themselves, then hand the task over and the autopilot completes it. Suites gate every PR. An autopilot ships only while its workflow passes.

![The evaluations board: scenarios generated from the scan, with verdicts](assets/evaluations.jpg)

**4. Deploy.** `holostaff deploy` opens a pull request: SDK init, journey stage markers, the embed. Your team reviews the diff like any other change. Merging is going live. Reverting is rollback. Nothing lands on its own.

**5. Verify.** Every handover is logged, watchable, and counted only when the task actually completed.

## The deploy PR, in full

The entire production footprint is a diff you review. Nothing lands on its own:

```diff
+ import { holostaff } from '@holostaff/sdk'
+
+ // Once at app startup.
+ holostaff.init({
+   sourceId: 'cli-source-abc',
+   tenantId: 'your-tenant-id',
+ })
+
+ // At journey-stage boundaries, placed from your journey map.
+ holostaff.markStageEntry('onboarding')
+
+ // On sign-in / sign-out.
+ holostaff.identify(user.id)
+ holostaff.clearIdentity()
```

The SDK renders the offer card, the intent overlay, the run, the anchored questions, the Allow pill, and the always-visible Stop. You write none of that. Reverting the PR removes all of it.

## Certification in CI

Synthetic users gate every pull request. Green means the autopilots on that build are certified; a failing suite takes the offer down instead of shipping a broken handover.

```yaml
name: Holostaff simulate
on:
  pull_request:

jobs:
  simulate:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
    steps:
      - uses: actions/checkout@v4
      - uses: Holostaff-AI/simulate-action@v1
        with:
          api-key: ${{ secrets.HOLOSTAFF_API_KEY }}
          source-id: ks_your_source_id
```

The PR comment reads `workflow certified (n/n runs)` when the suite passes. See [simulate-action](https://github.com/Holostaff-AI/simulate-action).

## The safety envelope

The autopilot acts inside your page through the SDK, in the user's own session, one small action at a time. Every target is highlighted on screen before anything happens. Consequential clicks (pay, submit, delete, send, sign) wait for the user to press an inline Allow, and no answer means no. It will never type into password, payment, or code fields: it points, the user types. Any keystroke from the user pauses it, and Stop never leaves the screen. These rules are enforced in the runtime, not the prompt, and they are not configurable per autopilot.

## What leaves your machine (and what never does)

`/scan` reads your source with read-only tools, and before anything uploads, a trust report shows you exactly what is about to be sent. The artifact contains only:

- Product identity: name, one-line description, framework, language
- Routes (paths and descriptions) and component names with roles
- Customer-facing copy strings (the literal text users see, with locations)
- Brand voice (tone, keywords)
- Workflows and their steps
- Coverage gaps the scan flagged

Your source code, file contents beyond the excerpted UI strings, `.env` files, secrets, and git history never leave your machine.

## Status

**Alpha, and live.** The package is on npm and every flow in this README works end-to-end against the hosted Holostaff API: sign-in, `/scan`, `/refine`, `/instrument`, `/embed`, and `holostaff deploy`. Model calls are served by your Holostaff workspace. Fair-use daily limits apply per workspace, and the CLI tells you if you hit one.

Alpha means: interfaces may still change between minor versions, scans of very large monorepos can be slow, and you should read the diff before merging anything the agent commits.

What it costs: the scan and your journey map are free. Going live starts a 14-day trial. After that you pay for two things only: simulation runs while you build and certify, and completed handovers when an autopilot finishes a task for a real user. A handover that stops or fails costs nothing. [Pricing](https://www.holostaff.ai/pricing).

## Commands

### Slash commands (interactive)

| Command | Purpose |
|---------|---------|
| `/scan` | Scan this repo, produce + upload an artifact |
| `/scan --add-repo` | Pick an existing source to merge into (multi-repo product) |
| `/refine` | Edit identity overrides on the live artifact |
| `/instrument` | Generate Holostaff SDK init + tracking, commit to a branch |
| `/embed` | Add the autopilot layer to the app entry, commit to a branch |
| `/whoami` · `/workspace` · `/login` · `/logout` | Auth + session utilities |
| `/help` · `/quit` | Help / exit |

### Argv subcommands (scriptable)

| Command | Purpose |
|---------|---------|
| `holostaff` | Open the interactive shell |
| `holostaff login` | Re-run device-flow auth |
| `holostaff logout` | Clear local credentials |
| `holostaff whoami` | Show signed-in user + workspace |
| `holostaff workspace` | Show active workspace |
| `holostaff import NAME` | Import a preset journey map instead of scanning (`import` alone lists them) |
| `holostaff scan [--add-repo ID] [--quiet] [--json] [--out PATH]` | Headless scan + upload (CI-friendly) |
| `holostaff deploy [--dry-run] [--force]` | Open the deploy PR |
| `holostaff --version` · `--help` | Version / usage |

## CI / scriptable mode

`holostaff scan --quiet --json` runs the full scan + upload without a TTY. Auth comes from env vars; result is a single JSON object on stdout.

```bash
export HOLOSTAFF_API_KEY="hsk_…"             # workspace API key
export HOLOSTAFF_WORKSPACE_ID="workspace_…"  # the workspace it's bound to

holostaff scan --quiet --json --out artifact.json
test $? -eq 0 || exit 1

jq -r '.upload.viewUrl' artifact.json
```

Exit codes:
- `0` uploaded successfully
- `1` scan or upload failed
- `2` bad args or preflight (missing env)
- `3` auth not configured for CI

## Auth

Two paths:

**Interactive (default):** OAuth-style device flow. Run `holostaff` and a browser opens to authorize. Credentials live in `~/.holostaff/credentials.json` (mode `0600`).

**CI:** Set `HOLOSTAFF_API_KEY` + `HOLOSTAFF_WORKSPACE_ID` in your environment. The CLI skips the file-based path when these are set.

Generate a workspace API key in the dashboard under Settings → CLI keys.

## Per-repo source binding

After your first successful upload, the CLI writes `.holostaff/source.json` in your repo. Subsequent scans bind to the same Holostaff source and version-bump its artifact.

Add `.holostaff/source.json` to your `.gitignore` if you don't want teammates' scans to land on your source automatically. Shared team bindings aren't supported yet.

## Environment variables

| Var | Required | What |
|-----|----------|------|
| `HOLOSTAFF_API_KEY` | CI mode | Workspace API key (Bearer JWT) |
| `HOLOSTAFF_WORKSPACE_ID` | CI mode | Workspace this key is bound to |
| `HOLOSTAFF_API_BASE_URL` | optional | Backend URL override (default: prod) |
| `HOLOSTAFF_APP_BASE_URL` | optional | Dashboard URL for the result `viewUrl` (default: `https://www.holostaff.ai`) |

Model access needs no configuration: scans run against the model deployment hosted by your Holostaff workspace, authenticated with your session. Fair-use daily limits apply per workspace; the CLI tells you if you hit one.

## Telemetry

Anonymous, opt-out. The CLI emits typed events for command starts, completions, and errors so we can see what's working and what's broken.

What's collected (per event):
- `cli_version`, `node_version`, `os`
- Hashed `workspace_id` (SHA-256, never the raw ID)
- `command` (`scan` / `instrument` / etc.)
- `duration_ms`, `outcome`
- `framework_detected`, `repo_size_bucket`
- `error_kind` for failures (typed: `auth_expired`, `instrument_typecheck_failed`, `network_blocked`, etc.)

What's never collected: file paths, source code, source content, secrets.

To disable: set `HOLOSTAFF_TELEMETRY=0` in your environment.

## License

Apache-2.0. See [LICENSE](./LICENSE).

## Contributing

PRs welcome. See [CONTRIBUTING.md](./CONTRIBUTING.md) for dev setup, smoke spikes, and the release flow. Release notes live in [CHANGELOG.md](./CHANGELOG.md).

## Reporting issues

Open an issue at https://github.com/Holostaff-AI/holostaff-cli/issues or reach out via your Holostaff workspace's support channel.
