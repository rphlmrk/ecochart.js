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

    protected setup(): void {}

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

    public render(r: ChartRenderer, layout: IndicatorLayout, g: Graphics) {
        const rawColor = this.getParam('color', '#00BCD4');
        
        // Darken default cyan slightly on light themes for crisp contrast
        let color = parseColor(rawColor);
        if (!r.isDarkTheme && String(rawColor).toUpperCase() === '#00BCD4') {
            color = 0x00838F; // Deep teal for light theme
        }
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
        g.stroke({ color, width: 2 });
    }

    public getValueAt(idx: number, ds: DataStore, _isDark: boolean, _defaultTextClr: number) {
        const val = (idx >= 0 && idx < ds.length) ? this.values[idx] : 0;
        return {
            label: this.name,
            valueStr: val > 0 ? val.toFixed(2) : 'n/a',
            valueColor: parseColor(this.getParam('color', '#00BCD4'))
        };
    }
}