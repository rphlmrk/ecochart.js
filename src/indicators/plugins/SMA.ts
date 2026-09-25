import { BaseIndicator, parseColor, type IndicatorLayout } from '../Indicator';
import type { DataStore } from '../../data/DataStore';
import type { ChartRenderer } from '../../renderer/ChartRenderer';
import { Graphics } from 'pixi.js';
import { MathWorkerClient } from '../../workers/MathWorkerClient';

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

    protected setup(): void { }

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
                const res = await MathWorkerClient.calculate('SMA', activeData, { period });
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
            // Live fast-tick sync (no worker needed for 1 bar)
            const period = this.getParam<number>('length', 20);
            const liveIdx = ds.length - 1;
            if (liveIdx < period - 1) return;

            let sum = 0;
            for (let j = 0; j < period; j++) {
                sum += ds.data[(liveIdx - j) * 6 + 4];
            }
            this.values[liveIdx] = sum / period;
            this.lastCalculatedIdx = liveIdx;
        }
    }

    public render(r: ChartRenderer, layout: IndicatorLayout, _g: Graphics) {
        const rawColor = String(this.getParam('color', '#FFC107')).trim().toUpperCase();
        let color = parseColor(rawColor);

        // Default adjustments
        if (!r.isDarkTheme && rawColor === '#FFC107') {
            color = 0xD97706;
        }

        // Luminous Check: Flip bright lines (like white) to dark slate in Light Mode
        if (!r.isDarkTheme) {
            const cR = (color >> 16) & 0xff;
            const cG = (color >> 8) & 0xff;
            const cB = color & 0xff;
            const luminance = (0.299 * cR + 0.587 * cG + 0.114 * cB);
            if (luminance > 180) {
                color = 0x131722; // Force to dark slate so it remains visible
            }
        }

        // Fire directly to the GPU!
        r.drawGPUIndicatorLine(this.id, this.values, color, 2, false, layout);
    }

    public getValueAt(idx: number, ds: DataStore, isDark: boolean, _defaultTextClr: number) {
        const val = (idx >= 0 && idx < ds.length) ? this.values[idx] : 0;
        const rawColor = String(this.getParam('color', '#FFC107')).toUpperCase();
        let valueColor = parseColor(rawColor);
        if (!isDark && rawColor === '#FFC107') {
            valueColor = 0xD97706; // Adjust to deep orange on light theme
        }

        return {
            label: this.name,
            valueStr: val > 0 ? val.toFixed(2) : 'n/a',
            valueColor
        };
    }
}