import { useState } from "react";
import { Eye, EyeOff, CheckCircle, XCircle, Loader } from "lucide-react";
import { useStore } from "../store";
import { validateKey } from "../api";
import type { Provider } from "../types";

const PROVIDERS: { value: Provider; label: string }[] = [
  { value: "anthropic", label: "Anthropic" },
  { value: "openai",    label: "OpenAI" },
  { value: "groq",      label: "Groq" },
  { value: "gemini",    label: "Gemini" },
  { value: "deepseek",  label: "DeepSeek" },
  { value: "mistral",   label: "Mistral" },
  { value: "xai",       label: "xAI Grok" },
  { value: "together",  label: "Together" },
];

const DEFAULT_MODELS: Record<Provider, string[]> = {
  anthropic: ["claude-sonnet-4-20250514", "claude-opus-4-20250514", "claude-haiku-4-5-20251001"],
  openai:    ["gpt-4o", "gpt-4o-mini", "gpt-4-turbo"],
  groq:      ["llama3-70b-8192", "llama3-8b-8192", "mixtral-8x7b-32768"],
  gemini:    ["gemini-1.5-pro", "gemini-1.5-flash", "gemini-2.0-flash"],
  deepseek:  ["deepseek-chat", "deepseek-coder"],
  mistral:   ["mistral-large-latest", "mistral-medium-latest", "mistral-small-latest"],
  xai:       ["grok-beta", "grok-vision-beta"],
  together:  ["meta-llama/Llama-3-70b-chat-hf", "mistralai/Mixtral-8x7B-Instruct-v0.1"],
};

type ValidStatus = "idle" | "checking" | "ok" | "fail" | "unknown";

export function ProviderBar() {
  const { provider, apiKey, model, setProvider, setApiKey, setModel, addToast } = useStore();
  const [showKey, setShowKey]       = useState(false);
  const [validStatus, setStatus]    = useState<ValidStatus>("idle");

  const handleValidate = async () => {
    if (!apiKey.trim()) { addToast("warn", "Masukkan API Key terlebih dahulu"); return; }
    setStatus("checking");
    try {
      const res = await validateKey(provider, apiKey.trim(), model || undefined);
      if (res.valid === true)  { setStatus("ok");      addToast("success", `API Key ${provider} valid`); }
      else if (res.valid === false) { setStatus("fail"); addToast("error", res.message); }
      else { setStatus("unknown"); addToast("info", res.message); }
    } catch (e: any) {
      setStatus("fail");
      addToast("error", e.message || "Validasi gagal");
    }
  };

  const models = DEFAULT_MODELS[provider] || [];

  return (
    <div className="provider-bar">
      {/* Provider */}
      <select
        className="provider-select"
        value={provider}
        onChange={e => { setProvider(e.target.value as Provider); setStatus("idle"); }}
      >
        {PROVIDERS.map(p => (
          <option key={p.value} value={p.value}>{p.label}</option>
        ))}
      </select>

      {/* Model */}
      <select
        className="provider-select"
        value={model}
        onChange={e => setModel(e.target.value)}
        style={{ minWidth: 210 }}
      >
        <option value="">Default model</option>
        {models.map(m => <option key={m} value={m}>{m}</option>)}
      </select>

      {/* API Key */}
      <div className="apikey-wrap">
        <input
          className="apikey-input"
          type={showKey ? "text" : "password"}
          placeholder={`${provider} API Key...`}
          value={apiKey}
          onChange={e => { setApiKey(e.target.value); setStatus("idle"); }}
        />
        <span className="apikey-eye" onClick={() => setShowKey(p => !p)}>
          {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
        </span>
      </div>

      {/* Validate button */}
      <button
        className="validate-btn"
        onClick={handleValidate}
        disabled={validStatus === "checking" || !apiKey}
      >
        {validStatus === "checking" ? "Checking..." : "Validate Key"}
      </button>

      {/* Status dot */}
      {validStatus !== "idle" && (
        <span
          className={`valid-dot ${validStatus === "ok" ? "ok" : validStatus === "checking" ? "check" : "fail"}`}
          title={validStatus === "ok" ? "Valid" : validStatus === "fail" ? "Invalid" : "Unknown"}
        />
      )}
    </div>
  );
}
