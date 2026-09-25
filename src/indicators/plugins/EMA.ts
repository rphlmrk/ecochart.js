import { BaseIndicator, parseColor, type IndicatorLayout } from '../Indicator';
import type { DataStore } from '../../data/DataStore';
import type { ChartRenderer } from '../../renderer/ChartRenderer';
import { Graphics } from 'pixi.js';

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

    protected next(index: number, _isClosed: boolean, ds: DataStore): void {
        const period = Math.max(1, this.getParam<number>('length', 20));
        const k = 2 / (period + 1);

        if (index === 0) {
            this.values[0] = ds.data[4]; // Initialize first point with first Close
            return;
        }

        const close = ds.data[index * 6 + 4];
        this.values[index] = (close - this.values[index - 1]) * k + this.values[index - 1];
    }

    public render(r: ChartRenderer, layout: IndicatorLayout, _g: Graphics) {
        const rawColor = String(this.getParam('color', '#00BCD4')).trim().toUpperCase();
        let color = parseColor(rawColor);

        // Default adjustments
        if (!r.isDarkTheme && rawColor === '#00BCD4') {
            color = 0x00838F; // Deep teal for light theme
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
        const rawColor = String(this.getParam('color', '#00BCD4')).toUpperCase();
        let valueColor = parseColor(rawColor);
        if (!isDark && rawColor === '#00BCD4') {
            valueColor = 0x00838F; // Adjust to deep teal on light theme
        }

        return {
            label: this.name,
            valueStr: val > 0 ? val.toFixed(2) : 'n/a',
            valueColor
        };
    }
}