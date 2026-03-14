// ════════════════════════════════════════
//  SmartScrapeAI v4 — Type Definitions
// ════════════════════════════════════════

export type Lang      = "nodejs" | "python" | "php";
export type Provider  = "anthropic" | "openai" | "groq" | "gemini" | "deepseek" | "mistral" | "xai" | "together";
export type FixMode   = "auto" | "rewrite" | "patch" | "enhance";
export type View = "generator" | "scrapers" | "fix" | "docs" | "storage";

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

export interface RecommendedModule {
  packages:    string[];
  reason:      string;
  install_cmd: string;
}

export interface AiAnalysis {
  greeting:             string;
  question:             string;
  suggestions:          string[];
  site_type?:           string;
  complexity?:          string;
  complexity_reason?:   string;
  scraping_strategy?:   string;
  css_selectors?:       { note: string; selectors: string[] };
  recommended_modules?: {
    nodejs:  RecommendedModule;
    python:  RecommendedModule;
    php:     RecommendedModule;
  };
}

export interface HtmlInfo {
  fetched:       boolean;
  status_code:   number | null;
  title:         string;
  detected_tech: string[];
  has_json_ld:   boolean;
  has_next_data: boolean;
  img_count:     number;
  link_count:    number;
  fetch_error:   string | null;
}

export interface AnalyzeResult {
  success:   boolean;
  url:       string;
  firewall:  FirewallResult;
  ai:        AiAnalysis;
  html_info?: HtmlInfo;
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

export interface ApiRoute {
  id:          string;
  scraperId:   string;
  name:        string;
  category:    string;
  method:      "GET" | "POST";
  path:        string;
  description: string;
  params?:     Array<{ name: string; type: string; required: boolean; description: string }>;
  createdAt:   string;
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
  apiRoutes?: ApiRoute[];
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
    tryEndpoint: string;
    tryInputs?:  TrySchemaField[];
    apiRoutes?:  ApiRoute[];
  }>;
  providers: {
    supported: string[];
    usage:     string;
  };
}

export interface TryOutputResult {
  scraperId:    string;
  scraper:      string;
  target:       string;
  firewall:     FirewallResult;
  run_command:  string;
  download:     string;
  zip:          string;
  code_lines:   number;
  code_preview: string;
  note:         string;
  asApiRoute?:  ApiRoute;
}

export type ModuleType = "commonjs" | "esm" | "esm-ts";

// ── C3 Storage ────────────────────────────────────────────────
export interface C3Config {
  configured:  boolean;
  endpoint:    string | null;
  bucket:      string;
  fileKey:     string;
  publicUrl:   string | null;
  hasKeys:     boolean;
}

export interface C3SyncResult {
  success:  boolean;
  message:  string;
  pull?:    { added: number; updated: number; total: number };
  push?:    { count: number; bytes: number };
  syncedAt?: string;
  error?:   string;
}
