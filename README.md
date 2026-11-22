<p align="center">
  <br/>
  <a href="https://opensource.org/license/agpl-v3"><img src="https://img.shields.io/badge/License-AGPL_v3-blue.svg?color=3F51B5&style=for-the-badge&label=License&logoColor=000000&labelColor=ececec" alt="License: AGPLv3"></a>
  <br/>
  <br/>
</p>

<p align="center">
  <a href="#">
    <img src="design/immich-logo-stacked-light.svg" width="300" alt="Immich Logo">
  </a>
</p>
<h3 align="center">Immich with Telegram-backed storage</h3>
<br/>

<p align="center">
An Immich fork: the normal Immich apps (web, mobile, desktop) on top, with
photo originals additionally stored in your own private Telegram channel —
unlimited capacity, no monthly fee, encrypted before they leave the server.
</p>

## What this fork adds

Immich keeps doing what Immich does: albums, search, faces, memories, maps, the
mobile apps. This fork adds one thing — a **Telegram storage backend**:

| | |
|---|---|
| **Unlimited capacity** | Telegram channels are not billed per gigabyte |
| **Encrypted at rest** | AES-256-GCM per 1 MiB chunk, per-file key derived with HKDF-SHA256 |
| **Zero UI changes** | The stock Immich clients work unreleased; backup/restore stays server-side |
| **Automatic restore** | If an original disappears from disk, the next download pulls it back from Telegram |
| **Predictable throttling** | Follows Telegram's own ~2 GB/day upload limit instead of being rate limited |
| **Self-contained** | One private channel, no third-party service, no sync client to install |

Read the design and the reasoning in [`PLAN-TELEGRAM-BACKEND.md`](./PLAN-TELEGRAM-BACKEND.md).

## How it works

```
upload ──▶ AssetCreate event ──▶ queue ──▶ encrypt ──▶ Telegram channel
                                                            │
                                                   telegram_ref table
                                                    (assetId ↔ messageId)

GET /assets/:id/original ── file on disk? ── yes ──▶ serve as usual
                                   │
                                   no ──▶ download + decrypt ──▶ serve
```

**The on-disk copy stays the source of truth.** Telegram is an off-ledger
backup, not a replacement — transcoding, thumbnails and machine learning keep
running against fast local storage. Only the original file is uploaded;
thumbnails, previews and encoded videos are regenerated locally and stay there.

## Quick start

```bash
# 1. Telegram credentials (https://my.telegram.org → API development tools)
#    and a private channel; its id starts with -100

# 2. Configure
TELEGRAM_STORAGE_ENABLED=true
TELEGRAM_API_ID=1234567
TELEGRAM_API_HASH=your_api_hash
TELEGRAM_CHAT_ID=-1001234567890

# 3. Generate the encryption key once, then keep it safe
docker exec -it immich-server immich-admin telegram:keygen
# → TELEGRAM_VAULT_KEY=<64 hex chars>   (add to the environment)

# 4. Create the MTProto session once (asks for phone + login code)
docker exec -it immich-server immich-admin telegram:login

# 5. Migrate and start
docker exec -it immich-server immich-admin migrations:run
docker compose up -d
```

New uploads are backed up from then on. Full instructions, operations and
caveats: [`TELEGRAM_STORAGE.md`](./TELEGRAM_STORAGE.md).

### Existing libraries

```bash
# queue every asset that has no Telegram copy yet (respects the daily budget)
curl -X POST -H "x-api-key: $KEY" http://localhost:2283/api/admin/telegram/backfill

# connection, queue depth, today's quota, backed-up count
curl -H "x-api-key: $KEY" http://localhost:2283/api/admin/telegram/status
```

A large first backfill takes days at 2 GB/day by design — that is Telegram's
limit, and the queue resumes where it stopped.

## ⚠️ Before you rely on this

- **`TELEGRAM_VAULT_KEY` is unrecoverable.** Lose it and every file already
  uploaded becomes unreadable. Store it outside the server.
- **The session file is a credential.** It grants full access to the Telegram
  account; never commit it, and treat it like a password.
- **Telegram is a third party.** Using it for storage is your call and your
  risk; terms and reliability are theirs, not this project's. Keep an
  independent backup — the [3-2-1 rule](https://www.backblaze.com/blog/the-3-2-1-backup-strategy/)
  still applies.
- **Single account, single channel.** No multi-account rotation yet.

## Status

| Area | State |
|---|---|
| Crypto (envelope, tamper detection) | Implemented, unit tested |
| MTProto upload/download + FLOOD_WAIT backoff | Implemented |
| Daily quota, sync queue, admin endpoints | Implemented |
| Restore fallback on download | Implemented |
| Live end-to-end run against a real Telegram account | Pending |

The branch carrying this work is `telegram-backend`. Live verification against a
real Telegram account is the next step; until then treat the feature as
unverified in production.

## Upstream

This fork is based on [immich-app/immich](https://github.com/immich-app/immich)
and tracks its `main`. Everything not related to the Telegram backend comes from
upstream — see their [documentation](https://docs.immich.app/),
[installation guide](https://docs.immich.app/install/requirements) and
[contributing guide](https://docs.immich.app/overview/support-the-project).

If you do not need Telegram storage, use upstream Immich instead of this fork.

## License

AGPLv3, same as upstream.
