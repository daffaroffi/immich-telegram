# Telegram Storage Integration

Free unlimited cloud storage for your Immich photo library using Telegram.

## Overview

This integration allows you to use Telegram Cloud Storage as the primary storage backend for Immich, providing:

- **Unlimited storage** - No size limits, no monthly fees
- **Fast access** - Local caching system for thumbnails and frequently accessed files
- **Secure** - TDENC2 encryption (XChaCha20-Poly1305) before upload
- **Reliable** - Built on Telegram's infrastructure with 99.9% uptime

## Prerequisites

1. **Telegram Account** - You need a Telegram account
2. **API Credentials** - Register at https://my.telegram.org
3. **Storage Channel** - Create a private Telegram channel for file storage

## Setup Guide

### Step 1: Get API Credentials

1. Go to https://my.telegram.org
2. Log in with your phone number
3. Go to "API Development Tools"
4. Create a new application
5. Note down `api_id` and `api_hash`

### Step 2: Create Storage Channel

1. Open Telegram and create a new **private channel**
2. Name it something like "Immich Storage"
3. Add your account as admin
4. Get the channel ID:
   - Forward a message from the channel to [@userinfobot](https://t.me/userinfobot)
   - Or use [@RawDataBot](https://t.me/RawDataBot) and look for `chat_id`

### Step 3: Configure Environment Variables

Add these to your `.env` file or `docker-compose.yml`:

```bash
# Enable Telegram storage
TELEGRAM_STORAGE_ENABLED=true

# API credentials (from Step 1)
TELEGRAM_API_ID=12345678
TELEGRAM_API_HASH=abcdef1234567890

# Channel ID (from Step 2) - must start with -100
TELEGRAM_CHAT_ID=-1001234567890

# Encryption (recommended)
TELEGRAM_ENCRYPTION_ENABLED=true
TELEGRAM_VAULT_KEY=  # Auto-generated on first run, SAVE THIS!
```

### Step 4: Run Database Migration

```bash
# From the server directory
pnpm run migrations:run
```

### Step 5: Start Immich

```bash
docker compose up -d
```

### Step 6: Authenticate with Telegram

On first run, Immich will prompt for Telegram authentication:

1. Check your Telegram for a login code
2. Enter the code when prompted
3. If you have 2FA enabled, enter your password

The session is saved to `/config/telegram.session` and persists across restarts.

## Configuration Options

| Variable | Description | Default |
|----------|-------------|---------|
| `TELEGRAM_STORAGE_ENABLED` | Enable/disable Telegram storage | `false` |
| `TELEGRAM_API_ID` | Telegram API ID | - |
| `TELEGRAM_API_HASH` | Telegram API hash | - |
| `TELEGRAM_CHAT_ID` | Target channel ID | - |
| `TELEGRAM_SESSION_PATH` | Session file path | `/config/telegram.session` |
| `TELEGRAM_ENCRYPTION_ENABLED` | Enable TDENC2 encryption | `true` |
| `TELEGRAM_VAULT_KEY` | Encryption key (hex) | Auto-generated |
| `TELEGRAM_CACHE_SIZE_MB` | Local cache size | `5120` (5GB) |
| `TELEGRAM_CACHE_TTL_HOURS` | Cache expiry time | `168` (1 week) |
| `TELEGRAM_MAX_CONCURRENT_UPLOADS` | Parallel uploads | `4` |
| `TELEGRAM_MAX_CONCURRENT_DOWNLOADS` | Parallel downloads | `8` |
| `TELEGRAM_UPLOAD_DELAY_MS` | Delay between uploads | `1000` |

## Multi-Account Support

For rate limit distribution, you can configure multiple Telegram accounts:

```bash
TELEGRAM_ACCOUNTS=primary,backup1,backup2

TELEGRAM_PRIMARY_API_ID=123456
TELEGRAM_PRIMARY_API_HASH=abc123
TELEGRAM_PRIMARY_SESSION=/config/session-primary
TELEGRAM_PRIMARY_CHAT_ID=-1001234567890

TELEGRAM_BACKUP1_API_ID=789012
TELEGRAM_BACKUP1_API_HASH=def456
TELEGRAM_BACKUP1_SESSION=/config/session-backup1
TELEGRAM_BACKUP1_CHAT_ID=-1009876543210
```

## Storage Modes

| Mode | Description |
|------|-------------|
| `local-only` | Default Immich behavior, no Telegram |
| `telegram-primary` | All files stored in Telegram |
| `hybrid` | Hot files local, cold files Telegram |
| `backup-only` | Local primary, Telegram backup |

## API Endpoints

Admin endpoints for managing Telegram storage:

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/admin/telegram/status` | Get storage status |
| `POST` | `/api/admin/telegram/config` | Update configuration |
| `POST` | `/api/admin/telegram/migrate` | Start migration |
| `GET` | `/api/admin/telegram/migrate/:id` | Get migration progress |
| `GET` | `/api/admin/telegram/cache` | Get cache statistics |
| `POST` | `/api/admin/telegram/cache/clear` | Clear cache |

## Architecture

```
┌─────────────────────────────────────────┐
│              Immich Server               │
│                                         │
│  ┌───────────────────────────────────┐  │
│  │      Storage Abstraction Layer    │  │
│  │  ┌──────────┐  ┌──────────────┐  │  │
│  │  │  Local   │  │   Telegram   │  │  │
│  │  │ Storage  │  │   Storage    │  │  │
│  │  └──────────┘  └──────────────┘  │  │
│  └───────────────────────────────────┘  │
│                    │                    │
│  ┌───────────────────────────────────┐  │
│  │      Cache Layer (Memory + Disk)  │  │
│  └───────────────────────────────────┘  │
└───────────────────┬─────────────────────┘
                    │
┌───────────────────▼─────────────────────┐
│         Telegram MTProto API            │
│  ┌───────────────────────────────────┐  │
│  │     TDENC2 Encryption Layer       │  │
│  │  - XChaCha20-Poly1305 (AEAD)     │  │
│  │  - HKDF-SHA256 (key derivation)  │  │
│  └───────────────────────────────────┘  │
└───────────────────┬─────────────────────┘
                    │
┌───────────────────▼─────────────────────┐
│       Telegram Cloud Storage            │
│  - Channel: "Immich Storage"            │
│  - Max 2 GB per file                    │
│  - Unlimited total storage              │
└─────────────────────────────────────────┘
```

## Migration

To migrate existing local files to Telegram:

```bash
# Via API
curl -X POST http://localhost:2283/api/admin/telegram/migrate \
  -H "x-api-key: YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "dryRun": false,
    "concurrency": 4,
    "includeThumbnails": true,
    "includeEncodedVideo": true
  }'
```

Or use the admin UI at `http://localhost:2283/admin/telegram`.

## Troubleshooting

### "FLOOD_WAIT" errors
Telegram rate limits requests. The system automatically waits and retries. Reduce `TELEGRAM_MAX_CONCURRENT_UPLOADS` if frequent.

### "Unauthorized" errors
Re-authenticate by deleting the session file and restarting:
```bash
rm /config/telegram.session
docker compose restart server
```

### Files not uploading
1. Check `TELEGRAM_STORAGE_ENABLED=true`
2. Verify channel ID starts with `-100`
3. Ensure bot/admin is added to the channel
4. Check server logs: `docker compose logs -f server`

### Slow thumbnail loading
Increase cache size:
```bash
TELEGRAM_CACHE_SIZE_MB=10240  # 10GB
```

## Security Notes

- Files are encrypted with TDENC2 before upload
- The vault key is auto-generated on first run
- **BACKUP YOUR VAULT KEY** - losing it means losing access to encrypted files
- Session files contain authentication tokens - keep them secure

## Links

- [Telegram MTProto Documentation](https://core.telegram.org/mtproto)
- [TDENC2 Specification](https://github.com/nicegram/nicegram-telegram-encryption)
- [gramjs Library](https://gram.js.org)
