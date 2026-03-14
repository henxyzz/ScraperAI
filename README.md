# SmartScrapeAI v4.0

AI-powered web scraper generator dengan fitur:
- 🧠 **AI Module Recommendations** — AI analisa site dan rekomendasikan library paling cocok
- ⚡ **Auto Install** — Install dependencies langsung dari UI dengan 1 klik
- 🔌 **Try Output → API Route** — Output scraper bisa dijadikan API endpoint (`/api/generated/:category/:name`)
- 📚 **Frontend API Docs** — Docs lengkap semua endpoint termasuk generated routes
- 🛠️ **Auto Fix Engine** — AI auto-fix error kode scraper
- 📱 **Responsive Mobile** — UI responsif untuk HP dan Desktop
- 🔥 **Multi-provider** — Anthropic, OpenAI, Groq, Gemini, DeepSeek, Mistral, xAI, Together

## Quick Start

```bash
# 1. Install dependencies
npm install
cd client && npm install && cd ..

# 2. Copy env
cp .env.example .env

# 3. Dev mode (server + vite)
npm run dev:all

# 4. Production build
npm run build && npm start
```

## Environment Variables

```env
PORT=8080
NODE_ENV=development
```

## API Endpoints v4

| Method | Path | Keterangan |
|--------|------|-----------|
| GET | /health | Health check |
| POST | /api/analyze | Analisa URL + rekomendasi module AI |
| POST | /api/generate | Generate kode scraper |
| POST | /api/scraper/:id/install | Auto install dependencies |
| GET | /api/routes | Semua generated API routes |
| POST | /api/scraper/:id/routes | Buat API route baru dari Try Output |
| GET | /api/generated/:category/:name | Endpoint yang di-generate |
| POST | /api/scraper/:id/fix | AI auto-fix error |
| GET | /api/docs | API documentation |

## Fitur v4 Baru

### AI Module Recommendations
Saat analisa URL, AI secara otomatis mendeteksi:
- Tipe site (ecommerce, news, social, dll)
- Kompleksitas scraping (simple/moderate/complex)
- Library terbaik untuk Node.js, Python, PHP
- Jika perlu bypass Cloudflare/WAF atau tidak

### Try Output → API Route
1. Generate scraper
2. Klik "Run Try Output" 
3. Centang "Jadikan API Route"
4. Set kategori & nama route
5. Auto tersimpan di `/api/generated/kategori/nama`

### Auto Install
Klik "Auto Install Modules" di Step 3 — sistem langsung install package yang direkomendasi AI.
