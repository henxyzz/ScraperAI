import { useState } from "react";
import { Play, ChevronDown, ChevronUp, Copy, Check, AlertTriangle, CheckCircle, Download, Route, PlusCircle } from "lucide-react";
import { tryScraper, createApiRoute } from "../api";
import { useStore } from "../store";
import type { Scraper, TrySchemaField, ApiRoute } from "../types";

interface Props {
  scraper: Scraper;
  compact?: boolean; // for use inside API Docs
}

export function TryOutputPanel({ scraper, compact = false }: Props) {
  const { addToast } = useStore();
  const [inputs,       setInputs]       = useState<Record<string, string>>({});
  const [loading,      setLoading]      = useState(false);
  const [result,       setResult]       = useState<any>(null);
  const [error,        setError]        = useState<string | null>(null);
  const [copied,       setCopied]       = useState(false);
  const [expanded,     setExpanded]     = useState(!compact);
  const [makeRoute,    setMakeRoute]    = useState(false);
  const [routeCat,     setRouteCat]     = useState("scraper");
  const [routeName,    setRouteName]    = useState(scraper.name);
  const [createdRoute, setCreatedRoute] = useState<ApiRoute | null>(null);
  const [routeLoading, setRouteLoading] = useState(false);

  const handleTry = async () => {
    setLoading(true); setResult(null); setError(null);
    try {
      const res = await tryScraper(scraper.id, inputs);
      setResult(res);
      if (!res.success) setError(res.error || "Gagal scraping");
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  const handleCopyJson = async () => {
    await navigator.clipboard.writeText(JSON.stringify(result?.scraped_data || result, null, 2));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleCreateRoute = async () => {
    setRouteLoading(true);
    try {
      const slug = routeName.trim().toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
      const res  = await createApiRoute(scraper.id, {
        name:        slug,
        category:    routeCat,
        method:      "GET",
        path:        `/api/generated/${routeCat}/${slug}`,
        description: `Scraper: ${scraper.url} — ${scraper.target}`,
        params:      (scraper.trySchema || []).map(f => ({ name: f.name, type: f.type, required: f.required, description: f.label })),
      });
      setCreatedRoute(res.route);
      addToast("success", `Route dibuat: ${res.route.path}`);
    } catch (e: any) {
      addToast("error", e.message);
    } finally {
      setRouteLoading(false);
    }
  };

  // Render scraped data as pretty table or JSON
  const renderScrapedData = (data: any, depth = 0): JSX.Element => {
    if (!data) return <span style={{ color: "var(--muted)" }}>null</span>;
    if (typeof data === "string") return <span style={{ color: "var(--neon2)" }}>"{data}"</span>;
    if (typeof data === "number") return <span style={{ color: "#f78c6c" }}>{data}</span>;
    if (typeof data === "boolean") return <span style={{ color: "#c792ea" }}>{String(data)}</span>;

    if (Array.isArray(data)) {
      if (data.length === 0) return <span style={{ color: "var(--muted)" }}>[]</span>;
      if (data.every(i => typeof i === "string" || typeof i === "number")) {
        return (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
            {data.map((item, i) => (
              <span key={i} style={{
                background: "rgba(46,255,168,.08)", border: "1px solid rgba(46,255,168,.2)",
                borderRadius: 4, padding: "1px 7px", fontFamily: "var(--mono)", fontSize: 11, color: "var(--neon)",
              }}>{item}</span>
            ))}
          </div>
        );
      }
      return (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {data.slice(0, 8).map((item, i) => (
            <div key={i} style={{ paddingLeft: 12, borderLeft: "2px solid var(--border2)" }}>
              {renderScrapedData(item, depth + 1)}
            </div>
          ))}
          {data.length > 8 && <span style={{ color: "var(--muted)", fontSize: 11 }}>... +{data.length - 8} item</span>}
        </div>
      );
    }

    if (typeof data === "object") {
      const SKIP_KEYS = ["_source","parsed_by","url","scraper_id","scraper_name","lang","target","firewall","scraped_at","note","download_url","zip_url"];
      const entries = Object.entries(data).filter(([k]) => depth === 0 ? !SKIP_KEYS.includes(k) : true);
      return (
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <tbody>
            {entries.map(([k, v]) => (
              <tr key={k} style={{ borderBottom: "1px solid var(--border)" }}>
                <td style={{
                  fontFamily: "var(--mono)", fontSize: 10, color: "var(--muted)",
                  textTransform: "uppercase", letterSpacing: 1, padding: "6px 10px 6px 0",
                  width: "30%", verticalAlign: "top", whiteSpace: "nowrap",
                }}>{k.replace(/_/g, " ")}</td>
                <td style={{ padding: "6px 0", fontSize: 12, color: "var(--text2)", verticalAlign: "top" }}>
                  {renderScrapedData(v, depth + 1)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      );
    }
    return <span>{String(data)}</span>;
  };

  const schema = scraper.trySchema || [];
  const hasDefaultUrl = schema.some(f => f.type === "url");

  return (
    <div className="try-panel">
      {compact && (
        <button className="try-panel-toggle" onClick={() => setExpanded(p => !p)}>
          <Play size={12} style={{ color: "var(--neon3)" }} />
          <span>Try It</span>
          {expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
        </button>
      )}

      {expanded && (
        <div className="try-panel-body">
          {/* Input fields */}
          {schema.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 10 }}>
              {schema.map(field => (
                <div key={field.name}>
                  <label style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--muted)", textTransform: "uppercase", letterSpacing: 1, display: "block", marginBottom: 4 }}>
                    {field.label}{field.required && <span style={{ color: "var(--danger)", marginLeft: 3 }}>*</span>}
                  </label>
                  <input
                    className="field-input"
                    style={{ fontSize: 12 }}
                    type={field.type === "url" ? "url" : "text"}
                    placeholder={field.placeholder}
                    value={inputs[field.name] || ""}
                    onChange={e => setInputs(p => ({ ...p, [field.name]: e.target.value }))}
                  />
                </div>
              ))}
            </div>
          )}

          {schema.length === 0 && (
            <div style={{ marginBottom: 10 }}>
              <label style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--muted)", textTransform: "uppercase", letterSpacing: 1, display: "block", marginBottom: 4 }}>URL Target</label>
              <input
                className="field-input"
                style={{ fontSize: 12 }}
                type="url"
                placeholder={scraper.url}
                value={inputs["url"] || ""}
                onChange={e => setInputs({ url: e.target.value })}
              />
            </div>
          )}

          <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
            <button className="btn btn-primary btn-sm" onClick={handleTry} disabled={loading}>
              {loading
                ? <><div className="spinner" style={{ width: 12, height: 12 }} /> Scraping...</>
                : <><Play size={12} /> Run Scraper</>}
            </button>
            {result?.download_url && (
              <a className="btn btn-secondary btn-sm" href={result.download_url} download>
                <Download size={12} /> Download Code
              </a>
            )}
          </div>

          {/* Error state */}
          {error && (
            <div className="info-box warn" style={{ marginBottom: 12 }}>
              <AlertTriangle size={13} />
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <span style={{ fontWeight: 600, fontSize: 12 }}>{error}</span>
                {result?.fix_hint && <span style={{ fontSize: 11 }}>{result.fix_hint}</span>}
              </div>
            </div>
          )}

          {/* Success: scraped data */}
          {result?.success && result.scraped_data && (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <CheckCircle size={13} style={{ color: "var(--neon)" }} />
                <span style={{ fontSize: 12, color: "var(--neon)", fontWeight: 600 }}>Data berhasil di-scrape!</span>
                <span style={{ fontSize: 11, color: "var(--muted)", fontFamily: "var(--mono)" }}>
                  via {result.scraped_data?.parsed_by || "inline-parser"}
                </span>
                <button className="btn-icon" style={{ marginLeft: "auto", padding: 4 }} onClick={handleCopyJson} title="Copy JSON">
                  {copied ? <Check size={12} style={{ color: "var(--neon)" }} /> : <Copy size={12} />}
                </button>
              </div>

              {/* Firewall warning */}
              {result.scraped_data?._note && (
                <div className="info-box warn" style={{ padding: "8px 12px" }}>
                  <AlertTriangle size={12} />
                  <span style={{ fontSize: 11 }}>{result.scraped_data._note}</span>
                </div>
              )}

              {/* Data table */}
              <div className="scraped-data-card">
                {renderScrapedData(result.scraped_data)}
              </div>

              {/* Raw JSON toggle */}
              <details>
                <summary style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--muted)", cursor: "pointer", userSelect: "none" }}>
                  RAW JSON ↓
                </summary>
                <pre className="try-raw-json">{JSON.stringify(result.scraped_data, null, 2)}</pre>
              </details>

              {/* Jadikan API Route */}
              {!createdRoute && (
                <div className="api-route-toggle">
                  <label className="api-route-check-label">
                    <input type="checkbox" checked={makeRoute} onChange={e => setMakeRoute(e.target.checked)} className="api-route-checkbox" />
                    <Route size={13} style={{ color: "var(--neon3)" }} />
                    <span style={{ fontSize: 12, fontWeight: 600 }}>Jadikan API Route</span>
                    <span className="badge badge-purple" style={{ fontSize: 9 }}>auto add</span>
                  </label>
                  <p style={{ fontSize: 11, color: "var(--muted)", marginLeft: 26 }}>
                    Auto add ke <code style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--neon2)" }}>/api/generated/kategori/nama</code>
                  </p>
                  {makeRoute && (
                    <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 8 }}>
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                        <input className="field-input" style={{ flex: 1, minWidth: 100, fontSize: 11 }} placeholder="kategori" value={routeCat} onChange={e => setRouteCat(e.target.value)} />
                        <input className="field-input" style={{ flex: 2, minWidth: 140, fontSize: 11 }} placeholder="nama-route" value={routeName} onChange={e => setRouteName(e.target.value)} />
                      </div>
                      <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--neon2)", background: "rgba(0,0,0,.3)", padding: "5px 10px", borderRadius: 6 }}>
                        GET /api/generated/{routeCat}/{routeName}
                      </div>
                      <button className="btn btn-primary btn-sm" onClick={handleCreateRoute} disabled={routeLoading} style={{ alignSelf: "flex-start" }}>
                        {routeLoading ? <><div className="spinner" style={{ width: 11, height: 11 }} /> Membuat...</> : <><PlusCircle size={11} /> Tambah Route</>}
                      </button>
                    </div>
                  )}
                </div>
              )}

              {createdRoute && (
                <div className="info-box neon">
                  <Route size={13} />
                  <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                    <span style={{ fontWeight: 600, fontSize: 12 }}>Route dibuat! Lihat di API Docs.</span>
                    <code style={{ fontFamily: "var(--mono)", fontSize: 11 }}>{createdRoute.method} {createdRoute.path}</code>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Partial success: has output but maybe blocked */}
          {result && !result.success && result.scraped_data && (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <div className="info-box warn">
                <AlertTriangle size={13} />
                <span style={{ fontSize: 12 }}>Partial data — site memblokir akses langsung</span>
              </div>
              <div className="scraped-data-card">
                {renderScrapedData(result.scraped_data)}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
