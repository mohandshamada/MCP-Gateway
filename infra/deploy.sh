#!/bin/bash
# MCP Gateway Deployment Script for Digital Ocean
# Run this script on a fresh Ubuntu 22.04+ server

set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Configuration
INSTALL_DIR="/opt/mcp-gateway"
CONFIG_DIR="/etc/mcp-gateway"
SERVICE_USER="mcpgateway"
DOMAIN="${MCP_DOMAIN:-mcp.yourdomain.com}"
GATEWAY_TOKEN="${MCP_GATEWAY_TOKEN:-}"

echo "=== MCP Gateway Deployment Script ==="
echo "Install directory: ${INSTALL_DIR}"
echo "Config directory: ${CONFIG_DIR}"
echo "Domain: ${DOMAIN}"

# Check if running as root
if [[ $EUID -ne 0 ]]; then
   echo -e "${RED}This script must be run as root${NC}"
   exit 1
fi

# Check for port conflicts
check_port_conflicts() {
    echo "=== Checking for port conflicts ==="
    local conflicts=0

    if ss -tuln | grep -q ':80 '; then
        echo -e "${YELLOW}WARNING: Port 80 is already in use${NC}"
        local process_80=$(ss -tlnp | grep ':80 ' | head -1)
        echo "  $process_80"
        conflicts=1
    fi

    if ss -tuln | grep -q ':443 '; then
        echo -e "${YELLOW}WARNING: Port 443 is already in use${NC}"
        local process_443=$(ss -tlnp | grep ':443 ' | head -1)
        echo "  $process_443"
        conflicts=1
    fi

    if [[ $conflicts -eq 1 ]]; then
        echo ""
        echo -e "${YELLOW}Detected services that may conflict with Caddy:${NC}"

        # Check for common web servers
        if systemctl is-active --quiet nginx 2>/dev/null; then
            echo "  - nginx is running"
            read -p "Stop and disable nginx? [y/N]: " stop_nginx
            if [[ "$stop_nginx" =~ ^[Yy]$ ]]; then
                systemctl stop nginx
                systemctl disable nginx
                echo -e "${GREEN}nginx stopped and disabled${NC}"
            fi
        fi

        if systemctl is-active --quiet apache2 2>/dev/null; then
            echo "  - apache2 is running"
            read -p "Stop and disable apache2? [y/N]: " stop_apache
            if [[ "$stop_apache" =~ ^[Yy]$ ]]; then
                systemctl stop apache2
                systemctl disable apache2
                echo -e "${GREEN}apache2 stopped and disabled${NC}"
            fi
        fi
    fi

    echo ""
}

check_port_conflicts

# Update system
echo "=== Updating system packages ==="
apt-get update
apt-get upgrade -y

# Install Node.js 20
echo "=== Installing Node.js 20 ==="
if ! command -v node &> /dev/null; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
fi

node --version
npm --version

# Install Caddy
echo "=== Installing Caddy ==="
if ! command -v caddy &> /dev/null; then
    apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
    apt-get update
    apt-get install -y caddy
fi

caddy version

# Create service user
echo "=== Creating service user ==="
if ! id "${SERVICE_USER}" &>/dev/null; then
    useradd --system --shell /bin/false --home-dir "${INSTALL_DIR}" "${SERVICE_USER}"
fi

# Create installation and config directories
echo "=== Setting up directories ==="
mkdir -p "${INSTALL_DIR}"
mkdir -p "${INSTALL_DIR}/config"
mkdir -p "${INSTALL_DIR}/logs"
mkdir -p "${CONFIG_DIR}"
mkdir -p "${CONFIG_DIR}/backups"
mkdir -p /var/log/caddy
mkdir -p /var/lib/mcp-gateway

# Copy application files (assumes they're in the current directory)
echo "=== Copying application files ==="
if [[ -d "dist" ]]; then
    cp -r dist "${INSTALL_DIR}/"
    cp package*.json "${INSTALL_DIR}/"
    cp -r config/*.json "${INSTALL_DIR}/config/" 2>/dev/null || true
    cp config/*.example "${INSTALL_DIR}/config/" 2>/dev/null || true
else
    echo "Warning: dist directory not found. Make sure to build the application first."
    echo "Run 'npm run build' before deploying."
fi

# Install production dependencies
echo "=== Installing production dependencies ==="
cd "${INSTALL_DIR}"
npm ci --only=production

# Pre-install common MCP servers locally to avoid npx permission issues
echo "=== Pre-installing MCP servers ==="
npm install --save \
    @modelcontextprotocol/server-memory \
    @modelcontextprotocol/server-filesystem \
    @modelcontextprotocol/server-github \
    @modelcontextprotocol/server-fetch \
    2>/dev/null || echo "Some MCP servers failed to install, they can be added later"

# Generate token if not provided
if [[ -z "${GATEWAY_TOKEN}" ]]; then
    GATEWAY_TOKEN="sk-$(openssl rand -hex 32)"
    echo "Generated new gateway token: ${GATEWAY_TOKEN}"
fi

# Create secrets file
echo "=== Creating secrets file ==="
cat > "${INSTALL_DIR}/config/secrets.env" << EOF
# MCP Gateway Secrets - Generated on $(date)
MCP_GATEWAY_TOKEN=${GATEWAY_TOKEN}
# Add additional secrets below:
# GITHUB_TOKEN=ghp_xxx
# BRAVE_API_KEY=BSA_xxx
EOF
chmod 600 "${INSTALL_DIR}/config/secrets.env"

# Create production config if it doesn't exist
echo "=== Creating production configuration ==="
if [[ ! -f "${CONFIG_DIR}/gateway.json" ]]; then
    cat > "${CONFIG_DIR}/gateway.json" << 'CONFIGEOF'
{
  "gateway": {
    "host": "127.0.0.1",
    "port": 3000,
    "name": "MCP Gateway",
    "version": "1.0.0"
  },
  "auth": {
    "enabled": true,
    "tokens": []
  },
  "servers": [
    {
      "id": "memory",
      "transport": "stdio",
      "command": "node",
      "args": ["/opt/mcp-gateway/node_modules/@modelcontextprotocol/server-memory/dist/index.js"],
      "enabled": true,
      "lazyLoad": false,
      "timeout": 60000,
      "maxRetries": 3
    }
  ],
  "settings": {
    "requestTimeout": 60000,
    "enableHealthChecks": true,
    "healthCheckInterval": 30000,
    "enableHotReload": true,
    "sessionTimeout": 3600000,
    "enableRateLimiting": true,
    "rateLimit": {
      "windowMs": 60000,
      "maxRequests": 100
    }
  }
}
CONFIGEOF
fi

# Create symlink so gateway loads config from /etc
echo "=== Setting up config symlink ==="
ln -sf "${CONFIG_DIR}/gateway.json" "${INSTALL_DIR}/config/gateway.json"

# Create Caddy configuration
echo "=== Configuring Caddy ==="
cat > /etc/caddy/Caddyfile << EOF
${DOMAIN} {
    reverse_proxy 127.0.0.1:3000 {
        flush_interval -1
        header_up Host {host}
        header_up X-Real-IP {remote_host}
        header_up X-Forwarded-For {remote_host}
        header_up X-Forwarded-Proto {scheme}
    }

    header {
        X-Frame-Options "DENY"
        X-XSS-Protection "1; mode=block"
        X-Content-Type-Options "nosniff"
        Referrer-Policy "strict-origin-when-cross-origin"
        -Server
    }

    log {
        output file /var/log/caddy/mcp-gateway.log {
            roll_size 10mb
            roll_keep 5
        }
        format json
    }
}
EOF

# Create systemd service
echo "=== Creating systemd service ==="
cat > /etc/systemd/system/mcp-gateway.service << EOF
[Unit]
Description=MCP Gateway - Federated MCP Server Aggregation Service
After=network.target

[Service]
Type=simple
User=${SERVICE_USER}
Group=${SERVICE_USER}
WorkingDirectory=${INSTALL_DIR}
Environment=NODE_ENV=production
Environment=LOG_LEVEL=info
Environment=CONFIG_PATH=${INSTALL_DIR}/config/gateway.json
EnvironmentFile=-${INSTALL_DIR}/config/secrets.env
ExecStart=/usr/bin/node ${INSTALL_DIR}/dist/index.js
Restart=always
RestartSec=10
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=${INSTALL_DIR}/logs
StandardOutput=journal
StandardError=journal
SyslogIdentifier=mcp-gateway
TimeoutStopSec=30

[Install]
WantedBy=multi-user.target
EOF

# Set permissions
echo "=== Setting permissions ==="
chown -R "${SERVICE_USER}:${SERVICE_USER}" "${INSTALL_DIR}"
chown -R "${SERVICE_USER}:${SERVICE_USER}" "${CONFIG_DIR}"
chown -R "${SERVICE_USER}:${SERVICE_USER}" /var/lib/mcp-gateway
chown -R caddy:caddy /var/log/caddy

# Configure firewall
echo "=== Configuring firewall ==="
if command -v ufw &> /dev/null; then
    ufw allow 80/tcp
    ufw allow 443/tcp
    ufw allow 22/tcp
    ufw --force enable
fi

# Reload systemd and start services
echo "=== Starting services ==="
systemctl daemon-reload
systemctl enable mcp-gateway
systemctl enable caddy
systemctl restart mcp-gateway
systemctl restart caddy

# Wait for services to start
sleep 5

# Check status
echo ""
echo "=== Deployment Complete ==="
echo ""
systemctl status mcp-gateway --no-pager || true
echo ""
systemctl status caddy --no-pager || true
echo ""
echo "=== Configuration ==="
echo "Gateway URL: https://${DOMAIN}"
echo "Gateway Token: ${GATEWAY_TOKEN}"
echo ""
echo "Test with:"
echo "  curl -H 'Authorization: Bearer ${GATEWAY_TOKEN}' https://${DOMAIN}/admin/health"
echo ""
echo "View logs with:"
echo "  journalctl -u mcp-gateway -f"
echo ""
echo "IMPORTANT: Save your gateway token securely!"
