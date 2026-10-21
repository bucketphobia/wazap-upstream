# Contributing

Issues and pull requests are welcome. Setup is in the README's
[Contributing](README.md#contributing) section; [CLAUDE.md](CLAUDE.md) is the
map: layout, the gate, commit style and the rules that must never break.

Before you open a pull request:

- `npm run check` passes (lint, typecheck, build and test). The tests need no
  WhatsApp account.
- Commits read `<Area>: <what changed>`, e.g. `Webhook: make message_sent and
  connection opt-in`.
- Anything that costs every install memory, disk or background work is off by
  default and turned on with a setting.
- Leave the version and `CHANGELOG.md` to the release.
