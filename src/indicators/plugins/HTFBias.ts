import { BaseIndicator, parseColor, type IndicatorLayout } from '../Indicator';
import type { DataStore } from '../../data/DataStore';
import type { ChartRenderer } from '../../renderer/ChartRenderer';
import { StrokeEngine } from '../../renderer/StrokeEngine';
import { Graphics } from 'pixi.js';

export class HTFBiasIndicator extends BaseIndicator {
    constructor(tfMins = 60) {
        super(`HTF_BIAS_${tfMins}`, `HTF Bias (${tfMins}m)`);
        this.params = [
            { id: 'tfMins', name: 'Timeframe', type: 'select', value: String(tfMins), options: ['15', '30', '45', '60', '120', '240', '480', '1440', 'Custom'] },
            { id: 'customMins', name: 'Custom Minutes', type: 'number', value: 21, min: 1, max: 43200, step: 1 },
            { id: 'displayMode', name: 'Display Mode', type: 'select', value: 'Top Ribbon', options: ['Top Ribbon', 'Overlay Lines', 'Both'] },
            { id: 'bullColor', name: 'Bull Bias Color', type: 'color', value: '#089981' },
            { id: 'bearColor', name: 'Bear Bias Color', type: 'color', value: '#F23645' },
            { id: 'showInsideBar', name: 'Show Inside Bar on Ribbon', type: 'boolean', value: true },
            { id: 'insideColor', name: 'Inside Bar Color', type: 'color', value: '#FFEB3B' },
            { id: 'showFutureClose', name: 'Show Future Close', type: 'boolean', value: true },
            { id: 'futureLineWidth', name: 'Future Line Width', type: 'number', value: 1, min: 1, max: 4, step: 0.5 },
            { id: 'sweepsOnly', name: 'Sweeps Only', type: 'boolean', value: false }
        ];
    }

    public getEffectiveTfMins(): number {
        const mode = this.getParam<string>('tfMins', '60');
        if (mode === 'Custom') {
            return Math.max(1, this.getParam<number>('customMins', 45));
        }
        return parseInt(mode, 10) || 60;
    }

    protected onParamsUpdated(): void {
        const tfMins = this.getEffectiveTfMins();
        this.id = `HTF_BIAS_${tfMins}`;
        this.name = `HTF Bias (${tfMins}m)`;
    }

    protected setup(): void {
        this.state = {
            cachedCandles: [],
            blockStartMs: 0,
            startIdx: 0, highIdx: 0, lowIdx: 0,
            o: 0, h: -Infinity, l: Infinity, c: 0
        };
    }

    protected override cloneState(state: any): any {
        return {
            ...state,
            cachedCandles: state.cachedCandles ? [...state.cachedCandles] : []
        };
    }

    protected next(index: number, _isClosed: boolean, ds: DataStore): void {
        const tfMs = this.getEffectiveTfMins() * 60 * 1000;
        const base = index * 6;
        const t = ds.data[base];
        const bTime = Math.floor(t / tfMs) * tfMs;
        const o = ds.data[base + 1], h = ds.data[base + 2], l = ds.data[base + 3], c = ds.data[base + 4];

        if (this.state.blockStartMs === 0 || bTime !== this.state.blockStartMs) {
            if (this.state.blockStartMs !== 0) {
                this.state.cachedCandles.push({
                    o: this.state.o, h: this.state.h, l: this.state.l, c: this.state.c,
                    highIdx: this.state.highIdx, lowIdx: this.state.lowIdx,
                    startIdx: this.state.startIdx, endIdx: index - 1
                });

                if (this.state.cachedCandles.length > 500) this.state.cachedCandles.shift();
            }
            this.state.blockStartMs = bTime;
            this.state.startIdx = index;
            this.state.highIdx = index;
            this.state.lowIdx = index;
            this.state.o = o;
            this.state.h = h;
            this.state.l = l;
        } else {
            if (h > this.state.h) { this.state.h = h; this.state.highIdx = index; }
            if (l < this.state.l) { this.state.l = l; this.state.lowIdx = index; }
        }
        this.state.c = c;
    }

    public render(r: ChartRenderer, layout: IndicatorLayout, g: Graphics) {
        const chartTfMs = r.parseIntervalMs(r.currentInterval);
        const tfMs = this.getEffectiveTfMins() * 60 * 1000;
        if (chartTfMs > tfMs) return; // <-- ADDED: Hide if chart TF > HTF

        const displayMode = this.getParam<string>('displayMode', 'Top Ribbon');

        // Dynamically link to theme colors if default params are used
        const rawBull = String(this.getParam('bullColor', '#089981')).toUpperCase();
        const rawBear = String(this.getParam('bearColor', '#F23645')).toUpperCase();
        const bullClr = rawBull === '#089981' ? r.bullColor : parseColor(rawBull);
        const bearClr = rawBear === '#F23645' ? r.bearColor : parseColor(rawBear);

        const sweepsOnly = this.getParam<boolean>('sweepsOnly', false);

        const showInsideBar = this.getParam<boolean>('showInsideBar', true);
        const insideClr = parseColor(this.getParam('insideColor', '#FFEB3B'));
        const showFutureClose = this.getParam<boolean>('showFutureClose', true);
        const futureLineWidth = this.getParam<number>('futureLineWidth', 1.5);

        const showRibbon = displayMode === 'Top Ribbon' || displayMode === 'Both';
        const showLines = displayMode === 'Overlay Lines' || displayMode === 'Both';

        const intervalMs = r.parseIntervalMs(r.currentInterval);
        const barsPerBlock = Math.max(1, Math.round(tfMs / intervalMs));

        const sp = r.candleSpacing * r.zoom;
        const visStart = Math.max(0, Math.floor(r.cameraX / sp));
        const visEnd = Math.min(r.dataStore.length, Math.floor((r.cameraX + layout.chartWidth) / sp) + 1);

        // Map over existing candles without doing an expensive spread [...] 
        const htfCandles = this.state.cachedCandles || [];
        const liveBlock = this.state.blockStartMs !== 0 ? {
            startIdx: this.state.startIdx, endIdx: r.dataStore.length - 1,
            highIdx: this.state.highIdx, lowIdx: this.state.lowIdx,
            o: this.state.o, h: this.state.h, l: this.state.l, c: this.state.c
        } : null;

        const totalBlocks = htfCandles.length + (liveBlock ? 1 : 0);
        if (totalBlocks < 2) return;

        // Helper to get candle by index without creating new arrays
        const getBlock = (idx: number) => idx < htfCandles.length ? htfCandles[idx] : liveBlock!;

        let mother = getBlock(0);
        let currentBias = 0;

        for (let i = 1; i < totalBlocks; i++) {
            const curr = getBlock(i);
            const isLast = i === totalBlocks - 1;
            const inView = !(curr.endIdx < visStart || curr.startIdx > visEnd);
            const isInside = curr.h <= mother.h && curr.l >= mother.l;

            let isBullSweep = false;
            let isBearSweep = false;

            if (!isInside) {
                const bearSignal = curr.c < curr.o && curr.h > curr.o;
                const bullSignal = curr.c > curr.o && curr.l < curr.o;

                isBearSweep = bearSignal && curr.h > mother.h;
                isBullSweep = bullSignal && curr.l < mother.l;

                if (sweepsOnly) {
                    if (isBullSweep) currentBias = 1;
                    else if (isBearSweep) currentBias = -1;
                    else currentBias = 0;
                } else {
                    if (bullSignal) currentBias = 1;
                    else if (bearSignal) currentBias = -1;
                    else currentBias = 0;
                }

                if (showLines && inView) {
                    if (isBearSweep) {
                        const x1 = (mother.highIdx * sp) - r.cameraX;
                        const x2 = (curr.highIdx * sp) - r.cameraX;
                        const y = layout.mainChartHeight - (((mother.h - r.currentMinPrice) / (r.currentMaxPrice - r.currentMinPrice)) * layout.mainChartHeight) + r.cameraY;
                        StrokeEngine.drawLine(g, x1, y, x2, y, { color: bearClr, width: 1.5, alpha: 0.8 });
                    } else if (isBullSweep) {
                        const x1 = (mother.lowIdx * sp) - r.cameraX;
                        const x2 = (curr.lowIdx * sp) - r.cameraX;
                        const y = layout.mainChartHeight - (((mother.l - r.currentMinPrice) / (r.currentMaxPrice - r.currentMinPrice)) * layout.mainChartHeight) + r.cameraY;
                        StrokeEngine.drawLine(g, x1, y, x2, y, { color: bullClr, width: 1.5, alpha: 0.8 });
                    }
                }

                mother = curr;
            }

            if (showRibbon && inView) {
                const x1 = (curr.startIdx * sp) - r.cameraX;
                // Extend active forming block to where the HTF session actually closes in the future
                const endBar = (isLast && showFutureClose)
                    ? (curr.startIdx + barsPerBlock)
                    : (curr.endIdx + 1);
                const x2 = (endBar * sp) - r.cameraX;

                const ribbonH = 18;
                const yTop = 6;

                // 1. Inside Bar on Ribbon (Compression state)
                if (isInside && showInsideBar) {
                    g.rect(x1, yTop, Math.max(1, x2 - x1), ribbonH).fill({ color: insideClr, alpha: 0.25 });
                    StrokeEngine.drawLine(g, x1, yTop, x2, yTop, { color: insideClr, width: 1.5, alpha: 0.8 });
                    StrokeEngine.drawLine(g, x1, yTop + ribbonH, x2, yTop + ribbonH, { color: insideClr, width: 1.5, alpha: 0.8 });

                    // 2. Trend Bias (Bull / Bear)
                } else if (currentBias !== 0) {
                    const color = currentBias === 1 ? bullClr : bearClr;
                    g.rect(x1, yTop, Math.max(1, x2 - x1), ribbonH).fill({ color, alpha: 0.2 });

                    if (isBearSweep) {
                        StrokeEngine.drawLine(g, x1, yTop, x2, yTop, { color: bearClr, width: 2.5, alpha: 0.9 });
                    } else if (isBullSweep) {
                        StrokeEngine.drawLine(g, x1, yTop + ribbonH, x2, yTop + ribbonH, { color: bullClr, width: 2.5, alpha: 0.9 });
                    }
                }

                // 3. Future Close: Clean vertical dashed line marking the session close time
                if (isLast && showFutureClose && x2 >= 0 && x1 <= layout.chartWidth) {
                    const vertLineColor = r.isDarkTheme ? 0xFFFF00 : 0xD97706; // Yellow on dark, Amber on light
                    StrokeEngine.drawLine(g, x2, 0, x2, layout.mainChartHeight, {
                        color: vertLineColor,
                        width: futureLineWidth,
                        alpha: 0.65,
                        style: 'dashed',
                        dashLength: 5,
                        gapLength: 3
                    });
                }
            }
        }
    }

    public getValueAt(idx: number, ds: DataStore, _isDark: boolean, _defaultTextClr: number) {
        const showInsideBar = this.getParam<boolean>('showInsideBar', true);
        const insideClr = parseColor(this.getParam('insideColor', '#FFEB3B'));

        // If the latest candle is an Inside Bar, reflect it in the telemetry
        const candles = this.state.cachedCandles || [];
        if (candles.length >= 1 && showInsideBar) {
            const last = { o: this.state.o, h: this.state.h, l: this.state.l, c: this.state.c }; // Active block
            const mother = candles[candles.length - 1];
            if (last.h <= mother.h && last.l >= mother.l) {
                return {
                    label: this.name,
                    valueStr: '⚡ Inside Bar',
                    valueColor: insideClr
                };
            }
        }

        const close = (idx >= 0 && idx < ds.length) ? ds.data[idx * 6 + 4] : 0;
        const open = (idx >= 0 && idx < ds.length) ? ds.data[idx * 6 + 1] : 0;
        const isBull = close >= open;

        const rawBull = String(this.getParam('bullColor', '#089981')).toUpperCase();
        const rawBear = String(this.getParam('bearColor', '#F23645')).toUpperCase();
        let bullClr = parseColor(rawBull);
        let bearClr = parseColor(rawBear);

        // Adjust defaults for light mode readability if using standard colors
        if (!_isDark) {
            if (rawBull === '#089981') bullClr = 0x056656;
            if (rawBear === '#F23645') bearClr = 0xB91C1C;
        }

        return {
            label: this.name,
            valueStr: isBull ? '▲ Bull Bias' : '▼ Bear Bias',
            valueColor: isBull ? bullClr : bearClr
        };
    }
}