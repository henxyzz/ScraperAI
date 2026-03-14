# 🤖 SmartScrapeAI v2.0

> **AI-Powered Web Scraper Generator** — Multi Provider AI, Auto Firewall Detection, Cloudflare Bypass, ZIP Download + Panduan Termux

---

## ✨ Fitur Utama

| Fitur | Keterangan |
|-------|-----------|
| 🤖 **Multi AI Provider** | Anthropic Claude, OpenAI, Groq, Gemini, DeepSeek, Mistral, xAI Grok |
| 🛡️ **Auto Detect Firewall** | Deteksi Cloudflare, WAF, Bot Protection otomatis via header check |
| 🔓 **Bypass Cloudflare** | puppeteer-extra-stealth / cloudscraper / cURL full headers |
| 💻 **3 Bahasa Output** | Node.js, Python, PHP |
| 🧪 **Debug Try Panel** | Input form otomatis sesuai website (TikTok, IG, dll) |
| 📦 **Download ZIP** | Kode + package.json/requirements + README + run.sh |
| 📋 **API Docs** | `/api/docs` — auto-register semua scraper yang dibuat |
| 🐳 **Docker Ready** | Node.js 20 + Python 3 + PHP 8 + Chromium dalam satu container |

---

## 🚀 Cara Run

### Option 1: Docker (Recommended)

```bash
# Build & Run
docker-compose up -d

# Atau manual
docker build -t smartscrapeai .
docker run -p 8080:8080 smartscrapeai
```

Buka: http://localhost:8080

---

### Option 2: Node.js Langsung

**Requirements:** Node.js 18+

```bash
# Install dependencies
npm install

# Copy .env
cp .env.example .env

# Jalankan
node server.js
```

---

### Option 3: Termux (Android)

```bash
# 1. Update Termux
pkg update && pkg upgrade -y

# 2. Install Node.js
pkg install -y nodejs-lts

# 3. (Opsional) Install Python & PHP
pkg install -y python python-pip php

# 4. Clone / extract project
cd SmartScrapeAI

# 5. Install dependencies
npm install

# 6. Jalankan
node server.js
```

Buka browser: http://localhost:8080

---

## 📋 API Endpoints

| Method | Endpoint | Keterangan |
|--------|----------|-----------|
| GET  | `/`                         | Frontend UI |
| GET  | `/health`                   | Health check |
| POST | `/api/analyze`              | Analisa URL + deteksi firewall |
| POST | `/api/generate`             | Generate kode scraper |
| GET  | `/api/docs`                 | API documentation (JSON) |
| GET  | `/api/scrapers`             | List semua scraper tersimpan |
| GET  | `/api/scraper/:id`          | Detail scraper by ID |
| GET  | `/api/scraper/:id/download` | Download file kode |
| POST | `/api/scraper/:id/try`      | Debug try request |
| DELETE | `/api/scraper/:id`        | Hapus scraper |

---

## 🔑 AI Providers yang Didukung

| Provider | Model Default | Cara Dapat API Key |
|----------|--------------|---------------------|
| Anthropic Claude | claude-sonnet-4-20250514 | console.anthropic.com |
| OpenAI | gpt-4o | platform.openai.com |
| Groq (Gratis!) | llama3-70b-8192 | console.groq.com |
| Google Gemini | gemini-1.5-flash | aistudio.google.com |
| DeepSeek | deepseek-chat | platform.deepseek.com |
| Mistral | mistral-large-latest | console.mistral.ai |
| xAI Grok | grok-beta | console.x.ai |

---

## 🧪 Contoh API Usage

### Analyze URL
```bash
curl -X POST http://localhost:8080/api/analyze \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://tiktok.com/@user/video/123",
    "provider": "anthropic",
    "apiKey": "sk-ant-...",
    "model": "claude-sonnet-4-20250514"
  }'
```

### Generate Scraper
```bash
curl -X POST http://localhost:8080/api/generate \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://tiktok.com/@user/video/123",
    "target": "URL video CDN",
    "lang": "nodejs",
    "bypassCF": true,
    "provider": "groq",
    "apiKey": "gsk_..."
  }'
```

---

## 📁 Struktur Project

```
SmartScrapeAI/
├── server.js           ← Express server utama
├── package.json
├── Dockerfile
├── docker-compose.yml
├── .env.example
├── README.md
├── api/
│   └── registry.js     ← In-memory scraper registry
└── public/
    └── index.html      ← Frontend UI lengkap
```

---

*SmartScrapeAI v2.0 — Powered by Multi-Provider AI*
