// ═══════════════════════════════════════════════════════════════
//  SmartScrapeAI Server v2.0
//  Express backend — AI scraper generator, multi-provider AI,
//  Cloudflare bypass detection, API docs registry
// ═══════════════════════════════════════════════════════════════

require("dotenv").config();
const express    = require("express");
const cors       = require("cors");
const helmet     = require("helmet");
const morgan     = require("morgan");
const path       = require("path");
const { v4: uuidv4 } = require("uuid");
const axios      = require("axios");
const registry   = require("./api/registry");

const app  = express();
const PORT = process.env.PORT || 8080;

// ── Middleware ────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(morgan("dev"));
app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname, "public")));

// ── Token caps per provider (output tokens maksimum yang didukung) ──
const PROVIDER_MAX_TOKENS = {
  anthropic: 16000,  // Claude Sonnet/Opus: max 16k output
  openai:    16384,  // GPT-4o: max 16k output
  groq:       8000,  // Llama3-70b di Groq: 8192 context limit
  gemini:    16000,  // Gemini 1.5 Flash/Pro: bisa hingga 8192+ output
  deepseek:  16000,  // DeepSeek: max 16k output
  mistral:   16000,  // Mistral Large: max 16k output
  xai:        8192,  // Grok Beta: 8192
};

// ── Helper: Call AI Provider ──────────────────────────────────
// maxTokens: null  → pakai PROVIDER_MAX_TOKENS (untuk generate kode, UNLIMITED)
// maxTokens: angka → pakai nilai itu (untuk chat singkat/analisa)
async function callAI({ provider, apiKey, model, system, prompt, maxTokens = null }) {
  const headers = { "Content-Type": "application/json" };

  // Resolusi token: null = pakai cap maksimum provider
  const resolveTokens = (provId, requested) =>
    requested !== null ? requested : (PROVIDER_MAX_TOKENS[provId] || 8192);

  // ── Anthropic ──
  if (provider === "anthropic") {
    const tokens = resolveTokens("anthropic", maxTokens);
    const res = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model: model || "claude-sonnet-4-20250514",
        max_tokens: tokens,
        system,
        messages: [{ role: "user", content: prompt }],
      },
      {
        headers: { ...headers, "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
        timeout: 120000, // 2 menit timeout
      }
    );
    return res.data.content?.[0]?.text || "";
  }

  // ── OpenAI / compatible ──
  if (provider === "openai" || provider === "deepseek" || provider === "together") {
    const baseURLs = {
      openai:   "https://api.openai.com/v1",
      deepseek: "https://api.deepseek.com/v1",
      together: "https://api.together.xyz/v1",
    };
    const defaultModels = {
      openai:   "gpt-4o",
      deepseek: "deepseek-chat",
      together: "meta-llama/Llama-3-70b-chat-hf",
    };
    const tokens = resolveTokens(provider, maxTokens);
    const res = await axios.post(
      `${baseURLs[provider]}/chat/completions`,
      {
        model: model || defaultModels[provider],
        max_tokens: tokens,
        messages: [
          { role: "system", content: system },
          { role: "user",   content: prompt  },
        ],
      },
      { headers: { ...headers, Authorization: `Bearer ${apiKey}` }, timeout: 120000 }
    );
    return res.data.choices?.[0]?.message?.content || "";
  }

  // ── Groq ──
  if (provider === "groq") {
    // Groq punya batasan ketat — pakai 8000 maksimum
    const tokens = maxTokens !== null ? Math.min(maxTokens, 8000) : 8000;
    const res = await axios.post(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        model: model || "llama3-70b-8192",
        max_tokens: tokens,
        messages: [
          { role: "system", content: system },
          { role: "user",   content: prompt  },
        ],
      },
      { headers: { ...headers, Authorization: `Bearer ${apiKey}` }, timeout: 120000 }
    );
    return res.data.choices?.[0]?.message?.content || "";
  }

  // ── Google Gemini ──
  if (provider === "gemini") {
    const mdl    = model || "gemini-1.5-flash";
    const tokens = resolveTokens("gemini", maxTokens);
    const res = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/${mdl}:generateContent?key=${apiKey}`,
      {
        contents: [{ parts: [{ text: `${system}\n\n${prompt}` }] }],
        generationConfig: { maxOutputTokens: tokens, temperature: 0.2 },
      },
      { headers, timeout: 120000 }
    );
    return res.data.candidates?.[0]?.content?.parts?.[0]?.text || "";
  }

  // ── Mistral ──
  if (provider === "mistral") {
    const tokens = resolveTokens("mistral", maxTokens);
    const res = await axios.post(
      "https://api.mistral.ai/v1/chat/completions",
      {
        model: model || "mistral-large-latest",
        max_tokens: tokens,
        messages: [
          { role: "system", content: system },
          { role: "user",   content: prompt  },
        ],
      },
      { headers: { ...headers, Authorization: `Bearer ${apiKey}` }, timeout: 120000 }
    );
    return res.data.choices?.[0]?.message?.content || "";
  }

  // ── xAI Grok ──
  if (provider === "xai") {
    const tokens = resolveTokens("xai", maxTokens);
    const res = await axios.post(
      "https://api.x.ai/v1/chat/completions",
      {
        model: model || "grok-beta",
        max_tokens: tokens,
        messages: [
          { role: "system", content: system },
          { role: "user",   content: prompt  },
        ],
      },
      { headers: { ...headers, Authorization: `Bearer ${apiKey}` }, timeout: 120000 }
    );
    return res.data.choices?.[0]?.message?.content || "";
  }

  throw new Error(`Provider tidak dikenal: ${provider}`);
}

// ── Helper: Detect Firewall ───────────────────────────────────
async function detectFirewall(url) {
  const result = {
    cloudflare: false,
    waf: false,
    bot_protection: false,
    details: [],
    bypass_recommended: false,
  };

  const cfDomains = [
    "tiktok.com","instagram.com","twitter.com","x.com","facebook.com",
    "shopee","tokopedia","lazada","bukalapak","discord.com","reddit.com",
    "cloudflare.com","medium.com","notion.so","akamai","fastly",
  ];

  try {
    const parsed = new URL(url);
    const host   = parsed.hostname.toLowerCase();

    // Cek known CF domains
    for (const d of cfDomains) {
      if (host.includes(d)) {
        result.cloudflare = true;
        result.details.push(`Domain ${host} dikenal menggunakan Cloudflare/WAF`);
        break;
      }
    }

    // Coba HEAD request untuk deteksi header
    try {
      const resp = await axios.head(url, {
        timeout: 6000,
        validateStatus: () => true,
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        },
      });

      const headers = resp.headers;
      const status  = resp.status;

      if (headers["cf-ray"] || headers["cf-cache-status"]) {
        result.cloudflare = true;
        result.details.push("Header Cloudflare terdeteksi: cf-ray / cf-cache-status");
      }
      if (headers["x-sucuri-id"] || headers["x-sucuri-cache"]) {
        result.waf = true;
        result.details.push("WAF Sucuri terdeteksi");
      }
      if (headers["x-distil-cs"]) {
        result.bot_protection = true;
        result.details.push("Bot protection Distil/Imperva terdeteksi");
      }
      if (headers["server"]?.toLowerCase().includes("cloudflare")) {
        result.cloudflare = true;
        result.details.push("Server header: Cloudflare");
      }
      if (status === 403 || status === 503 || status === 429) {
        result.bot_protection = true;
        result.details.push(`HTTP ${status} — kemungkinan diblock bot protection`);
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

function buildSystemPrompt(lang, bypassCF) {
  const bypass = bypassCF
    ? "PENTING: Website ini dilindungi Cloudflare/WAF! Gunakan teknik bypass lengkap."
    : "Website tidak memerlukan bypass khusus.";

  const SHARED_RULES = `
ATURAN TIDAK BOLEH DILANGGAR:
1. Output HANYA kode MENTAH. DILARANG keras: markdown, backtick, triple quote, penjelasan, komentar di luar kode.
2. Kode HARUS LENGKAP dari awal sampai akhir — JANGAN PERNAH potong di tengah dengan "// ... dst" atau placeholder apapun.
3. Setiap fungsi, loop, try/catch HARUS ada penutupnya yang lengkap.
4. Jika kode panjang, tetap tulis SELURUHNYA — tidak ada pengecualian.
5. Komentar dalam bahasa Indonesia di dalam kode boleh, tapi tidak ada teks di luar kode.`;

  const prompts = {
    nodejs: `Kamu adalah senior web scraping engineer expert Node.js. Tulis kode produksi yang lengkap dan bisa langsung dijalankan.
${bypass}
${bypassCF
  ? "Gunakan: puppeteer-extra + puppeteer-extra-plugin-stealth, random user-agent (paket user-agents), delay acak 1500-3000ms, nonHeadless: false."
  : "Gunakan: axios + cheerio untuk scraping statis."}
${SHARED_RULES}
- Mulai dari baris pertama: // SmartScrapeAI Generated Script
- require() semua library di paling atas
- Fungsi async main() dengan try/catch lengkap
- Output hasil: console.log(JSON.stringify(result, null, 2))
- Akhiri dengan: main().catch(console.error)`,

    python: `Kamu adalah senior web scraping engineer expert Python. Tulis kode produksi yang lengkap dan bisa langsung dijalankan.
${bypass}
${bypassCF
  ? "Gunakan: cloudscraper, fake_useragent.UserAgent(), BeautifulSoup, time.sleep(random.uniform(1.5, 3.0))."
  : "Gunakan: requests + BeautifulSoup4."}
${SHARED_RULES}
- Mulai dari baris pertama: # SmartScrapeAI Generated Script
- import semua modul di paling atas
- Fungsi main() dengan try/except lengkap
- Output hasil: print(json.dumps(result, indent=2, ensure_ascii=False))
- Akhiri dengan: if __name__ == '__main__': main()`,

    php: `Kamu adalah senior web scraping engineer expert PHP. Tulis kode produksi yang lengkap dan bisa langsung dijalankan.
${bypass}
${bypassCF
  ? "Gunakan cURL dengan header browser lengkap: User-Agent Chrome terbaru, Accept, Accept-Language, Referer, Cookie placeholder, sleep(rand(1,3))."
  : "Gunakan cURL + DOMDocument + DOMXPath."}
${SHARED_RULES}
- Mulai dari baris pertama: <?php
- Sertakan semua fungsi helper yang dibutuhkan
- try/catch lengkap
- Output hasil: echo json_encode($result, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE);`,
  };

  return prompts[lang];
}

// ── Generate Try-Input Schema ─────────────────────────────────
function buildTrySchema(url, target) {
  const host = (() => { try { return new URL(url).hostname.replace("www.", ""); } catch { return url; } })();
  const schemas = {
    "tiktok.com":    [{ name: "video_url",  label: "URL Video TikTok",   type: "url",  placeholder: "https://www.tiktok.com/@user/video/1234567890", required: true }],
    "instagram.com": [{ name: "post_url",   label: "URL Post Instagram", type: "url",  placeholder: "https://www.instagram.com/p/XXXXX/", required: true }],
    "youtube.com":   [{ name: "video_url",  label: "URL Video YouTube",  type: "url",  placeholder: "https://www.youtube.com/watch?v=XXXXX", required: true }],
    "twitter.com":   [{ name: "tweet_url",  label: "URL Tweet/Post",     type: "url",  placeholder: "https://x.com/user/status/XXXXX", required: true }],
    "x.com":         [{ name: "tweet_url",  label: "URL Post X",         type: "url",  placeholder: "https://x.com/user/status/XXXXX", required: true }],
    "shopee.co.id":  [{ name: "product_url",label: "URL Produk Shopee",  type: "url",  placeholder: "https://shopee.co.id/xxx", required: true }, { name: "limit", label: "Jumlah Produk", type: "number", placeholder: "10", required: false }],
    "tokopedia.com": [{ name: "product_url",label: "URL Produk Tokopedia",type:"url",  placeholder: "https://www.tokopedia.com/xxx", required: true }],
  };

  for (const [domain, schema] of Object.entries(schemas)) {
    if (host.includes(domain)) return schema;
  }

  // Generic schema
  return [
    { name: "target_url", label: "URL Target Scraping", type: "url",    placeholder: url, required: true },
    { name: "selector",   label: "CSS Selector (opsional)", type: "text", placeholder: "div.content, .price, h1, dll", required: false },
    { name: "limit",      label: "Limit hasil (opsional)", type: "number", placeholder: "10", required: false },
  ];
}

// ══════════════════════════════════════════════════════════════
//  ROUTES
// ══════════════════════════════════════════════════════════════

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "ok", version: "2.0.0", timestamp: new Date().toISOString() });
});

// ── POST /api/analyze ─────────────────────────────────────────
app.post("/api/analyze", async (req, res) => {
  const { url, provider, apiKey, model } = req.body;
  if (!url || !apiKey) return res.status(400).json({ error: "url dan apiKey diperlukan" });

  try {
    // Detect firewall
    const fw = await detectFirewall(url);

    // AI analyze
    const sys = `Kamu adalah SmartScrapeAI Agent berbahasa Indonesia.
Analisa URL dan sarankan target scraping yang spesifik.
Balas HANYA JSON valid (tanpa markdown):
{
  "greeting": "2 kalimat tentang website ini",
  "question": "tanya apa yang mau di-scrape (1 kalimat)",
  "suggestions": ["saran1","saran2","saran3","saran4","saran5"]
}`;

    const raw = await callAI({ provider, apiKey, model, system: sys, prompt: `Analisa: ${url}`, maxTokens: 500 });
    const clean = raw.replace(/```json|```/g, "").trim();
    let parsed;
    try   { parsed = JSON.parse(clean); }
    catch { parsed = {
      greeting: `Website ${url} siap untuk di-scrape menggunakan SmartScrapeAI.`,
      question: "Apa yang ingin kamu ambil dari website ini?",
      suggestions: ["🎥 URL Video/Media CDN","🖼️ Gambar & Thumbnail","📝 Teks & Konten Artikel","🔗 Semua Links & URL","📊 Data Tabel & Harga","🗂️ Semua Konten Halaman"],
    }; }

    res.json({ success: true, url, firewall: fw, ai: parsed });
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

  try {
    const sys    = buildSystemPrompt(lang, bypassCF);
    const prompt = `URL Target: ${url}
Yang akan di-scrape: ${target}
Bahasa: ${lang}
${bypassCF ? "Mode Bypass Cloudflare: AKTIF — Wajib gunakan semua teknik stealth bypass" : ""}

Tugas: Buat scraper LENGKAP dan SIAP PAKAI untuk mengambil: ${target}

Struktur kode wajib:
1. Import/require semua library
2. Konfigurasi (URL, headers, delay)
3. Fungsi fetch halaman${bypassCF ? " dengan bypass CF" : ""}
4. Fungsi parse & ekstrak: ${target}
5. Fungsi format/bersihkan data
6. Fungsi main() yang memanggil semua
7. Output JSON ke console
8. Error handling lengkap di setiap fungsi

INGAT: Tulis SEMUA kode dari awal sampai akhir. JANGAN potong atau skip bagian apapun.`;

    // maxTokens: null → pakai PROVIDER_MAX_TOKENS secara otomatis (kode tidak kepotong)
    let code = await callAI({ provider, apiKey, model, system: sys, prompt, maxTokens: null });
    // Bersihkan markdown jika ada
    code = code.replace(/^```[\w]*\n?/gm, "").replace(/^```\n?/gm, "").trim();

    // Buat ID dan simpan ke registry
    const id       = uuidv4();
    const trySchema = buildTrySchema(url, target);
    const host     = (() => { try { return new URL(url).hostname.replace("www.", ""); } catch { return "site"; } })();
    const extMap   = { nodejs: "js", python: "py", php: "php" };

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
      filename:  `scraper.${extMap[lang]}`,
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
  const all = registry.getAll();
  const docs = {
    name:        "SmartScrapeAI — API Documentation",
    version:     "2.0.0",
    description: "Auto-generated API docs dari semua scraper yang sudah dibuat",
    baseURL:     `http://localhost:${PORT}`,
    totalEndpoints: all.length + 4,
    builtinEndpoints: [
      { method: "GET",  path: "/health",       description: "Health check server" },
      { method: "POST", path: "/api/analyze",  description: "Analisa URL dan deteksi firewall", body: { url: "string", provider: "string", apiKey: "string", model: "string (opsional)" } },
      { method: "POST", path: "/api/generate", description: "Generate kode scraper", body: { url: "string", target: "string", lang: "nodejs|python|php", bypassCF: "boolean", provider: "string", apiKey: "string" } },
      { method: "GET",  path: "/api/docs",     description: "API documentation ini" },
    ],
    scrapers: all.map(s => ({
      id:          s.id,
      name:        s.name,
      url:         s.url,
      target:      s.target,
      lang:        s.lang,
      bypassCF:    s.bypassCF,
      provider:    s.provider,
      createdAt:   s.createdAt,
      endpoint:    `/api/scraper/${s.id}`,
      tryEndpoint: `/api/scraper/${s.id}/try`,
      tryInputs:   s.trySchema,
      download:    `/api/scraper/${s.id}/download`,
    })),
    providers: {
      supported: ["anthropic","openai","groq","gemini","deepseek","mistral","xai"],
      usage: "Kirim provider + apiKey di setiap request POST",
    },
  };
  res.json(docs);
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
  res.setHeader("Content-Type", "text/plain");
  res.send(entry.code);
});

// ── POST /api/scraper/:id/try ─────────────────────────────────
app.post("/api/scraper/:id/try", async (req, res) => {
  const entry = registry.getById(req.params.id);
  if (!entry) return res.status(404).json({ error: "Scraper tidak ditemukan" });

  // Coba fetch + parse sederhana sebagai preview
  const { target_url, video_url, post_url, product_url, tweet_url } = req.body;
  const targetURL = target_url || video_url || post_url || product_url || tweet_url || entry.url;

  try {
    const fw = await detectFirewall(targetURL);
    const preview = {
      message:        "Scraper siap dijalankan",
      target:         targetURL,
      scraper_id:     entry.id,
      lang:           entry.lang,
      bypass_mode:    entry.bypassCF,
      firewall_check: fw,
      run_command:    entry.lang === "nodejs" ? `node ${entry.filename}` : entry.lang === "python" ? `python3 ${entry.filename}` : `php ${entry.filename}`,
      code_preview:   entry.code.substring(0, 300) + "...",
      download_url:   `/api/scraper/${entry.id}/download`,
      note:           "Download kode lalu jalankan di local/server/Termux kamu",
    };
    res.json({ success: true, preview });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/scraper/:id/schema ───────────────────────────────
app.get("/api/scraper/:id/schema", (req, res) => {
  const entry = registry.getById(req.params.id);
  if (!entry) return res.status(404).json({ error: "Tidak ditemukan" });
  res.json({ id: entry.id, name: entry.name, inputs: entry.trySchema });
});

// ═══════════════════════════════════════════════════════════════
//  AI AUTO-FIX ENGINE
// ═══════════════════════════════════════════════════════════════

// ── POST /api/scraper/:id/fix ─────────────────────────────────
// Kirim error message → AI analisa + rewrite kode yang sudah fix
app.post("/api/scraper/:id/fix", async (req, res) => {
  const entry = registry.getById(req.params.id);
  if (!entry) return res.status(404).json({ error: "Scraper tidak ditemukan" });

  const { errorMessage, provider, apiKey, model, fixMode = "auto" } = req.body;
  if (!apiKey) return res.status(400).json({ error: "apiKey diperlukan" });

  const langLabel = { nodejs: "Node.js", python: "Python", php: "PHP" };

  // ── Analisa error dulu ──
  const analyzeSys = `Kamu adalah senior debugging engineer expert ${langLabel[entry.lang]}.
Analisa error yang diberikan dan kode scraper yang bermasalah.
Balas HANYA JSON valid (tanpa markdown, tanpa backtick):
{
  "error_type": "tipe error singkat (SyntaxError/NetworkError/ParseError/dll)",
  "root_cause": "penyebab utama error dalam 1 kalimat bahasa Indonesia",
  "fix_strategy": "strategi fix dalam 1-2 kalimat bahasa Indonesia",
  "severity": "critical|high|medium|low",
  "changes": ["perubahan 1 yang akan dilakukan", "perubahan 2", ...]
}`;

  const analyzePrompt = `Error yang terjadi:
${errorMessage || "Unknown error / kode tidak berjalan dengan benar"}

Kode scraper (${langLabel[entry.lang]}):
${entry.code.substring(0, 2000)}${entry.code.length > 2000 ? "\n... (kode terpotong untuk analisa)" : ""}

URL Target: ${entry.url}
Target scrape: ${entry.target}`;

  let analysis = null;
  try {
    const raw = await callAI({ provider, apiKey, model, system: analyzeSys, prompt: analyzePrompt, maxTokens: 600 });
    const clean = raw.replace(/```json|```/g, "").trim();
    analysis = JSON.parse(clean);
  } catch {
    analysis = {
      error_type: "Unknown",
      root_cause: "Tidak dapat menganalisa error secara detail",
      fix_strategy: "AI akan mencoba rewrite kode secara keseluruhan",
      severity: "high",
      changes: ["Rewrite kode lengkap dengan perbaikan error handling"],
    };
  }

  // ── Fix modes ──
  const fixModes = {
    auto:    "Perbaiki semua bug yang ditemukan secara otomatis",
    rewrite: "Tulis ulang SELURUH kode dari awal dengan logika yang lebih baik dan bug-free",
    patch:   "Hanya perbaiki bagian yang error, jangan ubah struktur keseluruhan",
    enhance: "Perbaiki bug DAN tambahkan fitur: retry otomatis, better error handling, logging",
  };

  const fixSys = `Kamu adalah senior debugging engineer expert ${langLabel[entry.lang]}.
${fixModes[fixMode] || fixModes.auto}

Error yang harus diperbaiki: ${errorMessage || "kode tidak berjalan"}
Root cause: ${analysis.root_cause}
Strategi: ${analysis.fix_strategy}

ATURAN TIDAK BOLEH DILANGGAR:
1. Output HANYA kode ${langLabel[entry.lang]} MENTAH yang sudah diperbaiki
2. DILARANG: markdown, backtick, triple quote, penjelasan di luar kode
3. Kode HARUS LENGKAP dari awal sampai akhir — tidak ada potongan
4. Tambahkan komentar // FIXED: di baris yang diperbaiki
5. Kode harus bisa langsung dijalankan tanpa error`;

  const fixPrompt = `Perbaiki kode berikut:

URL Target: ${entry.url}
Target scrape: ${entry.target}
Bypass CF: ${entry.bypassCF}

ERROR: ${errorMessage || "kode bermasalah"}

KODE ASLI (${langLabel[entry.lang]}):
${entry.code}

Perbaiki semua masalah dan output kode yang sudah fixed dan lengkap.`;

  try {
    let fixedCode = await callAI({ provider, apiKey, model, system: fixSys, prompt: fixPrompt, maxTokens: null });
    // Bersihkan sisa markdown
    fixedCode = fixedCode.replace(/^```[\w]*\n?/gm, "").replace(/^```\n?/gm, "").trim();

    // Hitung diff sederhana (jumlah baris berubah)
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
        linesChanged: diffCount,
        summary: `${fixedLines > origLines ? "+" : "-"}${diffCount} baris (${origLines} → ${fixedLines} baris)`,
      },
      message: `✅ Kode berhasil diperbaiki! ${analysis.changes.length} perubahan diterapkan.`,
    });
  } catch (e) {
    console.error("[fix]", e.message);
    res.status(500).json({ error: e.message, analysis });
  }
});

// ── POST /api/scraper/:id/apply ───────────────────────────────
// Terapkan kode yang sudah difix ke registry (update permanen)
app.post("/api/scraper/:id/apply", (req, res) => {
  const entry = registry.getById(req.params.id);
  if (!entry) return res.status(404).json({ error: "Scraper tidak ditemukan" });

  const { fixedCode, changeLog } = req.body;
  if (!fixedCode?.trim()) return res.status(400).json({ error: "fixedCode diperlukan" });

  // Simpan versi history sebelum update
  if (!entry.history) entry.history = [];
  entry.history.push({
    version:   (entry.history.length + 1),
    code:      entry.code,
    savedAt:   new Date().toISOString(),
    changeLog: changeLog || "Auto-fix applied",
  });

  // Update kode
  entry.code      = fixedCode;
  entry.updatedAt = new Date().toISOString();
  entry.fixCount  = (entry.fixCount || 0) + 1;
  entry.lastFix   = { appliedAt: new Date().toISOString(), changeLog };

  registry.update(entry.id, entry);

  res.json({
    success:  true,
    message:  `✅ Kode berhasil diperbarui! (Fix #${entry.fixCount})`,
    id:       entry.id,
    fixCount: entry.fixCount,
    versions: entry.history.length + 1,
  });
});

// ── POST /api/scraper/:id/revert ──────────────────────────────
// Kembalikan ke versi sebelumnya dari history
app.post("/api/scraper/:id/revert", (req, res) => {
  const entry = registry.getById(req.params.id);
  if (!entry) return res.status(404).json({ error: "Tidak ditemukan" });

  const { version } = req.body; // version number, default: versi sebelumnya
  if (!entry.history?.length) return res.status(400).json({ error: "Tidak ada history versi" });

  const idx     = version ? entry.history.findIndex(h => h.version === version) : entry.history.length - 1;
  const prevVer = entry.history[idx];
  if (!prevVer) return res.status(404).json({ error: "Versi tidak ditemukan" });

  entry.code      = prevVer.code;
  entry.updatedAt = new Date().toISOString();
  registry.update(entry.id, entry);

  res.json({
    success: true,
    message: `↩ Berhasil revert ke versi #${prevVer.version}`,
    revertedTo: prevVer.version,
  });
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

// ── POST /api/scraper/:id/edit ────────────────────────────────
// Edit manual spesifik bagian kode via AI instruction
app.post("/api/scraper/:id/edit", async (req, res) => {
  const entry = registry.getById(req.params.id);
  if (!entry) return res.status(404).json({ error: "Tidak ditemukan" });

  const { instruction, provider, apiKey, model } = req.body;
  if (!instruction || !apiKey) return res.status(400).json({ error: "instruction dan apiKey diperlukan" });

  const langLabel = { nodejs: "Node.js", python: "Python", php: "PHP" };

  const sys = `Kamu adalah senior ${langLabel[entry.lang]} engineer.
User memberikan instruksi spesifik untuk mengedit kode scraper.
Terapkan PERSIS sesuai instruksi. Jangan ubah bagian lain yang tidak diminta.
ATURAN: Output HANYA kode ${langLabel[entry.lang]} MENTAH yang sudah diedit. Tidak ada markdown. Kode LENGKAP dari awal sampai akhir.
Tandai baris yang diedit dengan komentar // EDITED: <alasan singkat>`;

  const prompt = `Instruksi edit: ${instruction}

Kode saat ini (${langLabel[entry.lang]}):
${entry.code}

Terapkan instruksi di atas dan output kode yang sudah diedit secara lengkap.`;

  try {
    let editedCode = await callAI({ provider, apiKey, model, system: sys, prompt, maxTokens: null });
    editedCode = editedCode.replace(/^```[\w]*\n?/gm, "").replace(/^```\n?/gm, "").trim();

    res.json({
      success:    true,
      editedCode,
      instruction,
      message:    "✅ Kode berhasil diedit sesuai instruksi",
    });
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

// ── GET /api/scrapers ─────────────────────────────────────────
app.get("/api/scrapers", (req, res) => {
  res.json({ success: true, count: registry.getAll().length, scrapers: registry.getAll() });
});

// Fallback ke frontend
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ── Start ─────────────────────────────────────────────────────
app.listen(PORT, "0.0.0.0", () => {
  console.log(`\n🤖 SmartScrapeAI Server v2.0 berjalan di port ${PORT}`);
  console.log(`   → http://localhost:${PORT}`);
  console.log(`   → API Docs: http://localhost:${PORT}/api/docs\n`);
});
