import { useState, useEffect, useRef, useCallback } from "react";
import {
  X, Eye, CheckSquare, AlertTriangle, Zap, RefreshCw,
  Layers, MousePointer2, LayoutGrid, ChevronDown, ChevronUp,
  Globe, Package, Search,
} from "lucide-react";
import { previewHtml, prefetchUrl } from "../api";
import type { PrefetchElement, PrefetchResult } from "../types";

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

const SRC_CLR: Record<string, string> = {
  microdata: "var(--neon)", visual: "var(--neon2)",
  dom: "var(--neon3)", itemprop: "var(--neon)", class: "#a78bfa",
};

const CAT_ICON: Record<string, string> = {
  movie:"🎬", tvseries:"📺", videoobject:"▶️", product:"🛍️",
  article:"📰", newsarticle:"📰", blogposting:"📝", person:"👤",
  organization:"🏢", review:"⭐", film_video:"🎬", produk:"🛍️",
  media:"📺", artikel:"📰", card:"📦", field:"🔧",
  search_form:"🔍", pagination:"📄", navigation:"🗂️",
  structured:"🗄️", meta:"🏷️",
};

type Mode = "iframe" | "cards";

export function VisualPickerModal({ url, onClose, onApply }: Props) {
  // ── State ──────────────────────────────────────────────────
  const [mode,       setMode]       = useState<Mode>("iframe");
  const [loading,    setLoading]    = useState(true);
  const [error,      setError]      = useState("");
  const [layer,      setLayer]      = useState(0);
  const [ready,      setReady]      = useState(false);
  const [picked,     setPicked]     = useState<PickedElement[]>([]);

  // Card fallback state
  const [scanning,      setScanning]      = useState(false);
  const [scanResult,    setScanResult]    = useState<PrefetchResult | null>(null);
  const [activeCategory,setActiveCategory]= useState<string | null>(null);
  const [checkedCards,  setCheckedCards]  = useState<Record<string, boolean>>({});
  const [cardSearch,    setCardSearch]    = useState("");

  const iframeRef = useRef<HTMLIFrameElement>(null);

  // ── iframe message listener ─────────────────────────────────
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

  // ── Load iframe via previewHtml ─────────────────────────────
  // previewHtml fetches HTML server-side (6-layer bypass) dan
  // inject picker script dengan OVERLAY TRICK — menembus semua z-index.
  const loadIframe = useCallback(async () => {
    if (!url) return;
    setLoading(true);
    setError("");
    setReady(false);

    try {
      const res = await previewHtml(url);
      if (!res.success || !res.html) {
        setError("Tidak bisa mengambil halaman ini.");
        setLoading(false);
        return;
      }
      setLayer(res.layer || 0);
      const iframe = iframeRef.current;
      if (iframe) {
        iframe.srcdoc = res.html;

        // Fallback: jika __sai_ready tidak datang dalam 10s, anggap loaded
        const fallback = setTimeout(() => {
          setLoading(false);
          setReady(true);
        }, 10000);

        const onLoad = () => {
          clearTimeout(fallback);
          setTimeout(() => { setLoading(false); setReady(true); }, 300);
        };
        iframe.addEventListener("load", onLoad, { once: true });
        return () => { clearTimeout(fallback); iframe.removeEventListener("load", onLoad); };
      }
    } catch (e: any) {
      setError(e.message || "Gagal memuat halaman");
      setLoading(false);
    }
  }, [url]);

  useEffect(() => { loadIframe(); }, [loadIframe]);

  // ── Load card fallback via prefetch ─────────────────────────
  const loadCards = useCallback(async () => {
    if (scanResult) {
      // Sudah ada data, cukup switch mode
      setMode("cards");
      return;
    }
    setScanning(true);
    try {
      const res = await prefetchUrl(url);
      setScanResult(res);
      if (res.elements?.length > 0) {
        setActiveCategory(res.elements[0].category);
      }
    } catch (e: any) {
      // silent
    } finally {
      setScanning(false);
      setMode("cards");
    }
  }, [url, scanResult]);

  // ── Card toggle ─────────────────────────────────────────────
  const toggleCard = (el: PrefetchElement, globalIdx: string) => {
    setCheckedCards(prev => {
      const next = { ...prev, [globalIdx]: !prev[globalIdx] };
      // Build picked from checked cards
      if (scanResult) {
        const newPicked: PickedElement[] = scanResult.elements
          .filter((_, i) => next[String(i)])
          .map((e, i) => ({
            id: `card_${i}_${Date.now()}`,
            source: e.source || "dom",
            category: e.category,
            label: e.label,
            selector: e.selector,
            itemType: (e as any).itemType || null,
            fields: e.fields || [],
            rawFields: e.rawFields || [],
            preview: e.preview || [],
            count: e.count || 0,
            target: e.target,
            priority: e.priority || 0,
          }));
        setPicked(newPicked);
      }
      return next;
    });
  };

  // ── Apply ───────────────────────────────────────────────────
  const handleApply = () => { onApply(picked); onClose(); };
  const removePicked = (id: string) => {
    setPicked(prev => prev.filter(p => p.id !== id));
    // Uncheck in card mode too
    if (scanResult) {
      const newChecked = { ...checkedCards };
      scanResult.elements.forEach((e, i) => {
        const found = picked.find(p => p.id === `card_${i}_${Date.now()}` || p.selector === e.selector);
        if (found?.id === id) delete newChecked[String(i)];
      });
      setCheckedCards(newChecked);
    }
  };

  // ── Grouped categories for card mode ───────────────────────
  const byCategory = scanResult
    ? (scanResult.categories || []).reduce((acc, cat) => {
        acc[cat] = (scanResult.elements || []).filter(e => e.category === cat);
        return acc;
      }, {} as Record<string, PrefetchElement[]>)
    : {};

  const filteredCatElements = (activeCategory && byCategory[activeCategory])
    ? byCategory[activeCategory].filter(el =>
        !cardSearch ||
        el.label.toLowerCase().includes(cardSearch) ||
        el.selector.toLowerCase().includes(cardSearch) ||
        (el.target || "").toLowerCase().includes(cardSearch)
      )
    : [];

  // ────────────────────────────────────────────────────────────
  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 9999,
      background: "rgba(0,0,0,.92)", display: "flex", flexDirection: "column",
      backdropFilter: "blur(8px)",
    }}>
      {/* ── Header ─────────────────────────────────────────── */}
      <div style={{
        display: "flex", alignItems: "center", gap: 12, padding: "10px 18px",
        borderBottom: "1px solid var(--border2)", background: "var(--surface)", flexShrink: 0,
      }}>
        {/* Logo */}
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{ width: 30, height: 30, borderRadius: 8, background: "rgba(46,255,168,.1)", border: "1px solid rgba(46,255,168,.25)", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <MousePointer2 size={14} style={{ color: "var(--neon)" }} />
          </div>
          <div>
            <div style={{ fontFamily: "var(--head)", fontSize: 13, fontWeight: 700, color: "var(--text)", lineHeight: 1.2 }}>Visual Element Picker</div>
            <div style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--muted)", letterSpacing: ".5px" }}>KLIK ELEMEN UNTUK MEMILIH</div>
          </div>
        </div>

        {/* URL */}
        <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--text2)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", background: "rgba(0,0,0,.3)", padding: "4px 10px", borderRadius: 6, border: "1px solid var(--border)" }}>
          <Globe size={9} style={{ display: "inline", marginRight: 5, opacity: .5 }} />
          {url}
        </span>

        {/* Mode switcher */}
        <div style={{ display: "flex", border: "1px solid var(--border2)", borderRadius: 8, overflow: "hidden", flexShrink: 0 }}>
          <button
            onClick={() => setMode("iframe")}
            style={{ padding: "5px 12px", background: mode === "iframe" ? "rgba(46,255,168,.12)" : "transparent", border: "none", cursor: "pointer", color: mode === "iframe" ? "var(--neon)" : "var(--muted)", fontFamily: "var(--mono)", fontSize: 10, display: "flex", alignItems: "center", gap: 5, borderRight: "1px solid var(--border2)" }}
          >
            <Eye size={11} /> Live
          </button>
          <button
            onClick={() => loadCards()}
            style={{ padding: "5px 12px", background: mode === "cards" ? "rgba(46,255,168,.12)" : "transparent", border: "none", cursor: "pointer", color: mode === "cards" ? "var(--neon)" : "var(--muted)", fontFamily: "var(--mono)", fontSize: 10, display: "flex", alignItems: "center", gap: 5 }}
          >
            <LayoutGrid size={11} /> {scanning ? "..." : "Scan"}
          </button>
        </div>

        {/* Status badges */}
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          {layer > 0 && mode === "iframe" && (
            <span style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--neon2)", background: "rgba(0,194,255,.07)", padding: "3px 8px", borderRadius: 5, border: "1px solid rgba(0,194,255,.2)", display: "flex", alignItems: "center", gap: 4 }}>
              <Layers size={9} /> L{layer}
            </span>
          )}
          {ready && mode === "iframe" && !loading && (
            <span style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--neon)", background: "rgba(46,255,168,.07)", padding: "3px 8px", borderRadius: 5, border: "1px solid rgba(46,255,168,.2)", display: "flex", alignItems: "center", gap: 5 }}>
              <span style={{ width: 5, height: 5, borderRadius: "50%", background: "var(--neon)", flexShrink: 0 }} />
              AKTIF
            </span>
          )}
          <button
            onClick={() => { setLoading(true); setError(""); setReady(false); loadIframe(); setMode("iframe"); }}
            disabled={loading}
            style={{ background: "transparent", border: "1px solid var(--border)", color: "var(--muted)", padding: "5px 8px", borderRadius: 6, cursor: "pointer", display: "flex" }}
            title="Reload iframe"
          >
            <RefreshCw size={13} />
          </button>
          <button onClick={onClose} style={{ background: "rgba(255,69,96,.07)", border: "1px solid rgba(255,69,96,.2)", cursor: "pointer", color: "var(--danger)", padding: "5px 9px", borderRadius: 6, display: "flex" }}>
            <X size={14} />
          </button>
        </div>
      </div>

      {/* ── Instruction bar ─────────────────────────────────── */}
      <div style={{ padding: "5px 18px", background: "rgba(46,255,168,.02)", borderBottom: "1px solid var(--border)", flexShrink: 0, display: "flex", alignItems: "center", gap: 18, flexWrap: "wrap" }}>
        {mode === "iframe" ? (
          <>
            {[["Hover","highlight elemen"],["Klik","pilih / batalkan"],["Selesai","kirim ke generator"]].map(([k,d]) => (
              <span key={k} style={{ fontSize: 11, color: "var(--text2)", display: "flex", alignItems: "center", gap: 5 }}>
                <kbd style={{ fontFamily: "var(--mono)", fontSize: 9, padding: "2px 6px", borderRadius: 4, background: "rgba(0,0,0,.4)", border: "1px solid var(--border2)", color: "var(--neon2)" }}>{k}</kbd>
                <span style={{ color: "var(--muted)" }}>{d}</span>
              </span>
            ))}
            <span style={{ marginLeft: "auto", fontFamily: "var(--mono)", fontSize: 9, color: "var(--muted)" }}>
              overlay mode — menembus semua z-index
            </span>
          </>
        ) : (
          <span style={{ fontSize: 11, color: "var(--text2)" }}>
            <b>Mode Scan</b> — klik card elemen untuk pilih. Gunakan jika Live mode gagal.
          </span>
        )}
      </div>

      <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
        {/* ── Main area ─────────────────────────────────────── */}
        <div style={{ flex: 1, position: "relative", overflow: "hidden" }}>

          {/* ─ IFRAME MODE ──────────────────────────────────── */}
          {mode === "iframe" && (
            <>
              {loading && (
                <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 16, background: "var(--bg)", zIndex: 10 }}>
                  <div style={{ position: "relative" }}>
                    <div className="spinner spinner-lg" />
                    <Eye size={14} style={{ position: "absolute", top: "50%", left: "50%", transform: "translate(-50%,-50%)", color: "var(--neon)", opacity: .7 }} />
                  </div>
                  <div style={{ textAlign: "center" }}>
                    <div style={{ fontFamily: "var(--mono)", fontSize: 13, color: "var(--text)", marginBottom: 5 }}>Mengambil HTML + inject picker...</div>
                    <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--muted)" }}>bypass 6 layer · overlay trick aktif</div>
                  </div>
                </div>
              )}
              {error && !loading && (
                <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 14, background: "var(--bg)", zIndex: 10, padding: 32 }}>
                  <div style={{ width: 52, height: 52, borderRadius: 14, background: "rgba(255,184,48,.07)", border: "1px solid rgba(255,184,48,.2)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                    <AlertTriangle size={22} style={{ color: "var(--warn)" }} />
                  </div>
                  <div style={{ textAlign: "center" }}>
                    <div style={{ fontSize: 13, color: "var(--warn)", marginBottom: 8, fontWeight: 600 }}>{error}</div>
                    <div style={{ fontSize: 12, color: "var(--muted)", lineHeight: 1.7 }}>
                      Site ini memblokir akses server-side.<br />
                      Gunakan <b style={{ color: "var(--text2)" }}>mode Scan</b> sebagai fallback yang 100% reliable.
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 8 }}>
                    <button className="btn btn-secondary btn-sm" onClick={() => { setLoading(true); setError(""); loadIframe(); }}>
                      <RefreshCw size={12} /> Retry
                    </button>
                    <button className="btn btn-primary btn-sm" onClick={() => loadCards()}>
                      <LayoutGrid size={12} /> Gunakan Scan Mode
                    </button>
                  </div>
                </div>
              )}
              <iframe
                ref={iframeRef}
                sandbox="allow-scripts allow-same-origin allow-forms"
                style={{ width: "100%", height: "100%", border: "none", display: loading || error ? "none" : "block", background: "#fff" }}
                title="visual-picker"
              />
            </>
          )}

          {/* ─ CARD MODE (fallback) ──────────────────────────── */}
          {mode === "cards" && (
            <div style={{ display: "flex", height: "100%", background: "var(--bg)" }}>
              {scanning ? (
                <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 14 }}>
                  <div className="spinner spinner-lg" />
                  <span style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--text2)" }}>Scanning elemen...</span>
                </div>
              ) : !scanResult ? (
                <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 14 }}>
                  <LayoutGrid size={36} style={{ color: "var(--muted)", opacity: .4 }} />
                  <div style={{ textAlign: "center" }}>
                    <div style={{ fontSize: 13, color: "var(--text2)", marginBottom: 8 }}>Scan belum dijalankan</div>
                    <button className="btn btn-primary btn-sm" onClick={() => loadCards()}>
                      <Package size={13} /> Mulai Scan
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  {/* Site info bar */}
                  <div style={{ position: "absolute", top: 0, left: 0, right: 0, background: "rgba(0,0,0,.6)", backdropFilter: "blur(4px)", borderBottom: "1px solid var(--border)", padding: "8px 14px", display: "flex", gap: 10, alignItems: "center", zIndex: 5, flexWrap: "wrap" }}>
                    <Globe size={11} style={{ color: "var(--muted)" }} />
                    <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--neon2)" }}>{scanResult.host}</span>
                    {scanResult.title && <span style={{ fontSize: 11, color: "var(--text2)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 200 }}>{scanResult.title}</span>}
                    <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--muted)", marginLeft: "auto" }}>{scanResult.elementCount} elemen · L{scanResult.layer}</span>
                  </div>

                  {/* Category sidebar */}
                  <div style={{ width: 160, flexShrink: 0, borderRight: "1px solid var(--border)", paddingTop: 52, overflowY: "auto", background: "var(--surface)" }}>
                    <div style={{ padding: "8px 8px 4px", fontFamily: "var(--mono)", fontSize: 8, color: "var(--muted)", textTransform: "uppercase", letterSpacing: 2 }}>Kategori</div>
                    {Object.keys(byCategory).map(cat => {
                      const items = byCategory[cat];
                      const nChecked = items.filter((el) => {
                        const gi = scanResult.elements.indexOf(el);
                        return checkedCards[String(gi)];
                      }).length;
                      return (
                        <button key={cat} onClick={() => setActiveCategory(cat)} style={{ display: "flex", alignItems: "center", gap: 7, padding: "7px 10px", borderRadius: 0, background: activeCategory === cat ? "rgba(46,255,168,.07)" : "transparent", borderLeft: activeCategory === cat ? "2px solid var(--neon)" : "2px solid transparent", cursor: "pointer", textAlign: "left", width: "100%", border: "none", borderLeft: activeCategory === cat ? "2px solid var(--neon)" : "2px solid transparent" }}>
                          <span style={{ fontSize: 12 }}>{CAT_ICON[cat] || "📋"}</span>
                          <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: activeCategory === cat ? "var(--neon)" : "var(--text2)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{cat}</span>
                          <span style={{ fontFamily: "var(--mono)", fontSize: 9, color: nChecked > 0 ? "var(--neon)" : "var(--muted)" }}>
                            {nChecked > 0 ? `${nChecked}/` : ""}{items.length}
                          </span>
                        </button>
                      );
                    })}
                  </div>

                  {/* Elements list */}
                  <div style={{ flex: 1, paddingTop: 52, overflow: "hidden", display: "flex", flexDirection: "column" }}>
                    {/* Search */}
                    <div style={{ padding: "8px 12px", borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, background: "rgba(0,0,0,.3)", border: "1px solid var(--border2)", borderRadius: 7, padding: "6px 10px" }}>
                        <Search size={11} style={{ color: "var(--muted)", flexShrink: 0 }} />
                        <input
                          value={cardSearch}
                          onChange={e => setCardSearch(e.target.value.toLowerCase())}
                          placeholder="Filter elemen..."
                          style={{ background: "none", border: "none", outline: "none", color: "var(--text)", fontFamily: "var(--mono)", fontSize: 11, flex: 1 }}
                        />
                      </div>
                    </div>

                    <div style={{ flex: 1, overflowY: "auto", padding: "10px 12px", display: "flex", flexDirection: "column", gap: 7 }}>
                      {filteredCatElements.length === 0 ? (
                        <div style={{ color: "var(--muted)", fontSize: 12, padding: 20, textAlign: "center" }}>
                          {activeCategory ? "Tidak ada elemen" : "Pilih kategori di kiri"}
                        </div>
                      ) : filteredCatElements.map((el) => {
                        const globalIdx = String(scanResult.elements.indexOf(el));
                        const isChecked = !!checkedCards[globalIdx];
                        return (
                          <div
                            key={globalIdx}
                            onClick={() => toggleCard(el, globalIdx)}
                            style={{
                              display: "flex", gap: 10, alignItems: "flex-start",
                              padding: "10px 12px", borderRadius: 9, cursor: "pointer",
                              background: isChecked ? "rgba(46,255,168,.06)" : "rgba(0,0,0,.3)",
                              border: `1px solid ${isChecked ? "rgba(46,255,168,.3)" : "var(--border)"}`,
                              transition: "all .15s",
                            }}
                          >
                            <div style={{ width: 15, height: 15, borderRadius: 4, border: `2px solid ${isChecked ? "var(--neon)" : "var(--border2)"}`, background: isChecked ? "var(--neon)" : "transparent", flexShrink: 0, marginTop: 1, display: "flex", alignItems: "center", justifyContent: "center" }}>
                              {isChecked && <span style={{ color: "#000", fontSize: 9, fontWeight: 700 }}>✓</span>}
                            </div>
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 4, flexWrap: "wrap" }}>
                                <span style={{ fontFamily: "var(--mono)", fontSize: 11, fontWeight: 600, color: isChecked ? "var(--neon)" : "var(--text)" }}>{el.label}</span>
                                <code style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--muted)", background: "rgba(0,0,0,.4)", padding: "1px 6px", borderRadius: 3 }}>
                                  {el.selector.length > 28 ? el.selector.substring(0, 28) + "…" : el.selector}
                                </code>
                                <span style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--neon)", marginLeft: "auto" }}>{el.count}×</span>
                              </div>
                              <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                                {(el.preview || []).slice(0, 2).map((p, pi) => (
                                  <div key={pi} style={{ fontSize: 10.5, color: "var(--text2)", fontFamily: "var(--mono)", lineHeight: 1.4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", paddingLeft: 6, borderLeft: "2px solid var(--border2)" }}>
                                    {p}
                                  </div>
                                ))}
                              </div>
                              {(el.rawFields || []).length > 0 && (
                                <div style={{ display: "flex", flexWrap: "wrap", gap: 3, marginTop: 5 }}>
                                  {(el.rawFields || []).slice(0, 5).map((f: string) => (
                                    <span key={f} style={{ fontFamily: "var(--mono)", fontSize: 8, padding: "2px 5px", borderRadius: 3, background: "rgba(0,0,0,.4)", border: "1px solid var(--border2)", color: "var(--text2)" }}>{f}</span>
                                  ))}
                                </div>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </>
              )}
            </div>
          )}
        </div>

        {/* ── Right panel: selected elements ─────────────────── */}
        <div style={{ width: 270, flexShrink: 0, borderLeft: "1px solid var(--border2)", background: "var(--surface)", display: "flex", flexDirection: "column", overflow: "hidden" }}>
          {/* Header */}
          <div style={{ padding: "10px 14px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", gap: 7 }}>
            <CheckSquare size={11} style={{ color: "var(--neon)" }} />
            <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--text2)", textTransform: "uppercase", letterSpacing: 1 }}>Dipilih</span>
            {picked.length > 0 && (
              <span style={{ fontFamily: "var(--mono)", fontSize: 9, padding: "1px 7px", borderRadius: 10, background: "rgba(46,255,168,.12)", border: "1px solid rgba(46,255,168,.25)", color: "var(--neon)" }}>
                {picked.length}
              </span>
            )}
            {picked.length > 0 && (
              <button onClick={() => { setPicked([]); setCheckedCards({}); }} style={{ marginLeft: "auto", background: "none", border: "none", color: "var(--muted)", cursor: "pointer", fontSize: 10, fontFamily: "var(--mono)" }}>
                clear
              </button>
            )}
          </div>

          {/* Elements */}
          <div style={{ flex: 1, overflowY: "auto", padding: "8px 10px", display: "flex", flexDirection: "column", gap: 6 }}>
            {picked.length === 0 ? (
              <div style={{ padding: "24px 12px", textAlign: "center" }}>
                <MousePointer2 size={26} style={{ color: "var(--muted)", opacity: .35, marginBottom: 10 }} />
                <p style={{ fontSize: 11, color: "var(--muted)", lineHeight: 1.7 }}>
                  {mode === "iframe"
                    ? "Klik elemen di halaman kiri."
                    : "Klik card elemen di tengah."}
                  <br />Selector otomatis ter-generate.
                </p>
              </div>
            ) : picked.map((el) => {
              const color = SRC_CLR[el.source] || "var(--neon)";
              return (
                <div key={el.id} style={{ background: "rgba(46,255,168,.04)", border: "1px solid rgba(46,255,168,.18)", borderRadius: 9, padding: "9px 11px", position: "relative" }}>
                  <button onClick={() => removePicked(el.id)} style={{ position: "absolute", top: 7, right: 7, background: "none", border: "none", cursor: "pointer", color: "var(--muted)", padding: 2, lineHeight: 1 }}>
                    <X size={10} />
                  </button>
                  <div style={{ display: "flex", alignItems: "center", gap: 5, marginBottom: 5, flexWrap: "wrap", paddingRight: 16 }}>
                    <span style={{ fontFamily: "var(--mono)", fontSize: 8, padding: "2px 6px", borderRadius: 4, background: "rgba(0,0,0,.35)", color, textTransform: "uppercase", letterSpacing: ".5px" }}>{el.source}</span>
                    <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--neon)", fontWeight: 700 }}>{el.count}×</span>
                    {el.itemType && <span style={{ fontFamily: "var(--mono)", fontSize: 8, color: "var(--neon3)", padding: "2px 5px", borderRadius: 4, background: "rgba(176,111,255,.08)", border: "1px solid rgba(176,111,255,.2)" }}>{el.itemType}</span>}
                  </div>
                  <code style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--text)", display: "block", marginBottom: 5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", background: "rgba(0,0,0,.35)", padding: "3px 7px", borderRadius: 5, border: "1px solid var(--border)" }}>
                    {el.selector}
                  </code>
                  {el.rawFields.length > 0 && (
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 3 }}>
                      {el.rawFields.slice(0, 5).map((f: string) => (
                        <span key={f} style={{ fontFamily: "var(--mono)", fontSize: 8, padding: "2px 5px", borderRadius: 3, background: "rgba(0,0,0,.4)", border: "1px solid var(--border2)", color: "var(--text2)" }}>{f}</span>
                      ))}
                      {el.rawFields.length > 5 && <span style={{ fontFamily: "var(--mono)", fontSize: 8, color: "var(--muted)", padding: "2px 4px" }}>+{el.rawFields.length - 5}</span>}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Apply */}
          <div style={{ padding: "12px 14px", borderTop: "1px solid var(--border)", flexShrink: 0, display: "flex", flexDirection: "column", gap: 7 }}>
            <button className="btn btn-primary" style={{ width: "100%" }} disabled={picked.length === 0} onClick={handleApply}>
              <Zap size={14} /> Pakai {picked.length} Elemen
            </button>
            <button className="btn btn-secondary btn-sm" style={{ width: "100%" }} onClick={onClose}>Batal</button>
          </div>
        </div>
      </div>
    </div>
  );
}
