#!/usr/bin/env bash
# Crown — deploy script. Run from inside the cloned Crown repo on the EC2 box:
#   chmod +x deploy.sh && ./deploy.sh
# Re-run any time after `git pull` to push updates live.
set -e

APPDIR="$(pwd)"
echo "==> Deploying Crown from $APPDIR"

# 1. Node.js 20 (only if missing)
if ! command -v node >/dev/null 2>&1; then
  echo "==> Installing Node.js 20"
  curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash -
  sudo dnf install -y nodejs
fi

# 2. Backend dependencies
echo "==> Installing backend dependencies"
npm install --omit=dev

# 3. Backend as a systemd service (reads the secret env file you created separately)
echo "==> Installing systemd service"
sudo tee /etc/systemd/system/crown.service >/dev/null <<EOF
[Unit]
Description=Crown backend
After=network.target

[Service]
WorkingDirectory=$APPDIR
EnvironmentFile=/etc/crown/crown.env
ExecStart=/usr/bin/node $APPDIR/server.js
Restart=always
RestartSec=3
User=ec2-user

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable --now crown
sudo systemctl restart crown

# 4. Publish the static site
echo "==> Publishing static files"
sudo mkdir -p /var/www/crown
sudo cp index.html /var/www/crown/index.html

# 5. nginx: serve the site + proxy /api to the backend
echo "==> Configuring nginx"
# neutralize any stock default_server so ours wins (idempotent)
sudo cp -n /etc/nginx/nginx.conf /etc/nginx/nginx.conf.bak 2>/dev/null || true
sudo sed -i 's/ default_server//g' /etc/nginx/nginx.conf
sudo tee /etc/nginx/conf.d/crown.conf >/dev/null <<'EOF'
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;
    root /var/www/crown;
    index index.html;

    location / { try_files $uri /index.html; }

    location /api/ {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 120s;
    }
}
EOF

sudo nginx -t
sudo systemctl restart nginx

echo ""
echo "==> Done. Checks:"
sudo systemctl is-active crown  && echo "    backend: running"
curl -s http://127.0.0.1:3000/api/health || true
echo ""
echo "==> Visit your site at http://<your-elastic-ip>/"
