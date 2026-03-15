import { useState, useEffect, useRef, useCallback } from "react";
import {
  X, Eye, CheckSquare, Zap, RefreshCw, Layers, MousePointer2,
  LayoutGrid, Globe, Search, Sparkles, Loader2, ShieldCheck,
  AlertTriangle, ChevronDown, Package,
} from "lucide-react";
import { previewHtml, prefetchUrl } from "../api";
import { useStore } from "../store";
import type { PrefetchElement, PrefetchResult } from "../types";

interface PickedElement {
  id: string; source: string; category: string; label: string;
  selector: string; itemType: string | null;
  fields: { name: string; value: string; source: string }[];
  rawFields: string[]; preview: string[]; count: number;
  target: string; priority: number;
}
interface AiRec {
  label: string; selector: string; target: string;
  fields: string[]; reason: string; priority: number;
}
interface Props {
  url: string;
  onClose: () => void;
  onApply: (elements: PickedElement[]) => void;
}

const SRC_CLR: Record<string, string> = {
  microdata:"var(--neon)", visual:"var(--neon2)",
  dom:"var(--neon3)", itemprop:"var(--neon)", class:"#a78bfa",
};

type Mode = "iframe" | "cards";

export function VisualPickerModal({ url, onClose, onApply }: Props) {
  const { provider, apiKey, model, addToast } = useStore();

  const [mode,    setMode]    = useState<Mode>("iframe");
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState("");
  const [layer,   setLayer]   = useState(0);
  const [ready,   setReady]   = useState(false);
  const [picked,  setPicked]  = useState<PickedElement[]>([]);

  const [scanning,       setScanning]       = useState(false);
  const [scanResult,     setScanResult]     = useState<PrefetchResult | null>(null);
  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  const [checkedCards,   setCheckedCards]   = useState<Record<string,boolean>>({});
  const [cardSearch,     setCardSearch]     = useState("");

  const [analyzing,   setAnalyzing]   = useState(false);
  const [aiRecs,      setAiRecs]      = useState<AiRec[] | null>(null);
  const [showAiPanel, setShowAiPanel] = useState(false);

  const iframeRef = useRef<HTMLIFrameElement>(null);

  // Parse URL for browser bar display
  let parsedUrl = { origin: url, pathname: "/", hostname: url };
  try { const u = new URL(url); parsedUrl = { origin: u.origin, pathname: u.pathname + u.search, hostname: u.hostname }; } catch {}

  // ── iframe message listener ───────────────────────────────
  const handleMessage = useCallback((e: MessageEvent) => {
    if (!e.data?.type?.startsWith("__sai_")) return;
    if (e.data.type === "__sai_ready") { setReady(true); setLoading(false); }
    else if (e.data.type === "__sai_selection") setPicked(e.data.items || []);
    else if (e.data.type === "__sai_done") { onApply(e.data.items || []); onClose(); }
  }, [onApply, onClose]);

  useEffect(() => {
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [handleMessage]);

  // ── Load iframe ───────────────────────────────────────────
  const loadIframe = useCallback(async () => {
    if (!url) return;
    setLoading(true); setError(""); setReady(false);
    try {
      const res = await previewHtml(url);
      if (!res.success || !res.html) {
        setError("Tidak bisa mengambil halaman ini. Gunakan mode Scan.");
        setLoading(false); return;
      }
      setLayer(res.layer || 0);
      const iframe = iframeRef.current;
      if (iframe) {
        iframe.srcdoc = res.html;
        const fallback = setTimeout(() => { setLoading(false); setReady(true); }, 10000);
        const onLoad = () => { clearTimeout(fallback); setTimeout(() => { setLoading(false); setReady(true); }, 300); };
        iframe.addEventListener("load", onLoad, { once: true });
        return () => { clearTimeout(fallback); iframe.removeEventListener("load", onLoad); };
      }
    } catch (e: any) { setError(e.message || "Gagal memuat halaman"); setLoading(false); }
  }, [url]);

  useEffect(() => { loadIframe(); }, [loadIframe]);

  // ── Load scan fallback ────────────────────────────────────
  const loadCards = useCallback(async () => {
    if (scanResult) { setMode("cards"); return; }
    setScanning(true);
    try {
      const res = await prefetchUrl(url);
      setScanResult(res);
      if (res.elements?.length > 0) setActiveCategory(res.elements[0].category);
    } catch {}
    finally { setScanning(false); setMode("cards"); }
  }, [url, scanResult]);

  // ── AI Analyze ────────────────────────────────────────────
  const handleAnalyzeAI = async () => {
    if (!apiKey.trim()) { addToast("warn", "Masukkan API Key di topbar terlebih dahulu"); return; }
    setAnalyzing(true); setShowAiPanel(true);
    try {
      const res = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, provider, apiKey, model }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || "Analisa gagal");
      // Parse AI suggestions as recommendations
      const recs: AiRec[] = (data.ai?.suggestions || []).map((s: string, i: number) => ({
        label: s.length > 60 ? s.substring(0, 60) + "…" : s,
        selector: data.ai?.css_selectors?.selectors?.[i] || "",
        target: s,
        fields: [],
        reason: data.ai?.scraping_strategy || "",
        priority: 10 - i,
      }));
      setAiRecs(recs);
      addToast("success", `AI merekomendasikan ${recs.length} target scraping`);
    } catch (e: any) {
      addToast("error", e.message || "Analisa AI gagal");
      setShowAiPanel(false);
    } finally { setAnalyzing(false); }
  };

  const applyAiRec = (rec: AiRec) => {
    const el: PickedElement = {
      id: `ai_${Date.now()}`,
      source: "ai",
      category: "ai-recommendation",
      label: rec.label,
      selector: rec.selector,
      itemType: null,
      fields: rec.fields.map(f => ({ name: f, value: "", source: "ai" })),
      rawFields: rec.fields,
      preview: [rec.target],
      count: 0,
      target: rec.target,
      priority: rec.priority,
    };
    setPicked(prev => {
      if (prev.find(p => p.target === rec.target)) return prev.filter(p => p.target !== rec.target);
      return [...prev, el];
    });
  };

  // ── Card toggle ───────────────────────────────────────────
  const toggleCard = (el: PrefetchElement, idx: string) => {
    setCheckedCards(prev => {
      const next = { ...prev, [idx]: !prev[idx] };
      if (scanResult) {
        setPicked(
          scanResult.elements
            .filter((_, i) => next[String(i)])
            .map((e, i) => ({
              id: `card_${i}`, source: e.source || "dom", category: e.category,
              label: e.label, selector: e.selector, itemType: (e as any).itemType || null,
              fields: e.fields || [], rawFields: e.rawFields || [],
              preview: e.preview || [], count: e.count || 0,
              target: e.target, priority: e.priority || 0,
            }))
        );
      }
      return next;
    });
  };

  const handleApply = () => { onApply(picked); onClose(); };
  const removePicked = (id: string) => setPicked(prev => prev.filter(p => p.id !== id));

  const byCategory = scanResult
    ? (scanResult.categories || []).reduce((acc, cat) => {
        acc[cat] = (scanResult.elements || []).filter(e => e.category === cat);
        return acc;
      }, {} as Record<string, PrefetchElement[]>)
    : {};

  const filteredEls = (activeCategory && byCategory[activeCategory])
    ? byCategory[activeCategory].filter(el =>
        !cardSearch || el.label.toLowerCase().includes(cardSearch) || el.selector.toLowerCase().includes(cardSearch)
      )
    : [];

  // ─────────────────────────────────────────────────────────
  return (
    <div style={{ position:"fixed",inset:0,zIndex:9999,background:"rgba(0,0,0,.88)",display:"flex",flexDirection:"column",backdropFilter:"blur(8px)" }}>

      {/* ── BROWSER CHROME (top bar) ─────────────────────── */}
      <div style={{ background:"#1c1f2e",borderBottom:"1px solid #2a2d3e",flexShrink:0,userSelect:"none" }}>

        {/* Tab bar */}
        <div style={{ display:"flex",alignItems:"center",gap:0,padding:"8px 12px 0",background:"#161824" }}>
          {/* Traffic lights */}
          <div style={{ display:"flex",gap:5,marginRight:10,alignItems:"center" }}>
            <div style={{ width:12,height:12,borderRadius:"50%",background:"#ff5f57",border:"1px solid rgba(0,0,0,.2)" }} />
            <div style={{ width:12,height:12,borderRadius:"50%",background:"#febc2e",border:"1px solid rgba(0,0,0,.2)" }} />
            <div style={{ width:12,height:12,borderRadius:"50%",background:"#28c840",border:"1px solid rgba(0,0,0,.2)" }} />
          </div>
          {/* Tab */}
          <div style={{ display:"flex",alignItems:"center",gap:7,background:"#1c1f2e",borderRadius:"6px 6px 0 0",padding:"6px 14px 8px",maxWidth:240,border:"1px solid #2a2d3e",borderBottom:"1px solid #1c1f2e",position:"relative",bottom:-1 }}>
            <Globe size={11} style={{ color:"#7880a0",flexShrink:0 }} />
            <span style={{ fontFamily:"var(--body)",fontSize:11,color:"#c8dae8",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",flex:1 }}>
              {parsedUrl.hostname}
            </span>
            <button onClick={onClose} style={{ background:"none",border:"none",color:"#404660",cursor:"pointer",padding:0,marginLeft:4,display:"flex",flexShrink:0 }}>
              <X size={10} />
            </button>
          </div>
        </div>

        {/* Address bar */}
        <div style={{ display:"flex",alignItems:"center",gap:8,padding:"7px 14px 9px" }}>
          {/* Nav buttons */}
          <div style={{ display:"flex",gap:2 }}>
            {[["←","back"],["→","fwd"],["↻","reload"]].map(([icon,title]) => (
              <button key={title} title={title} style={{ background:"none",border:"none",color:"#404660",cursor:"not-allowed",padding:"3px 5px",borderRadius:4,fontSize:14,lineHeight:1 }}>
                {icon}
              </button>
            ))}
          </div>

          {/* URL bar */}
          <div style={{ flex:1,display:"flex",alignItems:"center",gap:8,background:"rgba(0,0,0,.4)",border:"1px solid #2a2d3e",borderRadius:20,padding:"5px 14px",cursor:"default" }}>
            <ShieldCheck size={11} style={{ color:"#2effa8",flexShrink:0 }} />
            <span style={{ fontFamily:"'JetBrains Mono',monospace",fontSize:11,color:"#7880a0",flexShrink:0 }}>{parsedUrl.origin}</span>
            <span style={{ fontFamily:"'JetBrains Mono',monospace",fontSize:11,color:"#c8dae8",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",flex:1 }}>
              {parsedUrl.pathname !== "/" ? parsedUrl.pathname : ""}
            </span>
            {layer > 0 && <span style={{ fontFamily:"'JetBrains Mono',monospace",fontSize:9,color:"#00c2ff",background:"rgba(0,194,255,.07)",padding:"1px 7px",borderRadius:10,border:"1px solid rgba(0,194,255,.2)",flexShrink:0 }}>
              bypass L{layer}
            </span>}
          </div>

          {/* Right controls */}
          <div style={{ display:"flex",alignItems:"center",gap:5 }}>
            {ready && !loading && mode === "iframe" && (
              <div style={{ display:"flex",alignItems:"center",gap:5,padding:"3px 10px",borderRadius:20,background:"rgba(46,255,168,.07)",border:"1px solid rgba(46,255,168,.2)" }}>
                <span style={{ width:5,height:5,borderRadius:"50%",background:"var(--neon)",flexShrink:0 }} />
                <span style={{ fontFamily:"'JetBrains Mono',monospace",fontSize:9,color:"var(--neon)" }}>PICKER AKTIF</span>
              </div>
            )}

            {/* Mode switcher */}
            <div style={{ display:"flex",border:"1px solid #2a2d3e",borderRadius:7,overflow:"hidden" }}>
              <button onClick={() => setMode("iframe")}
                style={{ padding:"4px 11px",background:mode==="iframe"?"rgba(46,255,168,.1)":"transparent",border:"none",cursor:"pointer",color:mode==="iframe"?"var(--neon)":"#7880a0",fontFamily:"'JetBrains Mono',monospace",fontSize:9,display:"flex",alignItems:"center",gap:4,borderRight:"1px solid #2a2d3e" }}>
                <Eye size={10} /> Live
              </button>
              <button onClick={() => loadCards()}
                style={{ padding:"4px 11px",background:mode==="cards"?"rgba(46,255,168,.1)":"transparent",border:"none",cursor:"pointer",color:mode==="cards"?"var(--neon)":"#7880a0",fontFamily:"'JetBrains Mono',monospace",fontSize:9,display:"flex",alignItems:"center",gap:4 }}>
                <LayoutGrid size={10} /> {scanning ? "..." : "Scan"}
              </button>
            </div>

            {/* AI Analyze */}
            <button onClick={handleAnalyzeAI} disabled={analyzing}
              style={{ display:"flex",alignItems:"center",gap:5,padding:"5px 11px",borderRadius:7,background:analyzing?"rgba(129,140,248,.1)":"rgba(46,255,168,.08)",border:"1px solid rgba(46,255,168,.25)",cursor:analyzing?"not-allowed":"pointer",color:"var(--neon)",fontFamily:"'JetBrains Mono',monospace",fontSize:9,fontWeight:700 }}>
              {analyzing ? <Loader2 size={10} style={{ animation:"spin .7s linear infinite" }} /> : <Sparkles size={10} />}
              Analisis AI
            </button>

            <button onClick={() => { loadIframe(); setMode("iframe"); }} disabled={loading}
              style={{ background:"none",border:"1px solid #2a2d3e",color:"#404660",padding:"5px 7px",borderRadius:6,cursor:"pointer",display:"flex" }}>
              <RefreshCw size={12} />
            </button>
          </div>
        </div>

        {/* Instruction bar */}
        <div style={{ padding:"4px 14px 7px",display:"flex",alignItems:"center",gap:14,borderTop:"1px solid rgba(255,255,255,.04)" }}>
          {mode === "iframe" ? (
            <>
              {[["Hover","highlight"],["Klik","pilih/batalkan"],["Selesai (toolbar)","kirim ke generator"]].map(([k,d]) => (
                <span key={k} style={{ fontSize:10,color:"#7880a0",display:"flex",alignItems:"center",gap:5 }}>
                  <kbd style={{ fontFamily:"'JetBrains Mono',monospace",fontSize:8,padding:"2px 6px",borderRadius:4,background:"rgba(0,0,0,.4)",border:"1px solid #2a2d3e",color:"#00c2ff" }}>{k}</kbd>
                  <span style={{ color:"#404660" }}>{d}</span>
                </span>
              ))}
              <span style={{ marginLeft:"auto",fontFamily:"'JetBrains Mono',monospace",fontSize:9,color:"#404660" }}>
                overlay mode · link dinonaktifkan · navigasi diblokir
              </span>
            </>
          ) : (
            <span style={{ fontSize:10,color:"#7880a0" }}>
              <b style={{ color:"#c8dae8" }}>Scan Mode</b> — klik card elemen untuk pilih. 100% reliable fallback.
            </span>
          )}
        </div>
      </div>

      {/* ── MAIN CONTENT ────────────────────────────────── */}
      <div style={{ display:"flex",flex:1,overflow:"hidden" }}>

        {/* ─ Viewport ─────────────────────────────────── */}
        <div style={{ flex:1,position:"relative",overflow:"hidden" }}>

          {/* IFRAME MODE */}
          {mode === "iframe" && (
            <>
              {loading && (
                <div style={{ position:"absolute",inset:0,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:14,background:"#06090f",zIndex:10 }}>
                  <div style={{ position:"relative" }}>
                    <div className="spinner spinner-lg" />
                    <Eye size={14} style={{ position:"absolute",top:"50%",left:"50%",transform:"translate(-50%,-50%)",color:"var(--neon)",opacity:.7 }} />
                  </div>
                  <div style={{ textAlign:"center" }}>
                    <div style={{ fontFamily:"'JetBrains Mono',monospace",fontSize:12,color:"#c8dae8",marginBottom:4 }}>Fetching HTML + injecting picker...</div>
                    <div style={{ fontFamily:"'JetBrains Mono',monospace",fontSize:10,color:"#404660" }}>6-layer bypass active · scripts stripped · links neutralized</div>
                  </div>
                </div>
              )}
              {error && !loading && (
                <div style={{ position:"absolute",inset:0,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:14,background:"#06090f",zIndex:10,padding:32 }}>
                  <AlertTriangle size={28} style={{ color:"var(--warn)" }} />
                  <div style={{ textAlign:"center" }}>
                    <div style={{ fontSize:13,color:"var(--warn)",marginBottom:6,fontWeight:600 }}>{error}</div>
                    <div style={{ fontSize:11,color:"#7880a0",lineHeight:1.7 }}>
                      Site memblokir server-side fetch.<br />
                      Gunakan <b style={{ color:"#c8dae8" }}>Scan Mode</b> sebagai fallback 100% reliable.
                    </div>
                  </div>
                  <div style={{ display:"flex",gap:8 }}>
                    <button className="btn btn-secondary btn-sm" onClick={() => { setLoading(true); setError(""); loadIframe(); }}>
                      <RefreshCw size={12} /> Retry
                    </button>
                    <button className="btn btn-primary btn-sm" onClick={() => loadCards()}>
                      <LayoutGrid size={12} /> Scan Mode
                    </button>
                  </div>
                </div>
              )}
              <iframe
                ref={iframeRef}
                sandbox="allow-scripts allow-same-origin allow-forms"
                style={{ width:"100%",height:"100%",border:"none",display:loading||error?"none":"block",background:"#fff" }}
                title="visual-picker"
              />
            </>
          )}

          {/* SCAN MODE */}
          {mode === "cards" && (
            <div style={{ display:"flex",height:"100%",background:"var(--bg)",overflow:"hidden" }}>
              {scanning ? (
                <div style={{ flex:1,display:"flex",alignItems:"center",justifyContent:"center",flexDirection:"column",gap:12 }}>
                  <div className="spinner spinner-lg" />
                  <span style={{ fontFamily:"'JetBrains Mono',monospace",fontSize:11,color:"#7880a0" }}>Scanning elemen HTML...</span>
                </div>
              ) : !scanResult ? (
                <div style={{ flex:1,display:"flex",alignItems:"center",justifyContent:"center",flexDirection:"column",gap:12 }}>
                  <Package size={32} style={{ color:"#404660",opacity:.5 }} />
                  <button className="btn btn-primary btn-sm" onClick={() => loadCards()}>
                    <Package size={13} /> Mulai Scan
                  </button>
                </div>
              ) : (
                <>
                  {/* Site info */}
                  <div style={{ position:"absolute",top:0,left:0,right:0,background:"rgba(6,9,15,.85)",backdropFilter:"blur(4px)",borderBottom:"1px solid #1a1e30",padding:"6px 14px",display:"flex",gap:10,alignItems:"center",zIndex:5,flexWrap:"wrap" }}>
                    <Globe size={10} style={{ color:"#404660" }} />
                    <span style={{ fontFamily:"'JetBrains Mono',monospace",fontSize:10,color:"#00c2ff" }}>{scanResult.host}</span>
                    {scanResult.siteType && <span style={{ fontFamily:"'JetBrains Mono',monospace",fontSize:9,color:"var(--neon)",background:"rgba(46,255,168,.07)",padding:"1px 7px",borderRadius:10,border:"1px solid rgba(46,255,168,.2)" }}>{scanResult.siteType}</span>}
                    {scanResult.title && <span style={{ fontSize:11,color:"#7880a0",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",maxWidth:220 }}>{scanResult.title}</span>}
                    <span style={{ fontFamily:"'JetBrains Mono',monospace",fontSize:9,color:"#404660",marginLeft:"auto" }}>{scanResult.elementCount} elemen · L{scanResult.layer}</span>
                  </div>

                  {/* Categories */}
                  <div style={{ width:155,flexShrink:0,borderRight:"1px solid #1a1e30",paddingTop:44,overflowY:"auto",background:"#0b0d14" }}>
                    {Object.keys(byCategory).map(cat => {
                      const items = byCategory[cat];
                      const nc = items.filter((_,i) => checkedCards[String(scanResult.elements.indexOf(items[i]))]).length;
                      return (
                        <button key={cat} onClick={() => setActiveCategory(cat)} style={{ display:"flex",alignItems:"center",gap:7,padding:"7px 10px",background:activeCategory===cat?"rgba(46,255,168,.06)":"transparent",borderLeft:activeCategory===cat?"2px solid var(--neon)":"2px solid transparent",cursor:"pointer",textAlign:"left",width:"100%",border:"none" }}>
                          <span style={{ fontFamily:"'JetBrains Mono',monospace",fontSize:10,color:activeCategory===cat?"var(--neon)":"#7880a0",flex:1,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap" }}>{cat}</span>
                          <span style={{ fontFamily:"'JetBrains Mono',monospace",fontSize:9,color:nc>0?"var(--neon)":"#404660" }}>
                            {nc>0?`${nc}/`:""}{items.length}
                          </span>
                        </button>
                      );
                    })}
                  </div>

                  {/* Elements */}
                  <div style={{ flex:1,paddingTop:44,overflow:"hidden",display:"flex",flexDirection:"column" }}>
                    <div style={{ padding:"7px 12px",borderBottom:"1px solid #1a1e30",flexShrink:0 }}>
                      <div style={{ display:"flex",alignItems:"center",gap:7,background:"rgba(0,0,0,.3)",border:"1px solid #1a1e30",borderRadius:7,padding:"5px 10px" }}>
                        <Search size={10} style={{ color:"#404660" }} />
                        <input value={cardSearch} onChange={e=>setCardSearch(e.target.value.toLowerCase())} placeholder="Filter..." style={{ background:"none",border:"none",outline:"none",color:"#c8dae8",fontFamily:"'JetBrains Mono',monospace",fontSize:10,flex:1 }} />
                      </div>
                    </div>
                    <div style={{ flex:1,overflowY:"auto",padding:"10px 12px",display:"flex",flexDirection:"column",gap:6 }}>
                      {filteredEls.map(el => {
                        const gi = String(scanResult.elements.indexOf(el));
                        const isCk = !!checkedCards[gi];
                        return (
                          <div key={gi} onClick={() => toggleCard(el, gi)}
                            style={{ display:"flex",gap:9,alignItems:"flex-start",padding:"9px 11px",borderRadius:9,cursor:"pointer",background:isCk?"rgba(46,255,168,.05)":"rgba(0,0,0,.3)",border:`1px solid ${isCk?"rgba(46,255,168,.3)":"#1a1e30"}`,transition:"all .15s" }}>
                            <div style={{ width:14,height:14,borderRadius:3,border:`2px solid ${isCk?"var(--neon)":"#2a2d3e"}`,background:isCk?"var(--neon)":"transparent",flexShrink:0,marginTop:1,display:"flex",alignItems:"center",justifyContent:"center" }}>
                              {isCk && <span style={{ color:"#000",fontSize:8,fontWeight:700 }}>✓</span>}
                            </div>
                            <div style={{ flex:1,minWidth:0 }}>
                              <div style={{ display:"flex",alignItems:"center",gap:6,marginBottom:3 }}>
                                <span style={{ fontFamily:"'JetBrains Mono',monospace",fontSize:10,fontWeight:600,color:isCk?"var(--neon)":"#c8dae8" }}>{el.label}</span>
                                <code style={{ fontFamily:"'JetBrains Mono',monospace",fontSize:8,color:"#404660",background:"rgba(0,0,0,.4)",padding:"1px 5px",borderRadius:3 }}>
                                  {el.selector.length>26?el.selector.substring(0,26)+"…":el.selector}
                                </code>
                                <span style={{ fontFamily:"'JetBrains Mono',monospace",fontSize:9,color:"var(--neon)",marginLeft:"auto" }}>{el.count}×</span>
                              </div>
                              {(el.preview||[]).slice(0,2).map((p,pi) => (
                                <div key={pi} style={{ fontSize:10,color:"#7880a0",fontFamily:"'JetBrains Mono',monospace",lineHeight:1.4,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",paddingLeft:5,borderLeft:"2px solid #1a1e30" }}>{p}</div>
                              ))}
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

        {/* ── RIGHT PANEL ─────────────────────────────── */}
        <div style={{ width:280,flexShrink:0,borderLeft:"1px solid #1a1e30",background:"#0b0d14",display:"flex",flexDirection:"column",overflow:"hidden" }}>

          {/* AI Panel */}
          {showAiPanel && (
            <div style={{ borderBottom:"1px solid #1a1e30",flexShrink:0 }}>
              <div style={{ padding:"8px 12px",display:"flex",alignItems:"center",gap:7,background:"rgba(129,140,248,.05)",borderBottom:"1px solid rgba(129,140,248,.1)" }}>
                <Sparkles size={11} style={{ color:"var(--neon3)" }} />
                <span style={{ fontFamily:"'JetBrains Mono',monospace",fontSize:9,color:"var(--neon3)",textTransform:"uppercase",letterSpacing:1 }}>AI Recommendations</span>
                <button onClick={()=>setShowAiPanel(false)} style={{ marginLeft:"auto",background:"none",border:"none",color:"#404660",cursor:"pointer",padding:2 }}><X size={10}/></button>
              </div>
              {analyzing ? (
                <div style={{ padding:"16px",display:"flex",alignItems:"center",gap:8,justifyContent:"center" }}>
                  <Loader2 size={14} style={{ color:"var(--neon3)",animation:"spin .7s linear infinite" }} />
                  <span style={{ fontFamily:"'JetBrains Mono',monospace",fontSize:10,color:"#7880a0" }}>Menganalisa...</span>
                </div>
              ) : aiRecs && (
                <div style={{ maxHeight:200,overflowY:"auto",padding:"6px 10px",display:"flex",flexDirection:"column",gap:5 }}>
                  {aiRecs.map((rec, i) => {
                    const isChosen = picked.some(p => p.target === rec.target);
                    return (
                      <div key={i} onClick={() => applyAiRec(rec)}
                        style={{ padding:"7px 10px",borderRadius:7,cursor:"pointer",background:isChosen?"rgba(46,255,168,.07)":"rgba(0,0,0,.3)",border:`1px solid ${isChosen?"rgba(46,255,168,.3)":"#1a1e30"}`,transition:"all .15s" }}>
                        <div style={{ display:"flex",alignItems:"center",gap:6 }}>
                          <div style={{ width:12,height:12,borderRadius:3,border:`2px solid ${isChosen?"var(--neon)":"#2a2d3e"}`,background:isChosen?"var(--neon)":"transparent",flexShrink:0,display:"flex",alignItems:"center",justifyContent:"center" }}>
                            {isChosen && <span style={{ color:"#000",fontSize:7,fontWeight:700 }}>✓</span>}
                          </div>
                          <span style={{ fontSize:11,color:isChosen?"var(--neon)":"#c8dae8",flex:1,lineHeight:1.4 }}>{rec.label}</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* Selected elements header */}
          <div style={{ padding:"9px 12px",borderBottom:"1px solid #1a1e30",display:"flex",alignItems:"center",gap:7,flexShrink:0 }}>
            <CheckSquare size={11} style={{ color:"var(--neon)" }} />
            <span style={{ fontFamily:"'JetBrains Mono',monospace",fontSize:9,color:"#7880a0",textTransform:"uppercase",letterSpacing:1 }}>Dipilih</span>
            {picked.length > 0 && (
              <span style={{ fontFamily:"'JetBrains Mono',monospace",fontSize:9,padding:"1px 7px",borderRadius:10,background:"rgba(46,255,168,.1)",border:"1px solid rgba(46,255,168,.2)",color:"var(--neon)" }}>
                {picked.length}
              </span>
            )}
            {picked.length > 0 && (
              <button onClick={() => { setPicked([]); setCheckedCards({}); }} style={{ marginLeft:"auto",background:"none",border:"none",color:"#404660",cursor:"pointer",fontSize:9,fontFamily:"'JetBrains Mono',monospace" }}>
                clear
              </button>
            )}
          </div>

          {/* Selected list */}
          <div style={{ flex:1,overflowY:"auto",padding:"7px 9px",display:"flex",flexDirection:"column",gap:5 }}>
            {picked.length === 0 ? (
              <div style={{ padding:"24px 12px",textAlign:"center" }}>
                <MousePointer2 size={24} style={{ color:"#2a2d3e",marginBottom:10 }} />
                <p style={{ fontSize:10,color:"#404660",lineHeight:1.7,fontFamily:"'JetBrains Mono',monospace" }}>
                  {mode==="iframe"?"Klik elemen di halaman.":"Klik card di tengah."}<br />
                  Atau gunakan AI Recommendations.
                </p>
              </div>
            ) : picked.map(el => {
              const color = SRC_CLR[el.source] || "var(--neon)";
              return (
                <div key={el.id} style={{ background:"rgba(46,255,168,.03)",border:"1px solid rgba(46,255,168,.15)",borderRadius:8,padding:"8px 10px",position:"relative" }}>
                  <button onClick={() => removePicked(el.id)} style={{ position:"absolute",top:6,right:6,background:"none",border:"none",cursor:"pointer",color:"#404660",padding:2,lineHeight:1 }}><X size={9}/></button>
                  <div style={{ display:"flex",alignItems:"center",gap:5,marginBottom:4,paddingRight:14,flexWrap:"wrap" }}>
                    <span style={{ fontFamily:"'JetBrains Mono',monospace",fontSize:8,padding:"2px 6px",borderRadius:4,background:"rgba(0,0,0,.4)",color,textTransform:"uppercase",letterSpacing:".5px" }}>{el.source}</span>
                    {el.count > 0 && <span style={{ fontFamily:"'JetBrains Mono',monospace",fontSize:10,color:"var(--neon)",fontWeight:700 }}>{el.count}×</span>}
                    {el.itemType && <span style={{ fontFamily:"'JetBrains Mono',monospace",fontSize:8,color:"var(--neon3)",padding:"2px 5px",borderRadius:4,background:"rgba(176,111,255,.08)",border:"1px solid rgba(176,111,255,.2)" }}>{el.itemType}</span>}
                  </div>
                  <code style={{ fontFamily:"'JetBrains Mono',monospace",fontSize:9.5,color:"#c8dae8",display:"block",marginBottom:4,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",background:"rgba(0,0,0,.4)",padding:"3px 7px",borderRadius:5,border:"1px solid #1a1e30" }}>
                    {el.selector || el.target.substring(0,40)}
                  </code>
                  {el.rawFields.length > 0 && (
                    <div style={{ display:"flex",flexWrap:"wrap",gap:3 }}>
                      {el.rawFields.slice(0,5).map(f => (
                        <span key={f} style={{ fontFamily:"'JetBrains Mono',monospace",fontSize:8,padding:"1px 5px",borderRadius:3,background:"rgba(0,0,0,.4)",border:"1px solid #1a1e30",color:"#7880a0" }}>{f}</span>
                      ))}
                      {el.rawFields.length > 5 && <span style={{ fontFamily:"'JetBrains Mono',monospace",fontSize:8,color:"#404660" }}>+{el.rawFields.length-5}</span>}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Apply button */}
          <div style={{ padding:"11px 12px",borderTop:"1px solid #1a1e30",flexShrink:0,display:"flex",flexDirection:"column",gap:6 }}>
            <button className="btn btn-primary" style={{ width:"100%" }} disabled={picked.length===0} onClick={handleApply}>
              <Zap size={14} /> Pakai {picked.length} Elemen
            </button>
            <button className="btn btn-secondary btn-sm" style={{ width:"100%" }} onClick={onClose}>Batal</button>
          </div>
        </div>
      </div>
    </div>
  );
}
