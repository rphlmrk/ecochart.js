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
    // Exact Wick Alignment tracking: 1 if line created or level changed on this bar
    public levelChanges: Int8Array = new Int8Array(20000);
    // Active line price (trackedLow if bullish, trackedHigh if bearish)
    public activeLevels: Float64Array = new Float64Array(20000);

    constructor() {
        super('CBC_FLIP', 'CBC Flip (Exact Wick Alignment)', false);

        this.params = [
            {
                id: 'timeframe',
                name: 'Timeframe',
                type: 'select',
                value: 'Current',
                options: ['Current', '1m', '3m', '5m', '15m', '30m', '45m', '1h', '2h', '3h', '4h', '6h', '8h', '12h', '1d', 'Custom']
            },
            { id: 'customTfMins', name: 'Custom HTF Minutes', type: 'number', value: 60, min: 1, max: 43200, step: 1 },
            {
                id: 'lineStyle',
                name: 'Line Style',
                type: 'select',
                value: 'Exact Wick Alignment',
                options: ['Exact Wick Alignment', 'Stepline']
            },
            { id: 'triggerOnClose', name: 'Trigger on Candle Close Only', type: 'boolean', value: true },
            { id: 'showLines', name: 'Show Dynamic Wick Lines', type: 'boolean', value: true },
            { id: 'showBothWicks', name: 'Show Both Wicks of Tracked Candle', type: 'boolean', value: false },
            { id: 'lineWidth', name: 'Line Width', type: 'number', value: 2, min: 1, max: 4, step: 1 },
            { id: 'showShapes', name: 'Show Flip Shapes', type: 'boolean', value: true },
            { id: 'bullColor', name: 'Bullish Support Color', type: 'color', value: '#78CEB0' },
            { id: 'bearColor', name: 'Bearish Resistance Color', type: 'color', value: '#E46666' },
            { id: 'shapeSize', name: 'Shape Size', type: 'number', value: 7, min: 3, max: 20, step: 1 },
            { id: 'showBgColor', name: 'Show Background Highlight', type: 'boolean', value: true },
            { id: 'bullBgColor', name: 'Bulls Highlight Color', type: 'color', value: '#FFEB3B47' },
            { id: 'bearBgColor', name: 'Bears Highlight Color', type: 'color', value: '#05B9F03B' }
        ];
    }

    public static getTimeframeOptions(currentInterval: string): string[] {
        const ALL = ['1m', '3m', '5m', '15m', '30m', '45m', '1h', '2h', '3h', '4h', '6h', '8h', '12h', '1d', '3d', '1w'];
        const currentMs = TimeframeResampler.parseMs(currentInterval);
        const filtered = ALL.filter(tf => TimeframeResampler.parseMs(tf) > currentMs);
        return ['Current', ...filtered, 'Custom HTF'];
    }

    public getTimeframeOptions(currentInterval: string): string[] {
        return CBCFlipIndicator.getTimeframeOptions(currentInterval);
    }

    public getEffectiveTfMs(chartTfMs: number): number {
        const mode = this.getParam<string>('timeframe', 'Current');
        if (mode === 'Current') return chartTfMs;
        if (mode === 'Custom' || mode === 'Custom HTF') {
            const mins = Math.max(1, this.getParam<number>('customTfMins', 60));
            const customMs = mins * 60 * 1000;
            return Math.max(customMs, chartTfMs);
        }
        const parsedMs = TimeframeResampler.parseMs(mode.toLowerCase());
        if (parsedMs <= chartTfMs) {
            return chartTfMs;
        }
        return parsedMs;
    }

    public isHTF(chartTfMs: number): boolean {
        const tfMs = this.getEffectiveTfMs(chartTfMs);
        return tfMs > chartTfMs;
    }

    public getDisplayTitle(chartTfMs: number): string {
        const tf = this.getParam<string>('timeframe', 'Current');
        if (tf === 'Current') return 'CBC Flip (Exact Wick Alignment)';
        const tfMs = this.getEffectiveTfMs(chartTfMs);
        if (tfMs <= chartTfMs) {
            return `CBC Flip (Exact Wick Alignment) [Current]`;
        }
        return `CBC Flip (Exact Wick Alignment) [${tf}]`;
    }

    protected override onParamsUpdated(): void {
        this.reset();
        const tf = this.getParam<string>('timeframe', 'Current');
        this.name = tf === 'Current' ? 'CBC Flip (Exact Wick Alignment)' : `CBC Flip (Exact Wick Alignment) [${tf}]`;
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
            currBlockEvaluated: false,
            htfTrackedHigh: NaN,
            htfTrackedLow: NaN,
            htfCbc: false,
            prevHtfCbc: false
        };
        if (this.flips.length < this.values.length) {
            const cap = this.values.length;
            this.flips = new Int8Array(cap);
            this.trackedHighs = new Float64Array(cap);
            this.trackedLows = new Float64Array(cap);
            this.levelChanges = new Int8Array(cap);
            this.activeLevels = new Float64Array(cap);
        }
        this.flips.fill(0);
        this.trackedHighs.fill(0);
        this.trackedLows.fill(0);
        this.levelChanges.fill(0);
        this.activeLevels.fill(0);
    }

    public override reset(): void {
        this.flips.fill(0);
        this.trackedHighs.fill(0);
        this.trackedLows.fill(0);
        this.levelChanges.fill(0);
        this.activeLevels.fill(0);
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

            const newLevelChanges = new Int8Array(capacity);
            newLevelChanges.set(this.levelChanges);
            this.levelChanges = newLevelChanges;

            const newActiveLevels = new Float64Array(capacity);
            newActiveLevels.set(this.activeLevels);
            this.activeLevels = newActiveLevels;
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
            currBlockEvaluated: !!state.currBlockEvaluated,
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
            // Mode 1: Current Timeframe (Exact Wick Alignment)
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
                this.levelChanges[0] = 1;
                this.activeLevels[0] = currHigh; // not cbc -> activeLevel = trackedHigh
                return;
            }

            let cbc = !!this.state.cbc;
            const prevCbc = cbc;
            let trackedHigh = this.state.trackedHigh;
            let trackedLow = this.state.trackedLow;
            let bullSignal = false;
            let bearSignal = false;
            let levelChanged = false;

            // --- CORE CANDLE-BY-CANDLE LOGIC ---
            if (currClose < trackedLow) {
                // 1. CANDLE CLOSED OUTSIDE BELOW LOW -> Flip to Bearish
                if (cbc) {
                    cbc = false;
                    bearSignal = true;
                }
                trackedHigh = currHigh;
                trackedLow = currLow;
                levelChanged = true;
            } else if (currClose > trackedHigh) {
                // 2. CANDLE CLOSED OUTSIDE ABOVE HIGH -> Flip to Bullish
                if (!cbc) {
                    cbc = true;
                    bullSignal = true;
                }
                trackedHigh = currHigh;
                trackedLow = currLow;
                levelChanged = true;
            } else {
                // 3. CANDLE CLOSED INSIDE (Did not close outside)
                // If it wicks beyond the boundaries, expand that exact wick:
                if (currHigh > trackedHigh) {
                    trackedHigh = currHigh;
                    // If bearish, trackedHigh is our active resistance line
                    if (!cbc) {
                        levelChanged = true;
                    }
                }
                if (currLow < trackedLow) {
                    trackedLow = currLow;
                    // If bullish, trackedLow is our active support line
                    if (cbc) {
                        levelChanged = true;
                    }
                }
            }

            this.state.cbc = cbc;
            this.state.prevCbc = prevCbc;
            this.state.trackedHigh = trackedHigh;
            this.state.trackedLow = trackedLow;

            this.values[index] = cbc ? 1 : 0;
            this.trackedHighs[index] = trackedHigh;
            this.trackedLows[index] = trackedLow;

            const trendFlipped = bullSignal || bearSignal;
            const lineChanged = trendFlipped || levelChanged;
            const currentLevel = cbc ? trackedLow : trackedHigh;

            this.levelChanges[index] = lineChanged ? 1 : 0;
            this.activeLevels[index] = currentLevel;

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
        // Mode 2: Higher Timeframe (HTF Exact Wick Alignment)
        // Strictly triggers after HTF candle close
        // ==========================================
        const bTime = TimeframeResampler.getBucketStart(t, tfMs);

        if (index === 0) {
            this.state.currBlockTime = bTime;
            this.state.blockStartIdx = 0;
            this.state.blockHigh = currHigh;
            this.state.blockLow = currLow;
            this.state.blockClose = currClose;
            this.state.currBlockEvaluated = false;
            this.state.htfTrackedHigh = currHigh;
            this.state.htfTrackedLow = currLow;
            this.state.htfCbc = false;
            this.state.prevHtfCbc = false;
            this.values[0] = 0;
            this.flips[0] = 0;
            this.trackedHighs[0] = currHigh;
            this.trackedLows[0] = currLow;
            this.levelChanges[0] = 1;
            this.activeLevels[0] = currHigh;
            return;
        }

        // Check if a new HTF block has started
        let htfLevelChanged = false;
        if (this.state.currBlockTime !== 0 && bTime !== this.state.currBlockTime) {
            // Previous HTF candle ended at index - 1
            if (!this.state.currBlockEvaluated && index > 0) {
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
                    htfLevelChanged = true;
                } else if (closedClose > htfTrackedHigh) {
                    if (!htfCbc) {
                        htfCbc = true;
                        bullSignal = true;
                    }
                    htfTrackedHigh = closedHigh;
                    htfTrackedLow = closedLow;
                    htfLevelChanged = true;
                } else {
                    if (closedHigh > htfTrackedHigh) {
                        htfTrackedHigh = closedHigh;
                        if (!htfCbc) htfLevelChanged = true;
                    }
                    if (closedLow < htfTrackedLow) {
                        htfTrackedLow = closedLow;
                        if (htfCbc) htfLevelChanged = true;
                    }
                }

                this.state.htfCbc = htfCbc;
                this.state.prevHtfCbc = prevHtfCbc;
                this.state.htfTrackedHigh = htfTrackedHigh;
                this.state.htfTrackedLow = htfTrackedLow;

                if (bullSignal) {
                    this.flips[index - 1] = 1;
                    window.dispatchEvent(new CustomEvent('ecochart-alert', {
                        detail: { id: this.id, title: 'Bulls', message: `${this.name}: Bulls in Control` }
                    }));
                } else if (bearSignal) {
                    this.flips[index - 1] = -1;
                    window.dispatchEvent(new CustomEvent('ecochart-alert', {
                        detail: { id: this.id, title: 'Bears', message: `${this.name}: Bears in Control` }
                    }));
                }
            }

            // Start new HTF bucket
            this.state.currBlockTime = bTime;
            this.state.blockStartIdx = index;
            this.state.blockHigh = currHigh;
            this.state.blockLow = currLow;
            this.state.blockClose = currClose;
            this.state.currBlockEvaluated = false;
        } else {
            // Update extremes for current HTF bucket
            if (currHigh > this.state.blockHigh) this.state.blockHigh = currHigh;
            if (currLow < this.state.blockLow) this.state.blockLow = currLow;
            this.state.blockClose = currClose;
        }

        // Assign current HTF trend state to this lower timeframe bar
        this.values[index] = this.state.htfCbc ? 1 : 0;
        this.trackedHighs[index] = this.state.htfTrackedHigh;
        this.trackedLows[index] = this.state.htfTrackedLow;
        this.flips[index] = 0;

        const htfActiveLevel = this.state.htfCbc ? this.state.htfTrackedLow : this.state.htfTrackedHigh;
        this.activeLevels[index] = htfActiveLevel;
        this.levelChanges[index] = htfLevelChanged ? 1 : 0;

        // Check if the current bar closes the HTF block (exact block boundary and candle closed)
        const isHTFBlockClosed = isClosed && ((t + chartTfMs) >= (bTime + tfMs));
        if (isHTFBlockClosed && !this.state.currBlockEvaluated && !isNaN(this.state.htfTrackedHigh)) {
            const closedHigh = this.state.blockHigh;
            const closedLow = this.state.blockLow;
            const closedClose = this.state.blockClose;

            let htfCbc = !!this.state.htfCbc;
            const prevHtfCbc = htfCbc;
            let htfTrackedHigh = this.state.htfTrackedHigh;
            let htfTrackedLow = this.state.htfTrackedLow;
            let bullSignal = false;
            let bearSignal = false;
            let closedLevelChanged = false;

            if (closedClose < htfTrackedLow) {
                if (htfCbc) {
                    htfCbc = false;
                    bearSignal = true;
                }
                htfTrackedHigh = closedHigh;
                htfTrackedLow = closedLow;
                closedLevelChanged = true;
            } else if (closedClose > htfTrackedHigh) {
                if (!htfCbc) {
                    htfCbc = true;
                    bullSignal = true;
                }
                htfTrackedHigh = closedHigh;
                htfTrackedLow = closedLow;
                closedLevelChanged = true;
            } else {
                if (closedHigh > htfTrackedHigh) {
                    htfTrackedHigh = closedHigh;
                    if (!htfCbc) closedLevelChanged = true;
                }
                if (closedLow < htfTrackedLow) {
                    htfTrackedLow = closedLow;
                    if (htfCbc) closedLevelChanged = true;
                }
            }

            this.state.htfCbc = htfCbc;
            this.state.prevHtfCbc = prevHtfCbc;
            this.state.htfTrackedHigh = htfTrackedHigh;
            this.state.htfTrackedLow = htfTrackedLow;
            this.state.currBlockEvaluated = true;

            this.values[index] = htfCbc ? 1 : 0;
            this.trackedHighs[index] = htfTrackedHigh;
            this.trackedLows[index] = htfTrackedLow;
            const newHtfLevel = htfCbc ? htfTrackedLow : htfTrackedHigh;
            this.activeLevels[index] = newHtfLevel;
            if (closedLevelChanged) {
                this.levelChanges[index] = 1;
            }

            if (bullSignal) {
                this.flips[index] = 1;
                window.dispatchEvent(new CustomEvent('ecochart-alert', {
                    detail: { id: this.id, title: 'Bulls', message: `${this.name}: Bulls in Control` }
                }));
            } else if (bearSignal) {
                this.flips[index] = -1;
                window.dispatchEvent(new CustomEvent('ecochart-alert', {
                    detail: { id: this.id, title: 'Bears', message: `${this.name}: Bears in Control` }
                }));
            }
        }
    }

    public render(r: ChartRenderer, layout: IndicatorLayout, g: Graphics): void {
        if (!this.visible || r.dataStore.length === 0) return;

        const showLines = this.getParam<boolean>('showLines', true);
        const lineStyle = this.getParam<string>('lineStyle', 'Exact Wick Alignment');
        const showBothWicks = this.getParam<boolean>('showBothWicks', false);
        const lineWidth = Math.max(1, Math.min(4, this.getParam<number>('lineWidth', 2)));

        const showShapes = this.getParam<boolean>('showShapes', true);
        const showBgColor = this.getParam<boolean>('showBgColor', true);

        const bullColor = parseColor(this.getParam('bullColor', '#78CEB0'));
        const bearColor = parseColor(this.getParam('bearColor', '#E46666'));

        const bullBg = parseColorAndAlpha(this.getParam('bullBgColor', '#FFEB3B47'), 0.28);
        const bearBg = parseColorAndAlpha(this.getParam('bearBgColor', '#05B9F03B'), 0.23);

        const shapeSize = Math.max(3, this.getParam<number>('shapeSize', 7));

        const sp = r.candleSpacing * r.zoom;
        const halfSp = sp * 0.5;
        const dsLength = r.dataStore.length;
        const visStart = Math.max(0, Math.floor(r.cameraX / sp) - 2);
        const visEnd = Math.min(dsLength, Math.floor((r.cameraX + layout.chartWidth) / sp) + 2);
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
        // 2. Pixel-Perfect Wick Lines (Native Lines vs Stepline)
        // =========================================================================
        if (showLines) {
            if (lineStyle === 'Exact Wick Alignment') {
                // Find where the line covering visStart began
                let segStart = visStart;
                while (segStart > 0 && this.levelChanges[segStart] === 0) {
                    segStart--;
                }

                interface LineSeg { x1: number; y: number; x2: number; }
                const bullLines: LineSeg[] = [];
                const bearLines: LineSeg[] = [];
                const secBullLines: LineSeg[] = [];
                const secBearLines: LineSeg[] = [];

                let curr = segStart;
                while (curr < dsLength && curr <= visEnd) {
                    const isBull = this.values[curr] === 1;
                    const price = this.activeLevels[curr];
                    const lineStart = curr;

                    let lineEnd = curr;
                    while (lineEnd + 1 < dsLength && this.levelChanges[lineEnd + 1] === 0) {
                        lineEnd++;
                    }

                    if (!isNaN(price) && isFinite(price) && price > 0) {
                        const startX = r.getCandleCenterX(lineStart);
                        const nextIdx = lineEnd + 1;
                        // Lock previous line at next bar_index; on last ongoing bar, extend 1 bar forward
                        const endX = nextIdx < dsLength
                            ? r.getCandleCenterX(nextIdx)
                            : (r.getCandleCenterX(lineEnd) + sp);
                        const y = r.priceToY(price);

                        if (isBull) {
                            bullLines.push({ x1: startX, y, x2: endX });
                        } else {
                            bearLines.push({ x1: startX, y, x2: endX });
                        }

                        // Secondary bounds: ceiling during bull, floor during bear
                        if (showBothWicks) {
                            const secPrice = isBull ? this.trackedHighs[curr] : this.trackedLows[curr];
                            if (!isNaN(secPrice) && isFinite(secPrice) && secPrice > 0) {
                                const secY = r.priceToY(secPrice);
                                if (isBull) {
                                    secBullLines.push({ x1: startX, y: secY, x2: endX });
                                } else {
                                    secBearLines.push({ x1: startX, y: secY, x2: endX });
                                }
                            }
                        }
                    }

                    curr = lineEnd + 1;
                }

                // Stroke Bullish Support lines in its own path
                if (bullLines.length > 0) {
                    for (let k = 0; k < bullLines.length; k++) {
                        const seg = bullLines[k];
                        g.moveTo(seg.x1, seg.y).lineTo(seg.x2, seg.y);
                    }
                    g.stroke({ color: bullColor, width: lineWidth, alpha: 1.0 });
                }

                // Stroke Bearish Resistance lines in its own path
                if (bearLines.length > 0) {
                    for (let k = 0; k < bearLines.length; k++) {
                        const seg = bearLines[k];
                        g.moveTo(seg.x1, seg.y).lineTo(seg.x2, seg.y);
                    }
                    g.stroke({ color: bearColor, width: lineWidth, alpha: 1.0 });
                }

                // Stroke secondary bounds with subtle alpha
                if (showBothWicks) {
                    if (secBullLines.length > 0) {
                        for (let k = 0; k < secBullLines.length; k++) {
                            const seg = secBullLines[k];
                            g.moveTo(seg.x1, seg.y).lineTo(seg.x2, seg.y);
                        }
                        g.stroke({ color: bullColor, width: 1, alpha: 0.40 });
                    }
                    if (secBearLines.length > 0) {
                        for (let k = 0; k < secBearLines.length; k++) {
                            const seg = secBearLines[k];
                            g.moveTo(seg.x1, seg.y).lineTo(seg.x2, seg.y);
                        }
                        g.stroke({ color: bearColor, width: 1, alpha: 0.40 });
                    }
                }

            } else {
                // Classic Stepline Mode
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
                            g.lineTo(x, prevY).lineTo(x, y);
                        }

                        g.lineTo(x + halfSp, y);
                        prevY = y;
                    }

                    if (hasPath) {
                        g.stroke({ color, width, alpha });
                    }
                };

                drawStepline((i) => this.trackedLows[i], (i) => this.values[i] === 1, bullColor, lineWidth, 1.0);
                drawStepline((i) => this.trackedHighs[i], (i) => this.values[i] === 0, bearColor, lineWidth, 1.0);

                if (showBothWicks) {
                    drawStepline((i) => this.trackedHighs[i], (i) => this.values[i] === 1, bullColor, 1, 0.40);
                    drawStepline((i) => this.trackedLows[i], (i) => this.values[i] === 0, bearColor, 1, 0.40);
                }
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
