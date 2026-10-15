import { BaseIndicator, parseColor, parseColorAndAlpha, type IndicatorLayout } from '../Indicator';
import type { DataStore } from '../../data/DataStore';
import type { ChartRenderer } from '../../renderer/ChartRenderer';
import { TimeframeResampler } from '../../data/TimeframeResampler';
import { Graphics } from 'pixi.js';

export class CBCFlipIndicator extends BaseIndicator {
    // 1 = Bull flip (cbc && !cbc[1]), -1 = Bear flip (!cbc && cbc[1]), 0 = none
    public flips: Int8Array = new Int8Array(20000);

    constructor() {
        super('CBC_FLIP', 'CBC Flip', false);

        this.params = [
            {
                id: 'timeframe',
                name: 'Timeframe',
                type: 'select',
                value: 'Current',
                options: ['Current', '1m', '3m', '5m', '15m', '30m', '45m', '1h', '2h', '3h', '4h', '6h', '8h', '12h', '1d', 'Custom']
            },
            { id: 'customTfMins', name: 'Custom HTF Minutes', type: 'number', value: 60, min: 1, max: 43200, step: 1 },
            { id: 'triggerOnClose', name: 'Trigger on Candle Close Only', type: 'boolean', value: true },
            { id: 'showShapes', name: 'Show Flip Shapes', type: 'boolean', value: true },
            { id: 'bullColor', name: 'Bulls Signal Color', type: 'color', value: '#78CEB0' },
            { id: 'bearColor', name: 'Bears Signal Color', type: 'color', value: '#E46666' },
            { id: 'shapeSize', name: 'Shape Size', type: 'number', value: 7, min: 3, max: 20, step: 1 },
            { id: 'showBgColor', name: 'Show Background Highlight', type: 'boolean', value: true },
            { id: 'bullBgColor', name: 'Bulls Highlight Color', type: 'color', value: '#FFEB3B4A' },
            { id: 'bearBgColor', name: 'Bears Highlight Color', type: 'color', value: '#05B9F069' }
        ];
    }

    public getEffectiveTfMs(chartTfMs: number): number {
        const mode = this.getParam<string>('timeframe', 'Current');
        if (mode === 'Current') return chartTfMs;
        if (mode === 'Custom') {
            const mins = Math.max(1, this.getParam<number>('customTfMins', 60));
            return mins * 60 * 1000;
        }
        return TimeframeResampler.parseMs(mode.toLowerCase());
    }

    public isHTF(chartTfMs: number): boolean {
        const tfMs = this.getEffectiveTfMs(chartTfMs);
        return tfMs > chartTfMs;
    }

    public getDisplayTitle(chartTfMs: number): string {
        const tf = this.getParam<string>('timeframe', 'Current');
        if (tf === 'Current') return 'CBC Flip';
        const tfMs = this.getEffectiveTfMs(chartTfMs);
        if (tfMs <= chartTfMs) {
            return `CBC Flip (Current)`;
        }
        return `CBC Flip (${tf})`;
    }

    protected override onParamsUpdated(): void {
        this.reset();
        const tf = this.getParam<string>('timeframe', 'Current');
        this.name = tf === 'Current' ? 'CBC Flip' : `CBC Flip (${tf})`;
    }

    protected override setup(): void {
        this.state = {
            // Current timeframe state
            cbc: false,
            prevCbc: false,
            // HTF state
            currBlockTime: 0,
            blockStartIdx: 0,
            blockHigh: -Infinity,
            blockLow: Infinity,
            blockClose: 0,
            priorHigh: -Infinity,
            priorLow: Infinity,
            priorClose: 0,
            htfCbc: false,
            prevHtfCbc: false
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
        if (ds.length > this.flips.length) {
            const newFlips = new Int8Array(Math.max(ds.length * 2, 20000));
            newFlips.set(this.flips);
            this.flips = newFlips;
        }
        super.update(ds, isClosedTick);
    }

    protected override cloneState(state: any): any {
        return {
            cbc: !!state.cbc,
            prevCbc: !!state.prevCbc,
            currBlockTime: state.currBlockTime || 0,
            blockStartIdx: state.blockStartIdx || 0,
            blockHigh: state.blockHigh ?? -Infinity,
            blockLow: state.blockLow ?? Infinity,
            blockClose: state.blockClose ?? 0,
            priorHigh: state.priorHigh ?? -Infinity,
            priorLow: state.priorLow ?? Infinity,
            priorClose: state.priorClose ?? 0,
            htfCbc: !!state.htfCbc,
            prevHtfCbc: !!state.prevHtfCbc
        };
    }

    protected override next(index: number, isClosed: boolean, ds: DataStore): void {
        const chartTfMs = (ds.length >= 2 && ds.data[6] > ds.data[0]) ? (ds.data[6] - ds.data[0]) : 60000;
        const tfMs = this.getEffectiveTfMs(chartTfMs);
        const isHTF = tfMs > chartTfMs;

        const currBase = index * 6;
        const t = ds.data[currBase];
        const currHigh = ds.data[currBase + 2];
        const currLow = ds.data[currBase + 3];
        const currClose = ds.data[currBase + 4];

        if (!isHTF) {
            // ==========================================
            // Mode 1: Current Timeframe
            // ==========================================
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

            const prevCbc = !!this.state.cbc;
            let cbc = prevCbc;

            if (cbc && currClose < prevLow) {
                cbc = false;
            }
            if (!cbc && currClose > prevHigh) {
                cbc = true;
            }

            this.state.cbc = cbc;
            this.state.prevCbc = prevCbc;
            this.values[index] = cbc ? 1 : 0;

            let flip = 0;
            const triggerOnClose = this.getParam<boolean>('triggerOnClose', true);
            if (!triggerOnClose || isClosed) {
                if (cbc && !prevCbc) {
                    flip = 1;
                    if (isClosed) {
                        window.dispatchEvent(new CustomEvent('ecochart-alert', {
                            detail: { id: this.id, title: 'Bulls', message: `${this.name}: Bulls in Control` }
                        }));
                    }
                } else if (!cbc && prevCbc) {
                    flip = -1;
                    if (isClosed) {
                        window.dispatchEvent(new CustomEvent('ecochart-alert', {
                            detail: { id: this.id, title: 'Bears', message: `${this.name}: Bears in Control` }
                        }));
                    }
                }
            }
            this.flips[index] = flip;
            return;
        }

        // ==========================================
        // Mode 2: Higher Timeframe (HTF)
        // ==========================================
        const bTime = TimeframeResampler.getBucketStart(t, tfMs);

        if (index === 0) {
            this.state.currBlockTime = bTime;
            this.state.blockStartIdx = 0;
            this.state.blockHigh = currHigh;
            this.state.blockLow = currLow;
            this.state.blockClose = currClose;
            this.state.priorHigh = -Infinity;
            this.state.priorLow = Infinity;
            this.state.priorClose = 0;
            this.state.htfCbc = false;
            this.state.prevHtfCbc = false;
            this.values[0] = 0;
            this.flips[0] = 0;
            return;
        }

        // Check if an HTF block has completed
        if (this.state.currBlockTime !== 0 && bTime !== this.state.currBlockTime) {
            // The previous HTF block (ending at index - 1) just closed!
            const closedHigh = this.state.blockHigh;
            const closedLow = this.state.blockLow;
            const closedClose = this.state.blockClose;

            if (this.state.priorHigh !== -Infinity) {
                const prevHtfCbc = this.state.htfCbc;
                let htfCbc = prevHtfCbc;

                if (htfCbc && closedClose < this.state.priorLow) {
                    htfCbc = false;
                }
                if (!htfCbc && closedClose > this.state.priorHigh) {
                    htfCbc = true;
                }

                this.state.htfCbc = htfCbc;
                this.state.prevHtfCbc = prevHtfCbc;

                let flip = 0;
                if (htfCbc && !prevHtfCbc) {
                    flip = 1;
                    if (isClosed) {
                        window.dispatchEvent(new CustomEvent('ecochart-alert', {
                            detail: { id: this.id, title: 'Bulls', message: `${this.name}: Bulls in Control` }
                        }));
                    }
                } else if (!htfCbc && prevHtfCbc) {
                    flip = -1;
                    if (isClosed) {
                        window.dispatchEvent(new CustomEvent('ecochart-alert', {
                            detail: { id: this.id, title: 'Bears', message: `${this.name}: Bears in Control` }
                        }));
                    }
                }

                // Stamp flip on the closing bar of the HTF candle (index - 1)
                if (flip !== 0) {
                    this.flips[index - 1] = flip;
                }
            }

            // Advance prior HTF candle values
            this.state.priorHigh = closedHigh;
            this.state.priorLow = closedLow;
            this.state.priorClose = closedClose;

            // Start new HTF bucket
            this.state.currBlockTime = bTime;
            this.state.blockStartIdx = index;
            this.state.blockHigh = currHigh;
            this.state.blockLow = currLow;
            this.state.blockClose = currClose;
        } else {
            // Update extremes for current HTF bucket
            if (currHigh > this.state.blockHigh) this.state.blockHigh = currHigh;
            if (currLow < this.state.blockLow) this.state.blockLow = currLow;
            this.state.blockClose = currClose;
        }

        // Current bar carries the active HTF trend state
        this.values[index] = this.state.htfCbc ? 1 : 0;

        // On HTF, forming bars never trigger flip signals until closed
        let flip = 0;
        const isHTFBlockBoundary = (t + chartTfMs) >= (bTime + tfMs);
        if (isClosed && isHTFBlockBoundary && this.state.priorHigh !== -Infinity) {
            const prevHtfCbc = this.state.htfCbc;
            let htfCbc = prevHtfCbc;
            if (htfCbc && this.state.blockClose < this.state.priorLow) {
                htfCbc = false;
            }
            if (!htfCbc && this.state.blockClose > this.state.priorHigh) {
                htfCbc = true;
            }
            if (htfCbc && !prevHtfCbc) {
                flip = 1;
                window.dispatchEvent(new CustomEvent('ecochart-alert', {
                    detail: { id: this.id, title: 'Bulls', message: `${this.name}: Bulls in Control` }
                }));
            } else if (!htfCbc && prevHtfCbc) {
                flip = -1;
                window.dispatchEvent(new CustomEvent('ecochart-alert', {
                    detail: { id: this.id, title: 'Bears', message: `${this.name}: Bears in Control` }
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

        // 1. Batched Background Highlights
        // Batching all bull rects and bear rects into single draw passes eliminates per-bar GPU draw calls
        if (showBgColor) {
            let hasBullBg = false;
            let hasBearBg = false;

            // Draw Bull Backgrounds
            for (let i = visStart; i < visEnd; i++) {
                if (this.flips[i] === 1) {
                    const centerX = r.getCandleCenterX(i);
                    g.rect(centerX - halfSp, 0, sp, layout.mainChartHeight);
                    hasBullBg = true;
                }
            }
            if (hasBullBg) {
                g.fill({ color: bullBg.color, alpha: bullBg.alpha });
            }

            // Draw Bear Backgrounds
            for (let i = visStart; i < visEnd; i++) {
                if (this.flips[i] === -1) {
                    const centerX = r.getCandleCenterX(i);
                    g.rect(centerX - halfSp, 0, sp, layout.mainChartHeight);
                    hasBearBg = true;
                }
            }
            if (hasBearBg) {
                g.fill({ color: bearBg.color, alpha: bearBg.alpha });
            }
        }

        // 2. Batched Shapes: triangleup (belowbar) & triangledown (abovebar) centered on the candle
        if (showShapes) {
            const offset = 6;
            const triH = shapeSize * 1.35;
            const triHalfW = shapeSize;

            let hasBullShapes = false;
            let hasBearShapes = false;

            // Batch all Bull triangles into a single path and fill once
            for (let i = visStart; i < visEnd; i++) {
                if (this.flips[i] === 1) {
                    const centerX = r.getCandleCenterX(i);
                    const base = i * 6;
                    const low = ds.data[base + 3];
                    const yLow = r.priceToY(low);
                    const tipY = yLow + offset;
                    const baseY = tipY + triH;

                    g.moveTo(centerX, tipY)
                     .lineTo(centerX - triHalfW, baseY)
                     .lineTo(centerX + triHalfW, baseY)
                     .closePath();
                    hasBullShapes = true;
                }
            }
            if (hasBullShapes) {
                g.fill({ color: bullColor, alpha: 1.0 });
            }

            // Batch all Bear triangles into a single path and fill once
            for (let i = visStart; i < visEnd; i++) {
                if (this.flips[i] === -1) {
                    const centerX = r.getCandleCenterX(i);
                    const base = i * 6;
                    const high = ds.data[base + 2];
                    const yHigh = r.priceToY(high);
                    const tipY = yHigh - offset;
                    const baseY = tipY - triH;

                    g.moveTo(centerX, tipY)
                     .lineTo(centerX - triHalfW, baseY)
                     .lineTo(centerX + triHalfW, baseY)
                     .closePath();
                    hasBearShapes = true;
                }
            }
            if (hasBearShapes) {
                g.fill({ color: bearColor, alpha: 1.0 });
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

        const chartTfMs = (ds.length >= 2 && ds.data[6] > ds.data[0]) ? (ds.data[6] - ds.data[0]) : 60000;
        const title = this.getDisplayTitle(chartTfMs);

        return {
            label: title,
            valueStr,
            valueColor
        };
    }
}
