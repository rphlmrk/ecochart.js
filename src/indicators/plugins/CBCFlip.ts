import { BaseIndicator, parseColor, parseColorAndAlpha, type IndicatorLayout } from '../Indicator';
import type { DataStore } from '../../data/DataStore';
import type { ChartRenderer } from '../../renderer/ChartRenderer';
import { Graphics } from 'pixi.js';

export class CBCFlipIndicator extends BaseIndicator {
    // 1 = Bull flip (cbc && !cbc[1]), -1 = Bear flip (!cbc && cbc[1]), 0 = none
    public flips: Int8Array = new Int8Array(20000);

    constructor() {
        super('CBC_FLIP', 'CBC Flip', false);

        this.params = [
            { id: 'showShapes', name: 'Show Flip Shapes', type: 'boolean', value: true },
            { id: 'bullColor', name: 'Bulls Signal Color', type: 'color', value: '#78CEB0' },
            { id: 'bearColor', name: 'Bears Signal Color', type: 'color', value: '#E46666' },
            { id: 'shapeSize', name: 'Shape Size', type: 'number', value: 7, min: 3, max: 20, step: 1 },
            { id: 'showBgColor', name: 'Show Background Highlight', type: 'boolean', value: true },
            { id: 'bullBgColor', name: 'Bulls Highlight Color', type: 'color', value: '#FFEB3B4A' },
            { id: 'bearBgColor', name: 'Bears Highlight Color', type: 'color', value: '#05B9F069' }
        ];
    }

    protected override setup(): void {
        this.state = {
            cbc: false,
            prevCbc: false
        };
        if (this.flips.length < this.values.length) {
            this.flips = new Int8Array(this.values.length);
        }
        this.flips.fill(0);
    }

    public override reset(): void {
        this.flips.fill(0);
        super.reset();
    }

    public override update(ds: DataStore, isClosedTick: boolean): void {
        // Detect prepended history and invalidate cache so entire history recalculates
        if (this.lastCalculatedIdx !== -1 && (ds.length > this.lastCalculatedIdx + 2 || ds.length <= this.lastCalculatedIdx)) {
            this.lastCalculatedIdx = -1;
        }
        if (ds.length > this.flips.length) {
            const newFlips = new Int8Array(ds.length * 2);
            newFlips.set(this.flips);
            this.flips = newFlips;
        }
        super.update(ds, isClosedTick);
    }

    protected override cloneState(state: any): any {
        return {
            cbc: !!state.cbc,
            prevCbc: !!state.prevCbc
        };
    }

    protected override next(index: number, isClosed: boolean, ds: DataStore): void {
        if (index === 0) {
            this.state.cbc = false;
            this.state.prevCbc = false;
            this.values[0] = 0;
            this.flips[0] = 0;
            return;
        }

        const prevBase = (index - 1) * 6;
        const prevHigh = ds.data[prevBase + 2];
        const prevLow = ds.data[prevBase + 3];

        const currBase = index * 6;
        const currClose = ds.data[currBase + 4];

        // Pine Script logic:
        // cbc = false
        // cbc := cbc[1]
        // if cbc and close < low[1]
        //     cbc := false
        // if not cbc and close > high[1]
        //     cbc := true
        const prevCbc: boolean = !!this.state.cbc;
        let cbc: boolean = prevCbc;

        if (cbc && currClose < prevLow) {
            cbc = false;
        }
        if (!cbc && currClose > prevHigh) {
            cbc = true;
        }

        this.state.cbc = cbc;
        this.state.prevCbc = prevCbc;
        this.values[index] = cbc ? 1 : 0;

        // Detect flips:
        // Bull flip: cbc and not cbc[1]
        // Bear flip: not cbc and cbc[1]
        let flip = 0;
        if (cbc && !prevCbc) {
            flip = 1;
            if (isClosed) {
                window.dispatchEvent(new CustomEvent('ecochart-alert', {
                    detail: { id: this.id, title: 'Bulls', message: 'Bulls in Control' }
                }));
            }
        } else if (!cbc && prevCbc) {
            flip = -1;
            if (isClosed) {
                window.dispatchEvent(new CustomEvent('ecochart-alert', {
                    detail: { id: this.id, title: 'Bears', message: 'Bears in Control' }
                }));
            }
        }
        this.flips[index] = flip;
    }

    public render(r: ChartRenderer, layout: IndicatorLayout, g: Graphics): void {
        if (!this.visible || r.dataStore.length === 0) return;

        const showShapes = this.getParam<boolean>('showShapes', true);
        const showBgColor = this.getParam<boolean>('showBgColor', true);

        const bullColor = parseColor(this.getParam('bullColor', '#78CEB0'));
        const bearColor = parseColor(this.getParam('bearColor', '#E46666'));

        const bullBg = parseColorAndAlpha(this.getParam('bullBgColor', '#FFEB3B4A'), 0.29);
        const bearBg = parseColorAndAlpha(this.getParam('bearBgColor', '#05B9F069'), 0.41);

        const shapeSize = Math.max(3, this.getParam<number>('shapeSize', 7));

        const sp = r.candleSpacing * r.zoom;
        const visStart = Math.max(0, Math.floor(r.cameraX / sp) - 2);
        const visEnd = Math.min(r.dataStore.length, Math.floor((r.cameraX + layout.chartWidth) / sp) + 2);

        const halfSp = sp * 0.5;
        const ds = r.dataStore;

        // 1. Background tint on flip bars (centered directly on the candlestick)
        if (showBgColor) {
            for (let i = visStart; i < visEnd; i++) {
                const flip = this.flips[i];
                if (flip === 0) continue;

                const centerX = r.getCandleCenterX(i);
                if (flip === 1) {
                    g.rect(centerX - halfSp, 0, sp, layout.mainChartHeight).fill({
                        color: bullBg.color,
                        alpha: bullBg.alpha
                    });
                } else if (flip === -1) {
                    g.rect(centerX - halfSp, 0, sp, layout.mainChartHeight).fill({
                        color: bearBg.color,
                        alpha: bearBg.alpha
                    });
                }
            }
        }

        // 2. Shapes: triangleup (belowbar) & triangledown (abovebar) centered on the candle
        if (showShapes) {
            const offset = 6;
            const triH = shapeSize * 1.35;
            const triHalfW = shapeSize;

            for (let i = visStart; i < visEnd; i++) {
                const flip = this.flips[i];
                if (flip === 0) continue;

                const centerX = r.getCandleCenterX(i);
                const base = i * 6;

                if (flip === 1) {
                    // Bulls: shape.triangleup, location.belowbar
                    const low = ds.data[base + 3];
                    const yLow = r.priceToY(low);
                    const tipY = yLow + offset;
                    const baseY = tipY + triH;

                    g.moveTo(centerX, tipY)
                     .lineTo(centerX - triHalfW, baseY)
                     .lineTo(centerX + triHalfW, baseY)
                     .closePath()
                     .fill({ color: bullColor, alpha: 1.0 });

                } else if (flip === -1) {
                    // Bears: shape.triangledown, location.abovebar
                    const high = ds.data[base + 2];
                    const yHigh = r.priceToY(high);
                    const tipY = yHigh - offset;
                    const baseY = tipY - triH;

                    g.moveTo(centerX, tipY)
                     .lineTo(centerX - triHalfW, baseY)
                     .lineTo(centerX + triHalfW, baseY)
                     .closePath()
                     .fill({ color: bearColor, alpha: 1.0 });
                }
            }
        }
    }

    public override getValueAt(idx: number, ds: DataStore, _isDark: boolean, defaultTextClr: number) {
        if (idx < 0 || idx >= ds.length) {
            return { label: this.name, valueStr: '—', valueColor: defaultTextClr };
        }

        const isBull = this.values[idx] === 1;
        const flip = this.flips[idx];
        const bullClr = parseColor(this.getParam('bullColor', '#78CEB0'));
        const bearClr = parseColor(this.getParam('bearColor', '#E46666'));

        let valueStr = isBull ? 'Bulls' : 'Bears';
        let valueColor = isBull ? bullClr : bearClr;

        if (flip === 1) {
            valueStr = 'Bulls (Flip ▲)';
            valueColor = bullClr;
        } else if (flip === -1) {
            valueStr = 'Bears (Flip ▼)';
            valueColor = bearClr;
        }

        return {
            label: this.name,
            valueStr,
            valueColor
        };
    }
}
