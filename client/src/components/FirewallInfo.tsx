import { Shield, ShieldOff, Clock, Globe, AlertTriangle, CheckCircle } from "lucide-react";
import type { FirewallResult } from "../types";

interface Props {
  fw: FirewallResult;
}

export function FirewallInfo({ fw }: Props) {
  const checks = [
    { label: "Cloudflare",      on: fw.cloudflare },
    { label: "WAF",             on: fw.waf },
    { label: "Bot Protection",  on: fw.bot_protection },
    { label: "Bypass Needed",   on: fw.bypass_recommended },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
      {checks.map(c => (
        <div key={c.label} className="fw-row">
          <span className={`fw-dot ${c.on ? "on" : "off"}`} />
          <span className="fw-label">{c.label}</span>
          <span className="fw-val" style={{ color: c.on ? "var(--danger)" : "var(--neon)" }}>
            {c.on ? "TERDETEKSI" : "AMAN"}
          </span>
        </div>
      ))}

      {fw.status_code && (
        <div className="fw-row">
          <Globe size={8} style={{ color: "var(--muted)", flexShrink: 0 }} />
          <span className="fw-label">Status Code</span>
          <span className="fw-val">{fw.status_code}</span>
        </div>
      )}

      {fw.response_time_ms && (
        <div className="fw-row">
          <Clock size={8} style={{ color: "var(--muted)", flexShrink: 0 }} />
          <span className="fw-label">Response Time</span>
          <span className="fw-val">{fw.response_time_ms}ms</span>
        </div>
      )}

      {fw.details.length > 0 && (
        <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 4 }}>
          {fw.details.map((d, i) => (
            <div key={i} style={{ display: "flex", gap: 7, alignItems: "flex-start" }}>
              <AlertTriangle size={11} style={{ color: "var(--warn)", flexShrink: 0, marginTop: 2 }} />
              <span style={{ fontSize: 11, color: "var(--text2)", fontFamily: "var(--mono)" }}>{d}</span>
            </div>
          ))}
        </div>
      )}

      {fw.bypass_recommended && (
        <div className="info-box warn" style={{ marginTop: 12 }}>
          <AlertTriangle size={15} />
          <span>Website memerlukan teknik bypass. Aktifkan <strong>Bypass CF Mode</strong> saat generate.</span>
        </div>
      )}

      {!fw.bypass_recommended && (
        <div className="info-box neon" style={{ marginTop: 12 }}>
          <CheckCircle size={15} />
          <span>Website dapat di-scrape langsung tanpa bypass khusus.</span>
        </div>
      )}
    </div>
  );
}
