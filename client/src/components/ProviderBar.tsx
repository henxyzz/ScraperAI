import { useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import { useStore } from "../store";
import { validateKey } from "../api";
import type { Provider } from "../types";

const PROVIDERS: { value: Provider; label: string }[] = [
  { value: "anthropic", label: "Anthropic" },
  { value: "openai",    label: "OpenAI" },
  { value: "groq",      label: "Groq (Free)" },
  { value: "gemini",    label: "Gemini" },
  { value: "deepseek",  label: "DeepSeek" },
  { value: "mistral",   label: "Mistral" },
  { value: "xai",       label: "xAI Grok" },
  { value: "together",  label: "Together AI" },
];

// Model terbaru per provider — Maret 2025
const PROVIDER_MODELS: Record<Provider, { value: string; label: string }[]> = {
  anthropic: [
    { value: "claude-sonnet-4-20250514",  label: "Claude Sonnet 4 (Recommended)" },
    { value: "claude-opus-4-20250514",    label: "Claude Opus 4 (Best)" },
    { value: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5 (Fast)" },
  ],
  openai: [
    { value: "gpt-4o",              label: "GPT-4o (Recommended)" },
    { value: "gpt-4o-mini",         label: "GPT-4o Mini (Fast)" },
    { value: "o3-mini",             label: "o3-mini (Reasoning)" },
    { value: "o1",                  label: "o1 (Advanced Reasoning)" },
  ],
  groq: [
    { value: "llama-3.3-70b-versatile",        label: "Llama 3.3 70B Versatile (Recommended)" },
    { value: "llama-3.1-8b-instant",           label: "Llama 3.1 8B Instant (Fastest)" },
    { value: "deepseek-r1-distill-llama-70b",  label: "DeepSeek R1 Distill 70B" },
    { value: "qwen-qwq-32b",                   label: "Qwen QwQ 32B" },
    { value: "mixtral-8x7b-32768",             label: "Mixtral 8x7B" },
    { value: "gemma2-9b-it",                   label: "Gemma 2 9B" },
  ],
  gemini: [
    { value: "gemini-2.0-flash",         label: "Gemini 2.0 Flash (Recommended)" },
    { value: "gemini-2.0-flash-lite",    label: "Gemini 2.0 Flash-Lite (Fastest)" },
    { value: "gemini-2.5-pro-preview-03-25", label: "Gemini 2.5 Pro Preview" },
    { value: "gemini-1.5-pro",           label: "Gemini 1.5 Pro" },
    { value: "gemini-1.5-flash",         label: "Gemini 1.5 Flash" },
  ],
  deepseek: [
    { value: "deepseek-chat",      label: "DeepSeek V3 (Recommended)" },
    { value: "deepseek-reasoner",  label: "DeepSeek R1 (Reasoning)" },
  ],
  mistral: [
    { value: "mistral-large-latest",   label: "Mistral Large (Recommended)" },
    { value: "mistral-medium-latest",  label: "Mistral Medium" },
    { value: "mistral-small-latest",   label: "Mistral Small (Fast)" },
    { value: "codestral-latest",       label: "Codestral (Code)" },
  ],
  xai: [
    { value: "grok-3",            label: "Grok 3 (Recommended)" },
    { value: "grok-3-mini",       label: "Grok 3 Mini (Fast)" },
    { value: "grok-2-1212",       label: "Grok 2" },
    { value: "grok-vision-beta",  label: "Grok Vision Beta" },
  ],
  together: [
    { value: "meta-llama/Llama-3.3-70B-Instruct-Turbo",      label: "Llama 3.3 70B Turbo (Recommended)" },
    { value: "meta-llama/Meta-Llama-3.1-405B-Instruct-Turbo", label: "Llama 3.1 405B Turbo" },
    { value: "deepseek-ai/DeepSeek-V3",                        label: "DeepSeek V3" },
    { value: "Qwen/QwQ-32B-Preview",                           label: "QwQ 32B Preview" },
    { value: "mistralai/Mixtral-8x22B-Instruct-v0.1",          label: "Mixtral 8x22B" },
  ],
};

type ValidStatus = "idle" | "checking" | "ok" | "fail" | "unknown";

export function ProviderBar() {
  const { provider, apiKey, model, setProvider, setApiKey, setModel, addToast } = useStore();
  const [showKey, setShowKey]    = useState(false);
  const [status,  setStatus]     = useState<ValidStatus>("idle");

  const handleValidate = async () => {
    if (!apiKey.trim()) { addToast("warn", "Masukkan API Key terlebih dahulu"); return; }
    setStatus("checking");
    try {
      const res = await validateKey(provider, apiKey.trim(), model || undefined);
      if (res.valid === true)    { setStatus("ok");      addToast("success", `${provider} — API Key valid`); }
      else if (res.valid === false) { setStatus("fail"); addToast("error",   res.message); }
      else                       { setStatus("unknown"); addToast("info",    res.message); }
    } catch (e: any) {
      setStatus("fail");
      addToast("error", e.message || "Validasi gagal");
    }
  };

  const models = PROVIDER_MODELS[provider] || [];

  return (
    <div className="provider-bar">
      {/* Provider */}
      <select
        className="provider-select"
        value={provider}
        onChange={e => { setProvider(e.target.value as Provider); setModel(""); setStatus("idle"); }}
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
        style={{ minWidth: 240 }}
      >
        <option value="">Default ({models[0]?.label?.split(" (")[0] || "auto"})</option>
        {models.map(m => (
          <option key={m.value} value={m.value}>{m.label}</option>
        ))}
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
        <span className="apikey-eye" onClick={() => setShowKey((p: boolean) => !p)}>
          {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
        </span>
      </div>

      {/* Validate */}
      <button
        className="validate-btn"
        onClick={handleValidate}
        disabled={status === "checking" || !apiKey.trim()}
      >
        {status === "checking" ? "Checking..." : "Validate Key"}
      </button>

      {/* Status dot */}
      {status !== "idle" && (
        <span
          className={`valid-dot ${status === "ok" ? "ok" : status === "checking" ? "check" : "fail"}`}
          title={
            status === "ok"      ? "API Key valid" :
            status === "fail"    ? "API Key invalid" :
            status === "unknown" ? "Status tidak diketahui" :
            "Mengecek..."
          }
        />
      )}
    </div>
  );
}
