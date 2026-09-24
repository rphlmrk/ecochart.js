import { BaseIndicator, parseColor, type IndicatorLayout } from '../Indicator';
import type { DataStore } from '../../data/DataStore';
import type { ChartRenderer } from '../../renderer/ChartRenderer';
import { Graphics } from 'pixi.js';

export class VolumeIndicator extends BaseIndicator {
    constructor() {
        super('VOL', 'Volume');
        this.params = [
            { id: 'heightPct', name: 'Pane Height %', type: 'number', value: 0.15, min: 0.05, max: 0.5, step: 0.05 },
            { id: 'upColor', name: 'Up Vol Color', type: 'color', value: '#26A69A' },
            { id: 'downColor', name: 'Down Vol Color', type: 'color', value: '#EF5350' },
            { id: 'opacity', name: 'Bar Opacity', type: 'number', value: 0.4, min: 0.1, max: 1.0, step: 0.05 }
        ];
    }

    protected setup(): void {}
    protected next(): void {} // Volume reads directly from DataStore in render(), no math needed

    public render(r: ChartRenderer, layout: IndicatorLayout, g: Graphics) {
        const heightPct = this.getParam<number>('heightPct', 0.15);
        const rawUp = this.getParam('upColor', '#26A69A');
        const rawDown = this.getParam('downColor', '#EF5350');

        const upColor = rawUp === '#26A69A' ? r.bullColor : parseColor(rawUp);
        const downColor = rawDown === '#EF5350' ? r.bearColor : parseColor(rawDown);

        const customOpacity = this.getParam<number>('opacity', 0.4);
        const opacity = r.isDarkTheme ? customOpacity : Math.min(0.9, customOpacity * 1.6);

        const sp = r.candleSpacing * r.zoom;
        const visStart = Math.max(0, Math.floor(r.cameraX / sp));
        const visEnd = Math.min(r.dataStore.length, Math.floor((r.cameraX + layout.chartWidth) / sp) + 1);

        let maxVol = 0;
        for (let i = visStart; i < visEnd; i++) {
            maxVol = Math.max(maxVol, r.dataStore.data[i * 6 + 5]);
        }
        if (maxVol === 0) return;

        const maxH = layout.mainChartHeight * heightPct;
        const barW = Math.max(1, sp * 0.8);

        // BATcH RENDER: UP CANDLES
        g.beginPath();
        for (let i = visStart; i < visEnd; i++) {
            const base = i * 6;
            const open = r.dataStore.data[base + 1];
            const close = r.dataStore.data[base + 4];
            if (close >= open) {
                const vol = r.dataStore.data[base + 5];
                const x = (i * sp) - r.cameraX;
                const h = (vol / maxVol) * maxH;
                g.rect(x, layout.mainChartHeight - h, barW, h);
            }
        }
        g.fill({ color: upColor, alpha: opacity });

        // BATCH RENDER: DOWN CANDLES
        g.beginPath();
        for (let i = visStart; i < visEnd; i++) {
            const base = i * 6;
            const open = r.dataStore.data[base + 1];
            const close = r.dataStore.data[base + 4];
            if (close < open) {
                const vol = r.dataStore.data[base + 5];
                const x = (i * sp) - r.cameraX;
                const h = (vol / maxVol) * maxH;
                g.rect(x, layout.mainChartHeight - h, barW, h);
            }
        }
        g.fill({ color: downColor, alpha: opacity });
    }

    public getValueAt(idx: number, ds: DataStore, _isDark: boolean, _defaultTextClr: number) {
        const vol = (idx >= 0 && idx < ds.length) ? ds.data[idx * 6 + 5] : 0;
        const open = (idx >= 0 && idx < ds.length) ? ds.data[idx * 6 + 1] : 0;
        const close = (idx >= 0 && idx < ds.length) ? ds.data[idx * 6 + 4] : 0;
        const clr = close >= open 
            ? parseColor(this.getParam('upColor', '#26A69A')) 
            : parseColor(this.getParam('downColor', '#EF5350'));

        let volStr = vol.toFixed(0);
        if (vol >= 1_000_000) volStr = (vol / 1_000_000).toFixed(2) + 'M';
        else if (vol >= 1_000) volStr = (vol / 1_000).toFixed(1) + 'K';

        return {
            label: 'Volume',
            valueStr: volStr,
            valueColor: clr
        };
    }
}