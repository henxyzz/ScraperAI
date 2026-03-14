// ═══════════════════════════════════════════════════════════
//  SmartScrapeAI v3 — Registry
//  Penyimpanan semua scraper yang di-generate
//  In-memory + JSON file persistence (tidak hilang saat restart)
// ═══════════════════════════════════════════════════════════

const fs   = require("fs");
const path = require("path");

const DATA_FILE = path.join(__dirname, "..", "data", "scrapers.json");

// Load dari file saat startup
const scrapers = new Map();

function loadFromDisk() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw  = fs.readFileSync(DATA_FILE, "utf8");
      const list = JSON.parse(raw);
      if (Array.isArray(list)) {
        list.forEach(entry => scrapers.set(entry.id, entry));
        console.log(`[registry] Loaded ${scrapers.size} scraper dari disk`);
      }
    }
  } catch (e) {
    console.error("[registry] Gagal load dari disk:", e.message);
  }
}

function saveToDisk() {
  try {
    const dir = path.dirname(DATA_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const list = Array.from(scrapers.values());
    fs.writeFileSync(DATA_FILE, JSON.stringify(list, null, 2), "utf8");
  } catch (e) {
    console.error("[registry] Gagal save ke disk:", e.message);
  }
}

// Load saat module di-require
loadFromDisk();

const registry = {
  // Tambah scraper baru
  add(entry) {
    scrapers.set(entry.id, entry);
    saveToDisk();
    console.log(`[registry] + Scraper ditambahkan: ${entry.name} (${entry.id})`);
    return entry;
  },

  // Update scraper existing
  update(id, entry) {
    if (!scrapers.has(id)) return false;
    scrapers.set(id, entry);
    saveToDisk();
    console.log(`[registry] ~ Scraper diupdate: ${entry.name} (id=${id}, fix=#${entry.fixCount || 0})`);
    return true;
  },

  // Ambil scraper by ID — FIXED: dulu tidak ada method ini
  get(id) {
    return scrapers.get(id) || null;
  },

  // Alias get → getById (backward compat)
  getById(id) {
    return this.get(id);
  },

  // Semua scraper, urut terbaru
  getAll() {
    return Array.from(scrapers.values()).sort(
      (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
    );
  },

  // Hapus scraper
  remove(id) {
    const ok = scrapers.delete(id);
    if (ok) saveToDisk();
    return ok;
  },

  // Hapus semua
  clear() {
    scrapers.clear();
    saveToDisk();
  },

  // Jumlah scraper
  count() {
    return scrapers.size;
  },

  // Stats agregat
  stats() {
    const all = this.getAll();
    const byLang = all.reduce((acc, s) => {
      acc[s.lang] = (acc[s.lang] || 0) + 1;
      return acc;
    }, {});
    const byProvider = all.reduce((acc, s) => {
      acc[s.provider] = (acc[s.provider] || 0) + 1;
      return acc;
    }, {});
    return {
      total:       all.length,
      byLang,
      byProvider,
      withBypass:  all.filter(s => s.bypassCF).length,
      totalFixes:  all.reduce((n, s) => n + (s.fixCount || 0), 0),
    };
  },
};

module.exports = registry;
