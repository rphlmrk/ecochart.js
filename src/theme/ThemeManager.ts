import type { ChartTheme, AccentSource } from './types';
import { THEME_PRESETS } from './presets';

export class ThemeManager {
    private static instance: ThemeManager;
    private currentTheme: ChartTheme;
    private listeners: Array<(theme: ChartTheme) => void> = [];
    private readonly STORAGE_KEY = 'ecochart_theme_config';

    private constructor() {
        this.currentTheme = this.loadStoredTheme() || { ...THEME_PRESETS['midnight-abyss'] };
        this.applyTheme(this.currentTheme, false);
    }

    public static getInstance(): ThemeManager {
        if (!ThemeManager.instance) {
            ThemeManager.instance = new ThemeManager();
        }
        return ThemeManager.instance;
    }

    public getTheme(): ChartTheme {
        return { ...this.currentTheme };
    }

    public getResolvedAccentColor(): string {
        return this.currentTheme.accentSource === 'bull'
            ? this.currentTheme.bullBody
            : this.currentTheme.accentColor;
    }

    public setThemeById(id: string) {
        const preset = THEME_PRESETS[id];
        if (preset) {
            this.applyTheme({ ...preset });
        }
    }

    public setAccentSource(source: AccentSource, customColor?: string) {
        this.currentTheme.accentSource = source;
        if (customColor) {
            this.currentTheme.accentColor = customColor;
        }
        this.applyTheme(this.currentTheme);
    }

    public updateColor(key: keyof ChartTheme, value: string) {
        (this.currentTheme as any)[key] = value;
        this.applyTheme(this.currentTheme);
    }

    public subscribe(listener: (theme: ChartTheme) => void): () => void {
        this.listeners.push(listener);
        listener(this.getTheme());
        return () => {
            this.listeners = this.listeners.filter((l) => l !== listener);
        };
    }

    private applyTheme(theme: ChartTheme, persist = true) {
        this.currentTheme = theme;
        this.injectCSSVariables(theme);

        if (persist) {
            this.saveTheme(theme);
        }

        const resolvedTheme = this.getTheme();
        for (const listener of this.listeners) {
            listener(resolvedTheme);
        }
    }

    private injectCSSVariables(theme: ChartTheme) {
        if (typeof document === 'undefined') return;
        const root = document.documentElement;
        const accent = this.getResolvedAccentColor();

        root.style.setProperty('--chart-bg', theme.background);
        root.style.setProperty('--chart-panel-bg', theme.panelBackground);
        root.style.setProperty('--chart-grid', theme.gridLines);
        root.style.setProperty('--chart-text', theme.axisText);
        root.style.setProperty('--chart-crosshair', theme.crosshair);
        root.style.setProperty('--chart-bull', theme.bullBody);
        root.style.setProperty('--chart-bear', theme.bearBody);
        root.style.setProperty('--chart-accent', accent);
    }

    private saveTheme(theme: ChartTheme) {
        try {
            localStorage.setItem(this.STORAGE_KEY, JSON.stringify(theme));
        } catch {
            // Ignored if storage quota exceeded or disabled
        }
    }

    private loadStoredTheme(): ChartTheme | null {
        try {
            const raw = localStorage.getItem(this.STORAGE_KEY);
            return raw ? JSON.parse(raw) : null;
        } catch {
            return null;
        }
    }

    public static hexToInt(hex: string): number {
        return parseInt(hex.replace('#', '').slice(0, 6), 16);
    }

    public static hexToColorAndAlpha(hex: string): { color: number; alpha: number } {
        const clean = hex.replace('#', '');
        const color = parseInt(clean.slice(0, 6), 16) || 0;
        let alpha = 1;
        if (clean.length >= 8) {
            alpha = parseInt(clean.slice(6, 8), 16) / 255;
        }
        return { color, alpha };
    }
}

export const themeManager = ThemeManager.getInstance();