import { BaseIndicator, SMAEngine, EMAEngine, type IndicatorLayout } from './Indicator';
import type { DataStore } from '../data/DataStore';
import type { ChartRenderer } from '../renderer/ChartRenderer';
import { Graphics } from 'pixi.js';

export class SMAIndicator extends BaseIndicator {
    private period: number;
    private color: number;

    constructor(period = 20, color = 0x2962FF) {
        super(`SMA_${period}`, `SMA (${period})`);
        this.period = period;
        this.color = color;
    }

    protected calculate(ds: DataStore) {
        this.lastCalculatedIdx = SMAEngine.calculate(ds, this.period, this.values, this.lastCalculatedIdx);
    }

    public render(r: ChartRenderer, layout: IndicatorLayout, g: Graphics) {
        const sp = r.candleSpacing * r.zoom;
        const visStart = Math.max(this.period, Math.floor(r.cameraX / sp));
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
        g.stroke({ color: this.color, width: 2 });
    }
}

export class EMAIndicator extends BaseIndicator {
    private period: number;
    private color: number;

    constructor(period = 20, color = 0x00BCD4) {
        super(`EMA_${period}`, `EMA (${period})`);
        this.period = period;
        this.color = color;
    }

    protected calculate(ds: DataStore) {
        this.lastCalculatedIdx = EMAEngine.calculate(ds, this.period, this.values, this.lastCalculatedIdx);
    }

    public render(r: ChartRenderer, layout: IndicatorLayout, g: Graphics) {
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
        g.stroke({ color: this.color, width: 2 });
    }
}

export class VolumeIndicator extends BaseIndicator {
    constructor() { super('VOL', 'Volume'); }
    protected calculate(_ds: DataStore) {}

    public render(r: ChartRenderer, layout: IndicatorLayout, g: Graphics) {
        const sp = r.candleSpacing * r.zoom;
        const visStart = Math.max(0, Math.floor(r.cameraX / sp));
        const visEnd = Math.min(r.dataStore.length, Math.floor((r.cameraX + layout.chartWidth) / sp) + 1);

        let maxVol = 0;
        for (let i = visStart; i < visEnd; i++) {
            maxVol = Math.max(maxVol, r.dataStore.data[i * 6 + 5]);
        }
        if (maxVol === 0) return;

        const maxH = layout.mainChartHeight * 0.15; // Bottom 15%
        const barW = Math.max(2, sp * 0.8);

        for (let i = visStart; i < visEnd; i++) {
            const base = i * 6;
            const open = r.dataStore.data[base + 1];
            const close = r.dataStore.data[base + 4];
            const vol = r.dataStore.data[base + 5];

            const x = (i * sp) - r.cameraX;
            const h = (vol / maxVol) * maxH;
            const y = layout.mainChartHeight - h;

            const color = close >= open ? r.bullColor : r.bearColor;
            g.rect(x, y, barW, h).fill({ color, alpha: 0.4 });
        }
    }
}

export class ExhaustionIndicator extends BaseIndicator {
    private period = 20;
    constructor() { super('EXHAUST', 'Exhaustion (CCI)', true); }

    protected calculate(ds: DataStore) {
        const start = Math.max(this.period - 1, this.lastCalculatedIdx === -1 ? 0 : this.lastCalculatedIdx);
        for (let i = start; i < ds.length; i++) {
            let sum = 0;
            const tps = new Float64Array(this.period);
            for (let j = 0; j < this.period; j++) {
                const base = (i - j) * 6;
                const tp = (ds.data[base + 2] + ds.data[base + 3] + ds.data[base + 4]) / 3;
                tps[j] = tp;
                sum += tp;
            }
            const sma = sum / this.period;
            let madSum = 0;
            for (let j = 0; j < this.period; j++) {
                madSum += Math.abs(tps[j] - sma);
            }
            const mad = madSum / this.period;
            this.values[i] = mad === 0 ? 0 : (tps[0] - sma) / (0.015 * mad);
        }
        this.lastCalculatedIdx = ds.length - 1;
    }

    public render(r: ChartRenderer, layout: IndicatorLayout, g: Graphics) {
        const sp = r.candleSpacing * r.zoom;
        const visStart = Math.max(this.period, Math.floor(r.cameraX / sp));
        const visEnd = Math.min(r.dataStore.length, Math.floor((r.cameraX + layout.chartWidth) / sp) + 1);

        // Draw Background Thresholds
        const midY = layout.oscY + (layout.oscHeight / 2);
        g.rect(0, layout.oscY, layout.chartWidth, layout.oscHeight * 0.25).fill({ color: 0x00FFEA, alpha: 0.1 });
        g.rect(0, layout.oscY + layout.oscHeight * 0.75, layout.chartWidth, layout.oscHeight * 0.25).fill({ color: 0xFF9800, alpha: 0.1 });
        
        g.moveTo(0, midY).lineTo(layout.chartWidth, midY).stroke({ color: 0xFFFFFF, alpha: 0.2, width: 1 });

        let isDrawing = false;
        for (let i = visStart; i < visEnd; i++) {
            const x = (i * sp) - r.cameraX + (sp * 0.4);
            let val = this.values[i];
            if (val > 300) val = 300;
            if (val < -300) val = -300;
            
            // Map [-300, 300] to the oscHeight
            const y = layout.oscY + layout.oscHeight / 2 - (val * (layout.oscHeight / 600));

            if (!isDrawing) {
                g.moveTo(x, y);
                isDrawing = true;
            } else {
                g.lineTo(x, y);
            }
        }
        g.stroke({ color: 0xFFFFFF, width: 1.5 });
    }
}

export class HTFBoxIndicator extends BaseIndicator {
    private tfMins: number;
    constructor(tfMins = 60) {
        super(`HTF_BOX_${tfMins}`, `HTF Box (${tfMins}m)`);
        this.tfMins = tfMins;
    }

    protected calculate(_ds: DataStore) {} // Evaluated dynamically during render

    public render(r: ChartRenderer, layout: IndicatorLayout, g: Graphics) {
        const tfMs = this.tfMins * 60 * 1000;
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
                // Draw Previous Block
                if (blockStartMs !== 0) {
                    const endX = (i * sp) - r.cameraX;
                    this.drawBox(r, layout, g, startX, endX, blockO, blockH, blockL, blockC);
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
        // Draw forming block
        if (blockStartMs !== 0) {
            const endX = (visEnd * sp) - r.cameraX;
            this.drawBox(r, layout, g, startX, endX, blockO, blockH, blockL, blockC);
        }
    }

    private drawBox(r: ChartRenderer, layout: IndicatorLayout, g: Graphics, x1: number, x2: number, o: number, h: number, l: number, c: number) {
        const yTop = layout.mainChartHeight - (((Math.max(o, c) - r.currentMinPrice) / (r.currentMaxPrice - r.currentMinPrice)) * layout.mainChartHeight) + r.cameraY;
        const yBot = layout.mainChartHeight - (((Math.min(o, c) - r.currentMinPrice) / (r.currentMaxPrice - r.currentMinPrice)) * layout.mainChartHeight) + r.cameraY;
        
        // Map High and Low to Y coordinates
        const yH = layout.mainChartHeight - (((h - r.currentMinPrice) / (r.currentMaxPrice - r.currentMinPrice)) * layout.mainChartHeight) + r.cameraY;
        const yL = layout.mainChartHeight - (((l - r.currentMinPrice) / (r.currentMaxPrice - r.currentMinPrice)) * layout.mainChartHeight) + r.cameraY;
        
        const isBull = c >= o;
        const color = isBull ? r.bullColor : r.bearColor;
        const xMid = x1 + (x2 - x1) / 2;

        // Draw Wicks
        g.moveTo(xMid, yH).lineTo(xMid, yTop).stroke({ color, alpha: 0.5, width: 1.5 });
        g.moveTo(xMid, yBot).lineTo(xMid, yL).stroke({ color, alpha: 0.5, width: 1.5 });

        // Draw Body
        g.rect(x1, yTop, Math.max(1, x2 - x1), Math.max(1, yBot - yTop)).fill({ color, alpha: 0.1 });
        g.rect(x1, yTop, Math.max(1, x2 - x1), Math.max(1, yBot - yTop)).stroke({ color, alpha: 0.5, width: 1.5 });
    }
}