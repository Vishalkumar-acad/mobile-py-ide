#!/usr/bin/env bash
#
# Mobile Py IDE — one-shot bootstrap for a fresh Ubuntu / Debian VPS.
#
# What it does:
#   1. installs base packages + Node.js 20 (if missing)
#   2. creates a low-privilege service user
#   3. clones (or updates) the app into /opt/mobile-py-ide
#   4. writes a .env with sane defaults
#   5. installs + starts a hardened systemd service
#   6. creates a swap file if the box has none (important on 2 GB RAM)
#   7. optionally sets up nginx as a reverse proxy on port 80
#
# Usage (on the server, as root):
#   curl -fsSL https://raw.githubusercontent.com/Vishalkumar-acad/mobile-py-ide/main/deploy/bootstrap.sh | sudo bash
#
# or, after cloning:
#   sudo bash deploy/bootstrap.sh
#
# Override any setting via env vars, e.g.:
#   sudo PORT=8080 SETUP_NGINX=no bash deploy/bootstrap.sh
#
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/Vishalkumar-acad/mobile-py-ide.git}"
APP_DIR="${APP_DIR:-/opt/mobile-py-ide}"
APP_USER="${APP_USER:-mobilepy}"
NODE_MAJOR="${NODE_MAJOR:-20}"
PORT="${PORT:-3000}"
SWAP_MB="${SWAP_MB:-2048}"
SETUP_NGINX="${SETUP_NGINX:-yes}"
SERVICE_NAME="mobile-py-ide"

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[!]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[x]\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Please run as root (use sudo)."
export DEBIAN_FRONTEND=noninteractive

# --- 1. base packages ---------------------------------------------------
log "Installing base packages"
apt-get update -y
apt-get install -y --no-install-recommends ca-certificates curl git python3 python3-venv python3-pip

# --- 2. Node.js ---------------------------------------------------------
need_node=1
if command -v node >/dev/null 2>&1; then
  cur="$(node -v | sed 's/^v//; s/\..*//')"
  if [ "${cur:-0}" -ge "$NODE_MAJOR" ] 2>/dev/null; then need_node=0; fi
fi
if [ "$need_node" -eq 1 ]; then
  log "Installing Node.js ${NODE_MAJOR}.x"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y nodejs
else
  log "Node.js $(node -v) already present"
fi
command -v node >/dev/null 2>&1 || die "Node.js install failed."
command -v python3 >/dev/null 2>&1 || die "python3 is required but missing."

# --- 3. service user ----------------------------------------------------
if ! id -u "$APP_USER" >/dev/null 2>&1; then
  log "Creating service user '$APP_USER'"
  useradd --system --create-home --shell /usr/sbin/nologin "$APP_USER"
fi

# --- 4. code ------------------------------------------------------------
if [ -d "$APP_DIR/.git" ]; then
  log "Updating existing checkout in $APP_DIR"
  git -C "$APP_DIR" fetch --depth 1 origin main
  git -C "$APP_DIR" reset --hard origin/main
else
  log "Cloning into $APP_DIR"
  mkdir -p "$APP_DIR"
  git clone --depth 1 "$REPO_URL" "$APP_DIR"
fi
chown -R "$APP_USER:$APP_USER" "$APP_DIR"

# --- 4b. virtual environment (this is where pip installs go) ------------
VENV_PY="python3"
if python3 -m venv "$APP_DIR/venv" >/dev/null 2>&1; then
  log "Created virtual environment at $APP_DIR/venv"
  "$APP_DIR/venv/bin/pip" install --upgrade pip >/dev/null 2>&1 || true
  VENV_PY="$APP_DIR/venv/bin/python3"
  chown -R "$APP_USER:$APP_USER" "$APP_DIR/venv"
else
  warn "Could not create a virtual environment; falling back to the system python3."
fi

# --- 5. env file --------------------------------------------------------
if [ ! -f "$APP_DIR/.env" ]; then
  log "Writing $APP_DIR/.env"
  cat > "$APP_DIR/.env" <<EOF
HOST=127.0.0.1
PORT=${PORT}
TIMEOUT_MS=5000
MEMORY_LIMIT_MB=128
MAX_CONCURRENT_RUNS=2
MAX_QUEUE=8
STRICT_MODE=false
PYTHON_BIN=${VENV_PY}
EOF
else
  log "$APP_DIR/.env already exists, leaving it untouched"
  if ! grep -q '^PYTHON_BIN=' "$APP_DIR/.env"; then
    echo "PYTHON_BIN=${VENV_PY}" >> "$APP_DIR/.env"
    log "Added PYTHON_BIN=${VENV_PY} to the existing .env"
  fi
fi
chown "$APP_USER:$APP_USER" "$APP_DIR/.env"

# --- 6. systemd service -------------------------------------------------
log "Installing systemd unit /etc/systemd/system/${SERVICE_NAME}.service"
cat > "/etc/systemd/system/${SERVICE_NAME}.service" <<EOF
[Unit]
Description=Mobile Py IDE (sandboxed web Python runner)
After=network.target

[Service]
Type=simple
User=${APP_USER}
Group=${APP_USER}
WorkingDirectory=${APP_DIR}
EnvironmentFile=-${APP_DIR}/.env
ExecStart=$(command -v node) server/app.js
Restart=on-failure
RestartSec=2

# --- hardening ---
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/tmp
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
MemoryMax=512M
TasksMax=64

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now "$SERVICE_NAME"

# --- 7. swap ------------------------------------------------------------
if [ "${SWAP_MB}" -gt 0 ]; then
  if [ "$(swapon --show=NAME --noheadings 2>/dev/null | wc -l)" -eq 0 ] && [ ! -f /swapfile ]; then
    log "Creating ${SWAP_MB} MB swap file"
    fallocate -l "${SWAP_MB}M" /swapfile 2>/dev/null || dd if=/dev/zero of=/swapfile bs=1M count="${SWAP_MB}" status=none
    chmod 600 /swapfile
    mkswap /swapfile >/dev/null
    swapon /swapfile
    grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  else
    log "Swap already configured, skipping"
  fi
fi

# --- 8. nginx -----------------------------------------------------------
if [ "$SETUP_NGINX" = "yes" ]; then
  log "Configuring nginx reverse proxy on port 80"
  apt-get install -y --no-install-recommends nginx
  cat > "/etc/nginx/sites-available/${SERVICE_NAME}" <<EOF
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;
    client_max_body_size 1m;

    location / {
        proxy_pass http://127.0.0.1:${PORT};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 15s;
    }
}
EOF
  ln -sf "/etc/nginx/sites-available/${SERVICE_NAME}" "/etc/nginx/sites-enabled/${SERVICE_NAME}"
  rm -f /etc/nginx/sites-enabled/default
  nginx -t && systemctl reload nginx
fi

# --- 9. verify ----------------------------------------------------------
sleep 1
log "Health check"
if curl -fsS "http://127.0.0.1:${PORT}/api/health"; then
  echo
  if [ "$SETUP_NGINX" = "yes" ]; then
    log "Done. Open http://<your-server-ip>/ in your phone browser."
  else
    log "Done. Open http://<your-server-ip>:${PORT}/ in your phone browser."
  fi
  log "Logs: journalctl -u ${SERVICE_NAME} -f"
else
  warn "Health check failed. Inspect with: journalctl -u ${SERVICE_NAME} -e"
  exit 1
fi
