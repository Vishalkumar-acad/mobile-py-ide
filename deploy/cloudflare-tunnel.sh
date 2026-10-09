#!/usr/bin/env bash
#
# Mobile Py IDE — connect this server to a Cloudflare Tunnel.
#
# A tunnel lets Cloudflare reach your server without opening ANY inbound
# ports: cloudflared dials out to Cloudflare, and Cloudflare routes
# ide.pixelabs.in to http://localhost:3000. Combine it with a Cloudflare
# Access policy and only you can open the IDE.
#
# Get the token first (one time, in the dashboard):
#   Cloudflare Zero Trust -> Networks -> Tunnels -> Create a tunnel
#   -> Cloudflared -> name it "mobile-py-ide" -> copy the install token
#     (the long string after `cloudflared service install`)
#
# Then on the server:
#   sudo bash deploy/cloudflare-tunnel.sh <TUNNEL_TOKEN>
#
# After that, add a Public Hostname for the tunnel:
#   ide.pixelabs.in  ->  HTTP  ->  localhost:3000
#
set -euo pipefail

TOKEN="${1:-}"
if [ -z "$TOKEN" ]; then
  echo "Usage: sudo bash deploy/cloudflare-tunnel.sh <TUNNEL_TOKEN>" >&2
  exit 1
fi
if [ "$(id -u)" -ne 0 ]; then
  echo "Please run as root (use sudo)." >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive

echo "==> Installing cloudflared"
mkdir -p --mode=0755 /usr/share/keyrings
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg \
  | tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main' \
  > /etc/apt/sources.list.d/cloudflared.list
apt-get update -y
apt-get install -y cloudflared

echo "==> Connecting the tunnel"
# This writes /etc/cloudflared/config.yml and installs a systemd service.
cloudflared service install "$TOKEN"
systemctl enable --now cloudflared

sleep 2
echo "==> Tunnel status"
systemctl --no-pager --full status cloudflared | head -n 15 || true

cat <<'EOF'

Next steps (Cloudflare dashboard):
  1. Zero Trust -> Networks -> Tunnels -> your tunnel -> Public Hostname
       subdomain: ide    domain: pixelabs.in
       service:   HTTP   ->  localhost:3000
  2. Zero Trust -> Access -> Applications -> Add an application
       Self-hosted, domain ide.pixelabs.in
       Policy: Action = Allow, Include = Emails = you@pixelabs.in
     Now only that email can open the IDE.

You can also close inbound ports 80/443 in your AWS security group — the
tunnel needs no inbound access at all.
EOF
