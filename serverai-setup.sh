#!/usr/bin/env bash
# Server AI setup. Run once from inside the Crown repo on the EC2 box, after git pull:
#   chmod +x serverai-setup.sh && ./serverai-setup.sh
# Requires SERVERAI_DISCORD_TOKEN in /etc/crown/crown.env (add it before running,
# or run this, add the token, then: sudo systemctl restart crown-serverai).
# After future code updates: git pull, then sudo systemctl restart crown-serverai.
set -e

APPDIR="$(pwd)"
echo "==> Setting up Server AI from $APPDIR"

# data dir for the quota database (same home as crown.db)
sudo mkdir -p /var/lib/crown
sudo chown ec2-user:ec2-user /var/lib/crown

# dependencies (picks up discord.js from package.json)
echo "==> Installing dependencies"
npm install --omit=dev

# systemd service, same pattern as the crown backend
echo "==> Installing systemd service"
sudo tee /etc/systemd/system/crown-serverai.service >/dev/null <<EOF
[Unit]
Description=Server AI (Eclipse-X Discord assistant)
After=network.target

[Service]
WorkingDirectory=$APPDIR
EnvironmentFile=/etc/crown/crown.env
ExecStart=/usr/bin/node $APPDIR/server_ai.js
Restart=always
RestartSec=3
User=ec2-user

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable --now crown-serverai
sudo systemctl restart crown-serverai

echo ""
echo "==> Done. Checks:"
sudo systemctl is-active crown-serverai && echo "    server ai: running"
echo "    live logs: sudo journalctl -u crown-serverai -f"
