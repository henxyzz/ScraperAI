import { useState, useEffect, useRef, useCallback } from "react";
import { X, Loader, Eye, CheckSquare, AlertTriangle, Zap } from "lucide-react";
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

  useEffect(() => {
    if (!url) return;
    setLoading(true); setError(""); setReady(false); setPicked([]);

    // Mode 1: Coba load via proxy stream (real-time, tanpa putus)
    // iframe src → /api/proxy/stream?url=... (server pipe bytes langsung)
    const proxyUrl = `/api/proxy/stream?url=${encodeURIComponent(url)}`;

    if (iframeRef.current) {
      const iframe = iframeRef.current;

      // Timeout: jika 20 detik belum ready, fallback ke previewHtml
      const timeout = setTimeout(async () => {
        if (!ready) {
          console.log("[VisualPicker] Proxy timeout, fallback ke previewHtml...");
          try {
            const res = await previewHtml(url);
            if (res.success && res.html && iframe) {
              setLayer(res.layer);
              iframe.srcdoc = res.html;
            } else {
              setError("Gagal load halaman. Coba Scan Elemen biasa.");
            }
          } catch (e: any) {
            setError(e.message || "Gagal fetch HTML");
          } finally {
            setLoading(false);
          }
        }
      }, 20000);

      const handleLoad = () => {
        setLoading(false);
        clearTimeout(timeout);
        // Inject picker script setelah iframe load via proxy
        try {
          // Kirim pesan ke iframe untuk inject picker jika belum ada
          iframe.contentWindow?.postMessage({ type: "__sai_inject" }, "*");
        } catch {}
      };

      const handleError = async () => {
        clearTimeout(timeout);
        // Fallback ke previewHtml (srcdoc)
        try {
          const res = await previewHtml(url);
          if (res.success && res.html) {
            setLayer(res.layer);
            iframe.srcdoc = res.html;
          } else {
            setError("Gagal load halaman.");
          }
        } catch (e: any) {
          setError(e.message || "Gagal");
        } finally {
          setLoading(false);
        }
      };

      iframe.addEventListener("load", handleLoad, { once: true });
      iframe.addEventListener("error", handleError, { once: true });
      iframe.src = proxyUrl;

      return () => {
        clearTimeout(timeout);
        iframe.removeEventListener("load", handleLoad);
        iframe.removeEventListener("error", handleError);
      };
    }
  }, [url]);

  const handleApply = () => {
    onApply(picked);
    onClose();
  };

  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 9999,
      background: "rgba(0,0,0,.85)", display: "flex", flexDirection: "column",
      backdropFilter: "blur(4px)",
    }}>
      {/* Header */}
      <div style={{
        display: "flex", alignItems: "center", gap: 12,
        padding: "10px 18px", borderBottom: "1px solid var(--border)",
        background: "var(--bg2)", flexShrink: 0,
      }}>
        <Eye size={16} style={{ color: "var(--neon)" }} />
        <span style={{ fontFamily: "var(--head)", fontSize: 14, fontWeight: 700, color: "var(--text)" }}>
          Visual Element Picker
        </span>
        <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--muted)", flex: 1,
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {url}
        </span>
        {layer > 0 && (
          <span style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--neon2)",
            background: "rgba(46,255,168,.08)", padding: "2px 8px", borderRadius: 4,
            border: "1px solid rgba(46,255,168,.2)" }}>
            Layer {layer}
          </span>
        )}
        {ready && (
          <span style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--neon)",
            background: "rgba(46,255,168,.1)", padding: "2px 8px", borderRadius: 4 }}>
            PICKER AKTIF
          </span>
        )}
        <button onClick={onClose} style={{
          background: "transparent", border: "none", cursor: "pointer",
          color: "var(--muted)", padding: 4, borderRadius: 4,
        }}>
          <X size={16} />
        </button>
      </div>

      {/* Instructions */}
      <div style={{
        padding: "8px 18px", background: "rgba(46,255,168,.04)",
        borderBottom: "1px solid var(--border)", flexShrink: 0,
        display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap",
      }}>
        <span style={{ fontSize: 12, color: "var(--text2)" }}>
          <b>Hover</b> untuk highlight  ·  <b>Klik</b> untuk pilih  ·  Klik lagi untuk deselect
        </span>
        <span style={{ fontSize: 12, color: "var(--muted)" }}>
          Selector otomatis disesuaikan dengan section/konteks elemen
        </span>
      </div>

      <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
        {/* iframe preview */}
        <div style={{ flex: 1, position: "relative", background: "#fff" }}>
          {loading && (
            <div style={{
              position: "absolute", inset: 0, display: "flex", flexDirection: "column",
              alignItems: "center", justifyContent: "center", gap: 12,
              background: "var(--bg)", zIndex: 10,
            }}>
              <div className="spinner spinner-lg" />
              <span style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--text2)" }}>
                Mengambil HTML dengan bypass...
              </span>
              <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--muted)" }}>
                Auto-bypass 6 layer aktif
              </span>
            </div>
          )}
          {error && (
            <div style={{
              position: "absolute", inset: 0, display: "flex", flexDirection: "column",
              alignItems: "center", justifyContent: "center", gap: 12,
              background: "var(--bg)", zIndex: 10,
            }}>
              <AlertTriangle size={32} style={{ color: "var(--warn)" }} />
              <span style={{ fontSize: 13, color: "var(--warn)" }}>{error}</span>
              <span style={{ fontSize: 11, color: "var(--muted)" }}>
                Coba gunakan Scan Elemen biasa untuk site dengan proteksi tinggi
              </span>
            </div>
          )}
          <iframe
            ref={iframeRef}
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
            referrerPolicy="no-referrer"
            style={{
              width: "100%", height: "100%", border: "none",
              display: loading || error ? "none" : "block",
            }}
            title="visual-picker"
          />
        </div>

        {/* Right panel: selected elements */}
        <div style={{
          width: 280, flexShrink: 0, borderLeft: "1px solid var(--border)",
          background: "var(--bg2)", display: "flex", flexDirection: "column",
          overflow: "hidden",
        }}>
          <div style={{
            padding: "10px 14px", borderBottom: "1px solid var(--border)",
            fontFamily: "var(--mono)", fontSize: 10, color: "var(--muted)",
            textTransform: "uppercase", letterSpacing: 1,
            display: "flex", alignItems: "center", gap: 6,
          }}>
            <CheckSquare size={11} style={{ color: "var(--neon)" }} />
            Elemen Dipilih ({picked.length})
          </div>

          <div style={{ flex: 1, overflowY: "auto", padding: "8px 10px", display: "flex", flexDirection: "column", gap: 6 }}>
            {picked.length === 0 ? (
              <div style={{ padding: 16, textAlign: "center" }}>
                <Eye size={24} style={{ color: "var(--muted)", marginBottom: 8 }} />
                <p style={{ fontSize: 11, color: "var(--muted)", lineHeight: 1.6 }}>
                  Klik elemen di preview untuk memilihnya
                </p>
              </div>
            ) : picked.map((el) => {
              const pag = (el as any).pagination;
              return (
              <div key={el.id} style={{
                background: "rgba(46,255,168,.05)", border: "1px solid rgba(46,255,168,.2)",
                borderRadius: 8, padding: "8px 10px",
              }}>
                <div style={{ display: "flex", alignItems: "center", gap: 5, marginBottom: 4, flexWrap: "wrap" }}>
                  <span style={{
                    fontFamily: "var(--mono)", fontSize: 9, padding: "1px 6px",
                    borderRadius: 3, background: "rgba(46,255,168,.15)",
                    color: SOURCE_COLOR[el.source] || "var(--neon)", border: "1px solid rgba(46,255,168,.3)",
                  }}>
                    {el.source}
                  </span>
                  <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--neon)", fontWeight: 700 }}>
                    {el.count}x
                  </span>
                  {pag?.found && (
                    <span style={{
                      fontFamily: "var(--mono)", fontSize: 9, padding: "1px 6px", borderRadius: 3,
                      background: "rgba(0,194,255,.15)", color: "var(--neon2)",
                      border: "1px solid rgba(0,194,255,.3)",
                    }}>
                      {pag.type === "infinite_scroll" ? "infinite" :
                       pag.totalPages ? pag.totalPages + " hal" : "pagination"}
                    </span>
                  )}
                </div>
                <code style={{
                  fontFamily: "var(--mono)", fontSize: 10, color: "var(--text2)",
                  display: "block", marginBottom: 4,
                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                }}>
                  {el.selector}
                </code>
                {pag?.found && pag.nextUrl && (
                  <div style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--muted)", marginBottom: 4,
                    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    next: {pag.nextUrl}
                  </div>
                )}
                <div style={{ display: "flex", flexWrap: "wrap", gap: 3 }}>
                  {el.rawFields.slice(0, 5).map((f: string) => (
                    <span key={f} style={{
                      fontFamily: "var(--mono)", fontSize: 8, padding: "1px 5px",
                      borderRadius: 3, background: "rgba(0,0,0,.3)",
                      border: "1px solid var(--border2)", color: "var(--text2)",
                    }}>{f}</span>
                  ))}
                </div>
              </div>
            );
            })}
          </div>

          {/* Apply button */}
          <div style={{ padding: "12px 14px", borderTop: "1px solid var(--border)", flexShrink: 0 }}>
            <button
              className="btn btn-primary"
              style={{ width: "100%" }}
              disabled={picked.length === 0}
              onClick={handleApply}
            >
              <Zap size={14} />
              Pakai {picked.length} Elemen
            </button>
            <button
              className="btn btn-secondary"
              style={{ width: "100%", marginTop: 6 }}
              onClick={onClose}
            >
              Batal
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
