// ════════════════════════════════════════
//  SmartScrapeAI v4 — Zustand Store
// ════════════════════════════════════════

import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { View, Provider, Lang, FixMode, AnalyzeResult, Scraper, Toast, FixResult, TrySchemaField } from "./types";

let toastCounter = 0;

interface AppState {
  // ── View ──────────────────────────────
  activeView: View;
  setView: (v: View) => void;

  // ── Provider Config ───────────────────
  provider:  Provider;
  apiKey:    string;
  model:     string;
  setProvider: (p: Provider) => void;
  setApiKey:   (k: string) => void;
  setModel:    (m: string) => void;

  // ── Generator Flow ────────────────────
  genStep:       0 | 1 | 2 | 3;
  genUrl:        string;
  genAnalysis:   AnalyzeResult | null;
  genTarget:     string;
  genLang:       Lang;
  genBypassCF:   boolean;
  genResult:     { id: string; code: string; trySchema?: TrySchemaField[] } | null;

  setGenStep:     (s: 0 | 1 | 2 | 3) => void;
  setGenUrl:      (u: string) => void;
  setGenAnalysis: (a: AnalyzeResult | null) => void;
  setGenTarget:   (t: string) => void;
  setGenLang:     (l: Lang) => void;
  setGenBypassCF: (b: boolean) => void;
  setGenResult:   (r: { id: string; code: string; trySchema?: TrySchemaField[] } | null) => void;
  resetGen:       () => void;

  // ── Scrapers ──────────────────────────
  scrapers:    Scraper[];
  setScrapers: (s: Scraper[]) => void;

  // ── Fix Engine ────────────────────────
  fixScraperId: string | null;
  fixResult:    FixResult | null;
  setFixScraperId: (id: string | null) => void;
  setFixResult:    (r: FixResult | null) => void;

  // ── Toasts ────────────────────────────
  toasts:      Toast[];
  addToast:    (type: Toast["type"], msg: string) => void;
  removeToast: (id: string) => void;
}

export const useStore = create<AppState>()(
  persist(
    (set) => ({
      // ── View ──────────────────────────
      activeView: "generator",
      setView: (v) => set({ activeView: v }),

      // ── Provider Config ───────────────
      provider:    "anthropic",
      apiKey:      "",
      model:       "",
      setProvider: (p) => set({ provider: p, model: "" }),
      setApiKey:   (k) => set({ apiKey: k }),
      setModel:    (m) => set({ model: m }),

      // ── Generator Flow ────────────────
      genStep:     0,
      genUrl:      "",
      genAnalysis: null,
      genTarget:   "",
      genLang:     "nodejs",
      genBypassCF: false,
      genResult:   null,

      setGenStep:     (s) => set({ genStep: s }),
      setGenUrl:      (u) => set({ genUrl: u }),
      setGenAnalysis: (a) => set({ genAnalysis: a }),
      setGenTarget:   (t) => set({ genTarget: t }),
      setGenLang:     (l) => set({ genLang: l }),
      setGenBypassCF: (b) => set({ genBypassCF: b }),
      setGenResult:   (r) => set({ genResult: r }),
      resetGen: () => set({
        genStep: 0, genUrl: "", genAnalysis: null,
        genTarget: "", genLang: "nodejs", genBypassCF: false, genResult: null,
      }),

      // ── Scrapers ──────────────────────
      scrapers:    [],
      setScrapers: (s) => set({ scrapers: s }),

      // ── Fix Engine ────────────────────
      fixScraperId: null,
      fixResult:    null,
      setFixScraperId: (id) => set({ fixScraperId: id }),
      setFixResult:    (r)  => set({ fixResult: r }),

      // ── Toasts ────────────────────────
      toasts:      [],
      addToast: (type, msg) => set(state => ({
        toasts: [
          ...state.toasts.slice(-4),
          { id: `${Date.now()}-${toastCounter++}`, type, msg },
        ],
      })),
      removeToast: (id) => set(state => ({
        toasts: state.toasts.filter(t => t.id !== id),
      })),
    }),
    {
      name: "smartscrape-v4",
      partialize: (s) => ({
        provider: s.provider,
        apiKey:   s.apiKey,
        model:    s.model,
        genUrl:   s.genUrl,
        genLang:  s.genLang,
      }),
    }
  )
);
