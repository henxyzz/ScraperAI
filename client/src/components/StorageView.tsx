import { useState, useEffect } from "react";
import {
  CloudUpload, CloudDownload, RefreshCw, Trash2, CheckCircle,
  XCircle, Database, Info, Copy, Check, FileJson, AlertTriangle
} from "lucide-react";
import { useStore } from "../store";
import axios from "axios";
import type { C3Config, C3SyncResult } from "../types";

export function StorageView() {
  const { addToast } = useStore();

  const [config,    setConfig]    = useState<C3Config | null>(null);
  const [files,     setFiles]     = useState<string[]>([]);
  const [loading,   setLoading]   = useState(true);
  const [pushing,   setPushing]   = useState(false);
  const [pulling,   setPulling]   = useState(false);
  const [syncing,   setSyncing]   = useState(false);
  const [lastSync,  setLastSync]  = useState<C3SyncResult | null>(null);
  const [copied,    setCopied]    = useState(false);

  const loadStatus = async () => {
    setLoading(true);
    try {
      const res = await axios.get("/api/c3/status");
      setConfig(res.data.config);
      if (res.data.config.configured) {
        try {
          const fr = await axios.get("/api/c3/files");
          setFiles(fr.data.files || []);
        } catch {}
      }
    } catch (e: any) {
      addToast("error", e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadStatus(); }, []);

  const handlePush = async () => {
    setPushing(true);
    try {
      const r = await axios.post("/api/c3/push");
      addToast("success", r.data.message);
      setLastSync({ success: true, message: r.data.message, push: { count: r.data.scrapers, bytes: r.data.bytes } });
      loadStatus();
    } catch (e: any) {
      addToast("error", e.response?.data?.error || e.message);
    } finally { setPushing(false); }
  };

  const handlePull = async () => {
    setPulling(true);
    try {
      const r = await axios.post("/api/c3/pull");
      addToast("success", r.data.message);
      setLastSync({ success: true, message: r.data.message });
    } catch (e: any) {
      addToast("error", e.response?.data?.error || e.message);
    } finally { setPulling(false); }
  };

  const handleSync = async () => {
    setSyncing(true);
    try {
      const r = await axios.post("/api/c3/sync");
      addToast("success", r.data.message);
      setLastSync(r.data);
      loadStatus();
    } catch (e: any) {
      addToast("error", e.response?.data?.error || e.message);
    } finally { setSyncing(false); }
  };

  const handleDelete = async (filename: string) => {
    if (!confirm(`Hapus ${filename} dari C3 bucket?`)) return;
    try {
      await axios.delete(`/api/c3/file/${encodeURIComponent(filename)}`);
      addToast("success", `${filename} dihapus dari C3`);
      setFiles(prev => prev.filter(f => f !== filename));
    } catch (e: any) {
      addToast("error", e.response?.data?.error || e.message);
    }
  };

  const copyEnvTemplate = async () => {
    const tmpl = `C3_ENDPOINT=https://<ACCOUNT_ID>.r2.cloudflarestorage.com
C3_BUCKET=smartscrapeai
C3_ACCESS_KEY=your-r2-access-key-id
C3_SECRET_KEY=your-r2-secret-access-key
C3_PUBLIC_URL=
C3_FILE_KEY=scrapers.json`;
    await navigator.clipboard.writeText(tmpl);
    setCopied(true);
    addToast("info", "Template .env di-copy");
    setTimeout(() => setCopied(false), 2000);
  };

  if (loading) return (
    <div className="loading-overlay">
      <div className="spinner spinner-lg" />
      <span className="loading-msg">Mengecek koneksi C3 Storage...</span>
    </div>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18, maxWidth: 720 }}>

      {/* Status Card */}
      <div className="card">
        <div className="card-head">
          <Database size={14} style={{ color: config?.configured ? "var(--neon)" : "var(--muted)" }} />
          <span className="card-tag">C3 Storage Status</span>
          <button className="btn-icon btn-sm" onClick={loadStatus} style={{ marginLeft: "auto" }}>
            <RefreshCw size={13} />
          </button>
          <div className="card-dots"><span /><span /><span /></div>
        </div>
        <div className="card-body" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {/* Status row */}
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            {config?.configured
              ? <CheckCircle size={20} style={{ color: "var(--neon)" }} />
              : <XCircle     size={20} style={{ color: "var(--muted)" }} />}
            <div>
              <div style={{ fontSize: 14, fontWeight: 600, color: config?.configured ? "var(--neon)" : "var(--text2)" }}>
                {config?.configured ? "Terhubung ke C3 Storage" : "C3 Storage belum dikonfigurasi"}
              </div>
              <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 2 }}>
                {config?.configured
                  ? `Bucket: ${config.bucket} — ${files.length} file`
                  : "Set environment variables untuk mengaktifkan sync ke Cloudflare R2"}
              </div>
            </div>
          </div>

          {/* Config details if active */}
          {config?.configured && (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              {[
                { label: "Endpoint",   val: config.endpoint || "-" },
                { label: "Bucket",     val: config.bucket },
                { label: "File Key",   val: config.fileKey },
                { label: "Public URL", val: config.publicUrl || "(tidak diset)" },
              ].map(r => (
                <div key={r.label} style={{ background: "rgba(0,0,0,.3)", borderRadius: 8, padding: "8px 12px" }}>
                  <div style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--muted)", textTransform: "uppercase", letterSpacing: 1, marginBottom: 3 }}>{r.label}</div>
                  <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--text2)", wordBreak: "break-all" }}>{r.val}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Sync Actions */}
      {config?.configured ? (
        <div className="card">
          <div className="card-head">
            <RefreshCw size={14} style={{ color: "var(--neon2)" }} />
            <span className="card-tag">Sinkronisasi</span>
            <div className="card-dots"><span /><span /><span /></div>
          </div>
          <div className="card-body" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              {/* Sync (2-way) */}
              <button className="btn btn-primary" onClick={handleSync} disabled={syncing}>
                {syncing
                  ? <><div className="spinner" style={{ width: 14, height: 14 }} /> Syncing...</>
                  : <><RefreshCw size={14} /> Sync Sekarang</>}
              </button>

              {/* Push */}
              <button className="btn btn-secondary" onClick={handlePush} disabled={pushing}>
                {pushing
                  ? <><div className="spinner" style={{ width: 14, height: 14 }} /> Pushing...</>
                  : <><CloudUpload size={14} /> Push ke C3</>}
              </button>

              {/* Pull */}
              <button className="btn btn-secondary" onClick={handlePull} disabled={pulling}>
                {pulling
                  ? <><div className="spinner" style={{ width: 14, height: 14 }} /> Pulling...</>
                  : <><CloudDownload size={14} /> Pull dari C3</>}
              </button>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--muted)", letterSpacing: 1, textTransform: "uppercase" }}>Keterangan</div>
              {[
                { icon: RefreshCw,     label: "Sync",       desc: "Pull dari remote dulu, lalu push semua lokal ke C3 (2-way merge)" },
                { icon: CloudUpload,   label: "Push ke C3",  desc: "Upload scrapers.json lokal ke bucket C3 (overwrite)" },
                { icon: CloudDownload, label: "Pull dari C3", desc: "Download dari bucket C3 dan merge ke data lokal" },
              ].map(({ icon: Icon, label, desc }) => (
                <div key={label} style={{ display: "flex", gap: 10, fontSize: 12, alignItems: "flex-start" }}>
                  <Icon size={13} style={{ color: "var(--muted)", flexShrink: 0, marginTop: 2 }} />
                  <div><strong style={{ color: "var(--text2)" }}>{label}</strong>: <span style={{ color: "var(--muted)" }}>{desc}</span></div>
                </div>
              ))}
            </div>

            {/* Last sync result */}
            {lastSync && (
              <div className={`info-box ${lastSync.success ? "neon" : "danger"}`}>
                {lastSync.success ? <CheckCircle size={14} /> : <XCircle size={14} />}
                <div style={{ fontSize: 12 }}>
                  <strong>{lastSync.message}</strong>
                  {lastSync.syncedAt && (
                    <span style={{ marginLeft: 8, fontFamily: "var(--mono)", fontSize: 10, color: "var(--muted)" }}>
                      {new Date(lastSync.syncedAt).toLocaleString("id-ID")}
                    </span>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      ) : (
        /* Setup Guide */
        <div className="card">
          <div className="card-head">
            <Info size={14} style={{ color: "var(--neon2)" }} />
            <span className="card-tag">Cara Konfigurasi C3 Storage</span>
            <div className="card-dots"><span /><span /><span /></div>
          </div>
          <div className="card-body" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {[
                "Buka Cloudflare Dashboard → R2 Object Storage",
                "Buat bucket baru (misal: smartscrapeai)",
                "Pergi ke Manage R2 API Tokens → Create API Token",
                "Pilih Object Read & Write untuk bucket yang dibuat",
                "Copy Account ID, Access Key ID, dan Secret Access Key",
                "Set environment variables di file .env (lihat template di bawah)",
                "Restart server, lalu klik Sync",
              ].map((step, i) => (
                <div key={i} style={{ display: "flex", gap: 12, alignItems: "flex-start", fontSize: 13 }}>
                  <span style={{
                    width: 22, height: 22, borderRadius: "50%", background: "rgba(46,255,168,.1)",
                    border: "1px solid rgba(46,255,168,.25)", display: "flex", alignItems: "center",
                    justifyContent: "center", fontFamily: "var(--mono)", fontSize: 10, color: "var(--neon)",
                    flexShrink: 0,
                  }}>{i + 1}</span>
                  <span style={{ color: "var(--text2)", lineHeight: 1.6 }}>{step}</span>
                </div>
              ))}
            </div>

            {/* Env template */}
            <div style={{ background: "#050910", border: "1px solid var(--border)", borderRadius: "var(--radius)", overflow: "hidden" }}>
              <div style={{ display: "flex", alignItems: "center", padding: "8px 14px", borderBottom: "1px solid var(--border)", background: "rgba(0,0,0,.4)", gap: 8 }}>
                <FileJson size={12} style={{ color: "var(--muted)" }} />
                <span style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--muted)", letterSpacing: 2, textTransform: "uppercase", flex: 1 }}>.env template</span>
                <button className="btn-icon" style={{ padding: 4 }} onClick={copyEnvTemplate}>
                  {copied ? <Check size={11} style={{ color: "var(--neon)" }} /> : <Copy size={11} />}
                </button>
              </div>
              <pre style={{ fontFamily: "var(--mono)", fontSize: 11.5, color: "#adbdd1", padding: 14, margin: 0, lineHeight: 1.7 }}>
{`C3_ENDPOINT=https://<ACCOUNT_ID>.r2.cloudflarestorage.com
C3_BUCKET=smartscrapeai
C3_ACCESS_KEY=your-access-key-id
C3_SECRET_KEY=your-secret-access-key
C3_PUBLIC_URL=            # opsional
C3_FILE_KEY=scrapers.json # nama file di bucket`}
              </pre>
            </div>

            <div className="info-box info">
              <Info size={14} />
              <span style={{ fontSize: 12 }}>
                C3 Storage bersifat <strong>opsional</strong>. Tanpa ini, data tetap tersimpan di <code>data/scrapers.json</code> lokal.
              </span>
            </div>
          </div>
        </div>
      )}

      {/* File list */}
      {config?.configured && files.length > 0 && (
        <div className="card">
          <div className="card-head">
            <FileJson size={14} style={{ color: "var(--neon3)" }} />
            <span className="card-tag">Files di Bucket ({files.length})</span>
            <div className="card-dots"><span /><span /><span /></div>
          </div>
          <div className="card-body" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {files.map(f => (
              <div key={f} style={{
                display: "flex", alignItems: "center", gap: 10,
                padding: "9px 12px", background: "rgba(0,0,0,.3)",
                border: "1px solid var(--border)", borderRadius: 8,
              }}>
                <FileJson size={13} style={{ color: "var(--muted)", flexShrink: 0 }} />
                <span style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--text2)", flex: 1 }}>{f}</span>
                {config.publicUrl && (
                  <a
                    href={`${config.publicUrl}/${f}`}
                    target="_blank"
                    rel="noreferrer"
                    style={{ fontSize: 11, color: "var(--neon2)", fontFamily: "var(--mono)" }}
                  >
                    view
                  </a>
                )}
                <button className="btn btn-danger btn-sm" onClick={() => handleDelete(f)}>
                  <Trash2 size={11} />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
