import { BaseIndicator, type IndicatorLayout } from '../Indicator';
import type { DataStore } from '../../data/DataStore';
import type { ChartRenderer } from '../../renderer/ChartRenderer';
import { StrokeEngine } from '../../renderer/StrokeEngine';
import { Graphics } from 'pixi.js';

export class HTFBoxIndicator extends BaseIndicator {
    constructor(tfMins = 60) {
        super(`HTF_BOX_${tfMins}`, `HTF Box (${tfMins}m)`);
        this.params = [
            { id: 'tfMins', name: 'Timeframe', type: 'select', value: String(tfMins), options: ['15', '30', '45', '60', '120', '240', '480', '1440', 'Custom'] },
            { id: 'customMins', name: 'Custom Minutes', type: 'number', value: 45, min: 1, max: 43200, step: 1 },
            { id: 'displayMode', name: 'Display Mode', type: 'select', value: 'Overlay', options: ['Overlay', 'Top Ribbon', 'Bottom Ribbon'] },
            { id: 'opacity', name: 'Body Opacity', type: 'number', value: 0.2, min: 0.05, max: 1.0, step: 0.05 },
            { id: 'showWicks', name: 'Show Wicks', type: 'boolean', value: true },
            { id: 'showVertLines', name: 'Session Vertical Lines', type: 'boolean', value: false }
        ];
    }

    public getEffectiveTfMins(): number {
        const mode = this.getParam<string>('tfMins', '60');
        if (mode === 'Custom') {
            return Math.max(1, this.getParam<number>('customMins', 45));
        }
        return parseInt(mode, 10) || 60;
    }

   protected onParamsUpdated(): void {
        const tfMins = this.getEffectiveTfMins();
        this.id = `HTF_BOX_${tfMins}`;
        this.name = `HTF Box (${tfMins}m)`;
    }

    protected setup(): void {
        this.state = {
            cachedBlocks: [],
            blockStartMs: 0,
            startBarIdx: 0,
            o: 0, h: -Infinity, l: Infinity, c: 0
        };
    }

    protected next(index: number, _isClosed: boolean, ds: DataStore): void {
        const tfMs = this.getEffectiveTfMins() * 60 * 1000;
        const intervalMs = (ds.length >= 2 && ds.data[6] > ds.data[0]) ? (ds.data[6] - ds.data[0]) : 60000;
        const barsPerBlock = Math.max(1, Math.round(tfMs / intervalMs));

        const base = index * 6;
        const t = ds.data[base];
        const bTime = Math.floor(t / tfMs) * tfMs;
        const o = ds.data[base + 1], h = ds.data[base + 2], l = ds.data[base + 3], c = ds.data[base + 4];

        if (this.state.blockStartMs === 0 || bTime !== this.state.blockStartMs) {
            if (this.state.blockStartMs !== 0) {
                this.state.cachedBlocks.push({
                    startBarIdx: this.state.startBarIdx,
                    barsCount: barsPerBlock,
                    o: this.state.o, h: this.state.h, l: this.state.l, c: this.state.c
                });
                
                if (this.state.cachedBlocks.length > 500) this.state.cachedBlocks.shift(); // Prevent memory bloat
            }
            this.state.blockStartMs = bTime;
            this.state.startBarIdx = index;
            this.state.o = o;
            this.state.h = h;
            this.state.l = l;
        } else {
            this.state.h = Math.max(this.state.h, h);
            this.state.l = Math.min(this.state.l, l);
        }
        this.state.c = c;
    }

    public render(r: ChartRenderer, layout: IndicatorLayout, g: Graphics) {
        const displayMode = this.getParam<string>('displayMode', 'Overlay');
        const customOpacity = this.getParam<number>('opacity', 0.2);
        const showWicks = this.getParam<boolean>('showWicks', true);
        const showVert = this.getParam<boolean>('showVertLines', false);

        const opacity = r.isDarkTheme ? customOpacity : Math.min(0.85, customOpacity * 1.6);
        const sp = r.candleSpacing * r.zoom;

        // Combine history with actively forming block
        const blocks = [...(this.state.cachedBlocks || [])];
        if (this.state.blockStartMs !== 0) {
            const intervalMs = (r.dataStore.length >= 2) ? (r.dataStore.data[6] - r.dataStore.data[0]) : 60000;
            const barsPerBlock = Math.max(1, Math.round((this.getEffectiveTfMins() * 60000) / intervalMs));
            blocks.push({
                startBarIdx: this.state.startBarIdx,
                barsCount: barsPerBlock,
                o: this.state.o, h: this.state.h, l: this.state.l, c: this.state.c
            });
        }

        // Zero allocations: loops only over the few pre-calculated blocks visible on screen
        for (let i = 0; i < blocks.length; i++) {
            const b = blocks[i];
            const x1 = (b.startBarIdx * sp) - r.cameraX;
            const x2 = x1 + (b.barsCount * sp);

            // Frustum culling: skip blocks outside the screen
            if (x2 < 0 || x1 > layout.chartWidth) continue;

            this.drawHtfElement(r, layout, g, x1, x2, b.o, b.h, b.l, b.c, opacity, showWicks, displayMode, showVert);
        }
    }

    private drawHtfElement(
        r: ChartRenderer, layout: IndicatorLayout, g: Graphics,
        x1: number, x2: number, o: number, h: number, l: number, c: number,
        opacity: number, showWicks: boolean, mode: string, showVert: boolean
    ) {
        const isBull = c >= o;
        const color = isBull ? r.bullColor : r.bearColor;
        const width = Math.max(1, x2 - x1);

        if (showVert && x1 >= 0 && x1 <= layout.chartWidth) {
            StrokeEngine.drawLine(g, x1, 0, x1, layout.mainChartHeight, {
                color: r.gridColor, width: 1, alpha: 0.6, style: 'dashed', dashLength: 4, gapLength: 3
            });
        }

        if (mode === 'Top Ribbon' || mode === 'Bottom Ribbon') {
            const ribbonH = 18;
            const yTop = mode === 'Top Ribbon' ? 6 : (layout.mainChartHeight - ribbonH - 6);

            g.rect(x1, yTop, width, ribbonH).fill({ color, alpha: opacity });
            g.rect(x1, yTop, width, ribbonH).stroke({ color, alpha: 0.8, width: 1.5 });
            return;
        }

        const yTop = layout.mainChartHeight - (((Math.max(o, c) - r.currentMinPrice) / (r.currentMaxPrice - r.currentMinPrice)) * layout.mainChartHeight) + r.cameraY;
        const yBot = layout.mainChartHeight - (((Math.min(o, c) - r.currentMinPrice) / (r.currentMaxPrice - r.currentMinPrice)) * layout.mainChartHeight) + r.cameraY;
        const borderAlpha = r.isDarkTheme ? 0.6 : 0.85;

        if (showWicks) {
            const yH = layout.mainChartHeight - (((h - r.currentMinPrice) / (r.currentMaxPrice - r.currentMinPrice)) * layout.mainChartHeight) + r.cameraY;
            const yL = layout.mainChartHeight - (((l - r.currentMinPrice) / (r.currentMaxPrice - r.currentMinPrice)) * layout.mainChartHeight) + r.cameraY;
            const xMid = x1 + width / 2;

            g.moveTo(xMid, yH).lineTo(xMid, yTop).stroke({ color, alpha: borderAlpha, width: 1.5 });
            g.moveTo(xMid, yBot).lineTo(xMid, yL).stroke({ color, alpha: borderAlpha, width: 1.5 });
        }

        g.rect(x1, yTop, width, Math.max(1, yBot - yTop)).fill({ color, alpha: opacity });
        g.rect(x1, yTop, width, Math.max(1, yBot - yTop)).stroke({ color, alpha: borderAlpha, width: 1.5 });
    }

    public getValueAt(idx: number, ds: DataStore, _isDark: boolean, _defaultTextClr: number) {
        const close = (idx >= 0 && idx < ds.length) ? ds.data[idx * 6 + 4] : 0;
        const open = (idx >= 0 && idx < ds.length) ? ds.data[idx * 6 + 1] : 0;
        return {
            label: this.name,
            valueStr: close >= open ? 'Bullish' : 'Bearish',
            valueColor: close >= open ? 0x26A69A : 0xEF5350
        };
    }
}