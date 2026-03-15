import { useState, useEffect, useRef, useCallback } from "react";
import { X, Eye, CheckSquare, AlertTriangle, Zap, RefreshCw, Layers, MousePointer2 } from "lucide-react";
import { previewHtml } from "../api";

interface PickedElement {
  id: string;
  source: string;
  category: string;
  label: string;
  selector: string;
  itemType: string | null;
  fields: { name: string; value: string; source: string }[];
  rawFields: string[];
  preview: string[];
  count: number;
  target: string;
  priority: number;
}

interface Props {
  url: string;
  onClose: () => void;
  onApply: (elements: PickedElement[]) => void;
}

const SOURCE_COLOR: Record<string, string> = {
  microdata: "var(--neon)",
  visual:    "var(--neon2)",
  dom:       "var(--neon3)",
  itemprop:  "var(--neon)",
  class:     "#a78bfa",
};

export function VisualPickerModal({ url, onClose, onApply }: Props) {
  const [loading,  setLoading]  = useState(true);
  const [error,    setError]    = useState("");
  const [layer,    setLayer]    = useState(0);
  const [picked,   setPicked]   = useState<PickedElement[]>([]);
  const [ready,    setReady]    = useState(false);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  // Listen for postMessages from iframe
  const handleMessage = useCallback((e: MessageEvent) => {
    if (!e.data?.type?.startsWith("__sai_")) return;
    if (e.data.type === "__sai_ready") {
      setReady(true);
      setLoading(false);
    } else if (e.data.type === "__sai_selection") {
      setPicked(e.data.items || []);
    } else if (e.data.type === "__sai_done") {
      onApply(e.data.items || []);
      onClose();
    }
  }, [onApply, onClose]);

  useEffect(() => {
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [handleMessage]);

  // ── Load: gunakan previewHtml LANGSUNG (bukan proxy stream) ──
  // previewHtml sudah inject picker script di server-side.
  // Proxy stream TIDAK inject script sehingga picker tidak bisa aktif.
  const loadHtml = useCallback(async () => {
    if (!url) return;
    setLoading(true);
    setError("");
    setReady(false);
    setPicked([]);

    try {
      const res = await previewHtml(url);
      if (!res.success || !res.html) {
        setError("Tidak bisa mengambil halaman. Coba Scan Elemen biasa.");
        setLoading(false);
        return;
      }
      setLayer(res.layer || 0);
      const iframe = iframeRef.current;
      if (iframe) {
        // srcdoc = content "terpaku" di iframe, tidak bisa navigate keluar
        // picker script sudah ter-inject oleh server di dalam res.html
        iframe.srcdoc = res.html;

        // Fallback timeout: jika __sai_ready belum tiba dalam 8 detik
        const fallback = setTimeout(() => {
          setLoading(false);
          setReady(true);
        }, 8000);

        const onLoad = () => {
          clearTimeout(fallback);
          setTimeout(() => { setLoading(false); setReady(true); }, 500);
        };

        iframe.addEventListener("load", onLoad, { once: true });
        return () => { clearTimeout(fallback); iframe.removeEventListener("load", onLoad); };
      }
    } catch (e: any) {
      setError(e.message || "Gagal memuat halaman");
      setLoading(false);
    }
  }, [url]);

  useEffect(() => { loadHtml(); }, [loadHtml]);

  const handleApply = () => { onApply(picked); onClose(); };
  const removePicked = (id: string) => setPicked(prev => prev.filter(p => p.id !== id));

  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 9999,
      background: "rgba(0,0,0,.9)", display: "flex", flexDirection: "column",
      backdropFilter: "blur(6px)",
    }}>
      {/* Header */}
      <div style={{
        display: "flex", alignItems: "center", gap: 12,
        padding: "10px 18px", borderBottom: "1px solid var(--border2)",
        background: "var(--surface)", flexShrink: 0,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{
            width: 28, height: 28, borderRadius: 7,
            background: "rgba(46,255,168,.1)", border: "1px solid rgba(46,255,168,.2)",
            display: "flex", alignItems: "center", justifyContent: "center",
          }}>
            <MousePointer2 size={13} style={{ color: "var(--neon)" }} />
          </div>
          <div>
            <div style={{ fontFamily: "var(--head)", fontSize: 13, fontWeight: 700, color: "var(--text)", lineHeight: 1.2 }}>
              Visual Element Picker
            </div>
            <div style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--muted)", letterSpacing: ".5px" }}>
              KLIK ELEMEN DI HALAMAN UNTUK MEMILIH
            </div>
          </div>
        </div>
        <span style={{
          fontFamily: "var(--mono)", fontSize: 10, color: "var(--text2)", flex: 1,
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          background: "rgba(0,0,0,.35)", padding: "4px 10px", borderRadius: 6, border: "1px solid var(--border)",
        }}>
          {url}
        </span>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          {layer > 0 && (
            <span style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--neon2)", background: "rgba(0,194,255,.08)", padding: "3px 8px", borderRadius: 5, border: "1px solid rgba(0,194,255,.2)", display: "flex", alignItems: "center", gap: 4 }}>
              <Layers size={9} /> L{layer}
            </span>
          )}
          {ready && !loading && (
            <span style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--neon)", background: "rgba(46,255,168,.08)", padding: "3px 9px", borderRadius: 5, border: "1px solid rgba(46,255,168,.2)", display: "flex", alignItems: "center", gap: 5 }}>
              <span style={{ width: 5, height: 5, borderRadius: "50%", background: "var(--neon)", flexShrink: 0 }} />
              AKTIF
            </span>
          )}
          <button onClick={() => loadHtml()} disabled={loading}
            style={{ background: "transparent", border: "1px solid var(--border)", color: "var(--muted)", padding: "5px 8px", borderRadius: 6, cursor: "pointer", display: "flex" }}
            title="Reload">
            <RefreshCw size={13} />
          </button>
          <button onClick={onClose} style={{ background: "rgba(255,69,96,.08)", border: "1px solid rgba(255,69,96,.2)", cursor: "pointer", color: "var(--danger)", padding: "5px 9px", borderRadius: 6, display: "flex" }}>
            <X size={14} />
          </button>
        </div>
      </div>

      {/* Instructions */}
      <div style={{
        padding: "6px 18px", background: "rgba(46,255,168,.02)",
        borderBottom: "1px solid var(--border)", flexShrink: 0,
        display: "flex", alignItems: "center", gap: 18, flexWrap: "wrap",
      }}>
        {[["Hover","highlight"],["Klik","pilih / batalkan"],["Selesai","kirim ke generator"]].map(([k,d]) => (
          <span key={k} style={{ fontSize: 11, color: "var(--text2)", display: "flex", alignItems: "center", gap: 5 }}>
            <kbd style={{ fontFamily: "var(--mono)", fontSize: 9, padding: "2px 6px", borderRadius: 4, background: "rgba(0,0,0,.4)", border: "1px solid var(--border2)", color: "var(--neon2)" }}>{k}</kbd>
            <span style={{ color: "var(--muted)" }}>{d}</span>
          </span>
        ))}
      </div>

      <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
        {/* Iframe */}
        <div style={{ flex: 1, position: "relative", background: "#fff" }}>
          {loading && (
            <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 14, background: "var(--bg)", zIndex: 10 }}>
              <div style={{ position: "relative" }}>
                <div className="spinner spinner-lg" />
                <Eye size={14} style={{ position: "absolute", top: "50%", left: "50%", transform: "translate(-50%,-50%)", color: "var(--neon)", opacity: .7 }} />
              </div>
              <div style={{ textAlign: "center" }}>
                <div style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--text)", marginBottom: 4 }}>Mengambil HTML + inject picker...</div>
                <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--muted)" }}>bypass 6 layer aktif</div>
              </div>
            </div>
          )}
          {error && (
            <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 14, background: "var(--bg)", zIndex: 10, padding: 32 }}>
              <AlertTriangle size={28} style={{ color: "var(--warn)" }} />
              <div style={{ textAlign: "center" }}>
                <div style={{ fontSize: 13, color: "var(--warn)", marginBottom: 6, fontWeight: 600 }}>{error}</div>
                <div style={{ fontSize: 11, color: "var(--muted)", lineHeight: 1.65 }}>
                  Gunakan <b style={{ color: "var(--text2)" }}>Scan Elemen</b> sebagai alternatif.
                </div>
              </div>
              <button className="btn btn-secondary btn-sm" onClick={() => loadHtml()}>
                <RefreshCw size={12} /> Coba Lagi
              </button>
            </div>
          )}
          <iframe
            ref={iframeRef}
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
            style={{ width: "100%", height: "100%", border: "none", display: loading || error ? "none" : "block" }}
            title="visual-picker"
          />
        </div>

        {/* Right panel */}
        <div style={{
          width: 280, flexShrink: 0, borderLeft: "1px solid var(--border2)",
          background: "var(--surface)", display: "flex", flexDirection: "column", overflow: "hidden",
        }}>
          <div style={{ padding: "10px 14px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", gap: 7 }}>
            <CheckSquare size={11} style={{ color: "var(--neon)" }} />
            <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--text2)", textTransform: "uppercase", letterSpacing: 1 }}>
              Dipilih
            </span>
            {picked.length > 0 && (
              <span style={{ fontFamily: "var(--mono)", fontSize: 9, padding: "1px 7px", borderRadius: 10, background: "rgba(46,255,168,.12)", border: "1px solid rgba(46,255,168,.25)", color: "var(--neon)" }}>
                {picked.length}
              </span>
            )}
            {picked.length > 0 && (
              <button onClick={() => setPicked([])} style={{ marginLeft: "auto", background: "none", border: "none", color: "var(--muted)", cursor: "pointer", fontSize: 10, fontFamily: "var(--mono)" }}>
                clear
              </button>
            )}
          </div>

          <div style={{ flex: 1, overflowY: "auto", padding: "8px 10px", display: "flex", flexDirection: "column", gap: 6 }}>
            {picked.length === 0 ? (
              <div style={{ padding: "24px 12px", textAlign: "center" }}>
                <MousePointer2 size={26} style={{ color: "var(--muted)", opacity: .4, marginBottom: 10 }} />
                <p style={{ fontSize: 11, color: "var(--muted)", lineHeight: 1.65 }}>
                  Klik elemen di halaman kiri.<br />Selector otomatis ter-generate.
                </p>
              </div>
            ) : picked.map((el) => {
              const pag = (el as any).pagination;
              const color = SOURCE_COLOR[el.source] || "var(--neon)";
              return (
                <div key={el.id} style={{ background: "rgba(46,255,168,.04)", border: "1px solid rgba(46,255,168,.18)", borderRadius: 9, padding: "9px 11px", position: "relative" }}>
                  <button onClick={() => removePicked(el.id)} style={{ position: "absolute", top: 7, right: 7, background: "none", border: "none", cursor: "pointer", color: "var(--muted)", padding: 2, lineHeight: 1 }}>
                    <X size={10} />
                  </button>
                  <div style={{ display: "flex", alignItems: "center", gap: 5, marginBottom: 5, flexWrap: "wrap", paddingRight: 16 }}>
                    <span style={{ fontFamily: "var(--mono)", fontSize: 8, padding: "2px 6px", borderRadius: 4, background: "rgba(0,0,0,.35)", color, border: "1px solid rgba(0,0,0,.5)", textTransform: "uppercase", letterSpacing: ".5px" }}>
                      {el.source}
                    </span>
                    <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--neon)", fontWeight: 700 }}>{el.count}×</span>
                    {el.itemType && <span style={{ fontFamily: "var(--mono)", fontSize: 8, color: "var(--neon3)", padding: "2px 5px", borderRadius: 4, background: "rgba(176,111,255,.08)", border: "1px solid rgba(176,111,255,.2)" }}>{el.itemType}</span>}
                    {pag?.found && (
                      <span style={{ fontFamily: "var(--mono)", fontSize: 8, padding: "2px 6px", borderRadius: 4, background: "rgba(0,194,255,.1)", color: "var(--neon2)", border: "1px solid rgba(0,194,255,.25)" }}>
                        {pag.type === "infinite_scroll" ? "∞ scroll" : pag.totalPages ? pag.totalPages + " hal." : "paginasi"}
                      </span>
                    )}
                  </div>
                  <code style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--text)", display: "block", marginBottom: 5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", background: "rgba(0,0,0,.35)", padding: "3px 7px", borderRadius: 5, border: "1px solid var(--border)" }}>
                    {el.selector}
                  </code>
                  {el.rawFields.length > 0 && (
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 3 }}>
                      {el.rawFields.slice(0, 6).map((f: string) => (
                        <span key={f} style={{ fontFamily: "var(--mono)", fontSize: 8, padding: "2px 5px", borderRadius: 3, background: "rgba(0,0,0,.4)", border: "1px solid var(--border2)", color: "var(--text2)" }}>{f}</span>
                      ))}
                      {el.rawFields.length > 6 && <span style={{ fontFamily: "var(--mono)", fontSize: 8, color: "var(--muted)", padding: "2px 4px" }}>+{el.rawFields.length - 6}</span>}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <div style={{ padding: "12px 14px", borderTop: "1px solid var(--border)", flexShrink: 0, display: "flex", flexDirection: "column", gap: 7 }}>
            <button className="btn btn-primary" style={{ width: "100%" }} disabled={picked.length === 0} onClick={handleApply}>
              <Zap size={14} /> Pakai {picked.length} Elemen
            </button>
            <button className="btn btn-secondary btn-sm" style={{ width: "100%" }} onClick={onClose}>
              Batal
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
