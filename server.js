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
// Production: serve React build di /admin (bukan /)
// / dipakai untuk REST API hasil generate AI
if (IS_PROD) {
  const clientDist = path.join(__dirname, "client", "dist");
  if (fs.existsSync(clientDist)) {
    // Serve static assets (JS, CSS, img) tanpa prefix
    app.use("/admin", express.static(clientDist));
    // Serve static assets di root juga untuk resource files
    app.use(express.static(clientDist, { index: false }));
    console.log("[server] Serving React build di /admin");
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
// Auto-detect query params dari kode yang di-generate
function buildTrySchema(url, target, generatedCode) {
  const host = (() => { try { return new URL(url).hostname.replace("www.", ""); } catch { return url; } })();

  // ── 1. Auto-detect dari kode Express router yang di-generate ──
  if (generatedCode) {
    const params = [];
    const seen   = new Set();

    // Deteksi pattern: const { mode, query, url: itemUrl, limit } = req.query
    const destructureMatch = generatedCode.match(/const\s*\{([^}]+)\}\s*=\s*req\.query/);
    if (destructureMatch) {
      const parts = destructureMatch[1].split(",").map(s => s.trim());
      parts.forEach(part => {
        // Handle alias: "url: itemUrl" → name=url
        const name = part.split(":")[0].trim().replace(/\s.*/, "");
        if (!name || seen.has(name)) return;
        seen.add(name);

        // Tentukan tipe berdasarkan nama
        let type = "text", label = name, placeholder = "";
        if (name === "url" || name.endsWith("url") || name.endsWith("Url") || name.endsWith("URL")) {
          type = "url"; label = `URL ${name}`; placeholder = "https://...";
        } else if (name === "mode") {
          // Ambil mode values dari kode
          const modeVals = [...generatedCode.matchAll(/mode\s*===?\s*['"]([^'"]+)['"]/g)].map(m => m[1]);
          label = "Mode"; placeholder = modeVals.length ? modeVals.join(" | ") : "list";
          type  = "text";
        } else if (name === "query" || name === "q" || name === "search" || name === "keyword") {
          type = "text"; label = "Kata Pencarian"; placeholder = "Masukkan keyword...";
        } else if (name === "limit" || name === "page" || name === "offset") {
          type = "number"; label = name.charAt(0).toUpperCase() + name.slice(1); placeholder = "10";
        } else {
          label = name.replace(/_/g, " ").replace(/\b\w/g, l => l.toUpperCase());
          placeholder = name;
        }

        params.push({ name, label, type, placeholder, required: name === "mode" || name === "url" });
      });
    }

    // Deteksi manual: req.query.xxx patterns
    if (params.length === 0) {
      const qMatches = [...generatedCode.matchAll(/req\.query\.([a-zA-Z_]+)/g)];
      qMatches.forEach(m => {
        const name = m[1];
        if (seen.has(name)) return;
        seen.add(name);
        let type = "text", label = name, placeholder = name;
        if (name.toLowerCase().includes("url")) { type = "url"; placeholder = "https://..."; }
        else if (["limit","page","count","num"].includes(name)) { type = "number"; placeholder = "10"; }
        label = name.replace(/_/g, " ").replace(/\b\w/g, l => l.toUpperCase());
        params.push({ name, label, type, placeholder, required: false });
      });
    }

    if (params.length > 0) return params;
  }

  // ── 2. Known domain schemas ───────────────────────────────
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

  // ── 3. Generic default schema ─────────────────────────────
  return [
    { name: "mode",   label: "Mode",                     type: "text",   placeholder: "list",  required: true },
    { name: "query",  label: "Kata Pencarian (search)",   type: "text",   placeholder: "keyword...", required: false },
    { name: "url",    label: "URL Item (detail)",          type: "url",    placeholder: "https://...", required: false },
    { name: "limit",  label: "Limit hasil (opsional)",     type: "number", placeholder: "50",  required: false },
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

  // ── 1. Auto Bypass & Fetch HTML ────────────────────────────
  const logs = [];
  const log  = (msg) => logs.push(msg);
  let fetchResult;
  try {
    fetchResult = await fetchWithBypass(url, log);
  } catch (e) {
    return res.json({ success: false, error: e.message, elements: [], bypass_logs: logs });
  }
  const html  = fetchResult?.html;
  const layer = fetchResult?.layer;
  if (!html) {
    return res.json({
      success: false, error: fetchResult?.error || "Tidak bisa fetch HTML",
      elements: [], hint: "Semua 6 layer bypass gagal. URL mungkin butuh Puppeteer.", bypass_logs: logs,
    });
  }

  // ── 2. Deep Raw HTML Scan — semua elemen jadi checkbox ─────
  try {
    const $       = cheerio.load(html);
    const baseUrl = (() => { try { const u = new URL(url); return `${u.protocol}//${u.hostname}`; } catch { return ""; } })();
    const host    = baseUrl.replace(/https?:\/\//, "").replace("www.", "");
    const title   = $("title").first().text().trim().substring(0, 100);
    const siteType = detectSiteType(url, $, html);
    const pageInfo = detectPageType(url);

    const allElements = [];

    // ── LAYER 1: Schema.org Microdata ──────────────────────────
    $("[itemscope]").not("[itemscope] [itemscope]").each((_, el) => {
      if ($(el).closest("nav, header, footer").length) return;
      const itemType = ($(el).attr("itemtype") || "").split("/").pop() || "Item";
      const fields   = extractCardFields(el, $, baseUrl);
      if (fields.length < 2) return;
      const sel      = makeSelector(el, $);
      const fv       = (n) => fields.find(f => f.name === n)?.value || "";
      const preview  = [
        fv("title")   ? `📌 ${fv("title")}`          : null,
        fv("rating")  ? `⭐ ${fv("rating")}`          : null,
        fv("year")    ? `📅 ${fv("year")}`            : null,
        fv("quality") ? `🎬 ${fv("quality")}`         : null,
        fv("image")   ? `🖼️ ${fv("image").substring(0,70)}` : null,
        fv("link")    ? `🔗 ${fv("link").substring(0,70)}`  : null,
      ].filter(Boolean);
      allElements.push({
        id: `micro_${allElements.length}`, source: "microdata",
        category: itemType.toLowerCase(), label: `[${itemType}] microdata`,
        selector: sel, itemType, fields, rawFields: fields.map(f => f.name),
        preview, count: $(sel).not("[itemscope] [itemscope]").length || 1,
        target: `${itemType}: ${fields.map(f=>f.name).join(", ")}`, priority: 20,
      });
    });

    // ── LAYER 2: Repeating DOM groups ─────────────────────────
    const usedSels = new Set(allElements.map(e => e.selector));
    findRepeatingGroups($).forEach(group => {
      const sel = group.sel || makeSelector(group.els[0], $);
      if (usedSels.has(sel)) return;
      usedSels.add(sel);
      const sampleEls  = group.els.slice(0, 5);
      const allFields  = sampleEls.map(el => extractCardFields(el, $, baseUrl));
      const fc = {};
      allFields.forEach(fs => fs.forEach(f => { fc[f.name] = (fc[f.name]||0)+1; }));
      const consistent = Object.keys(fc)
        .filter(fn => fc[fn] >= Math.ceil(sampleEls.length * 0.4))
        .sort((a,b) => fc[b]-fc[a]);
      if (consistent.length < 2) return;
      const ff  = allFields[0] || [];
      const fv  = (n) => ff.find(f => f.name === n)?.value || "";
      const preview = [
        fv("title")   ? `📌 ${fv("title")}`          : null,
        fv("price")   ? `💰 ${fv("price")}`           : null,
        fv("rating")  ? `⭐ ${fv("rating")}`          : null,
        fv("year")    ? `📅 ${fv("year")}`            : null,
        fv("quality") ? `🎬 ${fv("quality")}`         : null,
        fv("image")   ? `🖼️ ${fv("image").substring(0,70)}` : null,
        fv("link")    ? `🔗 ${fv("link").substring(0,70)}`  : null,
      ].filter(Boolean);
      [allFields[1],allFields[2]].forEach(fs => {
        if (!fs) return;
        const t = fs.find(f=>f.name==="title");
        if (t && preview.length < 6) preview.push(`📌 ${t.value}`);
      });
      let lbl = "Card";
      if (consistent.includes("quality")||consistent.includes("rating")) lbl = siteType==="streaming"?"Film/Video":"Media";
      else if (consistent.includes("price")) lbl = "Produk";
      else if (consistent.includes("date"))  lbl = "Artikel";
      allElements.push({
        id: `dom_${allElements.length}`, source: "dom",
        category: lbl.toLowerCase().replace("/","_"),
        label: `[${lbl}] ${sel} (${group.els.length}x)`,
        selector: sel, fields: ff, rawFields: consistent, preview,
        count: group.els.length, priority: Math.round(group.score),
        target: `${group.els.length} ${lbl}: ${consistent.join(", ")} — selector: ${sel}`,
      });
    });

    // ── LAYER 3: itemprop field-level checkboxes ──────────────
    const seenProps = new Set();
    $("[itemprop]").each((_, el) => {
      const prop = $(el).attr("itemprop") || "";
      if (!prop || seenProps.has(prop)) return;
      seenProps.add(prop);
      const tag    = el.tagName;
      const sel    = `${tag}[itemprop="${prop}"]`;
      const samples = [];
      $(`[itemprop="${prop}"]`).slice(0, 3).each((_, e) => {
        const v = $(e).text().trim() || $(e).attr("src") || $(e).attr("href") || $(e).attr("content") || "";
        if (v) samples.push(v.substring(0, 80));
      });
      if (!samples.length) return;
      allElements.push({
        id: `itemprop_${prop}`, source: "itemprop", category: "field",
        label: `[itemprop="${prop}"]`,
        selector: sel, fields: [{name:prop, value:samples[0], type:"text", source:"microdata"}],
        rawFields: [prop], preview: samples.map(s=>`${prop}: ${s}`),
        count: $(`[itemprop="${prop}"]`).length, priority: 12,
        target: `itemprop ${prop}: ${samples.slice(0,2).join(" | ")}`,
      });
    });

    // ── LAYER 4: Class-based field checkboxes ─────────────────
    const seenCls = new Set();
    $("[class]").each((_, el) => {
      const tag = el.tagName;
      if (["html","body","head","script","style","noscript","nav","header","footer"].includes(tag)) return;
      if ($(el).closest("nav,header,footer,[class*='nav'],[class*='menu']").length) return;
      const cls = ($(el).attr("class")||"").split(/\s+/).filter(c=>c.length>2&&c.length<40&&!/^[0-9]/.test(c));
      if (!cls.length) return;
      const primary = cls[0];
      if (seenCls.has(primary)) return;
      seenCls.add(primary);
      const sel   = `${tag}.${primary}`;
      const count = $(sel).length;
      if (count < 2) return;
      const txt  = $(el).clone().children().remove().end().text().trim();
      const img  = $(el).find("img").first().attr("src") || $(el).find("img").first().attr("data-src") || "";
      const href = $(el).attr("href") || $(el).find("a[href]").first().attr("href") || "";
      const val  = txt || img || href;
      if (!val || val.length < 2 || val.length > 300) return;
      allElements.push({
        id: `cls_${primary}`, source: "class", category: "field",
        label: `.${primary}  (${count}x)`,
        selector: sel, fields:[{name:primary,value:val.substring(0,100),type:img?"url":href?"url":"text",source:"class"}],
        rawFields:[primary], preview:[`${sel}: ${val.substring(0,80)}`],
        count, priority: count > 5 ? 8 : 5,
        target: `${sel} (${count}x): ${val.substring(0,80)}`,
      });
    });

    // ── LAYER 5: Search form ──────────────────────────────────
    $("form").each((_, form) => {
      const si = $(form).find("input[type='search'],input[name='s'],input[name='q'],input[name*='search'],input[placeholder*='cari'],input[placeholder*='search']").first();
      if (!si.length) return;
      const action = $(form).attr("action") || "";
      const param  = si.attr("name") || "q";
      allElements.push({
        id: `form_search`, source: "form", category: "search_form",
        label: `[Form Search] action="${action}" param="${param}"`,
        selector: action ? `form[action="${action}"]` : "form",
        fields:[{name:param,value:action,type:"url",source:"form"}],
        rawFields:[param], preview:[`Search → ${action||"(halaman ini)"}`, `Param: ${param}`],
        count:1, priority:9,
        target: `form pencarian: kirim ke "${action||url}" param ${param}, scrape hasil`,
      });
    });

    // ── LAYER 6: Pagination ───────────────────────────────────
    const nextHref = $("a[rel='next']").first().attr("href") ||
      $("a").filter((_,a) => /next|selanjutnya|»/i.test($(a).text().trim())).first().attr("href") || "";
    if (nextHref) {
      allElements.push({
        id: "pagination", source: "pagination", category: "pagination",
        label: `[Pagination] next → ${nextHref.substring(0,60)}`,
        selector: "a[rel='next']",
        fields:[{name:"next_url",value:nextHref,type:"url",source:"dom"}],
        rawFields:["next_url"], preview:[`Next: ${nextHref}`],
        count:1, priority:6,
        target: `auto-follow pagination: "${nextHref}"`,
      });
    }

    // ── Sort & dedup ──────────────────────────────────────────
    const seen = new Set();
    const elements = allElements
      .sort((a,b) => (b.priority||0)-(a.priority||0))
      .filter(e => { const k=`${e.source}::${e.selector}`; if(seen.has(k))return false; seen.add(k); return true; });

    // Suggestions
    const siteSuggestions = getScraperSuggestions(siteType, elements);
    const urlSuggestions  = pageInfo.suggestions || [];
    const allSuggestions  = [
      ...urlSuggestions,
      ...siteSuggestions.filter(s => !urlSuggestions.some(u => u.label === s.label)),
    ].slice(0, 8);

    const smartSelectors = elements
      .filter(e => !["field","pagination"].includes(e.source))
      .slice(0, 8)
      .map(e => ({ category:e.category, selector:e.selector, label:e.label, count:e.count,
        fields:e.fields||[], rawFields:e.rawFields||[], priority:e.priority||0,
        source:e.source, itemType:e.itemType||null }));

    res.json({
      success:true, url, host, title, layer, siteType,
      pageType:pageInfo.pageType, platform:pageInfo.platform||null,
      pageHint:pageInfo.hint||null, searchQuery:pageInfo.searchQuery||null,
      scraperSuggestions:allSuggestions, smartSelectors,
      elementCount:elements.length, categories:[...new Set(elements.map(e=>e.category))],
      elements, bypass_logs:logs,
    });
  } catch (parseErr) {
    res.json({ success:false, error:`Parse error: ${parseErr.message}`, elements:[] });
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
//  DEEP DOM ANALYSIS ENGINE v2
//  Priority order:
//  1. Schema.org microdata (article[itemscope], itemprop)
//  2. JSON-LD structured data
//  3. Repeating DOM patterns (tag+class signature)
//  4. Universal elements (forms, pagination, nav, meta)
// ══════════════════════════════════════════════════════════════

function makeSelector(el, $) {
  const tag = el.tagName || "div";
  const cls = ($(el).attr("class") || "").split(/\s+/)
    .filter(c => c.length > 1 && c.length < 40 && !/^[0-9]/.test(c));
  if (cls.length > 0) return `${tag}.${cls.slice(0, 2).join(".")}`;
  const id = $(el).attr("id");
  if (id) return `${tag}#${id}`;
  const itemType = $(el).attr("itemtype") || "";
  if (itemType) return `${tag}[itemscope]`;
  return tag;
}

function scoreElement(el, $) {
  let score = 0;
  const hasImg   = $(el).find("img[src], img[data-src], img[data-lazy]").length > 0;
  const hasLink  = $(el).find("a[href]").length > 0;
  const txtLen   = $(el).text().trim().length;
  const hasNum   = /[\d\.]+/.test($(el).text());
  const hasMicro = $(el).attr("itemscope") !== undefined || $(el).find("[itemprop]").length > 2;
  if (hasImg)    score += 4;
  if (hasLink)   score += 3;
  if (hasMicro)  score += 6;  // microdata = sangat kaya data
  if (hasNum)    score += 1;
  if (txtLen > 20 && txtLen < 2000) score += 2;
  return score;
}

/**
 * Ekstrak field dari elemen — prioritaskan itemprop attributes (microdata)
 */
function extractCardFields(el, $, baseUrl) {
  const fields = [];
  const seen   = new Set();

  const addField = (name, value, type = "text", source = "dom") => {
    if (!value || String(value).trim().length < 1) return;
    const key = name + "::" + String(value).substring(0, 40);
    if (seen.has(key)) return;
    seen.add(key);
    fields.push({ name, value: String(value).substring(0, 300), type, source });
  };

  const absUrl = (href) => {
    if (!href) return "";
    if (href.startsWith("http")) return href;
    if (href.startsWith("//")) return "https:" + href;
    try { return new URL(href, baseUrl || "https://example.com").href; } catch { return href; }
  };

  // ── PRIORITY 1: itemprop microdata ────────────────────────
  const itempropMap = {
    "url":            (el) => addField("link",        absUrl($(el).attr("href") || $(el).attr("content") || $(el).text().trim()), "url",    "microdata"),
    "name":           (el) => addField("title",       $(el).text().trim() || $(el).attr("content") || "",                         "text",   "microdata"),
    "description":    (el) => addField("description", $(el).text().trim() || $(el).attr("content") || "",                         "text",   "microdata"),
    "image":          (el) => addField("image",       absUrl($(el).attr("src") || $(el).attr("content") || ""),                   "url",    "microdata"),
    "ratingValue":    (el) => addField("rating",      $(el).text().trim() || $(el).attr("content") || "",                         "number", "microdata"),
    "datePublished":  (el) => addField("year",        ($(el).text().trim() || $(el).attr("content") || "").substring(0, 10),      "text",   "microdata"),
    "genre":          (el) => addField("genre",       $(el).text().trim(),                                                         "text",   "microdata"),
    "duration":       (el) => addField("duration",    $(el).text().trim() || $(el).attr("content") || "",                         "text",   "microdata"),
    "director":       (el) => addField("director",    $(el).text().trim(),                                                         "text",   "microdata"),
    "actor":          (el) => addField("cast",        $(el).text().trim(),                                                         "text",   "microdata"),
    "price":          (el) => addField("price",       $(el).text().trim() || $(el).attr("content") || "",                         "price",  "microdata"),
    "availability":   (el) => addField("stock",       $(el).text().trim() || $(el).attr("content") || "",                         "text",   "microdata"),
    "episodeNumber":  (el) => addField("episode",     $(el).text().trim() || $(el).attr("content") || "",                         "number", "microdata"),
    "numberOfEpisodes": (el) => addField("episodes",  $(el).text().trim() || $(el).attr("content") || "",                         "number", "microdata"),
  };

  $(el).find("[itemprop]").addBack("[itemprop]").each((_, child) => {
    const prop = ($(child).attr("itemprop") || "").trim().toLowerCase();
    if (itempropMap[prop]) {
      try { itempropMap[prop](child); } catch {}
    } else if (prop) {
      // Unknown itemprop — tetap ekstrak
      const val = $(child).text().trim() || $(child).attr("content") || $(child).attr("src") || "";
      if (val.length > 0 && val.length < 200) addField(prop, val, "text", "microdata");
    }
  });

  // ── PRIORITY 2: data-* attributes ────────────────────────
  const dataAttrs = el.attribs || {};
  Object.keys(dataAttrs).forEach(attr => {
    if (!attr.startsWith("data-")) return;
    const val = dataAttrs[attr];
    if (!val || val.length < 1 || val.length > 300) return;
    const attrName = attr.replace("data-", "").replace(/-/g, "_");
    if (attrName === "id" || attrName === "v" || attrName === "key") return;
    addField(attrName, val, val.startsWith("http") || val.startsWith("/") ? "url" : "text", "data-attr");
  });

  // ── PRIORITY 3: Structural DOM (fallback jika tidak ada microdata) ──
  if (!fields.find(f => f.name === "title")) {
    const titleEl = $(el).find("h1,h2,h3,h4,h5,figcaption").first();
    if (titleEl.length) addField("title", titleEl.text().trim(), "text", "dom");
  }
  if (!fields.find(f => f.name === "link")) {
    const href = $(el).find("a[href]").first().attr("href") || "";
    if (href) addField("link", absUrl(href), "url", "dom");
  }
  if (!fields.find(f => f.name === "image")) {
    $(el).find("img").each((_, img) => {
      const src = $(img).attr("src") || $(img).attr("data-src") ||
                  $(img).attr("data-lazy-src") || $(img).attr("data-original") ||
                  $(img).attr("data-lazy") || $(img).attr("data-thumb") || "";
      if (src && !src.includes("data:image") && !src.includes("blank") && src.length > 5) {
        addField("image", absUrl(src), "url", "dom");
        return false;
      }
    });
  }

  // ── PRIORITY 4: Text pattern detection ────────────────────
  $(el).find("span, div, p, strong, em, small").each((_, child) => {
    const txt = $(child).clone().children().remove().end().text().trim();
    if (!txt || txt.length < 1 || txt.length > 200) return;
    const cls = ($(child).attr("class") || "").toLowerCase();

    if (!fields.find(f => f.name === "rating") &&
        (/^\d[\.,]\d$/.test(txt) || /\d+\/10/.test(txt) ||
         cls.includes("rating") || cls.includes("score") || cls.includes("imdb") ||
         cls.includes("star") || cls.includes("vote"))) {
      addField("rating", txt, "number", "pattern");
    }
    if (!fields.find(f => f.name === "year") && /^(19|20)\d{2}$/.test(txt)) {
      addField("year", txt, "number", "pattern");
    }
    if (!fields.find(f => f.name === "quality") &&
        /^(CAM|HDCAM|TS|HD|FHD|4K|BLURAY|WEB-?DL|WEBRIP|480p|720p|1080p|2160p)$/i.test(txt)) {
      addField("quality", txt, "text", "pattern");
    }
    if (!fields.find(f => f.name === "duration") &&
        (/\d+\s*(min|menit|jam|hour|ep|eps)/i.test(txt) ||
         cls.includes("duration") || cls.includes("durasi"))) {
      addField("duration", txt, "text", "pattern");
    }
    if (!fields.find(f => f.name === "episode") &&
        (/eps?\s*\d+|episode\s*\d+/i.test(txt) || cls.includes("episode") || cls.includes("eps"))) {
      addField("episode", txt, "text", "pattern");
    }
    if (!fields.find(f => f.name === "price") &&
        /^(rp|idr|\$|€)?[\s]?[\d\.,]+\s*(rb|jt|k)?$/i.test(txt)) {
      addField("price", txt, "price", "pattern");
    }
  });

  return fields;
}

/**
 * PRIORITY 1: Deteksi Schema.org microdata elements
 * article[itemscope], div[itemscope], li[itemscope] — sangat reliable
 */
function findMicrodataGroups($) {
  const groups = {};

  $("[itemscope]").each((_, el) => {
    const itemType = $(el).attr("itemtype") || "unknown";
    // Jangan ambil nested itemscope (hanya top-level)
    if ($(el).parents("[itemscope]").length > 0) return;
    // Jangan ambil elemen yang ada di nav/header/footer
    if ($(el).closest("nav, header, footer").length > 0) return;

    const typeShort = itemType.split("/").pop() || "Item";
    if (!groups[typeShort]) groups[typeShort] = { itemType, typeShort, els: [] };
    groups[typeShort].els.push(el);
  });

  return Object.values(groups).filter(g => g.els.length >= 1);
}

/**
 * PRIORITY 2: Repeating DOM groups (fallback jika tidak ada microdata)
 */
function findRepeatingGroups($, minCount = 3, maxGroups = 6) {
  const sigMap = {};

  $("li, article, div, tr").each((_, el) => {
    const tag = el.tagName;
    const cls = ($(el).attr("class") || "").split(/\s+/)
      .filter(c => c.length > 1 && c.length < 50 && !/^[0-9]/.test(c));

    // Butuh setidaknya 1 class untuk jadi signature
    if (cls.length === 0) return;

    const sig     = `${tag}.${cls.slice(0, 2).sort().join(".")}`;
    const txtLen  = $(el).text().trim().length;
    const childCt = $(el).children().length;

    if (childCt < 1 || txtLen < 10 || txtLen > 10000) return;
    // Skip nav/header/footer/sidebar
    if ($(el).closest("nav, header, footer, [class*='nav'], [class*='menu'], [class*='sidebar'], [class*='footer'], [class*='header']").length) return;
    // Skip elemen yang merupakan container dari repeating group lain (terlalu besar)
    if (txtLen > 3000 && childCt < 3) return;

    if (!sigMap[sig]) sigMap[sig] = { sig, sel: `${tag}.${cls[0]}`, els: [], score: 0 };
    sigMap[sig].els.push(el);
  });

  return Object.values(sigMap)
    .filter(g => g.els.length >= minCount)
    .map(g => {
      const sample   = g.els.slice(0, 3);
      const avgScore = sample.reduce((s, el) => s + scoreElement(el, $), 0) / sample.length;
      const hasImg   = sample.some(el => $(el).find("img[src], img[data-src]").length > 0);
      const hasLink  = sample.some(el => $(el).find("a[href]").length > 0);
      g.score = g.els.length * 0.4 + avgScore * 2.5 + (hasImg ? 6 : 0) + (hasLink ? 4 : 0);
      return g;
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, maxGroups);
}

/**
 * ENGINE UTAMA: Deep DOM Analysis
 */
function detectSmartElements(url, $, htmlRaw, siteType) {
  const elements = [];
  const baseUrl  = (() => {
    try { const u = new URL(url); return `${u.protocol}//${u.hostname}`; } catch { return ""; }
  })();

  // ══════════════════════════════════════════════════════════
  //  LAYER 1: Schema.org Microdata (PALING AKURAT)
  // ══════════════════════════════════════════════════════════
  const microdataGroups = findMicrodataGroups($);

  microdataGroups.forEach(group => {
    const sampleEls = group.els.slice(0, 5);
    const allFields = sampleEls.map(el => extractCardFields(el, $, baseUrl));

    // Count field consistency
    const fieldCounts = {};
    allFields.forEach(fs => fs.forEach(f => {
      fieldCounts[f.name] = (fieldCounts[f.name] || 0) + 1;
    }));
    const consistentFields = Object.keys(fieldCounts)
      .filter(fn => fieldCounts[fn] >= Math.ceil(sampleEls.length * 0.3))
      .sort((a, b) => fieldCounts[b] - fieldCounts[a]);

    const firstFields  = allFields[0] || [];
    const previewLines = [];

    const fv = (name) => firstFields.find(f => f.name === name)?.value || "";
    if (fv("title"))    previewLines.push(`📌 ${fv("title")}`);
    if (fv("rating"))   previewLines.push(`⭐ ${fv("rating")}`);
    if (fv("year"))     previewLines.push(`📅 ${fv("year")}`);
    if (fv("quality"))  previewLines.push(`🎬 ${fv("quality")}`);
    if (fv("episode"))  previewLines.push(`📺 Ep. ${fv("episode")}`);
    if (fv("duration")) previewLines.push(`⏱ ${fv("duration")}`);
    if (fv("image"))    previewLines.push(`🖼️ ${fv("image").substring(0, 80)}`);
    if (fv("link"))     previewLines.push(`🔗 ${fv("link").substring(0, 80)}`);

    // Add more from samples 2-3
    [allFields[1], allFields[2]].forEach(fs => {
      if (!fs) return;
      const t = fs.find(f => f.name === "title");
      if (t && !previewLines.some(l => l.includes(t.value.substring(0, 20)))) {
        previewLines.push(`📌 ${t.value}`);
      }
    });

    const sel = `article[itemscope][itemtype*="${group.typeShort}"], [itemtype*="${group.typeShort}"][itemscope]`;
    const simpleSel = makeSelector(group.els[0], $);

    elements.push({
      category:  group.typeShort.toLowerCase(),
      label:     `${group.typeShort} (${group.els.length} item) — microdata: ${consistentFields.slice(0, 5).join(", ")}`,
      selector:  simpleSel,
      selectorFull: sel,
      preview:   previewLines.slice(0, 6),
      count:     group.els.length,
      target:    `${group.els.length} ${group.typeShort} dari microdata — field: ${consistentFields.join(", ")} — selector: ${simpleSel}`,
      priority:  20 + group.els.length,
      fields:    firstFields,
      rawFields: consistentFields,
      source:    "microdata",
      itemType:  group.itemType,
    });
  });

  // ══════════════════════════════════════════════════════════
  //  LAYER 2: JSON-LD Structured Data
  // ══════════════════════════════════════════════════════════
  const jsonLdItems = [];
  $("script[type='application/ld+json']").each((_, el) => {
    try {
      const raw = $(el).text().trim();
      const obj = JSON.parse(raw);
      const items = Array.isArray(obj) ? obj : [obj];
      items.forEach(item => {
        if (!item) return;
        const type = item["@type"] || "Unknown";
        const entry = { type, raw: JSON.stringify(item).substring(0, 500) };
        // Extract key fields from JSON-LD
        const fields = [];
        ["name","headline","title","url","image","description","datePublished",
         "price","ratingValue","author","genre","duration"].forEach(k => {
          if (item[k]) fields.push({ name: k, value: String(typeof item[k] === "object" ? JSON.stringify(item[k]) : item[k]).substring(0, 150), type: "text" });
        });
        entry.fields = fields;
        jsonLdItems.push(entry);
      });
    } catch {}
  });

  if (jsonLdItems.length) {
    const types = [...new Set(jsonLdItems.map(j => j.type))];
    const previewFields = (jsonLdItems[0]?.fields || []).map(f => `${f.name}: ${f.value.substring(0, 60)}`);
    elements.push({
      category:  "structured",
      label:     `JSON-LD: ${types.join(", ")} (${jsonLdItems.length} objek)`,
      selector:  "script[type='application/ld+json']",
      preview:   previewFields.slice(0, 5),
      count:     jsonLdItems.length,
      target:    `JSON-LD ${types.join("/")} — field tersedia: ${(jsonLdItems[0]?.fields||[]).map(f=>f.name).join(", ")}`,
      priority:  18,
      fields:    jsonLdItems[0]?.fields || [],
      rawFields: (jsonLdItems[0]?.fields || []).map(f => f.name),
      source:    "json-ld",
    });
  }

  // ══════════════════════════════════════════════════════════
  //  LAYER 3: Repeating DOM Groups (jika microdata kosong)
  // ══════════════════════════════════════════════════════════
  const microdataSelectors = new Set(elements.map(e => e.selector));
  const groups = findRepeatingGroups($);

  groups.forEach(group => {
    // Skip jika sudah ditangkap microdata
    const sel = group.sel || makeSelector(group.els[0], $);
    if (microdataSelectors.has(sel)) return;

    const sampleEls  = group.els.slice(0, 5);
    const allFields  = sampleEls.map(el => extractCardFields(el, $, baseUrl));

    const fieldCounts = {};
    allFields.forEach(fs => fs.forEach(f => {
      fieldCounts[f.name] = (fieldCounts[f.name] || 0) + 1;
    }));
    const consistentFields = Object.keys(fieldCounts)
      .filter(fn => fieldCounts[fn] >= Math.ceil(sampleEls.length * 0.4))
      .sort((a, b) => fieldCounts[b] - fieldCounts[a]);

    if (consistentFields.length === 0) return;

    const firstFields  = allFields[0] || [];
    const previewLines = [];
    const fv = (name) => firstFields.find(f => f.name === name)?.value || "";

    if (fv("title"))    previewLines.push(`📌 ${fv("title")}`);
    if (fv("price"))    previewLines.push(`💰 ${fv("price")}`);
    if (fv("rating"))   previewLines.push(`⭐ ${fv("rating")}`);
    if (fv("year"))     previewLines.push(`📅 ${fv("year")}`);
    if (fv("quality"))  previewLines.push(`🎬 ${fv("quality")}`);
    if (fv("image"))    previewLines.push(`🖼️ ${fv("image").substring(0, 70)}`);
    if (fv("link"))     previewLines.push(`🔗 ${fv("link").substring(0, 70)}`);

    [allFields[1], allFields[2]].forEach(fs => {
      if (!fs) return;
      const t = fs.find(f => f.name === "title");
      if (t && !previewLines.some(l => l.includes(t.value.substring(0, 15)))) {
        previewLines.push(`📌 ${t.value}`);
      }
    });

    let cardType = "Card";
    if (consistentFields.includes("quality") || consistentFields.includes("rating")) cardType = "Film/Video";
    else if (consistentFields.includes("price")) cardType = "Produk";
    else if (consistentFields.includes("date")) cardType = "Artikel";

    elements.push({
      category:  cardType.toLowerCase().replace("/", "_"),
      label:     `${cardType} List (${group.els.length} item) — ${consistentFields.slice(0, 4).join(", ")}`,
      selector:  sel,
      preview:   previewLines.slice(0, 6),
      count:     group.els.length,
      target:    `${group.els.length} ${cardType} — field: ${consistentFields.join(", ")} — selector: ${sel}`,
      priority:  Math.round(group.score),
      fields:    firstFields,
      rawFields: consistentFields,
      source:    "dom",
    });
  });

  // ══════════════════════════════════════════════════════════
  //  LAYER 4: Universal Elements
  // ══════════════════════════════════════════════════════════

  // Search form
  $("form").each((_, form) => {
    const inputs = $(form).find("input");
    const isSearch = inputs.filter((_, inp) => {
      const t   = ($(inp).attr("type")        || "").toLowerCase();
      const n   = ($(inp).attr("name")        || "").toLowerCase();
      const p   = ($(inp).attr("placeholder") || "").toLowerCase();
      return t === "search" || n.includes("search") || n === "s" || n === "q" ||
             p.includes("cari") || p.includes("search") || p.includes("find");
    }).length > 0;
    if (!isSearch) return;

    const action     = $(form).attr("action") || "";
    const method     = ($(form).attr("method") || "GET").toUpperCase();
    const inputNames = inputs.map((_, i) => $(i).attr("name") || "").get().filter(Boolean);

    elements.push({
      category: "search_form",
      label:    `Form Pencarian → ${action || "(halaman ini)"}`,
      selector: action ? `form[action="${action}"]` : "form",
      preview:  [`Action: ${action || "(halaman ini)"}`, `Method: ${method}`, `Params: ${inputNames.join(", ")}`],
      count:    1,
      target:   `form pencarian: kirim keyword ke "${action || url}" dengan params ${inputNames.join(", ")}, ambil semua hasil`,
      priority: 8,
      source:   "dom",
    });
  });

  // Pagination
  const nextLink = $("a[rel='next']").first().attr("href") ||
                   $("a").filter((_, a) => /next|selanjutnya|»|›|\bnext\b/i.test($(a).text().trim())).first().attr("href") ||
                   $("[class*='next'] a, [class*='pagination'] a").last().attr("href") || "";
  const pageLinks = $("[class*='pagination'] a, [class*='paging'] a, a[href*='page='], a[href*='/page/']").filter((_, a) => {
    return /^\d+$/.test($(a).text().trim()) || /next|prev|»|«/i.test($(a).text().trim());
  });

  if (pageLinks.length > 0 || nextLink) {
    elements.push({
      category: "pagination",
      label:    `Pagination (${pageLinks.length} link)`,
      selector: "a[rel='next'], [class*='pagination'] a",
      preview:  [
        nextLink ? `Next URL: ${absUrl(nextLink, baseUrl)}` : "",
        ...pageLinks.slice(0, 3).map((_, a) => `${$(a).text().trim()} → ${$(a).attr("href") || ""}`).get(),
      ].filter(Boolean),
      count:    pageLinks.length,
      target:   `pagination: ikuti "${nextLink || "halaman berikutnya"}" untuk scrape semua halaman`,
      priority: 5,
      source:   "dom",
    });
  }

  // Navigation links (genre, kategori)
  const navLinkGroups = {};
  $("nav a[href], [class*='genre'] a, [class*='cat'] a, [class*='menu'] a").each((_, a) => {
    const href   = $(a).attr("href") || "";
    const txt    = $(a).text().trim();
    const parent = $(a).parent()[0];
    if (!txt || txt.length > 50 || !parent) return;
    const pSig   = makeSelector(parent, $);
    if (!navLinkGroups[pSig]) navLinkGroups[pSig] = [];
    navLinkGroups[pSig].push({ txt, href });
  });
  Object.values(navLinkGroups).forEach(items => {
    if (items.length < 3) return;
    const unique = [...new Map(items.map(i => [i.txt, i])).values()];
    if (unique.length < 3) return;
    elements.push({
      category: "navigation",
      label:    `Navigasi: ${unique.slice(0, 3).map(i => i.txt).join(", ")}... (${unique.length})`,
      selector: "nav a",
      preview:  unique.slice(0, 5).map(i => `${i.txt} → ${i.href}`),
      count:    unique.length,
      target:   `navigasi: ${unique.map(i => i.txt).slice(0, 6).join(", ")} — nama dan URL tiap link`,
      priority: 4,
      source:   "dom",
    });
  });

  // Meta tags
  const metaData = [];
  $("meta[name], meta[property]").each((_, el) => {
    const name    = $(el).attr("name") || $(el).attr("property") || "";
    const content = $(el).attr("content") || "";
    if (!name || !content || content.length < 3) return;
    if (/viewport|charset|robots|generator|theme|verify/i.test(name)) return;
    metaData.push(`${name}: ${content.substring(0, 80)}`);
  });
  if (metaData.length) {
    elements.push({
      category: "meta",
      label:    `Meta/OG Tags (${metaData.length})`,
      selector: "meta[name], meta[property]",
      preview:  metaData.slice(0, 5),
      count:    metaData.length,
      target:   `meta tags: ${metaData.slice(0, 3).map(m => m.split(":")[0]).join(", ")}`,
      priority: 2,
      source:   "dom",
    });
  }

  // Sort by priority, deduplicate
  const seen = new Set();
  return elements
    .sort((a, b) => (b.priority || 0) - (a.priority || 0))
    .filter(e => {
      const key = `${e.category}::${e.selector}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function absUrl(href, baseUrl) {
  if (!href) return "";
  if (href.startsWith("http")) return href;
  if (href.startsWith("//")) return "https:" + href;
  try { return new URL(href, baseUrl || "https://example.com").href; } catch { return href; }
}

/**
 * Build smart suggestions dari hasil deep DOM analysis
 */
function getScraperSuggestions(siteType, elements) {
  const suggestions = [];

  // Dari microdata elements (paling reliable)
  elements.filter(e => e.source === "microdata").forEach(el => {
    const fields = (el.rawFields || []).slice(0, 6).join(", ");
    suggestions.push({
      label: `🎯 ${el.label}`,
      desc:  `Scrape ${el.count} ${el.category} menggunakan selector "${el.selector}" — field: ${fields} — data dari Schema.org microdata (sangat akurat)`,
    });
  });

  // Dari JSON-LD
  elements.filter(e => e.source === "json-ld").forEach(el => {
    suggestions.push({
      label: `🗄️ ${el.label}`,
      desc:  `Ekstrak JSON-LD embedded: ${el.target}`,
    });
  });

  // Dari DOM repeating groups
  elements.filter(e => e.source === "dom" && ["film_video","produk","artikel","card"].includes(e.category)).forEach(el => {
    const fields = (el.rawFields || []).slice(0, 5).join(", ");
    suggestions.push({
      label: `📦 ${el.label}`,
      desc:  `Scrape ${el.count} item dengan selector "${el.selector}" — field: ${fields}`,
    });
  });

  // Search form
  elements.filter(e => e.category === "search_form").forEach(el => {
    suggestions.push({
      label: `🔍 Hasil Pencarian`,
      desc:  el.target,
    });
  });

  // Pagination
  elements.filter(e => e.category === "pagination").forEach(el => {
    suggestions.push({
      label: `📄 Semua Halaman (Auto-Pagination)`,
      desc:  el.target,
    });
  });

  // Context-based additions
  const contextual = {
    streaming: [
      { label: "🎬 Daftar Film + Poster + Rating", desc: "Scrape semua film: judul, URL poster, tahun, rating, genre, episode count, link detail — dengan auto-pagination" },
      { label: "📺 Episode & Link Streaming",       desc: "Dari halaman detail film/series: ambil semua episode beserta link streaming" },
      { label: "🎭 Detail Film Lengkap",             desc: "Detail: sinopsis, pemain, sutradara, tahun, genre, durasi, rating IMDB, embed player URL" },
    ],
    ecommerce: [
      { label: "🛍️ Produk + Harga + Rating",        desc: "Scrape semua produk: nama, harga normal, harga diskon, rating, jumlah review, URL gambar, link" },
      { label: "⭐ Review & Komentar Pembeli",       desc: "Dari halaman produk: bintang, teks review, nama pembeli, tanggal" },
    ],
    news: [
      { label: "📰 Berita + Tanggal + Penulis",      desc: "Scrape daftar berita: judul, tanggal, nama penulis, thumbnail, link artikel" },
      { label: "📝 Isi Artikel Lengkap",             desc: "Buka tiap artikel: judul, semua paragraf, gambar, tags, tanggal" },
    ],
  };
  (contextual[siteType] || []).forEach(s => {
    if (!suggestions.some(x => x.label === s.label)) suggestions.push(s);
  });

  if (!suggestions.some(s => s.label.includes("Pagination") || s.label.includes("Halaman"))) {
    suggestions.push({
      label: "📄 Scrape Semua Halaman",
      desc:  "Auto-follow pagination: scrape dari halaman 1 sampai terakhir, kumpulkan semua data",
    });
  }

  return suggestions.slice(0, 8);
}


// ══════════════════════════════════════════════════════════════
//  POST /api/preview-html  —  Visual Element Picker
//  Fetch HTML bypass → rewrite URLs → inject picker script
// ══════════════════════════════════════════════════════════════
app.post("/api/preview-html", async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: "url diperlukan" });

  let fetchResult;
  try { fetchResult = await fetchWithBypass(url, () => {}); }
  catch (e) { return res.status(500).json({ error: `Fetch gagal: ${e.message}` }); }
  if (!fetchResult?.html) {
    return res.status(500).json({ error: fetchResult?.error || "HTML tidak bisa diambil." });
  }

  let html = fetchResult.html;

  // Tambah base tag supaya resource relative load
  if (!html.includes("<base")) {
    html = html.replace(/<head([^>]*)>/i, `<head$1><base href="${url}">`);
    if (!html.includes("<base")) html = `<html><head><base href="${url}"></head><body>${html}</body></html>`;
  }

  // Hapus script (biarkan JSON-LD)
  html = html.replace(/<script(?![^>]*application\/ld\+json)[^>]*>[\s\S]*?<\/script>/gi, "");
  html = html.replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, "");

  // Inject visual picker
  const PICKER = `
<style>
.__sai_hover{outline:2px solid #00c2ff!important;outline-offset:1px!important;cursor:crosshair!important;background-color:rgba(0,194,255,.07)!important}
.__sai_selected{outline:3px solid #2effa8!important;background-color:rgba(46,255,168,.1)!important}
#__sai_badge{
  position:fixed;top:8px;left:50%;transform:translateX(-50%);
  background:rgba(0,0,0,.93);color:#2effa8;border:1px solid rgba(46,255,168,.5);
  padding:5px 14px;border-radius:7px;font:11px/1.5 monospace;
  z-index:2147483647;pointer-events:none;white-space:nowrap;display:none;
  max-width:90vw;overflow:hidden;text-overflow:ellipsis;
}
#__sai_bar{
  position:fixed;bottom:0;left:0;right:0;z-index:2147483647;
  background:rgba(8,12,18,.97);border-top:1px solid rgba(46,255,168,.4);
  padding:7px 16px;display:flex;align-items:center;gap:10px;
  font:11px monospace;color:#888;user-select:none;
  /* toolbar tidak intercept hover/click dari picker */
  pointer-events:all;
}
#__sai_bar button{
  background:#2effa8;color:#000;border:none;padding:4px 13px;
  border-radius:5px;cursor:pointer;font:700 11px monospace;
  pointer-events:all;
}
#__sai_bar .d{background:#ff4560;color:#fff;}
#__sai_bar .cnt{color:#2effa8;font-weight:700;margin:0 2px;}
</style>
<div id="__sai_badge"></div>
<div id="__sai_bar" data-sai-toolbar="1">
  <span>Visual Picker</span>
  <span>Dipilih: <span id="__sai_cnt" class="cnt">0</span> elemen</span>
  <button data-sai-btn="done" onclick="window.__sai_done()">Selesai</button>
  <button data-sai-btn="clear" class="d" onclick="window.__sai_clear()">Clear</button>
</div>
<script>
(function(){
'use strict';

var selected = [];
var hovered  = null;
var SKIP_TAGS = {html:1,body:1,head:1,script:1,style:1,noscript:1,meta:1,link:1};

/* --- Guard: apakah elemen ini bagian dari toolbar SAI? --- */
function isSAIEl(el) {
  if (!el || el.nodeType !== 1) return true;
  var cur = el;
  while (cur) {
    if (cur.id === '__sai_bar' || cur.id === '__sai_badge') return true;
    if (cur.getAttribute && cur.getAttribute('data-sai-toolbar')) return true;
    if (cur.getAttribute && cur.getAttribute('data-sai-btn')) return true;
    cur = cur.parentElement;
  }
  return false;
}

/* --- Buat selector dasar untuk satu elemen --- */
function baseSelector(el) {
  if (!el || el.nodeType !== 1) return null;
  var tag = el.tagName.toLowerCase();
  if (SKIP_TAGS[tag]) return null;

  // 1. id unik
  if (el.id && !/^[0-9]/.test(el.id) && document.querySelectorAll('#'+el.id).length === 1)
    return '#' + el.id;

  // 2. itemprop (microdata — sangat spesifik)
  var ip = el.getAttribute('itemprop');
  if (ip) return tag + '[itemprop="' + ip + '"]';

  // 3. class (ambil 2 class terpanjang, filter utility classes)
  var cls = Array.from(el.classList || [])
    .filter(function(c){ return c.length > 2 && c.length < 40 && !/^[0-9a-f]{5,}$/.test(c) && !/^(active|open|show|hide|is-|js-)/.test(c); })
    .sort(function(a,b){ return b.length - a.length; });
  if (cls.length) return tag + '.' + cls.slice(0,2).join('.');

  // 4. itemscope container
  if (el.getAttribute('itemtype')) return tag + '[itemscope]';

  return tag;
}

/* --- Context-aware selector: include parent section jika selector terlalu generic ---
   Misal: div.item di dalam section.hot-section → "section.hot-section div.item"
   Ini yang membedakan Hot Videos vs Latest Videos
*/
function buildContextSelector(el) {
  var childSel = baseSelector(el);
  if (!childSel) return null;

  // Hitung berapa banyak elemen dengan selector ini di seluruh dokumen
  var totalCount = 0;
  try { totalCount = document.querySelectorAll(childSel).length; } catch(e) { return childSel; }

  // Jika <= 3, selector sudah spesifik cukup
  if (totalCount <= 3) return childSel;

  // Walk up parent untuk cari container yang membatasi scope
  var parent = el.parentElement;
  var depth = 0;
  while (parent && depth < 8) {
    var pTag = (parent.tagName || '').toLowerCase();
    if (SKIP_TAGS[pTag] || pTag === 'main' || pTag === 'article') break;

    var pSel = baseSelector(parent);
    if (!pSel || pSel === pTag) { parent = parent.parentElement; depth++; continue; }

    // Cek berapa banyak childSel di dalam parent ini
    var scopedCount = 0;
    try { scopedCount = parent.querySelectorAll(childSel).length; } catch(e) {}

    // Jika parent membatasi scope dengan signifikan (< 50% dari total)
    if (scopedCount > 0 && scopedCount < totalCount * 0.6) {
      var combined = pSel + ' ' + childSel;
      // Verifikasi combined selector valid
      try {
        var verifyCount = document.querySelectorAll(combined).length;
        if (verifyCount > 0 && verifyCount <= scopedCount) {
          return combined;
        }
      } catch(e) {}
    }

    parent = parent.parentElement;
    depth++;
  }

  return childSel;
}

/* --- Extract field data dari elemen --- */
function extractFields(el) {
  var f = [], seen = {};
  function add(n, v, s) {
    if (!n || !v || seen[n]) return;
    var vs = String(v).trim();
    if (!vs || vs.length > 300) return;
    seen[n] = 1;
    f.push({ name: n, value: vs.substring(0, 200), source: s });
  }

  // itemprop (microdata — paling akurat)
  var props = el.querySelectorAll('[itemprop]');
  Array.from(props).forEach(function(c) {
    var p = c.getAttribute('itemprop');
    var v = c.textContent.trim() || c.getAttribute('src') || c.getAttribute('href') || c.getAttribute('content') || '';
    if (p && v) add(p, v, 'microdata');
  });

  // heading = title
  var h = el.querySelector('h1,h2,h3,h4,h5');
  if (h && h.textContent.trim()) add('title', h.textContent.trim(), 'dom');

  // link
  var a = el.querySelector('a[href]');
  if (a) add('link', a.href || a.getAttribute('href') || '', 'dom');

  // image (coba semua lazy-load attributes)
  var img = el.querySelector('img');
  if (img) {
    var src = img.getAttribute('data-src') || img.getAttribute('data-lazy') ||
              img.getAttribute('data-original') || img.getAttribute('data-lazy-src') ||
              img.getAttribute('data-thumbnail_url') || img.src || '';
    if (src && src.indexOf('data:') < 0 && src.length > 4) add('image', src, 'dom');
  }

  // data-* attributes
  Array.from(el.attributes || []).forEach(function(attr) {
    if (!attr.name.startsWith('data-')) return;
    var v = attr.value;
    if (!v || v.length > 300) return;
    var n = attr.name.replace('data-','').replace(/-/g,'_');
    if (['id','v','key','index','aos','wow'].includes(n)) return;
    add(n, v, 'data-attr');
  });

  // Scan text patterns: rating, year, quality, price
  var spans = el.querySelectorAll('span,strong,em,small,div,p');
  Array.from(spans).forEach(function(sp) {
    var t = sp.textContent.trim();
    if (!t || t.length > 100) return;
    if (!seen.rating  && /^\\d[.,]\\d$/.test(t))                         add('rating',  t, 'pattern');
    if (!seen.year    && /^(19|20)\\d{2}$/.test(t))                      add('year',    t, 'pattern');
    if (!seen.quality && /^(HD|FHD|4K|720p|1080p|BLURAY|WEB-?DL|CAM|TS|WEBRIP)$/i.test(t)) add('quality', t, 'pattern');
    if (!seen.episode && /^(ep|eps?|episode)\\s*\\d+/i.test(t))           add('episode', t, 'pattern');
    if (!seen.price   && /^(Rp|\\$|USD)?\\s?[\\d.,]+\\s*(rb|jt|k|m)?$/i.test(t) && t.length < 20) add('price', t, 'pattern');
  });

  // Fallback: ambil teks pertama yang berarti
  if (!seen.title && !seen.text) {
    var tx = el.textContent.trim().replace(/\\s+/g,' ').substring(0,100);
    if (tx) add('text', tx, 'dom');
  }

  return f;
}

function getItemType(el) {
  var it = el.getAttribute && el.getAttribute('itemtype');
  return it ? it.split('/').pop() : '';
}

function updateBadge(el) {
  var badge = document.getElementById('__sai_badge');
  if (!badge || !el) return;
  var ctxSel = buildContextSelector(el);
  if (!ctxSel) { badge.style.display = 'none'; return; }
  var n = 0;
  try { n = document.querySelectorAll(ctxSel).length; } catch(e) {}
  var it = getItemType(el);
  badge.style.display = 'block';
  badge.textContent   = (it ? '[' + it + '] ' : '') + ctxSel + ' -- ' + n + ' item';
}

/* --- Event: mouseover --- */
function onMouseOver(e) {
  var el = e.target;
  if (!el || SKIP_TAGS[(el.tagName||'').toLowerCase()]) return;
  if (isSAIEl(el)) return;

  if (hovered && hovered !== el) hovered.classList.remove('__sai_hover');
  hovered = el;
  el.classList.add('__sai_hover');
  updateBadge(el);
  e.stopPropagation();
}

/* --- Event: mouseout --- */
function onMouseOut(e) {
  var el = e.target;
  if (el && !el.classList.contains('__sai_selected')) el.classList.remove('__sai_hover');
  var badge = document.getElementById('__sai_badge');
  if (badge) badge.style.display = 'none';
}

/* --- Auto-detect pagination patterns di halaman --- */
function detectPagination() {
  var p = { found: false, type: null, selector: null, nextUrl: null, paramName: null, totalPages: null };

  // 1. rel="next" link — paling reliable
  var nextLink = document.querySelector('a[rel="next"]');
  if (nextLink) {
    p.found    = true;
    p.type     = 'rel_next';
    p.selector = 'a[rel="next"]';
    p.nextUrl  = nextLink.href;
    return p;
  }

  // 2. URL pattern detection (page=2, /page/2, ?p=2, hal=2, etc)
  var allLinks = Array.from(document.querySelectorAll('a[href]'));
  var pagePatterns = [
    { re: /[?&](page|p|hal|pg|paged|num)=(\d+)/i,  param: function(m){ return m[1]; } },
    { re: /\/page\/(\d+)/i,                           param: function(){ return 'page_path'; } },
    { re: /\/p\/(\d+)\/?$/i,                          param: function(){ return 'p_path'; } },
  ];
  var pageNums = [];
  var bestLink = null;
  allLinks.forEach(function(a) {
    var href = a.href || '';
    pagePatterns.forEach(function(pat) {
      var m = href.match(pat.re);
      if (m) {
        var num = parseInt(m[m.length-1], 10);
        if (num > 1) {
          pageNums.push(num);
          if (!bestLink || num > parseInt((bestLink.href.match(pat.re)||[0,0]).pop(), 10)) {
            bestLink = a;
            p.paramName = pat.param(m);
          }
        }
      }
    });
  });

  if (bestLink && pageNums.length > 0) {
    p.found      = true;
    p.type       = 'url_param';
    p.selector   = 'a[href*="page"]';
    p.nextUrl    = bestLink.href;
    p.totalPages = Math.max.apply(null, pageNums);
    return p;
  }

  // 3. "Load More" / "Next" button
  var loadMoreSels = [
    'button[class*="next"]', 'button[class*="load"]', 'button[class*="more"]',
    'a[class*="next"]',      'a[class*="load"]',      'a[class*="more"]',
    '.next a', '.pagination .next', '[aria-label="Next"]',
  ];
  for (var i = 0; i < loadMoreSels.length; i++) {
    var btn = document.querySelector(loadMoreSels[i]);
    if (btn) {
      p.found    = true;
      p.type     = 'button_next';
      p.selector = loadMoreSels[i];
      p.nextUrl  = btn.href || null;
      return p;
    }
  }

  // 4. Infinite scroll indicator
  var infiniteSels = [
    '[class*="infinite"]', '[data-infinite]', '[class*="load-more"]',
    '[class*="autoload"]', '[id*="infinite"]',
  ];
  for (var j = 0; j < infiniteSels.length; j++) {
    if (document.querySelector(infiniteSels[j])) {
      p.found    = true;
      p.type     = 'infinite_scroll';
      p.selector = infiniteSels[j];
      return p;
    }
  }

  return p;
}

/* --- Event: click --- */
function onClick(e) {
  // PENTING: skip jika ini toolbar SAI
  if (isSAIEl(e.target)) return;

  e.preventDefault();
  e.stopPropagation();

  var el = e.target;
  if (!el || SKIP_TAGS[(el.tagName||'').toLowerCase()]) return;

  var ctxSel = buildContextSelector(el);
  if (!ctxSel) return;

  var fields    = extractFields(el);
  var it        = getItemType(el);
  var allEls    = [];
  try { allEls = Array.from(document.querySelectorAll(ctxSel)); } catch(x) {}
  var cnt = allEls.length;

  // Toggle selection
  var existing = selected.findIndex(function(s){ return s.selector === ctxSel; });

  if (existing >= 0) {
    // Deselect
    selected.splice(existing, 1);
    allEls.forEach(function(x){ x.classList.remove('__sai_selected','__sai_hover'); });
  } else {
    // Auto-detect pagination setiap kali pilih elemen baru
    var pag = detectPagination();

    var item = {
      id:         'v_' + Date.now(),
      source:     it ? 'microdata' : 'visual',
      category:   it ? it.toLowerCase() : (el.tagName||'div').toLowerCase(),
      label:      (it ? '[' + it + '] ' : '') + ctxSel + ' (' + cnt + 'x)',
      selector:   ctxSel,
      itemType:   it || null,
      fields:     fields,
      rawFields:  fields.map(function(f){ return f.name; }),
      preview:    fields.slice(0,5).map(function(f){ return f.name + ': ' + f.value.substring(0,60); }),
      count:      cnt,
      target:     ctxSel + ' (' + cnt + 'x): ' + fields.map(function(f){ return f.name; }).join(', '),
      priority:   it ? 20 : 15,
      pagination: pag,  // Auto-detected pagination info
    };
    selected.push(item);
    allEls.forEach(function(x){ x.classList.add('__sai_selected'); });

    // Update badge dengan pagination info
    var badge = document.getElementById('__sai_badge');
    if (badge && pag.found) {
      badge.style.display = 'block';
      badge.textContent   = ctxSel + ' + ' + (pag.type === 'infinite_scroll' ? 'infinite scroll' : pag.totalPages ? pag.totalPages + ' halaman' : 'pagination') + ' terdeteksi';
    }
  }

  document.getElementById('__sai_cnt').textContent = selected.length;
  window.parent.postMessage({ type: '__sai_selection', items: selected }, '*');
}

/* --- Toolbar actions --- */
window.__sai_done = function() {
  window.parent.postMessage({ type: '__sai_done', items: selected }, '*');
};

window.__sai_clear = function() {
  document.querySelectorAll('.__sai_selected,.__sai_hover').forEach(function(el){
    el.classList.remove('__sai_selected','__sai_hover');
  });
  selected = [];
  document.getElementById('__sai_cnt').textContent = '0';
  window.parent.postMessage({ type: '__sai_selection', items: [] }, '*');
};

/* --- Attach events dengan capture=false untuk mouseover/out, capture=true untuk click tapi dengan guard --- */
document.addEventListener('mouseover', onMouseOver, false);
document.addEventListener('mouseout',  onMouseOut,  false);
document.addEventListener('click',     onClick,     true);

window.parent.postMessage({ type: '__sai_ready' }, '*');
})();
</script>`;

  if (html.includes("</body>")) html = html.replace("</body>", PICKER + "</body>");
  else html += PICKER;

  res.json({ success: true, url, layer: fetchResult.layer, html });
});

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

    // ── System prompts per lang ───────────────────────────────
    const RULES = `ATURAN OUTPUT:
1. Output HANYA kode MENTAH — tidak ada markdown, backtick, penjelasan di luar kode
2. Kode HARUS LENGKAP dari baris pertama sampai module.exports — JANGAN potong
3. Semua fungsi HARUS punya closing bracket yang benar
4. Komentar boleh dalam bahasa Indonesia di dalam kode`;

    const sysMap = {
      nodejs: `Kamu adalah senior Node.js scraping engineer.
Gunakan: axios + cheerio${bCF ? " + puppeteer-extra stealth jika JavaScript site" : ""}.
Output adalah Express.js router file — BUKAN standalone script.
${RULES}`,
      python: `Kamu adalah senior Python scraping engineer.
Gunakan: requests + BeautifulSoup4${bCF ? " + cloudscraper" : ""}.
Output adalah Flask Blueprint file.
${RULES}`,
      php: `Kamu adalah senior PHP scraping engineer.
Gunakan: cURL + DOMDocument.
Output adalah PHP endpoint file.
${RULES}`,
    };

    const siteCtx   = siteType ? `\nTipe website: ${siteType}` : "";
    const pageCtx   = req.query.pageType ? `\nTipe halaman: ${req.query.pageType}` : "";
    const searchCtx = req.query.searchQuery ? `\nSearch query: "${req.query.searchQuery}"` : "";

    // ── Fetch HTML & build real DOM context ──────────────────
    log(" Mengambil HTML nyata untuk konteks AI...");
    let fetchedHtml = "";
    try {
      const fr = await fetchWithBypass(url, () => {});
      if (fr.html) { fetchedHtml = fr.html; log(` HTML layer ${fr.layer} berhasil`); }
    } catch {}

    let domContext  = "";
    let bestSel     = "";
    let foundFields = [];
    let htmlSample  = "";

    // Parse dari selectors param (checkbox yang dipilih user — paling akurat)
    if (selectors) {
      try {
        const parsed = JSON.parse(selectors);
        if (Array.isArray(parsed) && parsed.length) {
          const best   = parsed.find(p => p.source === "microdata") || parsed[0];
          bestSel      = best.selector || "";
          foundFields  = best.fields   || [];
          const fStr   = foundFields.slice(0, 12)
            .map(f => `  ${f.name} (${f.source}): "${(f.value||"").substring(0,80)}"`)
            .join("\n");
          const allSels = parsed.slice(0, 6)
            .map(g => `  [${g.label}] sel="${g.selector}" fields=[${(g.rawFields||[]).join(",")}]`)
            .join("\n");
          domContext = `\n=== HASIL SCAN HTML NYATA ===\nCard selector: ${bestSel}\nItemType: ${best.itemType||"(DOM group)"}\nJumlah: ${best.count||"?"}\n\nField per card:\n${fStr||"  (title, link, image)"}\n\nSemua elemen dipilih:\n${allSels}`;
        }
      } catch {}
    }

    // Sample HTML card nyata
    if (fetchedHtml) {
      try {
        const $h = cheerio.load(fetchedHtml);
        const cardEl = $h("[itemscope]").not("[itemscope] [itemscope]").first().length
          ? $h("[itemscope]").not("[itemscope] [itemscope]").first()
          : $h("article").first().length ? $h("article").first() : $h("li[class]").first();
        if (cardEl.length) {
          const clone = cardEl.clone();
          clone.find("script,style,noscript").remove();
          htmlSample = clone.html()?.replace(/\s{2,}/g," ").trim().substring(0, 1500) || "";
          if (!bestSel) bestSel = makeSelector(cardEl[0], $h);
          domContext += `\n\n=== SAMPLE HTML CARD NYATA (1 item dari ${bestSel}) ===\n${htmlSample.substring(0,1200)}`;
        }
      } catch {}
    }

    const hostname  = (() => { try { return new URL(url).hostname.replace("www.",""); } catch { return "site"; } })();
    const routeName = hostname.replace(/\./g,"").replace(/[^a-z0-9]/gi,"").toLowerCase();
    const fieldList = foundFields.slice(0,8).map(f=>f.name).join(", ") || "title, link, image, rating";

    // Extract pagination info from selected elements (dari Visual Picker)
    let paginationInfo = { found: false, type: null, selector: null, nextUrl: null, totalPages: null };
    let paginationContext = "";
    if (selectors) {
      try {
        const parsed = JSON.parse(selectors);
        const withPag = parsed.find(p => p.pagination && p.pagination.found);
        if (withPag) {
          paginationInfo = withPag.pagination;
          paginationContext = `
=== PAGINATION TERDETEKSI ===
Tipe: ${paginationInfo.type}
Selector: ${paginationInfo.selector || "(auto-detect)"}
Next URL contoh: ${paginationInfo.nextUrl || "(ikuti pattern URL)"}
${paginationInfo.totalPages ? `Total halaman: ${paginationInfo.totalPages}` : ""}`;
        }
      } catch {}
    }

    const hasSearch = (target||"").toLowerCase().includes("cari") ||
                      (target||"").toLowerCase().includes("search") ||
                      (selectors||"").includes("search_form");

    // Determine pagination strategy based on detected type
    const pagStrategy = paginationInfo.found ? (
      paginationInfo.type === "rel_next"       ? `ikuti a[rel="next"].href loop sampai tidak ada lagi` :
      paginationInfo.type === "url_param"      ? `increment page parameter di URL (page=1,2,3,...) loop sampai halaman kosong` :
      paginationInfo.type === "button_next"    ? `ambil URL dari tombol next ("${paginationInfo.selector}"), follow sampai tidak ada` :
      paginationInfo.type === "infinite_scroll"? `gunakan parameter page/offset di request, loop sampai response kosong` :
      `ikuti a[rel="next"] atau increment page parameter`
    ) : `coba a[rel="next"] dulu, jika tidak ada increment ?page=N atau /page/N`;

    const prompt = `Website: ${url}${siteCtx}${pageCtx}${searchCtx}
Target: ${target}
${bCF ? "Website pakai proteksi — gunakan headers browser lengkap + retry 3x" : ""}
${domContext}
${paginationContext}

TUGAS UTAMA: Buat Express.js router sebagai API scraper UNLIMITED — scrape SEMUA halaman sekaligus.

KONSEP: Scraper ini harus "beranak" — 1 request API mengembalikan SEMUA hasil dari semua halaman.
Jangan berhenti di halaman 1. Loop terus sampai tidak ada lagi data.

MODES:
${hasSearch ? `- mode=list               → semua item halaman 1 s/d selesai (unlimited)
- mode=search&query=xxx   → cari di semua halaman sampai habis (unlimited)
- mode=detail&url=xxx     → detail 1 item spesifik` :
`- mode=list               → SEMUA item dari semua halaman sekaligus (unlimited)
- mode=detail&url=xxx     → detail lengkap 1 item`}

STRUKTUR FILE (WAJIB PERSIS SEPERTI INI):

const express = require('express');
const axios   = require('axios');
const cheerio = require('cheerio');
const router  = express.Router();

router.tags = ["${siteType||"scraper"}"];

/**
 * Scraper API — ${url}
 * GET /api/${routeName}?mode=list
 * GET /api/${routeName}?mode=list&limit=50       (opsional, default unlimited)
 * GET /api/${routeName}?mode=search&query=judul
 * GET /api/${routeName}?mode=detail&url=https://...
 */

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.5',
  'Accept-Encoding': 'gzip, deflate, br',
  'DNT': '1',
  'Connection': 'keep-alive',
  'Upgrade-Insecure-Requests': '1',
};

// Fetch HTML dengan retry otomatis
const fetchHtml = async (pageUrl) => {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const { data } = await axios.get(pageUrl, { headers: HEADERS, timeout: 20000 });
      return data;
    } catch (err) {
      if (attempt === 2) throw err;
      await new Promise(r => setTimeout(r, 1200 * (attempt + 1)));
    }
  }
};

// Parse items dari 1 halaman menggunakan selector: "${bestSel||"article[itemscope]"}"
// Return { items: [...], nextPageUrl: string|null }
const parsePage = (html, basePageUrl) => {
  const $ = cheerio.load(html);
  const items = [];

  $("${bestSel||"article[itemscope]"}").each((_, el) => {
    // Ekstrak semua field: ${fieldList}
    // Handle lazy-load img: data-src, data-lazy, data-original, data-thumbnail_url, src
    items.push({ /* field per item */ });
  });

  // Deteksi next page URL: ${pagStrategy}
  const nextPageUrl = /* logika next page */ null;

  return { items, nextPageUrl };
};

// Fetch SEMUA halaman sampai habis — ini yang bikin "beranak"/unlimited
const fetchAllPages = async (startUrl, limit = 0) => {
  const allItems = [];
  let   currentUrl = startUrl;
  let   pageNum    = 1;

  while (currentUrl) {
    console.log('Scraping page', pageNum, '-', currentUrl);
    const html = await fetchHtml(currentUrl);
    const { items, nextPageUrl } = parsePage(html, currentUrl);

    allItems.push(...items);

    // Stop jika: tidak ada halaman berikutnya, atau limit tercapai
    if (!nextPageUrl || nextPageUrl === currentUrl) break;
    if (limit > 0 && allItems.length >= limit) break;
    if (pageNum >= 50) break; // safety limit

    currentUrl = nextPageUrl;
    pageNum++;
    await new Promise(r => setTimeout(r, 800)); // delay sopan
  }

  return allItems;
};

// Parse detail 1 item dari halaman detail
const parseDetail = (html) => {
  const $ = cheerio.load(html);
  // Ekstrak semua info detail: title, description, image, rating, year, genre, cast, dll
  return { /* detail fields */ };
};

router.get('/', async (req, res) => {
  const { mode, query, url: itemUrl, limit } = req.query;
  const maxItems = limit ? parseInt(limit, 10) : 0;

  if (!mode) {
    return res.status(400).json({
      status: 'error',
      message: 'Parameter mode diperlukan',
      usage: 'mode=list | mode=search&query=xxx | mode=detail&url=xxx',
    });
  }

  try {
    if (mode === 'list') {
      const items = await fetchAllPages('${url}', maxItems);
      return res.json({ status: 'success', total: items.length, page_scraped: 'all', results: items });

    } else if (mode === 'search') {
      if (!query) return res.status(400).json({ status: 'error', message: 'Parameter query diperlukan' });
      const searchUrl = /* URL search */ '';
      const items     = await fetchAllPages(searchUrl, maxItems);
      return res.json({ status: 'success', query, total: items.length, results: items });

    } else if (mode === 'detail') {
      if (!itemUrl) return res.status(400).json({ status: 'error', message: 'Parameter url diperlukan' });
      const html   = await fetchHtml(itemUrl);
      const detail = parseDetail(html);
      return res.json({ status: 'success', results: detail });

    } else {
      return res.status(400).json({ status: 'error', message: 'Mode tidak valid: gunakan list, search, atau detail' });
    }
  } catch (err) {
    console.error('[${routeName}]', err.message);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

module.exports = router;

ATURAN KODE — WAJIB DIIKUTI:
1. Selector NYATA: "${bestSel||"article[itemscope]"}" untuk loop item
2. Field NYATA per item: ${fieldList}
   - Lazy-load img: COBA BERURUTAN → data-src, data-lazy, data-lazy-src, data-original, data-thumbnail_url, src
   - itemprop: gunakan [itemprop="name"], [itemprop="url"], [itemprop="image"] dst jika ada
3. Pagination: ${pagStrategy}
   - parsePage() HARUS return nextPageUrl yang valid atau null
   - fetchAllPages() loop sampai nextPageUrl null atau pageNum >= 50
4. Search URL: buat URL search dari pola yang terdeteksi di domContext
5. TULIS SEMUA KODE LENGKAP — TIDAK BOLEH ada "..." atau placeholder apapun
6. Semua fungsi HARUS punya implementasi nyata yang bisa dijalankan langsung`;



    const code = await (async () => {
      const raw = await callAI({ provider, apiKey, model, system: sysMap[lang], prompt, maxTokens: null });
      return raw.replace(/^```[\w]*\n?/gm, "").replace(/^```\n?/gm, "").trim();
    })();

    log(` AI selesai generate kode!`);
    log(`    Panjang kode: ${code.split("\n").length} baris`);
    log("    Menyimpan ke registry...");

    const id        = uuidv4();
    const trySchema = buildTrySchema(url, target, code);
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
    const trySchema = buildTrySchema(url, target, code);
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
// Smart try: jika scraper punya registered Express route → forward ke sana
// Jika tidak → inline fetch+parse
app.post("/api/scraper/:id/try", async (req, res) => {
  const entry = registry.getById(req.params.id);
  if (!entry) return res.status(404).json({ error: "Scraper tidak ditemukan" });

  // ── Cek apakah scraper punya registered API route ─────────
  // Jika ada, forward req.body sebagai query params ke route tersebut
  const apiRoutes = entry.apiRoutes || [];
  if (apiRoutes.length > 0) {
    const route    = apiRoutes[0]; // pakai route pertama
    const routeUrl = `http://localhost:${PORT}${route.path}`;
    try {
      // Forward semua req.body params sebagai query string
      const qs = new URLSearchParams(
        Object.fromEntries(Object.entries(req.body).filter(([,v]) => v !== undefined && v !== ""))
      ).toString();
      const callUrl = qs ? `${routeUrl}?${qs}` : routeUrl;
      console.log(`[try-router] Forwarding ke: ${callUrl}`);
      const resp = await axios.get(callUrl, { timeout: 60000 });
      return res.json({ success: true, scraped_data: resp.data, route: route.path, _source: "registered-route" });
    } catch (e) {
      console.log(`[try-router] Route call gagal: ${e.message}, fallback ke inline`);
    }
  }

  // ── Inline fallback: ambil semua params dari body ─────────
  const mode     = req.body.mode || "list";
  const query    = req.body.query || req.body.q || req.body.search || req.body.keyword || "";
  const itemUrl  = req.body.url || req.body.target_url || req.body.video_url ||
                   req.body.post_url || req.body.product_url || req.body.tweet_url || entry.url;
  const limit    = parseInt(req.body.limit || "20", 10);

  // Tentukan URL target berdasarkan mode
  let targetUrl = entry.url;
  if (mode === "detail" && itemUrl !== entry.url) {
    targetUrl = itemUrl;
  } else if ((mode === "search" || mode === "list") && query) {
    // Coba deteksi pola search URL dari kode yang di-generate
    const searchPatterns = [
      `${entry.url}?s=${encodeURIComponent(query)}`,
      `${entry.url}?q=${encodeURIComponent(query)}`,
      `${entry.url}?search=${encodeURIComponent(query)}`,
      `${entry.url}?keyword=${encodeURIComponent(query)}`,
    ];
    // Ambil pola dari kode jika ada
    const codeSearch = entry.code?.match(/\$\{?(?:BASE_URL|baseUrl)\}?\s*\+?\s*[`'"](.*?(?:s=|q=|search=|keyword=))[`'"]/);
    if (codeSearch) {
      targetUrl = `${entry.url}${codeSearch[1]}${encodeURIComponent(query)}`;
    } else {
      targetUrl = searchPatterns[0];
    }
  }

  // ── Browser-like headers ──────────────────────────────────
  const HEADERS = {
    "User-Agent":      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
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
    const nextData = html.match(/<script[^>]+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
    if (nextData) { try { return { _source: "NEXT_DATA", data: JSON.parse(nextData[1]) }; } catch {} }
    const jsonLds = [...html.matchAll(/<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)];
    for (const m of jsonLds) {
      try {
        const obj = JSON.parse(m[1].trim());
        if (obj["@type"] || obj.name || obj.price) return { _source: "JSON-LD", data: obj };
      } catch {}
    }
    const stateMatches = html.match(/window\.__(?:STATE|INITIAL_STATE|DATA|pageData|props)__\s*=\s*(\{[\s\S]*?\});/);
    if (stateMatches) { try { return { _source: "window.__STATE__", data: JSON.parse(stateMatches[1]) }; } catch {} }
    return null;
  };

  // ── Smart inline parser ───────────────────────────────────
  const inlineParser = async (html, url) => {
    const $  = cheerio.load(html);
    const h  = (() => { try { return new URL(url).hostname.toLowerCase().replace("www.",""); } catch { return ""; } })();
    const result = { url, site: h, mode, parsed_by: "smartscrape-inline-v4" };

    // Coba gunakan selector dari entry.trySchema atau kode yang di-generate
    const mainSel = (() => {
      // Cari selector dari kode generate
      const sMatch = entry.code?.match(/\$\(\s*["']([^"']+)["']\s*\)\.each/);
      return sMatch?.[1] || null;
    })();

    if (mainSel) {
      const items = [];
      try {
        $(mainSel).slice(0, limit).each((_, el) => {
          const item = {};
          // itemprop fields
          $(el).find("[itemprop]").each((_, c) => {
            const p = $(c).attr("itemprop") || "";
            const v = $(c).text().trim() || $(c).attr("src") || $(c).attr("href") || $(c).attr("content") || "";
            if (p && v) item[p] = v.substring(0, 200);
          });
          // fallback fields
          if (!item.name) {
            const h1 = $(el).find("h1,h2,h3,h4").first().text().trim();
            if (h1) item.title = h1;
          }
          const a = $(el).find("a[href]").first();
          if (a.length) item.link = a.attr("href") || "";
          const img = $(el).find("img").first();
          if (img.length) {
            item.image = img.attr("data-src") || img.attr("data-lazy") || img.attr("data-original") || img.attr("src") || "";
          }
          // rating, year, quality patterns
          $(el).find("span,strong,small,div").each((_, sp) => {
            const t = $(sp).text().trim();
            if (!item.rating  && /^\d[.,]\d$/.test(t)) item.rating  = t;
            if (!item.year    && /^(19|20)\d{2}$/.test(t)) item.year = t;
            if (!item.quality && /^(HD|FHD|4K|720p|1080p|BLURAY|WEB-DL)$/i.test(t)) item.quality = t;
          });
          if (Object.keys(item).length > 0) items.push(item);
        });
      } catch {}
      if (items.length > 0) {
        result.total         = items.length;
        result.results       = items;
        result.selector_used = mainSel;
        result._note         = `${items.length} item ditemukan dengan selector "${mainSel}"`;
        return result;
      }
    }

    // Generic fallback
    $("script, style, nav, footer, header, noscript, svg, iframe").remove();
    result.judul_halaman = $("title").text().trim();
    result.h1            = $("h1").map((_, el) => $(el).text().trim()).get().filter(Boolean).slice(0, 3);
    result.h2            = $("h2").map((_, el) => $(el).text().trim()).get().filter(Boolean).slice(0, 5);
    result.meta_description = $("meta[name='description']").attr("content") || "N/A";
    result.og_title      = $("meta[property='og:title']").attr("content") || "N/A";
    result.og_image      = $("meta[property='og:image']").attr("content") || "N/A";
    result.gambar        = $("img[src]").map((_, el) => $(el).attr("src")).get().filter(s => s && !s.includes("data:") && s.length > 10).slice(0, 5);
    result.links_count   = $("a[href]").length;
    const embedded = extractEmbeddedJson(html);
    if (embedded) result._embedded_json_source = embedded._source;
    return result;
  };

  try {
    console.log(`[try-v4] mode=${mode} url=${targetUrl}`);
    const html    = await fetchPage(targetUrl);
    const scraped = await inlineParser(html, targetUrl);
    const fw      = await detectFirewall(targetUrl).catch(() => ({ bypass_recommended: false, details: [] }));

    return res.json({
      success:      true,
      scraped_data: scraped,
      url:          targetUrl,
      mode,
      query:        query || null,
      scraper_id:   entry.id,
      scraper_name: entry.name,
      lang:         entry.lang,
      target:       entry.target,
      firewall:     fw,
      scraped_at:   new Date().toISOString(),
      download_url: `/api/scraper/${entry.id}/download`,
      zip_url:      `/api/scraper/${entry.id}/zip`,
    });

  } catch (err) {
    const fw = await detectFirewall(targetUrl).catch(() => null);
    return res.status(500).json({
      success:    false,
      error:      err.message,
      url:        targetUrl,
      mode,
      firewall:   fw,
      scraper_id: entry.id,
      fix_hint:   "Site memblokir akses langsung. Download & jalankan scraper di lokal/VPS dengan puppeteer.",
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

// ══════════════════════════════════════════════════════════════
//  GET / — SmartScrapeAI REST API Portal (HTML)
//  Tampilan lengkap semua generated API endpoints
// ══════════════════════════════════════════════════════════════
app.get("/", (req, res) => {
  const all    = registry.getAll();
  const routes = all.flatMap(s =>
    (s.apiRoutes || []).map(r => ({
      method:      r.method,
      path:        r.path,
      name:        r.name,
      description: r.description || `Scraper for ${s.url}`,
      category:    r.category || "general",
      params:      r.params || [],
      scraper:     s.name,
      scraper_url: s.url,
      lang:        s.lang,
      created:     s.createdAt,
    }))
  );

  const categories = [...new Set(routes.map(r => r.category))].sort();
  const stats = {
    total:     routes.length,
    scrapers:  all.length,
    categories: categories.length,
    uptime:    Math.floor(process.uptime()),
  };

  const routesJson = JSON.stringify(routes);
  const categoriesJson = JSON.stringify(categories);
  const statsJson = JSON.stringify(stats);

  const html = `<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>SmartScrapeAI — REST API</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500;700&display=swap" rel="stylesheet">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#08090d;--bg2:#0e1018;--bg3:#141720;
  --border:#1e2235;--border2:#2a2f45;
  --neon:#2effa8;--neon2:#00c2ff;--neon3:#a78bfa;
  --text:#e8eaf0;--text2:#8b93b0;--muted:#4a5068;
  --danger:#ff4560;--warn:#ffb84d;
  --mono:"JetBrains Mono",monospace;
  --head:"Space Grotesk",sans-serif;
}
html{scroll-behavior:smooth}
body{background:var(--bg);color:var(--text);font-family:var(--head);min-height:100vh;overflow-x:hidden}

/* Ambient glow */
body::before{
  content:"";position:fixed;top:-40%;left:-20%;width:60%;height:60%;
  background:radial-gradient(ellipse,rgba(46,255,168,.04) 0%,transparent 70%);
  pointer-events:none;z-index:0;
}
body::after{
  content:"";position:fixed;top:20%;right:-20%;width:50%;height:50%;
  background:radial-gradient(ellipse,rgba(0,194,255,.03) 0%,transparent 70%);
  pointer-events:none;z-index:0;
}

/* ── TOPBAR ── */
.topbar{
  position:sticky;top:0;z-index:100;
  background:rgba(8,9,13,.92);backdrop-filter:blur(20px);
  border-bottom:1px solid var(--border);
  display:flex;align-items:center;gap:16px;
  padding:0 24px;height:56px;
}
.logo{
  display:flex;align-items:center;gap:10px;
  font-family:var(--mono);font-size:15px;font-weight:700;
  color:var(--neon);text-decoration:none;letter-spacing:-.5px;
}
.logo span{color:var(--text2);font-weight:400}
.topbar-badge{
  font-family:var(--mono);font-size:9px;padding:2px 8px;
  border-radius:20px;border:1px solid rgba(46,255,168,.3);
  color:var(--neon);background:rgba(46,255,168,.07);
  letter-spacing:.5px;text-transform:uppercase;
}
.topbar-right{display:flex;align-items:center;gap:10px;margin-left:auto}
.topbar-link{
  font-size:12px;color:var(--text2);text-decoration:none;
  padding:5px 12px;border-radius:6px;border:1px solid var(--border2);
  transition:all .15s;
}
.topbar-link:hover{color:var(--neon);border-color:rgba(46,255,168,.3)}
.search-box{
  display:flex;align-items:center;gap:8px;
  background:var(--bg2);border:1px solid var(--border2);
  border-radius:8px;padding:6px 12px;
  transition:border-color .15s;
}
.search-box:focus-within{border-color:rgba(46,255,168,.4)}
.search-box input{
  background:transparent;border:none;outline:none;
  color:var(--text);font-family:var(--mono);font-size:12px;width:200px;
}
.search-box input::placeholder{color:var(--muted)}

/* ── HERO ── */
.hero{
  position:relative;padding:56px 24px 40px;
  text-align:center;max-width:700px;margin:0 auto;
}
.hero-title{
  font-size:clamp(28px,5vw,44px);font-weight:700;line-height:1.15;
  letter-spacing:-1.5px;margin-bottom:14px;
}
.hero-title .g{
  background:linear-gradient(135deg,var(--neon) 0%,var(--neon2) 50%,var(--neon3) 100%);
  -webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;
}
.hero-sub{font-size:15px;color:var(--text2);line-height:1.7;margin-bottom:24px}

/* ── STATS BAR ── */
.stats-bar{
  display:flex;align-items:stretch;justify-content:center;gap:0;
  max-width:520px;margin:0 auto 0;
  border:1px solid var(--border2);border-radius:12px;
  overflow:hidden;background:var(--bg2);
}
.stat-item{
  flex:1;padding:14px 18px;text-align:center;
  border-right:1px solid var(--border);
  position:relative;
}
.stat-item:last-child{border-right:none}
.stat-num{
  font-family:var(--mono);font-size:22px;font-weight:700;
  color:var(--neon);display:block;line-height:1;margin-bottom:4px;
}
.stat-label{font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:1px}

/* ── LAYOUT ── */
.layout{display:flex;gap:0;max-width:1200px;margin:0 auto;padding:32px 24px}
.sidebar{
  width:200px;flex-shrink:0;position:sticky;top:72px;
  align-self:flex-start;height:calc(100vh - 90px);overflow-y:auto;
  padding-right:16px;
}
.sidebar::-webkit-scrollbar{width:3px}
.sidebar::-webkit-scrollbar-thumb{background:var(--border2);border-radius:4px}
.sidebar-title{
  font-family:var(--mono);font-size:9px;color:var(--muted);
  text-transform:uppercase;letter-spacing:2px;
  padding:0 8px 10px;border-bottom:1px solid var(--border);margin-bottom:10px;
}
.cat-btn{
  display:flex;align-items:center;justify-content:space-between;
  width:100%;padding:7px 10px;border-radius:7px;
  background:transparent;border:none;cursor:pointer;
  font-family:var(--head);font-size:12px;color:var(--text2);
  transition:all .15s;text-align:left;
}
.cat-btn:hover{background:rgba(255,255,255,.04);color:var(--text)}
.cat-btn.active{background:rgba(46,255,168,.07);color:var(--neon)}
.cat-btn .cat-count{
  font-family:var(--mono);font-size:9px;color:var(--muted);
  background:var(--bg3);padding:1px 6px;border-radius:10px;
}
.cat-btn.active .cat-count{color:var(--neon);background:rgba(46,255,168,.12)}
.main{flex:1;min-width:0}

/* ── SECTION HEADING ── */
.section-head{
  display:flex;align-items:center;gap:10px;
  margin-bottom:20px;padding-bottom:12px;
  border-bottom:1px solid var(--border);
}
.section-head h2{font-size:15px;font-weight:600;color:var(--text)}
.section-count{
  font-family:var(--mono);font-size:10px;color:var(--muted);
  background:var(--bg3);padding:2px 8px;border-radius:10px;
}

/* ── ENDPOINT CARDS ── */
.cards{display:flex;flex-direction:column;gap:10px;margin-bottom:40px}
.card{
  background:var(--bg2);border:1px solid var(--border);
  border-radius:12px;overflow:hidden;transition:border-color .2s;
}
.card:hover{border-color:var(--border2)}
.card-header{
  display:flex;align-items:center;gap:12px;
  padding:14px 18px;cursor:pointer;user-select:none;
}
.card-header:hover .method-badge{filter:brightness(1.1)}
.method-badge{
  font-family:var(--mono);font-size:10px;font-weight:700;
  padding:3px 10px;border-radius:5px;flex-shrink:0;
  letter-spacing:.5px;
}
.method-GET{background:rgba(46,255,168,.12);color:var(--neon);border:1px solid rgba(46,255,168,.25)}
.method-POST{background:rgba(0,194,255,.12);color:var(--neon2);border:1px solid rgba(0,194,255,.25)}
.method-DELETE{background:rgba(255,69,96,.12);color:var(--danger);border:1px solid rgba(255,69,96,.25)}
.card-path{
  font-family:var(--mono);font-size:13px;color:var(--text);
  flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
}
.card-path .param{color:var(--neon3)}
.card-desc{font-size:11px;color:var(--text2);flex-shrink:0;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.card-arrow{
  color:var(--muted);font-size:14px;flex-shrink:0;
  transition:transform .2s;
}
.card.open .card-arrow{transform:rotate(180deg)}
.card-body{
  border-top:1px solid var(--border);
  padding:18px;display:none;
  flex-direction:column;gap:16px;
}
.card.open .card-body{display:flex}

/* Card body sections */
.cb-section-title{
  font-family:var(--mono);font-size:9px;color:var(--muted);
  text-transform:uppercase;letter-spacing:2px;margin-bottom:8px;
}
.params-table{width:100%;border-collapse:collapse}
.params-table th{
  font-family:var(--mono);font-size:9px;color:var(--muted);
  text-transform:uppercase;letter-spacing:1px;
  padding:0 10px 6px 0;text-align:left;
}
.params-table td{
  font-size:12px;color:var(--text2);
  padding:6px 10px 6px 0;
  border-top:1px solid var(--border);vertical-align:top;
}
.params-table td:first-child{font-family:var(--mono);font-size:11px;color:var(--neon3)}
.req-badge{
  font-family:var(--mono);font-size:8px;padding:1px 5px;
  border-radius:3px;background:rgba(255,184,77,.1);
  border:1px solid rgba(255,184,77,.25);color:var(--warn);
}
.opt-badge{
  font-family:var(--mono);font-size:8px;padding:1px 5px;
  border-radius:3px;background:rgba(255,255,255,.04);
  border:1px solid var(--border2);color:var(--muted);
}

/* Try panel */
.try-form{
  background:var(--bg3);border:1px solid var(--border2);
  border-radius:10px;padding:14px;display:flex;flex-direction:column;gap:10px;
}
.try-row{display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap}
.try-field{display:flex;flex-direction:column;gap:4px;flex:1;min-width:140px}
.try-field label{font-family:var(--mono);font-size:9px;color:var(--muted);text-transform:uppercase;letter-spacing:1px}
.try-field input{
  background:var(--bg2);border:1px solid var(--border2);
  border-radius:7px;padding:7px 10px;
  color:var(--text);font-family:var(--mono);font-size:12px;
  outline:none;transition:border-color .15s;
}
.try-field input:focus{border-color:rgba(46,255,168,.4)}
.try-btn{
  background:var(--neon);color:#000;border:none;
  padding:8px 18px;border-radius:7px;cursor:pointer;
  font-family:var(--mono);font-size:12px;font-weight:700;
  transition:all .15s;white-space:nowrap;flex-shrink:0;
}
.try-btn:hover{background:#1de896;transform:translateY(-1px)}
.try-btn:active{transform:translateY(0)}
.try-btn:disabled{opacity:.5;cursor:not-allowed;transform:none}
.try-result{
  background:rgba(0,0,0,.4);border:1px solid var(--border2);
  border-radius:8px;max-height:320px;overflow:auto;
  padding:14px;
}
.try-result pre{font-family:var(--mono);font-size:11px;line-height:1.6;color:var(--text2);white-space:pre-wrap;word-break:break-all}
.try-meta{display:flex;gap:12px;align-items:center;margin-bottom:8px;flex-wrap:wrap}
.status-ok{color:var(--neon);font-family:var(--mono);font-size:10px}
.status-err{color:var(--danger);font-family:var(--mono);font-size:10px}
.res-time{font-family:var(--mono);font-size:10px;color:var(--muted)}
.copy-btn{
  margin-left:auto;background:transparent;border:1px solid var(--border2);
  color:var(--muted);padding:3px 9px;border-radius:5px;cursor:pointer;
  font-family:var(--mono);font-size:9px;transition:all .15s;
}
.copy-btn:hover{color:var(--neon);border-color:rgba(46,255,168,.3)}

/* URL bar */
.url-bar{
  display:flex;align-items:center;gap:8px;
  background:rgba(0,0,0,.3);border:1px solid var(--border);
  border-radius:8px;padding:8px 12px;margin-bottom:4px;
}
.url-method{font-family:var(--mono);font-size:10px;font-weight:700;color:var(--neon)}
.url-text{font-family:var(--mono);font-size:11px;color:var(--text2);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

/* Empty state */
.empty{
  text-align:center;padding:80px 20px;
  display:flex;flex-direction:column;align-items:center;gap:16px;
}
.empty-icon{
  width:64px;height:64px;border-radius:16px;
  background:var(--bg2);border:1px solid var(--border2);
  display:flex;align-items:center;justify-content:center;
  font-size:28px;
}
.empty-title{font-size:18px;font-weight:600;color:var(--text)}
.empty-sub{font-size:13px;color:var(--text2);max-width:380px;line-height:1.7}
.empty-link{
  display:inline-flex;align-items:center;gap:6px;
  background:var(--neon);color:#000;padding:10px 22px;
  border-radius:8px;font-weight:700;font-size:13px;text-decoration:none;
  transition:all .15s;
}
.empty-link:hover{background:#1de896;transform:translateY(-1px)}

/* Footer */
.footer{
  text-align:center;padding:24px;
  font-family:var(--mono);font-size:11px;color:var(--muted);
  border-top:1px solid var(--border);margin-top:40px;
}
.footer a{color:var(--neon);text-decoration:none}
.footer a:hover{text-decoration:underline}

/* Scrollbar global */
::-webkit-scrollbar{width:4px;height:4px}
::-webkit-scrollbar-track{background:var(--bg)}
::-webkit-scrollbar-thumb{background:var(--border2);border-radius:4px}

/* Mobile */
@media(max-width:700px){
  .layout{flex-direction:column;padding:16px}
  .sidebar{width:100%;position:static;height:auto;padding:0;overflow-x:auto}
  .sidebar-cats{display:flex;flex-direction:row;gap:6px;overflow-x:auto;padding-bottom:10px}
  .cat-btn{white-space:nowrap}
  .hero{padding:32px 16px 24px}
  .card-desc{display:none}
  .try-row{flex-direction:column}
  .search-box input{width:130px}
}
.spinner{
  width:16px;height:16px;border:2px solid rgba(46,255,168,.2);
  border-top-color:var(--neon);border-radius:50%;
  animation:spin .7s linear infinite;display:inline-block;
}
@keyframes spin{to{transform:rotate(360deg)}}
</style>
</head>
<body>

<!-- TOPBAR -->
<nav class="topbar">
  <a class="logo" href="/">SmartScrape<span>AI</span></a>
  <span class="topbar-badge">REST API</span>
  <div class="search-box">
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="color:var(--muted);flex-shrink:0"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
    <input type="text" id="searchInput" placeholder="Cari endpoint..." oninput="filterEndpoints(this.value)">
  </div>
  <div class="topbar-right">
    <a class="topbar-link" href="/admin">Admin</a>
    <a class="topbar-link" href="/api/docs">API Docs</a>
    <a class="topbar-link" href="/health">Health</a>
  </div>
</nav>

<!-- HERO -->
<div class="hero">
  <h1 class="hero-title">Free <span class="g">REST API</span><br>Open &amp; Ready</h1>
  <p class="hero-sub">Semua endpoint di-generate otomatis oleh AI dari website target.<br>Akses langsung, tidak perlu key, gratis.</p>
  <div class="stats-bar">
    <div class="stat-item">
      <span class="stat-num" id="statEndpoints">${stats.total}</span>
      <span class="stat-label">Endpoints</span>
    </div>
    <div class="stat-item">
      <span class="stat-num" id="statScrapers">${stats.scrapers}</span>
      <span class="stat-label">Scrapers</span>
    </div>
    <div class="stat-item">
      <span class="stat-num">${stats.categories}</span>
      <span class="stat-label">Kategori</span>
    </div>
    <div class="stat-item">
      <span class="stat-num" id="uptime">${stats.uptime}s</span>
      <span class="stat-label">Uptime</span>
    </div>
  </div>
</div>

<!-- MAIN LAYOUT -->
<div class="layout">
  <!-- SIDEBAR -->
  <aside class="sidebar">
    <div class="sidebar-title">Kategori</div>
    <div class="sidebar-cats" id="catList">
      <button class="cat-btn active" data-cat="all" onclick="filterCat('all',this)">
        Semua <span class="cat-count" id="countAll">${routes.length}</span>
      </button>
    </div>
  </aside>

  <!-- MAIN CONTENT -->
  <main class="main" id="mainContent">
    <!-- Rendered by JS -->
  </main>
</div>

<!-- FOOTER -->
<footer class="footer">
  Powered by <a href="/admin">SmartScrapeAI</a> &mdash; Generated endpoints tersedia 24/7 &mdash;
  <span id="serverTime"></span>
</footer>

<script>
const ROUTES = ${routesJson};
const CATEGORIES = ${categoriesJson};
const BASE = window.location.origin;

let activeCategory = 'all';
let searchQuery    = '';

// ── Build sidebar categories ──
function buildSidebar() {
  const catList = document.getElementById('catList');
  const counts  = {};
  ROUTES.forEach(r => { counts[r.category] = (counts[r.category]||0)+1; });
  CATEGORIES.forEach(cat => {
    const btn = document.createElement('button');
    btn.className = 'cat-btn';
    btn.dataset.cat = cat;
    btn.onclick = () => filterCat(cat, btn);
    btn.innerHTML = cat + ' <span class="cat-count">' + (counts[cat]||0) + '</span>';
    catList.appendChild(btn);
  });
}

// ── Filter by category ──
function filterCat(cat, btn) {
  activeCategory = cat;
  document.querySelectorAll('.cat-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  renderEndpoints();
}

// ── Filter by search ──
function filterEndpoints(q) {
  searchQuery = q.toLowerCase();
  renderEndpoints();
}

// ── Format path with param highlighting ──
function formatPath(path) {
  return path.replace(/:([a-zA-Z_]+)/g, '<span class="param">:$1</span>')
             .replace(/\?([^=]+)=/g, '?<span class="param">$1</span>=');
}

// ── Render all endpoints ──
function renderEndpoints() {
  const main = document.getElementById('mainContent');
  let filtered = ROUTES.filter(r => {
    const catOk = activeCategory === 'all' || r.category === activeCategory;
    const searchOk = !searchQuery ||
      r.path.toLowerCase().includes(searchQuery) ||
      r.description.toLowerCase().includes(searchQuery) ||
      r.category.toLowerCase().includes(searchQuery) ||
      r.scraper.toLowerCase().includes(searchQuery);
    return catOk && searchOk;
  });

  if (filtered.length === 0) {
    main.innerHTML = ROUTES.length === 0
      ? \`<div class="empty">
          <div class="empty-icon">🔌</div>
          <div class="empty-title">Belum ada API endpoint</div>
          <div class="empty-sub">Buat scraper di Admin Panel, lalu generate API route dari scraper tersebut.</div>
          <a class="empty-link" href="/admin">Buka Admin Panel</a>
        </div>\`
      : \`<div class="empty">
          <div class="empty-icon">🔍</div>
          <div class="empty-title">Tidak ditemukan</div>
          <div class="empty-sub">Tidak ada endpoint yang cocok dengan pencarian "<b>\${searchQuery}</b>"</div>
        </div>\`;
    return;
  }

  // Group by category
  const bycat = {};
  filtered.forEach(r => {
    if (!bycat[r.category]) bycat[r.category] = [];
    bycat[r.category].push(r);
  });

  let html = '';
  Object.entries(bycat).forEach(([cat, catRoutes]) => {
    html += \`<div class="section-head">
      <h2>\${cat.charAt(0).toUpperCase()+cat.slice(1)}</h2>
      <span class="section-count">\${catRoutes.length} endpoint</span>
    </div>
    <div class="cards">\`;
    catRoutes.forEach((r, idx) => {
      const cid  = 'card_' + cat + '_' + idx;
      html += buildCard(r, cid);
    });
    html += '</div>';
  });
  main.innerHTML = html;
}

// ── Build single endpoint card ──
function buildCard(r, cid) {
  const hasParams = r.params && r.params.length > 0;
  let paramsHtml = '';
  let tryInputs  = '';

  if (hasParams) {
    paramsHtml += \`<div>
      <div class="cb-section-title">Parameters</div>
      <table class="params-table">
        <thead><tr>
          <th>Nama</th><th>Tipe</th><th>Keterangan</th><th>Wajib</th>
        </tr></thead>
        <tbody>\`;
    r.params.forEach(p => {
      paramsHtml += \`<tr>
        <td>\${p.name}</td>
        <td><span style="color:var(--neon3);font-family:var(--mono);font-size:10px">\${p.type||'string'}</span></td>
        <td>\${p.description||'-'}</td>
        <td>\${p.required ? '<span class="req-badge">required</span>' : '<span class="opt-badge">optional</span>'}</td>
      </tr>\`;
    });
    paramsHtml += '</tbody></table></div>';

    // Build try inputs per param
    r.params.forEach(p => {
      tryInputs += \`<div class="try-field">
        <label>\${p.name}\${p.required?'*':''}</label>
        <input type="\${p.type==='url'?'url':'text'}" id="inp_\${cid}_\${p.name}"
          placeholder="\${p.description||p.name}" />
      </div>\`;
    });
  } else {
    // Auto-detect mode/query/url dari path
    const urlParams = [...r.path.matchAll(/[?&]([^=]+)=/g)].map(m => m[1]);
    urlParams.forEach(p => {
      tryInputs += \`<div class="try-field">
        <label>\${p}</label>
        <input type="text" id="inp_\${cid}_\${p}" placeholder="\${p}" />
      </div>\`;
    });
    if (tryInputs === '') {
      tryInputs = \`<div class="try-field" style="flex:1">
        <label>URL lengkap (opsional override)</label>
        <input type="text" id="inp_\${cid}_custom" placeholder="\${BASE}\${r.path}" />
      </div>\`;
    }
  }

  return \`<div class="card" id="\${cid}">
    <div class="card-header" onclick="toggleCard('\${cid}')">
      <span class="method-badge method-\${r.method}">\${r.method}</span>
      <span class="card-path">\${formatPath(r.path)}</span>
      <span class="card-desc">\${r.description.substring(0,50)}</span>
      <span class="card-arrow">&#8964;</span>
    </div>
    <div class="card-body">
      <div>
        <div class="cb-section-title">Deskripsi</div>
        <p style="font-size:13px;color:var(--text2);line-height:1.6">\${r.description}</p>
        <div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap">
          <span style="font-family:var(--mono);font-size:10px;color:var(--muted)">Scraper:</span>
          <a href="\${r.scraper_url}" target="_blank" style="font-family:var(--mono);font-size:10px;color:var(--neon2);text-decoration:none">\${r.scraper_url}</a>
        </div>
      </div>
      \${paramsHtml}
      <div>
        <div class="cb-section-title">Try It</div>
        <div class="try-form">
          <div class="url-bar">
            <span class="url-method">\${r.method}</span>
            <span class="url-text" id="urlPreview_\${cid}">\${BASE}\${r.path}</span>
          </div>
          <div class="try-row">\${tryInputs}
            <button class="try-btn" id="btn_\${cid}" onclick="tryEndpoint('\${cid}','\${r.method}','\${r.path}',\${JSON.stringify(r.params||[])})">
              Run
            </button>
          </div>
        </div>
        <div id="result_\${cid}" style="display:none">
          <div class="try-result">
            <div class="try-meta">
              <span id="status_\${cid}"></span>
              <span id="time_\${cid}" class="res-time"></span>
              <button class="copy-btn" onclick="copyResult('\${cid}')">Copy</button>
            </div>
            <pre id="pre_\${cid}"></pre>
          </div>
        </div>
      </div>
    </div>
  </div>\`;
}

// ── Toggle card open/close ──
function toggleCard(cid) {
  const card = document.getElementById(cid);
  card.classList.toggle('open');
}

// ── Try endpoint ──
async function tryEndpoint(cid, method, path, params) {
  const btn = document.getElementById('btn_' + cid);
  const resultDiv = document.getElementById('result_' + cid);
  const pre       = document.getElementById('pre_' + cid);
  const statusEl  = document.getElementById('status_' + cid);
  const timeEl    = document.getElementById('time_' + cid);

  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>';
  resultDiv.style.display = 'none';

  // Build query string from inputs
  const qs = new URLSearchParams();
  if (params && params.length > 0) {
    params.forEach(p => {
      const val = document.getElementById('inp_' + cid + '_' + p.name)?.value?.trim();
      if (val) qs.set(p.name, val);
    });
  } else {
    // Auto-detect inputs
    const customInput = document.getElementById('inp_' + cid + '_custom');
    if (customInput?.value?.trim()) {
      // Use custom URL as override
      const customUrl = customInput.value.trim();
      // Extract params from URL
      try {
        const u = new URL(customUrl.startsWith('http') ? customUrl : BASE + customUrl);
        u.searchParams.forEach((v, k) => qs.set(k, v));
      } catch {}
    } else {
      // Check for ?param= style inputs
      const paramMatches = [...path.matchAll(/[?&]([^=]+)=/g)].map(m => m[1]);
      paramMatches.forEach(p => {
        const val = document.getElementById('inp_' + cid + '_' + p)?.value?.trim();
        if (val) qs.set(p, val);
      });
    }
  }

  const callUrl = BASE + path + (qs.toString() ? (path.includes('?') ? '&' : '?') + qs.toString() : '');
  document.getElementById('urlPreview_' + cid).textContent = callUrl;

  const t0 = Date.now();
  try {
    const resp = await fetch(callUrl, { method });
    const ms   = Date.now() - t0;
    const data = await resp.json();
    const json = JSON.stringify(data, null, 2);

    // Syntax highlight
    pre.innerHTML = syntaxHighlight(json);
    statusEl.innerHTML = \`<span class="status-ok">HTTP \${resp.status} OK</span>\`;
    timeEl.textContent = ms + 'ms';
    resultDiv.style.display = 'block';
  } catch (e) {
    const ms = Date.now() - t0;
    pre.textContent = 'Error: ' + e.message;
    statusEl.innerHTML = '<span class="status-err">Error</span>';
    timeEl.textContent = ms + 'ms';
    resultDiv.style.display = 'block';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Run';
  }
}

// ── Copy result ──
async function copyResult(cid) {
  const text = document.getElementById('pre_' + cid)?.textContent || '';
  await navigator.clipboard.writeText(text).catch(() => {});
  const btn = event.target;
  btn.textContent = 'Copied!';
  btn.style.color = 'var(--neon)';
  setTimeout(() => { btn.textContent = 'Copy'; btn.style.color = ''; }, 1500);
}

// ── JSON syntax highlight ──
function syntaxHighlight(json) {
  return json
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(?:\\s*:)?|\\b(true|false|null)\\b|-?\\d+(?:\\.\\d*)?(?:[eE][+\\-]?\\d+)?)/g, function(m){
      let cls = 'color:var(--neon3)';
      if (/^"/.test(m)) {
        cls = /:$/.test(m) ? 'color:var(--neon2)' : 'color:var(--neon)';
      } else if (/true|false/.test(m)) {
        cls = 'color:var(--warn)';
      } else if (/null/.test(m)) {
        cls = 'color:var(--muted)';
      } else {
        cls = 'color:var(--neon3)';
      }
      return '<span style="' + cls + '">' + m + '</span>';
    });
}

// ── Uptime counter ──
let uptimeBase = ${stats.uptime};
setInterval(() => {
  uptimeBase++;
  const el = document.getElementById('uptime');
  if (el) el.textContent = uptimeBase < 3600
    ? Math.floor(uptimeBase/60) + 'm ' + (uptimeBase%60) + 's'
    : Math.floor(uptimeBase/3600) + 'h ' + Math.floor((uptimeBase%3600)/60) + 'm';
}, 1000);

// ── Server time ──
function updateTime() {
  const el = document.getElementById('serverTime');
  if (el) el.textContent = new Date().toLocaleString('id-ID', {dateStyle:'medium',timeStyle:'short'});
}
updateTime();
setInterval(updateTime, 30000);

// ── Init ──
buildSidebar();
renderEndpoints();
</script>
</body>
</html>`;

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.send(html);
});



// ══════════════════════════════════════════════════════════════
//  GET /api/proxy/stream — Real-time streaming proxy
//  Fetch URL target tanpa CORS block, stream bytes langsung ke client
//  Dipakai oleh Visual Picker dan scraper preview
//  Query: url=<target_url>
// ══════════════════════════════════════════════════════════════
app.get("/api/proxy/stream", async (req, res) => {
  const { url: targetUrl } = req.query;
  if (!targetUrl) return res.status(400).json({ error: "url diperlukan" });

  let parsed;
  try { parsed = new URL(targetUrl); } catch { return res.status(400).json({ error: "URL tidak valid" }); }

  const proxyHeaders = {
    "User-Agent":      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Accept":          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "id-ID,id;q=0.9,en-US;q=0.8",
    "Accept-Encoding": "gzip, deflate, br",
    "Referer":         "https://www.google.com/",
    "DNT":             "1",
    "Connection":      "keep-alive",
    "Upgrade-Insecure-Requests": "1",
    "Sec-Fetch-Dest":  "document",
    "Sec-Fetch-Mode":  "navigate",
    "Sec-Fetch-Site":  "cross-site",
  };

  try {
    const upstream = await axios.get(targetUrl, {
      headers:          proxyHeaders,
      responseType:     "stream",
      timeout:          30000,
      maxRedirects:     10,
      validateStatus:   () => true,
      decompress:       true,
    });

    // Forward status
    res.status(upstream.status);

    // Forward content-type (agar browser tahu tipe konten)
    const ct = upstream.headers["content-type"] || "text/html; charset=utf-8";
    res.setHeader("Content-Type", ct);

    // CORS headers agar bisa diakses dari frontend
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("X-Proxy-Source", parsed.hostname);
    res.setHeader("X-Proxy-Layer",  "direct");

    // Remove headers yang bisa bikin masalah
    ["x-frame-options", "content-security-policy", "x-content-type-options",
     "strict-transport-security", "x-xss-protection"].forEach(h => res.removeHeader(h));

    // Jika HTML — inject base tag + rewrite link agar resource load
    if (ct.includes("text/html")) {
      let chunks = [];
      upstream.data.on("data", c => chunks.push(c));
      upstream.data.on("end", () => {
        let html = Buffer.concat(chunks).toString("utf8");
        const base = `${parsed.protocol}//${parsed.hostname}`;

        // Inject base tag
        if (!html.includes("<base")) {
          html = html.replace(/<head([^>]*)>/i, `<head$1><base href="${targetUrl}">`);
        }

        // Tambahkan CSP override script agar iframe works
        const CSP_RESET = `<script>
(function(){
  // Override document.domain untuk allow cross-origin messaging
  try { document.domain = document.domain; } catch(e) {}
})();
</script>`;
        html = html.replace("</head>", CSP_RESET + "</head>");

        res.end(html);
      });
      upstream.data.on("error", err => {
        if (!res.headersSent) res.status(502).json({ error: err.message });
        else res.end();
      });
    } else {
      // Non-HTML (CSS, JS, img) — pipe langsung
      upstream.data.pipe(res);
      upstream.data.on("error", () => res.end());
    }
  } catch (e) {
    if (!res.headersSent) res.status(502).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════
//  Frontend: /admin route (serve React SPA)
// ══════════════════════════════════════════════════════════════
if (IS_PROD) {
  const clientDist = path.join(__dirname, "client", "dist");
  const idxPath    = path.join(clientDist, "index.html");

  // /admin dan semua sub-route → index.html
  app.get(["/admin", "/admin/*"], (req, res) => {
    if (fs.existsSync(idxPath)) res.sendFile(idxPath);
    else res.status(404).json({ error: "Frontend tidak ditemukan. Build dulu: npm run build" });
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
