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
const cheerio           = require("cheerio");
const registry          = require("./api/registry");

const app     = express();
const PORT    = process.env.PORT || 8080;
const IS_PROD = process.env.NODE_ENV === "production";

// ── Trust Proxy (Clever Cloud / Nginx / Load Balancer) ────────
// Wajib agar express-rate-limit bisa baca X-Forwarded-For dengan benar
app.set("trust proxy", 1);

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

// ══════════════════════════════════════════════════════════════
//  POST /api/prefetch
//  Fetch URL, parse elemen HTML tanpa CSS, return element list
//  untuk ditampilkan sebagai checkbox di step 0 generator
// ══════════════════════════════════════════════════════════════
app.post("/api/prefetch", async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: "url diperlukan" });

  // Gunakan fetchWithBypass penuh (6 layer) agar bypass firewall otomatis
  const logs = [];
  const log  = (msg) => logs.push(msg);

  let fetchResult;
  try {
    fetchResult = await fetchWithBypass(url, log);
  } catch (e) {
    return res.json({
      success:  false,
      error:    e.message || "Fetch gagal",
      elements: [],
      hint:     "URL tidak bisa diakses. Coba Analisa untuk info lebih lanjut.",
    });
  }

  const html = fetchResult?.html;
  const layer = fetchResult?.layer;

  if (!html) {
    return res.json({
      success:  false,
      error:    fetchResult?.error || "Tidak bisa fetch HTML",
      elements: [],
      hint:     "Semua 6 layer bypass gagal. URL mungkin memerlukan Puppeteer/browser stealth.",
      bypass_logs: logs,
    });
  }

  // ── Smart parse dengan context-aware element detection ─────
  try {
    const $ = cheerio.load(html);
    const siteType = detectSiteType(url, $, html);
    const pageInfo = detectPageType(url);
    const elements = detectSmartElements(url, $, html, siteType);

    // Merge scraper suggestions: URL-based + site-type based
    const siteSuggestions = getScraperSuggestions(siteType, elements);
    const urlSuggestions  = pageInfo.suggestions || [];
    // URL-based suggestions are more specific — put them first
    const allSuggestions  = [
      ...urlSuggestions,
      ...siteSuggestions.filter(s => !urlSuggestions.some(u => u.label === s.label)),
    ].slice(0, 8);

    const host  = (() => { try { return new URL(url).hostname.replace("www.", ""); } catch { return url; } })();
    const title = (() => { try { return $("title").first().text().trim().substring(0, 100); } catch { return ""; } })();

    const smartSelectors = elements
      .filter(e => e.selector && e.selector !== "meta")
      .slice(0, 6)
      .map(e => ({ category: e.category, selector: e.selector, label: e.label }));

    res.json({
      success:            true,
      url,
      host,
      title,
      layer,
      siteType,
      pageType:           pageInfo.pageType,
      platform:           pageInfo.platform || null,
      pageHint:           pageInfo.hint || null,
      searchQuery:        pageInfo.searchQuery || null,
      scraperSuggestions: allSuggestions,
      smartSelectors,
      elementCount:       elements.reduce((a, e) => a + e.count, 0),
      categories:         [...new Set(elements.map(e => e.category))],
      elements,
    });
  } catch (parseErr) {
    res.json({
      success: false,
      error:   `Parse error: ${parseErr.message}`,
      elements: [],
    });
  }
});

// ══════════════════════════════════════════════════════════════
//  SMART URL PAGE TYPE DETECTOR
//  Deteksi jenis halaman dari URL pattern sebelum fetch
// ══════════════════════════════════════════════════════════════
function detectPageType(urlStr) {
  let parsed;
  try { parsed = new URL(urlStr); } catch { return { pageType: "unknown", hints: [] }; }

  const host    = parsed.hostname.toLowerCase().replace("www.", "");
  const path    = parsed.pathname.toLowerCase();
  const query   = parsed.searchParams;
  const fullUrl = urlStr.toLowerCase();

  // ── KNOWN DOMAINS ─────────────────────────────────────────
  const knownDomains = {
    // Social
    "x.com": "twitter", "twitter.com": "twitter",
    "instagram.com": "instagram", "tiktok.com": "tiktok",
    "facebook.com": "facebook", "linkedin.com": "linkedin",
    "youtube.com": "youtube", "reddit.com": "reddit",
    // Ecommerce
    "tokopedia.com": "ecommerce", "shopee.co.id": "ecommerce",
    "lazada.co.id": "ecommerce", "blibli.com": "ecommerce",
    "amazon.com": "ecommerce", "bukalapak.com": "ecommerce",
    // News
    "kompas.com": "news", "detik.com": "news", "tribunnews.com": "news",
    "cnbcindonesia.com": "news", "liputan6.com": "news",
    "kumparan.com": "news", "tempo.co": "news",
    // Jobs
    "linkedin.com/jobs": "jobs", "jobstreet.co.id": "jobs",
    "glints.com": "jobs", "kalibrr.com": "jobs",
  };

  for (const [d, type] of Object.entries(knownDomains)) {
    if (host.includes(d) || fullUrl.includes(d)) {
      return detectSocialPageType(type, parsed);
    }
  }

  return detectGenericPageType(parsed);
}

function detectSocialPageType(domain, parsed) {
  const path  = parsed.pathname.toLowerCase();
  const query = parsed.searchParams;
  const host  = parsed.hostname.toLowerCase();

  // ── TWITTER / X ───────────────────────────────────────────
  if (domain === "twitter") {
    if (query.has("q") || path.includes("/search")) {
      const q = query.get("q") || "";
      return {
        pageType: "search",
        platform: "twitter",
        searchQuery: q,
        suggestions: [
          { label: "🔍 Hasil Pencarian Tweet", desc: `Scrape tweet hasil pencarian "${q || "query"}" — teks, user, likes, retweets, tanggal` },
          { label: "📊 Trending Topics", desc: "Scrape topik trending dari hasil search — hashtag, jumlah tweet" },
          { label: "👤 User dari Hasil Search", desc: "Kumpulkan profil user yang muncul di hasil pencarian" },
        ],
        hint: query.has("q") ? `Pencarian Twitter/X untuk: "${q}"` : "Halaman search Twitter/X",
      };
    }
    if (path.match(/^\/[^/]+\/status\/\d+/)) {
      return {
        pageType: "post",
        platform: "twitter",
        suggestions: [
          { label: "🐦 Detail Tweet", desc: "Scrape tweet: teks lengkap, user, likes, retweets, replies, tanggal, media" },
          { label: "💬 Semua Reply/Komentar", desc: "Kumpulkan semua balasan dari thread tweet ini" },
        ],
        hint: "Halaman detail tweet/post",
      };
    }
    if (path.includes("/trending") || path.includes("/explore")) {
      return {
        pageType: "trending",
        platform: "twitter",
        suggestions: [
          { label: "🔥 Trending Topics", desc: "Scrape semua topik trending: hashtag, jumlah tweet, kategori" },
          { label: "💡 Trending News", desc: "Kumpulkan berita trending yang sedang ramai dibahas" },
        ],
        hint: "Halaman trending/explore Twitter",
      };
    }
    if (path.match(/^\/[^/]+\/followers/) || path.match(/^\/[^/]+\/following/)) {
      return {
        pageType: "followers",
        platform: "twitter",
        suggestions: [
          { label: "👥 Daftar Followers/Following", desc: "Scrape daftar followers/following: username, nama, bio, verified status" },
        ],
        hint: "Halaman followers/following",
      };
    }
    if (path.match(/^\/[^/]+$/) && path.length > 1) {
      const username = path.replace("/", "");
      return {
        pageType: "profile",
        platform: "twitter",
        suggestions: [
          { label: `📋 Semua Tweet @${username}`, desc: "Scrape timeline tweet: teks, tanggal, likes, retweets, media URL" },
          { label: `👤 Profil @${username}`, desc: "Scrape info profil: nama, bio, followers, following, lokasi, join date" },
          { label: "📌 Pinned Tweet", desc: "Ambil tweet yang di-pin + semua tweet terbaru" },
        ],
        hint: `Profil Twitter/X: @${username}`,
      };
    }
    return {
      pageType: "home",
      platform: "twitter",
      suggestions: [
        { label: "🏠 Tweet dari Home Timeline", desc: "Scrape tweet dari feed utama — teks, user, engagement" },
        { label: "🔥 Trending Saat Ini", desc: "Scrape topik trending di sidebar kanan" },
      ],
      hint: "Halaman utama Twitter/X (home feed)",
    };
  }

  // ── INSTAGRAM ─────────────────────────────────────────────
  if (domain === "instagram") {
    if (query.has("q") || path.includes("/explore/search")) {
      const q = query.get("q") || "";
      return {
        pageType: "search", platform: "instagram",
        suggestions: [
          { label: "🔍 Hasil Pencarian Instagram", desc: `Cari akun/hashtag/tempat: "${q || "query"}"` },
          { label: "#️⃣ Hasil Hashtag", desc: "Scrape post dari hashtag tertentu: gambar, caption, likes, komentar" },
        ],
        hint: `Pencarian Instagram: "${q}"`,
      };
    }
    if (path.includes("/explore")) {
      return {
        pageType: "explore", platform: "instagram",
        suggestions: [
          { label: "🔥 Post Trending/Explore", desc: "Scrape post populer dari halaman Explore: gambar, likes, user" },
          { label: "#️⃣ Explore by Hashtag", desc: "Kumpulkan post berdasarkan hashtag trending" },
        ],
        hint: "Halaman Explore Instagram",
      };
    }
    if (path.match(/^\/p\//) || path.match(/^\/reel\//)) {
      return {
        pageType: "post", platform: "instagram",
        suggestions: [
          { label: "📸 Detail Post/Reel", desc: "Scrape detail post: caption, likes, komentar, user, media URL, tanggal" },
          { label: "💬 Semua Komentar", desc: "Kumpulkan semua komentar beserta username dan likes komentar" },
        ],
        hint: "Halaman detail post Instagram",
      };
    }
    if (path.match(/^\/[^/]+\/?$/)) {
      const username = path.replace(/\//g, "");
      return {
        pageType: "profile", platform: "instagram",
        suggestions: [
          { label: `📸 Semua Post @${username}`, desc: "Scrape grid post: URL gambar, caption, likes, komentar count, tanggal" },
          { label: `👤 Profil @${username}`, desc: "Scrape info profil: nama, bio, followers, following, jumlah post" },
          { label: "🎬 Semua Reels", desc: "Kumpulkan semua Reels dari profil ini" },
        ],
        hint: `Profil Instagram: @${username}`,
      };
    }
  }

  // ── TIKTOK ─────────────────────────────────────────────────
  if (domain === "tiktok") {
    if (query.has("q") || path.includes("/search")) {
      const q = query.get("q") || "";
      return {
        pageType: "search", platform: "tiktok",
        suggestions: [
          { label: "🔍 Video dari Search TikTok", desc: `Scrape video hasil pencarian "${q}" — judul, views, likes, link` },
          { label: "👤 User dari Search", desc: "Kumpulkan profil TikToker dari hasil pencarian" },
        ],
        hint: `Pencarian TikTok: "${q}"`,
      };
    }
    if (path.includes("/foryou") || path === "/" || path === "") {
      return {
        pageType: "home", platform: "tiktok",
        suggestions: [
          { label: "🔥 Video For You / Trending", desc: "Scrape video trending FYP: judul, creator, likes, share, sound" },
          { label: "🏷️ Trending Hashtag", desc: "Kumpulkan hashtag yang sedang trending beserta jumlah video" },
        ],
        hint: "Halaman utama TikTok (For You Page)",
      };
    }
    if (path.match(/^\/tag\//)) {
      const tag = path.replace("/tag/", "");
      return {
        pageType: "hashtag", platform: "tiktok",
        suggestions: [
          { label: `#️⃣ Video Hashtag #${tag}`, desc: `Scrape semua video dengan hashtag #${tag}: views, likes, creator` },
        ],
        hint: `Halaman hashtag TikTok: #${tag}`,
      };
    }
    if (path.match(/^\/@[^/]+\/?$/)) {
      const username = path.replace("/@", "").replace("/", "");
      return {
        pageType: "profile", platform: "tiktok",
        suggestions: [
          { label: `🎬 Semua Video @${username}`, desc: "Scrape daftar video: judul/caption, views, likes, komentar, tanggal, link" },
          { label: `👤 Profil @${username}`, desc: "Scrape info profil: nama, bio, followers, following, total likes" },
        ],
        hint: `Profil TikTok: @${username}`,
      };
    }
  }

  // ── YOUTUBE ────────────────────────────────────────────────
  if (domain === "youtube") {
    if (query.has("search_query")) {
      const q = query.get("search_query") || "";
      return {
        pageType: "search", platform: "youtube",
        suggestions: [
          { label: `🔍 Video dari Search "${q}"`, desc: "Scrape hasil pencarian: judul, channel, views, durasi, tanggal, link" },
          { label: "📺 Channel dari Search", desc: "Kumpulkan channel YouTube yang muncul di hasil pencarian" },
        ],
        hint: `Pencarian YouTube: "${q}"`,
      };
    }
    if (query.has("v")) {
      return {
        pageType: "video", platform: "youtube",
        suggestions: [
          { label: "▶️ Detail Video YouTube", desc: "Scrape info video: judul, channel, views, likes, deskripsi, tanggal upload" },
          { label: "💬 Semua Komentar", desc: "Kumpulkan komentar: teks, user, likes komentar, tanggal" },
        ],
        hint: `Halaman video YouTube: ${query.get("v")}`,
      };
    }
    if (path.startsWith("/trending") || path.startsWith("/feed/trending")) {
      return {
        pageType: "trending", platform: "youtube",
        suggestions: [
          { label: "🔥 Video Trending YouTube", desc: "Scrape video trending: judul, channel, views, ranking" },
        ],
        hint: "Halaman Trending YouTube",
      };
    }
    if (path.match(/^\/(c\/|channel\/|@)/)) {
      return {
        pageType: "channel", platform: "youtube",
        suggestions: [
          { label: "📺 Semua Video Channel", desc: "Scrape daftar video: judul, views, tanggal, durasi, link" },
          { label: "👤 Info Channel", desc: "Scrape detail channel: nama, deskripsi, subscribers, jumlah video" },
          { label: "📋 Playlist Channel", desc: "Kumpulkan semua playlist yang ada di channel ini" },
        ],
        hint: "Halaman channel YouTube",
      };
    }
  }

  // ── REDDIT ─────────────────────────────────────────────────
  if (domain === "reddit") {
    if (query.has("q") || path.includes("/search")) {
      const q = query.get("q") || "";
      return {
        pageType: "search", platform: "reddit",
        suggestions: [
          { label: `🔍 Post dari Search "${q}"`, desc: "Scrape hasil pencarian Reddit: judul, subreddit, upvotes, komentar, link" },
        ],
        hint: `Pencarian Reddit: "${q}"`,
      };
    }
    if (path.match(/^\/r\/[^/]+\/comments\//)) {
      return {
        pageType: "post", platform: "reddit",
        suggestions: [
          { label: "📝 Detail Post Reddit", desc: "Scrape post: judul, isi, upvotes, awards, subreddit, user" },
          { label: "💬 Semua Komentar", desc: "Kumpulkan thread komentar: user, teks, upvotes, nested replies" },
        ],
        hint: "Halaman detail post Reddit",
      };
    }
    if (path.match(/^\/r\/[^/]+\/?$/)) {
      const sub = path.replace(/\//g, " ").trim().split(" ").pop();
      return {
        pageType: "subreddit", platform: "reddit",
        suggestions: [
          { label: `📋 Post Terbaru r/${sub}`, desc: "Scrape daftar post: judul, upvotes, komentar count, user, tanggal, link" },
          { label: `🔥 Post Hot/Top r/${sub}`, desc: "Ambil post terpopuler dari subreddit ini" },
          { label: "ℹ️ Info Subreddit", desc: "Scrape deskripsi, subscribers, rules, moderators" },
        ],
        hint: `Subreddit: r/${sub}`,
      };
    }
  }

  // ── ECOMMERCE ──────────────────────────────────────────────
  if (domain === "ecommerce") {
    if (query.has("q") || query.has("search") || query.has("keyword") || path.includes("/search")) {
      const q = query.get("q") || query.get("search") || query.get("keyword") || "";
      return {
        pageType: "search", platform: "ecommerce",
        suggestions: [
          { label: `🔍 Produk "${q}"`, desc: `Scrape hasil pencarian produk "${q}": nama, harga, rating, toko, link` },
          { label: "💰 Harga Terendah-Tertinggi", desc: "Bandingkan harga semua produk di hasil pencarian" },
        ],
        hint: `Pencarian produk: "${q}"`,
      };
    }
    if (path.includes("/category") || path.includes("/kategori") || path.includes("/c/")) {
      return {
        pageType: "category", platform: "ecommerce",
        suggestions: [
          { label: "🗂️ Semua Produk Kategori", desc: "Scrape semua produk dalam kategori ini: nama, harga, rating, gambar" },
          { label: "📄 Multi-halaman", desc: "Scrape semua halaman kategori dengan auto-pagination" },
        ],
        hint: "Halaman kategori produk",
      };
    }
    if (path.includes("/product") || path.includes("/p/") || path.includes("/item/")) {
      return {
        pageType: "product_detail", platform: "ecommerce",
        suggestions: [
          { label: "📦 Detail Produk Lengkap", desc: "Scrape semua info: nama, harga, stok, deskripsi, spesifikasi, gambar, seller" },
          { label: "⭐ Review & Rating", desc: "Kumpulkan semua review: bintang, komentar, foto review, tanggal" },
        ],
        hint: "Halaman detail produk",
      };
    }
  }

  return detectGenericPageType(parsed);
}

function detectGenericPageType(parsed) {
  const path  = parsed.pathname.toLowerCase();
  const query = parsed.searchParams;
  const host  = parsed.hostname.toLowerCase().replace("www.", "");

  // Generic search page
  const searchParams = ["q", "query", "search", "s", "keyword", "k", "term", "find", "cari"];
  const foundSearchParam = searchParams.find(p => query.has(p));
  if (foundSearchParam) {
    const q = query.get(foundSearchParam) || "";
    return {
      pageType: "search",
      searchQuery: q,
      searchParam: foundSearchParam,
      suggestions: [
        { label: `🔍 Hasil Pencarian "${q}"`, desc: `Scrape semua hasil pencarian untuk query "${q}" dari ${host}` },
        { label: "📄 Multi-halaman Hasil Search", desc: "Scrape hasil search di semua halaman dengan auto-pagination" },
        { label: "🔗 Link dari Hasil Search", desc: "Kumpulkan semua URL hasil pencarian untuk di-crawl lebih lanjut" },
      ],
      hint: `Halaman hasil pencarian: "${q}" (param: ${foundSearchParam})`,
    };
  }

  // Pagination/category page
  const pageParam = ["page", "p", "hal", "pg"].find(p => query.has(p));
  if (pageParam) {
    const pageNum = query.get(pageParam);
    return {
      pageType: "paginated",
      suggestions: [
        { label: "📄 Scrape Halaman Ini", desc: `Scrape konten halaman ${pageNum} saat ini` },
        { label: "📚 Scrape Semua Halaman", desc: "Auto-pagination: scrape dari halaman 1 sampai selesai" },
      ],
      hint: `Halaman paginasi (halaman ${pageNum})`,
    };
  }

  // Detail page (URL dengan ID/slug)
  if (path.match(/\/\d+/) || path.match(/\/[a-z0-9-]{8,}\/$/)) {
    return {
      pageType: "detail",
      suggestions: [
        { label: "📋 Konten Detail Halaman", desc: "Scrape semua konten dari halaman detail ini" },
        { label: "🔗 Link Terkait", desc: "Kumpulkan link ke halaman terkait/related content" },
      ],
      hint: "Kemungkinan halaman detail (ada ID/slug di URL)",
    };
  }

  // Homepage
  if (path === "/" || path === "") {
    return {
      pageType: "home",
      suggestions: [
        { label: "🏠 Konten Halaman Utama", desc: `Scrape konten utama homepage ${host}` },
        { label: "🔗 Semua Link Navigasi", desc: "Kumpulkan struktur navigasi dan link penting di homepage" },
        { label: "📢 Konten Featured/Banner", desc: "Scrape konten yang di-highlight di halaman utama" },
      ],
      hint: `Homepage: ${host}`,
    };
  }

  return { pageType: "general", suggestions: [], hint: "" };
}


function detectSiteType(url, $, htmlRaw) {
  const host  = (() => { try { return new URL(url).hostname.toLowerCase(); } catch { return url.toLowerCase(); } })();
  const title = $("title").first().text().toLowerCase();
  const meta  = ($("meta[name='description']").attr("content") || "").toLowerCase();
  const bodyTxt = ($("body").text() || "").toLowerCase().substring(0, 8000);
  const allText = `${host} ${title} ${meta} ${bodyTxt}`;
  const htmlLow = (htmlRaw || "").substring(0, 30000).toLowerCase();
  const ogType  = ($("meta[property='og:type']").attr("content") || "").toLowerCase();

  const score = { streaming:0, ecommerce:0, news:0, forum:0, jobs:0, social:0, general:0 };

  // ── Streaming / Film ─────────────────────────────────────────
  ["nonton","streaming","film","movie","series","episode","anime","drama","subtitle",
   "cinema","rebahin","lk21","indoxxi","loklok","ganool","subscene","watch online",
   "download film","sinopsis","trailer","season","episodes","imdb"].forEach(k => {
    if (allText.includes(k)) score.streaming += 2;
  });
  if ($("[class*='movie'],[class*='film'],[class*='episode'],[class*='poster'],[class*='series']").length > 2) score.streaming += 6;
  if (ogType.includes("video") || ogType.includes("movie")) score.streaming += 10;
  if (/nonton|streaming|film|movie|episode|anime/i.test(host)) score.streaming += 8;

  // ── Ecommerce ────────────────────────────────────────────────
  ["harga","price","cart","keranjang","checkout","beli","buy","produk","product",
   "tokopedia","shopee","lazada","blibli","amazon","toko","shop","store","diskon"].forEach(k => {
    if (allText.includes(k)) score.ecommerce += 2;
  });
  if ($("[class*='product'],[class*='price'],[class*='cart'],[class*='shop']").length > 2) score.ecommerce += 6;
  if (ogType.includes("product")) score.ecommerce += 10;

  // ── News / Blog ──────────────────────────────────────────────
  ["berita","news","artikel","article","headline","reporter","redaksi","publish",
   "kompas","detik","tribun","cnbc","liputan","kumparan","tirto","tempo","republika"].forEach(k => {
    if (allText.includes(k)) score.news += 2;
  });
  if ($("article,.article,.post,.news-item,.news-card").length > 2) score.news += 6;
  if (ogType.includes("article")) score.news += 10;

  // ── Forum ────────────────────────────────────────────────────
  ["forum","thread","reply","diskusi","discussion","kaskus","topik","subforum"].forEach(k => {
    if (allText.includes(k)) score.forum += 2;
  });
  if ($(".thread,.post,.reply,.forum-item").length > 2) score.forum += 6;

  // ── Social ───────────────────────────────────────────────────
  ["followers","following","likes","retweet","post","tweet","profile","feed"].forEach(k => {
    if (allText.includes(k)) score.social += 2;
  });

  // ── Jobs ─────────────────────────────────────────────────────
  ["lowongan","kerja","job","vacancy","career","hiring","loker","gaji","salary"].forEach(k => {
    if (allText.includes(k)) score.jobs += 2;
  });

  const best = Object.entries(score).sort((a, b) => b[1] - a[1])[0];
  return best[1] >= 3 ? best[0] : "general";
}

// ══════════════════════════════════════════════════════════════
//  SMART ELEMENT DETECTOR — Context-aware per site type
// ══════════════════════════════════════════════════════════════
function detectSmartElements(url, $, htmlRaw, siteType) {
  const elements = [];
  const host = (() => { try { return new URL(url).hostname; } catch { return url; } })();

  // ── Helper: find best repeating card selector ──────────────
  function findCardSelector(patterns) {
    for (const sel of patterns) {
      try {
        const count = $(sel).length;
        if (count >= 3) return { sel, count };
      } catch {}
    }
    return null;
  }

  function extractCardData(sel, maxItems = 5) {
    const samples = [];
    $(sel).slice(0, maxItems).each((_, el) => {
      const title  = $(el).find("h1,h2,h3,h4,[class*='title'],[class*='name'],[class*='judul']").first().text().trim();
      const img    = $(el).find("img").first().attr("src") || $(el).find("img").first().attr("data-src") || "";
      const link   = $(el).find("a[href]").first().attr("href") || "";
      const rating = $(el).find("[class*='rating'],[class*='imdb'],[class*='score'],[class*='vote']").first().text().trim();
      const year   = $(el).find("[class*='year'],[class*='tahun']").first().text().trim() ||
                     (title.match(/\((\d{4})\)/) || [])[1] || "";
      const info   = [title, year, rating].filter(Boolean).join(" | ");
      if (info.length > 2) samples.push(info.substring(0, 120));
    });
    return samples;
  }

  // ── STREAMING SITE ──────────────────────────────────────────
  if (siteType === "streaming") {
    // 1. Movie/video card list
    const cardPatterns = [
      "[class*='movie-item']","[class*='film-item']","[class*='video-item']",
      "[class*='movie-card']","[class*='film-card']","[class*='video-card']",
      "[class*='movie_item']","[class*='film_item']",
      "[class*='post-item']","[class*='item-film']",
      ".movies li","#movies li",".film-list li",
      "[class*='grid'] article","[class*='list'] article",
      "article[class*='movie']","article[class*='film']",
      ".content-film li", ".daftar-film li",
      "ul.film > li", "ul.movies > li",
      // Fallback: any repeating article/li with poster image
      ".main li:has(img)", ".content li:has(img)",
    ];
    const card = findCardSelector(cardPatterns);
    if (card) {
      const samples = extractCardData(card.sel);
      const selShort = card.sel.substring(0, 50);
      elements.push({
        category: "movies",
        label: `Daftar Film/Video (${card.count} item)`,
        selector: card.sel,
        preview: samples.length ? samples : [`${card.count} kartu film ditemukan`],
        count: card.count,
        target: `daftar film/video: judul, tahun, poster URL, rating, link detail — selector: ${selShort}`,
        priority: 10,
      });
    }

    // 2. Series/Episode list
    const epPatterns = [
      "[class*='episode']","[class*='eps']","[class*='season']",
      ".episode-list li","#episode li","[class*='list-eps']",
      "[class*='episode_list']","[class*='episodelist']",
    ];
    const ep = findCardSelector(epPatterns);
    if (ep) {
      const samples = [];
      $(ep.sel).slice(0, 5).each((_, el) => {
        const txt = $(el).text().replace(/\s+/g, " ").trim().substring(0, 100);
        if (txt.length > 2) samples.push(txt);
      });
      elements.push({
        category: "episodes",
        label: `Daftar Episode (${ep.count} episode)`,
        selector: ep.sel,
        preview: samples,
        count: ep.count,
        target: `daftar episode: nomor episode, judul episode, link streaming — selector: ${ep.sel.substring(0, 50)}`,
        priority: 9,
      });
    }

    // 3. Genre / Category navigation
    const genrePatterns = [
      "[class*='genre'] a","[class*='category'] a","[class*='kategori'] a",
      "nav a[href*='genre']","nav a[href*='category']","a[href*='/genre/']",
      "[class*='genre-list'] a","[class*='cat-list'] a",
    ];
    const genres = [];
    for (const sel of genrePatterns) {
      try {
        $(sel).slice(0, 10).each((_, el) => {
          const txt = $(el).text().trim();
          if (txt.length > 1 && txt.length < 40) genres.push(txt);
        });
        if (genres.length >= 3) break;
      } catch {}
    }
    if (genres.length >= 2) {
      elements.push({
        category: "genres",
        label: `Genre / Kategori (${genres.length} genre)`,
        selector: genrePatterns.find(s => { try { return $(s).length >= 2; } catch { return false; } }) || "nav a",
        preview: genres.slice(0, 5),
        count: genres.length,
        target: `daftar genre/kategori: nama genre dan URL linknya`,
        priority: 7,
      });
    }

    // 4. Latest / Featured section
    const latestPatterns = [
      "[class*='latest']","[class*='terbaru']","[class*='recent']","[class*='new']",
      "[class*='featured']","[class*='trending']","[class*='popular']","[class*='populer']",
      "#latest","#terbaru","#featured","#trending",
    ];
    for (const sel of latestPatterns) {
      try {
        const el = $(sel).first();
        if (!el.length) continue;
        const items = el.find("a[href]");
        if (items.length >= 3) {
          const samples = [];
          items.slice(0, 5).each((_, a) => {
            const txt = $(a).text().trim();
            if (txt.length > 1) samples.push(txt.substring(0, 80));
          });
          elements.push({
            category: "latest",
            label: `Film/Video Terbaru (${items.length} item)`,
            selector: sel,
            preview: samples,
            count: items.length,
            target: `film/video terbaru: judul, URL detail, poster, tahun rilis`,
            priority: 8,
          });
          break;
        }
      } catch {}
    }

    // 5. Search functionality
    const searchInput = $("input[name*='search'],input[name*='s'],input[placeholder*='cari'],input[placeholder*='search'],input[type='search']").first();
    if (searchInput.length) {
      const formAction = searchInput.closest("form").attr("action") || "";
      elements.push({
        category: "search",
        label: `Fungsi Pencarian`,
        selector: "input[type='search'], form[role='search']",
        preview: [`Form pencarian ditemukan${formAction ? ` — action: ${formAction}` : ""}`],
        count: 1,
        target: `scraper pencarian: kirim query ke form search, ambil hasil pencarian`,
        priority: 6,
      });
    }

    // 6. Video player / embed URL
    const playerPatterns = [
      "iframe[src*='player']","iframe[src*='embed']","iframe[src*='video']",
      "[class*='player']","[class*='embed']","video[src]","video source[src]",
      "[data-src*='player']","[data-embed]",
    ];
    for (const sel of playerPatterns) {
      try {
        const el = $(sel).first();
        if (el.length) {
          const src = el.attr("src") || el.attr("data-src") || "(embedded)";
          elements.push({
            category: "player",
            label: `Video Player / Embed`,
            selector: sel,
            preview: [`Embed URL: ${src.substring(0, 100)}`],
            count: 1,
            target: `URL embed video player, source video, link streaming langsung`,
            priority: 9,
          });
          break;
        }
      } catch {}
    }

    // 7. Film detail page detection
    const synopsisPatterns = [
      "[class*='synopsis'],[class*='sinopsis']","[class*='description'],[class*='deskripsi']",
      "[class*='detail'] p","[class*='overview']",".entry-content p",
    ];
    for (const sel of synopsisPatterns) {
      try {
        const el = $(sel).first();
        if (el.length && el.text().trim().length > 50) {
          const detailFields = [];
          const infoPatterns = ["[class*='genre']","[class*='year'],[class*='tahun']","[class*='director'],[class*='sutradara']",
            "[class*='cast'],[class*='pemain']","[class*='rating'],[class*='imdb']","[class*='duration'],[class*='durasi']"];
          infoPatterns.forEach(p => { try { if ($(p).length) detailFields.push(p); } catch {} });
          elements.push({
            category: "detail",
            label: `Detail Film/Video`,
            selector: "[class*='detail'],[class*='single'],[class*='post-content']",
            preview: [
              el.text().trim().substring(0, 120) + "…",
              ...(detailFields.length ? [`Field: ${detailFields.slice(0,3).join(", ")}`] : []),
            ],
            count: 1,
            target: `detail film lengkap: sinopsis, genre, tahun, sutradara, pemain, rating IMDB, durasi, poster`,
            priority: 8,
          });
          break;
        }
      } catch {}
    }

  // ── ECOMMERCE SITE ──────────────────────────────────────────
  } else if (siteType === "ecommerce") {
    const cardPatterns = [
      "[class*='product-item']","[class*='product-card']","[class*='product_item']",
      "[class*='item-product']",".products li",".product-list li",
      "[class*='grid'] [class*='product']","[class*='card']",
    ];
    const card = findCardSelector(cardPatterns);
    if (card) {
      const samples = [];
      $(card.sel).slice(0, 5).each((_, el) => {
        const name  = $(el).find("[class*='name'],[class*='title'],[class*='product-name']").first().text().trim();
        const price = $(el).find("[class*='price'],[class*='harga']").first().text().trim();
        const info  = [name, price].filter(Boolean).join(" — ");
        if (info.length > 2) samples.push(info.substring(0, 100));
      });
      elements.push({
        category: "products",
        label: `Daftar Produk (${card.count} item)`,
        selector: card.sel,
        preview: samples.length ? samples : [`${card.count} produk ditemukan`],
        count: card.count,
        target: `daftar produk: nama produk, harga, rating, gambar, link detail`,
        priority: 10,
      });
    }
    // Price elements
    const prices = [];
    $("[class*='price'],[class*='harga']").slice(0, 8).each((_, el) => {
      const txt = $(el).text().trim();
      if (txt.length > 0 && txt.length < 50) prices.push(txt);
    });
    if (prices.length >= 2) {
      elements.push({
        category: "prices",
        label: `Harga Produk (${prices.length} harga)`,
        selector: "[class*='price'],[class*='harga']",
        preview: prices.slice(0, 4),
        count: prices.length,
        target: `harga produk: harga normal, harga diskon, persentase diskon`,
        priority: 9,
      });
    }
    // Categories
    const cats = [];
    $("[class*='category'] a,[class*='kategori'] a,nav[class*='cat'] a").slice(0, 10).each((_, el) => {
      const txt = $(el).text().trim();
      if (txt.length > 1 && txt.length < 50) cats.push(txt);
    });
    if (cats.length >= 2) {
      elements.push({
        category: "categories",
        label: `Kategori (${cats.length})`,
        selector: "[class*='category'] a,[class*='kategori'] a",
        preview: cats.slice(0, 5),
        count: cats.length,
        target: `daftar kategori produk dengan nama dan URL link`,
        priority: 7,
      });
    }

  // ── NEWS SITE ───────────────────────────────────────────────
  } else if (siteType === "news") {
    const cardPatterns = [
      "article","[class*='article-item']","[class*='news-item']","[class*='post-item']",
      "[class*='card-news']","[class*='news-card']",".list-news li",".articles li",
    ];
    const card = findCardSelector(cardPatterns);
    if (card) {
      const samples = [];
      $(card.sel).slice(0, 5).each((_, el) => {
        const title = $(el).find("h1,h2,h3,h4,[class*='title']").first().text().trim();
        const date  = $(el).find("[class*='date'],[class*='time'],time").first().text().trim();
        const info  = [title, date].filter(Boolean).join(" | ");
        if (info.length > 2) samples.push(info.substring(0, 120));
      });
      elements.push({
        category: "articles",
        label: `Daftar Artikel (${card.count} artikel)`,
        selector: card.sel,
        preview: samples.length ? samples : [`${card.count} artikel ditemukan`],
        count: card.count,
        target: `daftar artikel/berita: judul, tanggal publish, penulis, kategori, link, thumbnail`,
        priority: 10,
      });
    }
    // Article detail
    const content = $("article .content, .article-body, .post-content, [class*='article-content']").first();
    if (content.length && content.text().trim().length > 100) {
      elements.push({
        category: "article_detail",
        label: `Isi Artikel Lengkap`,
        selector: "article, .article-body, .post-content",
        preview: [content.text().trim().substring(0, 150) + "…"],
        count: 1,
        target: `detail artikel: judul, isi lengkap, penulis, tanggal, kategori, gambar`,
        priority: 9,
      });
    }

  // ── FORUM ───────────────────────────────────────────────────
  } else if (siteType === "forum") {
    const threadPatterns = [
      "[class*='thread']","[class*='topic']","[class*='post']",
      ".thread-list li",".forum-list li",
    ];
    const card = findCardSelector(threadPatterns);
    if (card) {
      const samples = [];
      $(card.sel).slice(0, 5).each((_, el) => {
        const txt = $(el).find("h1,h2,h3,[class*='title']").first().text().trim() ||
                    $(el).text().replace(/\s+/g, " ").trim();
        if (txt.length > 2) samples.push(txt.substring(0, 100));
      });
      elements.push({
        category: "threads",
        label: `Daftar Thread/Topik (${card.count})`,
        selector: card.sel,
        preview: samples,
        count: card.count,
        target: `daftar thread: judul topik, penulis, jumlah balasan, tanggal, link`,
        priority: 10,
      });
    }
  }

  // ── UNIVERSAL ELEMENTS (semua site type) ─────────────────────
  // Pagination
  const pagePatterns = ["[class*='pagination']","[class*='paging']","[class*='page-nav']",
    "nav[aria-label*='page']",".wp-pagenavi","[class*='nextpage']"];
  for (const sel of pagePatterns) {
    try {
      if ($(sel).length) {
        const links = $(sel).find("a").map((_, el) => $(el).text().trim()).get().filter(Boolean).slice(0, 5);
        elements.push({
          category: "pagination",
          label: `Pagination / Halaman Berikutnya`,
          selector: sel,
          preview: links.length ? links : ["Pagination ditemukan"],
          count: $(sel).find("a").length,
          target: `navigasi halaman: URL halaman berikutnya/sebelumnya untuk scraping multi-halaman`,
          priority: 5,
        });
        break;
      }
    } catch {}
  }

  // Meta / SEO data (always useful)
  const metas = [];
  $("meta[name],meta[property]").each((_, el) => {
    const name = $(el).attr("name") || $(el).attr("property") || "";
    const content = $(el).attr("content") || "";
    if (name && content && content.length > 2 && !name.includes("viewport") && !name.includes("charset")) {
      metas.push(`${name}: ${content.substring(0, 80)}`);
    }
  });
  if (metas.length) {
    elements.push({
      category: "meta",
      label: `Meta / SEO Data (${metas.length} tag)`,
      selector: "meta",
      preview: metas.slice(0, 4),
      count: metas.length,
      target: `meta tags: og:title, og:image, og:description, keywords untuk SEO data`,
      priority: 3,
    });
  }

  // JSON-LD structured data
  const jsonLds = [];
  $("script[type='application/ld+json']").each((_, el) => {
    try {
      const obj = JSON.parse($(el).text().trim());
      jsonLds.push(obj["@type"] || "Unknown");
    } catch {}
  });
  if (jsonLds.length) {
    elements.push({
      category: "structured",
      label: `JSON-LD Structured Data (${jsonLds.length})`,
      selector: "script[type='application/ld+json']",
      preview: jsonLds,
      count: jsonLds.length,
      target: `JSON-LD: ${jsonLds.join(", ")} — data terstruktur berkualitas tinggi`,
      priority: 8,
    });
  }

  // Sort by priority descending
  elements.sort((a, b) => (b.priority || 0) - (a.priority || 0));
  return elements;
}

// ══════════════════════════════════════════════════════════════
//  SMART SCRAPER SUGGESTIONS — per site type
// ══════════════════════════════════════════════════════════════
function getScraperSuggestions(siteType, elements) {
  const byCategory = {};
  elements.forEach(e => { byCategory[e.category] = e; });

  const suggestions = {
    streaming: [
      { label: "🎬 Daftar Film/Video Terbaru", desc: "Scrape semua film di halaman utama: judul, poster, tahun, genre, rating, link detail" },
      { label: "🎭 Detail Film Lengkap", desc: "Scrape halaman detail film: sinopsis, genre, tahun, sutradara, pemain, rating IMDB, embed URL" },
      { label: "📺 Daftar Episode Serial", desc: "Scrape semua episode dari halaman series: nomor episode, judul, link streaming" },
      { label: "🔍 Hasil Pencarian Film", desc: "Scrape hasil search query tertentu: daftar film yang cocok dengan keyword" },
      { label: "🏷️ Film Berdasarkan Genre", desc: "Scrape daftar film per genre/kategori dengan paginasi" },
      { label: "📄 Multi-halaman (All Pages)", desc: "Scrape semua halaman dengan auto-follow pagination, kumpulkan semua film" },
    ],
    ecommerce: [
      { label: "🛍️ Daftar Produk Terbaru", desc: "Scrape semua produk: nama, harga, rating, gambar, link detail" },
      { label: "💰 Harga & Diskon Produk", desc: "Pantau harga produk tertentu, deteksi perubahan harga dan diskon" },
      { label: "⭐ Review & Rating Produk", desc: "Scrape semua review: bintang, komentar, nama pembeli, tanggal" },
      { label: "📦 Detail Produk Lengkap", desc: "Scrape halaman detail: nama, deskripsi, spesifikasi, harga, stok, gambar" },
      { label: "🗂️ Kategori & Sub-kategori", desc: "Scrape struktur navigasi kategori produk" },
      { label: "📄 Multi-halaman (All Pages)", desc: "Scrape semua halaman produk dengan auto-pagination" },
    ],
    news: [
      { label: "📰 Artikel Terbaru / Headline", desc: "Scrape daftar berita terbaru: judul, penulis, tanggal, thumbnail, link" },
      { label: "📝 Isi Artikel Lengkap", desc: "Scrape konten penuh artikel: judul, isi, penulis, tanggal, tags, gambar" },
      { label: "🏷️ Berita per Kategori", desc: "Scrape berita dari kategori tertentu dengan paginasi" },
      { label: "📄 Multi-halaman (All Pages)", desc: "Kumpulkan semua artikel dari banyak halaman" },
    ],
    forum: [
      { label: "💬 Daftar Thread/Topik", desc: "Scrape daftar thread: judul, penulis, jumlah balasan, tanggal, views" },
      { label: "📖 Isi Thread + Semua Balasan", desc: "Scrape konten thread lengkap: OP + semua reply" },
      { label: "👤 Profil User", desc: "Scrape profil pengguna: username, join date, post count" },
    ],
    jobs: [
      { label: "💼 Lowongan Kerja Terbaru", desc: "Scrape semua lowongan: posisi, perusahaan, lokasi, gaji, link apply" },
      { label: "🏢 Detail Lowongan", desc: "Scrape detail loker: deskripsi, kualifikasi, benefit, cara daftar" },
    ],
    social: [
      { label: "📸 Posts / Feed Terbaru", desc: "Scrape daftar post terbaru dari feed atau profil" },
      { label: "👥 Data Profil", desc: "Scrape info profil: nama, bio, followers, following, jumlah post" },
    ],
    general: [
      { label: "📋 Konten Utama Halaman", desc: "Scrape elemen utama halaman: heading, paragraf, link, gambar" },
      { label: "🔗 Semua Link & URL", desc: "Ekstrak semua link dari halaman untuk crawling/sitemap" },
      { label: "🖼️ Semua Gambar", desc: "Kumpulkan semua URL gambar beserta alt text" },
      { label: "📊 Data Tabel", desc: "Ekstrak data dari tabel HTML" },
    ],
  };

  return (suggestions[siteType] || suggestions.general).slice(0, 6);
}



// ── POST /api/url-detect ───────────────────────────────────────
// Deteksi tipe halaman INSTAN dari URL tanpa fetch — pure URL pattern analysis
app.post("/api/url-detect", (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: "url diperlukan" });
  try {
    const pageInfo = detectPageType(url);
    res.json({ success: true, url, ...pageInfo });
  } catch (e) {
    res.json({ success: false, url, pageType: "unknown", suggestions: [], hint: "" });
  }
});


// Ambil preview info halaman: og:image, favicon, title, description
// Digunakan di frontend untuk preview sebelum scrape
app.post("/api/preview", async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: "url diperlukan" });

  const result = {
    success:     false,
    url,
    title:       "",
    description: "",
    ogImage:     null,
    favicon:     null,
    themeColor:  null,
    siteName:    null,
    layer:       0,
    error:       null,
  };

  let html = null;

  // Layer 1
  try {
    const r = await axios.get(url, {
      timeout: 10000, validateStatus: () => true,
      headers: buildHeaders({ "Referer": "https://www.google.com/" }),
      maxRedirects: 5,
    });
    if (r.status < 400 && r.data) { html = typeof r.data === "string" ? r.data : null; result.layer = 1; }
  } catch {}

  // Layer 2 - rotate UA
  if (!html) {
    try {
      await randomDelay(300, 700);
      const r = await axios.get(url, {
        timeout: 10000, validateStatus: () => true,
        headers: buildHeaders({ "User-Agent": randomUA("mobile"), "Referer": "https://www.google.com/" }),
      });
      if (r.status < 400 && r.data) { html = typeof r.data === "string" ? r.data : null; result.layer = 2; }
    } catch {}
  }

  if (!html) {
    result.error = "Tidak bisa fetch halaman";
    return res.json(result);
  }

  try {
    const $ = cheerio.load(html);

    result.title       = $("title").first().text().trim().substring(0, 120)
                      || $("meta[property='og:title']").attr("content")?.substring(0, 120)
                      || "";
    result.description = $("meta[name='description']").attr("content")?.substring(0, 200)
                      || $("meta[property='og:description']").attr("content")?.substring(0, 200)
                      || "";
    result.siteName    = $("meta[property='og:site_name']").attr("content") || null;
    result.themeColor  = $("meta[name='theme-color']").attr("content") || null;

    // og:image
    const ogImg = $("meta[property='og:image']").attr("content")
               || $("meta[property='og:image:url']").attr("content")
               || $("meta[name='twitter:image']").attr("content")
               || $("meta[name='twitter:image:src']").attr("content");

    if (ogImg) {
      // Make absolute URL
      try {
        result.ogImage = ogImg.startsWith("http") ? ogImg : new URL(ogImg, url).href;
      } catch { result.ogImage = ogImg; }
    }

    // Favicon
    const favLink = $("link[rel='icon']").attr("href")
                 || $("link[rel='shortcut icon']").attr("href")
                 || $("link[rel='apple-touch-icon']").attr("href");
    if (favLink) {
      try { result.favicon = favLink.startsWith("http") ? favLink : new URL(favLink, url).href; }
      catch { result.favicon = favLink; }
    } else {
      // Default /favicon.ico
      try { result.favicon = `${new URL(url).origin}/favicon.ico`; } catch {}
    }

    result.success = true;
  } catch (e) {
    result.error = e.message;
  }

  res.json(result);
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

// ═══════════════════════════════════════════════════════════════
//  SMART BYPASS FETCHER — Multi-layer fallback untuk bypass firewall
//  Layer 1: axios biasa
//  Layer 2: Rotate User-Agent + fake browser headers
//  Layer 3: Google AMP / cached version
//  Layer 4: Wayback Machine snapshot
//  Layer 5: Axios dengan Cookie + Referrer bypass
// ═══════════════════════════════════════════════════════════════

const USER_AGENTS = [
  // Chrome Windows
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 11.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  // Chrome macOS
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_2_1) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  // Firefox Windows
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0",
  // Firefox macOS
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14.2; rv:131.0) Gecko/20100101 Firefox/131.0",
  // Safari macOS
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_2_1) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 13_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
  // Edge
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0",
  // Mobile Chrome Android
  "Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.6778.39 Mobile Safari/537.36",
  "Mozilla/5.0 (Linux; Android 14; SM-S928B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.6723.86 Mobile Safari/537.36",
  "Mozilla/5.0 (Linux; Android 13; Redmi Note 12) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36",
  // Mobile Safari iOS
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_1_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Mobile/15E148 Safari/604.1",
];

const MOBILE_UAS = USER_AGENTS.filter(ua => ua.includes("Mobile") || ua.includes("Android") || ua.includes("iPhone"));
const DESKTOP_UAS = USER_AGENTS.filter(ua => !ua.includes("Mobile") && !ua.includes("Android") && !ua.includes("iPhone"));

function randomUA(type = "any") {
  const pool = type === "mobile" ? MOBILE_UAS : type === "desktop" ? DESKTOP_UAS : USER_AGENTS;
  return pool[Math.floor(Math.random() * pool.length)];
}

function randomDelay(minMs = 800, maxMs = 2500) {
  return new Promise(r => setTimeout(r, Math.floor(Math.random() * (maxMs - minMs)) + minMs));
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function buildHeaders(extra = {}) {
  return {
    "User-Agent":                randomUA(),
    "Accept":                    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language":           "en-US,en;q=0.9,id;q=0.8",
    "Accept-Encoding":           "gzip, deflate, br",
    "Cache-Control":             "no-cache",
    "Pragma":                    "no-cache",
    "Sec-Ch-Ua":                 '"Chromium";v="124", "Google Chrome";v="124"',
    "Sec-Ch-Ua-Mobile":          "?0",
    "Sec-Ch-Ua-Platform":        '"Windows"',
    "Sec-Fetch-Dest":            "document",
    "Sec-Fetch-Mode":            "navigate",
    "Sec-Fetch-Site":            "none",
    "Sec-Fetch-User":            "?1",
    "Upgrade-Insecure-Requests": "1",
    "Connection":                "keep-alive",
    ...extra,
  };
}

/**
 * fetchWithBypass — coba fetch URL dengan berbagai strategi bypass
 * @param {string} url
 * @param {Function} log — callback(msg) untuk real-time log
 */
async function fetchWithBypass(url, log = () => {}) {
  const axiosCfg = (headers, timeout = 18000) => ({
    headers, timeout, maxRedirects: 6,
    validateStatus: s => s < 600,
    maxContentLength: 6 * 1024 * 1024,
  });

  let lastError = null;

  // ── Layer 1: Direct fetch ──────────────────────────────────
  log(" [Layer 1] Mencoba fetch langsung...");
  try {
    const resp = await axios.get(url, axiosCfg(buildHeaders()));
    if (resp.status < 400 && resp.data) {
      log(` [Layer 1] Berhasil! HTTP ${resp.status}`);
      return { html: typeof resp.data === "string" ? resp.data : JSON.stringify(resp.data), status: resp.status, layer: 1 };
    }
    log(` [Layer 1] HTTP ${resp.status} — mencoba layer berikutnya`);
    lastError = `HTTP ${resp.status}`;
  } catch (e) {
    log(` [Layer 1] Gagal: ${e.message}`);
    lastError = e.message;
  }
  await sleep(400);

  // ── Layer 2: Mobile UA + Referrer bypass ───────────────────
  log(" [Layer 2] Mencoba mobile user-agent + referrer trick...");
  try {
    const mobileUA = randomUA("mobile");
    const hostname = new URL(url).hostname;
    await randomDelay(500, 1200);
    const resp = await axios.get(url, axiosCfg(buildHeaders({
      "User-Agent": mobileUA,
      "Referer":    `https://www.google.com/search?q=${encodeURIComponent(hostname)}`,
      "Origin":     `https://${hostname}`,
      "Sec-Fetch-Dest": "document",
      "Sec-Fetch-Mode": "navigate",
    })));
    if (resp.status < 400 && resp.data) {
      log(` [Layer 2] Berhasil dengan mobile UA! HTTP ${resp.status}`);
      return { html: typeof resp.data === "string" ? resp.data : JSON.stringify(resp.data), status: resp.status, layer: 2 };
    }
    log(` [Layer 2] HTTP ${resp.status}`);
    lastError = `HTTP ${resp.status}`;
  } catch (e) {
    log(` [Layer 2] Gagal: ${e.message}`);
    lastError = e.message;
  }
  await randomDelay(800, 1800);

  // ── Layer 3: Random delay + desktop UA rotate + extra headers ─
  log(" [Layer 3] Mencoba dengan random delay + rotate user-agent...");
  try {
    await randomDelay(1500, 3000);
    const desktopUA = randomUA("desktop");
    const parsedUrl = new URL(url);
    const resp = await axios.get(url, axiosCfg(buildHeaders({
      "User-Agent":       desktopUA,
      "Referer":          "https://www.google.com/",
      "DNT":              "1",
      "Sec-Ch-Ua":        '"Chromium";v="131", "Not_A Brand";v="24"',
      "Sec-Ch-Ua-Mobile": "?0",
      "Sec-Ch-Ua-Platform": '"Windows"',
      "Sec-Fetch-Site":   "cross-site",
      "Sec-Fetch-Dest":   "document",
      "Sec-Fetch-Mode":   "navigate",
      "Cache-Control":    "no-cache",
    }), 28000));
    if (resp.status < 400 && resp.data) {
      log(` [Layer 3] Berhasil! HTTP ${resp.status}`);
      return { html: typeof resp.data === "string" ? resp.data : JSON.stringify(resp.data), status: resp.status, layer: 3 };
    }
    log(` [Layer 3] HTTP ${resp.status}`);
  } catch (e) {
    log(` [Layer 3] Gagal: ${e.message}`);
    lastError = e.message;
  }

  // ── Layer 4: Google Cache / AMP ────────────────────────────
  log(" [Layer 4] Mencoba Google Cache fallback...");
  try {
    const encoded  = encodeURIComponent(url);
    const cacheUrl = `https://webcache.googleusercontent.com/search?q=cache:${encoded}`;
    const resp = await axios.get(cacheUrl, axiosCfg(buildHeaders({
      "Referer": "https://www.google.com/",
    }), 15000));
    if (resp.status === 200 && typeof resp.data === "string" && resp.data.length > 500) {
      log(` [Layer 4] Berhasil via Google Cache!`);
      return { html: resp.data, status: 200, layer: 4, note: "dari Google Cache" };
    }
    log(` [Layer 4] Cache tidak tersedia`);
  } catch (e) {
    log(` [Layer 4] Google Cache gagal: ${e.message}`);
  }

  // ── Layer 5: Wayback Machine ───────────────────────────────
  log(" [Layer 5] Mencoba Wayback Machine (web.archive.org)...");
  try {
    const avail = await axios.get(
      `https://archive.org/wayback/available?url=${encodeURIComponent(url)}`,
      { timeout: 10000, headers: buildHeaders() }
    );
    const snapUrl = avail.data?.archived_snapshots?.closest?.url;
    if (snapUrl) {
      log(`   Snapshot ditemukan: ${snapUrl.substring(0, 70)}...`);
      const snap = await axios.get(snapUrl, axiosCfg(buildHeaders(), 20000));
      if (snap.status === 200 && snap.data) {
        log(` [Layer 5] Berhasil via Wayback Machine!`);
        return { html: typeof snap.data === "string" ? snap.data : JSON.stringify(snap.data), status: 200, layer: 5, note: "dari Wayback Machine" };
      }
    } else {
      log(` [Layer 5] Tidak ada snapshot Wayback Machine`);
    }
  } catch (e) {
    log(` [Layer 5] Wayback Machine gagal: ${e.message}`);
  }

  // ── Layer 6: iframe/embed via alternate URL format ──────────
  log(" [Layer 6] Mencoba variasi URL (www, http, path alternatif)...");
  try {
    const parsed = new URL(url);
    const altUrls = [
      url.replace("https://", "http://"),
      `https://www.${parsed.hostname.replace("www.", "")}${parsed.pathname}${parsed.search}`,
      `${parsed.origin}/`,
    ].filter(u => u !== url);

    for (const altUrl of altUrls) {
      try {
        const resp = await axios.get(altUrl, axiosCfg(buildHeaders(), 12000));
        if (resp.status < 400 && resp.data) {
          log(` [Layer 6] Berhasil via URL alternatif: ${altUrl.substring(0,50)}`);
          return { html: typeof resp.data === "string" ? resp.data : JSON.stringify(resp.data), status: resp.status, layer: 6 };
        }
      } catch {}
    }
    log(` [Layer 6] Semua URL alternatif gagal`);
  } catch (e) {
    log(` [Layer 6] Error: ${e.message}`);
  }

  log(` Semua ${6} layer bypass gagal. Error terakhir: ${lastError}`);
  return { html: null, status: null, layer: null, error: lastError || "Semua strategi bypass gagal" };
}

/**
 * parseHtmlToStructure — parse HTML yang sudah didapat jadi struktur data
 */
function parseHtmlToStructure(html, url) {
  const result = {
    fetched: true, statusCode: null, html_snippet: "",
    title: "", meta_desc: "", h1_tags: [], h2_tags: [],
    class_samples: [], data_attrs: [], scripts_src: [],
    json_ld: null, next_data: null, forms: [], tables: [],
    img_count: 0, link_count: 0, detected_tech: [], error: null,
  };

  try {
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
    ["Next.js",         /__NEXT_DATA__|_next\/static/],
    ["React",           /react(?:\.min)?\.js|__reactFiber|_reactRootContainer/],
    ["Vue.js",          /vue(?:\.min)?\.js|data-v-|__vue__/],
    ["Angular",         /angular(?:\.min)?\.js|ng-app|ng-controller/],
    ["Nuxt.js",         /__nuxt__|nuxt\.js/],
    ["SvelteKit",       /svelte|__sveltekit/],
    ["jQuery",          /jquery(?:\.min)?\.js|window\.\$/],
    ["Webpack",         /webpack_require|__webpack_modules__/],
    ["Tailwind CSS",    /tailwind/],
    ["WordPress",       /wp-content|wp-includes/],
    ["Shopify",         /shopify|Shopify\.theme/],
    ["GraphQL",         /graphql|__typename/],
    ["Infinite Scroll", /infinite.?scroll|loadMore|next_page_token/i],
    ["Login Required",  /login.*required|sign.?in.*required/i],
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
  let cleaned = ($c.html() || snippet).replace(/\s{2,}/g, " ").replace(/<!--[\s\S]*?-->/g, "").trim();
  result.html_snippet = cleaned.substring(0, 8000);

  } catch (parseErr) {
    result.error = `Parse error: ${parseErr.message}`;
    result.html_snippet = (html || "").substring(0, 2000);
  }

  return result;
}

// ── GET /api/analyze/stream — SSE real-time logging ───────────
// Dipanggil dari frontend sebelum POST /api/analyze
// Mengirim event stream: log langkah-langkah bypass + analisa
app.get("/api/analyze/stream", async (req, res) => {
  const { url, provider, apiKey, model } = req.query;
  if (!url || !apiKey) { res.status(400).json({ error: "url dan apiKey diperlukan" }); return; }

  // SSE headers
  res.setHeader("Content-Type",  "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection",    "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  const send = (type, data) => {
    if (res.writableEnded) return;
    res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const log  = (msg)    => send("log",    { msg, ts: Date.now() });
  const done = (result) => send("result", result);
  const fail = (err)    => send("error",  { msg: err });

  try {
    log(` Memulai analisa untuk: ${url}`);
    log(` AI Provider: ${provider}`);

    // Step 1: Firewall detection
    log(" Mendeteksi proteksi firewall...");
    const fw = await detectFirewall(url);
    if (fw.cloudflare)     log("  Terdeteksi: Cloudflare");
    if (fw.waf)            log("  Terdeteksi: WAF (Web Application Firewall)");
    if (fw.bot_protection) log("  Terdeteksi: Bot Protection");
    if (!fw.bypass_recommended) log(" Tidak ada proteksi khusus terdeteksi");

    // Step 2: Fetch HTML with bypass
    log(" Memulai fetch HTML...");
    const fetchResult = await fetchWithBypass(url, log);

    let htmlData;
    if (fetchResult.html) {
      log(` Parsing struktur HTML (layer ${fetchResult.layer})...`);
      if (fetchResult.note) log(`   ℹ  ${fetchResult.note}`);
      htmlData = parseHtmlToStructure(fetchResult.html, url);
      htmlData.statusCode = fetchResult.status;
      log(`    Title: ${htmlData.title || "(tidak ada)"}`);
      log(`    Teknologi: ${htmlData.detected_tech.join(", ") || "Standar HTML"}`);
      log(`     Gambar: ${htmlData.img_count} |  Link: ${htmlData.link_count}`);
      if (htmlData.json_ld)   log("    JSON-LD Structured Data ditemukan");
      if (htmlData.next_data) log("    __NEXT_DATA__ (Next.js) ditemukan");
      if (htmlData.class_samples.length) log(`    ${htmlData.class_samples.length} CSS class terdeteksi`);
    } else {
      log(` Fetch gagal setelah semua layer: ${fetchResult.error}`);
      log("   AI akan tetap analisa berdasarkan URL dan informasi firewall");
      htmlData = {
        fetched: false, statusCode: fetchResult.status, html_snippet: "",
        title: "", meta_desc: "", h1_tags: [], h2_tags: [],
        class_samples: [], data_attrs: [], scripts_src: [],
        json_ld: null, next_data: null, forms: [], tables: [],
        img_count: 0, link_count: 0, detected_tech: fw.cloudflare ? ["Cloudflare Protected"] : [],
        error: fetchResult.error,
      };
    }

    // Step 3: AI Analyze
    log(" Memulai analisa AI...");
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
` : `URL: ${url}\nHTML fetch gagal: ${htmlData.error || "blocked"}\nFirewall: ${fw.cloudflare ? "Cloudflare" : "tidak ada"}`;

    const analyzeSystem = `Kamu adalah SmartScrapeAI senior web scraping engineer berbahasa Indonesia.
Kamu diberi DATA ASLI HTML dari website yang sudah di-fetch. Gunakan data ini untuk analisa SANGAT AKURAT dan SPESIFIK.
- Gunakan class CSS dan data attributes nyata dari HTML untuk saran selector
- Jika terdeteksi Next.js/React/SPA → WAJIB rekomendasikan puppeteer/playwright
- Jika ada JSON-LD atau __NEXT_DATA__ → sebutkan data bisa diambil dari embedded JSON
- Suggestions HARUS sangat spesifik sesuai jenis website:
  * Streaming/film: "Daftar film terbaru dengan poster & rating", "Detail film: sinopsis+cast+embed URL", "Daftar episode serial"
  * Ecommerce: "Daftar produk: nama+harga+rating+gambar", "Detail produk lengkap", "Review & rating produk"
  * Berita: "Artikel terbaru: judul+tanggal+penulis", "Isi artikel lengkap", "Berita per kategori"
  * Forum: "Daftar thread terbaru", "Isi thread + semua reply"
  * General: field/class spesifik dari HTML

Balas HANYA JSON valid tanpa markdown:
{
  "greeting": "2 kalimat: jenis website + teknologi + strategi terbaik scraping",
  "question": "tanya field SPESIFIK dari HTML yang relevan (1 kalimat)",
  "suggestions": ["6 saran scraping SPESIFIK sesuai jenis website — contoh field nyata dari HTML"],
  "site_type": "streaming|ecommerce|news|forum|social|jobs|general",
  "complexity": "simple|moderate|complex",
  "complexity_reason": "1 kalimat spesifik kenapa kompleks/simple",
  "scraping_strategy": "2-3 kalimat: perlu browser automation? ada embedded JSON? cara terbaik scrape site ini",
  "css_selectors": { "note": "dari HTML asli website ini", "selectors": ["selector CSS nyata dari HTML"] },
  "recommended_modules": {
    "nodejs": { "packages": ["pkg"], "reason": "alasan spesifik", "install_cmd": "npm install pkg" },
    "python": { "packages": ["pkg"], "reason": "alasan spesifik", "install_cmd": "pip install pkg" },
    "php":    { "packages": ["guzzlehttp/guzzle"], "reason": "alasan", "install_cmd": "composer require guzzlehttp/guzzle" }
  }
}`;

    log("   Mengirim data ke AI untuk dianalisa...");
    const raw = await callAI({ provider, apiKey, model, system: analyzeSystem, prompt: htmlContext, maxTokens: 1200 });
    log("   AI selesai menjawab. Memproses hasil...");

    const clean = raw.replace(/```json|```/g, "").trim();
    let parsed;
    try {
      parsed = JSON.parse(clean);
      log(` Analisa selesai! Site type: ${parsed.site_type || "unknown"}, Kompleksitas: ${parsed.complexity || "?"}`);
    } catch {
      log("  JSON parse gagal, menggunakan fallback analisa");
      const host = (() => { try { return new URL(url).hostname.toLowerCase(); } catch { return ""; } })();
      const isEcomm = ["shopee","tokopedia","lazada","amazon"].some(s => host.includes(s));
      parsed = {
        greeting: `Website ${htmlData.title || url}. Teknologi: ${htmlData.detected_tech.join(", ") || "Standar HTML"}.`,
        question: "Data apa yang ingin kamu ambil?",
        suggestions: htmlData.h2_tags.slice(0,4).length
          ? [...htmlData.h2_tags.slice(0,4),"Gambar & media","Link & URL"]
          : ["Judul & konten","Harga & produk","Gambar","Link","Data tabel","Metadata"],
        site_type: isEcomm ? "ecommerce" : "other",
        complexity: needsBypass ? "complex" : "moderate",
        complexity_reason: needsBypass ? `Terdeteksi: ${htmlData.detected_tech.join(", ")}` : "Struktur HTML standar",
        scraping_strategy: needsBypass ? "Gunakan puppeteer-extra + stealth untuk bypass." : "axios+cheerio sudah cukup.",
        css_selectors: { note: "Sample class", selectors: htmlData.class_samples.slice(0,5) },
        recommended_modules: {
          nodejs: needsBypass
            ? { packages: ["puppeteer-extra","puppeteer-extra-plugin-stealth"], reason: "Butuh browser automation", install_cmd: "npm install puppeteer-extra puppeteer-extra-plugin-stealth" }
            : { packages: ["axios","cheerio"], reason: "HTML statis", install_cmd: "npm install axios cheerio" },
          python: needsBypass
            ? { packages: ["playwright","beautifulsoup4"], reason: "playwright untuk JS", install_cmd: "pip install playwright beautifulsoup4" }
            : { packages: ["requests","beautifulsoup4","lxml"], reason: "Standar", install_cmd: "pip install requests beautifulsoup4 lxml" },
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
      bypass_layer: fetchResult?.layer || null,
    };

    log(" Semua proses selesai! Memuat hasil...");
    done({ success: true, url, firewall: fw, ai: parsed, html_info });

  } catch (e) {
    console.error("[analyze/stream]", e.message);
    fail(e.message);
  } finally {
    if (!res.writableEnded) res.end();
  }
});

// ── GET /api/generate/stream — SSE real-time log generate kode ─
app.get("/api/generate/stream", async (req, res) => {
  const { url, target, lang, bypassCF, provider, apiKey, model, moduleType, siteType, selectors } = req.query;
  if (!url || !target || !lang || !apiKey) { res.status(400).json({ error: "url, target, lang, apiKey diperlukan" }); return; }

  res.setHeader("Content-Type",  "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection",    "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  const send = (type, data) => {
    if (res.writableEnded) return;
    res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const log  = (msg)    => send("log",    { msg, ts: Date.now() });
  const done = (result) => send("result", result);
  const fail = (err)    => send("error",  { msg: err });

  const langLabel = { nodejs:"Node.js", python:"Python", php:"PHP" };
  const bCF = bypassCF === "true";

  try {
    log(` Generate ${langLabel[lang]} scraper dimulai`);
    log(` Target URL: ${url}`);
    log(` Data yang di-scrape: ${target}`);
    log(` Bypass CF: ${bCF ? "AKTIF" : "Tidak aktif"}`);
    if (moduleType && lang === "nodejs") log(` Module type: ${moduleType}`);

    log(" Mengirim request ke AI provider...");
    log("   Ini bisa memakan waktu 30–90 detik, harap tunggu...");

    const SHARED_RULES = `
ATURAN TIDAK BOLEH DILANGGAR:
1. Output HANYA kode MENTAH — tidak ada markdown, backtick, penjelasan di luar kode
2. Kode HARUS LENGKAP dari awal sampai akhir — jangan pernah potong dengan "// ... dst"
3. Setiap fungsi, loop, try/catch HARUS punya penutup yang lengkap
4. Komentar bahasa Indonesia di dalam kode boleh
5. Jika kode panjang, tetap tulis SELURUHNYA`;

    const moduleNote = lang === "nodejs" && moduleType
      ? moduleType === "esm"    ? "\nGunakan ES Module syntax: import/export, file .mjs"
      : moduleType === "esm-ts" ? "\nGunakan TypeScript + ES Module: import/export dengan type annotations, file .ts"
      : "\nGunakan CommonJS: require()/module.exports"
      : "";

    const sysMap = {
      nodejs: `Kamu adalah senior Node.js web scraping engineer.
${bCF ? "PENTING: Gunakan puppeteer-extra + puppeteer-extra-plugin-stealth, random user-agent, delay acak 1500-3000ms." : "Gunakan axios + cheerio."}${moduleNote}${SHARED_RULES}
- Mulai dari: // SmartScrapeAI Generated Script
- require()/import semua library di atas
- async main() dengan try/catch lengkap
- console.log(JSON.stringify(result, null, 2))
- Akhiri: main().catch(console.error)`,

      python: `Kamu adalah senior Python web scraping engineer.
${bCF ? "PENTING: Gunakan cloudscraper, fake_useragent.UserAgent(), BeautifulSoup, time.sleep(random.uniform(1.5,3.0))." : "Gunakan requests + BeautifulSoup4."}${SHARED_RULES}
- Mulai dari: # SmartScrapeAI Generated Script
- import semua di atas
- def main() dengan try/except lengkap
- print(json.dumps(result, indent=2, ensure_ascii=False))
- if __name__ == '__main__': main()`,

      php: `Kamu adalah senior PHP web scraping engineer.
${bCF ? "PENTING: Gunakan cURL dengan full browser headers, rotate User-Agent, sleep(rand(1,3))." : "Gunakan cURL + DOMDocument."}${SHARED_RULES}
- Mulai dari: <?php
- Semua fungsi helper di atas
- try/catch lengkap
- echo json_encode($result, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE);`,
    };

    const siteContext = siteType ? `\nTipe website: ${siteType}` : "";
    const pageContext = req.query.pageType ? `\nTipe halaman: ${req.query.pageType}` : "";
    const searchCtx  = req.query.searchQuery ? `\nQuery pencarian: "${req.query.searchQuery}"` : "";
    const selectorContext = selectors ? (() => {
      try {
        const parsed = JSON.parse(selectors);
        if (Array.isArray(parsed) && parsed.length) {
          return "\nCSS Selectors dari HTML asli:\n" + parsed.map(s => `  ${s.category}: ${s.selector}`).join("\n");
        }
      } catch {}
      return "";
    })() : "";

    const siteSpecificGuide = {
      streaming: `\nPanduan site streaming:
- Untuk daftar film: cari elemen kartu/item yang berulang (li, article, div.item)
- Ambil: judul film, URL poster (src/data-src dari img), tahun, genre, rating, link detail
- Untuk episode: ikuti link ke halaman detail, ekstrak daftar episode
- Handle pagination: cari link "Next Page" atau nomor halaman
- Untuk embed URL video: cari iframe[src*='embed'] atau script dengan URL video`,
      ecommerce: `\nPanduan site ecommerce:
- Ambil semua kartu produk: nama, harga (normal + diskon), rating, stok, gambar, link
- Handle harga format: strip simbol mata uang, parse angka
- Ikuti pagination untuk halaman berikutnya`,
      news: `\nPanduan site berita:
- Ambil daftar artikel: judul, tanggal, penulis, kategori, thumbnail, link
- Untuk isi lengkap: ikuti link artikel, ambil konten dari elemen artikel/content
- Handle berbagai format tanggal Indonesia`,
    };

    const prompt = `URL Target: ${url}
Yang akan di-scrape: ${target}
Bahasa: ${lang}${siteContext}${pageContext}${searchCtx}${selectorContext}
${bCF ? "Mode Bypass Cloudflare: AKTIF — wajib gunakan semua teknik stealth bypass" : ""}
${(siteSpecificGuide[siteType] || "")}

Tugas: Buat scraper PRODUCTION-READY yang benar-benar bisa dijalankan untuk mengambil: ${target}

Struktur wajib:
1. Import/require semua library
2. Konfigurasi (BASE_URL, headers lengkap seperti browser asli, timeout, retry)
3. Fungsi fetchPage(url) dengan retry logic (3x) dan random delay
4. Fungsi parseData($, html) — ekstrak data target dengan selector yang tepat
5. Fungsi main() yang:
   - Fetch halaman
   - Parse data
   - Handle pagination jika ada (ambil semua halaman)
   - Return array hasil
6. Output: console.log(JSON.stringify(result, null, 2))
7. Error handling di setiap fungsi

PENTING: 
- Gunakan selector CSS spesifik dari konteks di atas, bukan selector generic
- Tulis SEMUA kode dari awal sampai akhir, JANGAN potong
- Kode harus bisa langsung dijalankan tanpa modifikasi`;

    const code = await (async () => {
      const raw = await callAI({ provider, apiKey, model, system: sysMap[lang], prompt, maxTokens: null });
      return raw.replace(/^```[\w]*\n?/gm, "").replace(/^```\n?/gm, "").trim();
    })();

    log(` AI selesai generate kode!`);
    log(`    Panjang kode: ${code.split("\n").length} baris`);
    log("    Menyimpan ke registry...");

    const id        = uuidv4();
    const trySchema = buildTrySchema(url, target);
    const host      = (() => { try { return new URL(url).hostname.replace("www.", ""); } catch { return "site"; } })();
    const extMap    = { nodejs: moduleType === "esm" ? "mjs" : moduleType === "esm-ts" ? "ts" : "js", python: "py", php: "php" };

    const entry = {
      id, name: `${host}-scraper`, url, target, lang, bypassCF: bCF, code,
      trySchema, provider, model: model || "default",
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      filename: `scraper.${extMap[lang]}`, fixCount: 0, history: [],
    };
    registry.add(entry);

    log(` Scraper tersimpan dengan ID: ${id}`);
    log(" Generate selesai! Siap digunakan.");
    done({ success: true, id, code, trySchema, entry });

  } catch (e) {
    console.error("[generate/stream]", e.message);
    fail(e.message);
  } finally {
    if (!res.writableEnded) res.end();
  }
});

// ── POST /api/analyze ─────────────────────────────────────────
// Legacy endpoint (tanpa SSE) — tetap dipertahankan untuk kompatibilitas
app.post("/api/analyze", async (req, res) => {
  const { url, provider, apiKey, model } = req.body;
  if (!url || !apiKey) return res.status(400).json({ error: "url dan apiKey diperlukan" });

  try {
    const [fw, fetchResult] = await Promise.all([
      detectFirewall(url),
      fetchWithBypass(url, () => {}),
    ]);

    let htmlData;
    if (fetchResult.html) {
      htmlData = parseHtmlToStructure(fetchResult.html, url);
      htmlData.statusCode = fetchResult.status;
    } else {
      htmlData = { fetched: false, statusCode: null, html_snippet: "", title: "", meta_desc: "", h1_tags: [], h2_tags: [], class_samples: [], data_attrs: [], scripts_src: [], json_ld: null, next_data: null, forms: [], tables: [], img_count: 0, link_count: 0, detected_tech: [], error: fetchResult.error };
    }

    const needsBypass = fw.bypass_recommended || htmlData.detected_tech.some(t => ["Next.js","React","Angular","Vue.js","SvelteKit","Nuxt.js"].includes(t));
    const htmlContext = htmlData.fetched
      ? `URL:${url}\nTitle:${htmlData.title}\nH1:${htmlData.h1_tags.join("|")}\nTech:${htmlData.detected_tech.join(",")}\nClasses:${htmlData.class_samples.slice(0,20).join(",")}\nJSON-LD:${htmlData.json_ld||"none"}\nNEXT:${htmlData.next_data||"none"}\n\nHTML:\n${htmlData.html_snippet}`
      : `URL:${url}\nFetch failed:${htmlData.error}\nFirewall:${fw.cloudflare?"Cloudflare":"none"}`;

    const raw = await callAI({ provider, apiKey, model, system: `Kamu SmartScrapeAI engineer. Analisa website dari HTML asli. Balas JSON valid: {"greeting":"...","question":"...","suggestions":[...],"site_type":"...","complexity":"...","complexity_reason":"...","scraping_strategy":"...","css_selectors":{"note":"...","selectors":[]},"recommended_modules":{"nodejs":{"packages":[],"reason":"","install_cmd":""},"python":{"packages":[],"reason":"","install_cmd":""},"php":{"packages":[],"reason":"","install_cmd":""}}}`, prompt: htmlContext, maxTokens: 1200 });
    const clean = raw.replace(/```json|```/g, "").trim();
    let parsed;
    try { parsed = JSON.parse(clean); }
    catch { parsed = { greeting: `Website ${htmlData.title||url}.`, question: "Data apa yang ingin kamu ambil?", suggestions: ["Konten utama","Judul & heading","Gambar & media","Link & URL","Data tabel","Metadata"], site_type: "other", complexity: needsBypass?"complex":"moderate", complexity_reason: needsBypass?"Butuh browser automation":"HTML standar", scraping_strategy: needsBypass?"Gunakan puppeteer-extra.":"axios+cheerio sudah cukup.", css_selectors: {note:"sample",selectors:htmlData.class_samples.slice(0,4)}, recommended_modules: { nodejs: needsBypass?{packages:["puppeteer-extra","puppeteer-extra-plugin-stealth"],reason:"bypass",install_cmd:"npm install puppeteer-extra puppeteer-extra-plugin-stealth"}:{packages:["axios","cheerio"],reason:"statis",install_cmd:"npm install axios cheerio"}, python: needsBypass?{packages:["playwright","beautifulsoup4"],reason:"JS",install_cmd:"pip install playwright beautifulsoup4"}:{packages:["requests","beautifulsoup4"],reason:"standar",install_cmd:"pip install requests beautifulsoup4"}, php:{packages:["guzzlehttp/guzzle"],reason:"http",install_cmd:"composer require guzzlehttp/guzzle"} } }; }

    res.json({ success:true, url, firewall:fw, ai:parsed, html_info:{ fetched:htmlData.fetched, status_code:htmlData.statusCode, title:htmlData.title, detected_tech:htmlData.detected_tech, has_json_ld:!!htmlData.json_ld, has_next_data:!!htmlData.next_data, img_count:htmlData.img_count, link_count:htmlData.link_count, fetch_error:htmlData.error||null } });
  } catch (e) {
    console.error("[analyze]", e.message);
    res.status(500).json({ error: e.message });
  }
});

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

  console.log(`[v4]  Registered: ${route.method} ${cleanPath}`);
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
      message:  ` ${packagesInfo} berhasil diinstall untuk ${entry.lang}!`,
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

// ══════════════════════════════════════════════════════════════
//  C3 STORAGE — Cloudflare R2 Sync
// ══════════════════════════════════════════════════════════════
const c3 = require("./api/c3storage");

// GET /api/c3/status — Cek konfigurasi C3
app.get("/api/c3/status", (req, res) => {
  const cfg = c3.config();
  res.json({
    success:    true,
    configured: cfg.configured,
    config:     cfg,
    hint:       cfg.configured
      ? "C3 Storage aktif. Gunakan /api/c3/push untuk sync."
      : "Set C3_ENDPOINT, C3_BUCKET, C3_ACCESS_KEY, C3_SECRET_KEY di .env untuk mengaktifkan.",
  });
});

// POST /api/c3/push — Upload scrapers.json ke R2
app.post("/api/c3/push", async (req, res) => {
  try {
    const scrapers = registry.getAll();
    const filename = req.body?.filename || "scrapers.json";
    const result   = await c3.uploadToC3(scrapers, filename);
    console.log(`[c3] Push ${scrapers.length} scrapers -> ${result.filename} (${result.bytes} bytes)`);
    res.json({
      success:  true,
      message:  `${scrapers.length} scraper berhasil di-push ke C3 Storage`,
      ...result,
    });
  } catch (e) {
    console.error("[c3/push]", e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/c3/pull — Download & merge scrapers dari R2
app.post("/api/c3/pull", async (req, res) => {
  try {
    const filename = req.body?.filename || "scrapers.json";
    const remote   = await c3.downloadFromC3(filename);
    if (!Array.isArray(remote)) throw new Error("Format file C3 tidak valid (bukan array)");

    let added = 0, updated = 0;
    for (const s of remote) {
      if (!s.id) continue;
      const existing = registry.getById(s.id);
      if (!existing) { registry.add(s); added++; }
      else if (new Date(s.updatedAt) > new Date(existing.updatedAt)) { registry.update(s.id, s); updated++; }
    }

    res.json({
      success: true,
      message: `Pull selesai: ${added} ditambahkan, ${updated} diperbarui`,
      total:   remote.length,
      added,
      updated,
      skipped: remote.length - added - updated,
    });
  } catch (e) {
    console.error("[c3/pull]", e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/c3/sync — 2-way sync (pull dulu, lalu push)
app.post("/api/c3/sync", async (req, res) => {
  try {
    // 1. Pull dari remote
    const filename = req.body?.filename || "scrapers.json";
    let pullResult = { added: 0, updated: 0, total: 0 };
    try {
      const remote = await c3.downloadFromC3(filename);
      if (Array.isArray(remote)) {
        for (const s of remote) {
          if (!s.id) continue;
          const ex = registry.getById(s.id);
          if (!ex) { registry.add(s); pullResult.added++; }
          else if (new Date(s.updatedAt) > new Date(ex.updatedAt)) { registry.update(s.id, s); pullResult.updated++; }
        }
        pullResult.total = remote.length;
      }
    } catch (pullErr) {
      // File belum ada di remote - lanjut ke push
      console.log("[c3/sync] Remote belum ada, langsung push:", pullErr.message);
    }

    // 2. Push lokal ke remote
    const allScrapers = registry.getAll();
    const pushResult  = await c3.uploadToC3(allScrapers, filename);

    res.json({
      success:  true,
      message:  `Sync selesai: pull ${pullResult.added} baru + ${pullResult.updated} update, push ${allScrapers.length} scrapers`,
      pull:     pullResult,
      push:     { count: allScrapers.length, bytes: pushResult.bytes },
      syncedAt: new Date().toISOString(),
    });
  } catch (e) {
    console.error("[c3/sync]", e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// GET /api/c3/files — List file di bucket
app.get("/api/c3/files", async (req, res) => {
  try {
    const files = await c3.listC3Files(req.query.prefix || "");
    res.json({ success: true, count: files.length, files });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// DELETE /api/c3/file/:name — Hapus file dari bucket
app.delete("/api/c3/file/:name", async (req, res) => {
  try {
    const result = await c3.deleteFromC3(req.params.name);
    res.json({ success: true, ...result });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── Fallback (Production React build) ────────────────────────
// HANYA untuk non-API routes agar request /api/* tetap return JSON error
if (IS_PROD) {
  app.get("*", (req, res) => {
    // Jangan serve index.html untuk /api/* — kembalikan 404 JSON
    if (req.path.startsWith("/api/") || req.path.startsWith("/health")) {
      return res.status(404).json({ error: "Endpoint tidak ditemukan", path: req.path });
    }
    const idx = path.join(__dirname, "client", "dist", "index.html");
    if (fs.existsSync(idx)) {
      res.sendFile(idx);
    } else {
      res.status(404).json({ error: "Frontend build tidak ditemukan. Jalankan: npm run build" });
    }
  });
}

// ── Start ─────────────────────────────────────────────────────
app.listen(PORT, "0.0.0.0", () => {
  console.log(`\n  SmartScrapeAI Server v4.0`);
  console.log(`  -> http://localhost:${PORT}`);
  console.log(`  -> API: http://localhost:${PORT}/api/docs`);
  console.log(`  -> Health: http://localhost:${PORT}/health`);
  console.log(`  -> Scrapers loaded: ${registry.count()}\n`);
});
