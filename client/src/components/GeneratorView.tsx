import { useState } from "react";
import {
  Globe, Zap, Code2, CheckCircle, ArrowRight, ArrowLeft,
  RefreshCw, Wand2, Package, Shield, ShieldOff,
  Route, Terminal, Play, PlusCircle, Box, Cpu
} from "lucide-react";
import { useStore } from "../store";
import { analyzeUrl, generateScraper, getTemplates, tryScraper, createApiRoute, installDeps } from "../api";
import { FirewallInfo } from "./FirewallInfo";
import { CodeBlock } from "./CodeBlock";
import type { Template, Lang, ApiRoute } from "../types";

const STEPS = [
  { id: 0, label: "URL" },
  { id: 1, label: "Analisa" },
  { id: 2, label: "Konfigurasi" },
  { id: 3, label: "Hasil" },
];

const LANG_OPTIONS: { value: Lang; label: string; sub: string }[] = [
  { value: "nodejs", label: "Node.js", sub: "axios + cheerio / puppeteer" },
  { value: "python", label: "Python",  sub: "requests + beautifulsoup4" },
  { value: "php",    label: "PHP",     sub: "cURL + DOMDocument" },
];

const COMPLEXITY_COLOR: Record<string, string> = {
  simple:   "var(--neon)",
  moderate: "var(--neon2)",
  complex:  "var(--warn)",
};

export function GeneratorView() {
  const {
    provider, apiKey, model,
    genStep, genUrl, genAnalysis, genTarget, genLang, genBypassCF, genResult,
    setGenStep, setGenUrl, setGenAnalysis, setGenTarget, setGenLang, setGenBypassCF, setGenResult,
    resetGen, addToast,
  } = useStore();

  const [loadingAnalyze,  setLoadingAnalyze]  = useState(false);
  const [loadingGenerate, setLoadingGenerate] = useState(false);
  const [templates,       setTemplates]       = useState<Template[]>([]);
  const [showTemplates,   setShowTemplates]   = useState(false);

  // v4: Module install from analysis
  const [installingModule, setInstallingModule] = useState<string | null>(null);
  const [moduleInstalled,  setModuleInstalled]  = useState<Record<string, boolean>>({});

  // v4: Try output
  const [tryLoading,    setTryLoading]    = useState(false);
  const [tryResult,     setTryResult]     = useState<any>(null);
  const [tryInputs,     setTryInputs]     = useState<Record<string, string>>({});
  const [makeApiRoute,  setMakeApiRoute]  = useState(false);
  const [routeCategory, setRouteCategory] = useState("scraper");
  const [routeName,     setRouteName]     = useState("");
  const [createdRoute,  setCreatedRoute]  = useState<ApiRoute | null>(null);
  const [routeLoading,  setRouteLoading]  = useState(false);

  // v4: Auto install (Step 3)
  const [installLoading, setInstallLoading] = useState(false);
  const [installResult,  setInstallResult]  = useState<{ success: boolean; message: string; output: string } | null>(null);

  const canProceed = !!apiKey.trim();

  // ── Step 0: URL input ─────────────────────────────────────
  const handleAnalyze = async () => {
    if (!genUrl.trim()) { addToast("warn", "Masukkan URL target terlebih dahulu"); return; }
    if (!canProceed)    { addToast("warn", "Masukkan API Key di topbar terlebih dahulu"); return; }
    setLoadingAnalyze(true);
    try {
      const res = await analyzeUrl(genUrl.trim(), provider, apiKey, model || undefined);
      setGenAnalysis(res);
      setGenBypassCF(res.firewall.bypass_recommended);
      setGenStep(1);
    } catch (e: any) {
      addToast("error", e.message || "Gagal analisa URL");
    } finally {
      setLoadingAnalyze(false);
    }
  };

  const loadTemplates = async () => {
    if (templates.length) { setShowTemplates(p => !p); return; }
    try {
      const res = await getTemplates();
      setTemplates(res.templates);
      setShowTemplates(true);
    } catch { addToast("error", "Gagal load templates"); }
  };

  const applyTemplate = (t: Template) => {
    setGenUrl(t.example_url);
    setGenTarget(t.target);
    setGenLang(t.lang);
    setShowTemplates(false);
    addToast("info", `Template "${t.name}" diterapkan`);
  };

  // ── v4: Install module dari step 1 ───────────────────────
  const handleInstallFromAnalysis = async (lang: Lang, packages: string[], installCmd: string) => {
    if (!genResult?.id) {
      addToast("warn", "Generate scraper dulu sebelum install");
      return;
    }
    const key = `${lang}-${packages.join(",")}`;
    setInstallingModule(key);
    try {
      const res = await installDeps(genResult.id, packages);
      if (res.success) {
        setModuleInstalled(p => ({ ...p, [key]: true }));
        addToast("success", res.message);
      } else {
        addToast("warn", res.message || "Install gagal");
      }
    } catch (e: any) {
      addToast("error", e.message || "Install gagal");
    } finally {
      setInstallingModule(null);
    }
  };

  // ── Step 1: Pick target ───────────────────────────────────
  const goToConfig = () => {
    if (!genTarget.trim()) { addToast("warn", "Pilih atau tulis target data terlebih dahulu"); return; }
    setGenStep(2);
  };

  // ── Step 2: Generate ──────────────────────────────────────
  const handleGenerate = async () => {
    if (!genTarget.trim()) { addToast("warn", "Target data belum diisi"); return; }
    if (!canProceed)       { addToast("warn", "API Key belum diisi"); return; }
    setLoadingGenerate(true);
    try {
      const res = await generateScraper({
        url: genUrl, target: genTarget, lang: genLang,
        bypassCF: genBypassCF, provider, apiKey, model: model || undefined,
      });
      setGenResult({ id: res.id, code: res.code, trySchema: res.trySchema });
      setGenStep(3);
      addToast("success", "Scraper berhasil di-generate!");
      try {
        const host = new URL(genUrl).hostname.replace("www.", "").replace(/\./g, "-");
        setRouteName(`${host}-scraper`);
      } catch { setRouteName("scraper"); }
    } catch (e: any) {
      addToast("error", e.message || "Gagal generate scraper");
    } finally {
      setLoadingGenerate(false);
    }
  };

  // ── v4: Try Output ────────────────────────────────────────
  const handleTry = async () => {
    if (!genResult?.id) return;
    setTryLoading(true); setTryResult(null);
    try {
      const res = await tryScraper(genResult.id, tryInputs);
      setTryResult(res.preview);
    } catch (e: any) {
      addToast("error", e.message || "Try gagal");
    } finally {
      setTryLoading(false);
    }
  };

  // ── v4: Create API Route ──────────────────────────────────
  const handleCreateRoute = async () => {
    if (!genResult?.id || !routeName.trim()) { addToast("warn", "Isi nama route"); return; }
    setRouteLoading(true);
    try {
      const slug = routeName.trim().toLowerCase().replace(/\s+/g,"-").replace(/[^a-z0-9-]/g,"");
      const res  = await createApiRoute(genResult.id, {
        name: slug, category: routeCategory, method: "GET",
        path: `/api/generated/${routeCategory}/${slug}`,
        description: `Scraper endpoint untuk ${genUrl} — target: ${genTarget}`,
        params: (genResult.trySchema||[]).map(f => ({ name:f.name, type:f.type, required:f.required, description:f.label })),
      });
      setCreatedRoute(res.route);
      addToast("success", `API Route dibuat: ${res.route.path}`);
    } catch (e: any) {
      addToast("error", e.message || "Gagal buat route");
    } finally {
      setRouteLoading(false);
    }
  };

  // ── v4: Auto Install di Step 3 ────────────────────────────
  const handleAutoInstall = async () => {
    if (!genResult?.id) return;
    setInstallLoading(true); setInstallResult(null);
    try {
      // Pakai AI-recommended packages jika ada dari analysis
      const recs = genAnalysis?.ai?.recommended_modules;
      const pkgs = recs ? recs[genLang]?.packages : undefined;
      const res  = await installDeps(genResult.id, pkgs);
      setInstallResult(res);
      if (res.success) addToast("success", "Dependencies berhasil diinstall!");
      else addToast("warn", res.message);
    } catch (e: any) {
      addToast("error", e.message || "Install gagal");
    } finally {
      setInstallLoading(false);
    }
  };

  // ── Render recommended modules card ──────────────────────

  return (
    <div>
      {/* Step Bar */}
      <div className="stepbar">
        {STEPS.map((s, idx) => (
          <>
            <div key={s.id} className={`step-item ${genStep > s.id ? "done" : genStep === s.id ? "active" : ""}`}>
              <div className="step-circle">
                {genStep > s.id ? <CheckCircle size={13} /> : s.id + 1}
              </div>
              <span className="step-label">{s.label}</span>
            </div>
            {idx < STEPS.length - 1 && <div className="step-line" />}
          </>
        ))}
      </div>

      {/* ── Step 0: URL ───────────────────────────────────── */}
      {genStep === 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div className="card">
            <div className="card-head">
              <Globe size={14} style={{ color: "var(--neon2)" }} />
              <span className="card-tag">Target URL</span>
              <div className="card-dots"><span /><span /><span /></div>
            </div>
            <div className="card-body" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <div className="field">
                <label className="field-label">URL Website yang akan di-scrape</label>
                <input
                  className="field-input"
                  type="url"
                  placeholder="https://tokopedia.com/product, https://news.ycombinator.com, ..."
                  value={genUrl}
                  onChange={e => setGenUrl(e.target.value)}
                  onKeyDown={e => e.key === "Enter" && handleAnalyze()}
                />
              </div>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                <button className="btn btn-primary" onClick={handleAnalyze} disabled={loadingAnalyze || !genUrl.trim()}>
                  {loadingAnalyze
                    ? <><div className="spinner" style={{ width: 15, height: 15 }} /> Menganalisa...</>
                    : <><Zap size={15} /> Analisa URL</>}
                </button>
                <button className="btn btn-secondary" onClick={loadTemplates}>
                  <Wand2 size={15} /> Templates
                </button>
              </div>
              {!canProceed && (
                <div className="info-box warn"><Shield size={15} /><span>Masukkan API Key di topbar terlebih dahulu.</span></div>
              )}
            </div>
          </div>

          {showTemplates && templates.length > 0 && (
            <div className="card">
              <div className="card-head">
                <Wand2 size={14} style={{ color: "var(--neon3)" }} />
                <span className="card-tag">Scraper Templates</span>
                <div className="card-dots"><span /><span /><span /></div>
              </div>
              <div className="card-body">
                <div className="template-grid">
                  {templates.map(t => (
                    <button key={t.id} onClick={() => applyTemplate(t)} className="template-card">
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                        <span style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--text)", fontWeight: 600 }}>{t.name}</span>
                        <span className={`badge badge-${t.lang === "nodejs" ? "neon" : t.lang === "python" ? "blue" : "purple"}`}>{t.lang}</span>
                      </div>
                      <p style={{ fontSize: 11, color: "var(--muted)", lineHeight: 1.5 }}>{t.description}</p>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Step 1: Analyze Result ─── */}
      {genStep === 1 && genAnalysis && (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div className="card">
            <div className="card-head">
              <Zap size={14} style={{ color: "var(--neon)" }} />
              <span className="card-tag">AI Analysis</span>
              {genAnalysis.ai.site_type && (
                <span className="badge badge-neutral" style={{ marginLeft: "auto" }}>{genAnalysis.ai.site_type}</span>
              )}
              <div className="card-dots"><span /><span /><span /></div>
            </div>
            <div className="card-body" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <p style={{ fontSize: 13, color: "var(--text2)", lineHeight: 1.7 }}>{genAnalysis.ai.greeting}</p>
              <p style={{ fontSize: 13, color: "var(--text)", fontWeight: 600 }}>{genAnalysis.ai.question}</p>
              <div className="field">
                <label className="field-label">Target Data (ketik sendiri atau pilih saran)</label>
                <textarea
                  className="field-textarea"
                  placeholder="Contoh: nama produk, harga, rating, jumlah review, URL gambar utama..."
                  value={genTarget}
                  onChange={e => setGenTarget(e.target.value)}
                  rows={3}
                />
              </div>
              <div className="suggestion-grid">
                {genAnalysis.ai.suggestions.map((s, i) => (
                  <button key={i} className={`suggestion-chip ${genTarget === s ? "selected" : ""}`} onClick={() => setGenTarget(s)}>{s}</button>
                ))}
              </div>
            </div>
          </div>

          {/* ── v4: REKOMENDASI MODULE AI ── */}
          {genAnalysis.ai.recommended_modules && (
            <div className="card">
              <div className="card-head">
                <Box size={14} style={{ color: "var(--neon3)" }} />
                <span className="card-tag">Rekomendasi Module AI</span>
                <span className="badge badge-purple" style={{ marginLeft: "auto", fontSize: 9 }}>v4 auto detect</span>
                <div className="card-dots"><span /><span /><span /></div>
              </div>
              <div className="card-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                {genAnalysis.ai.complexity && (
                  <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                    <Cpu size={12} style={{ color: "var(--muted)" }} />
                    <span style={{ fontSize: 11, color: "var(--muted)" }}>Kompleksitas:</span>
                    <span style={{ fontFamily: "var(--mono)", fontSize: 11, fontWeight: 700, color: COMPLEXITY_COLOR[genAnalysis.ai.complexity] || "var(--text2)" }}>
                      {genAnalysis.ai.complexity.toUpperCase()}
                    </span>
                    {genAnalysis.ai.complexity_reason && (
                      <span style={{ fontSize: 11, color: "var(--text2)" }}>— {genAnalysis.ai.complexity_reason}</span>
                    )}
                  </div>
                )}

                {/* Module per language */}
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  {(["nodejs","python","php"] as Lang[]).map(l => {
                    const rec = genAnalysis.ai.recommended_modules![l];
                    if (!rec) return null;
                    const isActive = genLang === l;
                    return (
                      <div key={l} className={`module-rec-item ${isActive ? "active" : ""}`} onClick={() => setGenLang(l)}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                            <span className={`badge badge-${l === "nodejs" ? "neon" : l === "python" ? "blue" : "purple"}`}>{l}</span>
                            {isActive && <span style={{ fontSize: 10, color: "var(--neon)", fontFamily: "var(--mono)" }}>← selected</span>}
                          </div>
                          <div style={{ display: "flex", gap: 5, flexWrap: "wrap", justifyContent: "flex-end" }}>
                            {rec.packages.map(pkg => (
                              <span key={pkg} className="module-pkg-badge"><Package size={9} />{pkg}</span>
                            ))}
                          </div>
                        </div>
                        <p style={{ fontSize: 11, color: "var(--text2)", marginBottom: 6 }}>💡 {rec.reason}</p>
                        <code className="module-cmd" style={{ fontSize: 10 }}>{rec.install_cmd}</code>
                        <p style={{ fontSize: 10, color: "var(--muted)", marginTop: 4 }}>
                          Klik untuk pilih bahasa ini. Install otomatis setelah generate.
                        </p>
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
                ? <Shield size={14} style={{ color: "var(--danger)" }} />
                : <ShieldOff size={14} style={{ color: "var(--neon)" }} />}
              <span className="card-tag">Firewall Detection</span>
              <div className="card-dots"><span /><span /><span /></div>
            </div>
            <div className="card-body"><FirewallInfo fw={genAnalysis.firewall} /></div>
          </div>

          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <button className="btn btn-secondary" onClick={() => setGenStep(0)}><ArrowLeft size={15} /> Kembali</button>
            <button className="btn btn-primary" onClick={goToConfig} disabled={!genTarget.trim()}>
              Konfigurasi <ArrowRight size={15} />
            </button>
          </div>
        </div>
      )}

      {/* ── Step 2: Configure ─── */}
      {genStep === 2 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div className="card">
            <div className="card-head">
              <Code2 size={14} style={{ color: "var(--neon2)" }} />
              <span className="card-tag">Konfigurasi Scraper</span>
              <div className="card-dots"><span /><span /><span /></div>
            </div>
            <div className="card-body" style={{ display: "flex", flexDirection: "column", gap: 18 }}>
              <div className="summary-box">
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <Globe size={12} style={{ color: "var(--muted)" }} />
                  <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--text2)", wordBreak: "break-all" }}>{genUrl}</span>
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <Zap size={12} style={{ color: "var(--muted)", flexShrink: 0, marginTop: 2 }} />
                  <span style={{ fontSize: 12, color: "var(--text2)" }}>{genTarget}</span>
                </div>
              </div>
              <div className="field">
                <label className="field-label">Bahasa Pemrograman</label>
                <div className="lang-selector">
                  {LANG_OPTIONS.map(l => (
                    <button key={l.value} className={`lang-opt ${genLang === l.value ? "active" : ""}`} onClick={() => setGenLang(l.value)}>
                      <span className="lang-opt-label">{l.label}</span>
                      <span className="lang-opt-sub">{l.sub}</span>
                      {genAnalysis?.ai?.recommended_modules?.[l.value] && (
                        <span style={{ fontSize: 9, color: "var(--neon3)", fontFamily: "var(--mono)", marginTop: 2 }}>AI rec ✓</span>
                      )}
                    </button>
                  ))}
                </div>
              </div>
              <div className="toggle-row">
                <div className="toggle-info">
                  <div className="toggle-title">Bypass Cloudflare / WAF Mode</div>
                  <div className="toggle-desc">Gunakan puppeteer stealth (Node.js) atau cloudscraper (Python) jika site terproteksi.</div>
                </div>
                <button className={`toggle ${genBypassCF ? "on" : ""}`} onClick={() => setGenBypassCF(!genBypassCF)}>
                  <div className="toggle-knob" />
                </button>
              </div>
              {genBypassCF && (
                <div className="info-box warn"><Shield size={15} /><span>Bypass mode aktif. Butuh library tambahan — akan diinstall otomatis setelah generate.</span></div>
              )}
            </div>
          </div>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <button className="btn btn-secondary" onClick={() => setGenStep(1)}><ArrowLeft size={15} /> Kembali</button>
            <button className="btn btn-primary" onClick={handleGenerate} disabled={loadingGenerate} style={{ flex: 1 }}>
              {loadingGenerate
                ? <><div className="spinner" style={{ width: 15, height: 15 }} /> AI sedang generate kode...</>
                : <><Zap size={15} /> Generate Scraper</>}
            </button>
          </div>
          {loadingGenerate && (
            <div className="info-box info">
              <div className="spinner" style={{ width: 13, height: 13, borderWidth: "1.5px", flexShrink: 0 }} />
              <span>AI sedang menulis kode scraper. Bisa 30–90 detik...</span>
            </div>
          )}
        </div>
      )}

      {/* ── Step 3: Result ─── */}
      {genStep === 3 && genResult && (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div className="info-box neon">
            <CheckCircle size={15} />
            <span>Scraper berhasil di-generate! Download dan jalankan di lokal / server / Termux.</span>
          </div>

          <div className="card">
            <div className="card-head">
              <Code2 size={14} style={{ color: "var(--neon)" }} />
              <span className="card-tag">Generated Code</span>
              <div className="card-dots"><span /><span /><span /></div>
            </div>
            <div className="card-body">
              <CodeBlock code={genResult.code} lang={genLang} scraperId={genResult.id} />
            </div>
          </div>

          {/* ── v4: AUTO INSTALL (pakai AI recommendation) ── */}
          <div className="card">
            <div className="card-head">
              <Terminal size={14} style={{ color: "var(--neon2)" }} />
              <span className="card-tag">Auto Install Dependencies</span>
              {genAnalysis?.ai?.recommended_modules?.[genLang] && (
                <span className="badge badge-neon" style={{ marginLeft: "auto", fontSize: 9 }}>AI recommended</span>
              )}
              <div className="card-dots"><span /><span /><span /></div>
            </div>
            <div className="card-body" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {genAnalysis?.ai?.recommended_modules?.[genLang] && (
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                  <span style={{ fontSize: 11, color: "var(--muted)" }}>Akan install:</span>
                  {genAnalysis.ai.recommended_modules[genLang].packages.map(p => (
                    <span key={p} className="module-pkg-badge"><Package size={9} />{p}</span>
                  ))}
                </div>
              )}
              <button
                className="btn btn-secondary"
                onClick={handleAutoInstall}
                disabled={installLoading}
                style={{ alignSelf: "flex-start" }}
              >
                {installLoading
                  ? <><div className="spinner" style={{ width: 13, height: 13 }} /> Installing...</>
                  : <><Terminal size={13} /> Auto Install Modules</>}
              </button>
              {installResult && (
                <div className={`info-box ${installResult.success ? "neon" : "warn"}`} style={{ flexDirection: "column", alignItems: "flex-start" }}>
                  <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <CheckCircle size={14} />
                    <span style={{ fontWeight: 600, fontSize: 12 }}>{installResult.message}</span>
                  </div>
                  {installResult.output && (
                    <pre className="install-output">{installResult.output}</pre>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* ── v4: TRY OUTPUT ── */}
          <div className="card">
            <div className="card-head">
              <Play size={14} style={{ color: "var(--neon3)" }} />
              <span className="card-tag">Try Output</span>
              <span className="badge badge-neon" style={{ marginLeft: "auto", fontSize: 9 }}>v4</span>
              <div className="card-dots"><span /><span /><span /></div>
            </div>
            <div className="card-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {(genResult.trySchema || []).map(field => (
                <div className="field" key={field.name}>
                  <label className="field-label">
                    {field.label}
                    {field.required && <span style={{ color: "var(--danger)", marginLeft: 4 }}>*</span>}
                  </label>
                  <input
                    className="field-input"
                    type={field.type}
                    placeholder={field.placeholder}
                    value={tryInputs[field.name] || ""}
                    onChange={e => setTryInputs(p => ({ ...p, [field.name]: e.target.value }))}
                  />
                </div>
              ))}
              <button className="btn btn-secondary" onClick={handleTry} disabled={tryLoading} style={{ alignSelf: "flex-start" }}>
                {tryLoading
                  ? <><div className="spinner" style={{ width: 13, height: 13 }} /> Mengecek...</>
                  : <><Play size={13} /> Run Try Output</>}
              </button>

              {tryResult && (
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  <div className="try-output-card">
                    {[
                      { k: "Target",  v: tryResult.target },
                      { k: "Command", v: tryResult.run_command, mono: true },
                      { k: "Lines",   v: `${tryResult.code_lines} baris` },
                      { k: "Firewall",v: tryResult.firewall_check?.bypass_recommended ? "⚠ Detected" : "✓ Clear",
                        color: tryResult.firewall_check?.bypass_recommended ? "var(--warn)" : "var(--neon)" },
                    ].map(row => (
                      <div className="try-output-row" key={row.k}>
                        <span className="try-key">{row.k}</span>
                        {row.mono
                          ? <code className="try-code">{row.v}</code>
                          : <span className="try-val" style={row.color ? { color: row.color } : {}}>{row.v}</span>}
                      </div>
                    ))}
                    <div className="try-output-row" style={{ alignItems: "flex-start" }}>
                      <span className="try-key">Preview</span>
                      <pre className="try-preview">{tryResult.code_preview}</pre>
                    </div>
                    <p style={{ fontSize: 11, color: "var(--muted)", marginTop: 4 }}>{tryResult.note}</p>
                  </div>

                  {/* ── v4: JADIKAN API ROUTE CHECKBOX ── */}
                  <div className="api-route-toggle">
                    <label className="api-route-check-label">
                      <input
                        type="checkbox"
                        checked={makeApiRoute}
                        onChange={e => setMakeApiRoute(e.target.checked)}
                        className="api-route-checkbox"
                      />
                      <Route size={13} style={{ color: "var(--neon3)" }} />
                      <span style={{ fontSize: 12, fontWeight: 600 }}>Jadikan API Route</span>
                      <span className="badge badge-purple" style={{ fontSize: 9 }}>auto add</span>
                    </label>
                    <p style={{ fontSize: 11, color: "var(--muted)", marginLeft: 26 }}>
                      Auto add ke <code style={{ fontFamily: "var(--mono)", color: "var(--neon2)", fontSize: 10 }}>/api/generated/kategori/fitur</code>
                    </p>
                  </div>

                  {makeApiRoute && !createdRoute && (
                    <div className="api-route-config">
                      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                        <div className="field" style={{ flex: 1, minWidth: 130 }}>
                          <label className="field-label">Kategori</label>
                          <input className="field-input" placeholder="scraper / ecommerce..." value={routeCategory}
                            onChange={e => setRouteCategory(e.target.value.toLowerCase().replace(/\s+/g,"-"))} />
                        </div>
                        <div className="field" style={{ flex: 2, minWidth: 160 }}>
                          <label className="field-label">Nama Route</label>
                          <input className="field-input" placeholder="get-products / scrape-news..." value={routeName}
                            onChange={e => setRouteName(e.target.value.toLowerCase().replace(/\s+/g,"-"))} />
                        </div>
                      </div>
                      <div className="api-route-preview-path">
                        <Route size={11} style={{ color: "var(--neon3)", flexShrink: 0 }} />
                        <code style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--neon2)" }}>
                          GET /api/generated/{routeCategory||"kategori"}/{routeName||"nama-route"}
                        </code>
                      </div>
                      <button className="btn btn-primary btn-sm" onClick={handleCreateRoute} disabled={routeLoading || !routeName.trim()}
                        style={{ alignSelf: "flex-start" }}>
                        {routeLoading
                          ? <><div className="spinner" style={{ width: 12, height: 12 }} /> Membuat...</>
                          : <><PlusCircle size={12} /> Tambah ke API Routes</>}
                      </button>
                    </div>
                  )}

                  {createdRoute && (
                    <div className="info-box neon">
                      <Route size={14} />
                      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                        <span style={{ fontWeight: 600, fontSize: 12 }}>API Route berhasil dibuat!</span>
                        <code style={{ fontFamily: "var(--mono)", fontSize: 11 }}>{createdRoute.method} {createdRoute.path}</code>
                        <span style={{ fontSize: 11, color: "var(--text2)" }}>Lihat di tab API Docs → Generated Routes</span>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <button className="btn btn-primary" onClick={resetGen}><RefreshCw size={14} /> Buat Baru</button>
            <button className="btn btn-secondary" onClick={() => useStore.getState().setView("scrapers")}>Lihat Scrapers</button>
            <button className="btn btn-secondary" onClick={() => { useStore.getState().setFixScraperId(genResult.id); useStore.getState().setView("fix"); }}>
              <Wand2 size={14} /> Fix Engine
            </button>
            <button className="btn btn-secondary" onClick={() => useStore.getState().setView("docs")}>
              <Route size={14} /> API Docs
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
