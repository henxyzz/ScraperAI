# ═══════════════════════════════════════════════════════════
#  SmartScrapeAI v2.0 — Dockerfile
#  Node.js 20 + Python 3 + PHP 8 + Chromium (untuk bypass CF)
# ═══════════════════════════════════════════════════════════

FROM node:20-bookworm-slim

LABEL maintainer="SmartScrapeAI"
LABEL description="SmartScrapeAI v2.0 — AI-Powered Scraper Generator"

# ── Set timezone Jakarta ──
ENV TZ=Asia/Jakarta
ENV NODE_ENV=production
ENV PORT=8080

# ── Hapus interaktif prompt ──
ENV DEBIAN_FRONTEND=noninteractive

# ── Install sistem deps ──
RUN apt-get update && apt-get install -y --no-install-recommends \
    # Python
    python3 \
    python3-pip \
    python3-venv \
    # PHP
    php \
    php-cli \
    php-curl \
    php-mbstring \
    php-xml \
    php-zip \
    php-json \
    # PHP Composer
    composer \
    # Tools
    curl \
    wget \
    git \
    unzip \
    ca-certificates \
    gnupg \
    # Chromium untuk Puppeteer bypass CF
    chromium \
    chromium-sandbox \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxkbcommon0 \
    libxrandr2 \
    xdg-utils \
    && rm -rf /var/lib/apt/lists/*

# ── Puppeteer: pakai Chromium sistem bukan download sendiri ──
ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# ── Install Python packages global ──
RUN pip3 install --no-cache-dir --break-system-packages \
    cloudscraper \
    beautifulsoup4 \
    requests \
    lxml \
    fake-useragent \
    playwright

# ── Setup working directory ──
WORKDIR /app

# ── Copy package.json dulu (cache layer) ──
COPY package.json ./

# ── Install Node.js dependencies ──
RUN npm install --omit=dev && npm cache clean --force

# ── Copy semua source code ──
COPY . .

# ── Buat directory output ──
RUN mkdir -p /app/scrapers /app/api

# ── Set permission ──
RUN chmod -R 755 /app

# ── Non-root user untuk keamanan ──
RUN groupadd -r scraper && useradd -r -g scraper -G audio,video scraper \
    && chown -R scraper:scraper /app
USER scraper

# ── Expose port ──
EXPOSE 8080

# ── Health check ──
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD curl -f http://localhost:8080/health || exit 1

# ── Start ──
CMD ["node", "server.js"]
