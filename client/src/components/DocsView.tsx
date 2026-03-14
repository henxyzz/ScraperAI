import { useState, useEffect } from "react";
import { BookOpen, Globe, RefreshCw, Copy, Check, ExternalLink } from "lucide-react";
import { getApiDocs } from "../api";
import { useStore } from "../store";
import type { ApiDocs } from "../types";

export function DocsView() {
  const { addToast } = useStore();
  const [docs,    setDocs]    = useState<ApiDocs | null>(null);
  const [loading, setLoading] = useState(true);
  const [copied,  setCopied]  = useState<string | null>(null);

  useEffect(() => {
    getApiDocs()
      .then(setDocs)
      .catch(e => addToast("error", e.message))
      .finally(() => setLoading(false));
  }, []);

  const copyUrl = async (path: string) => {
    const url = `${docs?.baseURL || ""}${path}`;
    await navigator.clipboard.writeText(url);
    setCopied(path);
    setTimeout(() => setCopied(null), 2000);
  };

  const methodClass = (m: string) =>
    `endpoint-method method-${m.toLowerCase()}`;

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
          <div className="card-dots"><span /><span /><span /></div>
        </div>
        <div className="card-body">
          <div style={{ display: "flex", gap: 20, flexWrap: "wrap", alignItems: "center" }}>
            <div>
              <div style={{ fontFamily: "var(--head)", fontSize: 16, fontWeight: 800, color: "var(--text)" }}>
                {docs.name}
              </div>
              <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 3 }}>{docs.description}</div>
            </div>
            <div style={{ marginLeft: "auto", display: "flex", gap: 14 }}>
              <div className="stat-box" style={{ minWidth: 90 }}>
                <div className="stat-value" style={{ fontSize: 22 }}>{docs.totalEndpoints}</div>
                <div className="stat-label">Endpoints</div>
              </div>
              <div className="stat-box" style={{ minWidth: 90 }}>
                <div className="stat-value" style={{ fontSize: 22 }}>{docs.scrapers.length}</div>
                <div className="stat-label">Scrapers</div>
              </div>
            </div>
          </div>

          <div style={{ marginTop: 14, display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--muted)" }}>Base URL:</span>
            <code style={{
              fontFamily: "var(--mono)", fontSize: 12, color: "var(--neon2)",
              background: "rgba(0,0,0,.4)", padding: "3px 10px", borderRadius: 6,
            }}>
              {docs.baseURL}
            </code>
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

      {/* Built-in Endpoints */}
      <div className="card">
        <div className="card-head">
          <BookOpen size={14} style={{ color: "var(--neon3)" }} />
          <span className="card-tag">Endpoints ({docs.builtinEndpoints.length})</span>
          <div className="card-dots"><span /><span /><span /></div>
        </div>
        <div className="card-body">
          <div className="endpoint-list">
            {docs.builtinEndpoints.map((ep, i) => (
              <div key={i} className="endpoint-item">
                <span className={methodClass(ep.method)}>{ep.method}</span>
                <div style={{ flex: 1 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
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
            <span className="card-tag">Generated Scraper Endpoints ({docs.scrapers.length})</span>
            <div className="card-dots"><span /><span /><span /></div>
          </div>
          <div className="card-body">
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {docs.scrapers.map(s => (
                <div key={s.id} style={{
                  background: "rgba(0,0,0,.3)", border: "1px solid var(--border)",
                  borderRadius: "var(--radius)", padding: "12px 15px",
                }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 8 }}>
                    <span style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--text)", fontWeight: 600 }}>{s.name}</span>
                    <div style={{ display: "flex", gap: 6 }}>
                      <span className="badge badge-neutral">{s.lang}</span>
                      <span className="badge badge-neutral">{s.provider}</span>
                    </div>
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
                    {[
                      { method: "GET",  path: s.endpoint },
                      { method: "GET",  path: s.download },
                      { method: "GET",  path: s.zip },
                    ].map((ep, idx) => (
                      <div key={idx} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <span className={methodClass(ep.method)} style={{ fontSize: 9 }}>{ep.method}</span>
                        <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--text2)" }}>{ep.path}</span>
                        <button className="btn-icon" style={{ padding: 3 }} onClick={() => copyUrl(ep.path)}>
                          {copied === ep.path
                            ? <Check size={10} style={{ color: "var(--neon)" }} />
                            : <Copy size={10} />}
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
