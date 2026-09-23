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

    protected calculate(ds: DataStore) {
        const period = Math.max(2, this.getParam<number>('length', 20));
        const start = Math.max(period - 1, this.lastCalculatedIdx === -1 ? 0 : this.lastCalculatedIdx);

        const tps = new Float64Array(period); // Instantiate OUTSIDE the loop once
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
            this.values[i] = mad === 0 ? 0 : (tps[0] - sma) / (0.015 * mad);
        }
        this.lastCalculatedIdx = ds.length - 1;
    }

    public render(r: ChartRenderer, layout: IndicatorLayout, g: Graphics) {
        const period = Math.max(2, this.getParam<number>('length', 20));
        const bullColor = parseColor(this.getParam('bullColor', '#00FFEA'));
        const bearColor = parseColor(this.getParam('bearColor', '#FF9800'));
        const rawLineColor = String(this.getParam('lineColor', '#FFFFFF')).toUpperCase();

        const lineColor = (rawLineColor === '#FFFFFF' && !r.isDarkTheme)
            ? r.axisTextColor
            : parseColor(rawLineColor);

        const sp = r.candleSpacing * r.zoom;
        const visStart = Math.max(period, Math.floor(r.cameraX / sp));
        const visEnd = Math.min(r.dataStore.length, Math.floor((r.cameraX + layout.chartWidth) / sp) + 1);

        g.rect(0, layout.oscY, layout.chartWidth, layout.oscHeight).fill({ color: r.axisBgColor, alpha: 0.35 });

        const bandAlpha = r.isDarkTheme ? 0.12 : 0.22;
        const yUpperBand = layout.oscY + layout.oscHeight * 0.25;
        const yLowerBand = layout.oscY + layout.oscHeight * 0.75;
        const midY = layout.oscY + (layout.oscHeight / 2);

        g.rect(0, layout.oscY, layout.chartWidth, layout.oscHeight * 0.25).fill({ color: bullColor, alpha: bandAlpha });
        g.rect(0, yLowerBand, layout.chartWidth, layout.oscHeight * 0.25).fill({ color: bearColor, alpha: bandAlpha });

        const zeroLineColor = r.isDarkTheme ? 0xFFFFFF : r.axisTextColor;
        StrokeEngine.drawLine(g, 0, midY, layout.chartWidth, midY, {
            color: zeroLineColor, width: 1, alpha: 0.25, style: 'solid'
        });

        StrokeEngine.drawLine(g, 0, yUpperBand, layout.chartWidth, yUpperBand, {
            color: bullColor, width: 1, alpha: 0.35, style: 'dashed', dashLength: 4, gapLength: 3
        });

        StrokeEngine.drawLine(g, 0, yLowerBand, layout.chartWidth, yLowerBand, {
            color: bearColor, width: 1, alpha: 0.35, style: 'dashed', dashLength: 4, gapLength: 3
        });

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

    public getValueAt(idx: number, ds: DataStore, _isDark: boolean, defaultTextClr: number) {
        const val = (idx >= 0 && idx < ds.length) ? this.values[idx] : 0;
        const thresh = this.getParam<number>('threshold', 80);
        const bullColor = parseColor(this.getParam('bullColor', '#00FFEA'));
        const bearColor = parseColor(this.getParam('bearColor', '#FF9800'));

        let valueColor = defaultTextClr;
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