import { BaseIndicator, type IndicatorLayout } from '../Indicator';
import type { DataStore } from '../../data/DataStore';
import type { ChartRenderer } from '../../renderer/ChartRenderer';
import { StrokeEngine } from '../../renderer/StrokeEngine';
import { Graphics } from 'pixi.js';

export class HTFProjectionsIndicator extends BaseIndicator {
    constructor(htfMins = 'Custom', customMins = 21) {
        // Calculate the initial effective minutes (21m if Custom)
        const initialEffectiveMins = htfMins === 'Custom' ? customMins : (parseInt(String(htfMins), 10) || 240);

        super(`HTF_PROJ_${initialEffectiveMins}`, `HTF Projections (${initialEffectiveMins}m)`);

        this.params = [
            { id: 'htfMins', name: 'Timeframe', type: 'select', value: String(htfMins), options: ['60', '120', '240', '480', '1440', 'Custom'] },
            { id: 'customMins', name: 'Custom Minutes', type: 'number', value: customMins, min: 1, max: 43200, step: 1 },
            { id: 'count', name: 'Candle Count', type: 'number', value: 8, min: 2, max: 10 },
            { id: 'widthBars', name: 'Candle Width', type: 'number', value: 3, min: 2, max: 15 },
            { id: 'gapBars', name: 'Gap Bars', type: 'number', value: 1, min: 1, max: 6 },
            // Note: Increased max to 50 so value: 30 doesn't get clipped by the input
            { id: 'offsetBars', name: 'Offset from Live', type: 'number', value: 30, min: 2, max: 50 },
            { id: 'showFifty', name: 'Show 50% Equilibrium', type: 'boolean', value: true },
            { id: 'showHL', name: 'Show Origin Lines', type: 'boolean', value: true },
            { id: 'lineThickness', name: 'Line Thickness', type: 'number', value: 1.5, min: 1, max: 4, step: 0.5 }
        ];
    }


    public getEffectiveTfMins(): number {
        const mode = this.getParam<string>('htfMins', '240');
        if (mode === 'Custom') {
            return Math.max(1, this.getParam<number>('customMins', 90));
        }
        return parseInt(mode, 10) || 240;
    }

    private cachedCandles: Array<{
        o: number; h: number; l: number; c: number;
        highIdx: number; lowIdx: number;
    }> = [];

    protected onParamsUpdated(): void {
        const tfMins = this.getEffectiveTfMins();
        this.id = `HTF_PROJ_${tfMins}`;
        this.name = `HTF Projections (${tfMins}m)`;
        this.cachedCandles = [];
    }

    protected calculate(ds: DataStore) {
        if (ds.length === 0) {
            this.cachedCandles = [];
            return;
        }

        const count = this.getParam<number>('count', 4);
        const tfMs = this.getEffectiveTfMins() * 60 * 1000;
        const targetCount = count + 2;

        // Fast reverse scan: only scan history far enough back to draw what we need
        let blocksFound = 0;
        let lastBlockTime = -1;
        let scanStartIdx = 0;

        for (let i = ds.length - 1; i >= 0; i--) {
            const bTime = Math.floor(ds.data[i * 6] / tfMs) * tfMs;
            if (bTime !== lastBlockTime) {
                lastBlockTime = bTime;
                blocksFound++;
                if (blocksFound >= targetCount) {
                    scanStartIdx = i;
                    break;
                }
            }
        }

        this.cachedCandles = [];
        let curBlock: any = null;
        let blockStartMs = 0;

        for (let i = scanStartIdx; i < ds.length; i++) {
            const base = i * 6;
            const t = ds.data[base];
            const bTime = Math.floor(t / tfMs) * tfMs;
            const o = ds.data[base + 1], h = ds.data[base + 2], l = ds.data[base + 3], c = ds.data[base + 4];

            if (!curBlock || bTime !== blockStartMs) {
                if (curBlock) this.cachedCandles.push(curBlock);
                blockStartMs = bTime;
                curBlock = { o, h, l, c, highIdx: i, lowIdx: i };
            } else {
                if (h > curBlock.h) { curBlock.h = h; curBlock.highIdx = i; }
                if (l < curBlock.l) { curBlock.l = l; curBlock.lowIdx = i; }
                curBlock.c = c;
            }
        }
        if (curBlock) this.cachedCandles.push(curBlock);
        this.lastCalculatedIdx = ds.length - 1;
    }

    public render(r: ChartRenderer, layout: IndicatorLayout, g: Graphics) {
        const chartTfMs = r.parseIntervalMs(r.currentInterval);
        const tfMs = this.getEffectiveTfMins() * 60 * 1000;
        if (chartTfMs > tfMs) return; // <-- ADDED: Hide if chart TF > HTF

        const count = this.getParam<number>('count', 4);
        const widthBars = this.getParam<number>('widthBars', 5);
        const gapBars = this.getParam<number>('gapBars', 2);
        const offsetBars = this.getParam<number>('offsetBars', 6);
        const showFifty = this.getParam<boolean>('showFifty', true);
        const showHL = this.getParam<boolean>('showHL', true);
        const lineThickness = this.getParam<number>('lineThickness', 1.5);

        // Theme-Aware Color: Inverts to dark axis text color on light themes and white on dark themes
        const helperLineColor = r.isDarkTheme ? 0xFFFFFF : r.axisTextColor;

        const sp = r.candleSpacing * r.zoom;
        const drawCandles = this.cachedCandles.slice(-count);
        if (drawCandles.length === 0) return;

        const liveIdx = r.dataStore.length - 1;
        const startBar = liveIdx + offsetBars;

        for (let i = 0; i < drawCandles.length; i++) {
            const d = drawCandles[i];
            const leftBar = startBar + i * (widthBars + gapBars);
            const rightBar = leftBar + widthBars;
            const midBar = leftBar + widthBars / 2;

            const xLeft = (leftBar * sp) - r.cameraX;
            const xRight = (rightBar * sp) - r.cameraX;
            const xMid = (midBar * sp) - r.cameraX;

            if (xRight < 0 || xLeft > layout.chartWidth) continue;

            const isBull = d.c >= d.o;
            const color = isBull ? r.bullColor : r.bearColor;

            const yTop = layout.mainChartHeight - (((Math.max(d.o, d.c) - r.currentMinPrice) / (r.currentMaxPrice - r.currentMinPrice)) * layout.mainChartHeight) + r.cameraY;
            const yBot = layout.mainChartHeight - (((Math.min(d.o, d.c) - r.currentMinPrice) / (r.currentMaxPrice - r.currentMinPrice)) * layout.mainChartHeight) + r.cameraY;
            const yH = layout.mainChartHeight - (((d.h - r.currentMinPrice) / (r.currentMaxPrice - r.currentMinPrice)) * layout.mainChartHeight) + r.cameraY;
            const yL = layout.mainChartHeight - (((d.l - r.currentMinPrice) / (r.currentMaxPrice - r.currentMinPrice)) * layout.mainChartHeight) + r.cameraY;

            // Wicks
            g.moveTo(xMid, yH).lineTo(xMid, yTop).stroke({ color, width: lineThickness, alpha: 0.8 });
            g.moveTo(xMid, yBot).lineTo(xMid, yL).stroke({ color, width: lineThickness, alpha: 0.8 });

            const bodyH = Math.max(1, yBot - yTop);
            g.rect(xLeft, yTop, xRight - xLeft, bodyH).fill({ color, alpha: 0.25 });
            g.rect(xLeft, yTop, xRight - xLeft, bodyH).stroke({ color, width: lineThickness, alpha: 0.8 });

            // 50% Equilibrium Line (Theme-Aware: dark on light theme, white on dark theme)
            if (showFifty) {
                const y50 = (yTop + yBot) / 2;
                StrokeEngine.drawLine(g, xLeft, y50, xRight, y50, {
                    color: helperLineColor, width: lineThickness, alpha: 0.7, style: 'dashed', dashLength: 3, gapLength: 2
                });
            }

            // Origin Connecting Lines (Clipped to visible screen to save GPU cycles)
            if (showHL && (drawCandles.length - 1 - i) < 2) {
                const xOriginHigh = Math.max(-10, (d.highIdx * sp) - r.cameraX);
                const xOriginLow = Math.max(-10, (d.lowIdx * sp) - r.cameraX);

                if (xOriginHigh < xMid) {
                    StrokeEngine.drawLine(g, xOriginHigh, yH, xMid, yH, { color: helperLineColor, width: Math.max(1, lineThickness - 0.5), alpha: 0.45, style: 'dotted' });
                }
                if (xOriginLow < xMid) {
                    StrokeEngine.drawLine(g, xOriginLow, yL, xMid, yL, { color: helperLineColor, width: Math.max(1, lineThickness - 0.5), alpha: 0.45, style: 'dotted' });
                }
            }
        }
    }
}