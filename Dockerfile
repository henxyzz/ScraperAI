# ══════════════════════════════════════════════════════════
#  SmartScrapeAI v4 — Dockerfile (Clever Cloud / Docker)
#  Env vars (PORT, ADMIN_USER, ADMIN_PASS, etc.) diinjek
#  oleh platform di runtime — tidak perlu .env file.
# ══════════════════════════════════════════════════════════
FROM node:20-alpine

# Install build deps (untuk native npm modules)
RUN apk add --no-cache python3 make g++

WORKDIR /app

# ── Install root dependencies ───────────────────────────
COPY package.json ./
RUN npm install --production

# ── Build React frontend ────────────────────────────────
COPY client/package.json ./client/
RUN cd client && npm install

COPY client/ ./client/
RUN cd client && npm run build && npm prune --production

# ── Copy server files ────────────────────────────────────
COPY server.js ./
COPY api/ ./api/
COPY .env.example ./.env.example

# ── Data directory (scraper registry) ───────────────────
RUN mkdir -p /app/data && chmod 777 /app/data

# ── Expose port ─────────────────────────────────────────
EXPOSE 8080

# ── Default env (overridable via platform env vars) ─────
# Clever Cloud / Railway / Render akan override via ENV panel
ENV NODE_ENV=production

# ── Healthcheck ─────────────────────────────────────────
HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
  CMD wget -q -O- http://localhost:${PORT:-8080}/health | grep -q '"status":"ok"' || exit 1

CMD ["node", "server.js"]
