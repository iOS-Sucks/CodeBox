export const SETTINGS_KEY = 'codebox.settings.v1';

/** Accent stored as an "r,g,b" triple so themes and translucency derive from it. */
export const ACCENT_DEFAULT = '200,255,0';

export interface AccentPreset {
  name: string;
  rgb: string;
}

export const ACCENT_PRESETS: AccentPreset[] = [
  { name: 'Volt', rgb: '200,255,0' },
  { name: 'Blue', rgb: '3,140,252' },
  { name: 'Purple', rgb: '128,3,252' },
  { name: 'Gold', rgb: '252,169,3' },
  { name: 'Yellow', rgb: '252,240,3' },
  { name: 'Orange', rgb: '252,65,3' },
  { name: 'Red', rgb: '252,3,3' },
  { name: 'Mint', rgb: '3,252,173' },
  { name: 'Pink', rgb: '206,3,252' },
];

export interface AppSettings {
  version: 1;
  accent: string;
  /** Gradient accents instead of flat ones. Marked beta: may look off in spots. */
  gradients: boolean;
  fontSize: number;
  tabSize: 2 | 4;
  wrap: boolean;
  lineNumbers: boolean;
  autoPreview: boolean;
  consoleAutoOpen: boolean;
}

export const DEFAULT_SETTINGS: AppSettings = {
  version: 1,
  accent: ACCENT_DEFAULT,
  gradients: false,
  fontSize: 13,
  tabSize: 2,
  wrap: false,
  lineNumbers: true,
  autoPreview: true,
  consoleAutoOpen: true,
};

export function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<AppSettings>;
    return {
      version: 1,
      accent: typeof parsed.accent === 'string' && parseAccent(parsed.accent) ? parsed.accent : ACCENT_DEFAULT,
      gradients: parsed.gradients === true,
      fontSize:
        typeof parsed.fontSize === 'number' ? Math.min(18, Math.max(11, Math.round(parsed.fontSize))) : DEFAULT_SETTINGS.fontSize,
      tabSize: parsed.tabSize === 4 ? 4 : 2,
      wrap: parsed.wrap === true,
      lineNumbers: parsed.lineNumbers !== false,
      autoPreview: parsed.autoPreview !== false,
      consoleAutoOpen: parsed.consoleAutoOpen !== false,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(s: AppSettings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    // Private mode etc. — settings just don't persist.
  }
}

export type Rgb = [number, number, number];

/** Parse an "r,g,b" triple, clamped to 0–255. Null when unusable. */
export function parseAccent(raw: string): Rgb | null {
  const parts = raw.split(',').map((p) => Number(p.trim()));
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return null;
  return parts.map((n) => Math.min(255, Math.max(0, Math.round(n)))) as Rgb;
}

/** "r,g,b" → "#rrggbb" for the native color input. */
export function accentToHex(rgb: Rgb): string {
  return `#${rgb.map((n) => n.toString(16).padStart(2, '0')).join('')}`;
}

/** "#rrggbb" → "r,g,b". Null when unusable. */
export function hexToAccent(hex: string): string | null {
  const m = hex.trim().match(/^#?([0-9a-f]{6})$/i);
  if (!m) return null;
  const n = Number.parseInt(m[1], 16);
  return `${(n >> 16) & 255},${(n >> 8) & 255},${n & 255}`;
}

/** Point every accent-derived CSS variable at the new color. */
export function applyAccentToDom(rgb: Rgb): void {
  const [r, g, b] = rgb;
  const root = document.documentElement.style;
  root.setProperty('--volt', `rgb(${r},${g},${b})`);
  root.setProperty('--volt-dim', `rgba(${r},${g},${b},0.14)`);
  root.setProperty('--volt-select', `rgba(${r},${g},${b},0.25)`);
  root.setProperty('--volt-line', `rgba(${r},${g},${b},0.07)`);
  root.setProperty('--volt-gutter', `rgba(${r},${g},${b},0.08)`);
  root.setProperty('--volt-focus', `rgba(${r},${g},${b},0.55)`);
  root.setProperty('--volt-match', `rgba(${r},${g},${b},0.3)`);
  root.setProperty('--volt-hover', `rgba(${r},${g},${b},0.18)`);
}

export function applyGradientsToDom(on: boolean): void {
  document.body.classList.toggle('grad', on);
}

export function applySettingsToDom(s: AppSettings): void {
  applyAccentToDom(parseAccent(s.accent) ?? parseAccent(ACCENT_DEFAULT) ?? [200, 255, 0]);
  applyGradientsToDom(s.gradients);
}
