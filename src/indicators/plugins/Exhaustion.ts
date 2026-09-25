import { BaseIndicator, parseColor, type IndicatorLayout } from '../Indicator';
import type { DataStore } from '../../data/DataStore';
import type { ChartRenderer } from '../../renderer/ChartRenderer';
import { StrokeEngine } from '../../renderer/StrokeEngine';
import { Graphics } from 'pixi.js';
import { MathWorkerClient } from '../../workers/MathWorkerClient';

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

    private reusableTps = new Float64Array(200);

    protected async calculate(ds: DataStore) {
        if (this.isCalculating || ds.length === 0) return;

        // If historical candles were prepended or data reset, invalidate cache so worker recalculates
        if (this.lastCalculatedIdx !== -1 && (ds.length > this.lastCalculatedIdx + 2 || ds.length <= this.lastCalculatedIdx)) {
            this.lastCalculatedIdx = -1;
        }

        if (this.lastCalculatedIdx === -1) {
            this.isCalculating = true;
            const period = this.getParam<number>('length', 20);
            try {
                const activeData = ds.data.subarray(0, ds.length * 6);
                const res = await MathWorkerClient.calculate('EXHAUSTION', activeData, { period });
                if (res) {
                    if (res.values.length > this.values.length) {
                        this.values = new Float64Array(res.values.length * 2);
                    }
                    this.values.set(res.values);
                }
                this.lastCalculatedIdx = ds.length - 1;
                this.revision++;
            } finally {
                this.isCalculating = false;
                window.dispatchEvent(new Event('ecochart-indicator-ready'));
            }
        } else {
            const period = Math.max(2, this.getParam<number>('length', 20));
            const liveIdx = ds.length - 1;
            if (liveIdx < period - 1) return;

            if (this.reusableTps.length < period) this.reusableTps = new Float64Array(period * 2);
            const tps = this.reusableTps;

            let sum = 0;
            for (let j = 0; j < period; j++) {
                const base = (liveIdx - j) * 6;
                const tp = (ds.data[base + 2] + ds.data[base + 3] + ds.data[base + 4]) / 3;
                tps[j] = tp;
                sum += tp;
            }
            const sma = sum / period;
            let madSum = 0;
            for (let j = 0; j < period; j++) madSum += Math.abs(tps[j] - sma);

            const mad = madSum / period;
            const rawVal = mad === 0 ? 0 : (tps[0] - sma) / (0.015 * mad);
            this.values[liveIdx] = Math.max(-300, Math.min(300, rawVal));
            this.lastCalculatedIdx = liveIdx;
        }
    }

    public render(r: ChartRenderer, layout: IndicatorLayout, g: Graphics) {
        // 1. Detect if the chart background is light
        const bgR = (r.bgColor >> 16) & 0xff;
        const bgG = (r.bgColor >> 8) & 0xff;
        const bgB = r.bgColor & 0xff;
        const isLightMode = !r.isDarkTheme || (0.299 * bgR + 0.587 * bgG + 0.114 * bgB) > 130;

        // 2. Resolve line color: If white/light on a light background, force to solid dark slate
        const rawLineColor = String(this.getParam('lineColor', '#FFFFFF')).trim().toUpperCase();
        let lineColor = parseColor(rawLineColor);

        if (isLightMode) {
            const lR = (lineColor >> 16) & 0xff;
            const lG = (lineColor >> 8) & 0xff;
            const lB = lineColor & 0xff;
            if ((0.299 * lR + 0.587 * lG + 0.114 * lB) > 180) {
                lineColor = 0x131722; // Force to dark slate
            }
        }

        // 3. Resolve Bull/Bear band colors
        const rawBull = String(this.getParam('bullColor', '#00FFEA')).toUpperCase();
        const bullColor = rawBull === '#00FFEA' ? r.bullColor : parseColor(rawBull);

        const rawBear = String(this.getParam('bearColor', '#FF9800')).toUpperCase();
        const bearColor = rawBear === '#FF9800' ? r.bearColor : parseColor(rawBear);

        // 4. Dynamic Auto-Scale: Scan visible bars to fit peaks & troughs inside the panel
        const thresh = this.getParam<number>('threshold', 80);
        const sp = r.candleSpacing * r.zoom;
        const visStart = Math.max(0, Math.floor(r.cameraX / sp) - 5);
        const visEnd = Math.min(r.dataStore.length, Math.floor((r.cameraX + layout.chartWidth) / sp) + 5);

        let maxVal = thresh * 1.3;
        let minVal = -thresh * 1.3;

        for (let i = visStart; i < visEnd; i++) {
            const v = this.values[i];
            if (v > maxVal) maxVal = v;
            if (v < minVal) minVal = v;
        }

        // Keep scale symmetric around 0 with 15% breathing room at the extremes
        const absMax = Math.max(Math.abs(maxVal), Math.abs(minVal));
        const scaleMax = Math.ceil(absMax * 1.15);
        const scaleMin = -scaleMax;

        if (this.oscillatorScale) {
            this.oscillatorScale.min = scaleMin;
            this.oscillatorScale.max = scaleMax;
            this.oscillatorScale.steps = [thresh, 0, -thresh];
        }

        // 5. Calculate Y positions aligned with dynamic scale bounds
        const oscRange = scaleMax - scaleMin;
        const normUpper = (thresh - scaleMin) / oscRange;
        const normLower = (-thresh - scaleMin) / oscRange;

        const yUpperBand = layout.oscY + layout.oscHeight - (normUpper * layout.oscHeight);
        const yLowerBand = layout.oscY + layout.oscHeight - (normLower * layout.oscHeight);
        const midY = layout.oscY + (layout.oscHeight / 2);
        const bandAlpha = isLightMode ? 0.18 : 0.12;

        // Extreme shaded zones
        g.rect(0, layout.oscY, layout.chartWidth, Math.max(0, yUpperBand - layout.oscY)).fill({ color: bullColor, alpha: bandAlpha });
        g.rect(0, yLowerBand, layout.chartWidth, Math.max(0, (layout.oscY + layout.oscHeight) - yLowerBand)).fill({ color: bearColor, alpha: bandAlpha });

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