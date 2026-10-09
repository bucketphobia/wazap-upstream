# Contributor notes

wazap is the `wazap-mcp` npm package; the command it installs is `wazap`. This
file is for people changing the code and is not published. `AGENT.md`
(singular) is a different document: it ships in the package and drives a
first-time setup for an agent's user.

## Layout

- `src/*.ts` — runtime code, ESM, TypeScript strict; `npm run build` emits
  `dist/` (gitignored), which is what runs. `src/whatsapp.ts` is one account's
  service; each thing it does is a part in `src/service/`.
- `test/*.test.mjs` — plain JS on `node:test`, against the **built** `dist/`:
  a source edit is not tested until `npm run build` (`npm test` builds first).
- `scripts/` — repo utilities; `scripts/eval/` is the assistant evaluation
  harness (`eval/` holds its cases and fixtures).
- `dist-bundle/`, `node_modules/` — generated, never edit.

## Commands

- `npm run check` — the local gate: lint → typecheck → test (which builds).
- `npm run check:clock` — the suite on clocks that break day arithmetic, ~3 min.
- `npm run check:linux` — in Docker, the tests a change reaches on Node 22.16.0
  and 24 (`-- --all` for the whole suite).
- `npm run bench:db`, `npm run fold:table` — database timing, and regenerating
  `src/db/fold-table.ts`. Neither is in the gate.

## The gate and the hook

`npm run check` is what CI runs on Node 22.16.0 and 24, after `npm ci`. CI
also runs `npm audit --omit=dev --audit-level=high`, and a weekly Baileys
canary tests against the newest Baileys (a red canary blocks nothing).

`npm run hooks:install` (once per clone) turns on the pre-push hook in
`scripts/git-hooks/`, which runs the gate. Skip it only consciously:
`git push --no-verify` or `SKIP_GATE=1 git push`.

## Commit style

`<Area>: <what changed>` as a sentence, e.g. `Webhook: make message_sent and
connection opt-in`. Releases are `Release X.Y.Z: ...`. Small commits.

## Releases

A release is one commit and one tag; CI does the publishing.

1. Bump the version in `package.json`, `package-lock.json` (both root
   entries), `server.json` (top level and the npm package), `manifest.json`
   and `.claude-plugin/plugin.json`.
2. Add a `## X.Y.Z` section at the top of `CHANGELOG.md`; it becomes the
   GitHub Release notes, and publishing refuses a version without one.
3. Commit as `Release X.Y.Z: <what is in it>`, tag `vX.Y.Z`, push both.

The tag runs `.github/workflows/publish.yml`: npm with provenance, the MCP
Registry, then the GitHub Release with the `.mcpb`. When a step fails after
`npm publish`, do not re-run the whole workflow (npm refuses a version twice):
`scripts/release-registry.sh` redoes the registry step, and a failed `release`
job can be re-run alone.

## Rules that must never break

- **stdout is the MCP protocol.** Over stdio every byte on stdout is protocol;
  human-readable lines go to stderr (`src/logger.ts`).
- **One process owns a data dir.** `server.lock` enforces it.
- **No secrets, ever.** `.env`, `accounts.json`, tokens and pairing codes stay
  out of the tree, and out of error strings and logs.
- **Settings are few on purpose.** `.env.example` and `docs/settings.md` list
  every `WAZAP_*` a user sets, and nothing else. A setting that stops being
  read goes into `RETIRED_SETTINGS` in `src/config.ts`.
- **A schema migration never runs without a copy of the file beside it.**
  Nothing may move a write ahead of that copy in `Connection.open`.
- **Hygiene is not behavior.** Lint, format and docs commits must not change
  what the binary does.

## Development knobs

Read by the code, used by tests and local debugging, and deliberately not
settings: `WAZAP_TEST_WAIT_SCALE`, `WAZAP_NO_UPDATE_CHECK`, `WAZAP_NO_SHARE`,
`WAZAP_LIVE_TIMEOUT_MS`, `WAZAP_TRANSCRIBE_URL`,
`WAZAP_TRANSCRIBE_MODEL`, `WAZAP_WHISPER_MODEL`, `WAZAP_WHISPER_BIN`,
`WAZAP_EMBED_MODEL`, `WAZAP_EMBED_BIN`, `WAZAP_EMBED_URL`,
`WAZAP_RECALL_MIN_SIMILARITY`. Do not document them as settings, and do not
remove one while a test sets it.
