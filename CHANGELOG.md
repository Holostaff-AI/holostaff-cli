# Changelog

All notable changes to `@holostaff/cli` are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). The CLI follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html); during alpha
(`0.x`) minor bumps may include breaking changes.

## [Unreleased]

## [0.3.5] — 2026-06-23

### Added
- Scans now record the repo's GitHub origin (`github.com/owner/repo`) on the
  source. The server keys repo-identity dedup on it within a workspace, so a
  teammate scanning the same repo converges onto one journey map instead of
  forking a duplicate. Wired into both the interactive and headless (`scan
  --quiet`) paths; non-GitHub / origin-less repos behave as before (fresh
  source, no dedup). Pairs with server-side scan attribution
  (`createdBy` / `lastScannedBy`), which needs no CLI change.

## [0.3.2] — 2026-06-11

### Fixed
- The conversational shell knew nothing about `/deploy` — its system
  prompt carried a hand-written command list that went stale. The chat
  prompt now renders the live command registry, and a bare command name
  typed without the slash ("deploy") gets an instant "Did you mean
  `/deploy`?" without an LLM round-trip.

## [0.3.1] — 2026-06-11

### Fixed
- Headless `holostaff scan` now accepts file-backed credentials (from
  `holostaff login`) instead of requiring `HOLOSTAFF_API_KEY` env vars.
  Local scripted scans previously failed with "CI mode requires
  HOLOSTAFF_API_KEY" even when signed in. Env keys still take
  precedence; expired tokens get a clear re-login error.

## [0.3.0] — 2026-06-11

### Added
- **`holostaff deploy`** — opens a deploy PR for the bound source via the
  Holostaff GitHub App. Full state machine: binding → source state →
  edits-drift check → open-deploy guard (`--force` to repush) → deploy
  intent → PR creation. Also available as `/deploy` in the interactive
  shell. `--dry-run` prints the plan without side effects.
- **Scan reconciliation** — scans now walk the repo for existing
  `holostaff.*` SDK calls (`.vue`, `.tsx`, `.jsx`) and upload them as
  `detectedInstrumentation`, so the dashboard's instrumentation chips
  reflect what's actually wired in code.
- **Signal taxonomy walk** — the scan agent maps host-app events
  (checkout success, resource created, errors) to the Holostaff
  custom-signal taxonomy and declares `emitSignal` probes per workflow
  step. Taxonomy names only; unmappable events surface as candidates in
  scan notes.
- **Identity surface declarations** — the scan agent reports where the
  app completes sign-in/sign-out (OAuth callbacks, auth-state listeners,
  custom-named routes) so the deploy PR can ship `identify()` /
  `clearIdentity()` skeletons at the right spots.
- Interactive shell shows a spinner with a command-aware label while a
  slash command runs (previously silent until completion).

### Changed
- The scan agent no longer declares `markStageEntry` calls — the server
  derives those deterministically from each workflow's entry pages.

## [0.2.0] — 2026-06-02

### Added
- `/scan` now emits **risks** and **interventions** per workflow. The agent
  walks the Bowtie stage decomposition (~36 sub-steps) for each workflow's
  stage and, for sub-steps that map onto the journey, designs a risk
  anchored to the relevant step and a paired copilot intervention. Seven
  modalities are supported, including `silence` as a deliberate
  no-intervention output.
- Bundled framework data in `src/agent/stageDecomposition.ts` (mirrors the
  server's authoritative copy). The scan-agent prompt renders it inline so
  the agent has the full taxonomy in context.

### Changed
- `ScanFindings` schema (and the resulting artifact upload) gains two new
  arrays per workflow: `risks[]` and `interventions[]`. Both default to
  `[]` so existing workflows without a designed shadow path still
  validate.

## [0.1.1] — 2026-05-07

### Changed
- Repo split out of the `holostaff-agent` monorepo into its own home at
  [Holostaff-AI/holostaff-cli](https://github.com/Holostaff-AI/holostaff-cli).
- `package.json` `homepage` / `repository` / `bugs` URLs corrected. The
  `0.1.0` tarball pointed at a non-existent `automi-ai/holostaff-agent`
  repo; this release fixes the broken links on the npm page.
- Tag scheme simplified: future releases use `vX.Y.Z`, not `cli-vX.Y.Z`.

## [0.1.0] — 2026-05-07

First public alpha. Replaces the deleted browser wizard as the sole way to
build a Holostaff knowledge artifact and wire a copilot into a codebase.

### Added
- Interactive Ink shell entered by running `holostaff` in a repo.
- `/scan` — read-only repo scan that produces a structured artifact, shows
  a trust report, uploads on confirm.
- `/scan --add-repo <sourceId>` — merge the scan into an existing source
  rather than creating a new one (multi-repo product support).
- `/refine` — edit identity overrides (product name, one-line description,
  notes) on the live artifact without re-scanning.
- `/instrument` — agent drafts a tracking-SDK integration patch, shows a
  per-file diff, and on confirm creates a `holostaff/instrument-<ts>`
  branch and commits.
- `/embed` — same pattern for the widget script tag.
- Free-form chat — anything not starting with `/` goes to a Holostaff Q&A
  agent with multi-turn session resume.
- Auth — device-flow OAuth (interactive) and `HOLOSTAFF_API_KEY` +
  `HOLOSTAFF_WORKSPACE_ID` env-var auth (CI).
- Auth utilities — `/whoami`, `/workspace`, `/login`, `/logout`.
- `holostaff scan --quiet --json [--out PATH] [--add-repo ID]` — headless
  CI mode with typed exit codes (0 ok, 1 scan/upload failed, 2 bad
  args / preflight, 3 auth not configured).
- Anonymous, opt-out telemetry: `cli_version`, hashed `workspace_id`,
  `command`, `outcome`, `duration_ms`, `framework_detected`,
  `repo_size_bucket`, typed `error_kind`. Opt out with
  `HOLOSTAFF_TELEMETRY=0`.
- Per-repo source binding — first successful upload writes
  `.holostaff/source.json` so subsequent scans bump the same artifact.

### Known limitations
- The `@holostaff/sdk` tracking package referenced by `/instrument` is not
  yet on npm — `/instrument` ships the integration shape; the package
  lands separately. Tracked in PRD §13 OQ11.
- `/embed` writes a literal `data-staff-id="REPLACE_WITH_COPILOT_ID"`
  placeholder; the copilot picker lands once `/api/cli/copilots` ships
  with B4. Tracked in PRD §13 OQ12.
- Customers must currently bring their own Azure AI Foundry credentials
  (`AZURE_ANTHROPIC_ENDPOINT` + `AZURE_ANTHROPIC_API_KEY`). The backend
  will issue per-session model tokens before public GA. Tracked in PRD
  §13 OQ10.

[Unreleased]: https://github.com/Holostaff-AI/holostaff-cli/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/Holostaff-AI/holostaff-cli/releases/tag/v0.1.1
[0.1.0]: https://github.com/Holostaff-AI/holostaff-cli/releases/tag/v0.1.0
