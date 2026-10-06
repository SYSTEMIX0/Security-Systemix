#!/usr/bin/env bash
# تثبيت Systemix على سيرفر Ubuntu/Debian: Node 20 + pm2 + Caddy (HTTPS تلقائي).
# الاستخدام:  sudo bash deploy/setup-vps.sh your-domain.example
set -euo pipefail
DOMAIN="${1:?اكتب الدومين: sudo bash deploy/setup-vps.sh your-domain.example}"
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"

apt-get update -y
apt-get install -y curl ca-certificates gnupg debian-keyring debian-archive-keyring apt-transport-https

if ! command -v node >/dev/null || [ "$(node -v | cut -d. -f1 | tr -d v)" -lt 18 ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
npm install -g pm2

if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y && apt-get install -y caddy
fi
printf '%s {\n    encode gzip\n    reverse_proxy localhost:3000\n}\n' "$DOMAIN" > /etc/caddy/Caddyfile
systemctl reload caddy || systemctl restart caddy

cd "$APP_DIR"
[ -f .env ] || { cp .env.example .env; echo ">> عبّي ملف .env ثم أعد تشغيل السكربت"; exit 1; }
npm install --omit=dev
pm2 start src/index.js --name systemix --update-env
pm2 save
pm2 startup systemd -u "${SUDO_USER:-root}" --hp "$(getent passwd "${SUDO_USER:-root}" | cut -d: -f6)" >/dev/null || true
echo "تم ✅  الرابط: https://$DOMAIN   (سجّل https://$DOMAIN/auth/callback في Developer Portal > OAuth2 > Redirects، وحط PUBLIC_URL=https://$DOMAIN في .env)"
