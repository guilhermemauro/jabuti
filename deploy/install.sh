#!/bin/sh
# Installs Jabuti on a fresh Ubuntu or Debian server, as root: Docker if missing,
# then deploy/compose.yml in /opt/jabuti. Used as a DigitalOcean Droplet's user data,
# by deploy/aws.yml, or by hand:
#
#   curl -fsSL https://raw.githubusercontent.com/guilhermemauro/jabuti/main/deploy/install.sh | sh
#
# It ends by printing the address to open and the setup code. Run it again to update.
# JABUTI_IP sets the public IP when the server cannot find it out (behind NAT).
set -eu

REPO=https://raw.githubusercontent.com/guilhermemauro/jabuti/main
DIR=/opt/jabuti

if [ "$(id -u)" != 0 ]; then
  echo "Run as root (sudo sh)." >&2
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "Installing Docker…"
  curl -fsSL https://get.docker.com | sh
fi

mkdir -p "$DIR"
cd "$DIR"
curl -fsSL "$REPO/deploy/compose.yml" -o compose.yml
docker compose pull
docker compose up -d

# The address: the public IP, as its sslip.io name.
IP=${JABUTI_IP:-$(curl -fsS --max-time 10 https://checkip.amazonaws.com || true)}
IP=$(printf '%s' "$IP" | tr -d '[:space:]')

# The setup code appears in the log once the server is up; none means already claimed.
CODE=""
i=0
while [ $i -lt 60 ] && [ -z "$CODE" ]; do
  CODE=$(docker compose logs jabuti 2>/dev/null | sed 's/\x1b\[[0-9;]*m//g' |
    grep -o 'setup code *[A-Z0-9]\{4\}-[A-Z0-9]\{4\}' | tail -n 1 | grep -o '[A-Z0-9]\{4\}-[A-Z0-9]\{4\}' || true)
  if docker compose logs jabuti 2>/dev/null | grep -q "Jabuti on http" && [ -z "$CODE" ]; then break; fi
  i=$((i + 1))
  sleep 2
done

echo
echo "Jabuti is running."
if [ -n "$IP" ]; then
  echo "  Open:        https://$(printf '%s' "$IP" | tr . -).sslip.io"
else
  echo "  Open:        https://<this server's IP, dots as dashes>.sslip.io"
fi
if [ -n "$CODE" ]; then
  echo "  Setup code:  $CODE   (set the owner password now: until then, the code claims it)"
else
  echo "  Setup code:  none. Already claimed, or still starting: cd $DIR && docker compose logs jabuti"
fi
echo "  Then:        Settings → Domain, to use a domain of your own."
echo "  Update:      run this script again."
