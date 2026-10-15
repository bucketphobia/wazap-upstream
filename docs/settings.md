# Settings

Most of these are written for you by `wazap config`, `wazap login` and
`wazap expose`; `.env.example` shows them all with their comments.

| Variable | Default | Meaning |
| --- | --- | --- |
| `WAZAP_DATA_DIR` | `~/.wazap` | Where everything is stored. |
| `WAZAP_READ_ONLY` | unset (`0`) | `1` does not register the write tools. Unset and `0` both do. `wazap config writes on\|off` sets it. |
| `WAZAP_PERSIST_HISTORY` | `1` | Privacy: `0` keeps no messages on disk, removing them at each start and stop; barriers, chats, contacts and notes stay, and recall is off. |
| `WAZAP_HOST` / `WAZAP_PORT` | `127.0.0.1` / `8766` | Where `wazap serve --http` listens. |
| `WAZAP_PUBLIC_URL` / `WAZAP_OAUTH_PASSWORD` | unset | The `https` address agents reach the server at, and the password its consent page asks for (at least 8 characters). Both together turn [OAuth](self-host.md#hosted-agents-oauth) on; `wazap expose` sets them. |
| `WAZAP_READ_TOKEN` / `WAZAP_WRITE_TOKEN` | unset | Static bearer tokens for your own code; see [Building on wazap](api-and-webhooks.md#building-on-wazap-http-api-for-products). |
| `WAZAP_TRANSCRIBE` | `off` | `local`, `openai` or `off`. `wazap config transcribe` sets it. |
| `WAZAP_TRANSCRIBE_API_KEY` | unset | The key for `openai`; `OPENAI_API_KEY` is the fallback. Never a flag. |
| `WAZAP_TRANSCRIBE_AUTH` | unset | `Bearer <token>` (or any Authorization value), or `<Header-Name>: <value>`, as with `WAZAP_WEBHOOK_AUTH`. Overrides both API key settings; no key is then required. A credential: reported only as set, never printed. HTTPS-or-loopback still applies. |
| `WAZAP_TRANSCRIBE_ALLOW_API` | unset (`0`) | `1` lets a read-only account upload audio to `openai` (and be billed for it); WhatsApp writes stay off. Notes are then transcribed when asked, unless `WAZAP_TRANSCRIBE_AUTO` says otherwise. |
| `WAZAP_TRANSCRIBE_AUTO` | `1` | `0` stops background transcription. `all` takes the user's own new live notes to `openai` too, with `WAZAP_TRANSCRIBE_ALLOW_API=1`; never history or stored notes. |
| `WAZAP_RECALL_CACHE_MAX_MB` | `2048` | Shared vector cache limit in MiB, including shared indexes; `0` disables it. Maps and process overhead are additional. See [search workers](recall.md#search-workers). |
| `WAZAP_RECALL` | `off` | `local` turns on [semantic recall](recall.md#semantic-recall). `wazap config recall` sets it. |
| `WAZAP_WEBHOOK` | `off` | `on` posts the enabled events to the webhook URL. `wazap config webhook` sets it with the next two. |
| `WAZAP_WEBHOOK_URL` / `WAZAP_WEBHOOK_SECRET` | unset | HTTPS endpoint (`http://` only on loopback) and the shared secret for `X-Wazap-Signature`. The secret is never a flag. An account's `webhook_url` and `webhook_secret` win. |
| `WAZAP_WEBHOOK_EVENTS` | unset (`message_received`) | Which events to post, comma-separated: `message_received`, `message_sent`, `connection`, `alert`, `reminder`, `scheduled`. `all` is the first three; the last three are posted only when named (`all,alert` adds alerts). An account's `webhook_events` wins. |
| `WAZAP_WEBHOOK_AUTH` | unset | A header the receiver expects beside the signature: `Bearer <token>` goes out as `Authorization`, `<Header-Name>: <value>` as that header. `wazap config webhook auth` sets it at a prompt that does not echo it. An account's `webhook_auth` wins. |
| `WAZAP_WEBHOOK_CHATS` | unset | Comma-separated chat ids or phone numbers. Together with `WAZAP_WEBHOOK_TAG`, or on its own, only matching chats are posted. Unset, with no tag, posts every chat except contacts tagged `#private`. An empty value posts no message events. Groups match only when listed. A contact tagged `#private` is never posted, with or without a filter. `connection` events are not filtered. `wazap config webhook chats` writes it. An account's `webhook_chats` replaces the global filter, tag included. |
| `WAZAP_WEBHOOK_TAG` | unset | A contact tag, stored the way `remember` stores it (`autopeloc` or `#autopeloc`). Direct chats filed under it are posted. Groups are not. Membership is read from the account database, so it changes without a restart. An account's `webhook_tag` replaces the global filter, chat list included. |
| `WAZAP_WEBHOOK_COALESCE` | unset (`off`) | Seconds a chat's messages wait so they can share one POST, from 1 to 300. Delivery also happens by twice that, and never later than 5 minutes after the first message of the burst. Unset posts one event per message. An account's `webhook_coalesce` wins. `0` turns the wait off for that account. |
| `WAZAP_WEBHOOK_RETRY_401` | unset (`off`) | `on` retries a 401 on the same schedule as a 5xx. Unset fails a 401 at once. An account's `webhook_retry_401` wins. |
| `WAZAP_MEDIA_KEEP` | `unmuted` | Which chats' arriving media is downloaded at once and [kept](data.md#kept-media), so `get_media` still has it after WhatsApp drops it: `unmuted` (every direct or group chat not muted), `all` (muted ones too), `chats` (only `WAZAP_MEDIA_KEEP_CHATS`), or `off`. Channels and broadcast lists only when listed. `off` also removes the copies kept earlier, at the next start. A value that does not parse keeps nothing new and removes nothing, with a warning at startup. Nothing is kept with `WAZAP_PERSIST_HISTORY=0`. |
| `WAZAP_MEDIA_KEEP_CHATS` | unset | Comma-separated chat ids or phone numbers: the only chats under `chats`; under `unmuted` and `all`, kept even while muted, channels included. |
| `WAZAP_MEDIA_KEEP_TYPES` | `image,voice,audio,document` | Which media is kept, comma-separated, from `image`, `voice`, `audio`, `document`, `video`, `sticker`. View-once media is never kept. |
| `WAZAP_MEDIA_KEEP_MAX_MB` | `16` | A file bigger than this (1 to 100 MB) is not kept. |
| `WAZAP_MEDIA_KEEP_QUOTA_MB` | `1024` | All of an account's kept files together stay under this; the oldest are removed first to make room. Nothing is written that would leave the disk with less than 1 GB, or 5% of it, free. |
| `WAZAP_MEDIA_KEEP_DAYS` | `90` | A file kept longer than this is removed (checked at start and hourly); `0` keeps files until the quota needs the room. |
| `WAZAP_RETENTION` | `0` | `1` turns on [strict retention](data.md#strict-retention-wazap_retention1-off-by-default). |
| `WAZAP_PRE_MIGRATION_BACKUP` | `1` | `0` upgrades the account database without first copying it beside itself. An upgrade that cannot write the copy refuses to start; this is the way past that, knowingly. |
| `WAZAP_TRUST_PROXY` | `loopback` | Advanced, for a self-hosted OAuth server behind a proxy: the proxy IPs/CIDRs trusted for X-Forwarded-For, comma-separated; `none` trusts no proxy. |

Flags beat environment variables, which beat `<data-dir>/.env`. A setting an
earlier wazap read and this one does not is ignored, with a warning at startup
that says what replaced it; see the [CHANGELOG](../CHANGELOG.md).
`WAZAP_TRANSPORT=http` still serves HTTP through 1.x, with a warning: `--http`
is the supported way, and the variable goes away in 2.0.

Anything else `WAZAP_*` that the code still reads is a development knob, not a
setting: it is listed under **Development knobs** in
[CLAUDE.md](../CLAUDE.md#development-knobs), and a user should not need it.
