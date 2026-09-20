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
            { id: 'customMins', name: 'Custom Minutes', type: 'number', value: 45, min: 1, max: 43200, step: 1 },
            { id: 'displayMode', name: 'Display Mode', type: 'select', value: 'Top Ribbon', options: ['Top Ribbon', 'Overlay Lines', 'Both'] },
            { id: 'bullColor', name: 'Bull Bias Color', type: 'color', value: '#089981' },
            { id: 'bearColor', name: 'Bear Bias Color', type: 'color', value: '#F23645' },
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

    private cachedCandles: Array<{
        o: number; h: number; l: number; c: number;
        highIdx: number; lowIdx: number; startIdx: number; endIdx: number;
    }> = [];

    protected onParamsUpdated(): void {
        const tfMins = this.getEffectiveTfMins();
        this.id = `HTF_BIAS_${tfMins}`;
        this.name = `HTF Bias (${tfMins}m)`;
        this.cachedCandles = [];
    }

    // Pre-aggregates candles ONCE when data updates
    protected calculate(ds: DataStore) {
        if (ds.length === 0) {
            this.cachedCandles = [];
            return;
        }

        const tfMs = this.getEffectiveTfMins() * 60 * 1000;
        this.cachedCandles = [];
        let curBlock: any = null;

        for (let i = 0; i < ds.length; i++) {
            const base = i * 6;
            const t = ds.data[base];
            const bTime = Math.floor(t / tfMs) * tfMs;
            const o = ds.data[base + 1], h = ds.data[base + 2], l = ds.data[base + 3], c = ds.data[base + 4];

            if (!curBlock || bTime !== curBlock.startMs) {
                if (curBlock) {
                    curBlock.endIdx = i - 1;
                    this.cachedCandles.push(curBlock);
                }
                curBlock = { startMs: bTime, o, h, l, c, highIdx: i, lowIdx: i, startIdx: i, endIdx: i };
            } else {
                if (h > curBlock.h) { curBlock.h = h; curBlock.highIdx = i; }
                if (l < curBlock.l) { curBlock.l = l; curBlock.lowIdx = i; }
                curBlock.c = c;
            }
        }
        if (curBlock) {
            curBlock.endIdx = ds.length - 1;
            this.cachedCandles.push(curBlock);
        }
        this.lastCalculatedIdx = ds.length - 1;
    }

    public render(r: ChartRenderer, layout: IndicatorLayout, g: Graphics) {
        const displayMode = this.getParam<string>('displayMode', 'Top Ribbon');
        const bullClr = parseColor(this.getParam('bullColor', '#089981'));
        const bearClr = parseColor(this.getParam('bearColor', '#F23645'));
        const sweepsOnly = this.getParam<boolean>('sweepsOnly', false);

        const showRibbon = displayMode === 'Top Ribbon' || displayMode === 'Both';
        const showLines = displayMode === 'Overlay Lines' || displayMode === 'Both';

        const sp = r.candleSpacing * r.zoom;
        const visStart = Math.max(0, Math.floor(r.cameraX / sp));
        const visEnd = Math.min(r.dataStore.length, Math.floor((r.cameraX + layout.chartWidth) / sp) + 1);

        const htfCandles = this.cachedCandles;
        if (htfCandles.length < 2) return;

        let mother = htfCandles[0];
        let currentBias = 0;

        for (let i = 1; i < htfCandles.length; i++) {
            const curr = htfCandles[i];
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

            if (showRibbon && inView && currentBias !== 0) {
                const x1 = (curr.startIdx * sp) - r.cameraX;
                const x2 = ((curr.endIdx + 1) * sp) - r.cameraX;
                const ribbonH = 18;
                const yTop = 6;
                const color = currentBias === 1 ? bullClr : bearClr;

                g.rect(x1, yTop, Math.max(1, x2 - x1), ribbonH).fill({ color, alpha: 0.2 });

                if (isBearSweep) {
                    StrokeEngine.drawLine(g, x1, yTop, x2, yTop, { color: bearClr, width: 2.5, alpha: 0.9 });
                } else if (isBullSweep) {
                    StrokeEngine.drawLine(g, x1, yTop + ribbonH, x2, yTop + ribbonH, { color: bullClr, width: 2.5, alpha: 0.9 });
                }
            }
        }
    }

    public getValueAt(idx: number, ds: DataStore, _isDark: boolean, _defaultTextClr: number) {
        const close = (idx >= 0 && idx < ds.length) ? ds.data[idx * 6 + 4] : 0;
        const open = (idx >= 0 && idx < ds.length) ? ds.data[idx * 6 + 1] : 0;
        const isBull = close >= open;
        return {
            label: this.name,
            valueStr: isBull ? '▲ Bull Bias' : '▼ Bear Bias',
            valueColor: isBull ? 0x089981 : 0xF23645
        };
    }
}