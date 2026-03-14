import { useState } from "react";
import {
  Globe, Zap, Code2, CheckCircle, ArrowRight, ArrowLeft,
  RefreshCw, RotateCcw, Wand2, Package, Download, Shield, ShieldOff
} from "lucide-react";
import { useStore } from "../store";
import { analyzeUrl, generateScraper, getTemplates } from "../api";
import { FirewallInfo } from "./FirewallInfo";
import { CodeBlock } from "./CodeBlock";
import type { Template, Lang } from "../types";

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

  // ── Step 1: Pick target ───────────────────────────────────
  const handlePickTarget = (suggestion: string) => {
    setGenTarget(suggestion);
  };

  const goToConfig = () => {
    if (!genTarget.trim()) { addToast("warn", "Pilih atau tulis target data terlebih dahulu"); return; }
    setGenStep(2);
  };

  // ── Step 2: Configure & Generate ─────────────────────────
  const handleGenerate = async () => {
    if (!genTarget.trim()) { addToast("warn", "Target data belum diisi"); return; }
    if (!canProceed)       { addToast("warn", "API Key belum diisi"); return; }

    setLoadingGenerate(true);
    try {
      const res = await generateScraper({
        url:      genUrl,
        target:   genTarget,
        lang:     genLang,
        bypassCF: genBypassCF,
        provider,
        apiKey,
        model: model || undefined,
      });
      setGenResult({ id: res.id, code: res.code });
      setGenStep(3);
      addToast("success", "Scraper berhasil di-generate!");
    } catch (e: any) {
      addToast("error", e.message || "Gagal generate scraper");
    } finally {
      setLoadingGenerate(false);
    }
  };

  return (
    <div>
      {/* Step Bar */}
      <div className="stepbar">
        {STEPS.map((s, idx) => (
          <>
            <div
              key={s.id}
              className={`step-item ${genStep > s.id ? "done" : genStep === s.id ? "active" : ""}`}
            >
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
                  placeholder="https://www.tokopedia.com/product, https://news.ycombinator.com, ..."
                  value={genUrl}
                  onChange={e => setGenUrl(e.target.value)}
                  onKeyDown={e => e.key === "Enter" && handleAnalyze()}
                />
              </div>

              <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                <button
                  className="btn btn-primary"
                  onClick={handleAnalyze}
                  disabled={loadingAnalyze || !genUrl.trim()}
                >
                  {loadingAnalyze
                    ? <><div className="spinner" style={{ width: 15, height: 15 }} /> Menganalisa...</>
                    : <><Zap size={15} /> Analisa URL</>}
                </button>
                <button className="btn btn-secondary" onClick={loadTemplates}>
                  <Wand2 size={15} /> Templates
                </button>
              </div>

              {!canProceed && (
                <div className="info-box warn">
                  <Shield size={15} />
                  <span>Masukkan API Key di topbar terlebih dahulu sebelum menganalisa.</span>
                </div>
              )}
            </div>
          </div>

          {/* Template Grid */}
          {showTemplates && templates.length > 0 && (
            <div className="card">
              <div className="card-head">
                <Wand2 size={14} style={{ color: "var(--neon3)" }} />
                <span className="card-tag">Scraper Templates</span>
                <div className="card-dots"><span /><span /><span /></div>
              </div>
              <div className="card-body">
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 10 }}>
                  {templates.map(t => (
                    <button
                      key={t.id}
                      onClick={() => applyTemplate(t)}
                      style={{
                        background: "rgba(0,0,0,.3)", border: "1px solid var(--border2)",
                        borderRadius: "var(--radius)", padding: "12px", textAlign: "left",
                        cursor: "pointer", transition: "all .15s",
                      }}
                      onMouseEnter={e => (e.currentTarget.style.borderColor = "var(--neon)")}
                      onMouseLeave={e => (e.currentTarget.style.borderColor = "var(--border2)")}
                    >
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                        <span style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--text)", fontWeight: 600 }}>{t.name}</span>
                        <span className={`badge badge-${t.lang === "nodejs" ? "neon" : t.lang === "python" ? "blue" : "purple"}`}>
                          {t.lang}
                        </span>
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

      {/* ── Step 1: Analyze Result ────────────────────────── */}
      {genStep === 1 && genAnalysis && (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {/* AI Greeting */}
          <div className="card">
            <div className="card-head">
              <Zap size={14} style={{ color: "var(--neon)" }} />
              <span className="card-tag">AI Analysis</span>
              <div className="card-dots"><span /><span /><span /></div>
            </div>
            <div className="card-body" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <p style={{ fontSize: 13, color: "var(--text2)", lineHeight: 1.7 }}>
                {genAnalysis.ai.greeting}
              </p>
              <p style={{ fontSize: 13, color: "var(--text)", fontWeight: 600 }}>
                {genAnalysis.ai.question}
              </p>

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
                  <button
                    key={i}
                    className={`suggestion-chip ${genTarget === s ? "selected" : ""}`}
                    onClick={() => handlePickTarget(s)}
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Firewall */}
          <div className="card">
            <div className="card-head">
              {genAnalysis.firewall.bypass_recommended
                ? <Shield size={14} style={{ color: "var(--danger)" }} />
                : <ShieldOff size={14} style={{ color: "var(--neon)" }} />
              }
              <span className="card-tag">Firewall Detection</span>
              <div className="card-dots"><span /><span /><span /></div>
            </div>
            <div className="card-body">
              <FirewallInfo fw={genAnalysis.firewall} />
            </div>
          </div>

          {/* Actions */}
          <div style={{ display: "flex", gap: 10 }}>
            <button className="btn btn-secondary" onClick={() => setGenStep(0)}>
              <ArrowLeft size={15} /> Kembali
            </button>
            <button className="btn btn-primary" onClick={goToConfig} disabled={!genTarget.trim()}>
              Konfigurasi <ArrowRight size={15} />
            </button>
          </div>
        </div>
      )}

      {/* ── Step 2: Configure ────────────────────────────── */}
      {genStep === 2 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div className="card">
            <div className="card-head">
              <Code2 size={14} style={{ color: "var(--neon2)" }} />
              <span className="card-tag">Konfigurasi Scraper</span>
              <div className="card-dots"><span /><span /><span /></div>
            </div>
            <div className="card-body" style={{ display: "flex", flexDirection: "column", gap: 18 }}>
              {/* Summary */}
              <div style={{
                background: "rgba(0,0,0,.3)", border: "1px solid var(--border)",
                borderRadius: "var(--radius)", padding: "12px 14px",
                display: "flex", flexDirection: "column", gap: 8,
              }}>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <Globe size={12} style={{ color: "var(--muted)" }} />
                  <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--text2)", wordBreak: "break-all" }}>{genUrl}</span>
                </div>
                <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
                  <Zap size={12} style={{ color: "var(--muted)", flexShrink: 0, marginTop: 2 }} />
                  <span style={{ fontSize: 12, color: "var(--text2)" }}>{genTarget}</span>
                </div>
              </div>

              {/* Language */}
              <div className="field">
                <label className="field-label">Bahasa Pemrograman</label>
                <div className="lang-selector">
                  {LANG_OPTIONS.map(l => (
                    <button
                      key={l.value}
                      className={`lang-opt ${genLang === l.value ? "active" : ""}`}
                      onClick={() => setGenLang(l.value)}
                    >
                      <span className="lang-opt-label">{l.label}</span>
                      <span className="lang-opt-sub">{l.sub}</span>
                    </button>
                  ))}
                </div>
              </div>

              {/* Bypass CF toggle */}
              <div className="toggle-row">
                <div className="toggle-info">
                  <div className="toggle-title">Bypass Cloudflare / WAF Mode</div>
                  <div className="toggle-desc">
                    Aktifkan jika website memiliki perlindungan anti-bot (Cloudflare, Imperva, dll).
                    Gunakan puppeteer-extra stealth (Node.js) atau cloudscraper (Python).
                  </div>
                </div>
                <button
                  className={`toggle ${genBypassCF ? "on" : ""}`}
                  onClick={() => setGenBypassCF(!genBypassCF)}
                >
                  <div className="toggle-knob" />
                </button>
              </div>

              {genBypassCF && (
                <div className="info-box warn">
                  <Shield size={15} />
                  <span>Bypass mode aktif. Scraper akan menggunakan stealth techniques. Butuh install library tambahan.</span>
                </div>
              )}
            </div>
          </div>

          {/* Actions */}
          <div style={{ display: "flex", gap: 10 }}>
            <button className="btn btn-secondary" onClick={() => setGenStep(1)}>
              <ArrowLeft size={15} /> Kembali
            </button>
            <button
              className="btn btn-primary"
              onClick={handleGenerate}
              disabled={loadingGenerate}
              style={{ flex: 1 }}
            >
              {loadingGenerate
                ? <><div className="spinner" style={{ width: 15, height: 15 }} /> AI sedang generate kode...</>
                : <><Zap size={15} /> Generate Scraper</>}
            </button>
          </div>

          {loadingGenerate && (
            <div className="info-box info">
              <div className="spinner" style={{ width: 13, height: 13, borderWidth: "1.5px", flexShrink: 0 }} />
              <span>AI sedang menulis kode scraper yang lengkap. Proses bisa 30–90 detik tergantung kompleksitas...</span>
            </div>
          )}
        </div>
      )}

      {/* ── Step 3: Result ───────────────────────────────── */}
      {genStep === 3 && genResult && (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div className="info-box neon">
            <CheckCircle size={15} />
            <span>Scraper berhasil di-generate! Download dan jalankan di lokal / server / Termux kamu.</span>
          </div>

          <div className="card">
            <div className="card-head">
              <Code2 size={14} style={{ color: "var(--neon)" }} />
              <span className="card-tag">Generated Code</span>
              <div className="card-dots"><span /><span /><span /></div>
            </div>
            <div className="card-body">
              <CodeBlock
                code={genResult.code}
                lang={genLang}
                scraperId={genResult.id}
              />
            </div>
          </div>

          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <button className="btn btn-primary" onClick={resetGen}>
              <RefreshCw size={15} /> Buat Scraper Baru
            </button>
            <button
              className="btn btn-secondary"
              onClick={() => useStore.getState().setView("scrapers")}
            >
              Lihat Semua Scraper
            </button>
            <button
              className="btn btn-secondary"
              onClick={() => {
                useStore.getState().setFixScraperId(genResult.id);
                useStore.getState().setView("fix");
              }}
            >
              <Wand2 size={15} /> Fix Engine
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
