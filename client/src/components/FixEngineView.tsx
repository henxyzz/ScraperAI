import { useState, useEffect } from "react";
import {
  Wrench, Zap, CheckCircle, XCircle, Save, RotateCcw,
  AlertTriangle, ChevronDown, ChevronUp, List
} from "lucide-react";
import { useStore } from "../store";
import {
  getScrapers, fixScraper, applyFix, revertScraper,
  editScraper, getHistory
} from "../api";
import { CodeBlock } from "./CodeBlock";
import type { Scraper, FixMode } from "../types";

const FIX_MODES: { value: FixMode; label: string; desc: string }[] = [
  { value: "auto",    label: "Auto Fix",  desc: "Fix semua bug secara otomatis" },
  { value: "patch",   label: "Patch",     desc: "Perbaiki bagian error saja" },
  { value: "rewrite", label: "Rewrite",   desc: "Tulis ulang seluruh kode" },
  { value: "enhance", label: "Enhance",   desc: "Fix + tambah retry & logging" },
];

export function FixEngineView() {
  const {
    provider, apiKey, model,
    fixScraperId, fixResult,
    setFixScraperId, setFixResult,
    addToast,
  } = useStore();

  const [scrapers,     setScrapers]     = useState<Scraper[]>([]);
  const [selected,     setSelected]     = useState<Scraper | null>(null);
  const [errorMsg,     setErrorMsg]     = useState("");
  const [fixMode,      setFixMode]      = useState<FixMode>("auto");
  const [instruction,  setInstruction]  = useState("");
  const [loading,      setLoading]      = useState(false);
  const [loadingApply, setLoadingApply] = useState(false);
  const [loadingEdit,  setLoadingEdit]  = useState(false);
  const [loadingRevert,setLoadingRevert]= useState(false);
  const [showOrig,     setShowOrig]     = useState(false);
  const [history,      setHistory]      = useState<any>(null);
  const [showHistory,  setShowHistory]  = useState(false);

  useEffect(() => {
    getScrapers().then(r => {
      setScrapers(r.scrapers);
      if (fixScraperId) {
        const s = r.scrapers.find(x => x.id === fixScraperId);
        if (s) setSelected(s);
      }
    });
  }, [fixScraperId]);

  const handleFix = async () => {
    if (!selected)          { addToast("warn", "Pilih scraper terlebih dahulu"); return; }
    if (!apiKey.trim())     { addToast("warn", "Masukkan API Key di topbar"); return; }

    setLoading(true);
    setFixResult(null);
    try {
      const res = await fixScraper(selected.id, errorMsg, provider, apiKey, model || undefined, fixMode);
      setFixResult(res);
      addToast("success", "Analisa & fix selesai");
    } catch (e: any) {
      addToast("error", e.message || "Fix gagal");
    } finally {
      setLoading(false);
    }
  };

  const handleApply = async () => {
    if (!fixResult || !selected) return;
    setLoadingApply(true);
    try {
      const res = await applyFix(selected.id, fixResult.fixedCode, `Fix mode: ${fixMode}`);
      // Update local state
      setSelected(prev => prev ? { ...prev, code: fixResult.fixedCode, fixCount: res.fixCount } : null);
      setScrapers(prev => prev.map(s => s.id === selected.id ? { ...s, code: fixResult.fixedCode, fixCount: res.fixCount } : s));
      setFixResult(null);
      addToast("success", res.message);
    } catch (e: any) {
      addToast("error", e.message);
    } finally {
      setLoadingApply(false);
    }
  };

  const handleEdit = async () => {
    if (!selected)         { addToast("warn", "Pilih scraper"); return; }
    if (!instruction.trim()){ addToast("warn", "Tulis instruksi edit"); return; }
    if (!apiKey.trim())    { addToast("warn", "Masukkan API Key"); return; }

    setLoadingEdit(true);
    try {
      const res = await editScraper(selected.id, instruction, provider, apiKey, model || undefined);
      // Show as fix result
      setFixResult({
        success: true, id: selected.id,
        analysis: {
          error_type: "Manual Edit", severity: "low",
          root_cause: instruction, fix_strategy: "Edit sesuai instruksi",
          changes: [instruction],
        },
        fixMode: "patch", fixedCode: res.editedCode, original: selected.code,
        diff: {
          originalLines: selected.code.split("\n").length,
          fixedLines: res.editedCode.split("\n").length,
          linesChanged: Math.abs(res.editedCode.split("\n").length - selected.code.split("\n").length),
          summary: "",
        },
        message: res.message,
      });
      setInstruction("");
      addToast("success", "Edit selesai — preview di bawah");
    } catch (e: any) {
      addToast("error", e.message);
    } finally {
      setLoadingEdit(false);
    }
  };

  const handleRevert = async () => {
    if (!selected) return;
    setLoadingRevert(true);
    try {
      const res = await revertScraper(selected.id);
      addToast("success", res.message);
      // Reload scraper
      const all = await getScrapers();
      const updated = all.scrapers.find(s => s.id === selected.id);
      if (updated) { setSelected(updated); setScrapers(all.scrapers); }
      setFixResult(null);
    } catch (e: any) {
      addToast("error", e.message);
    } finally {
      setLoadingRevert(false);
    }
  };

  const loadHistory = async () => {
    if (!selected) return;
    try {
      const h = await getHistory(selected.id);
      setHistory(h);
      setShowHistory(p => !p);
    } catch (e: any) {
      addToast("error", e.message);
    }
  };

  const sevColor: Record<string, string> = {
    critical: "var(--danger)", high: "#ff7845", medium: "var(--warn)", low: "var(--neon2)"
  };

  return (
    <div className="fix-engine-layout" style={{ display: "flex", gap: 16 }}>
      {/* Left: config panel */}
      <div style={{ width: 320, flexShrink: 0, display: "flex", flexDirection: "column", gap: 14 }}>
        {/* Select Scraper */}
        <div className="card">
          <div className="card-head">
            <Wrench size={14} style={{ color: "var(--neon3)" }} />
            <span className="card-tag">Select Scraper</span>
            <div className="card-dots"><span /><span /><span /></div>
          </div>
          <div className="card-body">
            <select
              className="field-select"
              value={selected?.id || ""}
              onChange={e => {
                const s = scrapers.find(x => x.id === e.target.value);
                setSelected(s || null);
                setFixScraperId(e.target.value || null);
                setFixResult(null);
              }}
            >
              <option value="">— Pilih scraper —</option>
              {scrapers.map(s => (
                <option key={s.id} value={s.id}>{s.name} ({s.lang})</option>
              ))}
            </select>

            {selected && (
              <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 6 }}>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  <span className={`badge badge-${selected.lang === "nodejs" ? "neon" : selected.lang === "python" ? "blue" : "purple"}`}>
                    {selected.lang}
                  </span>
                  {selected.bypassCF && <span className="badge badge-warn">bypass CF</span>}
                  {selected.fixCount > 0 && (
                    <span className="badge badge-neutral">fix #{selected.fixCount}</span>
                  )}
                </div>
                <p style={{ fontSize: 11, color: "var(--text2)", marginTop: 4 }}>{selected.url}</p>
                <p style={{ fontSize: 11, color: "var(--muted)" }}>{selected.code.split("\n").length} baris kode</p>
              </div>
            )}
          </div>
        </div>

        {/* Error Message */}
        <div className="card">
          <div className="card-head">
            <AlertTriangle size={14} style={{ color: "var(--warn)" }} />
            <span className="card-tag">Error Message</span>
            <div className="card-dots"><span /><span /><span /></div>
          </div>
          <div className="card-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <textarea
              className="field-textarea"
              placeholder="Paste error yang kamu dapat saat menjalankan scraper...
Contoh: TypeError: Cannot read properties of undefined..."
              value={errorMsg}
              onChange={e => setErrorMsg(e.target.value)}
              rows={5}
            />
            <p style={{ fontSize: 11, color: "var(--muted)" }}>
              Kosongkan jika ingin AI analisa kode secara umum tanpa error spesifik.
            </p>
          </div>
        </div>

        {/* Fix Mode */}
        <div className="card">
          <div className="card-head">
            <Zap size={14} style={{ color: "var(--neon)" }} />
            <span className="card-tag">Fix Mode</span>
            <div className="card-dots"><span /><span /><span /></div>
          </div>
          <div className="card-body">
            <div className="fix-mode-grid">
              {FIX_MODES.map(m => (
                <button
                  key={m.value}
                  className={`fix-mode-chip ${fixMode === m.value ? "active" : ""}`}
                  onClick={() => setFixMode(m.value)}
                >
                  <span>{m.label}</span>
                  <small>{m.desc}</small>
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Fix Button */}
        <button
          className="btn btn-primary"
          onClick={handleFix}
          disabled={loading || !selected}
          style={{ width: "100%" }}
        >
          {loading
            ? <><div className="spinner" style={{ width: 15, height: 15 }} /> AI sedang menganalisa & fix...</>
            : <><Zap size={15} /> Jalankan Fix Engine</>}
        </button>

        {/* Manual Edit */}
        <div className="card">
          <div className="card-head">
            <Wrench size={14} style={{ color: "var(--neon2)" }} />
            <span className="card-tag">Manual Edit (AI)</span>
            <div className="card-dots"><span /><span /><span /></div>
          </div>
          <div className="card-body" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <textarea
              className="field-textarea"
              placeholder="Instruksi edit spesifik...
Contoh: Ganti delay dari 1000ms ke 2000ms
Tambahkan logging timestamp di setiap request"
              value={instruction}
              onChange={e => setInstruction(e.target.value)}
              rows={4}
            />
            <button
              className="btn btn-secondary btn-sm"
              onClick={handleEdit}
              disabled={loadingEdit || !selected || !instruction.trim()}
            >
              {loadingEdit
                ? <><div className="spinner" style={{ width: 13, height: 13 }} /> Editing...</>
                : <><Wrench size={13} /> Apply Edit Instruction</>}
            </button>
          </div>
        </div>

        {/* History */}
        {selected && selected.fixCount > 0 && (
          <div className="card">
            <div className="card-head">
              <List size={14} style={{ color: "var(--text2)" }} />
              <span className="card-tag">Version History</span>
              <button className="btn-icon btn-sm" onClick={loadHistory} style={{ marginLeft: "auto" }}>
                {showHistory ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
              </button>
            </div>
            {showHistory && history && (
              <div className="card-body" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {history.history.map((h: any) => (
                  <div key={h.version} style={{
                    background: "rgba(0,0,0,.3)", border: "1px solid var(--border)",
                    borderRadius: 8, padding: "9px 12px",
                    display: "flex", justifyContent: "space-between", alignItems: "center",
                  }}>
                    <div>
                      <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--text2)" }}>v{h.version} — {h.lines} baris</div>
                      <div style={{ fontSize: 10, color: "var(--muted)", marginTop: 2 }}>{h.changeLog}</div>
                    </div>
                    <button
                      className="btn btn-ghost btn-sm"
                      onClick={handleRevert}
                      disabled={loadingRevert}
                    >
                      <RotateCcw size={11} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Right: results */}
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 14 }}>
        {!fixResult && !loading && selected && (
          <div className="card">
            <div className="card-head">
              <Wrench size={14} style={{ color: "var(--neon)" }} />
              <span className="card-tag">Current Code — {selected.name}</span>
              <div className="card-dots"><span /><span /><span /></div>
            </div>
            <div className="card-body">
              <CodeBlock code={selected.code} lang={selected.lang} scraperId={selected.id} />
            </div>
          </div>
        )}

        {loading && (
          <div className="card">
            <div className="card-body">
              <div className="loading-overlay">
                <div className="spinner spinner-lg" />
                <span className="loading-msg">AI menganalisa error dan menulis fix...</span>
                <span className="loading-sub">Bisa memakan waktu 30–90 detik</span>
              </div>
            </div>
          </div>
        )}

        {fixResult && (
          <>
            {/* Analysis */}
            <div className="card">
              <div className="card-head">
                <AlertTriangle size={14} style={{ color: "var(--warn)" }} />
                <span className="card-tag">Error Analysis</span>
                <span className="badge badge-neutral" style={{ marginLeft: "auto" }}>
                  {fixResult.fixMode}
                </span>
                <div className="card-dots"><span /><span /><span /></div>
              </div>
              <div className="card-body">
                <div className="analysis-card">
                  <div className="analysis-row">
                    <span className="analysis-key">Type</span>
                    <span className="analysis-val" style={{ fontFamily: "var(--mono)", fontSize: 11 }}>
                      {fixResult.analysis.error_type}
                    </span>
                  </div>
                  <div className="analysis-row">
                    <span className="analysis-key">Severity</span>
                    <span className="analysis-val" style={{ color: sevColor[fixResult.analysis.severity], fontFamily: "var(--mono)", fontSize: 11, textTransform: "uppercase" }}>
                      {fixResult.analysis.severity}
                    </span>
                  </div>
                  <div className="analysis-row">
                    <span className="analysis-key">Root Cause</span>
                    <span className="analysis-val">{fixResult.analysis.root_cause}</span>
                  </div>
                  <div className="analysis-row">
                    <span className="analysis-key">Strategy</span>
                    <span className="analysis-val">{fixResult.analysis.fix_strategy}</span>
                  </div>
                  <div className="analysis-row">
                    <span className="analysis-key">Changes</span>
                    <ul className="analysis-changes">
                      {fixResult.analysis.changes.map((c, i) => <li key={i}>{c}</li>)}
                    </ul>
                  </div>
                </div>
              </div>
            </div>

            {/* Diff bar */}
            <div className="diff-bar">
              <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--text2)" }}>Diff:</span>
              <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--muted)" }}>
                {fixResult.diff.originalLines} baris
              </span>
              <span style={{ color: "var(--neon2)", fontSize: 13 }}>→</span>
              <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--neon)" }}>
                {fixResult.diff.fixedLines} baris
              </span>
              {fixResult.diff.linesChanged > 0 && (
                <span style={{
                  fontFamily: "var(--mono)", fontSize: 10, padding: "2px 8px",
                  borderRadius: 4, marginLeft: 4,
                  background: fixResult.diff.fixedLines > fixResult.diff.originalLines
                    ? "rgba(46,255,168,.1)" : "rgba(255,69,96,.1)",
                  color: fixResult.diff.fixedLines > fixResult.diff.originalLines
                    ? "var(--neon)" : "var(--danger)",
                }}>
                  {fixResult.diff.fixedLines > fixResult.diff.originalLines ? "+" : "-"}{fixResult.diff.linesChanged}
                </span>
              )}
            </div>

            {/* Fixed Code */}
            <div className="card">
              <div className="card-head">
                <CheckCircle size={14} style={{ color: "var(--neon)" }} />
                <span className="card-tag">Fixed Code</span>
                <div className="card-dots"><span /><span /><span /></div>
              </div>
              <div className="card-body">
                <CodeBlock code={fixResult.fixedCode} lang={selected?.lang || "nodejs"} maxHeight={400} />
              </div>
            </div>

            {/* Compare toggle */}
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => setShowOrig(p => !p)}
              style={{ alignSelf: "flex-start" }}
            >
              {showOrig ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
              {showOrig ? "Sembunyikan" : "Tampilkan"} kode original
            </button>

            {showOrig && selected && (
              <div className="card">
                <div className="card-head">
                  <XCircle size={14} style={{ color: "var(--muted)" }} />
                  <span className="card-tag" style={{ color: "var(--muted)" }}>Original Code</span>
                  <div className="card-dots"><span /><span /><span /></div>
                </div>
                <div className="card-body">
                  <CodeBlock code={fixResult.original} lang={selected.lang} maxHeight={320} />
                </div>
              </div>
            )}

            {/* Apply actions */}
            <div style={{ display: "flex", gap: 10 }}>
              <button
                className="btn btn-primary"
                onClick={handleApply}
                disabled={loadingApply}
              >
                {loadingApply
                  ? <><div className="spinner" style={{ width: 15, height: 15 }} /> Menerapkan...</>
                  : <><Save size={15} /> Terapkan Fix ke Scraper</>}
              </button>
              <button
                className="btn btn-secondary"
                onClick={() => setFixResult(null)}
              >
                Batalkan
              </button>
            </div>
          </>
        )}

        {!fixResult && !loading && !selected && (
          <div className="empty-state">
            <div className="empty-icon"><Wrench size={48} /></div>
            <div className="empty-title">AI Fix Engine</div>
            <div className="empty-sub">
              Pilih scraper, paste error message, pilih fix mode, lalu jalankan Fix Engine.
              AI akan menganalisa penyebab error dan menulis kode yang sudah diperbaiki.
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
