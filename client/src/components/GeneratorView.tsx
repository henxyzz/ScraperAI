import { useState, useEffect, useRef } from "react";
import {
  Globe, Zap, Code2, CheckCircle, ArrowRight, ArrowLeft,
  RefreshCw, Wand2, Package, Shield, ShieldOff,
  Terminal, Play, Box, Cpu, Route, CheckSquare, Square, Settings2,
  ChevronDown, ChevronUp, Activity,
} from "lucide-react";
import { useStore } from "../store";
import { generateScraper, getTemplates, installDeps, getApiRoutes, createApiRoute, deleteApiRoute, prefetchUrl, previewUrl, detectUrl } from "../api";
import { FirewallInfo } from "./FirewallInfo";
import { TryOutputPanel } from "./TryOutputPanel";
import { CodeBlock } from "./CodeBlock";
import type { Template, Lang, ApiRoute, PrefetchElement, PrefetchResult, UrlDetectResult } from "../types";

type ModuleType = "commonjs" | "esm" | "esm-ts";
interface ModuleTypeOpt { value: ModuleType; label: string; sub: string; ext: string; note: string; }
const MODULE_TYPES: ModuleTypeOpt[] = [
  { value: "commonjs", label: "CommonJS",  sub: "require() / module.exports", ext: ".js",  note: "Node default" },
  { value: "esm",      label: "ES Module", sub: "import / export",            ext: ".mjs", note: "Modern ESM"   },
  { value: "esm-ts",   label: "ESM + TS",  sub: "TypeScript + import/export", ext: ".ts",  note: "With types"  },
];

const STEPS = [{ id:0,label:"URL"},{id:1,label:"Analisa"},{id:2,label:"Konfigurasi"},{id:3,label:"Hasil"}];
const LANG_OPTIONS: { value: Lang; label: string; sub: string }[] = [
  { value: "nodejs", label: "Node.js", sub: "axios + cheerio / puppeteer" },
  { value: "python", label: "Python",  sub: "requests + beautifulsoup4"   },
  { value: "php",    label: "PHP",     sub: "cURL + DOMDocument"           },
];
const COMPLEXITY_COLOR: Record<string,string> = { simple:"var(--neon)", moderate:"var(--neon2)", complex:"var(--warn)" };

export function GeneratorView() {
  const {
    provider, apiKey, model,
    genStep, genUrl, genAnalysis, genTarget, genLang, genBypassCF, genResult,
    setGenStep, setGenUrl, setGenAnalysis, setGenTarget, setGenLang, setGenBypassCF, setGenResult,
    resetGen, addToast,
  } = useStore();

  const [loadingAnalyze,     setLoadingAnalyze]     = useState(false);
  const [loadingGenerate,    setLoadingGenerate]    = useState(false);
  const [templates,          setTemplates]          = useState<Template[]>([]);
  const [showTemplates,      setShowTemplates]      = useState(false);
  const [checkedFields,      setCheckedFields]      = useState<Record<number,boolean>>({});
  const [moduleType,         setModuleType]         = useState<ModuleType>("commonjs");
  const [installLoading,     setInstallLoading]     = useState(false);
  const [installResult,      setInstallResult]      = useState<{success:boolean;message:string;output:string}|null>(null);
  // Store deep DOM selectors from scan to pass to generate
  const [scanSmartSelectors, setScanSmartSelectors] = useState<any[]>([]);

  const canProceed = !!apiKey.trim();

  // ── SSE log state ─────────────────────────────────────────
  const [logs,        setLogs]        = useState<string[]>([]);
  const [showLogs,    setShowLogs]    = useState(false);
  const [genLogs,     setGenLogs]     = useState<string[]>([]);
  const [showGenLogs, setShowGenLogs] = useState(false);
  const logRef    = useRef<HTMLDivElement>(null);
  const genLogRef = useRef<HTMLDivElement>(null);

  useEffect(() => { if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight; }, [logs]);
  useEffect(() => { if (genLogRef.current) genLogRef.current.scrollTop = genLogRef.current.scrollHeight; }, [genLogs]);

  /* ── Step 0: Analyze via SSE stream ── */
  const handleAnalyze = async () => {
    if (!genUrl.trim()) { addToast("warn","Masukkan URL target terlebih dahulu"); return; }
    if (!canProceed)    { addToast("warn","Masukkan API Key di topbar terlebih dahulu"); return; }
    setLoadingAnalyze(true); setCheckedFields({});
    setLogs([]); setShowLogs(true);

    const params = new URLSearchParams({ url: genUrl.trim(), provider, apiKey, model: model || "" });
    const evtSrc = new EventSource(`/api/analyze/stream?${params.toString()}`);

    evtSrc.addEventListener("log", (e) => {
      const d = JSON.parse(e.data);
      setLogs(p => [...p, d.msg]);
    });

    evtSrc.addEventListener("result", (e) => {
      evtSrc.close();
      try {
        const data = JSON.parse(e.data);
        setGenAnalysis(data);
        setGenBypassCF(data.firewall?.bypass_recommended || false);
        setGenStep(1);
        addToast("success", "Analisa selesai!");
      } catch { addToast("error", "Gagal parse hasil analisa"); }
      setLoadingAnalyze(false);
    });

    evtSrc.addEventListener("error", (e) => {
      evtSrc.close();
      try {
        const d = JSON.parse((e as any).data || "{}");
        addToast("error", d.msg || "Gagal analisa URL");
        setLogs(p => [...p, ` Error: ${d.msg}`]);
      } catch {
        addToast("error", "Koneksi SSE terputus");
      }
      setLoadingAnalyze(false);
    });

    evtSrc.onerror = () => {
      evtSrc.close();
      addToast("error", "Koneksi SSE error");
      setLoadingAnalyze(false);
    };
  };

  const loadTemplates = async () => {
    if (templates.length) { setShowTemplates(v=>!v); return; }
    try { const r = await getTemplates(); setTemplates(r.templates); setShowTemplates(true); }
    catch { addToast("error","Gagal load templates"); }
  };

  const applyTemplate = (t:Template) => {
    setGenUrl(t.example_url); setGenTarget(t.target); setGenLang(t.lang);
    setShowTemplates(false); addToast("info",`Template "${t.name}" diterapkan`);
  };

  /* ── Checkbox field toggle ── */
  const toggleField = (idx:number) => {
    setCheckedFields(prev => {
      const next = { ...prev, [idx]: !prev[idx] };
      const checked = (genAnalysis?.ai.suggestions||[]).filter((_,i)=>next[i]).join(", ");
      if (checked) setGenTarget(checked);
      return next;
    });
  };
  const checkedCount = Object.values(checkedFields).filter(Boolean).length;

  /* ── Step 1 → Step 2 ── */
  const goToConfig = () => {
    if (!genTarget.trim()) { addToast("warn","Pilih atau tulis target data terlebih dahulu"); return; }
    setGenStep(2);
  };

  /* ── Step 2: Generate via SSE stream ── */
  const handleGenerate = async () => {
    if (!genTarget.trim()) { addToast("warn","Target data belum diisi"); return; }
    if (!canProceed)       { addToast("warn","API Key belum diisi"); return; }
    setLoadingGenerate(true);
    setGenLogs([]); setShowGenLogs(true);

    const params = new URLSearchParams({
      url: genUrl, target: genTarget, lang: genLang,
      bypassCF: String(genBypassCF), provider, apiKey, model: model || "",
      moduleType: genLang === "nodejs" ? moduleType : "",
      siteType:    genAnalysis?.ai?.site_type || "",
      pageType:    "",
      searchQuery: "",
      // Prioritize deep DOM scan selectors (most accurate), fallback to AI css selectors
      selectors: (() => {
        if (scanSmartSelectors.length > 0) {
          return JSON.stringify(scanSmartSelectors);
        }
        const aiSels = genAnalysis?.ai?.css_selectors?.selectors;
        if (aiSels?.length) {
          return JSON.stringify(aiSels.map((s: string) => ({ selector: s, category: "css", count: 0, fields: [], rawFields: [] })));
        }
        return "";
      })(),
    });
    const evtSrc = new EventSource(`/api/generate/stream?${params.toString()}`);

    evtSrc.addEventListener("log", (e) => {
      const d = JSON.parse(e.data);
      setGenLogs(p => [...p, d.msg]);
    });

    evtSrc.addEventListener("result", (e) => {
      evtSrc.close();
      try {
        const data = JSON.parse(e.data);
        setGenResult({ id: data.id, code: data.code, trySchema: data.trySchema });
        setGenStep(3);
        addToast("success", "Scraper berhasil di-generate!");
      } catch { addToast("error", "Gagal parse kode yang di-generate"); }
      setLoadingGenerate(false);
    });

    evtSrc.addEventListener("error", (e) => {
      evtSrc.close();
      try {
        const d = JSON.parse((e as any).data || "{}");
        addToast("error", d.msg || "Gagal generate scraper");
        setGenLogs(p => [...p, ` Error: ${d.msg}`]);
      } catch {
        addToast("error", "Koneksi SSE error saat generate");
      }
      setLoadingGenerate(false);
    });

    evtSrc.onerror = () => { evtSrc.close(); setLoadingGenerate(false); };
  };

  /* ── Auto Install ── */
  const handleAutoInstall = async () => {
    if (!genResult?.id) return;
    setInstallLoading(true); setInstallResult(null);
    try {
      const recs = genAnalysis?.ai?.recommended_modules;
      const pkgs = recs ? recs[genLang]?.packages : undefined;
      const res  = await installDeps(genResult.id, pkgs);
      setInstallResult(res);
      if (res.success) addToast("success","Dependencies berhasil diinstall!");
      else addToast("warn", res.message);
    } catch(e:any){ addToast("error",e.message||"Install gagal"); }
    finally { setInstallLoading(false); }
  };

  const getExt = () => genLang==="nodejs"?(moduleType==="esm"?".mjs":moduleType==="esm-ts"?".ts":".js"):genLang==="python"?".py":".php";

  return (
    <div>
      {/* Step Bar */}
      <div className="stepbar">
        {STEPS.map((s,idx) => (
          <span key={s.id} style={{display:"contents"}}>
            <div className={`step-item ${genStep>s.id?"done":genStep===s.id?"active":""}`}>
              <div className="step-circle">
                {genStep>s.id ? <CheckCircle size={13}/> : s.id+1}
              </div>
              <span className="step-label">{s.label}</span>
            </div>
            {idx<STEPS.length-1 && <div className="step-line"/>}
          </span>
        ))}
      </div>

      {/* ──── STEP 0: URL ──────────────────────────────────── */}
      {genStep===0 && (
        <Step0UrlPanel
          genUrl={genUrl} setGenUrl={setGenUrl}
          loadingAnalyze={loadingAnalyze}
          canProceed={canProceed}
          handleAnalyze={handleAnalyze}
          loadTemplates={loadTemplates}
          showTemplates={showTemplates}
          templates={templates}
          applyTemplate={applyTemplate}
          logs={logs} showLogs={showLogs} setShowLogs={setShowLogs}
          logRef={logRef}
          genTarget={genTarget} setGenTarget={setGenTarget}
          addToast={addToast}
          onScanComplete={(selectors) => setScanSmartSelectors(selectors || [])}
        />
      )}

      {/* ──── STEP 1: ANALYZE RESULT ─────────────────────── */}
      {genStep===1 && genAnalysis && (
        <div style={{display:"flex",flexDirection:"column",gap:16}}>
          <div className="card">
            <div className="card-head">
              <Zap size={14} style={{color:"var(--neon)"}}/>
              <span className="card-tag">AI Analysis</span>
              {genAnalysis.ai.site_type && (
                <span className="badge badge-neutral" style={{marginLeft:"auto"}}>{genAnalysis.ai.site_type}</span>
              )}
              <div className="card-dots"><span/><span/><span/></div>
            </div>
            <div className="card-body" style={{display:"flex",flexDirection:"column",gap:14}}>
              <p style={{fontSize:13,color:"var(--text2)",lineHeight:1.7}}>{genAnalysis.ai.greeting}</p>
              <p style={{fontSize:13,color:"var(--text)",fontWeight:600}}>{genAnalysis.ai.question}</p>

              {/* ── HTML Fetch Info Badge ── */}
              {genAnalysis.html_info && (
                <div style={{
                  background:genAnalysis.html_info.fetched?"rgba(46,255,168,.05)":"rgba(255,184,48,.05)",
                  border:`1px solid ${genAnalysis.html_info.fetched?"rgba(46,255,168,.2)":"rgba(255,184,48,.25)"}`,
                  borderRadius:9,padding:"10px 14px",
                }}>
                  <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap",marginBottom:6}}>
                    <span style={{fontFamily:"var(--mono)",fontSize:10,letterSpacing:1,
                      color:genAnalysis.html_info.fetched?"var(--neon)":"var(--warn)"}}>
                      {genAnalysis.html_info.fetched?" HTML BERHASIL DI-FETCH":" HTML TIDAK BISA DI-FETCH"}
                    </span>
                    {genAnalysis.html_info.status_code&&<span className="badge badge-neutral" style={{fontSize:9}}>HTTP {genAnalysis.html_info.status_code}</span>}
                    {genAnalysis.html_info.has_json_ld&&<span className="badge badge-neon" style={{fontSize:9}}>JSON-LD </span>}
                    {genAnalysis.html_info.has_next_data&&<span className="badge badge-blue" style={{fontSize:9}}>__NEXT_DATA__ </span>}
                    {genAnalysis.html_info.fetch_error&&<span style={{fontSize:11,color:"var(--warn)"}}>— {genAnalysis.html_info.fetch_error}</span>}
                  </div>
                  {genAnalysis.html_info.detected_tech.length>0&&(
                    <div style={{display:"flex",gap:5,flexWrap:"wrap",marginBottom:4}}>
                      <span style={{fontSize:10,color:"var(--muted)"}}>Tech:</span>
                      {genAnalysis.html_info.detected_tech.map((t:string)=>(
                        <span key={t} className="module-pkg-badge" style={{fontSize:9}}>{t}</span>
                      ))}
                    </div>
                  )}
                  <div style={{display:"flex",gap:12,fontSize:11,color:"var(--muted)"}}>
                    {genAnalysis.html_info.title&&<span> {genAnalysis.html_info.title.substring(0,60)}</span>}
                    <span> {genAnalysis.html_info.img_count} img</span>
                    <span> {genAnalysis.html_info.link_count} link</span>
                  </div>
                </div>
              )}

              {/* ── Scraping Strategy ── */}
              {genAnalysis.ai.scraping_strategy&&(
                <div style={{background:"rgba(0,194,255,.05)",border:"1px solid rgba(0,194,255,.18)",borderRadius:9,padding:"10px 14px"}}>
                  <div style={{fontFamily:"var(--mono)",fontSize:10,color:"var(--neon2)",letterSpacing:1,textTransform:"uppercase",marginBottom:5}}>
                     Strategi Scraping
                  </div>
                  <p style={{fontSize:12.5,color:"var(--text2)",lineHeight:1.7}}>{genAnalysis.ai.scraping_strategy}</p>
                  {genAnalysis.ai.css_selectors?.selectors&&genAnalysis.ai.css_selectors.selectors.length>0&&(
                    <div style={{marginTop:8,display:"flex",gap:5,flexWrap:"wrap"}}>
                      <span style={{fontSize:10,color:"var(--muted)"}}>CSS selectors dari HTML:</span>
                      {genAnalysis.ai.css_selectors.selectors.map((s:string)=>(
                        <code key={s} style={{fontFamily:"var(--mono)",fontSize:10,padding:"1px 6px",
                          background:"rgba(0,0,0,.4)",border:"1px solid var(--border2)",borderRadius:4,color:"var(--neon)"}}>{s}</code>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* ── Checkbox Field Selector ── */}
              <div className="field">
                <label className="field-label" style={{display:"flex",alignItems:"center",gap:7}}>
                  <CheckSquare size={12} style={{color:"var(--neon)"}}/>
                  Pilih Field yang Akan Di-scrape
                  {checkedCount>0 && <span className="badge badge-neon" style={{fontSize:9}}>{checkedCount} dipilih</span>}
                </label>
                <div style={{display:"flex",flexDirection:"column",gap:6,marginBottom:10}}>
                  {genAnalysis.ai.suggestions.map((s,i)=>(
                    <label key={i} onClick={()=>toggleField(i)} style={{
                      display:"flex",alignItems:"center",gap:10,cursor:"pointer",
                      padding:"8px 12px",userSelect:"none",
                      background:checkedFields[i]?"rgba(46,255,168,.08)":"rgba(0,0,0,.25)",
                      border:`1px solid ${checkedFields[i]?"rgba(46,255,168,.35)":"var(--border2)"}`,
                      borderRadius:8,transition:"all .15s",
                    }}>
                      {checkedFields[i]
                        ? <CheckSquare size={14} style={{color:"var(--neon)",flexShrink:0}}/>
                        : <Square      size={14} style={{color:"var(--muted)",flexShrink:0}}/>}
                      <span style={{fontSize:13,color:checkedFields[i]?"var(--text)":"var(--text2)"}}>{s}</span>
                    </label>
                  ))}
                </div>
                <label className="field-label" style={{marginTop:4}}>atau ketik manual / gabungan</label>
                <textarea className="field-textarea"
                  placeholder="Contoh: nama produk, harga, rating, URL gambar..."
                  value={genTarget} onChange={e=>setGenTarget(e.target.value)} rows={2}/>
              </div>
            </div>
          </div>

          {/* Recommended modules */}
          {genAnalysis.ai.recommended_modules && (
            <div className="card">
              <div className="card-head">
                <Box size={14} style={{color:"var(--neon3)"}}/>
                <span className="card-tag">Rekomendasi Module AI</span>
                <span className="badge badge-purple" style={{marginLeft:"auto",fontSize:9}}>v4 auto detect</span>
                <div className="card-dots"><span/><span/><span/></div>
              </div>
              <div className="card-body" style={{display:"flex",flexDirection:"column",gap:12}}>
                {genAnalysis.ai.complexity && (
                  <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
                    <Cpu size={12} style={{color:"var(--muted)"}}/>
                    <span style={{fontSize:11,color:"var(--muted)"}}>Kompleksitas:</span>
                    <span style={{fontFamily:"var(--mono)",fontSize:11,fontWeight:700,color:COMPLEXITY_COLOR[genAnalysis.ai.complexity]||"var(--text2)"}}>
                      {genAnalysis.ai.complexity.toUpperCase()}
                    </span>
                    {genAnalysis.ai.complexity_reason && (
                      <span style={{fontSize:11,color:"var(--text2)"}}>— {genAnalysis.ai.complexity_reason}</span>
                    )}
                  </div>
                )}
                <div style={{display:"flex",flexDirection:"column",gap:10}}>
                  {(["nodejs","python","php"] as Lang[]).map(l=>{
                    const rec=genAnalysis.ai.recommended_modules![l];
                    if(!rec) return null;
                    const isActive=genLang===l;
                    return (
                      <div key={l} className={`module-rec-item ${isActive?"active":""}`} onClick={()=>setGenLang(l)}>
                        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
                          <div style={{display:"flex",gap:6,alignItems:"center"}}>
                            <span className={`badge badge-${l==="nodejs"?"neon":l==="python"?"blue":"purple"}`}>{l}</span>
                            {isActive && <span style={{fontSize:10,color:"var(--neon)",fontFamily:"var(--mono)"}}>← selected</span>}
                          </div>
                          <div style={{display:"flex",gap:5,flexWrap:"wrap",justifyContent:"flex-end"}}>
                            {rec.packages.map(pkg=>(<span key={pkg} className="module-pkg-badge"><Package size={9}/>{pkg}</span>))}
                          </div>
                        </div>
                        <p style={{fontSize:11,color:"var(--text2)",marginBottom:6}}> {rec.reason}</p>
                        <code className="module-cmd" style={{fontSize:10}}>{rec.install_cmd}</code>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          )}

          {/* Firewall */}
          <div className="card">
            <div className="card-head">
              {genAnalysis.firewall.bypass_recommended
                ? <Shield size={14} style={{color:"var(--danger)"}}/>
                : <ShieldOff size={14} style={{color:"var(--neon)"}}/>}
              <span className="card-tag">Firewall Detection</span>
              <div className="card-dots"><span/><span/><span/></div>
            </div>
            <div className="card-body"><FirewallInfo fw={genAnalysis.firewall}/></div>
          </div>

          <div style={{display:"flex",gap:10,flexWrap:"wrap"}}>
            <button className="btn btn-secondary" onClick={()=>setGenStep(0)}><ArrowLeft size={15}/> Kembali</button>
            <button className="btn btn-primary" onClick={goToConfig} disabled={!genTarget.trim()}>
              Konfigurasi <ArrowRight size={15}/>
            </button>
          </div>
        </div>
      )}

      {/* ──── STEP 2: CONFIGURE ─────────────────────────────── */}
      {genStep===2 && (
        <div style={{display:"flex",flexDirection:"column",gap:16}}>
          <div className="card">
            <div className="card-head">
              <Code2 size={14} style={{color:"var(--neon2)"}}/>
              <span className="card-tag">Konfigurasi Scraper</span>
              <div className="card-dots"><span/><span/><span/></div>
            </div>
            <div className="card-body" style={{display:"flex",flexDirection:"column",gap:18}}>
              {/* Summary */}
              <div className="summary-box">
                <div style={{display:"flex",gap:8,alignItems:"center"}}>
                  <Globe size={12} style={{color:"var(--muted)"}}/>
                  <span style={{fontFamily:"var(--mono)",fontSize:11,color:"var(--text2)",wordBreak:"break-all"}}>{genUrl}</span>
                </div>
                <div style={{display:"flex",gap:8}}>
                  <Zap size={12} style={{color:"var(--muted)",flexShrink:0,marginTop:2}}/>
                  <span style={{fontSize:12,color:"var(--text2)"}}>{genTarget}</span>
                </div>
              </div>

              {/* Lang selector */}
              <div className="field">
                <label className="field-label">Bahasa Pemrograman</label>
                <div className="lang-selector">
                  {LANG_OPTIONS.map(l=>(
                    <button key={l.value} className={`lang-opt ${genLang===l.value?"active":""}`} onClick={()=>setGenLang(l.value)}>
                      <span className="lang-opt-label">{l.label}</span>
                      <span className="lang-opt-sub">{l.sub}</span>
                      {genAnalysis?.ai?.recommended_modules?.[l.value] && (
                        <span style={{fontSize:9,color:"var(--neon3)",fontFamily:"var(--mono)",marginTop:2}}>AI rec </span>
                      )}
                    </button>
                  ))}
                </div>
              </div>

              {/* Module type (Node.js only) */}
              {genLang==="nodejs" && (
                <div className="field">
                  <label className="field-label" style={{display:"flex",alignItems:"center",gap:7}}>
                    <Settings2 size={12} style={{color:"var(--neon2)"}}/>
                    Tipe Module Output
                  </label>
                  <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
                    {MODULE_TYPES.map(mt=>(
                      <button key={mt.value} onClick={()=>setModuleType(mt.value)} style={{
                        flex:1,minWidth:110,padding:"10px 8px",cursor:"pointer",transition:"all .15s",
                        display:"flex",flexDirection:"column",alignItems:"center",gap:4,
                        background:moduleType===mt.value?"rgba(0,194,255,.1)":"rgba(0,0,0,.4)",
                        border:`1.5px solid ${moduleType===mt.value?"var(--neon2)":"var(--border2)"}`,
                        borderRadius:9,color:moduleType===mt.value?"var(--neon2)":"var(--muted)",
                      }}>
                        <span style={{fontFamily:"var(--mono)",fontSize:12,fontWeight:700}}>{mt.label}</span>
                        <span style={{fontSize:10,opacity:.65}}>{mt.sub}</span>
                        <span style={{fontFamily:"var(--mono)",fontSize:9,opacity:.5}}>{mt.ext} · {mt.note}</span>
                      </button>
                    ))}
                  </div>
                  <p style={{fontSize:11,color:"var(--muted)",marginTop:6}}>
                    {moduleType==="commonjs" && <>Output: <code style={{fontFamily:"var(--mono)",fontSize:10}}>require()</code> / <code style={{fontFamily:"var(--mono)",fontSize:10}}>module.exports</code></>}
                    {moduleType==="esm"      && <>Output: <code style={{fontFamily:"var(--mono)",fontSize:10}}>import</code> / <code style={{fontFamily:"var(--mono)",fontSize:10}}>export default</code> (.mjs)</>}
                    {moduleType==="esm-ts"   && <>Output: TypeScript dengan full type annotations (.ts)</>}
                  </p>
                </div>
              )}

              {/* Bypass toggle */}
              <div className="toggle-row">
                <div className="toggle-info">
                  <div className="toggle-title">Bypass Cloudflare / WAF Mode</div>
                  <div className="toggle-desc">Gunakan puppeteer stealth (Node.js) atau cloudscraper (Python).</div>
                </div>
                <button className={`toggle ${genBypassCF?"on":""}`} onClick={()=>setGenBypassCF(!genBypassCF)}>
                  <div className="toggle-knob"/>
                </button>
              </div>
              {genBypassCF && (
                <div className="info-box warn"><Shield size={15}/><span>Bypass mode aktif — library tambahan auto-install setelah generate.</span></div>
              )}
            </div>
          </div>

          <div style={{display:"flex",gap:10,flexWrap:"wrap"}}>
            <button className="btn btn-secondary" onClick={()=>setGenStep(1)}><ArrowLeft size={15}/> Kembali</button>
            <button className="btn btn-primary" onClick={handleGenerate} disabled={loadingGenerate} style={{flex:1}}>
              {loadingGenerate
                ? <><div className="spinner" style={{width:15,height:15}}/> AI sedang generate kode...</>
                : <><Zap size={15}/> Generate Scraper</>}
            </button>
          </div>
          {loadingGenerate && (
            <div className="info-box info">
              <div className="spinner" style={{width:13,height:13,borderWidth:"1.5px",flexShrink:0}}/>
              <span>AI sedang menulis kode scraper. Bisa 30–90 detik...</span>
            </div>
          )}
          {/* ── Generate Real-time Log Panel ── */}
          {genLogs.length > 0 && (
            <div style={{background:"rgba(0,0,0,.5)",border:"1px solid var(--border2)",borderRadius:10,overflow:"hidden"}}>
              <button
                onClick={()=>setShowGenLogs(v=>!v)}
                style={{width:"100%",display:"flex",alignItems:"center",gap:8,padding:"9px 14px",
                  background:"transparent",border:"none",cursor:"pointer",color:"var(--muted)",
                  fontFamily:"var(--mono)",fontSize:11,textAlign:"left"}}
              >
                <Activity size={12} style={{color:loadingGenerate?"var(--neon)":"var(--muted)"}}/>
                <span style={{flex:1}}>
                  {loadingGenerate ? "⏳ AI sedang generate..." : " Generate selesai"} — {genLogs.length} log
                </span>
                {showGenLogs ? <ChevronUp size={12}/> : <ChevronDown size={12}/>}
              </button>
              {showGenLogs && (
                <div ref={genLogRef} style={{
                  padding:"10px 14px",maxHeight:250,overflowY:"auto",
                  display:"flex",flexDirection:"column",gap:3,
                }}>
                  {genLogs.map((msg,i)=>(
                    <div key={i} style={{
                      fontFamily:"var(--mono)",fontSize:11,lineHeight:1.6,
                      color: msg.includes("[DONE]") || msg.includes("selesai") || msg.includes("Berhasil")
                           ? "var(--neon)"
                           : msg.includes("[ERR]") || msg.includes("gagal") || msg.includes("Error")
                           ? "var(--danger)"
                           : msg.includes("[WARN]") || msg.includes("bypass") || msg.includes("Proteksi")
                           ? "var(--warn)"
                           : msg.includes("[AI]") || msg.includes("Analisa") || msg.includes("Generate") || msg.includes("Fetch")
                           ? "var(--neon2)"
                           : "var(--text2)",
                    }}>{msg}</div>
                  ))}
                  {loadingGenerate && (
                    <div style={{display:"flex",gap:6,alignItems:"center",marginTop:4}}>
                      <div className="spinner" style={{width:10,height:10,borderWidth:"1.5px"}}/>
                      <span style={{fontFamily:"var(--mono)",fontSize:10,color:"var(--muted)"}}>AI sedang menulis kode...</span>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* ──── STEP 3: RESULT ───────────────────────────────── */}
      {genStep===3 && genResult && (
        <div style={{display:"flex",flexDirection:"column",gap:16}}>

          <div className="info-box neon">
            <CheckCircle size={15}/>
            <span>Scraper berhasil di-generate! Download dan jalankan di lokal / server / Termux.</span>
          </div>

          {/* Code output */}
          <div className="card">
            <div className="card-head">
              <Code2 size={14} style={{color:"var(--neon)"}}/>
              <span className="card-tag">Generated Code</span>
              {genLang==="nodejs" && (
                <span className="badge badge-blue" style={{marginLeft:"auto",fontSize:9}}>
                  {MODULE_TYPES.find(m=>m.value===moduleType)?.label}
                </span>
              )}
              <div className="card-dots"><span/><span/><span/></div>
            </div>
            <div className="card-body">
              <CodeBlock code={genResult.code} lang={genLang} scraperId={genResult.id}/>
            </div>
          </div>

          {/* Auto install */}
          <div className="card">
            <div className="card-head">
              <Terminal size={14} style={{color:"var(--neon2)"}}/>
              <span className="card-tag">Auto Install Dependencies</span>
              {genAnalysis?.ai?.recommended_modules?.[genLang] && (
                <span className="badge badge-neon" style={{marginLeft:"auto",fontSize:9}}>AI recommended</span>
              )}
              <div className="card-dots"><span/><span/><span/></div>
            </div>
            <div className="card-body" style={{display:"flex",flexDirection:"column",gap:10}}>
              {genAnalysis?.ai?.recommended_modules?.[genLang] && (
                <div style={{display:"flex",gap:6,flexWrap:"wrap",alignItems:"center"}}>
                  <span style={{fontSize:11,color:"var(--muted)"}}>Akan install:</span>
                  {genAnalysis.ai.recommended_modules[genLang].packages.map(p=>(
                    <span key={p} className="module-pkg-badge"><Package size={9}/>{p}</span>
                  ))}
                </div>
              )}
              <button className="btn btn-secondary" onClick={handleAutoInstall} disabled={installLoading} style={{alignSelf:"flex-start"}}>
                {installLoading
                  ? <><div className="spinner" style={{width:13,height:13}}/> Installing...</>
                  : <><Terminal size={13}/> Auto Install Modules</>}
              </button>
              {installResult && (
                <div className={`info-box ${installResult.success?"neon":"warn"}`} style={{flexDirection:"column",alignItems:"flex-start"}}>
                  <div style={{display:"flex",gap:8,alignItems:"center"}}>
                    <CheckCircle size={14}/>
                    <span style={{fontWeight:600,fontSize:12}}>{installResult.message}</span>
                  </div>
                  {installResult.output && <pre className="install-output">{installResult.output}</pre>}
                </div>
              )}
            </div>
          </div>

          {/* Try output */}
          <div className="card">
            <div className="card-head">
              <Play size={14} style={{color:"var(--neon3)"}}/>
              <span className="card-tag">Try Output — Real Data</span>
              <span className="badge badge-neon" style={{marginLeft:"auto",fontSize:9}}>v4 live</span>
              <div className="card-dots"><span/><span/><span/></div>
            </div>
            <div className="card-body">
              <TryOutputPanel scraper={{
                id:genResult.id,
                name:`${genUrl.replace(/https?:\/\//,"").split("/")[0]}-scraper`,
                url:genUrl, target:genTarget, lang:genLang, bypassCF:genBypassCF,
                code:genResult.code, trySchema:genResult.trySchema||[],
                provider, model:model||"",
                createdAt:new Date().toISOString(), updatedAt:new Date().toISOString(),
                filename:`scraper${getExt()}`, fixCount:0, history:[],
              }}/>
            </div>
          </div>

          {/* API Routes panel */}
          <div className="card">
            <div className="card-head">
              <Route size={14} style={{color:"var(--neon2)"}}/>
              <span className="card-tag">API Routes — Query Params &amp; Exports</span>
              <div className="card-dots"><span/><span/><span/></div>
            </div>
            <div className="card-body">
              <ApiRoutesPanel
                scraperId={genResult.id}
                scraperName={`${genUrl.replace(/https?:\/\//,"").split("/")[0]}-scraper`}
              />
            </div>
          </div>

          {/* Action row */}
          <div style={{display:"flex",gap:10,flexWrap:"wrap"}}>
            <button className="btn btn-primary" onClick={resetGen}><RefreshCw size={14}/> Buat Baru</button>
            <button className="btn btn-secondary" onClick={()=>useStore.getState().setView("scrapers")}>Lihat Scrapers</button>
            <button className="btn btn-secondary" onClick={()=>{ useStore.getState().setFixScraperId(genResult.id); useStore.getState().setView("fix"); }}>
              <Wand2 size={14}/> Fix Engine
            </button>
            <button className="btn btn-secondary" onClick={()=>useStore.getState().setView("docs")}>
              <Route size={14}/> API Docs
            </button>
          </div>

        </div>
      )}
    </div>
  );
}

/* ════════════════════════════════════════
   ApiRoutesPanel — inline component
   Query params builder, test endpoint,
   export sebagai module
════════════════════════════════════════ */
interface ApiRoutesPanelProps { scraperId:string; scraperName:string; }

function ApiRoutesPanel({ scraperId, scraperName }:ApiRoutesPanelProps) {
  const { addToast } = useStore();
  const [routes,      setRoutes]      = useState<ApiRoute[]>([]);
  const [loading,     setLoading]     = useState(false);
  const [creating,    setCreating]    = useState(false);
  const [showForm,    setShowForm]    = useState(false);
  const [testQuery,   setTestQuery]   = useState<Record<string,string>>({});
  const [activeTest,  setActiveTest]  = useState<string|null>(null);
  const [testResults, setTestResults] = useState<Record<string,any>>({});

  const [formName,    setFormName]    = useState(scraperName);
  const [formMethod,  setFormMethod]  = useState<"GET"|"POST">("GET");
  const [formCat,     setFormCat]     = useState("scraper");
  const [formDesc,    setFormDesc]    = useState("");
  const [formParams,  setFormParams]  = useState([
    { name:"url",    type:"string",  required:true,  description:"URL target yang akan di-scrape" },
    { name:"limit",  type:"number",  required:false, description:"Jumlah hasil maksimum" },
    { name:"format", type:"string",  required:false, description:"Format output: json | csv | text" },
  ]);

  useEffect(()=>{ loadRoutes(); },[scraperId]);

  const loadRoutes = async () => {
    setLoading(true);
    try { const r = await getApiRoutes(scraperId); setRoutes(r.routes||[]); }
    catch { /* silent */ }
    finally { setLoading(false); }
  };

  const handleCreate = async () => {
    setCreating(true);
    try {
      const slug = formName.toLowerCase().replace(/\s+/g,"-")||scraperId;
      const res  = await createApiRoute(scraperId, {
        name:formName||scraperName, category:formCat,
        method:formMethod, path:`/api/run/${slug}`,
        description:formDesc||`Scraper route untuk ${scraperName}`,
        params:formParams,
      });
      setRoutes(p=>[...p,res.route]);
      setShowForm(false);
      addToast("success",`Route "${res.route.path}" berhasil dibuat!`);
    } catch(e:any){ addToast("error",e.message); }
    finally { setCreating(false); }
  };

  const handleDelete = async (routeId:string) => {
    try {
      await deleteApiRoute(scraperId,routeId);
      setRoutes(p=>p.filter(r=>r.id!==routeId));
      addToast("info","Route dihapus");
    } catch(e:any){ addToast("error",e.message); }
  };

  const buildQS = (params:ApiRoute["params"]|undefined, vals:Record<string,string>) => {
    if(!params) return "";
    type RouteParam = { name: string; type: string; required: boolean; description: string };
    const q = (params as RouteParam[]).filter((p: RouteParam) => Boolean(vals[p.name])).map((p: RouteParam) => `${p.name}=${encodeURIComponent(vals[p.name])}`).join("&");
    return q?`?${q}`:"";
  };

  const handleTest = async (route:ApiRoute) => {
    setActiveTest(route.id);
    const qs      = buildQS(route.params,testQuery);
    const fullUrl = `${window.location.origin}${route.path}${qs}`;
    try {
      const res  = await fetch(fullUrl,{
        method:route.method, headers:{"Content-Type":"application/json"},
        ...(route.method==="POST"?{body:JSON.stringify(testQuery)}:{}),
      });
      const data = await res.json();
      setTestResults(p=>({...p,[route.id]:{ok:res.ok,status:res.status,data}}));
    } catch(e:any){
      setTestResults(p=>({...p,[route.id]:{ok:false,error:e.message}}));
    } finally { setActiveTest(null); }
  };

  const addParam    = () => setFormParams(p=>[...p,{name:"",type:"string",required:false,description:""}]);
  const removeParam = (i:number) => setFormParams(p=>p.filter((_,idx)=>idx!==i));
  const updateParam = (i:number,f:string,v:string|boolean) =>
    setFormParams(p=>p.map((pm,idx)=>idx===i?{...pm,[f]:v}:pm));

  return (
    <div style={{display:"flex",flexDirection:"column",gap:12}}>
      {loading && <div style={{color:"var(--muted)",fontFamily:"var(--mono)",fontSize:12}}>⏳ Loading routes...</div>}

      {routes.length===0&&!loading && (
        <div style={{color:"var(--muted)",fontSize:13,padding:"10px 0"}}>
          Belum ada API route. Buat route agar scraper bisa dipanggil via HTTP endpoint dengan query params &amp; di-export sebagai module.
        </div>
      )}

      {routes.map(route=>(
        <div key={route.id} style={{background:"rgba(0,0,0,.3)",border:"1px solid var(--border2)",borderRadius:10,padding:14}}>
          {/* Header */}
          <div style={{display:"flex",gap:8,alignItems:"center",marginBottom:8,flexWrap:"wrap"}}>
            <span style={{
              fontFamily:"var(--mono)",fontSize:10,fontWeight:700,padding:"2px 8px",borderRadius:4,
              background:route.method==="GET"?"rgba(46,255,168,.15)":"rgba(0,194,255,.15)",
              color:route.method==="GET"?"var(--neon)":"var(--neon2)",
              border:`1px solid ${route.method==="GET"?"rgba(46,255,168,.3)":"rgba(0,194,255,.3)"}`,
            }}>{route.method}</span>
            <code style={{fontFamily:"var(--mono)",fontSize:12,color:"var(--text)",flex:1}}>{route.path}</code>
            <span className="badge badge-neutral" style={{fontSize:9}}>{route.category}</span>
            <button onClick={()=>handleDelete(route.id)} style={{
              background:"transparent",border:"1px solid rgba(255,69,96,.2)",borderRadius:5,
              padding:"3px 8px",color:"var(--danger)",fontFamily:"var(--mono)",fontSize:10,cursor:"pointer",
            }}></button>
          </div>
          {route.description && <p style={{fontSize:12,color:"var(--text2)",marginBottom:10}}>{route.description}</p>}

          {/* Query params input */}
          {route.params&&route.params.length>0 && (
            <div style={{marginBottom:10}}>
              <div style={{fontFamily:"var(--mono)",fontSize:10,color:"var(--muted)",letterSpacing:1,textTransform:"uppercase",marginBottom:6}}>
                Query Parameters
              </div>
              <div style={{display:"flex",flexDirection:"column",gap:5}}>
                {route.params.map(p=>(
                  <div key={p.name} style={{display:"flex",gap:8,alignItems:"center"}}>
                    <code style={{fontFamily:"var(--mono)",fontSize:11,color:p.required?"var(--neon)":"var(--text2)",width:80,flexShrink:0}}>
                      {p.name}{p.required?"*":""}
                    </code>
                    <span style={{fontFamily:"var(--mono)",fontSize:10,color:"var(--muted)",width:50}}>{p.type}</span>
                    <input
                      style={{flex:1,background:"rgba(0,0,0,.4)",border:"1px solid var(--border2)",
                        borderRadius:6,padding:"5px 10px",color:"#e0efff",fontFamily:"var(--mono)",fontSize:11,outline:"none"}}
                      placeholder={p.description||`nilai ${p.name}`}
                      value={testQuery[p.name]||""}
                      onChange={e=>setTestQuery(q=>({...q,[p.name]:e.target.value}))}
                    />
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* URL preview */}
          <div style={{
            background:"rgba(0,0,0,.5)",border:"1px solid var(--border)",borderRadius:7,
            padding:"8px 12px",marginBottom:10,fontFamily:"var(--mono)",fontSize:11,wordBreak:"break-all",
          }}>
            <span style={{color:"var(--neon2)"}}>{route.method}</span>{" "}
            <span style={{color:"var(--text2)"}}>{window.location.origin}</span>
            <span style={{color:"var(--neon)"}}>{route.path}</span>
            <span style={{color:"var(--warn)"}}>{buildQS(route.params,testQuery)}</span>
          </div>

          {/* Actions */}
          <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
            <button className="btn btn-secondary" onClick={()=>handleTest(route)} disabled={activeTest===route.id} style={{fontSize:12}}>
              {activeTest===route.id
                ? <><div className="spinner" style={{width:12,height:12}}/> Testing...</>
                : <><Play size={12}/> Test Endpoint</>}
            </button>
            <button className="btn btn-secondary" style={{fontSize:12}}
              onClick={()=>navigator.clipboard.writeText(`${window.location.origin}${route.path}${buildQS(route.params,testQuery)}`)}>
              Copy URL
            </button>
          </div>

          {testResults[route.id] && (
            <div style={{
              marginTop:10,background:"rgba(0,0,0,.5)",whiteSpace:"pre-wrap",
              border:`1px solid ${testResults[route.id].ok?"rgba(46,255,168,.2)":"rgba(255,69,96,.2)"}`,
              borderRadius:8,padding:12,fontFamily:"var(--mono)",fontSize:11,maxHeight:200,overflow:"auto",
              color:testResults[route.id].ok?"var(--neon)":"var(--danger)",
            }}>
              {testResults[route.id].error
                ? ` ${testResults[route.id].error}`
                : `HTTP ${testResults[route.id].status}\n${JSON.stringify(testResults[route.id].data,null,2)}`}
            </div>
          )}
        </div>
      ))}

      <button className="btn btn-secondary" onClick={()=>setShowForm(v=>!v)} style={{alignSelf:"flex-start"}}>
        <Route size={13}/> {showForm?"Tutup Form":"+ Buat API Route"}
      </button>

      {showForm && (
        <div style={{background:"rgba(0,194,255,.04)",border:"1px solid rgba(0,194,255,.18)",borderRadius:12,padding:18}}>
          <div style={{fontFamily:"var(--mono)",fontSize:10,letterSpacing:1.5,color:"var(--neon2)",textTransform:"uppercase",marginBottom:14}}>
            Buat API Route Baru
          </div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:12}}>
            <div className="field">
              <label className="field-label">Nama Route</label>
              <input className="field-input" value={formName} onChange={e=>setFormName(e.target.value)} placeholder="tiktok-scraper"/>
            </div>
            <div className="field">
              <label className="field-label">Kategori</label>
              <input className="field-input" value={formCat} onChange={e=>setFormCat(e.target.value)} placeholder="scraper"/>
            </div>
          </div>
          <div className="field" style={{marginBottom:10}}>
            <label className="field-label">Deskripsi</label>
            <input className="field-input" value={formDesc} onChange={e=>setFormDesc(e.target.value)} placeholder="Deskripsi endpoint..."/>
          </div>
          <div style={{display:"flex",gap:8,marginBottom:12}}>
            {(["GET","POST"] as const).map(m=>(
              <button key={m} onClick={()=>setFormMethod(m)} style={{
                padding:"7px 18px",borderRadius:7,cursor:"pointer",fontFamily:"var(--mono)",fontSize:12,fontWeight:700,
                background:formMethod===m?(m==="GET"?"rgba(46,255,168,.15)":"rgba(0,194,255,.15)"):"rgba(0,0,0,.4)",
                border:`1px solid ${formMethod===m?(m==="GET"?"rgba(46,255,168,.4)":"rgba(0,194,255,.4)"):"var(--border2)"}`,
                color:formMethod===m?(m==="GET"?"var(--neon)":"var(--neon2)"):"var(--muted)",
              }}>{m}</button>
            ))}
          </div>
          <div style={{marginBottom:12}}>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:8}}>
              <label className="field-label" style={{marginBottom:0}}>Query Parameters</label>
              <button className="btn btn-secondary" style={{fontSize:11,padding:"4px 10px"}} onClick={addParam}>+ Param</button>
            </div>
            <div style={{display:"flex",flexDirection:"column",gap:6}}>
              {formParams.map((p,i)=>(
                <div key={i} style={{display:"flex",gap:7,alignItems:"center"}}>
                  <input className="field-input" style={{flex:2,fontSize:11}} placeholder="nama"
                    value={p.name} onChange={e=>updateParam(i,"name",e.target.value)}/>
                  <select
                    value={p.type} onChange={e=>updateParam(i,"type",e.target.value)}
                    style={{background:"rgba(0,0,0,.5)",border:"1px solid var(--border2)",borderRadius:7,
                      padding:"9px 8px",color:"var(--text)",fontFamily:"var(--mono)",fontSize:11,outline:"none"}}>
                    <option value="string">string</option>
                    <option value="number">number</option>
                    <option value="boolean">boolean</option>
                    <option value="url">url</option>
                  </select>
                  <label style={{display:"flex",alignItems:"center",gap:5,cursor:"pointer",fontSize:12,color:"var(--muted)",userSelect:"none",whiteSpace:"nowrap"}}>
                    <input type="checkbox" checked={p.required} onChange={e=>updateParam(i,"required",e.target.checked)} style={{accentColor:"var(--neon)"}}/>
                    wajib
                  </label>
                  <input className="field-input" style={{flex:3,fontSize:11}} placeholder="deskripsi"
                    value={p.description} onChange={e=>updateParam(i,"description",e.target.value)}/>
                  <button onClick={()=>removeParam(i)} style={{background:"transparent",border:"none",color:"var(--danger)",cursor:"pointer",fontSize:16,lineHeight:1,flexShrink:0}}></button>
                </div>
              ))}
            </div>
          </div>
          <button className="btn btn-primary" onClick={handleCreate} disabled={creating}>
            {creating
              ? <><div className="spinner" style={{width:13,height:13}}/> Membuat...</>
              : <><Route size={13}/> Buat Route</>}
          </button>
        </div>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
//  Step0UrlPanel — URL input + Element Scanner dengan checkbox
// ══════════════════════════════════════════════════════════════

const CATEGORY_COLORS: Record<string,string> = {
  headings:   "var(--neon)",
  text:       "var(--text2)",
  links:      "var(--neon2)",
  images:     "var(--neon3)",
  tables:     "var(--warn)",
  lists:      "var(--text2)",
  data:       "var(--neon)",
  forms:      "var(--neon2)",
  meta:       "var(--muted)",
  structured: "var(--warn)",
};

const CATEGORY_LABELS: Record<string,string> = {
  headings:       "Headings",
  text:           "Teks",
  links:          "Links",
  images:         "Gambar",
  tables:         "Tabel",
  lists:          "List",
  data:           "Data",
  forms:          "Form",
  meta:           "Meta/SEO",
  structured:     "JSON-LD",
  movies:         "🎬 Film/Video",
  episodes:       "📺 Episode",
  genres:         "🏷️ Genre",
  latest:         "🆕 Terbaru",
  search:         "🔍 Pencarian",
  player:         "▶️ Player",
  detail:         "📋 Detail",
  pagination:     "📄 Paginasi",
  products:       "🛍️ Produk",
  prices:         "💰 Harga",
  categories:     "🗂️ Kategori",
  articles:       "📰 Artikel",
  article_detail: "📝 Isi Artikel",
  threads:        "💬 Thread",
};

interface Step0Props {
  genUrl: string; setGenUrl: (u:string)=>void;
  loadingAnalyze: boolean; canProceed: boolean;
  handleAnalyze: ()=>void;
  loadTemplates: ()=>void; showTemplates: boolean;
  templates: Template[]; applyTemplate: (t:Template)=>void;
  logs: string[]; showLogs: boolean; setShowLogs: (v:boolean)=>void;
  logRef: React.RefObject<HTMLDivElement>;
  genTarget: string; setGenTarget: (t:string)=>void;
  addToast: (type:any, msg:string)=>void;
  onScanComplete?: (selectors: any[]) => void;
}

function Step0UrlPanel({
  genUrl, setGenUrl, loadingAnalyze, canProceed,
  handleAnalyze, loadTemplates, showTemplates, templates, applyTemplate,
  logs, showLogs, setShowLogs, logRef,
  genTarget, setGenTarget, addToast, onScanComplete,
}: Step0Props) {
  const [scanning,       setScanning]       = useState(false);
  const [scanResult,     setScanResult]     = useState<PrefetchResult|null>(null);
  const [checked,        setChecked]        = useState<Record<string,boolean>>({});
  const [activeCategory, setActiveCategory] = useState<string|null>(null);
  const [previewing,     setPreviewing]     = useState(false);
  const [preview,        setPreview]        = useState<{
    success: boolean; title: string; description: string;
    ogImage: string|null; favicon: string|null; themeColor: string|null;
    siteName: string|null; layer: number; error: string|null;
  }|null>(null);
  const [urlDetect,      setUrlDetect]      = useState<UrlDetectResult|null>(null);

  // Instant URL detect on every valid URL change (debounced)
  useEffect(() => {
    if (!genUrl.trim().startsWith("http")) { setUrlDetect(null); return; }
    const timer = setTimeout(async () => {
      try {
        const res = await detectUrl(genUrl.trim());
        setUrlDetect(res);
      } catch { setUrlDetect(null); }
    }, 400);
    return () => clearTimeout(timer);
  }, [genUrl]);

  const handlePreview = async (urlToPreview: string) => {
    if (!urlToPreview.trim()) return;
    setPreviewing(true); setPreview(null);
    try {
      const res = await previewUrl(urlToPreview.trim());
      setPreview(res);
    } catch { /* silent — preview is non-critical */ }
    finally { setPreviewing(false); }
  };

  const handleScan = async () => {
    if (!genUrl.trim()) { addToast("warn","Masukkan URL terlebih dahulu"); return; }
    setScanning(true); setScanResult(null); setChecked({});
    try {
      const res = await prefetchUrl(genUrl.trim());
      setScanResult(res);
      if (!res.success) addToast("warn", res.error || "Scan gagal, coba Analisa langsung");
      else {
        addToast("success", `${res.elements.length} pola elemen ditemukan di ${res.host}`);
        if (res.elements.length > 0) setActiveCategory(res.elements[0].category);
        // Pass smart selectors with field data up to parent for generate
        if (onScanComplete && res.smartSelectors) onScanComplete(res.smartSelectors);
      }
    } catch(e:any) { addToast("error", e.message); }
    finally { setScanning(false); }
  };

  // Rebuild target dari checked elements
  const toggleEl = (idx: string, target: string, forceVal?: boolean) => {
    setChecked(prev => {
      const next = { ...prev, [idx]: forceVal !== undefined ? forceVal : !prev[idx] };
      const targets = (scanResult?.elements || [])
        .filter((_,i) => next[String(i)])
        .map(e => e.target);
      setGenTarget(targets.join("; "));
      return next;
    });
  };

  const checkedCount = Object.values(checked).filter(Boolean).length;
  const byCategory = scanResult
    ? (scanResult.categories || []).reduce((acc, cat) => {
        acc[cat] = (scanResult.elements || []).filter(e => e.category === cat);
        return acc;
      }, {} as Record<string, PrefetchElement[]>)
    : {};

  return (
    <div style={{display:"flex",flexDirection:"column",gap:14}}>
      {/* ── URL Input Card ── */}
      <div className="card">
        <div className="card-head">
          <Globe size={14} style={{color:"var(--neon2)"}}/>
          <span className="card-tag">Target URL</span>
          <div className="card-dots"><span/><span/><span/></div>
        </div>
        <div className="card-body" style={{display:"flex",flexDirection:"column",gap:12}}>
          <div className="field">
            <label className="field-label">URL Website yang akan di-scrape</label>
            <input className="field-input" type="url"
              placeholder="https://tokopedia.com/product, https://tiktok.com/@user, ..."
              value={genUrl} onChange={e=>{setGenUrl(e.target.value); setScanResult(null); setChecked({}); setPreview(null);}}
              onKeyDown={e=>e.key==="Enter"&&handleScan()}
              onBlur={e=>{ if(e.target.value.startsWith("http")) handlePreview(e.target.value); }}/>
          </div>

          {/* URL Preview card — auto loads on blur */}
          {(previewing || preview) && (
            <div style={{
              display:"flex", alignItems:"flex-start", gap:12,
              padding:"12px 14px", borderRadius:10,
              background:"rgba(0,0,0,.35)", border:"1px solid var(--border2)",
              position:"relative",
            }}>
              {previewing && <div className="spinner" style={{width:14,height:14,flexShrink:0,marginTop:2}}/>}
              {preview?.ogImage && (
                <img
                  src={preview.ogImage}
                  alt="preview"
                  style={{
                    width:120, height:68, objectFit:"cover", borderRadius:7,
                    border:"1px solid var(--border)", flexShrink:0, background:"var(--card)",
                  }}
                  onError={e=>{(e.currentTarget as HTMLImageElement).style.display="none";}}
                />
              )}
              {preview && !preview.ogImage && preview.favicon && (
                <img
                  src={preview.favicon}
                  alt="favicon"
                  style={{width:28,height:28,objectFit:"contain",flexShrink:0,borderRadius:5}}
                  onError={e=>{(e.currentTarget as HTMLImageElement).style.display="none";}}
                />
              )}
              {preview && (
                <div style={{flex:1,minWidth:0}}>
                  <div style={{
                    fontSize:13, fontWeight:600, color:"var(--text)",
                    overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap",
                    marginBottom:3,
                  }}>
                    {preview.title || genUrl}
                  </div>
                  {preview.siteName && (
                    <div style={{fontSize:10,color:"var(--neon2)",fontFamily:"var(--mono)",marginBottom:4}}>
                      {preview.siteName}
                    </div>
                  )}
                  {preview.description && (
                    <div style={{
                      fontSize:11, color:"var(--text2)", lineHeight:1.5,
                      display:"-webkit-box", WebkitLineClamp:2, WebkitBoxOrient:"vertical",
                      overflow:"hidden",
                    }}>
                      {preview.description}
                    </div>
                  )}
                  <div style={{display:"flex",gap:8,marginTop:5,alignItems:"center"}}>
                    <span style={{fontFamily:"var(--mono)",fontSize:9,color:"var(--muted)"}}>
                      Layer {preview.layer}
                    </span>
                    {preview.themeColor && (
                      <span style={{
                        width:10,height:10,borderRadius:"50%",
                        background:preview.themeColor,flexShrink:0,
                        border:"1px solid rgba(255,255,255,.15)",
                      }}/>
                    )}
                    {!preview.success && preview.error && (
                      <span style={{fontSize:10,color:"var(--warn)"}}>Preview gagal — {preview.error}</span>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ── Instant URL Detect Hint ── */}
          {urlDetect && urlDetect.pageType !== "unknown" && urlDetect.pageType !== "general" && (
            <div style={{
              background:"rgba(46,255,168,.04)",border:"1px solid rgba(46,255,168,.18)",
              borderRadius:10,padding:"10px 14px",display:"flex",flexDirection:"column",gap:8,
            }}>
              <div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap"}}>
                <Zap size={11} style={{color:"var(--neon)",flexShrink:0}}/>
                <span style={{fontFamily:"var(--mono)",fontSize:10,color:"var(--neon)",textTransform:"uppercase",letterSpacing:1}}>
                  Smart URL Detect
                </span>
                {urlDetect.platform && (
                  <span className="badge badge-neon" style={{fontSize:9}}>{urlDetect.platform}</span>
                )}
                <span className="badge badge-neutral" style={{fontSize:9}}>{urlDetect.pageType}</span>
              </div>
              {urlDetect.hint && (
                <p style={{fontSize:12,color:"var(--text2)",margin:0}}>{urlDetect.hint}</p>
              )}
              {urlDetect.suggestions && urlDetect.suggestions.length > 0 && (
                <div style={{display:"flex",flexDirection:"column",gap:5}}>
                  <div style={{fontFamily:"var(--mono)",fontSize:9,color:"var(--muted)",textTransform:"uppercase",letterSpacing:1}}>
                    Quick Scraper Suggestions — klik untuk isi target:
                  </div>
                  <div style={{display:"flex",flexWrap:"wrap",gap:6}}>
                    {urlDetect.suggestions.map((s, i) => (
                      <button key={i} onClick={() => setGenTarget(s.desc)}
                        title={s.desc}
                        style={{
                          display:"flex",alignItems:"center",gap:5,
                          padding:"6px 11px",borderRadius:7,cursor:"pointer",
                          background: genTarget===s.desc ? "rgba(46,255,168,.15)" : "rgba(0,0,0,.3)",
                          border:`1px solid ${genTarget===s.desc ? "rgba(46,255,168,.4)" : "var(--border2)"}`,
                          color: genTarget===s.desc ? "var(--neon)" : "var(--text2)",
                          fontSize:11,transition:"all .15s",textAlign:"left",
                        }}>
                        {s.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
            {/* Scan Elements — tidak butuh API key */}
            <button className="btn btn-primary" onClick={handleScan}
              disabled={scanning||!genUrl.trim()}>
              {scanning
                ? <><div className="spinner" style={{width:14,height:14}}/> Scanning...</>
                : <><Box size={14}/> Scan Elemen</>}
            </button>

            {/* Langsung analisa AI */}
            <button className="btn btn-secondary" onClick={handleAnalyze}
              disabled={loadingAnalyze||!genUrl.trim()}>
              {loadingAnalyze
                ? <><div className="spinner" style={{width:14,height:14}}/> Menganalisa...</>
                : <><Zap size={14}/> Analisa dengan AI</>}
            </button>

            <button className="btn btn-secondary" onClick={loadTemplates}>
              <Wand2 size={14}/> Templates
            </button>
          </div>

          {!canProceed && (
            <div className="info-box warn">
              <Shield size={14}/>
              <span style={{fontSize:12}}>Scan Elemen tidak butuh API key. Untuk Analisa AI, masukkan API key di topbar.</span>
            </div>
          )}

          {/* SSE Logs */}
          {logs.length > 0 && (
            <div style={{background:"rgba(0,0,0,.4)",border:"1px solid var(--border2)",borderRadius:9,overflow:"hidden"}}>
              <button onClick={()=>setShowLogs(!showLogs)}
                style={{width:"100%",display:"flex",alignItems:"center",gap:8,padding:"8px 13px",
                  background:"transparent",border:"none",cursor:"pointer",color:"var(--muted)",
                  fontFamily:"var(--mono)",fontSize:10,textAlign:"left"}}>
                <Activity size={11} style={{color:loadingAnalyze?"var(--neon)":"var(--muted)"}}/>
                <span style={{flex:1}}>
                  {loadingAnalyze ? "Proses berjalan..." : "Selesai"} — {logs.length} log
                </span>
                {showLogs ? <ChevronUp size={11}/> : <ChevronDown size={11}/>}
              </button>
              {showLogs && (
                <div ref={logRef} style={{padding:"8px 13px",maxHeight:180,overflowY:"auto",display:"flex",flexDirection:"column",gap:2}}>
                  {logs.map((msg,i)=>(
                    <div key={i} style={{fontFamily:"var(--mono)",fontSize:10.5,lineHeight:1.55,
                      color: msg.includes("selesai")||msg.includes("Berhasil") ? "var(--neon)"
                           : msg.includes("gagal")||msg.includes("Error")     ? "var(--danger)"
                           : msg.includes("bypass")||msg.includes("Layer")    ? "var(--warn)"
                           : msg.includes("AI")||msg.includes("Analisa")      ? "var(--neon2)"
                           : "var(--text2)"}}>
                      {msg}
                    </div>
                  ))}
                  {loadingAnalyze && (
                    <div style={{display:"flex",gap:6,alignItems:"center",marginTop:3}}>
                      <div className="spinner" style={{width:9,height:9,borderWidth:"1.5px"}}/>
                      <span style={{fontFamily:"var(--mono)",fontSize:9.5,color:"var(--muted)"}}>memproses...</span>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* ── Element Scanner Result ── */}
      {scanResult && scanResult.success && scanResult.elements.length > 0 && (
        <div className="card">
          <div className="card-head">
            <CheckSquare size={14} style={{color:"var(--neon)"}}/>
            <span className="card-tag">Pilih Elemen yang Mau Di-scrape</span>
            {checkedCount > 0 && (
              <span style={{marginLeft:6,fontFamily:"var(--mono)",fontSize:10,
                background:"rgba(46,255,168,.12)",color:"var(--neon)",
                padding:"2px 8px",borderRadius:4,border:"1px solid rgba(46,255,168,.25)"}}>
                {checkedCount} dipilih
              </span>
            )}
            <div style={{marginLeft:"auto",display:"flex",gap:6}}>
              <button className="btn btn-ghost btn-sm" onClick={()=>{
                const all: Record<string,boolean> = {};
                scanResult.elements.forEach((_,i)=>{ all[String(i)]=true; });
                setChecked(all);
                setGenTarget(scanResult.elements.map(e=>e.target).join("; "));
              }}>Pilih Semua</button>
              <button className="btn btn-ghost btn-sm" onClick={()=>{
                setChecked({}); setGenTarget("");
              }}>Clear</button>
            </div>
            <div className="card-dots"><span/><span/><span/></div>
          </div>

          {/* Site info */}
          <div style={{padding:"10px 18px",borderBottom:"1px solid var(--border)",
            display:"flex",gap:16,alignItems:"center",background:"rgba(0,0,0,.2)",flexWrap:"wrap"}}>
            <div style={{display:"flex",alignItems:"center",gap:7}}>
              <Globe size={11} style={{color:"var(--muted)"}}/>
              <span style={{fontFamily:"var(--mono)",fontSize:11,color:"var(--neon2)"}}>{scanResult.host}</span>
            </div>
            {scanResult.siteType && (
              <span className="badge badge-neon" style={{fontSize:9,textTransform:"uppercase"}}>
                {scanResult.siteType}
              </span>
            )}
            {scanResult.pageHint && (
              <span style={{fontSize:11,color:"var(--text2)",fontStyle:"italic"}}>{scanResult.pageHint}</span>
            )}
            {scanResult.title && (
              <span style={{fontSize:12,color:"var(--text2)",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",maxWidth:280}}>
                {scanResult.title}
              </span>
            )}
            <span style={{fontFamily:"var(--mono)",fontSize:10,color:"var(--muted)",marginLeft:"auto"}}>
              Layer {scanResult.layer} — {scanResult.elementCount} elemen
            </span>
          </div>

          {/* Smart Scraper Suggestions — quick-pick cards */}
          {scanResult.scraperSuggestions && scanResult.scraperSuggestions.length > 0 && (
            <div style={{padding:"12px 16px",borderBottom:"1px solid var(--border)",
              background:"rgba(46,255,168,.02)"}}>
              <div style={{fontFamily:"var(--mono)",fontSize:9,color:"var(--neon)",
                textTransform:"uppercase",letterSpacing:1.5,marginBottom:8}}>
                ⚡ Smart Suggestions — klik untuk langsung pakai sebagai target
              </div>
              <div style={{display:"flex",flexWrap:"wrap",gap:6}}>
                {scanResult.scraperSuggestions.map((s, i) => (
                  <button key={i} onClick={() => setGenTarget(s.desc)}
                    title={s.desc}
                    style={{
                      padding:"6px 12px",borderRadius:8,cursor:"pointer",
                      background: genTarget===s.desc ? "rgba(46,255,168,.15)" : "rgba(0,0,0,.35)",
                      border:`1px solid ${genTarget===s.desc ? "rgba(46,255,168,.45)" : "var(--border2)"}`,
                      color: genTarget===s.desc ? "var(--neon)" : "var(--text2)",
                      fontSize:11.5,transition:"all .15s",
                    }}>
                    {s.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div style={{display:"flex",height:"auto"}}>
            {/* Category tabs - left */}
            <div style={{width:150,flexShrink:0,borderRight:"1px solid var(--border)",
              display:"flex",flexDirection:"column",padding:"8px 6px",gap:2}}>
              {Object.keys(byCategory).map(cat => {
                const items = byCategory[cat];
                const catChecked = items.filter((_,i) => {
                  const globalIdx = scanResult.elements.findIndex(e=>e===items[i]);
                  return checked[String(globalIdx)];
                }).length;
                return (
                  <button key={cat} onClick={()=>setActiveCategory(cat)}
                    style={{display:"flex",alignItems:"center",gap:7,padding:"7px 9px",borderRadius:8,
                      background:activeCategory===cat?"rgba(46,255,168,.07)":"transparent",
                      border:`1px solid ${activeCategory===cat?"rgba(46,255,168,.2)":"transparent"}`,
                      cursor:"pointer",textAlign:"left",transition:"all .15s"}}>
                    <span style={{width:7,height:7,borderRadius:"50%",flexShrink:0,
                      background:CATEGORY_COLORS[cat]||"var(--muted)"}}/>
                    <span style={{fontFamily:"var(--mono)",fontSize:10,
                      color:activeCategory===cat?"var(--neon)":"var(--text2)",flex:1,
                      overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
                      {CATEGORY_LABELS[cat]||cat}
                    </span>
                    <span style={{fontFamily:"var(--mono)",fontSize:9,color:"var(--muted)"}}>
                      {catChecked>0 ? <span style={{color:"var(--neon)"}}>{catChecked}/</span> : ""}{items.length}
                    </span>
                  </button>
                );
              })}
            </div>

            {/* Elements list - right */}
            <div style={{flex:1,padding:"12px 14px",display:"flex",flexDirection:"column",gap:8,
              maxHeight:380,overflowY:"auto"}}>
              {activeCategory && byCategory[activeCategory]
                ? byCategory[activeCategory].map((el) => {
                    const globalIdx = String(scanResult.elements.indexOf(el));
                    const isChecked = !!checked[globalIdx];
                    return (
                      <label key={globalIdx} style={{display:"flex",gap:10,alignItems:"flex-start",
                        padding:"10px 12px",borderRadius:9,cursor:"pointer",
                        background:isChecked?"rgba(46,255,168,.05)":"rgba(0,0,0,.25)",
                        border:`1px solid ${isChecked?"rgba(46,255,168,.25)":"var(--border)"}`,
                        transition:"all .15s"}}>
                        <input type="checkbox" checked={isChecked}
                          onChange={()=>toggleEl(globalIdx, el.target)}
                          style={{accentColor:"var(--neon)",marginTop:2,flexShrink:0}}/>
                        <div style={{flex:1,minWidth:0}}>
                          <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:5}}>
                            <span style={{fontFamily:"var(--mono)",fontSize:11,fontWeight:600,
                              color:isChecked?"var(--neon)":"var(--text)"}}>
                              {el.label}
                            </span>
                            <code style={{fontFamily:"var(--mono)",fontSize:9,color:"var(--muted)",
                              background:"rgba(0,0,0,.4)",padding:"1px 6px",borderRadius:3}}>
                              {el.selector.length>30 ? el.selector.substring(0,30)+"…" : el.selector}
                            </code>
                          </div>
                          {/* Preview items */}
                          <div style={{display:"flex",flexDirection:"column",gap:3}}>
                            {el.preview.slice(0,3).map((p,pi)=>(
                              <div key={pi} style={{fontSize:11,color:"var(--text2)",
                                fontFamily:"var(--mono)",lineHeight:1.4,
                                overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",
                                paddingLeft:4,borderLeft:"2px solid var(--border2)"}}>
                                {p}
                              </div>
                            ))}
                          </div>
                        </div>
                      </label>
                    );
                  })
                : <div style={{color:"var(--muted)",fontSize:12,padding:16}}>Pilih kategori di kiri</div>
              }
            </div>
          </div>

          {/* Target preview + Analisa button */}
          {checkedCount > 0 && (
            <div style={{padding:"12px 18px",borderTop:"1px solid var(--border)",
              display:"flex",gap:12,alignItems:"flex-start",background:"rgba(0,0,0,.2)"}}>
              <div style={{flex:1}}>
                <div style={{fontFamily:"var(--mono)",fontSize:9,color:"var(--muted)",
                  textTransform:"uppercase",letterSpacing:1.5,marginBottom:5}}>
                  Target yang akan di-scrape
                </div>
                <div style={{fontSize:12,color:"var(--text2)",lineHeight:1.55}}>
                  {genTarget.substring(0,200)}{genTarget.length>200?"…":""}
                </div>
              </div>
              <button className="btn btn-primary" onClick={handleAnalyze}
                disabled={loadingAnalyze||!canProceed}>
                {loadingAnalyze
                  ? <><div className="spinner" style={{width:14,height:14}}/> Menganalisa...</>
                  : <><Zap size={14}/> Analisa dengan AI</>}
              </button>
            </div>
          )}
        </div>
      )}

      {/* Scan failed fallback */}
      {scanResult && !scanResult.success && (
        <div className="info-box warn">
          <Shield size={14}/>
          <div>
            <div style={{fontSize:12,fontWeight:600}}>{scanResult.error}</div>
            {scanResult.hint && <div style={{fontSize:11,marginTop:3,color:"var(--text2)"}}>{scanResult.hint}</div>}
          </div>
        </div>
      )}

      {/* Templates */}
      {showTemplates && templates.length>0 && (
        <div className="card">
          <div className="card-head">
            <Wand2 size={14} style={{color:"var(--neon3)"}}/>
            <span className="card-tag">Scraper Templates</span>
            <div className="card-dots"><span/><span/><span/></div>
          </div>
          <div className="card-body">
            <div className="template-grid">
              {templates.map(t=>(
                <button key={t.id} onClick={()=>applyTemplate(t)} className="template-card">
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
                    <span style={{fontFamily:"var(--mono)",fontSize:12,color:"var(--text)",fontWeight:600}}>{t.name}</span>
                    <span className={`badge badge-${t.lang==="nodejs"?"neon":t.lang==="python"?"blue":"purple"}`}>{t.lang}</span>
                  </div>
                  <p style={{fontSize:11,color:"var(--muted)",lineHeight:1.5}}>{t.description}</p>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
