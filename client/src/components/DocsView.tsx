import { useState, useEffect } from "react";
import {
  BookOpen, Globe, RefreshCw, Copy, Check, Route, Trash2,
  ChevronDown, ChevronUp, Play, Search
} from "lucide-react";
import { getApiDocs, getAllApiRoutes, deleteApiRoute, getScrapers } from "../api";
import { useStore } from "../store";
import { TryOutputPanel } from "./TryOutputPanel";
import type { ApiDocs, ApiRoute, Scraper } from "../types";

export function DocsView() {
  const { addToast } = useStore();
  const [docs,       setDocs]       = useState<ApiDocs | null>(null);
  const [loading,    setLoading]    = useState(true);
  const [copied,     setCopied]     = useState<string | null>(null);
  const [allRoutes,  setAllRoutes]  = useState<ApiRoute[]>([]);
  const [scrapers,   setScrapers]   = useState<Scraper[]>([]);
  const [expanded,   setExpanded]   = useState<string | null>(null);
  const [tryOpen,    setTryOpen]    = useState<string | null>(null);
  const [search,     setSearch]     = useState("");

  const load = async () => {
    setLoading(true);
    try {
      const [docsRes, routesRes, scrapersRes] = await Promise.all([
        getApiDocs(),
        getAllApiRoutes().catch(() => ({ routes: [], total: 0, success: false })),
        getScrapers().catch(() => ({ scrapers: [] })),
      ]);
      setDocs(docsRes);
      setAllRoutes(routesRes.routes || []);
      setScrapers(scrapersRes.scrapers || []);
    } catch (e: any) {
      addToast("error", e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const copyUrl = async (path: string) => {
    await navigator.clipboard.writeText(`${docs?.baseURL || ""}${path}`);
    setCopied(path);
    setTimeout(() => setCopied(null), 2000);
  };

  const handleDeleteRoute = async (scraperId: string, routeId: string) => {
    if (!confirm("Hapus API route ini?")) return;
    try {
      await deleteApiRoute(scraperId, routeId);
      setAllRoutes(prev => prev.filter(r => r.id !== routeId));
      addToast("success", "Route dihapus");
    } catch (e: any) {
      addToast("error", e.message);
    }
  };

  const M = (m: string) => `endpoint-method method-${m.toLowerCase()}`;

  const filteredScrapers = scrapers.filter(s =>
    !search || s.name.toLowerCase().includes(search) || s.url.toLowerCase().includes(search) || s.target.toLowerCase().includes(search)
  );

  if (loading) return (
    <div className="loading-overlay">
      <div className="spinner spinner-lg" />
      <span className="loading-msg">Memuat API docs...</span>
    </div>
  );

  if (!docs) return (
    <div className="empty-state">
      <div className="empty-icon"><BookOpen size={48} /></div>
      <div className="empty-title">Gagal memuat docs</div>
    </div>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>

      {/* ── Header ── */}
      <div className="card">
        <div className="card-head">
          <BookOpen size={14} style={{ color: "var(--neon)" }} />
          <span className="card-tag">API Documentation</span>
          <span className="badge badge-neutral" style={{ marginLeft: "auto" }}>v{docs.version}</span>
          <button className="btn-icon" style={{ marginLeft: 6 }} onClick={load}><RefreshCw size={13} /></button>
          <div className="card-dots"><span /><span /><span /></div>
        </div>
        <div className="card-body">
          <div className="docs-header-grid">
            <div>
              <div style={{ fontFamily: "var(--head)", fontSize: 15, fontWeight: 800, color: "var(--text)" }}>{docs.name}</div>
              <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 3 }}>{docs.description}</div>
            </div>
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
              {[
                { v: docs.totalEndpoints, l: "Endpoints" },
                { v: docs.scrapers.length, l: "Scrapers" },
                { v: allRoutes.length, l: "Routes", c: "var(--neon3)" },
              ].map(s => (
                <div key={s.l} className="stat-box" style={{ minWidth: 80 }}>
                  <div className="stat-value" style={{ fontSize: 20, color: s.c }}>{s.v}</div>
                  <div className="stat-label">{s.l}</div>
                </div>
              ))}
            </div>
          </div>
          <div style={{ marginTop: 12, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--muted)" }}>Base URL:</span>
            <code style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--neon2)", background: "rgba(0,0,0,.4)", padding: "3px 10px", borderRadius: 6 }}>
              {docs.baseURL}
            </code>
            <button className="btn-icon" onClick={() => copyUrl("")}>
              {copied === "" ? <Check size={11} style={{ color: "var(--neon)" }} /> : <Copy size={11} />}
            </button>
          </div>
        </div>
      </div>

      {/* ── Scraper Endpoints — with Try button ── */}
      {scrapers.length > 0 && (
        <div className="card">
          <div className="card-head">
            <Play size={14} style={{ color: "var(--neon3)" }} />
            <span className="card-tag">Scraper Files — Try Langsung</span>
            <span className="badge badge-neon" style={{ marginLeft: "auto", fontSize: 9 }}>{scrapers.length} scrapers</span>
            <div className="card-dots"><span /><span /><span /></div>
          </div>
          <div className="card-body" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {/* Search */}
            <div className="search-input-wrap" style={{ marginBottom: 6 }}>
              <span className="search-input-icon"><Search size={13} /></span>
              <input className="search-input" placeholder="Cari scraper..." value={search}
                onChange={e => setSearch(e.target.value.toLowerCase())} />
            </div>

            {filteredScrapers.map(s => {
              const isExp = expanded === s.id;
              const isTry = tryOpen === s.id;
              const scraperRoutes = allRoutes.filter(r => r.scraperId === s.id);
              return (
                <div key={s.id} className="scraper-doc-card">
                  {/* Header row */}
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontFamily: "var(--mono)", fontSize: 12, fontWeight: 700, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.name}</div>
                      <div style={{ fontSize: 10, color: "var(--muted)", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.url}</div>
                    </div>
                    <div style={{ display: "flex", gap: 6, alignItems: "center", flexShrink: 0 }}>
                      {scraperRoutes.length > 0 && <span className="badge badge-purple" style={{ fontSize: 9 }}>+{scraperRoutes.length} routes</span>}
                      <span className={`badge badge-${s.lang === "nodejs" ? "neon" : s.lang === "python" ? "blue" : "purple"}`}>{s.lang}</span>
                      {/* ── TRY BUTTON ── */}
                      <button
                        className={`btn btn-sm ${isTry ? "btn-primary" : "btn-secondary"}`}
                        onClick={() => setTryOpen(isTry ? null : s.id)}
                        style={{ gap: 5 }}
                      >
                        <Play size={11} /> {isTry ? "Tutup Try" : "Try"}
                      </button>
                      <button className="btn-icon" onClick={() => setExpanded(isExp ? null : s.id)}>
                        {isExp ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
                      </button>
                    </div>
                  </div>

                  {/* ── TRY PANEL inline ── */}
                  {isTry && (
                    <div style={{ marginTop: 12, borderTop: "1px solid var(--border2)", paddingTop: 12 }}>
                      <TryOutputPanel scraper={s} compact={false} />
                    </div>
                  )}

                  {/* Endpoint list */}
                  {isExp && (
                    <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 6 }}>
                      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: 5 }}>
                        {[
                          { method: "GET",  path: `/api/scraper/${s.id}`,          label: "Detail" },
                          { method: "GET",  path: `/api/scraper/${s.id}/download`,  label: "Download" },
                          { method: "GET",  path: `/api/scraper/${s.id}/zip`,       label: "ZIP" },
                          { method: "POST", path: `/api/scraper/${s.id}/try`,       label: "Try" },
                          { method: "POST", path: `/api/scraper/${s.id}/fix`,       label: "Fix" },
                          { method: "GET",  path: `/api/scraper/${s.id}/routes`,    label: "Routes" },
                          { method: "POST", path: `/api/scraper/${s.id}/install`,   label: "Install" },
                        ].map((ep, idx) => (
                          <div key={idx} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                            <span className={M(ep.method)} style={{ fontSize: 9 }}>{ep.method}</span>
                            <code style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--text2)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{ep.path}</code>
                            <button className="btn-icon" style={{ padding: 3, flexShrink: 0 }} onClick={() => copyUrl(ep.path)}>
                              {copied === ep.path ? <Check size={9} style={{ color: "var(--neon)" }} /> : <Copy size={9} />}
                            </button>
                          </div>
                        ))}
                      </div>

                      {scraperRoutes.length > 0 && (
                        <div style={{ marginTop: 6, paddingTop: 6, borderTop: "1px dashed var(--border)" }}>
                          <div style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--neon3)", marginBottom: 5, textTransform: "uppercase", letterSpacing: 1 }}>Generated Routes</div>
                          {scraperRoutes.map(r => (
                            <div key={r.id} style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                              <span className={M(r.method)} style={{ fontSize: 9 }}>{r.method}</span>
                              <code style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--neon2)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.path}</code>
                              <button className="btn-icon" style={{ padding: 3 }} onClick={() => copyUrl(r.path)}>
                                {copied === r.path ? <Check size={9} style={{ color: "var(--neon)" }} /> : <Copy size={9} />}
                              </button>
                              <button className="btn btn-danger btn-sm" style={{ padding: "2px 6px", fontSize: 9 }}
                                onClick={() => handleDeleteRoute(r.scraperId, r.id)}>
                                <Trash2 size={9} />
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ── Generated API Routes ── */}
      {allRoutes.length > 0 && (
        <div className="card">
          <div className="card-head">
            <Route size={14} style={{ color: "var(--neon3)" }} />
            <span className="card-tag">Generated API Routes</span>
            <span className="badge badge-purple" style={{ marginLeft: "auto" }}>{allRoutes.length}</span>
            <div className="card-dots"><span /><span /><span /></div>
          </div>
          <div className="card-body" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <p style={{ fontSize: 11, color: "var(--muted)" }}>Endpoint yang dibuat dari Try Output. Path: <code style={{ fontFamily: "var(--mono)", color: "var(--neon2)", fontSize: 10 }}>/api/generated/kategori/nama</code></p>
            {Array.from(new Set(allRoutes.map(r => r.category))).map(cat => (
              <div key={cat}>
                <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--neon3)", textTransform: "uppercase", letterSpacing: 2, padding: "5px 0 3px", borderBottom: "1px solid var(--border)", marginBottom: 5 }}>
                   {cat}
                </div>
                {allRoutes.filter(r => r.category === cat).map(route => (
                  <div key={route.id} className="generated-route-card" style={{ marginBottom: 6 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                      <span className={M(route.method)} style={{ flexShrink: 0 }}>{route.method}</span>
                      <code style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--neon2)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{route.path}</code>
                      <button className="btn-icon" style={{ padding: 4 }} onClick={() => copyUrl(route.path)}>
                        {copied === route.path ? <Check size={11} style={{ color: "var(--neon)" }} /> : <Copy size={11} />}
                      </button>
                      <button className="btn btn-danger btn-sm" style={{ padding: "3px 8px", fontSize: 10 }}
                        onClick={() => handleDeleteRoute(route.scraperId, route.id)}>
                        <Trash2 size={10} />
                      </button>
                    </div>
                    <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 4 }}>{route.description}</div>
                    {route.params && route.params.length > 0 && (
                      <div style={{ display: "flex", gap: 5, flexWrap: "wrap", marginTop: 5 }}>
                        {route.params.map(p => (
                          <span key={p.name} style={{ fontFamily: "var(--mono)", fontSize: 9, padding: "2px 7px", background: "rgba(0,0,0,.3)", border: "1px solid var(--border2)", borderRadius: 4, color: p.required ? "var(--warn)" : "var(--muted)" }}>
                            {p.required ? "* " : ""}{p.name}:{p.type}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Built-in Endpoints ── */}
      <div className="card">
        <div className="card-head">
          <BookOpen size={14} style={{ color: "var(--neon2)" }} />
          <span className="card-tag">Built-in Endpoints ({docs.builtinEndpoints.length})</span>
          <div className="card-dots"><span /><span /><span /></div>
        </div>
        <div className="card-body">
          <div className="endpoint-list">
            {docs.builtinEndpoints.map((ep, i) => (
              <div key={i} className="endpoint-item">
                <span className={M(ep.method)}>{ep.method}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                    <span className="endpoint-path">{ep.path}</span>
                    <button className="btn-icon" style={{ padding: 3 }} onClick={() => copyUrl(ep.path)}>
                      {copied === ep.path ? <Check size={10} style={{ color: "var(--neon)" }} /> : <Copy size={10} />}
                    </button>
                  </div>
                  <div className="endpoint-desc">{ep.description}</div>
                  {ep.body && (
                    <div className="endpoint-params">
                      {Object.entries(ep.body).map(([k,v]) => (
                        <div key={k} className="endpoint-param"><strong>{k}</strong>: {v}</div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ── Providers ── */}
      <div className="card">
        <div className="card-head">
          <Globe size={14} style={{ color: "var(--neon2)" }} />
          <span className="card-tag">Supported Providers</span>
          <div className="card-dots"><span /><span /><span /></div>
        </div>
        <div className="card-body">
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {docs.providers.supported.map(p => <span key={p} className="badge badge-neon">{p}</span>)}
          </div>
          <p style={{ fontSize: 12, color: "var(--muted)", marginTop: 10 }}>{docs.providers.usage}</p>
        </div>
      </div>

    </div>
  );
}
