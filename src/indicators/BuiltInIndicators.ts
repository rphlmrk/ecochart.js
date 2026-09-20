import { BaseIndicator, SMAEngine, EMAEngine, type IndicatorLayout } from './Indicator';
import type { DataStore } from '../data/DataStore';
import type { ChartRenderer } from '../renderer/ChartRenderer';
import { ThemeManager } from '../theme/ThemeManager';
import { StrokeEngine } from '../renderer/StrokeEngine';
import { Graphics } from 'pixi.js';

function parseColor(val: string | number): number {
    if (typeof val === 'number') return val;
    if (typeof val === 'string') return ThemeManager.hexToInt(val);
    return 0xffffff;
}

// ==========================================
// 1. SIMPLE MOVING AVERAGE (SMA)
// ==========================================
export class SMAIndicator extends BaseIndicator {
    constructor(period = 20, color = '#FFC107') {
        super(`SMA_${period}`, `SMA (${period})`);
        this.params = [
            { id: 'length', name: 'Length', type: 'number', value: period, min: 1, max: 500 },
            { id: 'color', name: 'Line Color', type: 'color', value: color }
        ];
    }

    protected onParamsUpdated(): void {
        const len = this.getParam<number>('length', 20);
        this.id = `SMA_${len}`;
        this.name = `SMA (${len})`;
    }

    protected calculate(ds: DataStore) {
        const length = Math.max(1, this.getParam<number>('length', 20));
        this.lastCalculatedIdx = SMAEngine.calculate(ds, length, this.values, this.lastCalculatedIdx);
    }

    public render(r: ChartRenderer, layout: IndicatorLayout, g: Graphics) {
        const length = Math.max(1, this.getParam<number>('length', 20));
        const rawColor = this.getParam('color', '#FFC107');
        
        // Deepen yellow slightly on light themes for high-contrast legibility
        let color = parseColor(rawColor);
        if (!r.isDarkTheme && rawColor.toUpperCase() === '#FFC107') {
            color = 0xD97706; // Amber
        }

        const sp = r.candleSpacing * r.zoom;
        const visStart = Math.max(length, Math.floor(r.cameraX / sp));
        const visEnd = Math.min(r.dataStore.length, Math.floor((r.cameraX + layout.chartWidth) / sp) + 1);

        let isDrawing = false;
        for (let i = visStart; i < visEnd; i++) {
            const x = (i * sp) - r.cameraX + (sp * 0.4);
            const y = layout.mainChartHeight - (((this.values[i] - r.currentMinPrice) / (r.currentMaxPrice - r.currentMinPrice)) * layout.mainChartHeight) + r.cameraY;

            if (!isDrawing) {
                g.moveTo(x, y);
                isDrawing = true;
            } else {
                g.lineTo(x, y);
            }
        }
        g.stroke({ color, width: 2 });
    }
}

// ==========================================
// 2. EXPONENTIAL MOVING AVERAGE (EMA)
// ==========================================
export class EMAIndicator extends BaseIndicator {
    constructor(period = 20, color = '#00BCD4') {
        super(`EMA_${period}`, `EMA (${period})`);
        this.params = [
            { id: 'length', name: 'Length', type: 'number', value: period, min: 1, max: 500 },
            { id: 'color', name: 'Line Color', type: 'color', value: color }
        ];
    }

    protected onParamsUpdated(): void {
        const len = this.getParam<number>('length', 20);
        this.id = `EMA_${len}`;
        this.name = `EMA (${len})`;
    }

    protected calculate(ds: DataStore) {
        const length = Math.max(1, this.getParam<number>('length', 20));
        this.lastCalculatedIdx = EMAEngine.calculate(ds, length, this.values, this.lastCalculatedIdx);
    }

    public render(r: ChartRenderer, layout: IndicatorLayout, g: Graphics) {
        const color = parseColor(this.getParam('color', '#00BCD4'));
        const sp = r.candleSpacing * r.zoom;
        const visStart = Math.max(1, Math.floor(r.cameraX / sp));
        const visEnd = Math.min(r.dataStore.length, Math.floor((r.cameraX + layout.chartWidth) / sp) + 1);

        let isDrawing = false;
        for (let i = visStart; i < visEnd; i++) {
            const x = (i * sp) - r.cameraX + (sp * 0.4);
            const y = layout.mainChartHeight - (((this.values[i] - r.currentMinPrice) / (r.currentMaxPrice - r.currentMinPrice)) * layout.mainChartHeight) + r.cameraY;

            if (!isDrawing) {
                g.moveTo(x, y);
                isDrawing = true;
            } else {
                g.lineTo(x, y);
            }
        }
        g.stroke({ color, width: 2 });
    }
}

// ==========================================
// 3. VOLUME OVERLAY (Theme-Reactive)
// ==========================================
export class VolumeIndicator extends BaseIndicator {
    constructor() {
        super('VOL', 'Volume');
        this.params = [
            { id: 'heightPct', name: 'Pane Height %', type: 'number', value: 0.15, min: 0.05, max: 0.5, step: 0.05 },
            { id: 'upColor', name: 'Up Vol Color', type: 'color', value: '#26A69A' },
            { id: 'downColor', name: 'Down Vol Color', type: 'color', value: '#EF5350' },
            { id: 'opacity', name: 'Bar Opacity', type: 'number', value: 0.4, min: 0.1, max: 1.0, step: 0.05 }
        ];
    }

    protected calculate(_ds: DataStore) {}

    public render(r: ChartRenderer, layout: IndicatorLayout, g: Graphics) {
        const heightPct = this.getParam<number>('heightPct', 0.15);
        const rawUp = this.getParam('upColor', '#26A69A');
        const rawDown = this.getParam('downColor', '#EF5350');

        // Automatically bind to theme candle colors if left at default
        const upColor = rawUp === '#26A69A' ? r.bullColor : parseColor(rawUp);
        const downColor = rawDown === '#EF5350' ? r.bearColor : parseColor(rawDown);

        // Boost opacity on light themes so pastel bars do not wash out
        const customOpacity = this.getParam<number>('opacity', 0.4);
        const opacity = r.isDarkTheme ? customOpacity : Math.min(0.9, customOpacity * 1.6);

        const sp = r.candleSpacing * r.zoom;
        const visStart = Math.max(0, Math.floor(r.cameraX / sp));
        const visEnd = Math.min(r.dataStore.length, Math.floor((r.cameraX + layout.chartWidth) / sp) + 1);

        let maxVol = 0;
        for (let i = visStart; i < visEnd; i++) {
            maxVol = Math.max(maxVol, r.dataStore.data[i * 6 + 5]);
        }
        if (maxVol === 0) return;

        const maxH = layout.mainChartHeight * heightPct;
        const barW = Math.max(2, sp * 0.8);

        for (let i = visStart; i < visEnd; i++) {
            const base = i * 6;
            const open = r.dataStore.data[base + 1];
            const close = r.dataStore.data[base + 4];
            const vol = r.dataStore.data[base + 5];

            const x = (i * sp) - r.cameraX;
            const h = (vol / maxVol) * maxH;
            const y = layout.mainChartHeight - h;

            const color = close >= open ? upColor : downColor;
            g.rect(x, y, barW, h).fill({ color, alpha: opacity });
        }
    }
}

// ==========================================
// 4. EXHAUSTION (CCI STOIC OSCILLATOR)
// ==========================================
export class ExhaustionIndicator extends BaseIndicator {
    constructor(period = 20, threshold = 80) {
        super('EXHAUST', 'Exhaustion (CCI)', true);
        this.params = [
            { id: 'length', name: 'CCI Length', type: 'number', value: period, min: 2, max: 200 },
            { id: 'threshold', name: 'Extreme Level', type: 'number', value: threshold, min: 10, max: 200, step: 10 },
            { id: 'bullColor', name: 'Bull Extreme Color', type: 'color', value: '#00FFEA' },
            { id: 'bearColor', name: 'Bear Extreme Color', type: 'color', value: '#FF9800' },
            { id: 'lineColor', name: 'Line Color', type: 'color', value: '#FFFFFF' }
        ];

        // Define the independent sub-axis scale
        this.oscillatorScale = {
            min: -150,
            max: 150,
            steps: [threshold, 0, -threshold],
            format: (v) => (v > 0 ? `+${v}` : `${v}`)
        };
    }

    protected onParamsUpdated(): void {
        const thresh = this.getParam<number>('threshold', 80);
        if (this.oscillatorScale) {
            this.oscillatorScale.steps = [thresh, 0, -thresh];
        }
    }

    protected calculate(ds: DataStore) {
        const period = Math.max(2, this.getParam<number>('length', 20));
        const start = Math.max(period - 1, this.lastCalculatedIdx === -1 ? 0 : this.lastCalculatedIdx);

        for (let i = start; i < ds.length; i++) {
            let sum = 0;
            const tps = new Float64Array(period);
            for (let j = 0; j < period; j++) {
                const base = (i - j) * 6;
                const tp = (ds.data[base + 2] + ds.data[base + 3] + ds.data[base + 4]) / 3;
                tps[j] = tp;
                sum += tp;
            }
            const sma = sum / period;
            let madSum = 0;
            for (let j = 0; j < period; j++) {
                madSum += Math.abs(tps[j] - sma);
            }
            const mad = madSum / period;
            this.values[i] = mad === 0 ? 0 : (tps[0] - sma) / (0.015 * mad);
        }
        this.lastCalculatedIdx = ds.length - 1;
    }

    public render(r: ChartRenderer, layout: IndicatorLayout, g: Graphics) {
        const period = Math.max(2, this.getParam<number>('length', 20));
        const bullColor = parseColor(this.getParam('bullColor', '#00FFEA'));
        const bearColor = parseColor(this.getParam('bearColor', '#FF9800'));
        const rawLineColor = String(this.getParam('lineColor', '#FFFFFF')).toUpperCase();

        // High-Contrast Auto-Flip: Invert white line to dark theme text color on light themes
        const lineColor = (rawLineColor === '#FFFFFF' && !r.isDarkTheme)
            ? r.axisTextColor
            : parseColor(rawLineColor);

        const sp = r.candleSpacing * r.zoom;
        const visStart = Math.max(period, Math.floor(r.cameraX / sp));
        const visEnd = Math.min(r.dataStore.length, Math.floor((r.cameraX + layout.chartWidth) / sp) + 1);

        // 1. Subtle Background Fill for the entire oscillator pane
        g.rect(0, layout.oscY, layout.chartWidth, layout.oscHeight).fill({ color: r.axisBgColor, alpha: 0.35 });

        // 2. Zone Bands (Enhanced opacity on light themes)
        const bandAlpha = r.isDarkTheme ? 0.12 : 0.22;
        const yUpperBand = layout.oscY + layout.oscHeight * 0.25;
        const yLowerBand = layout.oscY + layout.oscHeight * 0.75;
        const midY = layout.oscY + (layout.oscHeight / 2);

        g.rect(0, layout.oscY, layout.chartWidth, layout.oscHeight * 0.25).fill({ color: bullColor, alpha: bandAlpha });
        g.rect(0, yLowerBand, layout.chartWidth, layout.oscHeight * 0.25).fill({ color: bearColor, alpha: bandAlpha });

        // 3. Zone Boundary & Zero Lines (Universal Contrast)
        const zeroLineColor = r.isDarkTheme ? 0xFFFFFF : r.axisTextColor;
        StrokeEngine.drawLine(g, 0, midY, layout.chartWidth, midY, {
            color: zeroLineColor,
            width: 1,
            alpha: 0.25,
            style: 'solid'
        });

        StrokeEngine.drawLine(g, 0, yUpperBand, layout.chartWidth, yUpperBand, {
            color: bullColor,
            width: 1,
            alpha: 0.35,
            style: 'dashed',
            dashLength: 4,
            gapLength: 3
        });

        StrokeEngine.drawLine(g, 0, yLowerBand, layout.chartWidth, yLowerBand, {
            color: bearColor,
            width: 1,
            alpha: 0.35,
            style: 'dashed',
            dashLength: 4,
            gapLength: 3
        });

        // 4. Draw Oscillating Signal Curve
        let isDrawing = false;
        for (let i = visStart; i < visEnd; i++) {
            const x = (i * sp) - r.cameraX + (sp * 0.4);
            let val = this.values[i];
            if (val > 300) val = 300;
            if (val < -300) val = -300;
            
            const y = layout.oscY + layout.oscHeight / 2 - (val * (layout.oscHeight / 600));

            if (!isDrawing) {
                g.moveTo(x, y);
                isDrawing = true;
            } else {
                g.lineTo(x, y);
            }
        }
        g.stroke({ color: lineColor, width: 1.5 });
    }
}

// ==========================================
// 5. HIGHER TIMEFRAME (HTF) BOX
// ==========================================
export class HTFBoxIndicator extends BaseIndicator {
    constructor(tfMins = 60) {
        super(`HTF_BOX_${tfMins}`, `HTF Box (${tfMins}m)`);
        this.params = [
            { id: 'tfMins', name: 'Timeframe (Mins)', type: 'select', value: String(tfMins), options: ['15', '30', '60', '120', '240', '1440'] },
            { id: 'opacity', name: 'Body Opacity', type: 'number', value: 0.15, min: 0.05, max: 1.0, step: 0.05 },
            { id: 'showWicks', name: 'Show Wicks', type: 'boolean', value: true }
        ];
    }

    protected onParamsUpdated(): void {
        const tfMins = parseInt(this.getParam<string>('tfMins', '60'), 10) || 60;
        this.id = `HTF_BOX_${tfMins}`;
        this.name = `HTF Box (${tfMins}m)`;
    }

    protected calculate(_ds: DataStore) {}

    public render(r: ChartRenderer, layout: IndicatorLayout, g: Graphics) {
        const tfMins = parseInt(this.getParam<string>('tfMins', '60'), 10) || 60;
        const customOpacity = this.getParam<number>('opacity', 0.15);
        const showWicks = this.getParam<boolean>('showWicks', true);

        // Boost opacity on light themes so boxes are immediately apparent
        const opacity = r.isDarkTheme ? customOpacity : Math.min(0.8, customOpacity * 1.8);

        const tfMs = tfMins * 60 * 1000;
        const sp = r.candleSpacing * r.zoom;
        const visStart = Math.max(0, Math.floor(r.cameraX / sp));
        const visEnd = Math.min(r.dataStore.length, Math.floor((r.cameraX + layout.chartWidth) / sp) + 1);

        let blockStartMs = 0;
        let blockO = 0, blockH = -Infinity, blockL = Infinity, blockC = 0;
        let startX = 0;

        for (let i = visStart; i < visEnd; i++) {
            const base = i * 6;
            const t = r.dataStore.data[base];
            const bTime = Math.floor(t / tfMs) * tfMs;

            if (blockStartMs === 0 || bTime !== blockStartMs) {
                if (blockStartMs !== 0) {
                    const endX = (i * sp) - r.cameraX;
                    this.drawBox(r, layout, g, startX, endX, blockO, blockH, blockL, blockC, opacity, showWicks);
                }
                blockStartMs = bTime;
                startX = (i * sp) - r.cameraX;
                blockO = r.dataStore.data[base + 1];
                blockH = r.dataStore.data[base + 2];
                blockL = r.dataStore.data[base + 3];
            } else {
                blockH = Math.max(blockH, r.dataStore.data[base + 2]);
                blockL = Math.min(blockL, r.dataStore.data[base + 3]);
            }
            blockC = r.dataStore.data[base + 4];
        }

        if (blockStartMs !== 0) {
            const endX = (visEnd * sp) - r.cameraX;
            this.drawBox(r, layout, g, startX, endX, blockO, blockH, blockL, blockC, opacity, showWicks);
        }
    }

    private drawBox(
        r: ChartRenderer, layout: IndicatorLayout, g: Graphics,
        x1: number, x2: number, o: number, h: number, l: number, c: number,
        opacity: number, showWicks: boolean
    ) {
        const yTop = layout.mainChartHeight - (((Math.max(o, c) - r.currentMinPrice) / (r.currentMaxPrice - r.currentMinPrice)) * layout.mainChartHeight) + r.cameraY;
        const yBot = layout.mainChartHeight - (((Math.min(o, c) - r.currentMinPrice) / (r.currentMaxPrice - r.currentMinPrice)) * layout.mainChartHeight) + r.cameraY;
        const isBull = c >= o;
        const color = isBull ? r.bullColor : r.bearColor;

        const borderAlpha = r.isDarkTheme ? 0.5 : 0.8;

        if (showWicks) {
            const yH = layout.mainChartHeight - (((h - r.currentMinPrice) / (r.currentMaxPrice - r.currentMinPrice)) * layout.mainChartHeight) + r.cameraY;
            const yL = layout.mainChartHeight - (((l - r.currentMinPrice) / (r.currentMaxPrice - r.currentMinPrice)) * layout.mainChartHeight) + r.cameraY;
            const xMid = x1 + (x2 - x1) / 2;

            g.moveTo(xMid, yH).lineTo(xMid, yTop).stroke({ color, alpha: borderAlpha, width: 1.5 });
            g.moveTo(xMid, yBot).lineTo(xMid, yL).stroke({ color, alpha: borderAlpha, width: 1.5 });
        }

        g.rect(x1, yTop, Math.max(1, x2 - x1), Math.max(1, yBot - yTop)).fill({ color, alpha: opacity });
        g.rect(x1, yTop, Math.max(1, x2 - x1), Math.max(1, yBot - yTop)).stroke({ color, alpha: borderAlpha, width: 1.5 });
    }
}