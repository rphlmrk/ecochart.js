import { BaseIndicator, parseColor, type IndicatorLayout } from '../Indicator';
import type { DataStore } from '../../data/DataStore';
import type { ChartRenderer } from '../../renderer/ChartRenderer';
import { StrokeEngine } from '../../renderer/StrokeEngine';
import { Graphics } from 'pixi.js';

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

    private reusableTps = new Float64Array(200); // Pre-allocated to prevent GC allocation on ticks

    protected calculate(ds: DataStore) {
        const period = Math.max(2, this.getParam<number>('length', 20));
        const start = Math.max(period - 1, this.lastCalculatedIdx === -1 ? 0 : this.lastCalculatedIdx);

        if (this.reusableTps.length < period) {
            this.reusableTps = new Float64Array(period * 2);
        }
        const tps = this.reusableTps;
        for (let i = start; i < ds.length; i++) {
            let sum = 0;
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

            // Clamp math immediately
            const rawVal = mad === 0 ? 0 : (tps[0] - sma) / (0.015 * mad);
            this.values[i] = Math.max(-300, Math.min(300, rawVal));
        }
        this.lastCalculatedIdx = ds.length - 1;
    }

    public render(r: ChartRenderer, layout: IndicatorLayout, g: Graphics) {
        // 1. Detect if the chart background is light (checks theme flag AND background brightness)
        const bgR = (r.bgColor >> 16) & 0xff;
        const bgG = (r.bgColor >> 8) & 0xff;
        const bgB = r.bgColor & 0xff;
        const isLightMode = !r.isDarkTheme || (0.299 * bgR + 0.587 * bgG + 0.114 * bgB) > 130;

        // 2. Resolve line color: If white on a light background, force to solid black
        const rawLineColor = String(this.getParam('lineColor', '#FFFFFF')).trim().toUpperCase();
        let lineColor = parseColor(rawLineColor);
        const lR = (lineColor >> 16) & 0xff;
        const lG = (lineColor >> 8) & 0xff;
        const lB = lineColor & 0xff;
        const isWhite = (lR > 200 && lG > 200 && lB > 200) || rawLineColor.startsWith('#FFF');

        if (isLightMode && isWhite) {
            lineColor = 0x000000; // Force solid black
        }

        // 3. Resolve Bull/Bear band colors
        const rawBull = String(this.getParam('bullColor', '#00FFEA')).toUpperCase();
        const bullColor = rawBull === '#00FFEA' ? r.bullColor : parseColor(rawBull);

        const rawBear = String(this.getParam('bearColor', '#FF9800')).toUpperCase();
        const bearColor = rawBear === '#FF9800' ? r.bearColor : parseColor(rawBear);

        const bandAlpha = isLightMode ? 0.18 : 0.12;
        const yUpperBand = layout.oscY + layout.oscHeight * 0.25;
        const yLowerBand = layout.oscY + layout.oscHeight * 0.75;
        const midY = layout.oscY + (layout.oscHeight / 2);

        g.rect(0, layout.oscY, layout.chartWidth, layout.oscHeight * 0.25).fill({ color: bullColor, alpha: bandAlpha });
        g.rect(0, yLowerBand, layout.chartWidth, layout.oscHeight * 0.25).fill({ color: bearColor, alpha: bandAlpha });

        // Zero center line: black on light mode, white on dark mode
        const zeroLineColor = isLightMode ? 0x000000 : 0xFFFFFF;
        StrokeEngine.drawLine(g, 0, midY, layout.chartWidth, midY, {
            color: zeroLineColor, width: 1, alpha: isLightMode ? 0.35 : 0.25, style: 'solid'
        });

        StrokeEngine.drawLine(g, 0, yUpperBand, layout.chartWidth, yUpperBand, {
            color: bullColor, width: 1, alpha: 0.35, style: 'dashed', dashLength: 4, gapLength: 3
        });

        StrokeEngine.drawLine(g, 0, yLowerBand, layout.chartWidth, yLowerBand, {
            color: bearColor, width: 1, alpha: 0.35, style: 'dashed', dashLength: 4, gapLength: 3
        });

        // Fire line rendering directly to the GPU!
        r.drawGPUIndicatorLine(this.id, this.values, lineColor, 1.5, true, layout, this.oscillatorScale);
    }

    public getValueAt(idx: number, ds: DataStore, isDark: boolean, defaultTextClr: number) {
        const val = (idx >= 0 && idx < ds.length) ? this.values[idx] : 0;
        const thresh = this.getParam<number>('threshold', 80);

        const rawBull = String(this.getParam('bullColor', '#00FFEA')).toUpperCase();
        const rawBear = String(this.getParam('bearColor', '#FF9800')).toUpperCase();

        let bullColor = parseColor(rawBull);
        let bearColor = parseColor(rawBear);

        if (!isDark) {
            if (rawBull === '#00FFEA') bullColor = 0x089981;
            if (rawBear === '#FF9800') bearColor = 0xF23645;
        }

        let valueColor = !isDark ? 0x000000 : defaultTextClr;
        if (val >= thresh) valueColor = bullColor;
        else if (val <= -thresh) valueColor = bearColor;

        const sign = val > 0 ? '+' : '';
        return {
            label: `Exhaustion (${this.getParam('length', 20)})`,
            valueStr: `${sign}${val.toFixed(2)}`,
            valueColor
        };
    }
}