import { Zap, Code2, Wrench, BookOpen, Terminal, Database } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useStore } from "./store";
import { ProviderBar } from "./components/ProviderBar";
import { GeneratorView } from "./components/GeneratorView";
import { ScrapersView } from "./components/ScrapersView";
import { FixEngineView } from "./components/FixEngineView";
import { DocsView } from "./components/DocsView";
import { StorageView } from "./components/StorageView";
import { ToastContainer } from "./components/Toast";
import type { View } from "./types";

interface NavItem { id: View; label: string; Icon: LucideIcon; }

const NAV_ITEMS: NavItem[] = [
  { id: "generator", label: "Generator",  Icon: Zap },
  { id: "scrapers",  label: "Scrapers",   Icon: Code2 },
  { id: "fix",       label: "Fix Engine", Icon: Wrench },
  { id: "storage",   label: "C3 Storage", Icon: Database },
  { id: "docs",      label: "API Docs",   Icon: BookOpen },
];

const VIEW_TITLES: Record<View, string> = {
  generator: "Scraper Generator",
  scrapers:  "Scraper Library",
  fix:       "AI Fix Engine",
  storage:   "C3 Storage Sync",
  docs:      "API Documentation",
};

export default function App() {
  const { activeView, setView } = useStore();

  return (
    <>
      <div className="bg-grid" />
      <div className="bg-orb bg-orb1" />
      <div className="bg-orb bg-orb2" />

      <div className="app-shell">
        <aside className="sidebar">
          <div className="sidebar-logo">
            <div className="sidebar-logo-mark">
              <span className="logo-ai">Smart</span>
              <span className="logo-scrape">Scrape</span>
              <span className="logo-ai">AI</span>
            </div>
            <div className="sidebar-ver">v4.0</div>
          </div>

          <nav className="sidebar-nav">
            {NAV_ITEMS.map(({ id, label, Icon }) => (
              <button
                key={id}
                className={`nav-item ${activeView === id ? "active" : ""}`}
                onClick={() => setView(id)}
              >
                <Icon size={16} />
                <span className="nav-item-label">{label}</span>
              </button>
            ))}
          </nav>

          <div className="sidebar-footer">
            <div className="sidebar-version">henhendrazat © 2025</div>
          </div>
        </aside>

        <main className="main-area">
          <header className="topbar">
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <Terminal size={15} style={{ color: "var(--neon)", opacity: .7 }} />
              <span className="topbar-title">{VIEW_TITLES[activeView]}</span>
            </div>
            <div style={{ flex: 1 }} />
            <ProviderBar />
          </header>

          <div className="content-area">
            {activeView === "generator" && <GeneratorView />}
            {activeView === "scrapers"  && <ScrapersView />}
            {activeView === "fix"       && <FixEngineView />}
            {activeView === "storage"   && <StorageView />}
            {activeView === "docs"      && <DocsView />}
          </div>
        </main>
      </div>

      <ToastContainer />
    </>
  );
}
