#!/usr/bin/env bash
# One-command deploy to a fresh Ubuntu/Debian VPS (Hetzner, DigitalOcean, Vultr…).
# Installs Docker and Caddy (automatic HTTPS), clones the repo, and starts the app.
#
#   ssh root@your-server 'bash -s' < deploy/deploy.sh resume.example.com you@example.com
#
# Afterwards edit /opt/resume-editor/.env (ANTHROPIC_API_KEY, SIGNUP_CODE, …) and run:
#   cd /opt/resume-editor && docker compose up -d
#
# Re-run the same command later to pull the latest code and rebuild.
set -euo pipefail

DOMAIN="${1:?usage: deploy.sh <domain> <letsencrypt-email>}"
EMAIL="${2:?usage: deploy.sh <domain> <letsencrypt-email>}"
REPO="${REPO:-https://github.com/acorbin3/resume-editor.git}"
DIR=/opt/resume-editor

if ! command -v docker >/dev/null; then
  curl -fsSL https://get.docker.com | sh
fi

if ! command -v caddy >/dev/null; then
  apt-get update
  apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl gnupg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update && apt-get install -y caddy
fi

if [ -d "$DIR/.git" ]; then
  git -C "$DIR" pull --ff-only
else
  git clone "$REPO" "$DIR"
fi
cd "$DIR"

if [ ! -f .env ]; then
  cp .env.example .env
  echo "SIGNUP_CODE=$(openssl rand -hex 8)" >> .env
  echo "APP_URL=https://$DOMAIN" >> .env
  echo ">> Created .env. Set ANTHROPIC_API_KEY in $DIR/.env before using the app."
fi

# Caddy terminates HTTPS and forwards to the container on localhost:4747.
cat > /etc/caddy/Caddyfile <<EOF
{
  email $EMAIL
}
$DOMAIN {
  encode gzip
  reverse_proxy 127.0.0.1:4747
}
EOF
systemctl reload caddy || systemctl restart caddy

docker compose up -d --build

# Nightly backup of the data volume to /var/backups/resume-editor (keep 14 days).
cat > /etc/cron.daily/resume-editor-backup <<'EOF'
#!/bin/sh
set -e
mkdir -p /var/backups/resume-editor
docker run --rm -v resume-editor_resume-data:/data:ro -v /var/backups/resume-editor:/out alpine \
  tar czf "/out/data-$(date +%F).tgz" -C /data .
find /var/backups/resume-editor -name 'data-*.tgz' -mtime +14 -delete
EOF
chmod +x /etc/cron.daily/resume-editor-backup

echo
echo "Deployed. Visit https://$DOMAIN once DNS points here."
echo "Invite code for sign-up: $(grep ^SIGNUP_CODE= .env | cut -d= -f2-)"
echo "Logs: cd $DIR && docker compose logs -f"
