import type { ChartTheme, AccentSource } from './types';
import { THEME_PRESETS } from './presets';

export type DynamicThemeMode = 'manual' | 'schedule' | 'session' | 'system' | 'solar-session';

export interface DynamicThemeConfig {
    mode: DynamicThemeMode;
    dayThemeId: string;    // Light preset
    nightThemeId: string;  // Dark preset
    dayStartHour: number;  // Local 24h format (e.g. 7 for 07:00)
    nightStartHour: number;// Local 24h format (e.g. 19 for 19:00)
}

export class ThemeManager {
    private static instance: ThemeManager;
    private currentTheme: ChartTheme;
    private listeners: Array<(theme: ChartTheme) => void> = [];
    private readonly STORAGE_KEY = 'ecochart_theme_config';

    private dynamicConfig: DynamicThemeConfig;
    private readonly DYNAMIC_STORAGE_KEY = 'ecochart_dynamic_theme_config';

    private constructor() {
        this.currentTheme = this.loadStoredTheme() || { ...THEME_PRESETS['midnight-abyss'] };
        this.dynamicConfig = this.loadStoredDynamicConfig() || {
            mode: 'manual',
            dayThemeId: 'solar-spark',
            nightThemeId: 'midnight-abyss',
            dayStartHour: 7,
            nightStartHour: 19
        };
        this.applyTheme(this.currentTheme, false);
        this.evaluateDynamicTheme();
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

    // =========================================================================
    // 🕒 DYNAMIC TIME & SESSION THEME ENGINE (Options A - D)
    // =========================================================================

    public getDynamicConfig(): DynamicThemeConfig {
        return { ...this.dynamicConfig };
    }

    public setDynamicConfig(config: Partial<DynamicThemeConfig>) {
        this.dynamicConfig = { ...this.dynamicConfig, ...config };
        this.saveDynamicConfig(this.dynamicConfig);
        this.evaluateDynamicTheme();
    }

    /**
     * Evaluates active mode (A, B, C, D) and smoothly transitions theme if changed
     */
    public evaluateDynamicTheme() {
        if (this.dynamicConfig.mode === 'manual') return;

        const now = new Date();
        const localHour = now.getHours();
        const floatHourUTC = now.getUTCHours() + (now.getUTCMinutes() / 60);

        let targetThemeId = this.currentTheme.id;
        let targetAccentOverride: string | null = null;

        // --- OPTION A: SCHEDULED DAY & NIGHT ---
        if (this.dynamicConfig.mode === 'schedule') {
            const isDay = localHour >= this.dynamicConfig.dayStartHour && localHour < this.dynamicConfig.nightStartHour;
            targetThemeId = isDay ? this.dynamicConfig.dayThemeId : this.dynamicConfig.nightThemeId;
        }

        // --- OPTION B: MARKET SESSION PRESETS ---
        else if (this.dynamicConfig.mode === 'session') {
            if (floatHourUTC >= 13.5 && floatHourUTC < 20.0) {
                targetThemeId = 'solar-spark';      // New York Open (Energetic daylight)
            } else if (floatHourUTC >= 8.0 && floatHourUTC < 16.5) {
                targetThemeId = 'corporate-trust';  // London Open (Crisp European finance)
            } else if (floatHourUTC >= 0.0 && floatHourUTC < 9.0) {
                targetThemeId = 'cyberpunk-neon';   // Tokyo/Asia Open (Futuristic dark)
            } else {
                targetThemeId = 'midnight-abyss';   // Off-hours dark
            }
        }

        // --- OPTION C: FOLLOW SYSTEM OS ---
        else if (this.dynamicConfig.mode === 'system') {
            const prefersDark = typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
            targetThemeId = prefersDark ? this.dynamicConfig.nightThemeId : this.dynamicConfig.dayThemeId;
        }

        // --- OPTION D: SOLAR SESSION FLOW ---
        // Transitions Day (Light) -> Night (Dark) with the active market session color injected
        else if (this.dynamicConfig.mode === 'solar-session') {
            const isDay = localHour >= this.dynamicConfig.dayStartHour && localHour < this.dynamicConfig.nightStartHour;
            targetThemeId = isDay ? this.dynamicConfig.dayThemeId : this.dynamicConfig.nightThemeId;

            // Session opening colors
            if (floatHourUTC >= 13.5 && floatHourUTC < 20.0) {
                targetAccentOverride = '#EF5350'; // New York Coral
            } else if (floatHourUTC >= 8.0 && floatHourUTC < 16.5) {
                targetAccentOverride = '#2962FF'; // London Royal Blue
            } else if (floatHourUTC >= 0.0 && floatHourUTC < 9.0) {
                targetAccentOverride = '#FBC02D'; // Asia Gold
            }
        }

        const basePreset = THEME_PRESETS[targetThemeId];
        if (!basePreset) return;

        const resolvedAccent = targetAccentOverride || (basePreset.accentSource === 'bull' ? basePreset.bullBody : basePreset.accentColor);

        // Guard: Only fire updates if the preset ID or accent color actually transitioned
        const hasIdChanged = this.currentTheme.id !== targetThemeId;
        const hasAccentChanged = this.getResolvedAccentColor().toUpperCase() !== resolvedAccent.toUpperCase();

        if (hasIdChanged || hasAccentChanged) {
            const newTheme: ChartTheme = { ...basePreset };
            if (targetAccentOverride) {
                newTheme.accentSource = 'custom';
                newTheme.accentColor = targetAccentOverride;
                newTheme.crosshair = targetAccentOverride;
            }
            this.applyTheme(newTheme);
        }
    }

    private saveDynamicConfig(config: DynamicThemeConfig) {
        try {
            localStorage.setItem(this.DYNAMIC_STORAGE_KEY, JSON.stringify(config));
        } catch {}
    }

    private loadStoredDynamicConfig(): DynamicThemeConfig | null {
        try {
            const raw = localStorage.getItem(this.DYNAMIC_STORAGE_KEY);
            return raw ? JSON.parse(raw) : null;
        } catch {
            return null;
        }
    }
}

export const themeManager = ThemeManager.getInstance();