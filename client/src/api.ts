// ════════════════════════════════════════
//  SmartScrapeAI v4 — API Client
// ════════════════════════════════════════

import axios from "axios";
import type {
  AnalyzeResult, GenerateResult, Scraper, FixResult,
  Template, ScraperStats, ValidateResult, ApiDocs,
  Lang, Provider, FixMode, ApiRoute,
} from "./types";

const BASE = "";  // Vite proxy handles /api → backend in dev, same origin in prod

const api = axios.create({
  baseURL: BASE,
  timeout: 150000,
});

// ── Interceptors ──────────────────────────────────────────────
api.interceptors.response.use(
  r => r,
  err => {
    const msg = err.response?.data?.error || err.message || "Request gagal";
    return Promise.reject(new Error(msg));
  }
);

// ── Provider & Validate ───────────────────────────────────────
export const validateKey = (provider: Provider, apiKey: string, model?: string) =>
  api.post<ValidateResult>("/api/validate", { provider, apiKey, model }).then(r => r.data);

// ── Templates ─────────────────────────────────────────────────
export const getTemplates = () =>
  api.get<{ success: boolean; templates: Template[] }>("/api/templates").then(r => r.data);

// ── Analyze ───────────────────────────────────────────────────
export const analyzeUrl = (url: string, provider: Provider, apiKey: string, model?: string) =>
  api.post<AnalyzeResult>("/api/analyze", { url, provider, apiKey, model }).then(r => r.data);

// ── Generate ──────────────────────────────────────────────────
export const generateScraper = (params: {
  url: string; target: string; lang: Lang; bypassCF: boolean;
  provider: Provider; apiKey: string; model?: string;
}) => api.post<GenerateResult>("/api/generate", params).then(r => r.data);

// ── Scrapers ──────────────────────────────────────────────────
export const getScrapers = () =>
  api.get<{ success: boolean; count: number; scrapers: Scraper[] }>("/api/scrapers").then(r => r.data);

export const getScraper = (id: string) =>
  api.get<{ success: boolean; scraper: Scraper }>(`/api/scraper/${id}`).then(r => r.data);

export const deleteScraper = (id: string) =>
  api.delete<{ success: boolean; message: string }>(`/api/scraper/${id}`).then(r => r.data);

export const searchScrapers = (q?: string, lang?: string, provider?: string) =>
  api.get<{ success: boolean; count: number; scrapers: Scraper[] }>("/api/scrapers/search", {
    params: { q, lang, provider },
  }).then(r => r.data);

export const getStats = () =>
  api.get<{ success: boolean; stats: ScraperStats }>("/api/scrapers/stats").then(r => r.data);

// ── Try Output ────────────────────────────────────────────────
export const tryScraper = (id: string, params: Record<string, string>) =>
  api.post<{ success: boolean; preview: any }>(`/api/scraper/${id}/try`, params).then(r => r.data);

// ── Fix Engine ────────────────────────────────────────────────
export const fixScraper = (
  id: string,
  errorMessage: string,
  provider: Provider,
  apiKey: string,
  model: string | undefined,
  fixMode: FixMode
) => api.post<FixResult>(`/api/scraper/${id}/fix`, { errorMessage, provider, apiKey, model, fixMode }).then(r => r.data);

export const applyFix = (id: string, fixedCode: string, changeLog?: string) =>
  api.post<{ success: boolean; message: string; fixCount: number }>(`/api/scraper/${id}/apply`, { fixedCode, changeLog }).then(r => r.data);

export const revertScraper = (id: string, version?: number) =>
  api.post<{ success: boolean; message: string }>(`/api/scraper/${id}/revert`, { version }).then(r => r.data);

export const editScraper = (id: string, instruction: string, provider: Provider, apiKey: string, model?: string) =>
  api.post<{ success: boolean; editedCode: string; message: string }>(`/api/scraper/${id}/edit`, { instruction, provider, apiKey, model }).then(r => r.data);

// ── History ───────────────────────────────────────────────────
export const getHistory = (id: string) =>
  api.get(`/api/scraper/${id}/history`).then(r => r.data);

// ── API Docs ──────────────────────────────────────────────────
export const getApiDocs = () =>
  api.get<ApiDocs>("/api/docs").then(r => r.data);

// ── v4: API Routes ────────────────────────────────────────────
export const createApiRoute = (scraperId: string, route: Omit<ApiRoute, "id" | "scraperId" | "createdAt">) =>
  api.post<{ success: boolean; route: ApiRoute; message: string }>(`/api/scraper/${scraperId}/routes`, route).then(r => r.data);

export const getApiRoutes = (scraperId: string) =>
  api.get<{ success: boolean; routes: ApiRoute[] }>(`/api/scraper/${scraperId}/routes`).then(r => r.data);

export const deleteApiRoute = (scraperId: string, routeId: string) =>
  api.delete<{ success: boolean; message: string }>(`/api/scraper/${scraperId}/routes/${routeId}`).then(r => r.data);

export const getAllApiRoutes = () =>
  api.get<{ success: boolean; routes: ApiRoute[]; total: number }>("/api/routes").then(r => r.data);

// ── Auto Install ──────────────────────────────────────────────
export const installDeps = (scraperId: string, packages?: string[]) =>
  api.post<{ success: boolean; message: string; output: string }>(`/api/scraper/${scraperId}/install`, { packages }).then(r => r.data);

// ── Download helpers (window.location) ───────────────────────
export const downloadFile = (id: string) => {
  window.location.href = `/api/scraper/${id}/download`;
};

export const downloadZip = (id: string) => {
  window.location.href = `/api/scraper/${id}/zip`;
};

export const exportAllZip = () => {
  window.location.href = "/api/export/zip";
};

export default api;
