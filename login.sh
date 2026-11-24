#!/usr/bin/env bash
# =============================================================
# Login Telegram untuk immich-telegram — jalankan di VPS:
#   bash /root/immich-telegram/login.sh
# (atau: node /root/immich-telegram/server/login-cli.js)
# =============================================================
set -e
cd "$(dirname "$0")/server"

echo "== Login Telegram MTProto (immich-telegram) =="
read -rp "Nomor HP (format internasional, mis. +6289678430846): " PHONE

node login-cli.js "$PHONE"
