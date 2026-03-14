import { useState, useEffect, useCallback } from "react";
import {
  Search, Globe, Code2, Shield, ShieldOff, Trash2, Download,
  Package, Wand2, RefreshCw, ChevronRight, BarChart3, ExternalLink,
  Clock, Wrench, Filter
} from "lucide-react";
import { useStore } from "../store";
import {
  getScrapers, deleteScraper, searchScrapers, getStats,
  downloadFile, downloadZip, exportAllZip
} from "../api";
import { CodeBlock } from "./CodeBlock";
import type { Scraper, ScraperStats } from "../types";

export function ScrapersView() {
  const { addToast, setFixScraperId, setView } = useStore();

  const [scrapers,  setScrapers]  = useState<Scraper[]>([]);
  const [stats,     setStats]     = useState<ScraperStats | null>(null);
  const [selected,  setSelected]  = useState<Scraper | null>(null);
  const [loading,   setLoading]   = useState(true);
  const [searchQ,   setSearchQ]   = useState("");
  const [filterLang, setFilterLang] = useState("");
  const [deleting,  setDeleting]  = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [sRes, stRes] = await Promise.all([getScrapers(), getStats()]);
      setScrapers(sRes.scrapers);
      setStats(stRes.stats);
    } catch (e: any) {
      addToast("error", e.message || "Gagal load scrapers");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, []);

  const handleSearch = async (q: string, lang: string) => {
    if (!q && !lang) { load(); return; }
    try {
      const res = await searchScrapers(q || undefined, lang || undefined);
      setScrapers(res.scrapers);
    } catch {}
  };

  const handleDelete = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm("Hapus scraper ini? Aksi tidak bisa di-undo.")) return;
    setDeleting(id);
    try {
      await deleteScraper(id);
      setScrapers(prev => prev.filter(s => s.id !== id));
      if (selected?.id === id) setSelected(null);
      addToast("success", "Scraper dihapus");
      if (stats) setStats({ ...stats, total: stats.total - 1 });
    } catch (e: any) {
      addToast("error", e.message);
    } finally {
      setDeleting(null);
    }
  };

  const openFix = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setFixScraperId(id);
    setView("fix");
  };

  const langColor: Record<string, string> = {
    nodejs: "neon", python: "blue", php: "purple"
  };

  const formatDate = (d: string) =>
    new Date(d).toLocaleString("id-ID", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });

  return (
    <div className="scrapers-layout" style={{ display: "flex", gap: 16 }}>
      {/* Left: list */}
      <div style={{ flex: 1, minWidth: 0 }}>
        {/* Stats Row */}
        {stats && (
          <div className="stats-grid" style={{ marginBottom: 18 }}>
            <div className="stat-box">
              <div className="stat-value">{stats.total}</div>
              <div className="stat-label">Total Scrapers</div>
            </div>
            {Object.entries(stats.byLang).map(([lang, count]) => (
              <div key={lang} className="stat-box">
                <div className="stat-value">{count}</div>
                <div className="stat-label">{lang}</div>
              </div>
            ))}
            <div className="stat-box">
              <div className="stat-value" style={{ color: "var(--warn)" }}>{stats.withBypass}</div>
              <div className="stat-label">Bypass CF</div>
            </div>
            <div className="stat-box">
              <div className="stat-value" style={{ color: "var(--neon2)" }}>{stats.totalFixes}</div>
              <div className="stat-label">Total Fixes</div>
            </div>
          </div>
        )}

        {/* Search & Actions */}
        <div className="search-bar">
          <div className="search-input-wrap">
            <span className="search-input-icon"><Search size={14} /></span>
            <input
              className="search-input"
              placeholder="Cari scraper by URL, target, nama..."
              value={searchQ}
              onChange={e => { setSearchQ(e.target.value); handleSearch(e.target.value, filterLang); }}
            />
          </div>
          <select
            className="provider-select"
            value={filterLang}
            onChange={e => { setFilterLang(e.target.value); handleSearch(searchQ, e.target.value); }}
          >
            <option value="">Semua Lang</option>
            <option value="nodejs">Node.js</option>
            <option value="python">Python</option>
            <option value="php">PHP</option>
          </select>
          <button className="btn btn-secondary btn-sm" onClick={load} title="Refresh">
            <RefreshCw size={13} />
          </button>
          {scrapers.length > 0 && (
            <button className="btn btn-secondary btn-sm" onClick={exportAllZip} title="Export semua ke ZIP">
              <Package size={13} /> Export ZIP
            </button>
          )}
        </div>

        {/* List */}
        {loading ? (
          <div className="loading-overlay">
            <div className="spinner spinner-lg" />
            <span className="loading-msg">Memuat scrapers...</span>
          </div>
        ) : scrapers.length === 0 ? (
          <div className="empty-state">
            <div className="empty-icon"><Code2 size={48} /></div>
            <div className="empty-title">Belum ada scraper</div>
            <div className="empty-sub">Generate scraper pertamamu di tab Generator.</div>
            <button className="btn btn-primary" onClick={() => setView("generator")}>
              <Wand2 size={15} /> Buat Scraper Baru
            </button>
          </div>
        ) : (
          <div className="scraper-grid">
            {scrapers.map(s => (
              <div
                key={s.id}
                className={`scraper-card ${selected?.id === s.id ? "active" : ""}`}
                onClick={() => setSelected(selected?.id === s.id ? null : s)}
                style={selected?.id === s.id ? { borderColor: "var(--neon)", background: "var(--card2)" } : {}}
              >
                <div className="scraper-card-head">
                  <div style={{ flex: 1 }}>
                    <div className="scraper-card-name">{s.name}</div>
                    <div style={{ display: "flex", gap: 5, marginTop: 5, flexWrap: "wrap" }}>
                      <span className={`badge badge-${langColor[s.lang] || "neutral"}`}>{s.lang}</span>
                      {s.bypassCF && <span className="badge badge-warn">bypass</span>}
                      {s.fixCount > 0 && (
                        <span className="badge badge-neutral">fix #{s.fixCount}</span>
                      )}
                    </div>
                  </div>
                  <ChevronRight size={14} style={{
                    color: "var(--muted)", transition: "transform .2s",
                    transform: selected?.id === s.id ? "rotate(90deg)" : "none",
                  }} />
                </div>

                <div className="scraper-card-body">
                  <div className="scraper-card-row">
                    <Globe size={12} />
                    <span style={{ color: "var(--neon2)", fontSize: 11 }}>{s.url}</span>
                  </div>
                  <div className="scraper-card-row">
                    <Wand2 size={12} />
                    <span>{s.target.slice(0, 80)}{s.target.length > 80 ? "…" : ""}</span>
                  </div>
                  <div className="scraper-card-row">
                    <Clock size={12} />
                    <span style={{ color: "var(--muted)", fontFamily: "var(--mono)", fontSize: 10 }}>
                      {formatDate(s.createdAt)}
                    </span>
                  </div>
                </div>

                <div className="scraper-card-actions">
                  <button className="btn btn-ghost btn-sm" onClick={e => { e.stopPropagation(); downloadFile(s.id); }} title="Download file">
                    <Download size={12} />
                  </button>
                  <button className="btn btn-ghost btn-sm" onClick={e => { e.stopPropagation(); downloadZip(s.id); }} title="Download ZIP">
                    <Package size={12} />
                  </button>
                  <button className="btn btn-ghost btn-sm" onClick={e => openFix(s.id, e)} title="Fix Engine">
                    <Wrench size={12} />
                  </button>
                  <button
                    className="btn btn-danger btn-sm"
                    onClick={e => handleDelete(s.id, e)}
                    disabled={deleting === s.id}
                    title="Hapus scraper"
                    style={{ marginLeft: "auto" }}
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Right: detail pane */}
      {selected && (
        <div className="scraper-detail-pane" style={{ width: 480, flexShrink: 0 }}>
          <div className="card" style={{ position: "sticky", top: 80 }}>
            <div className="card-head">
              <Code2 size={14} style={{ color: "var(--neon)" }} />
              <span className="card-tag">{selected.name}</span>
              <button className="btn-icon" style={{ marginLeft: "auto" }} onClick={() => setSelected(null)}>
                
              </button>
            </div>
            <div className="card-body">
              {/* Meta */}
              <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 14 }}>
                {[
                  { label: "URL",      val: selected.url },
                  { label: "Target",   val: selected.target },
                  { label: "Provider", val: `${selected.provider} / ${selected.model || "default"}` },
                  { label: "Created",  val: formatDate(selected.createdAt) },
                  { label: "Lines",    val: `${selected.code.split("\n").length} baris` },
                ].map(r => (
                  <div key={r.label} style={{ display: "flex", gap: 10, fontSize: 12 }}>
                    <span style={{ color: "var(--muted)", fontFamily: "var(--mono)", fontSize: 10, width: 60, flexShrink: 0, textTransform: "uppercase", letterSpacing: 1, paddingTop: 1 }}>{r.label}</span>
                    <span style={{ color: "var(--text2)", wordBreak: "break-all" }}>{r.val}</span>
                  </div>
                ))}
              </div>

              <CodeBlock
                code={selected.code}
                lang={selected.lang}
                scraperId={selected.id}
                maxHeight={320}
              />

              <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
                <button className="btn btn-primary btn-sm" onClick={() => { setFixScraperId(selected.id); setView("fix"); }}>
                  <Wrench size={12} /> Fix Engine
                </button>
                <button className="btn btn-secondary btn-sm" onClick={() => downloadZip(selected.id)}>
                  <Package size={12} /> Download ZIP
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
