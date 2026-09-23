import { BaseIndicator, parseColor, type IndicatorLayout } from '../Indicator';
import type { DataStore } from '../../data/DataStore';
import type { ChartRenderer } from '../../renderer/ChartRenderer';
import { Graphics } from 'pixi.js';

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

    protected setup(): void {}

    protected next(index: number, _isClosed: boolean, ds: DataStore): void {
        const length = Math.max(1, this.getParam<number>('length', 20));
        if (index < length - 1) return;
        
        let sum = 0;
        for (let j = 0; j < length; j++) {
            sum += ds.data[(index - j) * 6 + 4]; // Close price
        }
        this.values[index] = sum / length;
    }

    public render(r: ChartRenderer, layout: IndicatorLayout, g: Graphics) {
        const length = Math.max(1, this.getParam<number>('length', 20));
        const rawColor = this.getParam('color', '#FFC107');
        
        let color = parseColor(rawColor);
        if (!r.isDarkTheme && String(rawColor).toUpperCase() === '#FFC107') {
            color = 0xD97706;
        }

        const sp = r.candleSpacing * r.zoom;
        const visStart = Math.max(length, Math.floor(r.cameraX / sp));
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
            valueColor: parseColor(this.getParam('color', '#FFC107'))
        };
    }
}