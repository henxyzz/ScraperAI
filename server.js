// ═══════════════════════════════════════════════════════════════
//  SmartScrapeAI Server v4.0
//  v4: AI module recommendations, auto-install, generated API routes,
//      Try Output → API Route, auto-fix error handler, responsive UI
// ═══════════════════════════════════════════════════════════════

require("dotenv").config();
const express           = require("express");
const cors              = require("cors");
const helmet            = require("helmet");
const morgan            = require("morgan");
const path              = require("path");
const fs                = require("fs");
const os                = require("os");
const { v4: uuidv4 }    = require("uuid");
const { exec }          = require("child_process");
const axios             = require("axios");
const rateLimit         = require("express-rate-limit");
const JSZip             = require("jszip");
const registry          = require("./api/registry");

const app     = express();
const PORT    = process.env.PORT || 8080;
const IS_PROD = process.env.NODE_ENV === "production";

// Buat direktori data jika belum ada
const DATA_DIR = path.join(__dirname, "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ── Middleware ────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: IS_PROD ? false : "*" }));
app.use(morgan(IS_PROD ? "combined" : "dev"));
app.use(express.json({ limit: "10mb" }));

// ── Rate Limiting ─────────────────────────────────────────────
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Terlalu banyak request. Coba lagi dalam 15 menit." },
});

const aiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 15,
  message: { error: "Rate limit: max 15 AI request per menit." },
});

app.use("/api/", apiLimiter);
app.use("/api/analyze",        aiLimiter);
app.use("/api/generate",       aiLimiter);
app.use("/api/validate",       aiLimiter);
app.use("/api/scraper/:id/fix",  aiLimiter);
app.use("/api/scraper/:id/edit", aiLimiter);

// ── Static Files ──────────────────────────────────────────────
// Production: serve React build. Development: Vite dev server handle frontend.
if (IS_PROD) {
  const clientDist = path.join(__dirname, "client", "dist");
  if (fs.existsSync(clientDist)) {
    app.use(express.static(clientDist));
    console.log("[server] Serving React build dari client/dist");
  }
}

// ── Default Models (latest per provider) ─────────────────────
const PROVIDER_DEFAULTS = {
  anthropic: "claude-sonnet-4-20250514",
  openai:    "gpt-4o",
  groq:      "llama-3.3-70b-versatile",
  gemini:    "gemini-2.0-flash",
  deepseek:  "deepseek-chat",
  mistral:   "mistral-large-latest",
  xai:       "grok-3",
  together:  "meta-llama/Llama-3.3-70B-Instruct-Turbo",
};

// ── Token Caps (max output tokens per provider/model) ─────────
const PROVIDER_MAX_TOKENS = {
  anthropic: 16000,   // claude-sonnet/opus: up to 64k but 16k safe
  openai:    16384,   // gpt-4o: 16k output
  groq:      32000,   // llama-3.3-70b-versatile: 32768 max
  gemini:    16000,   // gemini-2.0-flash: 8192 default, up to 16k
  deepseek:  16000,   // deepseek-chat v3: up to 16k
  mistral:   16000,   // mistral-large-latest: 16k
  xai:       16000,   // grok-3: 16k output
  together:  16000,   // llama-3.3-70b: 16k
};

// ── Helper: Call AI Provider ──────────────────────────────────
async function callAI({ provider, apiKey, model, system, prompt, maxTokens = null }) {
  const JSON_HDR = { "Content-Type": "application/json" };

  const resolveTokens = (provId, requested) =>
    requested !== null ? requested : (PROVIDER_MAX_TOKENS[provId] || 8192);

  const resolveModel = (provId, requested) =>
    (requested && requested.trim()) ? requested.trim() : PROVIDER_DEFAULTS[provId];

  // ── Anthropic Claude ──────────────────────────────────────
  if (provider === "anthropic") {
    const tokens = resolveTokens("anthropic", maxTokens);
    const mdl    = resolveModel("anthropic", model);
    const body   = {
      model:      mdl,
      max_tokens: tokens,
      messages:   [{ role: "user", content: prompt }],
    };
    // system hanya dikirim jika ada isinya
    if (system && system.trim()) body.system = system.trim();

    const res = await axios.post(
      "https://api.anthropic.com/v1/messages", body,
      {
        headers: { ...JSON_HDR, "x-api-key": apiKey.trim(), "anthropic-version": "2023-06-01" },
        timeout: 150000,
      }
    );
    return res.data.content?.[0]?.text || "";
  }

  // ── OpenAI ────────────────────────────────────────────────
  if (provider === "openai") {
    const tokens = resolveTokens("openai", maxTokens);
    const mdl    = resolveModel("openai", model);
    const msgs   = [];
    if (system && system.trim()) msgs.push({ role: "system", content: system.trim() });
    msgs.push({ role: "user", content: prompt });

    // o1/o3 series tidak support max_tokens — pakai max_completion_tokens
    const isReasoning = /^o[13]/.test(mdl);
    const body = {
      model: mdl,
      messages: msgs,
      [isReasoning ? "max_completion_tokens" : "max_tokens"]: tokens,
    };

    const res = await axios.post(
      "https://api.openai.com/v1/chat/completions", body,
      { headers: { ...JSON_HDR, Authorization: `Bearer ${apiKey.trim()}` }, timeout: 150000 }
    );
    return res.data.choices?.[0]?.message?.content || "";
  }

  // ── Groq ──────────────────────────────────────────────────
  if (provider === "groq") {
    const mdl    = resolveModel("groq", model);
    // Token limit per model Groq
    const MODEL_CAPS = {
      "llama-3.3-70b-versatile":        32768,
      "llama-3.1-70b-versatile":        32768,
      "llama-3.1-8b-instant":           8192,
      "llama3-70b-8192":                8192,
      "llama3-8b-8192":                 8192,
      "mixtral-8x7b-32768":             32768,
      "gemma2-9b-it":                   8192,
      "gemma-7b-it":                    8192,
      "deepseek-r1-distill-llama-70b":  32768,
      "qwen-qwq-32b":                   32768,
    };
    const cap    = MODEL_CAPS[mdl] || 8192;
    const tokens = maxTokens !== null ? Math.min(maxTokens, cap) : cap;
    const msgs   = [];
    if (system && system.trim()) msgs.push({ role: "system", content: system.trim() });
    msgs.push({ role: "user", content: prompt });

    const res = await axios.post(
      "https://api.groq.com/openai/v1/chat/completions",
      { model: mdl, max_tokens: tokens, messages: msgs },
      { headers: { ...JSON_HDR, Authorization: `Bearer ${apiKey.trim()}` }, timeout: 150000 }
    );
    return res.data.choices?.[0]?.message?.content || "";
  }

  // ── Google Gemini ─────────────────────────────────────────
  if (provider === "gemini") {
    const mdl    = resolveModel("gemini", model);
    const tokens = resolveTokens("gemini", maxTokens);

    // Gemini 2.x: gunakan systemInstruction field (bukan concat string)
    const body = {
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: tokens, temperature: 0.2 },
    };
    if (system && system.trim()) {
      body.systemInstruction = { parts: [{ text: system.trim() }] };
    }

    const res = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/${mdl}:generateContent?key=${apiKey.trim()}`,
      body,
      { headers: JSON_HDR, timeout: 150000 }
    );

    // Handle blocked responses
    const candidate = res.data.candidates?.[0];
    if (!candidate) {
      const reason = res.data.promptFeedback?.blockReason || "unknown";
      throw new Error(`Gemini: response diblok (${reason})`);
    }
    return candidate.content?.parts?.[0]?.text || "";
  }

  // ── Mistral ───────────────────────────────────────────────
  if (provider === "mistral") {
    const tokens = resolveTokens("mistral", maxTokens);
    const mdl    = resolveModel("mistral", model);
    const msgs   = [];
    if (system && system.trim()) msgs.push({ role: "system", content: system.trim() });
    msgs.push({ role: "user", content: prompt });

    const res = await axios.post(
      "https://api.mistral.ai/v1/chat/completions",
      { model: mdl, max_tokens: tokens, messages: msgs },
      { headers: { ...JSON_HDR, Authorization: `Bearer ${apiKey.trim()}` }, timeout: 150000 }
    );
    return res.data.choices?.[0]?.message?.content || "";
  }

  // ── xAI Grok ─────────────────────────────────────────────
  if (provider === "xai") {
    const tokens = resolveTokens("xai", maxTokens);
    const mdl    = resolveModel("xai", model);
    const msgs   = [];
    if (system && system.trim()) msgs.push({ role: "system", content: system.trim() });
    msgs.push({ role: "user", content: prompt });

    const res = await axios.post(
      "https://api.x.ai/v1/chat/completions",
      { model: mdl, max_tokens: tokens, messages: msgs },
      { headers: { ...JSON_HDR, Authorization: `Bearer ${apiKey.trim()}` }, timeout: 150000 }
    );
    return res.data.choices?.[0]?.message?.content || "";
  }

  // ── DeepSeek ──────────────────────────────────────────────
  if (provider === "deepseek") {
    const tokens = resolveTokens("deepseek", maxTokens);
    const mdl    = resolveModel("deepseek", model);
    const msgs   = [];
    if (system && system.trim()) msgs.push({ role: "system", content: system.trim() });
    msgs.push({ role: "user", content: prompt });

    const res = await axios.post(
      "https://api.deepseek.com/chat/completions",
      { model: mdl, max_tokens: tokens, messages: msgs },
      { headers: { ...JSON_HDR, Authorization: `Bearer ${apiKey.trim()}` }, timeout: 150000 }
    );
    return res.data.choices?.[0]?.message?.content || "";
  }

  // ── Together AI ───────────────────────────────────────────
  if (provider === "together") {
    const tokens = resolveTokens("together", maxTokens);
    const mdl    = resolveModel("together", model);
    const msgs   = [];
    if (system && system.trim()) msgs.push({ role: "system", content: system.trim() });
    msgs.push({ role: "user", content: prompt });

    const res = await axios.post(
      "https://api.together.xyz/v1/chat/completions",
      { model: mdl, max_tokens: tokens, messages: msgs },
      { headers: { ...JSON_HDR, Authorization: `Bearer ${apiKey.trim()}` }, timeout: 150000 }
    );
    return res.data.choices?.[0]?.message?.content || "";
  }

  throw new Error(`Provider tidak dikenal: ${provider}`);
}

// ── Helper: Detect Firewall ───────────────────────────────────
async function detectFirewall(url) {
  const result = {
    cloudflare:         false,
    waf:                false,
    bot_protection:     false,
    details:            [],
    bypass_recommended: false,
    status_code:        null,
    response_time_ms:   null,
  };

  const cfDomains = [
    "tiktok.com","instagram.com","twitter.com","x.com","facebook.com",
    "shopee","tokopedia","lazada","bukalapak","discord.com","reddit.com",
    "cloudflare.com","medium.com","notion.so","akamai","fastly","linkedin.com",
  ];

  try {
    const parsed = new URL(url);
    const host   = parsed.hostname.toLowerCase();

    for (const d of cfDomains) {
      if (host.includes(d)) {
        result.cloudflare = true;
        result.details.push(`Domain ${host} dikenal menggunakan Cloudflare/WAF`);
        break;
      }
    }

    const t0 = Date.now();
    try {
      const resp = await axios.head(url, {
        timeout: 8000,
        validateStatus: () => true,
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0" },
      });
      result.response_time_ms = Date.now() - t0;
      result.status_code      = resp.status;

      const h = resp.headers;
      if (h["cf-ray"] || h["cf-cache-status"]) {
        result.cloudflare = true;
        result.details.push("Header Cloudflare terdeteksi: cf-ray / cf-cache-status");
      }
      if (h["x-sucuri-id"] || h["x-sucuri-cache"]) {
        result.waf = true;
        result.details.push("WAF Sucuri terdeteksi");
      }
      if (h["x-distil-cs"]) {
        result.bot_protection = true;
        result.details.push("Bot protection Distil/Imperva terdeteksi");
      }
      if (h["server"]?.toLowerCase().includes("cloudflare")) {
        result.cloudflare = true;
        result.details.push("Server header: Cloudflare");
      }
      if (h["x-akamai-transformed"] || h["akamai-origin-hop"]) {
        result.waf = true;
        result.details.push("Akamai CDN/WAF terdeteksi");
      }
      if ([403, 503, 429].includes(resp.status)) {
        result.bot_protection = true;
        result.details.push(`HTTP ${resp.status} — kemungkinan diblok bot protection`);
      }
    } catch (e) {
      result.details.push(`Tidak bisa HEAD request: ${e.message}`);
    }

    result.bypass_recommended = result.cloudflare || result.waf || result.bot_protection;
  } catch (e) {
    result.details.push(`Error parsing URL: ${e.message}`);
  }

  return result;
}

// ── Helper: Build System Prompt ───────────────────────────────
function buildSystemPrompt(lang, bypassCF) {
  const bypass = bypassCF
    ? "PENTING: Website ini dilindungi Cloudflare/WAF! Gunakan teknik bypass lengkap."
    : "Website tidak memerlukan bypass khusus.";

  const SHARED = `
ATURAN TIDAK BOLEH DILANGGAR:
1. Output HANYA kode MENTAH. DILARANG: markdown, backtick, triple quote, penjelasan di luar kode.
2. Kode HARUS LENGKAP dari awal sampai akhir — JANGAN potong dengan "// ... dst" atau placeholder.
3. Setiap fungsi, loop, try/catch HARUS lengkap dengan penutupnya.
4. Jika kode panjang, tetap tulis SELURUHNYA tanpa pengecualian.
5. Komentar dalam bahasa Indonesia di dalam kode boleh, tapi tidak ada teks di luar kode.`;

  const prompts = {
    nodejs: `Kamu adalah senior web scraping engineer expert Node.js. Tulis kode produksi yang lengkap dan bisa langsung dijalankan.
${bypass}
${bypassCF
  ? "Gunakan: puppeteer-extra + puppeteer-extra-plugin-stealth, random user-agent (paket user-agents), delay acak 1500-3000ms."
  : "Gunakan: axios + cheerio untuk scraping statis. Tambahkan retry logic jika request gagal."}
${SHARED}
- Mulai dari baris pertama: // SmartScrapeAI v3 Generated Script
- require() semua library di paling atas
- Fungsi async main() dengan try/catch lengkap
- Output hasil: console.log(JSON.stringify(result, null, 2))
- Akhiri dengan: main().catch(console.error)`,

    python: `Kamu adalah senior web scraping engineer expert Python. Tulis kode produksi yang lengkap dan bisa langsung dijalankan.
${bypass}
${bypassCF
  ? "Gunakan: cloudscraper, fake_useragent.UserAgent(), BeautifulSoup, time.sleep(random.uniform(1.5, 3.0))."
  : "Gunakan: requests + BeautifulSoup4. Tambahkan retry logic dengan requests.adapters.HTTPAdapter."}
${SHARED}
- Mulai dari baris pertama: # SmartScrapeAI v3 Generated Script
- import semua modul di paling atas
- Fungsi main() dengan try/except lengkap
- Output hasil: print(json.dumps(result, indent=2, ensure_ascii=False))
- Akhiri dengan: if __name__ == '__main__': main()`,

    php: `Kamu adalah senior web scraping engineer expert PHP. Tulis kode produksi yang lengkap dan bisa langsung dijalankan.
${bypass}
${bypassCF
  ? "Gunakan cURL dengan header browser lengkap: User-Agent Chrome, Accept, Accept-Language, sleep(rand(1,3))."
  : "Gunakan cURL + DOMDocument + DOMXPath. Tambahkan error handling untuk setiap cURL request."}
${SHARED}
- Mulai dari baris pertama: <?php
- Sertakan semua fungsi helper yang dibutuhkan
- try/catch lengkap
- Output hasil: echo json_encode($result, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);`,
  };

  return prompts[lang];
}

// ── Helper: Build Try Schema ──────────────────────────────────
function buildTrySchema(url, target) {
  const host = (() => { try { return new URL(url).hostname.replace("www.", ""); } catch { return url; } })();
  const schemas = {
    "tiktok.com":    [{ name: "video_url",   label: "URL Video TikTok",    type: "url",    placeholder: "https://www.tiktok.com/@user/video/123", required: true }],
    "instagram.com": [{ name: "post_url",    label: "URL Post Instagram",  type: "url",    placeholder: "https://www.instagram.com/p/XXXXX/", required: true }],
    "youtube.com":   [{ name: "video_url",   label: "URL Video YouTube",   type: "url",    placeholder: "https://www.youtube.com/watch?v=XXXXX", required: true }],
    "twitter.com":   [{ name: "tweet_url",   label: "URL Tweet/Post X",    type: "url",    placeholder: "https://x.com/user/status/XXXXX", required: true }],
    "x.com":         [{ name: "tweet_url",   label: "URL Post X",          type: "url",    placeholder: "https://x.com/user/status/XXXXX", required: true }],
    "shopee.co.id":  [{ name: "product_url", label: "URL Produk Shopee",   type: "url",    placeholder: "https://shopee.co.id/xxx", required: true }, { name: "limit", label: "Jumlah Produk", type: "number", placeholder: "10", required: false }],
    "tokopedia.com": [{ name: "product_url", label: "URL Produk Tokopedia",type: "url",    placeholder: "https://www.tokopedia.com/xxx", required: true }],
    "linkedin.com":  [{ name: "profile_url", label: "URL Profil/Perusahaan",type: "url",   placeholder: "https://www.linkedin.com/in/user", required: true }],
  };

  for (const [domain, schema] of Object.entries(schemas)) {
    if (host.includes(domain)) return schema;
  }

  return [
    { name: "target_url", label: "URL Target Scraping",    type: "url",    placeholder: url, required: true },
    { name: "selector",   label: "CSS Selector (opsional)",type: "text",   placeholder: "div.content, .price, h1", required: false },
    { name: "limit",      label: "Limit hasil (opsional)", type: "number", placeholder: "10", required: false },
  ];
}

// ── Helper: Generate Requirements File ───────────────────────
function generateRequirements(lang, bypassCF) {
  if (lang === "nodejs") {
    const deps = bypassCF
      ? { "puppeteer-extra": "^3.3.6", "puppeteer-extra-plugin-stealth": "^2.11.2", "user-agents": "^1.0.1388", "axios": "^1.7.2", "cheerio": "^1.0.0" }
      : { "axios": "^1.7.2", "cheerio": "^1.0.0" };
    return JSON.stringify({ name: "scraper", version: "1.0.0", dependencies: deps }, null, 2);
  }
  if (lang === "python") {
    const pkgs = bypassCF
      ? "requests\nbeautifulsoup4\ncloudscraper\nfake-useragent\nlxml"
      : "requests\nbeautifulsoup4\nlxml";
    return pkgs;
  }
  if (lang === "php") {
    return `{
  "require": {
    "php": ">=7.4",
    "guzzlehttp/guzzle": "^7.0"
  }
}`;
  }
  return "";
}

// ── Helper: Generate README ───────────────────────────────────
function generateReadme(entry) {
  const extMap  = { nodejs: "js", python: "py", php: "php" };
  const runMap  = { nodejs: `node ${entry.filename}`, python: `python3 ${entry.filename}`, php: `php ${entry.filename}` };
  const depsMap = {
    nodejs: entry.bypassCF ? "npm install puppeteer-extra puppeteer-extra-plugin-stealth user-agents axios cheerio" : "npm install axios cheerio",
    python: entry.bypassCF ? "pip install requests beautifulsoup4 cloudscraper fake-useragent lxml" : "pip install requests beautifulsoup4 lxml",
    php:    "composer install",
  };

  return `# SmartScrapeAI — ${entry.name}

Generated oleh SmartScrapeAI v3.0
Tanggal: ${new Date(entry.createdAt).toLocaleString("id-ID")}

## Info Scraper
- URL Target  : ${entry.url}
- Target Data : ${entry.target}
- Bahasa      : ${entry.lang}
- Bypass CF   : ${entry.bypassCF ? "YA (stealth mode aktif)" : "TIDAK"}
- Provider AI : ${entry.provider} / ${entry.model || "default"}

## Cara Pakai

### 1. Install dependencies
\`\`\`
${depsMap[entry.lang]}
\`\`\`

### 2. Jalankan scraper
\`\`\`
${runMap[entry.lang]}
\`\`\`

## Catatan
- Scraper ini di-generate secara otomatis oleh AI
- Test di lokal/server/VPS sebelum deployment
- Jika ada error, gunakan fitur Fix Engine di SmartScrapeAI
- Copyright ${new Date().getFullYear()} henhendrazat — SmartScrapeAI
`;
}

// ══════════════════════════════════════════════════════════════
//  ROUTES
// ══════════════════════════════════════════════════════════════

// Health check
app.get("/health", (req, res) => {
  res.json({
    status:    "ok",
    version:   "3.0.0",
    timestamp: new Date().toISOString(),
    uptime:    process.uptime(),
    scrapers:  registry.count(),
    memory:    process.memoryUsage(),
  });
});

// ── GET /api/scrapers/stats ───────────────────────────────────
app.get("/api/scrapers/stats", (req, res) => {
  res.json({ success: true, stats: registry.stats() });
});

// ── GET /api/scrapers/search ──────────────────────────────────
app.get("/api/scrapers/search", (req, res) => {
  const { q, lang, provider } = req.query;
  let results = registry.getAll();
  if (q)        results = results.filter(s => s.name.includes(q) || s.url.includes(q) || s.target.toLowerCase().includes(q.toLowerCase()));
  if (lang)     results = results.filter(s => s.lang === lang);
  if (provider) results = results.filter(s => s.provider === provider);
  res.json({ success: true, count: results.length, scrapers: results });
});

// ── GET /api/templates ────────────────────────────────────────
app.get("/api/templates", (req, res) => {
  const templates = [
    { id: "ecommerce-product",  name: "E-Commerce Product", description: "Scrape nama, harga, rating, stok produk dari marketplace", lang: "nodejs", target: "nama produk, harga, rating, jumlah review, stok, URL gambar utama", example_url: "https://www.tokopedia.com/product-page" },
    { id: "news-article",       name: "News Article",       description: "Ekstrak judul, konten, author, tanggal artikel berita",     lang: "python", target: "judul artikel, konten lengkap, nama penulis, tanggal publish, kategori, tags", example_url: "https://www.detik.com/artikel" },
    { id: "social-profile",     name: "Social Profile",     description: "Ambil info profil dari media sosial",                       lang: "nodejs", target: "username, bio, jumlah followers, following, post count, avatar URL", example_url: "https://www.instagram.com/user" },
    { id: "job-listing",        name: "Job Listing",        description: "Kumpulkan data lowongan kerja",                             lang: "python", target: "judul pekerjaan, perusahaan, lokasi, gaji, requirements, tanggal post", example_url: "https://www.linkedin.com/jobs" },
    { id: "real-estate",        name: "Real Estate",        description: "Data properti: harga, spesifikasi, lokasi",                 lang: "nodejs", target: "harga properti, tipe, luas tanah, luas bangunan, lokasi, fasilitas, URL foto", example_url: "https://www.rumah123.com/properti" },
    { id: "product-catalog",    name: "Product Catalog",    description: "Katalog produk lengkap dari toko online",                   lang: "php",    target: "semua produk dengan nama, SKU, harga, deskripsi, kategori, stok, gambar", example_url: "https://example-store.com/catalog" },
    { id: "video-metadata",     name: "Video Metadata",     description: "Metadata video: judul, views, likes, channel",             lang: "nodejs", target: "judul video, channel, views, likes, tanggal upload, durasi, thumbnail URL, deskripsi", example_url: "https://www.youtube.com/watch?v=XXXXX" },
    { id: "review-scraper",     name: "Review Scraper",     description: "Kumpulkan review dan rating produk/layanan",               lang: "python", target: "nama reviewer, rating bintang, teks review, tanggal, verified purchase status", example_url: "https://www.tokopedia.com/product/review" },
  ];
  res.json({ success: true, count: templates.length, templates });
});

// ── POST /api/validate ────────────────────────────────────────
// Validasi API key provider
app.post("/api/validate", async (req, res) => {
  const { provider, apiKey, model } = req.body;
  if (!provider || !apiKey) return res.status(400).json({ error: "provider dan apiKey diperlukan" });

  const VALIDATE_BODY = {
    // Pakai model paling murah/cepat tiap provider untuk validate
    anthropic: { model: model || "claude-haiku-4-5-20251001", max_tokens: 5,  messages: [{ role: "user", content: "Hi" }] },
    openai:    { model: model || "gpt-4o-mini",               max_tokens: 5,  messages: [{ role: "user", content: "Hi" }] },
    groq:      { model: model || "llama-3.1-8b-instant",      max_tokens: 5,  messages: [{ role: "user", content: "Hi" }] },
    gemini:    null,  // handle terpisah (beda format)
    deepseek:  { model: model || "deepseek-chat",             max_tokens: 5,  messages: [{ role: "user", content: "Hi" }] },
    mistral:   { model: model || "mistral-small-latest",      max_tokens: 5,  messages: [{ role: "user", content: "Hi" }] },
    xai:       { model: model || "grok-3-mini",               max_tokens: 5,  messages: [{ role: "user", content: "Hi" }] },
    together:  { model: model || "meta-llama/Llama-3.3-70B-Instruct-Turbo", max_tokens: 5, messages: [{ role: "user", content: "Hi" }] },
  };

  const VALIDATE_URLS = {
    anthropic: "https://api.anthropic.com/v1/messages",
    openai:    "https://api.openai.com/v1/chat/completions",
    groq:      "https://api.groq.com/openai/v1/chat/completions",
    deepseek:  "https://api.deepseek.com/chat/completions",
    mistral:   "https://api.mistral.ai/v1/chat/completions",
    xai:       "https://api.x.ai/v1/chat/completions",
    together:  "https://api.together.xyz/v1/chat/completions",
  };

  const VALIDATE_HEADERS = (prov) => {
    const base = { "Content-Type": "application/json" };
    if (prov === "anthropic") return { ...base, "x-api-key": apiKey.trim(), "anthropic-version": "2023-06-01" };
    return { ...base, Authorization: `Bearer ${apiKey.trim()}` };
  };

  const testFn = async () => {
    // Gemini beda endpoint & format
    if (provider === "gemini") {
      const mdl = model || "gemini-2.0-flash";
      return axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/${mdl}:generateContent?key=${apiKey.trim()}`,
        { contents: [{ role: "user", parts: [{ text: "Hi" }] }], generationConfig: { maxOutputTokens: 5 } },
        { headers: { "Content-Type": "application/json" }, timeout: 12000 }
      );
    }

    const url  = VALIDATE_URLS[provider];
    const body = VALIDATE_BODY[provider];
    if (!url || !body) throw new Error(`Provider tidak dikenal: ${provider}`);

    return axios.post(url, body, { headers: VALIDATE_HEADERS(provider), timeout: 12000 });
  };

  if (!VALIDATE_URLS[provider] && provider !== "gemini") {
    return res.status(400).json({ error: `Provider tidak dikenal: ${provider}` });
  }

  try {
    await testFn();
    res.json({ success: true, valid: true, provider, message: `API Key ${provider} valid dan aktif` });
  } catch (e) {
    const status = e.response?.status;
    // Error detail dari berbagai provider berbeda format
    const msg =
      e.response?.data?.error?.message ||        // OpenAI, Groq, xAI, Mistral, Together
      e.response?.data?.message ||               // Anthropic
      e.response?.data?.error?.status ||         // Gemini
      e.message || "Unknown error";
    if (status === 401 || status === 403) {
      return res.json({ success: true, valid: false, provider, message: `API Key tidak valid: ${msg}` });
    }
    // 404 = model tidak ditemukan, tapi key mungkin valid
    if (status === 404) {
      return res.json({ success: true, valid: null, provider, message: `Model tidak ditemukan, coba ganti model. Key mungkin valid.` });
    }
    res.json({ success: true, valid: null, provider, message: `Tidak bisa verifikasi (HTTP ${status || "timeout"}): ${msg}` });
  }
});

// ── POST /api/analyze ─────────────────────────────────────────
// ═══════════════════════════════════════════════════════════
//  HTML FETCHER + STRUCTURAL ANALYZER untuk /api/analyze
// ═══════════════════════════════════════════════════════════

const FETCH_HEADERS_ANALYZE = {
  "User-Agent":      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept":          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7",
  "Accept-Encoding": "gzip, deflate, br",
  "Cache-Control":   "no-cache",
  "Sec-Fetch-Dest":  "document",
  "Sec-Fetch-Mode":  "navigate",
  "Sec-Fetch-Site":  "none",
  "Upgrade-Insecure-Requests": "1",
};

async function fetchAndExtractHtml(url) {
  const result = {
    fetched: false, statusCode: null, html_snippet: "",
    title: "", meta_desc: "", h1_tags: [], h2_tags: [],
    class_samples: [], data_attrs: [], scripts_src: [],
    json_ld: null, next_data: null, forms: [], tables: [],
    img_count: 0, link_count: 0, detected_tech: [], error: null,
  };
  try {
    const resp = await axios.get(url, {
      headers: FETCH_HEADERS_ANALYZE, timeout: 18000, maxRedirects: 5,
      validateStatus: s => s < 600, maxContentLength: 5 * 1024 * 1024,
    });
    result.statusCode = resp.status;
    const contentType = resp.headers["content-type"] || "";
    if (contentType.includes("application/json")) {
      const jStr = typeof resp.data === "string" ? resp.data : JSON.stringify(resp.data, null, 2);
      result.fetched = true;
      result.html_snippet = jStr.substring(0, 3000);
      result.detected_tech.push("JSON API (no HTML)");
      return result;
    }
    if (!contentType.includes("html") && !contentType.includes("text")) {
      result.error = `Bukan halaman HTML: ${contentType}`; return result;
    }
    const html = typeof resp.data === "string" ? resp.data : "";
    if (!html) { result.error = "HTML kosong"; return result; }
    result.fetched = true;
    const $ = cheerio.load(html);
    result.title     = $("title").first().text().trim().substring(0, 120);
    result.meta_desc = ($("meta[name='description']").attr("content") || "").substring(0, 200);
    result.h1_tags   = $("h1").map((_, el) => $(el).text().trim()).get().filter(Boolean).slice(0, 5);
    result.h2_tags   = $("h2").map((_, el) => $(el).text().trim()).get().filter(Boolean).slice(0, 8);

    const classSet = new Set();
    $("[class]").each((_, el) => {
      const cls = $(el).attr("class") || "";
      cls.split(/\s+/).filter(c => c.length > 2 && c.length < 40 && !/^[0-9]/.test(c)).forEach(c => classSet.add(c));
    });
    result.class_samples = [...classSet].slice(0, 40);

    const dataAttrSet = new Set();
    $("*").each((_, el) => {
      Object.keys(el.attribs || {}).filter(a => a.startsWith("data-") && a.length < 40).forEach(a => dataAttrSet.add(a));
    });
    result.data_attrs = [...dataAttrSet].slice(0, 25);
    result.scripts_src = $("script[src]").map((_, el) => $(el).attr("src") || "").get()
      .filter(s => s && !s.includes("analytics") && !s.includes("gtag")).slice(0, 12);

    $("script[type='application/ld+json']").each((_, el) => {
      if (result.json_ld) return;
      try { result.json_ld = JSON.stringify(JSON.parse($(el).text().trim())).substring(0, 800); } catch {}
    });

    const nextMatch = html.match(/<script[^>]+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
    if (nextMatch) {
      try {
        const nd = JSON.parse(nextMatch[1]);
        result.next_data = JSON.stringify({ _keys: Object.keys(nd.props?.pageProps || nd), _route: nd.page }).substring(0, 400);
      } catch { result.next_data = nextMatch[1].substring(0, 400); }
    }

    $("form").each((_, form) => {
      const inputs = $(form).find("input,select,textarea")
        .map((_, el) => `${el.tagName}[${$(el).attr("name") || $(el).attr("id") || "?"}]`).get();
      if (inputs.length) result.forms.push(inputs.slice(0, 8).join(", "));
    });
    result.forms = result.forms.slice(0, 4);

    $("table").each((_, tbl) => {
      const headers = $(tbl).find("th").map((_, el) => $(el).text().trim()).get().filter(Boolean);
      if (headers.length) result.tables.push(headers.slice(0, 8).join(" | "));
    });
    result.tables = result.tables.slice(0, 5);

    result.img_count  = $("img").length;
    result.link_count = $("a[href]").length;

    const scriptContent = $("script:not([src])").text().substring(0, 5000);
    const allScripts    = result.scripts_src.join(" ") + " " + html.substring(0, 3000);
    const techChecks = [
      ["Next.js",          /__NEXT_DATA__|_next\/static/],
      ["React",            /react(?:\.min)?\.js|__reactFiber|_reactRootContainer/],
      ["Vue.js",           /vue(?:\.min)?\.js|data-v-|__vue__/],
      ["Angular",          /angular(?:\.min)?\.js|ng-app|ng-controller/],
      ["Nuxt.js",          /__nuxt__|nuxt\.js/],
      ["SvelteKit",        /svelte|__sveltekit/],
      ["jQuery",           /jquery(?:\.min)?\.js|window\.\$/],
      ["Webpack",          /webpack_require|__webpack_modules__/],
      ["Tailwind CSS",     /tailwind|class="[^"]*(?:flex|grid|text-|bg-|p-|m-)[^"]*"/],
      ["WordPress",        /wp-content|wp-includes/],
      ["Shopify",          /shopify|Shopify\.theme/],
      ["GraphQL",          /graphql|__typename/],
      ["Infinite Scroll",  /infinite.?scroll|loadMore|next_page_token/i],
      ["Login Required",   /login|sign.?in.*required|auth.*required/i],
    ];
    techChecks.forEach(([name, pattern]) => {
      if (pattern.test(allScripts) || pattern.test(scriptContent)) result.detected_tech.push(name);
    });

    let snippet = "";
    const candidates = ["main","article","[role='main']",".product",".content",".container","body"];
    for (const sel of candidates) {
      const el = $(sel).first();
      if (el.length && el.text().trim().length > 100) { snippet = el.html() || ""; break; }
    }
    if (!snippet) snippet = $("body").html() || html;
    const $c = cheerio.load(snippet);
    $c("script,style,noscript,iframe,svg,head").remove();
    let cleaned = $c.html() || snippet;
    cleaned = cleaned.replace(/\s{2,}/g, " ").replace(/<!--[\s\S]*?-->/g, "").trim();
    result.html_snippet = cleaned.substring(0, 8000);
  } catch (e) {
    result.error = e.message;
  }
  return result;
}

// ── POST /api/analyze ─────────────────────────────────────────
app.post("/api/analyze", async (req, res) => {
  const { url, provider, apiKey, model } = req.body;
  if (!url || !apiKey) return res.status(400).json({ error: "url dan apiKey diperlukan" });

  try {
    const [fw, htmlData] = await Promise.all([
      detectFirewall(url),
      fetchAndExtractHtml(url),
    ]);

    const needsBypass = fw.bypass_recommended ||
      htmlData.detected_tech.some(t => ["Next.js","React","Angular","Vue.js","Infinite Scroll","SvelteKit","Nuxt.js"].includes(t));

    const htmlContext = htmlData.fetched ? `
=== DATA ASLI HTML DARI WEBSITE ===
URL: ${url}
HTTP Status: ${htmlData.statusCode}
Title: ${htmlData.title || "(tidak ada)"}
Meta Description: ${htmlData.meta_desc || "(tidak ada)"}
H1: ${htmlData.h1_tags.join(" | ") || "(tidak ada)"}
H2: ${htmlData.h2_tags.slice(0,5).join(" | ") || "(tidak ada)"}
Gambar: ${htmlData.img_count} | Link: ${htmlData.link_count}
Teknologi terdeteksi: ${htmlData.detected_tech.join(", ") || "Standar HTML"}
CSS Classes (sample): ${htmlData.class_samples.slice(0,25).join(", ")}
Data attributes: ${htmlData.data_attrs.join(", ") || "(tidak ada)"}
JSON-LD: ${htmlData.json_ld || "(tidak ada)"}
__NEXT_DATA__ keys: ${htmlData.next_data || "(tidak ada)"}
Form fields: ${htmlData.forms.join(" | ") || "(tidak ada)"}
Tabel: ${htmlData.tables.join(" | ") || "(tidak ada)"}

=== SNIPPET HTML BERSIH ===
${htmlData.html_snippet}
` : `URL: ${url}\nHTML fetch gagal: ${htmlData.error || "timeout/blocked"}\nFirewall: ${fw.cloudflare ? "Cloudflare" : "tidak ada"}`;

    const analyzeSystem = `Kamu adalah SmartScrapeAI senior web scraping engineer berbahasa Indonesia.
Kamu diberi DATA ASLI HTML dari website yang sudah di-fetch: class CSS, data attributes, JSON-LD, teknologi terdeteksi, dan snippet HTML nyata.
Gunakan data ini untuk analisa yang SANGAT AKURAT dan SPESIFIK — bukan hanya berdasarkan nama domain.

ATURAN:
- Gunakan class CSS dan data attributes nyata dari HTML untuk saran selector
- Jika terdeteksi Next.js/React/SPA → WAJIB rekomendasikan puppeteer/playwright, bukan axios biasa
- Jika ada JSON-LD atau __NEXT_DATA__ → sebutkan data bisa diambil dari embedded JSON (lebih akurat)
- Suggestions HARUS menyebut nama field/class/key spesifik yang terlihat di HTML

Balas HANYA JSON valid tanpa markdown:
{
  "greeting": "2 kalimat: jenis website + teknologi terdeteksi + strategi scraping terbaik",
  "question": "tanya field spesifik yang terlihat di HTML (1 kalimat, sebut nama class/key nyata)",
  "suggestions": ["field spesifik dari HTML misal: .price, data-product-id, atau __NEXT_DATA__.props.product.name"],
  "site_type": "ecommerce|news|social|blog|api|forum|dashboard|other",
  "complexity": "simple|moderate|complex",
  "complexity_reason": "1 kalimat spesifik sebut teknologinya",
  "scraping_strategy": "2-3 kalimat strategi: apakah perlu browser automation, embedded JSON tersedia, dll",
  "css_selectors": { "note": "selector dari HTML asli", "selectors": ["sel1","sel2","sel3"] },
  "recommended_modules": {
    "nodejs": { "packages": ["pkg1"], "reason": "alasan spesifik berdasarkan tech stack", "install_cmd": "npm install pkg1" },
    "python": { "packages": ["pkg1"], "reason": "alasan spesifik", "install_cmd": "pip install pkg1" },
    "php":    { "packages": ["guzzlehttp/guzzle"], "reason": "alasan", "install_cmd": "composer require guzzlehttp/guzzle" }
  }
}`;

    const raw = await callAI({ provider, apiKey, model, system: analyzeSystem, prompt: htmlContext, maxTokens: 1200 });
    const clean = raw.replace(/```json|```/g, "").trim();
    let parsed;
    try { parsed = JSON.parse(clean); }
    catch {
      const host = (() => { try { return new URL(url).hostname.toLowerCase(); } catch { return ""; } })();
      const isSocial = ["instagram","tiktok","twitter","x.com","facebook"].some(s => host.includes(s));
      const isEcomm  = ["shopee","tokopedia","lazada","amazon","ebay"].some(s => host.includes(s));
      parsed = {
        greeting:    `Website ${htmlData.title || url}. Teknologi: ${htmlData.detected_tech.join(", ") || "Standar HTML"}.`,
        question:    "Data apa yang ingin kamu ambil dari website ini?",
        suggestions: htmlData.h2_tags.slice(0,4).length
          ? [...htmlData.h2_tags.slice(0,4),"Gambar & media","Link & URL"]
          : ["Judul & konten","Harga & produk","Gambar","Link","Data tabel","Metadata"],
        site_type:   isSocial ? "social" : isEcomm ? "ecommerce" : "other",
        complexity:  needsBypass ? "complex" : "moderate",
        complexity_reason: needsBypass ? `Terdeteksi: ${htmlData.detected_tech.join(", ")}` : "Struktur HTML standar",
        scraping_strategy: needsBypass
          ? "Gunakan puppeteer-extra + stealth untuk Node.js atau playwright untuk Python karena site menggunakan JS rendering."
          : "Bisa pakai axios+cheerio (Node.js) atau requests+BeautifulSoup (Python) untuk site HTML statis ini.",
        css_selectors: { note: "Sample dari HTML", selectors: htmlData.class_samples.slice(0,5) },
        recommended_modules: {
          nodejs: needsBypass
            ? { packages: ["puppeteer-extra","puppeteer-extra-plugin-stealth"], reason: "Butuh browser automation", install_cmd: "npm install puppeteer-extra puppeteer-extra-plugin-stealth" }
            : { packages: ["axios","cheerio"], reason: "HTML statis", install_cmd: "npm install axios cheerio" },
          python: needsBypass
            ? { packages: ["playwright","beautifulsoup4"], reason: "playwright untuk JS rendering", install_cmd: "pip install playwright beautifulsoup4" }
            : { packages: ["requests","beautifulsoup4","lxml"], reason: "Standar HTML statis", install_cmd: "pip install requests beautifulsoup4 lxml" },
          php: { packages: ["guzzlehttp/guzzle"], reason: "HTTP client PHP", install_cmd: "composer require guzzlehttp/guzzle" },
        },
      };
    }

    const html_info = {
      fetched: htmlData.fetched, status_code: htmlData.statusCode,
      title: htmlData.title, detected_tech: htmlData.detected_tech,
      has_json_ld: !!htmlData.json_ld, has_next_data: !!htmlData.next_data,
      img_count: htmlData.img_count, link_count: htmlData.link_count,
      fetch_error: htmlData.error || null,
    };

    res.json({ success: true, url, firewall: fw, ai: parsed, html_info });
  } catch (e) {
    console.error("[analyze]", e.message);
    res.status(500).json({ error: e.message });
  }

// ── POST /api/generate ────────────────────────────────────────
app.post("/api/generate", async (req, res) => {
  const { url, target, lang, bypassCF, provider, apiKey, model } = req.body;
  if (!url || !target || !lang || !apiKey)
    return res.status(400).json({ error: "url, target, lang, apiKey diperlukan" });
  if (!["nodejs", "python", "php"].includes(lang))
    return res.status(400).json({ error: "lang harus: nodejs, python, atau php" });

  try {
    const sys    = buildSystemPrompt(lang, bypassCF);
    const prompt = `URL Target: ${url}
Yang akan di-scrape: ${target}
Bahasa: ${lang}
${bypassCF ? "Mode Bypass Cloudflare: AKTIF — Wajib gunakan semua teknik stealth bypass" : ""}

Tugas: Buat scraper LENGKAP dan SIAP PAKAI untuk mengambil: ${target}

Struktur kode wajib:
1. Import/require semua library yang dibutuhkan
2. Konfigurasi (URL, headers, delay, timeout)
3. Fungsi fetch halaman${bypassCF ? " dengan bypass CF/stealth" : ""}
4. Fungsi parse & ekstrak: ${target}
5. Fungsi format dan bersihkan data hasil
6. Fungsi main() yang memanggil semua fungsi di atas
7. Output JSON ke console/stdout
8. Error handling dan retry logic di setiap fungsi

INGAT: Tulis SEMUA kode dari awal sampai akhir. JANGAN potong atau skip bagian apapun.`;

    let code = await callAI({ provider, apiKey, model, system: sys, prompt, maxTokens: null });
    code      = code.replace(/^```[\w]*\n?/gm, "").replace(/^```\n?/gm, "").trim();

    const id        = uuidv4();
    const trySchema = buildTrySchema(url, target);
    const host      = (() => { try { return new URL(url).hostname.replace("www.", ""); } catch { return "site"; } })();
    const extMap    = { nodejs: "js", python: "py", php: "php" };

    const entry = {
      id,
      name:      `${host}-scraper`,
      url,
      target,
      lang,
      bypassCF:  !!bypassCF,
      code,
      trySchema,
      provider,
      model:     model || "default",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      filename:  `scraper.${extMap[lang]}`,
      fixCount:  0,
      history:   [],
    };

    registry.add(entry);
    res.json({ success: true, id, code, trySchema, entry });
  } catch (e) {
    console.error("[generate]", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/docs ─────────────────────────────────────────────
app.get("/api/docs", (req, res) => {
  const all  = registry.getAll();
  const allApiRoutes = all.flatMap(s => (s.apiRoutes || []).map(r => ({ ...r, scraperName: s.name })));
  const docs = {
    name:           "SmartScrapeAI — API Documentation",
    version:        "4.0.0",
    description:    "Auto-generated API docs dari semua scraper yang sudah dibuat",
    baseURL:        `${req.protocol}://${req.get("host")}`,
    totalEndpoints: all.length + 18 + allApiRoutes.length,
    generatedRouteCount: allApiRoutes.length,
    builtinEndpoints: [
      { method: "GET",    path: "/health",                   description: "Health check server + stats" },
      { method: "POST",   path: "/api/validate",             description: "Validasi API key provider", body: { provider: "string", apiKey: "string", model: "string (opsional)" } },
      { method: "POST",   path: "/api/analyze",              description: "Analisa URL, deteksi firewall, dan saran scraping", body: { url: "string", provider: "string", apiKey: "string" } },
      { method: "POST",   path: "/api/generate",             description: "Generate kode scraper", body: { url: "string", target: "string", lang: "nodejs|python|php", bypassCF: "boolean", provider: "string", apiKey: "string" } },
      { method: "GET",    path: "/api/scrapers",             description: "Daftar semua scraper" },
      { method: "GET",    path: "/api/scrapers/stats",       description: "Statistik agregat semua scraper" },
      { method: "GET",    path: "/api/scrapers/search",      description: "Cari scraper", query: { q: "string", lang: "string", provider: "string" } },
      { method: "GET",    path: "/api/templates",            description: "Template scraper yang tersedia" },
      { method: "GET",    path: "/api/export/zip",           description: "Export semua scraper sebagai ZIP" },
      { method: "GET",    path: "/api/docs",                 description: "API documentation ini" },
      { method: "GET",    path: "/api/scraper/:id",          description: "Detail scraper by ID" },
      { method: "GET",    path: "/api/scraper/:id/download", description: "Download file kode scraper" },
      { method: "GET",    path: "/api/scraper/:id/zip",      description: "Download ZIP (kode + dependencies + README)" },
      { method: "GET",    path: "/api/scraper/:id/schema",   description: "Input schema untuk try endpoint" },
      { method: "GET",    path: "/api/scraper/:id/history",  description: "Riwayat versi scraper" },
      { method: "POST",   path: "/api/scraper/:id/try",      description: "Preview scraper info" },
      { method: "POST",   path: "/api/scraper/:id/fix",      description: "AI auto-fix error scraper", body: { errorMessage: "string", provider: "string", apiKey: "string", fixMode: "auto|rewrite|patch|enhance" } },
      { method: "POST",   path: "/api/scraper/:id/apply",    description: "Terapkan kode yang sudah difix" },
      { method: "POST",   path: "/api/scraper/:id/revert",   description: "Revert ke versi sebelumnya" },
      { method: "POST",   path: "/api/scraper/:id/edit",     description: "Edit kode via instruksi AI" },
      { method: "DELETE", path: "/api/scraper/:id",          description: "Hapus scraper" },
      { method: "GET",    path: "/api/routes",               description: "Semua generated API routes" },
      { method: "GET",    path: "/api/scraper/:id/routes",   description: "API routes untuk scraper tertentu" },
      { method: "POST",   path: "/api/scraper/:id/routes",   description: "Buat API route baru dari scraper", body: { name: "string", category: "string", path: "string", method: "GET|POST" } },
      { method: "DELETE", path: "/api/scraper/:id/routes/:routeId", description: "Hapus API route" },
      { method: "POST",   path: "/api/scraper/:id/install",  description: "Auto install dependencies scraper" },
    ],
    scrapers: all.map(s => ({
      id:          s.id,
      name:        s.name,
      url:         s.url,
      target:      s.target,
      lang:        s.lang,
      bypassCF:    s.bypassCF,
      provider:    s.provider,
      model:       s.model,
      fixCount:    s.fixCount || 0,
      createdAt:   s.createdAt,
      updatedAt:   s.updatedAt,
      endpoint:    `/api/scraper/${s.id}`,
      download:    `/api/scraper/${s.id}/download`,
      zip:         `/api/scraper/${s.id}/zip`,
      tryEndpoint: `/api/scraper/${s.id}/try`,
      tryInputs:   s.trySchema,
      apiRoutes:   s.apiRoutes || [],
    })),
    providers: {
      supported: ["anthropic","openai","groq","gemini","deepseek","mistral","xai","together"],
      usage:     "Kirim provider + apiKey di setiap request POST yang butuh AI",
    },
  };
  res.json(docs);
});

// ── GET /api/scrapers ─────────────────────────────────────────
app.get("/api/scrapers", (req, res) => {
  const all = registry.getAll();
  res.json({ success: true, count: all.length, scrapers: all });
});

// ── GET /api/export/zip ───────────────────────────────────────
// Export semua scraper sebagai ZIP
app.get("/api/export/zip", async (req, res) => {
  const all = registry.getAll();
  if (!all.length) return res.status(404).json({ error: "Belum ada scraper yang dibuat" });

  try {
    const zip = new JSZip();
    const extMap = { nodejs: "js", python: "py", php: "php" };
    const reqFile = { nodejs: "package.json", python: "requirements.txt", php: "composer.json" };

    for (const entry of all) {
      const folderName = `${entry.name}-${entry.id.slice(0, 8)}`;
      const folder     = zip.folder(folderName);
      folder.file(`scraper.${extMap[entry.lang]}`, entry.code);
      folder.file(reqFile[entry.lang],                generateRequirements(entry.lang, entry.bypassCF));
      folder.file("README.md",                        generateReadme(entry));
    }

    // Manifest
    zip.file("manifest.json", JSON.stringify({
      exported_at: new Date().toISOString(),
      total:       all.length,
      scrapers:    all.map(s => ({ id: s.id, name: s.name, lang: s.lang, url: s.url })),
    }, null, 2));

    const buffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
    const fname  = `smartscrapeai-export-${Date.now()}.zip`;
    res.setHeader("Content-Disposition", `attachment; filename="${fname}"`);
    res.setHeader("Content-Type", "application/zip");
    res.send(buffer);
  } catch (e) {
    console.error("[export/zip]", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/scraper/:id ──────────────────────────────────────
app.get("/api/scraper/:id", (req, res) => {
  const entry = registry.getById(req.params.id);
  if (!entry) return res.status(404).json({ error: "Scraper tidak ditemukan" });
  res.json({ success: true, scraper: entry });
});

// ── GET /api/scraper/:id/download ────────────────────────────
app.get("/api/scraper/:id/download", (req, res) => {
  const entry = registry.getById(req.params.id);
  if (!entry) return res.status(404).json({ error: "Scraper tidak ditemukan" });
  res.setHeader("Content-Disposition", `attachment; filename="${entry.filename}"`);
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.send(entry.code);
});

// ── GET /api/scraper/:id/zip ──────────────────────────────────
// ZIP: kode + requirements + README
app.get("/api/scraper/:id/zip", async (req, res) => {
  const entry = registry.getById(req.params.id);
  if (!entry) return res.status(404).json({ error: "Scraper tidak ditemukan" });

  try {
    const zip    = new JSZip();
    const extMap = { nodejs: "js", python: "py", php: "php" };
    const reqFile = { nodejs: "package.json", python: "requirements.txt", php: "composer.json" };

    zip.file(`scraper.${extMap[entry.lang]}`, entry.code);
    zip.file(reqFile[entry.lang],              generateRequirements(entry.lang, entry.bypassCF));
    zip.file("README.md",                      generateReadme(entry));
    zip.file("scraper-info.json", JSON.stringify({
      id: entry.id, name: entry.name, url: entry.url,
      target: entry.target, lang: entry.lang, bypassCF: entry.bypassCF,
      createdAt: entry.createdAt, fixCount: entry.fixCount || 0,
    }, null, 2));

    const buffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
    res.setHeader("Content-Disposition", `attachment; filename="${entry.name}-${entry.id.slice(0, 8)}.zip"`);
    res.setHeader("Content-Type", "application/zip");
    res.send(buffer);
  } catch (e) {
    console.error("[scraper/zip]", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/scraper/:id/schema ───────────────────────────────
app.get("/api/scraper/:id/schema", (req, res) => {
  const entry = registry.getById(req.params.id);
  if (!entry) return res.status(404).json({ error: "Tidak ditemukan" });
  res.json({ id: entry.id, name: entry.name, inputs: entry.trySchema });
});

// ── GET /api/scraper/:id/history ──────────────────────────────
app.get("/api/scraper/:id/history", (req, res) => {
  const entry = registry.getById(req.params.id);
  if (!entry) return res.status(404).json({ error: "Tidak ditemukan" });
  res.json({
    id:       entry.id,
    fixCount: entry.fixCount || 0,
    versions: (entry.history?.length || 0) + 1,
    history:  (entry.history || []).map(h => ({
      version:   h.version,
      savedAt:   h.savedAt,
      changeLog: h.changeLog,
      lines:     h.code.split("\n").length,
    })),
    current: {
      version:   (entry.history?.length || 0) + 1,
      updatedAt: entry.updatedAt || entry.createdAt,
      lines:     entry.code.split("\n").length,
    },
  });
});

// ── POST /api/scraper/:id/try ─────────────────────────────────
// v4: REAL SCRAPER — inline fetch+parse, return actual JSON data
app.post("/api/scraper/:id/try", async (req, res) => {
  const entry = registry.getById(req.params.id);
  if (!entry) return res.status(404).json({ error: "Scraper tidak ditemukan" });

  const inputURL = req.body.target_url || req.body.video_url || req.body.post_url
    || req.body.product_url || req.body.tweet_url || req.body.url || entry.url;

  const cheerio = (() => { try { return require("cheerio"); } catch { return null; } })();

  // ── Browser-like headers ──────────────────────────────────
  const HEADERS = {
    "User-Agent":      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept":          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7",
    "Accept-Encoding": "gzip, deflate, br",
    "Cache-Control":   "no-cache",
    "Pragma":          "no-cache",
    "Sec-Fetch-Dest":  "document",
    "Sec-Fetch-Mode":  "navigate",
    "Sec-Fetch-Site":  "none",
    "Upgrade-Insecure-Requests": "1",
  };

  // ── Helper: fetch page ────────────────────────────────────
  const fetchPage = async (url) => {
    const resp = await axios.get(url, {
      headers: HEADERS, timeout: 25000, maxRedirects: 5,
      validateStatus: s => s < 500,
    });
    return resp.data;
  };

  // ── Helper: extract JSON-LD / __NEXT_DATA__ / embedded JSON ──
  const extractEmbeddedJson = (html) => {
    if (!html) return null;
    // 1) __NEXT_DATA__
    const nextData = html.match(/<script[^>]+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
    if (nextData) { try { return { _source: "NEXT_DATA", data: JSON.parse(nextData[1]) }; } catch {} }
    // 2) JSON-LD
    const jsonLds = [...html.matchAll(/<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)];
    for (const m of jsonLds) {
      try {
        const obj = JSON.parse(m[1].trim());
        if (obj["@type"] || obj.name || obj.price) return { _source: "JSON-LD", data: obj };
      } catch {}
    }
    // 3) window.__STATE__ / window.STATE / window.pageData
    const stateMatches = html.match(/window\.__(?:STATE|INITIAL_STATE|DATA|pageData|props)__\s*=\s*(\{[\s\S]*?\});/);
    if (stateMatches) { try { return { _source: "window.__STATE__", data: JSON.parse(stateMatches[1]) }; } catch {} }
    return null;
  };

  // ── Detect site & use specialist parser ───────────────────
  const host = (() => { try { return new URL(inputURL).hostname.toLowerCase().replace("www.",""); } catch { return ""; } })();

  const SITE_PARSERS = {
    "tokopedia.com": async (html, url) => {
      const embedded = extractEmbeddedJson(html);
      let result = { url, site: "tokopedia.com", parsed_by: "inline-parser-v4" };

      // Try NEXT_DATA first (most reliable for Tokopedia)
      if (embedded?.data) {
        const d = embedded.data;
        // Navigate Tokopedia's NEXT_DATA structure
        const pdp = d?.props?.pageProps?.productSSRData?.pdpGetLayout?.basicInfo ||
                    d?.props?.pageProps?.layoutData?.pdpGetLayout?.basicInfo ||
                    d?.props?.pageProps;
        if (pdp?.name) {
          result = {
            ...result,
            nama_produk:   pdp.name,
            harga:         pdp.price?.value ? `Rp ${pdp.price.value.toLocaleString("id-ID")}` : pdp.priceInfo?.price || "N/A",
            rating:        pdp.rating?.averageRate || pdp.stats?.rating || "N/A",
            jumlah_review: pdp.stats?.reviewCount || pdp.rating?.totalRating || 0,
            terjual:       pdp.stats?.txSuccess || 0,
            stok:          pdp.stock?.value || "Ada",
            toko:          pdp.shopInfo?.name || pdp.shopName || "N/A",
            lokasi:        pdp.shopInfo?.location || "N/A",
            kondisi:       pdp.condition === 1 ? "Baru" : "Bekas",
            berat:         pdp.weight ? `${pdp.weight} gram` : "N/A",
            kategori:      pdp.breadcrumb?.map(b => b.name).join(" > ") || "N/A",
            gambar:        (pdp.media?.photos || []).slice(0,3).map(p => p.urlThumbnail || p.url300 || p.url),
            deskripsi:     (pdp.description?.replace(/<[^>]+>/g,"").substring(0,300) || "N/A") + "...",
            url_produk:    url,
            _source:       embedded._source,
          };
          return result;
        }
      }

      // Fallback: cheerio HTML parsing
      if (cheerio) {
        const $ = cheerio.load(html);
        result = {
          ...result,
          nama_produk:   $("h1[data-testid='lblPDPDetailProductName'], h1.css-1os9jjn, [class*='product-name'] h1").first().text().trim() || $("h1").first().text().trim() || "N/A",
          harga:         $("[data-testid='lblPDPDetailProductPrice'], .css-o0erv3, [class*='product-price']").first().text().trim() || "N/A",
          rating:        $("[data-testid='icnStarRating'], .css-1c2dfid, [class*='star-rating']").first().text().trim() || "N/A",
          toko:          $("[data-testid='llbPDPFooterShopName'], .css-1xs1wfr, [class*='shop-name']").first().text().trim() || "N/A",
          deskripsi:     $("[data-testid='lblPDPDescriptionProduk'], [class*='product-desc']").first().text().trim().substring(0,300) || "N/A",
          gambar:        $("img[data-testid='PDPMainImage'], .main-product-image img, [class*='product-image'] img").map((_,el) => $(el).attr("src") || $(el).attr("data-src")).get().filter(Boolean).slice(0,3),
          url_produk:    url,
          _source:       "cheerio-html-parser",
          _note:         "Tokopedia memblokir akses langsung. Data mungkin tidak lengkap. Gunakan scraper dengan puppeteer stealth untuk data lengkap.",
        };
      }
      return result;
    },

    "shopee.co.id": async (html, url) => {
      const embedded = extractEmbeddedJson(html);
      if (!cheerio) return { url, site: "shopee.co.id", error: "cheerio tidak tersedia" };
      const $ = cheerio.load(html);
      return {
        url, site: "shopee.co.id", parsed_by: "inline-parser-v4",
        nama_produk: $("._2rI3BH, [class*='pdp-product-title']").first().text().trim() || $("h1").first().text().trim() || "N/A",
        harga:       $("._3n5NQx, [class*='pdp-price']").first().text().trim() || "N/A",
        toko:        $("[class*='seller-name'], ._1VqRBa").first().text().trim() || "N/A",
        _note:       "Shopee memerlukan browser automation untuk data lengkap",
      };
    },

    "youtube.com": async (html, url) => {
      const embedded = extractEmbeddedJson(html);
      const videoId = url.match(/v=([^&]+)/)?.[1] || url.match(/youtu\.be\/([^?]+)/)?.[1];
      if (embedded?.data) {
        const page = embedded.data;
        const vd = page?.props?.pageProps?.videoDetails || page?.videoDetails;
        if (vd) return { url, site: "youtube.com", parsed_by: "NEXT_DATA",
          judul: vd.title, channel: vd.author, views: vd.viewCount, durasi: vd.lengthSeconds + "s",
          thumbnail: `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`, video_id: videoId };
      }
      if (!cheerio) return { url, site: "youtube.com", video_id: videoId };
      const $ = cheerio.load(html);
      return {
        url, site: "youtube.com", parsed_by: "inline-parser-v4",
        judul:     $("meta[name='title']").attr("content") || $("title").text().replace(" - YouTube",""),
        channel:   $("link[itemprop='name']").attr("content") || "N/A",
        thumbnail: videoId ? `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg` : "N/A",
        video_id:  videoId || "N/A",
      };
    },
  };

  // ── Generic fallback parser ───────────────────────────────
  const genericParser = async (html, url) => {
    if (!cheerio) return { url, error: "Parser tidak tersedia", note: "Install cheerio di server" };
    const $ = cheerio.load(html);

    // Remove scripts, styles, nav, footer
    $("script, style, nav, footer, header, noscript, svg, iframe").remove();

    // Extract based on target field
    const target  = entry.target.toLowerCase();
    const result  = { url, site: host, parsed_by: "generic-cheerio-parser", target: entry.target };

    // Prices
    if (target.includes("harga") || target.includes("price")) {
      const priceEls = $("[class*='price'],[class*='harga'],[itemprop='price']").map((_,el) => $(el).text().trim()).get().filter(Boolean);
      result.harga = priceEls.slice(0,3);
    }
    // Product names / titles
    result.judul_halaman = $("title").text().trim();
    result.h1 = $("h1").map((_,el) => $(el).text().trim()).get().filter(Boolean).slice(0,3);
    result.h2 = $("h2").map((_,el) => $(el).text().trim()).get().filter(Boolean).slice(0,5);
    // Meta
    result.meta_description = $("meta[name='description']").attr("content") || "N/A";
    result.og_title         = $("meta[property='og:title']").attr("content") || "N/A";
    result.og_description   = $("meta[property='og:description']").attr("content") || "N/A";
    result.og_image         = $("meta[property='og:image']").attr("content") || "N/A";
    // Images
    result.gambar = $("img[src]").map((_,el) => $(el).attr("src")).get()
      .filter(s => s && !s.includes("data:") && s.length > 10).slice(0,5);
    // Links
    result.links_count = $("a[href]").length;
    // Tables
    const tables = [];
    $("table").each((_,tbl) => {
      const rows = $(tbl).find("tr").map((_,tr) => $(tr).find("td,th").map((_,td) => $(td).text().trim()).get()).get();
      if (rows.length) tables.push(rows.slice(0,5));
    });
    if (tables.length) result.tabel = tables.slice(0,2);
    // Embedded JSON
    const embedded = extractEmbeddedJson(html);
    if (embedded) result._embedded_json_source = embedded._source;

    return result;
  };

  // ── MAIN EXECUTION ────────────────────────────────────────
  try {
    console.log(`[try-v4] Fetching: ${inputURL}`);
    const html = await fetchPage(inputURL);

    // Pick specialist parser or generic
    let scraped = null;
    for (const [domain, parser] of Object.entries(SITE_PARSERS)) {
      if (host.includes(domain)) {
        scraped = await parser(html, inputURL);
        break;
      }
    }
    if (!scraped) scraped = await genericParser(html, inputURL);

    const fw = await detectFirewall(inputURL).catch(() => ({ bypass_recommended: false, details: [] }));

    return res.json({
      success:      true,
      scraped_data: scraped,
      url:          inputURL,
      scraper_id:   entry.id,
      scraper_name: entry.name,
      lang:         entry.lang,
      target:       entry.target,
      firewall:     fw,
      scraped_at:   new Date().toISOString(),
      note:         "Data diambil langsung oleh server via inline HTML parser. Untuk data lebih lengkap, download & jalankan kode scraper dengan puppeteer.",
      download_url: `/api/scraper/${entry.id}/download`,
      zip_url:      `/api/scraper/${entry.id}/zip`,
    });

  } catch (err) {
    // Jika fetch gagal (Cloudflare block, timeout, dll)
    const fw = await detectFirewall(inputURL).catch(() => null);
    return res.status(500).json({
      success:    false,
      error:      err.message,
      url:        inputURL,
      firewall:   fw,
      scraper_id: entry.id,
      fix_hint:   `Site memblokir akses langsung. Download scraper & jalankan dengan puppeteer stealth di lokal/VPS.`,
      download:   `/api/scraper/${entry.id}/download`,
      zip:        `/api/scraper/${entry.id}/zip`,
    });
  }
});

// ══════════════════════════════════════════════════════════════
//  AI AUTO-FIX ENGINE
// ══════════════════════════════════════════════════════════════

// ── POST /api/scraper/:id/fix ─────────────────────────────────
app.post("/api/scraper/:id/fix", async (req, res) => {
  const entry = registry.getById(req.params.id);
  if (!entry) return res.status(404).json({ error: "Scraper tidak ditemukan" });

  const { errorMessage, provider, apiKey, model, fixMode = "auto" } = req.body;
  if (!apiKey) return res.status(400).json({ error: "apiKey diperlukan" });

  const langLabel = { nodejs: "Node.js", python: "Python", php: "PHP" };

  // Analisa error
  const analyzeSys = `Kamu adalah senior debugging engineer expert ${langLabel[entry.lang]}.
Analisa error yang diberikan dan kode scraper yang bermasalah.
Balas HANYA JSON valid (tanpa markdown, tanpa backtick):
{
  "error_type": "tipe error singkat (SyntaxError/NetworkError/ParseError/dll)",
  "root_cause": "penyebab utama error dalam 1 kalimat bahasa Indonesia",
  "fix_strategy": "strategi fix dalam 1-2 kalimat bahasa Indonesia",
  "severity": "critical|high|medium|low",
  "changes": ["perubahan spesifik 1", "perubahan spesifik 2"]
}`;

  const analyzePrompt = `Error yang terjadi:\n${errorMessage || "Unknown error / kode tidak berjalan"}\n\nKode scraper (${langLabel[entry.lang]}):\n${entry.code.substring(0, 2500)}${entry.code.length > 2500 ? "\n... (kode terpotong)" : ""}\n\nURL Target: ${entry.url}\nTarget scrape: ${entry.target}`;

  let analysis = null;
  try {
    const raw   = await callAI({ provider, apiKey, model, system: analyzeSys, prompt: analyzePrompt, maxTokens: 700 });
    const clean = raw.replace(/```json|```/g, "").trim();
    analysis    = JSON.parse(clean);
  } catch {
    analysis = {
      error_type: "Unknown", severity: "high",
      root_cause: "Tidak dapat menganalisa error secara detail",
      fix_strategy: "AI akan mencoba rewrite kode secara keseluruhan",
      changes: ["Rewrite kode lengkap dengan perbaikan error handling"],
    };
  }

  // Fix modes
  const fixModes = {
    auto:    "Perbaiki semua bug yang ditemukan secara otomatis",
    rewrite: "Tulis ulang SELURUH kode dari awal dengan logika yang lebih baik dan bug-free",
    patch:   "Hanya perbaiki bagian yang error, jangan ubah struktur keseluruhan",
    enhance: "Perbaiki bug DAN tambahkan fitur: retry otomatis, better error handling, logging, rate limiting",
  };

  const fixSys = `Kamu adalah senior debugging engineer expert ${langLabel[entry.lang]}.
${fixModes[fixMode] || fixModes.auto}

Error: ${errorMessage || "kode tidak berjalan"}
Root cause: ${analysis.root_cause}
Strategi: ${analysis.fix_strategy}

ATURAN TIDAK BOLEH DILANGGAR:
1. Output HANYA kode ${langLabel[entry.lang]} MENTAH yang sudah diperbaiki
2. DILARANG: markdown, backtick, triple quote, penjelasan di luar kode
3. Kode HARUS LENGKAP dari awal sampai akhir
4. Tandai baris yang diperbaiki dengan komentar: // FIXED: <alasan singkat>
5. Kode harus bisa langsung dijalankan tanpa error`;

  const fixPrompt = `Perbaiki kode berikut:\n\nURL Target: ${entry.url}\nTarget scrape: ${entry.target}\nBypass CF: ${entry.bypassCF}\n\nERROR: ${errorMessage || "kode bermasalah"}\n\nKODE ASLI (${langLabel[entry.lang]}):\n${entry.code}\n\nOutput kode yang sudah fixed dan lengkap.`;

  try {
    let fixedCode = await callAI({ provider, apiKey, model, system: fixSys, prompt: fixPrompt, maxTokens: null });
    fixedCode     = fixedCode.replace(/^```[\w]*\n?/gm, "").replace(/^```\n?/gm, "").trim();

    const origLines  = entry.code.split("\n").length;
    const fixedLines = fixedCode.split("\n").length;
    const diffCount  = Math.abs(fixedLines - origLines);

    res.json({
      success:   true,
      id:        entry.id,
      analysis,
      fixMode,
      fixedCode,
      original:  entry.code,
      diff: {
        originalLines: origLines,
        fixedLines,
        linesChanged:  diffCount,
        summary: `${fixedLines > origLines ? "+" : "-"}${diffCount} baris (${origLines} → ${fixedLines} baris)`,
      },
      message: `Kode berhasil diperbaiki. ${analysis.changes.length} perubahan diterapkan.`,
    });
  } catch (e) {
    console.error("[fix]", e.message);
    res.status(500).json({ error: e.message, analysis });
  }
});

// ── POST /api/scraper/:id/apply ───────────────────────────────
app.post("/api/scraper/:id/apply", (req, res) => {
  const entry = registry.getById(req.params.id);
  if (!entry) return res.status(404).json({ error: "Scraper tidak ditemukan" });

  const { fixedCode, changeLog } = req.body;
  if (!fixedCode?.trim()) return res.status(400).json({ error: "fixedCode diperlukan" });

  if (!entry.history) entry.history = [];
  entry.history.push({
    version:   (entry.history.length + 1),
    code:      entry.code,
    savedAt:   new Date().toISOString(),
    changeLog: changeLog || "Auto-fix applied",
  });

  entry.code      = fixedCode;
  entry.updatedAt = new Date().toISOString();
  entry.fixCount  = (entry.fixCount || 0) + 1;
  entry.lastFix   = { appliedAt: new Date().toISOString(), changeLog };

  registry.update(entry.id, entry);
  res.json({ success: true, message: `Kode berhasil diperbarui (Fix #${entry.fixCount})`, id: entry.id, fixCount: entry.fixCount, versions: entry.history.length + 1 });
});

// ── POST /api/scraper/:id/revert ──────────────────────────────
app.post("/api/scraper/:id/revert", (req, res) => {
  const entry = registry.getById(req.params.id);
  if (!entry) return res.status(404).json({ error: "Tidak ditemukan" });

  const { version } = req.body;
  if (!entry.history?.length) return res.status(400).json({ error: "Tidak ada history versi" });

  const idx     = version ? entry.history.findIndex(h => h.version === version) : entry.history.length - 1;
  const prevVer = entry.history[idx];
  if (!prevVer) return res.status(404).json({ error: "Versi tidak ditemukan" });

  entry.code      = prevVer.code;
  entry.updatedAt = new Date().toISOString();
  registry.update(entry.id, entry);
  res.json({ success: true, message: `Berhasil revert ke versi #${prevVer.version}`, revertedTo: prevVer.version });
});

// ── POST /api/scraper/:id/edit ────────────────────────────────
app.post("/api/scraper/:id/edit", async (req, res) => {
  const entry = registry.getById(req.params.id);
  if (!entry) return res.status(404).json({ error: "Tidak ditemukan" });

  const { instruction, provider, apiKey, model } = req.body;
  if (!instruction || !apiKey) return res.status(400).json({ error: "instruction dan apiKey diperlukan" });

  const langLabel = { nodejs: "Node.js", python: "Python", php: "PHP" };
  const sys    = `Kamu adalah senior ${langLabel[entry.lang]} engineer.\nUser memberikan instruksi spesifik untuk mengedit kode scraper.\nTerapkan PERSIS sesuai instruksi. Jangan ubah bagian lain.\nATURAN: Output HANYA kode ${langLabel[entry.lang]} MENTAH yang sudah diedit. Tidak ada markdown. Kode LENGKAP dari awal.\nTandai baris yang diedit dengan komentar // EDITED: <alasan singkat>`;
  const prompt = `Instruksi edit: ${instruction}\n\nKode saat ini:\n${entry.code}\n\nTerapkan instruksi dan output kode yang sudah diedit secara lengkap.`;

  try {
    let editedCode = await callAI({ provider, apiKey, model, system: sys, prompt, maxTokens: null });
    editedCode     = editedCode.replace(/^```[\w]*\n?/gm, "").replace(/^```\n?/gm, "").trim();
    res.json({ success: true, editedCode, instruction, message: "Kode berhasil diedit sesuai instruksi" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── DELETE /api/scraper/:id ───────────────────────────────────
app.delete("/api/scraper/:id", (req, res) => {
  const ok = registry.remove(req.params.id);
  if (!ok) return res.status(404).json({ error: "Tidak ditemukan" });
  res.json({ success: true, message: "Scraper dihapus" });
});

// ── Fallback untuk React Router (Production) ──────────────────
if (IS_PROD) {
  app.get("*", (req, res) => {
    const indexPath = path.join(__dirname, "client", "dist", "index.html");
    if (fs.existsSync(indexPath)) {
      res.sendFile(indexPath);
    } else {
      res.status(404).json({ error: "Frontend build tidak ditemukan. Jalankan: npm run build" });
    }
  });
}

// ── Start ─────────────────────────────────────────────────────
app.listen(PORT, "0.0.0.0", () => {
  console.log(`\n  SmartScrapeAI Server v3.0`);
  console.log(`  → http://localhost:${PORT}`);
  console.log(`  → API Docs: http://localhost:${PORT}/api/docs`);
  console.log(`  → Health:   http://localhost:${PORT}/health`);
  console.log(`  → Scrapers: ${registry.count()} loaded dari disk\n`);
});

// ══════════════════════════════════════════════════════════════
//  v4: API ROUTES MANAGEMENT
//  Auto-add scraper ke /api/generated/:category/:name
// ══════════════════════════════════════════════════════════════

const { v4: uuidv4Route } = require("uuid");

// ── POST /api/scraper/:id/routes ──────────────────────────────
app.post("/api/scraper/:id/routes", (req, res) => {
  const entry = registry.getById(req.params.id);
  if (!entry) return res.status(404).json({ error: "Scraper tidak ditemukan" });

  const { name, category, method, path: routePath, description, params } = req.body;
  if (!name || !category || !routePath)
    return res.status(400).json({ error: "name, category, path diperlukan" });

  const route = {
    id:          uuidv4Route(),
    scraperId:   entry.id,
    name,
    category,
    method:      method || "GET",
    path:        routePath,
    description: description || `Generated endpoint dari scraper ${entry.name}`,
    params:      params || [],
    createdAt:   new Date().toISOString(),
  };

  if (!entry.apiRoutes) entry.apiRoutes = [];
  // Cek duplicate path
  const dup = entry.apiRoutes.find(r => r.path === routePath);
  if (dup) return res.status(409).json({ error: `Route ${routePath} sudah ada`, existing: dup });

  entry.apiRoutes.push(route);
  registry.update(entry.id, entry);

  // ── Auto-register dynamic route di Express ────────────────
  try {
    registerGeneratedRoute(route, entry);
    res.json({ success: true, route, message: `Route ${routePath} berhasil dibuat dan didaftarkan` });
  } catch (e) {
    res.status(500).json({ error: `Route tersimpan tapi gagal register: ${e.message}` });
  }
});

// ── GET /api/scraper/:id/routes ───────────────────────────────
app.get("/api/scraper/:id/routes", (req, res) => {
  const entry = registry.getById(req.params.id);
  if (!entry) return res.status(404).json({ error: "Tidak ditemukan" });
  res.json({ success: true, routes: entry.apiRoutes || [] });
});

// ── DELETE /api/scraper/:id/routes/:routeId ───────────────────
app.delete("/api/scraper/:id/routes/:routeId", (req, res) => {
  const entry = registry.getById(req.params.id);
  if (!entry) return res.status(404).json({ error: "Tidak ditemukan" });

  const idx = (entry.apiRoutes || []).findIndex(r => r.id === req.params.routeId);
  if (idx === -1) return res.status(404).json({ error: "Route tidak ditemukan" });

  entry.apiRoutes.splice(idx, 1);
  registry.update(entry.id, entry);
  res.json({ success: true, message: "Route dihapus" });
});

// ── GET /api/routes ───────────────────────────────────────────
// Semua routes dari semua scrapers
app.get("/api/routes", (req, res) => {
  const all = registry.getAll();
  const routes = all.flatMap(s => (s.apiRoutes || []).map(r => ({ ...r, scraperName: s.name })));
  res.json({ success: true, total: routes.length, routes });
});

// ── Helper: Register generated route di Express ───────────────
const registeredPaths = new Set();

function registerGeneratedRoute(route, scraperEntry) {
  const cleanPath = route.path.replace(/\/+$/, "");
  if (registeredPaths.has(cleanPath)) return; // Skip jika sudah ada
  registeredPaths.add(cleanPath);

  const handler = async (req, res) => {
    const params = { ...req.query, ...req.body };
    const fw = await detectFirewall(scraperEntry.url).catch(() => null);
    const extMap = { nodejs: "js", python: "py", php: "php" };
    const runMap = { nodejs: "node scraper.js", python: "python3 scraper.py", php: "php scraper.php" };

    // Auto-fix jika ada error di file terkait (v4 feature)
    let fixNote = null;
    if (scraperEntry.lastFix && scraperEntry.lastFix.appliedAt) {
      const fixAge = Date.now() - new Date(scraperEntry.lastFix.appliedAt).getTime();
      if (fixAge < 60000) {
        fixNote = `Kode sudah auto-fix ${Math.round(fixAge/1000)}s lalu: ${scraperEntry.lastFix.changeLog || ""}`;
      }
    }

    res.json({
      success:        true,
      route:          route.path,
      scraper_id:     scraperEntry.id,
      scraper_name:   scraperEntry.name,
      url_target:     scraperEntry.url,
      target_data:    scraperEntry.target,
      lang:           scraperEntry.lang,
      bypass_mode:    scraperEntry.bypassCF,
      firewall:       fw,
      run_command:    runMap[scraperEntry.lang],
      download_url:   `/api/scraper/${scraperEntry.id}/download`,
      zip_url:        `/api/scraper/${scraperEntry.id}/zip`,
      code_lines:     scraperEntry.code.split("\n").length,
      code_preview:   scraperEntry.code.substring(0, 500) + "...",
      input_params:   params,
      fix_note:       fixNote,
      generated_at:   route.createdAt,
      note:           "Download file kode lalu jalankan di lokal/server/Termux",
    });
  };

  if (route.method === "GET")  app.get(cleanPath,  handler);
  if (route.method === "POST") app.post(cleanPath, handler);

  console.log(`[v4] ✓ Registered: ${route.method} ${cleanPath}`);
}

// ── Re-register semua saved routes saat startup ───────────────
function reRegisterAllRoutes() {
  const all = registry.getAll();
  let count = 0;
  for (const s of all) {
    for (const route of (s.apiRoutes || [])) {
      try {
        registerGeneratedRoute(route, s);
        count++;
      } catch (e) {
        console.error(`[v4] Failed to re-register ${route.path}:`, e.message);
      }
    }
  }
  if (count > 0) console.log(`[v4] Re-registered ${count} API routes`);
}

// Jalankan re-register setelah server start
setTimeout(reRegisterAllRoutes, 100);

// ══════════════════════════════════════════════════════════════
//  v4: AUTO INSTALL DEPENDENCIES
// ══════════════════════════════════════════════════════════════


// ── POST /api/scraper/:id/install ─────────────────────────────
// Install modules — bisa terima custom packages dari AI recommendation
app.post("/api/scraper/:id/install", async (req, res) => {
  const entry = registry.getById(req.params.id);
  if (!entry) return res.status(404).json({ error: "Scraper tidak ditemukan" });

  const { packages: customPackages } = req.body;

  const tmpDir = path.join(os.tmpdir(), `smartscrape-${entry.id.slice(0, 8)}`);
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

  let installCmd = "";
  let packagesInfo = "";

  if (entry.lang === "nodejs") {
    const pkgs = customPackages || (entry.bypassCF
      ? ["puppeteer-extra","puppeteer-extra-plugin-stealth","user-agents","axios","cheerio"]
      : ["axios","cheerio"]);
    const pkgJson = { name:"scraper", version:"1.0.0", dependencies: pkgs.reduce((acc,p) => ({...acc,[p]:"latest"}), {}) };
    fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify(pkgJson, null, 2));
    installCmd   = `cd "${tmpDir}" && npm install 2>&1`;
    packagesInfo = pkgs.join(", ");
  } else if (entry.lang === "python") {
    const pkgs = customPackages || (entry.bypassCF
      ? ["cloudscraper","beautifulsoup4","fake-useragent","lxml","requests"]
      : ["requests","beautifulsoup4","lxml"]);
    fs.writeFileSync(path.join(tmpDir, "requirements.txt"), pkgs.join("\n"));
    installCmd   = `pip install ${pkgs.join(" ")} 2>&1`;
    packagesInfo = pkgs.join(", ");
  } else {
    const pkgs = customPackages || ["guzzlehttp/guzzle"];
    fs.writeFileSync(path.join(tmpDir, "composer.json"), JSON.stringify({ require: pkgs.reduce((a,p)=>({...a,[p]:"*"}),{"php":">=7.4"}) }, null, 2));
    installCmd   = `cd "${tmpDir}" && composer install --no-interaction 2>&1`;
    packagesInfo = pkgs.join(", ");
  }

  exec(installCmd, { timeout: 180000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
    const raw    = stdout + stderr;
    const output = raw.substring(0, 3000);

    if (err && err.code !== 0) {
      const notFound = [];
      if (entry.lang === "python") {
        const matches = raw.match(/No matching distribution found for ([^\s\n]+)/g) || [];
        matches.forEach(m => notFound.push(m.replace("No matching distribution found for ","").trim()));
      }
      return res.json({
        success:       false,
        message:       `Install gagal${notFound.length ? " untuk: " + notFound.join(", ") : ""}. Cek output.`,
        output,
        packages:      packagesInfo,
        auto_fix_hint: `Jalankan manual: ${installCmd}`,
      });
    }

    entry.installedModules = { packages: packagesInfo, installedAt: new Date().toISOString(), lang: entry.lang };
    registry.update(entry.id, entry);

    res.json({
      success:  true,
      message:  `✓ ${packagesInfo} berhasil diinstall untuk ${entry.lang}!`,
      output:   output || "Install selesai.",
      packages: packagesInfo,
      lang:     entry.lang,
    });
  });
});

// ══════════════════════════════════════════════════════════════
//  v4: AUTO FIX API FILE KETIKA ERROR
//  Intercept 500 errors di generated routes dan auto-fix
// ══════════════════════════════════════════════════════════════

// Error handler middleware khusus untuk /api/generated/*
app.use("/api/generated", (err, req, res, next) => {
  if (!err) return next();

  // Cari scraper yang terkait dengan path ini
  const routePath = req.path;
  const all       = registry.getAll();
  let matchedScraper = null;
  let matchedRoute   = null;

  for (const s of all) {
    for (const r of (s.apiRoutes || [])) {
      if (routePath.includes(r.name) || req.originalUrl === r.path) {
        matchedScraper = s;
        matchedRoute   = r;
        break;
      }
    }
    if (matchedScraper) break;
  }

  console.error(`[v4 auto-fix] Error di ${req.originalUrl}:`, err.message);

  res.status(500).json({
    success:     false,
    error:       err.message,
    path:        req.originalUrl,
    scraper_id:  matchedScraper?.id || null,
    auto_fix_hint: matchedScraper
      ? `Gunakan POST /api/scraper/${matchedScraper.id}/fix untuk auto-fix kode`
      : "Tidak ditemukan scraper yang terkait",
    fix_url:     matchedScraper ? `/api/scraper/${matchedScraper.id}/fix` : null,
  });
});

// ── Update /api/docs untuk include generated routes ───────────
// Patch docs endpoint to include apiRoutes
const originalDocsHandler = app._router.stack
  .filter(l => l.route?.path === "/api/docs")
  .pop();

// Override docs endpoint dengan versi v4
app.get("/api/docs/v4", (req, res) => {
  const all   = registry.getAll();
  const allApiRoutes = all.flatMap(s => (s.apiRoutes || []).map(r => ({ ...r, scraperName: s.name })));

  res.json({
    name:           "SmartScrapeAI — API Documentation v4",
    version:        "4.0.0",
    description:    "Auto-generated API docs + Generated Routes dari scraper",
    baseURL:        `${req.protocol}://${req.get("host")}`,
    totalEndpoints: all.length + 18 + allApiRoutes.length,
    generatedRoutes: allApiRoutes,
    generatedRouteCount: allApiRoutes.length,
    scrapers: all.map(s => ({
      id:          s.id,
      name:        s.name,
      url:         s.url,
      target:      s.target,
      lang:        s.lang,
      bypassCF:    s.bypassCF,
      provider:    s.provider,
      model:       s.model,
      fixCount:    s.fixCount || 0,
      createdAt:   s.createdAt,
      updatedAt:   s.updatedAt,
      endpoint:    `/api/scraper/${s.id}`,
      download:    `/api/scraper/${s.id}/download`,
      zip:         `/api/scraper/${s.id}/zip`,
      tryEndpoint: `/api/scraper/${s.id}/try`,
      tryInputs:   s.trySchema,
      apiRoutes:   s.apiRoutes || [],
    })),
    providers: {
      supported: ["anthropic","openai","groq","gemini","deepseek","mistral","xai","together"],
      usage:     "Kirim provider + apiKey di setiap request POST yang butuh AI",
    },
  });
});
