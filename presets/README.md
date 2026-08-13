# Preset journey maps

A scan of an open-source product, published so the next person does not
have to run it again.

```bash
npx @holostaff/cli scan --from https://raw.githubusercontent.com/Holostaff-AI/holostaff-cli/master/presets/opnform.json
```

That creates the map in your workspace in about a second: no agent run,
no model spend, no nine-minute wait. You get your own source, your own
version, and your own copy to edit. Provenance is recorded as
`cli_preset` rather than `cli_scan`, because nobody read *your* code.

Use a preset when you self-host a product we have already scanned. Run a
normal `scan` when you have forked it heavily, or when it is yours.

| File | Product | Scanned from |
|---|---|---|
| `opnform.json` | [OpnForm](https://github.com/OpnForm/OpnForm), open-source form builder | `3a1b5abd`, 2026-08-07 |
| `formbricks.json` | [Formbricks](https://github.com/formbricks/formbricks), open-source survey platform | `4185f823`, 2026-08-10 |
| `atlas-cmms.json` | [Atlas CMMS](https://github.com/Grashjs/cmms), open-source maintenance management | `5c8e395c`, 2026-08-11 |
| `documenso.json` | [Documenso](https://github.com/documenso/documenso), open-source document signing | `617f8cc2`, 2026-08-12 |

Presets are plain artifact JSON. `--from` also accepts a local path, and
accepts either a bare artifact or an API response wrapped in
`{ "artifact": ... }`, so you can pull one straight off your own map and
hand it to a colleague.
