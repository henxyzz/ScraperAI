// ════════════════════════════════════════
//  SmartScrapeAI v3 — Type Definitions
// ════════════════════════════════════════

export type Lang      = "nodejs" | "python" | "php";
export type Provider  = "anthropic" | "openai" | "groq" | "gemini" | "deepseek" | "mistral" | "xai" | "together";
export type FixMode   = "auto" | "rewrite" | "patch" | "enhance";
export type View      = "generator" | "scrapers" | "fix" | "docs";

export interface ProviderConfig {
  provider: Provider;
  apiKey:   string;
  model:    string;
}

export interface FirewallResult {
  cloudflare:         boolean;
  waf:                boolean;
  bot_protection:     boolean;
  details:            string[];
  bypass_recommended: boolean;
  status_code:        number | null;
  response_time_ms:   number | null;
}

export interface AiAnalysis {
  greeting:    string;
  question:    string;
  suggestions: string[];
}

export interface AnalyzeResult {
  success:  boolean;
  url:      string;
  firewall: FirewallResult;
  ai:       AiAnalysis;
}

export interface TrySchemaField {
  name:        string;
  label:       string;
  type:        "url" | "text" | "number";
  placeholder: string;
  required:    boolean;
}

export interface ScraperHistory {
  version:   number;
  code:      string;
  savedAt:   string;
  changeLog: string;
}

export interface Scraper {
  id:         string;
  name:       string;
  url:        string;
  target:     string;
  lang:       Lang;
  bypassCF:   boolean;
  code:       string;
  trySchema:  TrySchemaField[];
  provider:   string;
  model:      string;
  createdAt:  string;
  updatedAt:  string;
  filename:   string;
  fixCount:   number;
  history:    ScraperHistory[];
  lastFix?:   { appliedAt: string; changeLog: string };
}

export interface GenerateResult {
  success:   boolean;
  id:        string;
  code:      string;
  trySchema: TrySchemaField[];
  entry:     Scraper;
}

export interface FixAnalysis {
  error_type:    string;
  root_cause:    string;
  fix_strategy:  string;
  severity:      "critical" | "high" | "medium" | "low";
  changes:       string[];
}

export interface FixResult {
  success:   boolean;
  id:        string;
  analysis:  FixAnalysis;
  fixMode:   FixMode;
  fixedCode: string;
  original:  string;
  diff: {
    originalLines: number;
    fixedLines:    number;
    linesChanged:  number;
    summary:       string;
  };
  message: string;
}

export interface Template {
  id:          string;
  name:        string;
  description: string;
  lang:        Lang;
  target:      string;
  example_url: string;
}

export interface ScraperStats {
  total:       number;
  byLang:      Record<string, number>;
  byProvider:  Record<string, number>;
  withBypass:  number;
  totalFixes:  number;
}

export interface ValidateResult {
  success: boolean;
  valid:   boolean | null;
  provider: string;
  message:  string;
}

export interface Toast {
  id:   string;
  type: "success" | "error" | "info" | "warn";
  msg:  string;
}

export interface ApiDocsEndpoint {
  method:      string;
  path:        string;
  description: string;
  body?:       Record<string, string>;
  query?:      Record<string, string>;
}

export interface ApiDocs {
  name:             string;
  version:          string;
  description:      string;
  baseURL:          string;
  totalEndpoints:   number;
  builtinEndpoints: ApiDocsEndpoint[];
  scrapers:         Array<{
    id:          string;
    name:        string;
    url:         string;
    lang:        string;
    provider:    string;
    createdAt:   string;
    endpoint:    string;
    download:    string;
    zip:         string;
  }>;
  providers: {
    supported: string[];
    usage:     string;
  };
}
