import { BaseIndicator, parseColor, parseColorAndAlpha, type IndicatorLayout } from '../Indicator';
import type { DataStore } from '../../data/DataStore';
import type { ChartRenderer } from '../../renderer/ChartRenderer';
import { TimeframeResampler } from '../../data/TimeframeResampler';
import { Graphics } from 'pixi.js';

export class CBCFlipIndicator extends BaseIndicator {
    // 1 = Bull flip, -1 = Bear flip, 0 = none
    public flips: Int8Array = new Int8Array(20000);
    // Tracked Wick Expansion Levels
    public trackedHighs: Float64Array = new Float64Array(20000);
    public trackedLows: Float64Array = new Float64Array(20000);

    constructor() {
        super('CBC_FLIP', 'CBC Flip (Wick Expansion)', false);

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
            { id: 'showLines', name: 'Show Dynamic Wick Lines', type: 'boolean', value: true },
            { id: 'showBothWicks', name: 'Show Both Wicks of Tracked Candle', type: 'boolean', value: false },
            { id: 'lineWidth', name: 'Wick Line Width', type: 'number', value: 2, min: 1, max: 5, step: 1 },
            { id: 'showShapes', name: 'Show Flip Shapes', type: 'boolean', value: true },
            { id: 'bullColor', name: 'Bulls Color (Support / ▲)', type: 'color', value: '#78CEB0' },
            { id: 'bearColor', name: 'Bears Color (Resistance / ▼)', type: 'color', value: '#E46666' },
            { id: 'shapeSize', name: 'Shape Size', type: 'number', value: 7, min: 3, max: 20, step: 1 },
            { id: 'showBgColor', name: 'Show Background Highlight', type: 'boolean', value: true },
            { id: 'bullBgColor', name: 'Bulls Highlight Color', type: 'color', value: '#FFEB3B47' },
            { id: 'bearBgColor', name: 'Bears Highlight Color', type: 'color', value: '#05B9F03B' }
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
        if (tf === 'Current') return 'CBC Flip (Wick Expansion)';
        const tfMs = this.getEffectiveTfMs(chartTfMs);
        if (tfMs <= chartTfMs) {
            return `CBC Flip (Wick Expansion) [Current]`;
        }
        return `CBC Flip (Wick Expansion) [${tf}]`;
    }

    protected override onParamsUpdated(): void {
        this.reset();
        const tf = this.getParam<string>('timeframe', 'Current');
        this.name = tf === 'Current' ? 'CBC Flip (Wick Expansion)' : `CBC Flip (Wick Expansion) [${tf}]`;
    }

    protected override setup(): void {
        this.state = {
            cbc: false,
            prevCbc: false,
            trackedHigh: NaN,
            trackedLow: NaN,
            currBlockTime: 0,
            blockStartIdx: 0,
            blockHigh: -Infinity,
            blockLow: Infinity,
            blockClose: 0,
            htfTrackedHigh: NaN,
            htfTrackedLow: NaN,
            htfCbc: false,
            prevHtfCbc: false
        };
        if (this.flips.length < this.values.length) {
            this.flips = new Int8Array(this.values.length);
            this.trackedHighs = new Float64Array(this.values.length);
            this.trackedLows = new Float64Array(this.values.length);
        }
        this.flips.fill(0);
        this.trackedHighs.fill(0);
        this.trackedLows.fill(0);
    }

    public override reset(): void {
        this.flips.fill(0);
        this.trackedHighs.fill(0);
        this.trackedLows.fill(0);
        super.reset();
    }

    public override update(ds: DataStore, isClosedTick: boolean): void {
        if (ds.length > this.flips.length) {
            const capacity = Math.max(ds.length * 2, 20000);
            const newFlips = new Int8Array(capacity);
            newFlips.set(this.flips);
            this.flips = newFlips;

            const newHighs = new Float64Array(capacity);
            newHighs.set(this.trackedHighs);
            this.trackedHighs = newHighs;

            const newLows = new Float64Array(capacity);
            newLows.set(this.trackedLows);
            this.trackedLows = newLows;
        }
        super.update(ds, isClosedTick);
    }

    protected override cloneState(state: any): any {
        return {
            cbc: !!state.cbc,
            prevCbc: !!state.prevCbc,
            trackedHigh: state.trackedHigh,
            trackedLow: state.trackedLow,
            currBlockTime: state.currBlockTime || 0,
            blockStartIdx: state.blockStartIdx || 0,
            blockHigh: state.blockHigh ?? -Infinity,
            blockLow: state.blockLow ?? Infinity,
            blockClose: state.blockClose ?? 0,
            htfTrackedHigh: state.htfTrackedHigh,
            htfTrackedLow: state.htfTrackedLow,
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
            // Mode 1: Current Timeframe (Wick Expansion)
            // ==========================================
            if (index === 0 || isNaN(this.state.trackedHigh)) {
                this.state.trackedHigh = currHigh;
                this.state.trackedLow = currLow;
                this.state.cbc = false;
                this.state.prevCbc = false;
                this.values[0] = 0;
                this.flips[0] = 0;
                this.trackedHighs[0] = currHigh;
                this.trackedLows[0] = currLow;
                return;
            }

            let cbc = !!this.state.cbc;
            const prevCbc = cbc;
            let trackedHigh = this.state.trackedHigh;
            let trackedLow = this.state.trackedLow;
            let bullSignal = false;
            let bearSignal = false;

            // --- CORE WICK EXPANSION LOGIC ---
            if (currClose < trackedLow) {
                // 1. CANDLE CLOSED OUTSIDE BELOW LOW
                if (cbc) {
                    cbc = false;
                    bearSignal = true;
                }
                // Reset reference levels to this breakout candle
                trackedHigh = currHigh;
                trackedLow = currLow;
            } else if (currClose > trackedHigh) {
                // 2. CANDLE CLOSED OUTSIDE ABOVE HIGH
                if (!cbc) {
                    cbc = true;
                    bullSignal = true;
                }
                // Reset reference levels to this breakout candle
                trackedHigh = currHigh;
                trackedLow = currLow;
            } else {
                // 3. CANDLE DID NOT CLOSE OUTSIDE (Closed inside the range)
                // If it wicked beyond the range, take the new wick and expand bounds:
                if (currHigh > trackedHigh) {
                    trackedHigh = currHigh;
                }
                if (currLow < trackedLow) {
                    trackedLow = currLow;
                }
            }

            this.state.cbc = cbc;
            this.state.prevCbc = prevCbc;
            this.state.trackedHigh = trackedHigh;
            this.state.trackedLow = trackedLow;

            this.values[index] = cbc ? 1 : 0;
            this.trackedHighs[index] = trackedHigh;
            this.trackedLows[index] = trackedLow;

            let flip = 0;
            const triggerOnClose = this.getParam<boolean>('triggerOnClose', true);
            if (!triggerOnClose || isClosed) {
                if (bullSignal) {
                    flip = 1;
                    if (isClosed) {
                        window.dispatchEvent(new CustomEvent('ecochart-alert', {
                            detail: { id: this.id, title: 'Bulls', message: `${this.name}: Bulls in Control` }
                        }));
                    }
                } else if (bearSignal) {
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
        // Mode 2: Higher Timeframe (HTF Wick Expansion)
        // ==========================================
        const bTime = TimeframeResampler.getBucketStart(t, tfMs);

        if (index === 0) {
            this.state.currBlockTime = bTime;
            this.state.blockStartIdx = 0;
            this.state.blockHigh = currHigh;
            this.state.blockLow = currLow;
            this.state.blockClose = currClose;
            this.state.htfTrackedHigh = currHigh;
            this.state.htfTrackedLow = currLow;
            this.state.htfCbc = false;
            this.state.prevHtfCbc = false;
            this.values[0] = 0;
            this.flips[0] = 0;
            this.trackedHighs[0] = currHigh;
            this.trackedLows[0] = currLow;
            return;
        }

        // Check if an HTF block has completed
        if (this.state.currBlockTime !== 0 && bTime !== this.state.currBlockTime) {
            // Previous HTF candle (ending at index - 1) just closed!
            const closedHigh = this.state.blockHigh;
            const closedLow = this.state.blockLow;
            const closedClose = this.state.blockClose;

            let htfCbc = !!this.state.htfCbc;
            const prevHtfCbc = htfCbc;
            let htfTrackedHigh = isNaN(this.state.htfTrackedHigh) ? closedHigh : this.state.htfTrackedHigh;
            let htfTrackedLow = isNaN(this.state.htfTrackedLow) ? closedLow : this.state.htfTrackedLow;
            let bullSignal = false;
            let bearSignal = false;

            if (closedClose < htfTrackedLow) {
                if (htfCbc) {
                    htfCbc = false;
                    bearSignal = true;
                }
                htfTrackedHigh = closedHigh;
                htfTrackedLow = closedLow;
            } else if (closedClose > htfTrackedHigh) {
                if (!htfCbc) {
                    htfCbc = true;
                    bullSignal = true;
                }
                htfTrackedHigh = closedHigh;
                htfTrackedLow = closedLow;
            } else {
                if (closedHigh > htfTrackedHigh) htfTrackedHigh = closedHigh;
                if (closedLow < htfTrackedLow) htfTrackedLow = closedLow;
            }

            this.state.htfCbc = htfCbc;
            this.state.prevHtfCbc = prevHtfCbc;
            this.state.htfTrackedHigh = htfTrackedHigh;
            this.state.htfTrackedLow = htfTrackedLow;

            let flip = 0;
            if (bullSignal) {
                flip = 1;
                if (isClosed) {
                    window.dispatchEvent(new CustomEvent('ecochart-alert', {
                        detail: { id: this.id, title: 'Bulls', message: `${this.name}: Bulls in Control` }
                    }));
                }
            } else if (bearSignal) {
                flip = -1;
                if (isClosed) {
                    window.dispatchEvent(new CustomEvent('ecochart-alert', {
                        detail: { id: this.id, title: 'Bears', message: `${this.name}: Bears in Control` }
                    }));
                }
            }

            if (flip !== 0) {
                this.flips[index - 1] = flip;
            }

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

        // Assign current state to this lower timeframe bar
        this.values[index] = this.state.htfCbc ? 1 : 0;
        this.trackedHighs[index] = this.state.htfTrackedHigh;
        this.trackedLows[index] = this.state.htfTrackedLow;

        // On HTF, signals strictly trigger on candle close
        let flip = 0;
        const isHTFBlockBoundary = (t + chartTfMs) >= (bTime + tfMs);
        if (isClosed && isHTFBlockBoundary && !isNaN(this.state.htfTrackedHigh)) {
            let htfCbc = !!this.state.htfCbc;
            let bullSignal = false;
            let bearSignal = false;
            if (this.state.blockClose < this.state.htfTrackedLow) {
                if (htfCbc) bearSignal = true;
            } else if (this.state.blockClose > this.state.htfTrackedHigh) {
                if (!htfCbc) bullSignal = true;
            }

            if (bullSignal) {
                flip = 1;
                window.dispatchEvent(new CustomEvent('ecochart-alert', {
                    detail: { id: this.id, title: 'Bulls', message: `${this.name}: Bulls in Control` }
                }));
            } else if (bearSignal) {
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

        const showLines = this.getParam<boolean>('showLines', true);
        const showBothWicks = this.getParam<boolean>('showBothWicks', false);
        const lineWidth = Math.max(1, this.getParam<number>('lineWidth', 2));

        const showShapes = this.getParam<boolean>('showShapes', true);
        const showBgColor = this.getParam<boolean>('showBgColor', true);

        const bullColor = parseColor(this.getParam('bullColor', '#78CEB0'));
        const bearColor = parseColor(this.getParam('bearColor', '#E46666'));

        const bullBg = parseColorAndAlpha(this.getParam('bullBgColor', '#FFEB3B47'), 0.28);
        const bearBg = parseColorAndAlpha(this.getParam('bearBgColor', '#05B9F03B'), 0.23);

        const shapeSize = Math.max(3, this.getParam<number>('shapeSize', 7));

        const sp = r.candleSpacing * r.zoom;
        const halfSp = sp * 0.5;
        const visStart = Math.max(0, Math.floor(r.cameraX / sp) - 2);
        const visEnd = Math.min(r.dataStore.length, Math.floor((r.cameraX + layout.chartWidth) / sp) + 2);
        const ds = r.dataStore;

        // =========================================================================
        // 1. Batched Background Highlights (Single GPU draw call per direction)
        // =========================================================================
        if (showBgColor) {
            let hasBullBg = false;
            let hasBearBg = false;

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

        // =========================================================================
        // 2. Dynamic Wick Steplines (Batched GPU Stroke Calls)
        // =========================================================================
        if (showLines) {
            // Helper function to draw continuous stepline paths for a given series and condition
            const drawStepline = (
                getValue: (idx: number) => number,
                isConditionMet: (idx: number) => boolean,
                color: number,
                width: number,
                alpha: number
            ) => {
                let hasPath = false;
                let inSegment = false;
                let prevY = 0;

                for (let i = visStart; i < visEnd; i++) {
                    const active = isConditionMet(i);
                    const val = getValue(i);

                    if (!active || isNaN(val)) {
                        inSegment = false;
                        continue;
                    }

                    const x = r.getCandleCenterX(i);
                    const y = r.priceToY(val);

                    if (!inSegment) {
                        g.moveTo(x - halfSp, y).lineTo(x, y);
                        inSegment = true;
                        hasPath = true;
                    } else {
                        // Horizontal step from prev candle center to current candle center, then vertical jump
                        g.lineTo(x, prevY).lineTo(x, y);
                    }

                    // Extend through the right edge of this bar
                    g.lineTo(x + halfSp, y);
                    prevY = y;
                }

                if (hasPath) {
                    g.stroke({ color, width, alpha });
                }
            };

            // 1. Bullish Support Line: trackedLow (linewidth 2, green)
            drawStepline(
                (i) => this.trackedLows[i],
                (i) => this.values[i] === 1,
                bullColor,
                lineWidth,
                1.0
            );

            // 2. Bearish Resistance Line: trackedHigh (linewidth 2, red)
            drawStepline(
                (i) => this.trackedHighs[i],
                (i) => this.values[i] === 0,
                bearColor,
                lineWidth,
                1.0
            );

            // 3. Optional Secondary Plots (showBothWicks)
            if (showBothWicks) {
                // Bullish Tracked High Ceiling (transparent green, width 1)
                drawStepline(
                    (i) => this.trackedHighs[i],
                    (i) => this.values[i] === 1,
                    bullColor,
                    1,
                    0.40
                );

                // Bearish Tracked Low Floor (transparent red, width 1)
                drawStepline(
                    (i) => this.trackedLows[i],
                    (i) => this.values[i] === 0,
                    bearColor,
                    1,
                    0.40
                );
            }
        }

        // =========================================================================
        // 3. Batched Shapes: triangleup (belowbar) & triangledown (abovebar)
        // =========================================================================
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

        const high = this.trackedHighs[idx];
        const low = this.trackedLows[idx];
        const fmt = (p: number) => {
            if (isNaN(p) || !isFinite(p) || p === 0) return '—';
            return p >= 10 ? p.toFixed(2) : p.toPrecision(5);
        };

        let valueStr = isBull ? `Bulls (Supp: ${fmt(low)})` : `Bears (Res: ${fmt(high)})`;
        let valueColor = isBull ? bullClr : bearClr;

        if (flip === 1) {
            valueStr = `Bulls (Flip ▲ | ${fmt(low)})`;
            valueColor = bullClr;
        } else if (flip === -1) {
            valueStr = `Bears (Flip ▼ | ${fmt(high)})`;
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
