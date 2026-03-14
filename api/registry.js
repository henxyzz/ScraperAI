// ═══════════════════════════════════════════════════════════
//  SmartScrapeAI — API Registry
//  Menyimpan semua scraper yang sudah di-generate (in-memory)
//  Bisa di-extend ke database (MongoDB/SQLite) jika perlu
// ═══════════════════════════════════════════════════════════

const scrapers = new Map();

const registry = {
  add(entry) {
    scrapers.set(entry.id, entry);
    console.log(`[registry] Scraper ditambahkan: ${entry.name} (${entry.id})`);
    return entry;
  },

  update(id, entry) {
    if (!scrapers.has(id)) return false;
    scrapers.set(id, entry);
    console.log(`[registry] Scraper diupdate: ${entry.name} (${id}) — fix #${entry.fixCount || 0}`);
    return true;
  },


    return scrapers.get(id) || null;
  },

  getAll() {
    return Array.from(scrapers.values()).sort(
      (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
    );
  },

  remove(id) {
    return scrapers.delete(id);
  },

  count() {
    return scrapers.size;
  },
};

module.exports = registry;
