import { BaseIndicator, parseColor, type IndicatorLayout } from '../Indicator';
import type { DataStore } from '../../data/DataStore';
import type { ChartRenderer } from '../../renderer/ChartRenderer';
import { Graphics } from 'pixi.js';
import { MathWorkerClient } from '../../workers/MathWorkerClient';

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
                const res = await MathWorkerClient.calculate('EMA', activeData, { period });
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
            const k = 2 / (period + 1);
            const liveIdx = ds.length - 1;
            if (liveIdx === 0) {
                this.values[0] = ds.data[4];
                return;
            }
            const close = ds.data[liveIdx * 6 + 4];
            this.values[liveIdx] = (close - this.values[liveIdx - 1]) * k + this.values[liveIdx - 1];
            this.lastCalculatedIdx = liveIdx;
        }
    }

    public render(r: ChartRenderer, layout: IndicatorLayout, _g: Graphics) {
        const rawColor = String(this.getParam('color', '#00BCD4')).trim().toUpperCase();
        let color = parseColor(rawColor);

        // Default adjustments
        if (!r.isDarkTheme && rawColor === '#00BCD4') {
            color = 0x00838F; // Deep teal for light theme
        }

        // Exact Clash Prevention: Only flip pure white or pure black
        if (!r.isDarkTheme && color === 0xFFFFFF) {
            color = 0x131722; // Pure white flips to dark slate
        } else if (r.isDarkTheme && color === 0x000000) {
            color = 0xD1D4DC; // Pure black flips to light gray
        }

        // Fire directly to the GPU!
        r.drawGPUIndicatorLine(this.id, this.values, color, 2, false, layout);
    }

    public getValueAt(idx: number, ds: DataStore, isDark: boolean, _defaultTextClr: number) {
        const val = (idx >= 0 && idx < ds.length) ? this.values[idx] : 0;
        const rawColor = String(this.getParam('color', '#00BCD4')).toUpperCase();
        let valueColor = parseColor(rawColor);

        if (!isDark && rawColor === '#00BCD4') {
            valueColor = 0x00838F; // Adjust to deep teal on light theme
        }

        // Exact Clash Prevention for Legend Text
        if (!isDark && valueColor === 0xFFFFFF) {
            valueColor = 0x131722;
        } else if (isDark && valueColor === 0x000000) {
            valueColor = 0xD1D4DC;
        }

        return {
            label: this.name,
            valueStr: val > 0 ? val.toFixed(2) : 'n/a',
            valueColor
        };
    }
}