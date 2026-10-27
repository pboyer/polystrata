import {
  ChevronLeft,
  ChevronRight,
  createIcons,
  Gauge,
  type IconNode,
  Maximize,
  Moon,
  Pause,
  Play,
  RotateCcw,
  StepForward,
  Sun,
} from "lucide";

// Lucide 1.x dropped brand icons; this is the `github` glyph from lucide-static 0.469 (ISC).
const Github: IconNode = [
  [
    "path",
    {
      d: "M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4",
    },
  ],
  ["path", { d: "M9 18c-4.51 2-5-2-7-2" }],
];

const ICONS = {
  ChevronLeft,
  ChevronRight,
  Gauge,
  Github,
  Maximize,
  Moon,
  Pause,
  Play,
  RotateCcw,
  StepForward,
  Sun,
};

export function renderIcons(): void {
  createIcons({ icons: ICONS });
}

export interface CanvasPalette {
  dark: boolean;
  bg: string;
  ink: string;
  muted: string;
  grid: string;
  axis: string;
  gridLabel: string;
  bodyA: string;
  bodyB: string;
  bodyC: string;
  shell: string;
  hole: string;
  sample: string;
  sampleDiscarded: string;
  deltaW: string;
  edgeNeutral: string;
  radius: string;
  ok: string;
  bad: string;
  fills: string[];
}

const LIGHT: CanvasPalette = {
  dark: false,
  bg: "#ffffff",
  ink: "#0a0a0a",
  muted: "#8a8a8a",
  grid: "rgba(0, 0, 0, 0.045)",
  axis: "rgba(0, 0, 0, 0.16)",
  gridLabel: "rgba(0, 0, 0, 0.35)",
  bodyA: "#3f6f9f",
  bodyB: "#c0643a",
  bodyC: "#6f8a3c",
  shell: "#0a0a0a",
  hole: "#8b5a8f",
  sample: "#c39130",
  sampleDiscarded: "rgba(0, 0, 0, 0.3)",
  deltaW: "#b4607a",
  edgeNeutral: "rgba(0, 0, 0, 0.3)",
  radius: "rgba(195, 145, 48, 0.6)",
  ok: "#2f7d4f",
  bad: "#b8433a",
  // sage, sand, sky, clay
  fills: ["rgba(127, 159, 122, 0.26)", "rgba(201, 164, 106, 0.26)", "rgba(127, 159, 191, 0.26)", "rgba(185, 132, 114, 0.26)"],
};

const DARK: CanvasPalette = {
  dark: true,
  bg: "#000000",
  ink: "#f2f2f2",
  muted: "#7a7a7a",
  grid: "rgba(255, 255, 255, 0.05)",
  axis: "rgba(255, 255, 255, 0.18)",
  gridLabel: "rgba(255, 255, 255, 0.35)",
  bodyA: "#86aed6",
  bodyB: "#e08b62",
  bodyC: "#a7bf6c",
  shell: "#f2f2f2",
  hole: "#c497c4",
  sample: "#e0b357",
  sampleDiscarded: "rgba(255, 255, 255, 0.3)",
  deltaW: "#d98fa6",
  edgeNeutral: "rgba(255, 255, 255, 0.3)",
  radius: "rgba(224, 179, 87, 0.6)",
  ok: "#6fbf8b",
  bad: "#e07a6f",
  fills: ["rgba(127, 159, 122, 0.24)", "rgba(201, 164, 106, 0.22)", "rgba(127, 159, 191, 0.24)", "rgba(185, 132, 114, 0.24)"],
};

const STORAGE_KEY = "polystrata-theme";
const media = window.matchMedia("(prefers-color-scheme: dark)");
const listeners: Array<() => void> = [];

// Explicit user choice; null follows the OS setting.
let override: "light" | "dark" | null = (() => {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === "light" || v === "dark" ? v : null;
  } catch {
    return null;
  }
})();

export function isDark(): boolean {
  return override ? override === "dark" : media.matches;
}

export function palette(): CanvasPalette {
  return isDark() ? DARK : LIGHT;
}

/** Translucent version of a #rrggbb palette color. */
export function alpha(hex: string, a: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

function apply(): void {
  if (override) document.documentElement.dataset.theme = override;
  else delete document.documentElement.dataset.theme;
  const btn = document.getElementById("btn-theme");
  if (btn) {
    const dark = isDark();
    btn.innerHTML = `<i data-lucide="${dark ? "sun" : "moon"}"></i>`;
    btn.setAttribute("aria-label", dark ? "Switch to light mode" : "Switch to dark mode");
    btn.title = btn.getAttribute("aria-label")!;
    renderIcons();
  }
  for (const fn of listeners) fn();
}

export function onThemeChange(fn: () => void): void {
  listeners.push(fn);
}

/** Wire up the header theme toggle and Lucide icons. Call once after the DOM is ready. */
export function initTheme(): void {
  renderIcons();
  apply();
  media.addEventListener("change", apply);
  document.getElementById("btn-theme")?.addEventListener("click", () => {
    const next = isDark() ? "light" : "dark";
    // Picking the system's own preference clears the override so it keeps following the OS.
    override = (next === "dark") === media.matches ? null : next;
    try {
      if (override) localStorage.setItem(STORAGE_KEY, override);
      else localStorage.removeItem(STORAGE_KEY);
    } catch {
      // Storage unavailable; the choice lasts for this page view.
    }
    apply();
  });
}
