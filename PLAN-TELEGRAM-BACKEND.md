# Plan — Immich 3.4 + Telegram Storage (Jalur B)

Tanggal: 2026-11-22 · Status: PLAN (belum eksekusi)

## Keputusan final (Dapa)

1. **Jalur B**: port engine Telegram-Drive → modul server Immich (TypeScript/gramjs), bukan REST client.
2. **UI & apps**: 100% Immich bawaan (web/mobile/desktop). Tidak ada perubahan di web/, mobile/, e2e/.
3. **Original tetap di disk VPS** — Telegram = lapisan cadangan tak terbatas + restore otomatis kalau disk hilang.
4. **Enkripsi sendiri** (bukan TDENC2, tidak perlu kompatibel Telegram-Drive).
5. **Tanpa multi-akun**. Rate-limit mengikuti Telegram: default `TELEGRAM_DAILY_UPLOAD_LIMIT_MB = 2048` (2 GB/hari), upload berhenti & lanjut besok.
6. **Deploy**: nanti, bukan VPS ini (12 GB sudah terisi tumpukan lain).

## Arsitektur

```
[Apps Immich: APK/IPA/EXE]  ←  tidak diubah
        │ API
[Server Immich 3.4]
  asset-media.service ──(AssetCreate event)──▶ telegram-sync.service (BARU)
        │                                          │
        │                              [antrian + daily quota]
        │                                          │
  downloadOriginal ◀──fallback──▶ telegram-restore ─┤
        │                                          │
  disk VPS (source of truth)           telegram-mtproto (gramjs)
  thumbnails/preview: disk saja        telegram-crypto (enkripsi sendiri)
                                               │
                                     [Channel Telegram privat]
                                     tabel telegram_ref: asset_id ↔ msg_id
```

## Komponen baru (server/src/)

| # | File | Isi | Sumber |
|---|------|-----|--------|
| 1 | `services/telegram/mtproto.service.ts` | gramjs klien: login (api_id/api_hash, session file), uploadFile chunked, downloadMedia, reconnect | port dari fork lama `telegram-mtproto.service.ts` (448 l) + pola `resumable_upload.rs` Telegram-Drive |
| 2 | `services/telegram/crypto.service.ts` | enkripsi sendiri: XChaCha20-Poly1305 per-chunk (AES-GCM via node:crypto fallback), HKDF derive, random nonce per file, key dari `TELEGRAM_VAULT_KEY` env | fork lama `telegram-encryption.service.ts` (526 l) — buang TDENC2 header/key-slot, simpelkan |
| 3 | `services/telegram/quota.service.ts` | daily limit 2 GB, reset tengah malam WIB, antrian antar-hari | baru (ganti rate-limit.service 201 l) |
| 4 | `services/telegram/sync.service.ts` | **inti**: `@OnEvent('AssetCreate')` → enqueue; job antrian: baca file disk → encrypt → upload → simpan `telegram_ref`; retry; status | baru |
| 5 | `services/telegram/restore.service.ts` | fallback `downloadOriginal`: kalau disk hilang → download+decrypt dari Telegram → tulis ke disk → serve | baru |
| 6 | `schema/tables/telegram-ref.table.ts` + migration | `asset_id FK, message_id int, chat_id bigint, size, checksum sha1, encrypted bool, uploaded_at` | adaptasi fork lama `telegram-storage.entity.ts` |
| 7 | `controllers/telegram-admin.controller.ts` | `GET /admin/telegram/status`, `POST /admin/telegram/sync` (scan semua asset), `POST /admin/telegram/verify` | fork lama (132 l) — dipangkas |
| 8 | `config/telegram.config.ts` + env.dto.ts | TELEGRAM_ENABLED, API_ID, API_HASH, CHAT_ID, SESSION_PATH, VAULT_KEY, DAILY_UPLOAD_LIMIT_MB | fork lama |
| 9 | Patch `asset-media.service.ts` | fallback restore di `downloadOriginal` | baru |
| 10 | Patch `enum.ts` / `types.ts` / `app.module.ts` | JobName.TelegramUpload dsb, register provider | kecil |

Hapus dari fork lama: migration service (259 l) — tidak perlu (original tetap di disk, sync sekali jalan + incremental), admin API yang tebal.

## Urutan eksekusi (sprint)

1. **Sprint 1 — fondasi**: table+migration, config+env, mtproto.service (login+upload+download mentah, test manual ke channel), crypto.service. Target: upload 1 file terenkripsi & download balik, CLI/scratch test.
2. **Sprint 2 — sync**: quota.service, sync.service (event+queue+telegram_ref), register module. Target: upload foto baru lewat UI → otomatis muncul di Telegram, tercatat di DB.
3. **Sprint 3 — restore + admin**: restore fallback di downloadOriginal, admin controller, backfill semua asset lama. Target: hapus file disk → UI tetap tampil (restore otomatis), status admin benar.
4. **Sprint 4 — hardening**: retry/backoff FLOOD_WAIT, integritas (verifikasi checksum), dokumentasi, tag release fork.

## Risiko & mitigasi

- **gramjs di NestJS/Immich**: dynamic import seperti fork lama; kalau bundling kewalahan, jalankan sebagai worker process terpisah dalam repo yang sama.
- **FLOOD_WAIT**: quota 2 GB/hari diharapkan cegah sebelum Telegram menjegal; tangkap error & jadwalkan ulang.
- **DB lock**: telegram_ref sederhana (1 row/asset) — aman di Postgres.
- **VPS disk penuh**: sync baca dari disk, tidak menduplikasi (cache tidak dipakai — thumbnails tidak pernah dikirim ke Telegram, hanya original + preview opsional).

## Yang belum diputuskan (untuk diskusi berikutnya)

- Nama release/branding fork (tetap `immich-telegram`?)
- Locale channel: 1 channel saja untuk semua user (single-user install) — diasumsikan ya
- Estimasi waktu per sprint belum dihitung sampai sprint 1 jadi (gramjs behaviour di Node 26 perlu diverifikasi dulu)
