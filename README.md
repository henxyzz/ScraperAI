# SmartScrapeAI v3.0

AI-Powered Web Scraper Generator dengan Multi-Provider AI, React + TypeScript frontend, dan AI Fix Engine.

## Bug Fixes dari v2 → v3

| Bug | Status |
|-----|--------|
| `registry.getById` tidak ada — semua endpoint scraper crash 500 | FIXED |
| Rate limiter di-import tapi tidak di-setup | FIXED |
| JSZip di-install tapi tidak ada endpoint download ZIP | FIXED |
| Registry in-memory — data hilang saat restart | FIXED (JSON persistence) |
| Frontend HTML 1770 baris monolitik | REPLACED (React + TypeScript) |
| Tidak ada validasi provider API key | ADDED |
| Tidak ada search/filter scraper | ADDED |
| Tidak ada stats endpoint | ADDED |
| Tidak ada export semua scraper ke ZIP | ADDED |
| Tidak ada templates scraper | ADDED |

## Tech Stack

**Backend**
- Node.js + Express
- Multi-provider AI: Anthropic, OpenAI, Groq, Gemini, DeepSeek, Mistral, xAI, Together
- JSON file persistence (`data/scrapers.json`)
- Rate limiting per-route
- JSZip untuk download paket

**Frontend**
- React 18 + TypeScript
- Vite (dev server + build)
- Zustand state management
- Custom syntax highlighter tanpa dependensi besar
- Dark neon terminal aesthetic

## Cara Install & Run

### Development (dengan Vite dev server)

```bash
# Install server dependencies
npm install

# Install client dependencies
cd client && npm install && cd ..

# Jalankan backend + frontend (2 terminal)
npm run dev              # Backend: http://localhost:8080
cd client && npm run dev # Frontend: http://localhost:5173
```

Frontend dev server (port 5173) otomatis proxy `/api` ke backend (port 8080).

### Production

```bash
# Build React frontend
npm run build   # atau: cd client && npm run build

# Start server (serves React build + API)
NODE_ENV=production npm start
```

### Docker

```bash
docker-compose up -d
```

## Fitur

- **4-step Generator**: URL → AI Analisa → Konfigurasi → Kode siap pakai
- **Firewall Detection**: Otomatis deteksi Cloudflare, WAF, bot protection
- **Bypass Mode**: Puppeteer stealth (Node.js) / cloudscraper (Python)
- **3 Bahasa**: Node.js, Python, PHP
- **AI Fix Engine**: Analisa error + 4 fix mode (auto/patch/rewrite/enhance)
- **Version History**: Riwayat setiap kali fix diterapkan + revert
- **Manual Edit**: Edit kode via instruksi bahasa natural ke AI
- **Download**: File langsung, atau ZIP (kode + requirements + README)
- **Export All**: Download semua scraper sebagai satu ZIP
- **API Docs**: Auto-generated docs dari semua scraper yang dibuat
- **Persistence**: Data tersimpan ke `data/scrapers.json`, tidak hilang saat restart

## API Endpoints

| Method | Path | Deskripsi |
|--------|------|-----------|
| GET | /health | Health check |
| POST | /api/validate | Validasi API key provider |
| POST | /api/analyze | Analisa URL + deteksi firewall |
| POST | /api/generate | Generate kode scraper |
| GET | /api/scrapers | Daftar semua scraper |
| GET | /api/scrapers/stats | Statistik scrapers |
| GET | /api/scrapers/search | Cari scraper |
| GET | /api/templates | Template scraper tersedia |
| GET | /api/export/zip | Export semua scraper ke ZIP |
| GET | /api/scraper/:id | Detail scraper |
| GET | /api/scraper/:id/download | Download file kode |
| GET | /api/scraper/:id/zip | Download ZIP |
| GET | /api/scraper/:id/history | Riwayat versi |
| POST | /api/scraper/:id/fix | AI auto-fix |
| POST | /api/scraper/:id/apply | Terapkan fix |
| POST | /api/scraper/:id/revert | Revert ke versi sebelumnya |
| POST | /api/scraper/:id/edit | Edit via instruksi AI |
| DELETE | /api/scraper/:id | Hapus scraper |

---
Copyright 2025 henhendrazat — SmartScrapeAI v3.0
