# Security

## Reporting a vulnerability

Email security@holostaff.ai. We acknowledge within 2 business days and keep you updated until the fix ships. Please do not test against other customers' workspaces or the hosted service beyond what is needed to demonstrate the issue.

## What this CLI touches

- Reads your repository with read-only tools. It never writes to your source except through `holostaff deploy`, which opens a pull request you review.
- Uploads only the scan artifact shown in the trust report: product identity, routes, component names with roles, customer-facing copy strings, brand voice, workflows and steps, coverage gaps. Source code, `.env` files, secrets, and git history never leave your machine.
- Stores state in `.holostaff/` in your repo and `~/.holostaff/credentials.json` (a workspace token). Delete both to remove every trace.
- Model calls during a scan go through your Holostaff workspace; you hold no model keys.

## What the runtime SDK touches

The SDK your deploy PR adds records the page with rrweb so the autopilot can act from what is on screen. Password, email, and phone inputs are always masked; mark rendered personal data with `holostaff-mask` or `holostaff-block`; set `observe: { enabled: false }` to turn capture off for a host. Consequential actions wait for the user's inline Allow, and the autopilot never types into password, payment, or code fields. These rules are enforced in the runtime, not the prompt.

Full data-handling details (hosting regions, subprocessors, retention, DPA): https://www.holostaff.ai/security

## Supported versions

Only the latest published `@holostaff/cli` and `@holostaff/sdk` receive security fixes during alpha.
