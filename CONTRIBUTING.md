# Contributing to `@holostaff/cli`

Thanks for the interest. The CLI is alpha and moves fast — expect rough
edges. This file is the short version; deeper context lives in
[`documents/holostaff-cli-prd.md`](../documents/holostaff-cli-prd.md).

## Dev setup

```bash
git clone https://github.com/automi-ai/holostaff-agent
cd holostaff-agent/cli
npm install
npm run build
npm link            # makes `holostaff` available globally for local testing
```

Requires Node 20+.

You'll also need:
- `AZURE_ANTHROPIC_ENDPOINT` + `AZURE_ANTHROPIC_API_KEY` for any flow that
  invokes the agent (`/scan`, `/instrument`, `/embed`, `/refine`).
- A Holostaff workspace to upload artifacts to. For local dev against a
  non-prod backend set `HOLOSTAFF_API_BASE_URL` and
  `HOLOSTAFF_APP_BASE_URL`.

## Running

- `npm run dev` — run the CLI under `tsx` without a build step.
- `npm run build && node dist/index.js` — exercise the same code path the
  npm tarball ships.
- `npm run typecheck` — fast feedback while editing types.

## Smoke spikes

Each major flow has a smoke spike under `src/spike/` that runs the agent
against a tmp fixture without touching the user's repo:

- `npm run spike:scan` / `spike:scan-ink` / `spike:trust-report`
- `npm run spike:upload`
- `npm run spike:chat`
- `npm run spike:refine`
- `npm run spike:add-repo`
- `npm run spike:instrument`
- `npm run spike:embed`

Spikes are excluded from the published tarball and from `tsc` builds (see
[tsconfig.json](./tsconfig.json) `exclude`).

## Code style

- TypeScript strict mode; no `any` unless commented and unavoidable.
- Use the existing Ink components in `src/ui/` rather than adding a new
  layout primitive — the shell, scan, refine, instrument, and embed flows
  share patterns intentionally.
- Agent prompts live next to their drivers (`agent/<flow>/<flow>Prompt.ts`).
- New slash commands go through `src/commands/slash.ts` with a typed
  `SlashOutcome` variant.

## Telemetry

If your change adds a new flow or error path, emit a typed event via
[`src/telemetry.ts`](./src/telemetry.ts) so we can see it in the field.
The event must use the existing `TelemetryCommand` / `TelemetryOutcome`
union types — extend them rather than passing a free-form string.

## Releasing

Maintainers only:

1. Bump `version` in [package.json](./package.json).
2. Add a section to [CHANGELOG.md](./CHANGELOG.md) under a new
   `[X.Y.Z] — YYYY-MM-DD` heading.
3. Commit, then tag: `git tag cli-vX.Y.Z && git push --tags`.
4. The `cli-release` GitHub Action publishes the signed tarball to npm.

The release workflow refuses to publish if the tag's version doesn't
match `package.json`, so a botched bump can't ship a stale build.

## Reporting issues

[github.com/automi-ai/holostaff-agent/issues](https://github.com/automi-ai/holostaff-agent/issues).
Include CLI version (`holostaff --version`), framework, and the error
output. We're especially interested in scans that produce empty
artifacts and `/instrument` patches that don't typecheck.
