# Build stage
FROM node:20-slim AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci

# Copy source code
COPY tsconfig.json ./
COPY src/ ./src/

# Build the application
RUN npm run build

# Production stage
FROM node:20-slim AS production

# Create non-root user for security
RUN groupadd -r mcpgateway && useradd -r -g mcpgateway mcpgateway

WORKDIR /app

# Copy package files and install production dependencies only
COPY package*.json ./
RUN npm ci --only=production && npm cache clean --force

# Copy built application
COPY --from=builder /app/dist ./dist

# Copy config directory structure
COPY config/ ./config/

# Set ownership
RUN chown -R mcpgateway:mcpgateway /app

# Switch to non-root user
USER mcpgateway

# Environment variables
ENV NODE_ENV=production
ENV LOG_LEVEL=info
ENV CONFIG_PATH=/app/config/gateway.json

# Expose port (internal only, behind reverse proxy)
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/admin/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

# Start the application
CMD ["node", "dist/index.js"]
