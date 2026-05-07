# Holostaff CLI

Scan a codebase, instrument it with Holostaff tracking, and embed a copilot — all from your terminal.

```
$ holostaff
Welcome to Holostaff. Looks like a Vue 3 + Vite app with 14 components and 13 routes.

> /scan
✓ Scan complete · 183.1s · TutorLM
  Send to your Holostaff workspace? [Y/N/S]
```

## Status

**Alpha.** The flows in this README work end-to-end against the deployed Holostaff API. Distribution is a private install for now; public npm + signed releases are pending the A8 milestone.

The `@holostaff/sdk` tracking package referenced by `/instrument` is not yet on npm — `/instrument` ships the *integration shape*; the package lands separately. Same caveat for `holostaff-widget` is not — that one is published.

## Install

```bash
# Once we publish:
npm install -g @holostaff/cli

# Today (private install):
git clone https://github.com/automi-ai/holostaff-agent
cd holostaff-agent/cli
npm install
npm run build
npm link
```

Requires Node 20+.

## Quickstart

In a repo you want to add a copilot to:

```bash
$ cd ~/code/your-app
$ holostaff
```

The interactive shell walks you through:

1. **Sign in.** Device-flow OAuth via your Holostaff workspace. Browser opens; you confirm.
2. **`/scan`.** Reads your code (read-only), produces a structured knowledge artifact, shows a trust report (what gets sent vs. what stays local), uploads on confirm.
3. **`/instrument`.** Drafts a patch that adds the Holostaff tracking SDK to your app. Shows a per-file diff. On confirm, creates a `holostaff/instrument-<ts>` branch and commits.
4. **`/embed`.** Same flow for the widget script tag.
5. **`/refine`.** Edits the artifact's identity (product name, description, notes) without re-scanning. Survives re-scans.
6. **`/help`.** Lists every slash command.

You can also chat the agent — anything that doesn't start with `/` goes to a free-form conversation.

## Commands

### Slash commands (interactive)

| Command | Purpose |
|---------|---------|
| `/scan` | Scan this repo, produce + upload an artifact |
| `/scan --add-repo` | Pick an existing source to merge into (multi-repo product) |
| `/refine` | Edit identity overrides on the live artifact |
| `/instrument` | Generate Holostaff SDK init + tracking, commit to a branch |
| `/embed` | Add the widget script tag to the app entry, commit to a branch |
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
| `holostaff scan [--add-repo ID] [--quiet] [--json] [--out PATH]` | Headless scan + upload (CI-friendly) |
| `holostaff --version` · `--help` | Version / usage |

## CI / scriptable mode

`holostaff scan --quiet --json` runs the full scan + upload without a TTY. Auth comes from env vars; result is a single JSON object on stdout.

```bash
export HOLOSTAFF_API_KEY="hsk_…"             # workspace API key
export HOLOSTAFF_WORKSPACE_ID="workspace_…"  # the workspace it's bound to
export AZURE_ANTHROPIC_ENDPOINT="…"          # model API
export AZURE_ANTHROPIC_API_KEY="…"

holostaff scan --quiet --json --out artifact.json
test $? -eq 0 || exit 1

jq -r '.upload.viewUrl' artifact.json
```

Exit codes:
- `0` uploaded successfully
- `1` scan or upload failed
- `2` bad args or preflight (missing env)
- `3` auth not configured for CI

## What stays on your machine

`/scan` reads your source code with read-only tools, but the artifact it sends to your workspace contains only:
- Product identity: name, one-line description, framework, language
- Routes (paths + descriptions)
- Component names + roles
- Customer-facing copy strings (the literal text users see, with file/i18n locations)
- Brand voice (tone, keywords)
- Workflows (multi-step user flows + steps)
- Coverage gaps the scan flagged

Your source code, file contents (beyond the excerpted UI strings), `.env` files, secrets, and git history never leave your machine.

The trust report shows you exactly what's about to be sent before you confirm.

## Auth

Two paths:

**Interactive (default):** OAuth-style device flow. Run `holostaff` and a browser opens to authorize. Credentials live in `~/.holostaff/credentials.json` (mode `0600`).

**CI:** Set `HOLOSTAFF_API_KEY` + `HOLOSTAFF_WORKSPACE_ID` in your environment. The CLI skips the file-based path when these are set.

Generate a workspace API key in the dashboard at Settings → CLI keys (lands in B3).

## Per-repo source binding

After your first successful upload, the CLI writes `.holostaff/source.json` in your repo. Subsequent scans bind to the same Holostaff source and version-bump its artifact.

Add `.holostaff/source.json` to your `.gitignore` if you don't want teammates' scans to land on your source automatically — multi-user shared bindings are a B3 follow-up.

## Environment variables

| Var | Required | What |
|-----|----------|------|
| `HOLOSTAFF_API_KEY` | CI mode | Workspace API key (Bearer JWT) |
| `HOLOSTAFF_WORKSPACE_ID` | CI mode | Workspace this key is bound to |
| `HOLOSTAFF_API_BASE_URL` | optional | Backend URL override (default: prod) |
| `HOLOSTAFF_APP_BASE_URL` | optional | Dashboard URL for the result `viewUrl` (default: `https://www.holostaff.ai`) |
| `AZURE_ANTHROPIC_ENDPOINT` | scan / instrument / embed / refine | Foundry endpoint |
| `AZURE_ANTHROPIC_API_KEY` | scan / instrument / embed / refine | Foundry key |

Production CLI distribution will drop the BYO `AZURE_*` requirement — the backend will issue per-session model tokens. Tracked in PRD §13 OQ10.

## Telemetry

Anonymous, opt-out. The CLI emits typed events for command starts, completions, and errors so we can see what's working and what's broken.

What's collected (per event):
- `cli_version`, `node_version`, `os`
- Hashed `workspace_id` (SHA-256 — never the raw ID)
- `command` (`scan` / `instrument` / etc.)
- `duration_ms`, `outcome`
- `framework_detected`, `repo_size_bucket`
- `error_kind` for failures (typed: `auth_expired`, `instrument_typecheck_failed`, `network_blocked`, etc.)

What's never collected: file paths, source code, source content, secrets.

To disable: set `HOLOSTAFF_TELEMETRY=0` in your environment.

## License

Apache-2.0. See [LICENSE](./LICENSE).

## Reporting issues

Open an issue at https://github.com/automi-ai/holostaff-agent or reach out via your Holostaff workspace's support channel.
