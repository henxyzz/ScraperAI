import { useState, useEffect } from "react";
import { BookOpen, Globe, RefreshCw, Copy, Check, Route, Trash2, ChevronDown, ChevronUp } from "lucide-react";
import { getApiDocs, getAllApiRoutes, deleteApiRoute } from "../api";
import { useStore } from "../store";
import type { ApiDocs, ApiRoute } from "../types";

export function DocsView() {
  const { addToast } = useStore();
  const [docs,       setDocs]       = useState<ApiDocs | null>(null);
  const [loading,    setLoading]    = useState(true);
  const [copied,     setCopied]     = useState<string | null>(null);
  const [allRoutes,  setAllRoutes]  = useState<ApiRoute[]>([]);
  const [routesLoading, setRoutesLoading] = useState(false);
  const [expandedScraper, setExpandedScraper] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const [docsRes, routesRes] = await Promise.all([
        getApiDocs(),
        getAllApiRoutes().catch(() => ({ routes: [], total: 0, success: false })),
      ]);
      setDocs(docsRes);
      setAllRoutes(routesRes.routes || []);
    } catch (e: any) {
      addToast("error", e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const copyUrl = async (path: string) => {
    const url = `${docs?.baseURL || ""}${path}`;
    await navigator.clipboard.writeText(url);
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

  const methodClass = (m: string) => `endpoint-method method-${m.toLowerCase()}`;

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
      {/* Header */}
      <div className="card">
        <div className="card-head">
          <BookOpen size={14} style={{ color: "var(--neon)" }} />
          <span className="card-tag">API Documentation</span>
          <span className="badge badge-neutral" style={{ marginLeft: "auto" }}>v{docs.version}</span>
          <button className="btn-icon" style={{ marginLeft: 8 }} onClick={load} title="Refresh">
            <RefreshCw size={13} />
          </button>
          <div className="card-dots"><span /><span /><span /></div>
        </div>
        <div className="card-body">
          <div className="docs-header-grid">
            <div>
              <div style={{ fontFamily: "var(--head)", fontSize: 16, fontWeight: 800, color: "var(--text)" }}>
                {docs.name}
              </div>
              <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 3 }}>{docs.description}</div>
            </div>
            <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
              <div className="stat-box" style={{ minWidth: 90 }}>
                <div className="stat-value" style={{ fontSize: 22 }}>{docs.totalEndpoints}</div>
                <div className="stat-label">Built-in</div>
              </div>
              <div className="stat-box" style={{ minWidth: 90 }}>
                <div className="stat-value" style={{ fontSize: 22 }}>{docs.scrapers.length}</div>
                <div className="stat-label">Scrapers</div>
              </div>
              <div className="stat-box" style={{ minWidth: 90 }}>
                <div className="stat-value" style={{ fontSize: 22, color: "var(--neon3)" }}>{allRoutes.length}</div>
                <div className="stat-label">API Routes</div>
              </div>
            </div>
          </div>

          <div style={{ marginTop: 14, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--muted)" }}>Base URL:</span>
            <code style={{
              fontFamily: "var(--mono)", fontSize: 12, color: "var(--neon2)",
              background: "rgba(0,0,0,.4)", padding: "3px 10px", borderRadius: 6,
            }}>
              {docs.baseURL}
            </code>
            <button className="btn-icon" onClick={() => copyUrl("")}>
              {copied === "" ? <Check size={12} style={{ color: "var(--neon)" }} /> : <Copy size={12} />}
            </button>
          </div>
        </div>
      </div>

      {/* Providers */}
      <div className="card">
        <div className="card-head">
          <Globe size={14} style={{ color: "var(--neon2)" }} />
          <span className="card-tag">Supported Providers</span>
          <div className="card-dots"><span /><span /><span /></div>
        </div>
        <div className="card-body">
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {docs.providers.supported.map(p => (
              <span key={p} className="badge badge-neon">{p}</span>
            ))}
          </div>
          <p style={{ fontSize: 12, color: "var(--muted)", marginTop: 10 }}>{docs.providers.usage}</p>
        </div>
      </div>

      {/* ── v4: Generated API Routes ─────────────────────────── */}
      {allRoutes.length > 0 && (
        <div className="card">
          <div className="card-head">
            <Route size={14} style={{ color: "var(--neon3)" }} />
            <span className="card-tag">Generated API Routes</span>
            <span className="badge badge-purple" style={{ marginLeft: "auto" }}>{allRoutes.length} routes</span>
            <div className="card-dots"><span /><span /><span /></div>
          </div>
          <div className="card-body" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <p style={{ fontSize: 12, color: "var(--muted)" }}>
              API routes yang di-generate otomatis dari hasil Try Output scraper.
              Path format: <code style={{ fontFamily: "var(--mono)", color: "var(--neon2)", fontSize: 11 }}>/api/generated/kategori/fitur</code>
            </p>

            {/* Group by category */}
            {Array.from(new Set(allRoutes.map(r => r.category))).map(cat => (
              <div key={cat} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <div style={{
                  fontFamily: "var(--mono)", fontSize: 10, color: "var(--neon3)",
                  textTransform: "uppercase", letterSpacing: 2, padding: "6px 0 2px",
                  borderBottom: "1px solid var(--border)", marginBottom: 2,
                }}>
                  📂 {cat}
                </div>
                {allRoutes.filter(r => r.category === cat).map(route => (
                  <div key={route.id} className="generated-route-card">
                    <div style={{ display: "flex", alignItems: "center", gap: 8, flex: 1, minWidth: 0 }}>
                      <span className={methodClass(route.method)} style={{ flexShrink: 0 }}>{route.method}</span>
                      <code style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--neon2)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {route.path}
                      </code>
                    </div>
                    <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 4 }}>{route.description}</div>
                    {route.params && route.params.length > 0 && (
                      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 6 }}>
                        {route.params.map(p => (
                          <span key={p.name} style={{
                            fontFamily: "var(--mono)", fontSize: 9, padding: "2px 7px",
                            background: "rgba(0,0,0,.3)", border: "1px solid var(--border2)",
                            borderRadius: 4, color: p.required ? "var(--warn)" : "var(--muted)",
                          }}>
                            {p.required ? "* " : ""}{p.name}: {p.type}
                          </span>
                        ))}
                      </div>
                    )}
                    <div style={{ display: "flex", gap: 6, marginTop: 8, alignItems: "center" }}>
                      <button className="btn-icon" style={{ padding: 4 }} onClick={() => copyUrl(route.path)} title="Copy URL">
                        {copied === route.path
                          ? <Check size={11} style={{ color: "var(--neon)" }} />
                          : <Copy size={11} />}
                      </button>
                      <span style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--muted)", marginLeft: "auto" }}>
                        {new Date(route.createdAt).toLocaleDateString("id-ID")}
                      </span>
                      <button
                        className="btn btn-danger btn-sm"
                        style={{ padding: "3px 8px", fontSize: 10 }}
                        onClick={() => handleDeleteRoute(route.scraperId, route.id)}
                        title="Hapus route"
                      >
                        <Trash2 size={10} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Built-in Endpoints */}
      <div className="card">
        <div className="card-head">
          <BookOpen size={14} style={{ color: "var(--neon3)" }} />
          <span className="card-tag">Built-in Endpoints ({docs.builtinEndpoints.length})</span>
          <div className="card-dots"><span /><span /><span /></div>
        </div>
        <div className="card-body">
          <div className="endpoint-list">
            {docs.builtinEndpoints.map((ep, i) => (
              <div key={i} className="endpoint-item">
                <span className={methodClass(ep.method)}>{ep.method}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <span className="endpoint-path">{ep.path}</span>
                    <button
                      className="btn-icon"
                      style={{ padding: 4 }}
                      onClick={() => copyUrl(ep.path)}
                      title="Copy URL"
                    >
                      {copied === ep.path
                        ? <Check size={11} style={{ color: "var(--neon)" }} />
                        : <Copy size={11} />}
                    </button>
                  </div>
                  <div className="endpoint-desc">{ep.description}</div>
                  {ep.body && (
                    <div className="endpoint-params">
                      {Object.entries(ep.body).map(([k, v]) => (
                        <div key={k} className="endpoint-param">
                          <strong>{k}</strong>: {v}
                        </div>
                      ))}
                    </div>
                  )}
                  {ep.query && (
                    <div className="endpoint-params">
                      {Object.entries(ep.query).map(([k, v]) => (
                        <div key={k} className="endpoint-param">
                          <strong>?{k}</strong>: {v}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Dynamic Scraper Endpoints */}
      {docs.scrapers.length > 0 && (
        <div className="card">
          <div className="card-head">
            <Globe size={14} style={{ color: "var(--neon)" }} />
            <span className="card-tag">Scraper Endpoints ({docs.scrapers.length})</span>
            <div className="card-dots"><span /><span /><span /></div>
          </div>
          <div className="card-body">
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {docs.scrapers.map(s => {
                const scraperRoutes = allRoutes.filter(r => r.scraperId === s.id);
                const isExpanded = expandedScraper === s.id;
                return (
                  <div key={s.id} className="scraper-doc-card">
                    <div
                      style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", cursor: "pointer" }}
                      onClick={() => setExpandedScraper(isExpanded ? null : s.id)}
                    >
                      <div>
                        <span style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--text)", fontWeight: 600 }}>{s.name}</span>
                        <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 2, wordBreak: "break-all" }}>{s.url}</div>
                      </div>
                      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                        {scraperRoutes.length > 0 && (
                          <span className="badge badge-purple" style={{ fontSize: 9 }}>+{scraperRoutes.length} routes</span>
                        )}
                        <span className="badge badge-neutral">{s.lang}</span>
                        <span className="badge badge-neutral">{s.provider}</span>
                        {isExpanded ? <ChevronUp size={13} style={{ color: "var(--muted)" }} /> : <ChevronDown size={13} style={{ color: "var(--muted)" }} />}
                      </div>
                    </div>

                    {isExpanded && (
                      <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 6 }}>
                        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: 6 }}>
                          {[
                            { method: "GET",  path: s.endpoint,    label: "Detail" },
                            { method: "GET",  path: s.download,    label: "Download" },
                            { method: "GET",  path: s.zip,         label: "ZIP" },
                            { method: "POST", path: s.tryEndpoint, label: "Try" },
                          ].map((ep, idx) => (
                            <div key={idx} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                              <span className={methodClass(ep.method)} style={{ fontSize: 9 }}>{ep.method}</span>
                              <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--text2)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{ep.path}</span>
                              <button className="btn-icon" style={{ padding: 3, flexShrink: 0 }} onClick={() => copyUrl(ep.path)}>
                                {copied === ep.path
                                  ? <Check size={10} style={{ color: "var(--neon)" }} />
                                  : <Copy size={10} />}
                              </button>
                            </div>
                          ))}
                        </div>

                        {/* Scraper's generated routes */}
                        {scraperRoutes.length > 0 && (
                          <div style={{ marginTop: 6, paddingTop: 6, borderTop: "1px solid var(--border)" }}>
                            <div style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--neon3)", marginBottom: 6, textTransform: "uppercase", letterSpacing: 1 }}>
                              Generated Routes
                            </div>
                            {scraperRoutes.map(r => (
                              <div key={r.id} style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                                <span className={methodClass(r.method)} style={{ fontSize: 9 }}>{r.method}</span>
                                <code style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--neon2)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.path}</code>
                                <button className="btn-icon" style={{ padding: 3 }} onClick={() => copyUrl(r.path)}>
                                  {copied === r.path ? <Check size={10} style={{ color: "var(--neon)" }} /> : <Copy size={10} />}
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
        </div>
      )}
    </div>
  );
}
