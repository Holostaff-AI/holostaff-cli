# Changelog

All notable changes to `@holostaff/cli` are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). The CLI follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html); during alpha
(`0.x`) minor bumps may include breaking changes.

## [Unreleased]

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
