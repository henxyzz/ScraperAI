import { useState } from "react";
import { Copy, Check, Download, Package } from "lucide-react";
import { useStore } from "../store";
import { downloadFile, downloadZip } from "../api";
import type { Lang } from "../types";

interface Props {
  code:       string;
  lang:       Lang;
  scraperId?: string;
  maxHeight?: number;
}

// Simple syntax highlighter — token coloring untuk JS/Python/PHP
function tokenize(code: string, lang: Lang): string {
  const esc = (s: string) => s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");

  const COLORS = {
    kw:      "#c792ea", // keywords
    str:     "#c3e88d", // strings
    cmt:     "#546e7a", // comments
    num:     "#f78c6c", // numbers
    fn:      "#82aaff", // functions
    builtin: "#ffcb6b", // built-ins / require
    prop:    "#89ddff", // properties
    punct:   "#89ddff", // punctuation
    plain:   "#adbdd1", // default
    fixed:   "#2effa8", // // FIXED: lines
  };

  const span = (color: string, s: string) =>
    `<span style="color:${color}">${esc(s)}</span>`;

  const KEYWORDS_JS = /\b(const|let|var|function|async|await|return|if|else|for|while|try|catch|finally|throw|new|typeof|instanceof|class|extends|import|export|default|null|undefined|true|false|require|module\.exports)\b/g;
  const KEYWORDS_PY = /\b(def|class|return|if|elif|else|for|while|try|except|finally|raise|import|from|as|with|lambda|True|False|None|async|await|yield|pass|break|continue|in|not|and|or|is)\b/g;
  const KEYWORDS_PHP = /\b(function|return|if|else|elseif|foreach|for|while|try|catch|finally|throw|class|new|echo|print|require|include|use|namespace|public|private|protected|static|true|false|null|array|isset|empty|list)\b/g;

  const lines = code.split("\n");

  return lines.map(line => {
    // FIXED: or EDITED: lines — highlight whole line
    if (/\/\/ FIXED:/i.test(line) || /\/\/ EDITED:/i.test(line) || /# FIXED:/i.test(line) || /# EDITED:/i.test(line)) {
      return `<span style="color:${COLORS.fixed};background:rgba(46,255,168,.06);display:block">${esc(line)}</span>`;
    }

    // Comments
    if (/^\s*(\/\/|#|\/\*)/.test(line)) {
      return span(COLORS.cmt, line);
    }

    // Process token by token
    let result = esc(line);

    // Strings
    result = result.replace(/(&quot;|')(.*?)(\1)/g, (m) => `<span style="color:${COLORS.str}">${m}</span>`);
    result = result.replace(/`([^`]*)`/g, (m) => `<span style="color:${COLORS.str}">${m}</span>`);

    // Numbers
    result = result.replace(/\b(\d+\.?\d*)\b/g, (m) => `<span style="color:${COLORS.num}">${m}</span>`);

    // Keywords
    const kwRe = lang === "python" ? KEYWORDS_PY : lang === "php" ? KEYWORDS_PHP : KEYWORDS_JS;
    result = result.replace(kwRe, (m) => `<span style="color:${COLORS.kw}">${m}</span>`);

    // require/import
    result = result.replace(/\b(require|import|from)\b/g, (m) => `<span style="color:${COLORS.builtin}">${m}</span>`);

    // Function calls
    result = result.replace(/(\w+)(\()/g, (_, name, paren) =>
      `<span style="color:${COLORS.fn}">${name}</span><span style="color:${COLORS.punct}">${paren}</span>`);

    return result;
  }).join("\n");
}

export function CodeBlock({ code, lang, scraperId, maxHeight = 480 }: Props) {
  const { addToast } = useStore();
  const [copied, setCopied] = useState(false);

  const lines = code.split("\n").length;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      addToast("success", "Kode berhasil di-copy");
      setTimeout(() => setCopied(false), 2000);
    } catch {
      addToast("error", "Gagal copy ke clipboard");
    }
  };

  const html = tokenize(code, lang);

  return (
    <div className="code-wrap">
      <div className="code-header">
        <span className="code-lang-tag">{lang === "nodejs" ? "javascript" : lang}</span>
        <span className="code-lines">{lines} baris</span>
        <div className="code-actions">
          {scraperId && (
            <>
              <button className="btn-icon btn-sm" onClick={() => downloadFile(scraperId)} title="Download file">
                <Download size={13} />
              </button>
              <button className="btn-icon btn-sm" onClick={() => downloadZip(scraperId)} title="Download ZIP">
                <Package size={13} />
              </button>
            </>
          )}
          <button className="btn-icon btn-sm" onClick={handleCopy} title="Copy kode">
            {copied ? <Check size={13} style={{ color: "var(--neon)" }} /> : <Copy size={13} />}
          </button>
        </div>
        <div className="card-dots">
          <span /><span /><span />
        </div>
      </div>
      <div className="code-scroll" style={{ maxHeight }}>
        <pre
          className="code-pre"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      </div>
    </div>
  );
}
