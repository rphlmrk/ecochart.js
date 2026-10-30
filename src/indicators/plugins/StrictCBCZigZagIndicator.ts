import { BaseIndicator, parseColorAndAlpha, parseColor, type IndicatorLayout } from '../Indicator';
import type { DataStore } from '../../data/DataStore';
import type { ChartRenderer } from '../../renderer/ChartRenderer';
import { TimeframeResampler } from '../../data/TimeframeResampler';
import { Graphics } from 'pixi.js';

export interface StrictZigZagPivot {
    id: number;
    barIndex: number;
    time: number;
    price: number;
    type: 'high' | 'low';
    label: 'HH' | 'LH' | 'HL' | 'LL';
    confirmedBarIndex: number;
}

export interface StrictZigZagLeg {
    from: StrictZigZagPivot;
    to: StrictZigZagPivot;
    direction: 'up' | 'down';
}

/**
 * Strict CBC ZigZag Indicator
 * 
 * High-performance, hardware-accelerated structural ZigZag:
 * - Swing High confirmed when a Bearish CBC Flip triggers (close < anchorLow)
 * - Swing Low confirmed when a Bullish CBC Flip triggers (close > anchorHigh)
 * - Automatic Market Structure classification (HH, LH, HL, LL)
 * - Multi-Timeframe Projection (Native Chart TF or Resampled HTF)
 * - Real-time active developing leg (showing the current unconfirmed swing)
 * - High-speed batched PixiJS GPU rendering with viewport culling
 * - Real-time breakout and swing alert integration
 */
export class StrictCBCZigZagIndicator extends BaseIndicator {
    // Cached pivot structures to eliminate render-loop CPU overhead
    public cachedPivots: StrictZigZagPivot[] = [];
    public cachedLegs: StrictZigZagLeg[] = [];
    public activePivot: { barIndex: number; price: number; type: 'high' | 'low' } | null = null;
    public currentSymbol = 'BTCUSDT';

    private notifiedPivots = new Set<string>();

    // Eco-mode cache invalidation state
    private lastCalculatedLength = -1;
    private lastStateHash = '';

    // Per-bar telemetry buffers for zero-allocation crosshair inspection
    public pivotTypes: Int8Array = new Int8Array(20000);  // 1 = High, -1 = Low, 0 = None
    public pivotPrices: Float64Array = new Float64Array(20000);
    public trends: Int8Array = new Int8Array(20000);       // 1 = Bullish Push, -1 = Bearish Pullback

    constructor() {
        super('STRICT_CBC_ZIGZAG', 'Strict CBC ZigZag');
        this.isOscillator = false;
        this.layerType = 'main';

        this.params = [
            // Timeframe selection
            {
                id: 'timeframe',
                name: 'Timeframe',
                type: 'select',
                value: 'Current',
                options: ['Current', '1m', '3m', '5m', '15m', '30m', '45m', '1h', '2h', '3h', '4h', '6h', '8h', '12h', '1d', '3d', '1w', 'Custom HTF']
            },
            { id: 'customTfMins', name: 'Custom HTF Minutes', type: 'number', value: 60, min: 1, max: 43200, step: 1 },

            // ZigZag Leg Styling
            { id: 'upLegColor', name: 'Up Leg Color', type: 'color', value: '#26A69A' },
            { id: 'downLegColor', name: 'Down Leg Color', type: 'color', value: '#EF5350' },
            { id: 'lineWidth', name: 'Line Thickness', type: 'number', value: 2, min: 1, max: 6, step: 0.5 },
            { id: 'showActiveLeg', name: 'Show Developing Leg', type: 'boolean', value: true },

            // Pivot Markers Styling
            { id: 'showPivots', name: 'Show Pivot Markers', type: 'boolean', value: true },
            { id: 'pivotRadius', name: 'Pivot Dot Radius', type: 'number', value: 3.5, min: 1, max: 10, step: 0.5 },
            { id: 'highColor', name: 'High Pivot Color', type: 'color', value: '#EF5350' },
            { id: 'lowColor', name: 'Low Pivot Color', type: 'color', value: '#26A69A' }
        ];
    }

    public static getTimeframeOptions(currentInterval: string): string[] {
        const ALL = ['1m', '3m', '5m', '15m', '30m', '45m', '1h', '2h', '3h', '4h', '6h', '8h', '12h', '1d', '3d', '1w'];
        const currentMs = TimeframeResampler.parseMs(currentInterval);
        const filtered = ALL.filter(tf => TimeframeResampler.parseMs(tf) > currentMs);
        return ['Current', ...filtered, 'Custom HTF'];
    }

    public getTimeframeOptions(currentInterval: string): string[] {
        return StrictCBCZigZagIndicator.getTimeframeOptions(currentInterval);
    }

    public getEffectiveTfMs(chartTfMs: number): number {
        const mode = this.getParam<string>('timeframe', 'Current');
        if (mode === 'Current') return chartTfMs;
        if (mode === 'Custom' || mode === 'Custom HTF') {
            const mins = Math.max(1, this.getParam<number>('customTfMins', 60));
            return Math.max(mins * 60 * 1000, chartTfMs);
        }
        const parsedMs = TimeframeResampler.parseMs(mode.toLowerCase());
        return parsedMs <= chartTfMs ? chartTfMs : parsedMs;
    }

    protected override onParamsUpdated(): void {
        this.lastCalculatedLength = -1;
        this.lastStateHash = '';
        this.cachedPivots = [];
        this.cachedLegs = [];
        this.activePivot = null;
        const tf = this.getParam<string>('timeframe', 'Current');
        this.name = tf === 'Current' ? 'Strict CBC ZigZag' : `Strict CBC ZigZag [${tf}]`;
    }

    public override reset(): void {
        this.cachedPivots = [];
        this.cachedLegs = [];
        this.activePivot = null;
        this.lastCalculatedLength = -1;
        this.lastStateHash = '';
        this.pivotTypes.fill(0);
        this.pivotPrices.fill(0);
        this.trends.fill(0);
        super.reset();
    }

    public calculate(ds: DataStore): void {
        this.buildCachedPivots(ds);
    }

    public override update(ds: DataStore, isClosedTick: boolean): void {
        if (ds.length > this.pivotTypes.length) {
            const cap = Math.max(ds.length * 2, 20000);
            const newTypes = new Int8Array(cap);
            newTypes.set(this.pivotTypes);
            this.pivotTypes = newTypes;

            const newPrices = new Float64Array(cap);
            newPrices.set(this.pivotPrices);
            this.pivotPrices = newPrices;

            const newTrends = new Int8Array(cap);
            newTrends.set(this.trends);
            this.trends = newTrends;
        }

        this.buildCachedPivots(ds);
        super.update(ds, isClosedTick);
    }

    private dispatchPivotAlert(pivot: StrictZigZagPivot): void {
        const sym = this.currentSymbol || 'BTCUSDT';
        const key = `${sym}_${pivot.type}_${pivot.barIndex}_${pivot.price}`;
        if (this.notifiedPivots.has(key)) return;

        this.notifiedPivots.add(key);
        if (this.notifiedPivots.size > 200) {
            const firstKey = this.notifiedPivots.values().next().value;
            if (firstKey) this.notifiedPivots.delete(firstKey);
        }

        const isHigh = pivot.type === 'high';
        window.dispatchEvent(new CustomEvent('ecochart-alert', {
            detail: {
                id: this.id,
                title: `${isHigh ? 'Swing High' : 'Swing Low'} Confirmed [${pivot.label}]`,
                message: `${sym}: Confirmed ${pivot.label} at $${pivot.price.toFixed(2)}`
            }
        }));

        // alertManager.triggerPriceTouch(sym, pivot.price, isHigh ? 'above' : 'below');
    }

    /**
     * Builds and caches Strict CBC ZigZag Pivots and Legs
     */
    private buildCachedPivots(ds: DataStore): void {
        const len = ds.length;
        if (len === 0) {
            this.cachedPivots = [];
            this.cachedLegs = [];
            this.activePivot = null;
            this.lastCalculatedLength = 0;
            this.lastStateHash = '';
            return;
        }

        const chartTfMs = (ds.length >= 2 && ds.data[6] > ds.data[0]) ? (ds.data[6] - ds.data[0]) : 60000;
        const tfMs = this.getEffectiveTfMs(chartTfMs);
        const isHTF = tfMs > chartTfMs;

        const lastIdx = len - 1;
        const baseLast = lastIdx * 6;
        const lastH = ds.data[baseLast + 2];
        const lastL = ds.data[baseLast + 3];
        const lastC = ds.data[baseLast + 4];

        const stateHash = `${tfMs}:${isHTF}:${len}:${lastH}:${lastL}:${lastC}`;
        if (this.lastStateHash === stateHash && this.lastCalculatedLength === len) {
            return;
        }

        this.pivotTypes.fill(0);
        this.pivotPrices.fill(0);
        this.trends.fill(0);

        // =========================================================================
        // MODE 1: Native Chart Timeframe
        // =========================================================================
        if (!isHTF) {
            const data = ds.data;
            const pivots: StrictZigZagPivot[] = [];
            let nextPivotId = 1;

            let anchorHigh = data[2];
            let anchorLow = data[3];
            let isBullish = true;

            let phaseHigh = data[2];
            let phaseHighIdx = 0;
            let phaseLow = data[3];
            let phaseLowIdx = 0;

            let lastHighPrice: number | null = null;
            let lastLowPrice: number | null = null;

            for (let i = 0; i < len; i++) {
                const base = i * 6;
                const o = data[base + 1];
                const h = data[base + 2];
                const l = data[base + 3];
                const c = data[base + 4];

                const isBuy = c > o;
                const isSell = c < o;

                const bearishFlip = isBullish && isSell && (c < anchorLow);
                const bullishFlip = !isBullish && isBuy && (c > anchorHigh);

                if (isBullish) {
                    if (h > phaseHigh) {
                        phaseHigh = h;
                        phaseHighIdx = i;
                    }
                } else {
                    if (l < phaseLow) {
                        phaseLow = l;
                        phaseLowIdx = i;
                    }
                }

                // Bearish Flip -> Confirms phaseHigh as a Swing High Pivot
                if (bearishFlip) {
                    isBullish = false;

                    const label: 'HH' | 'LH' = (lastHighPrice === null || phaseHigh >= lastHighPrice) ? 'HH' : 'LH';
                    lastHighPrice = phaseHigh;

                    const highPivot: StrictZigZagPivot = {
                        id: nextPivotId++,
                        barIndex: phaseHighIdx,
                        time: data[phaseHighIdx * 6],
                        price: phaseHigh,
                        type: 'high',
                        label,
                        confirmedBarIndex: i
                    };
                    pivots.push(highPivot);
                    this.pivotTypes[phaseHighIdx] = 1;
                    this.pivotPrices[phaseHighIdx] = phaseHigh;

                    phaseLow = l;
                    phaseLowIdx = i;

                    if (i === len - 1) {
                        this.dispatchPivotAlert(highPivot);
                    }
                }

                // Bullish Flip -> Confirms phaseLow as a Swing Low Pivot
                if (bullishFlip) {
                    isBullish = true;

                    const label: 'LL' | 'HL' = (lastLowPrice === null || phaseLow <= lastLowPrice) ? 'LL' : 'HL';
                    lastLowPrice = phaseLow;

                    const lowPivot: StrictZigZagPivot = {
                        id: nextPivotId++,
                        barIndex: phaseLowIdx,
                        time: data[phaseLowIdx * 6],
                        price: phaseLow,
                        type: 'low',
                        label,
                        confirmedBarIndex: i
                    };
                    pivots.push(lowPivot);
                    this.pivotTypes[phaseLowIdx] = -1;
                    this.pivotPrices[phaseLowIdx] = phaseLow;

                    phaseHigh = h;
                    phaseHighIdx = i;

                    if (i === len - 1) {
                        this.dispatchPivotAlert(lowPivot);
                    }
                }

                const validContinuation = (isBullish && c > anchorHigh) || (!isBullish && c < anchorLow);
                if (validContinuation || bearishFlip || bullishFlip) {
                    anchorHigh = h;
                    anchorLow = l;
                }

                this.trends[i] = isBullish ? 1 : -1;
            }

            // Assemble confirmed legs
            const legs: StrictZigZagLeg[] = [];
            for (let k = 1; k < pivots.length; k++) {
                const prev = pivots[k - 1];
                const curr = pivots[k];
                legs.push({
                    from: prev,
                    to: curr,
                    direction: curr.price >= prev.price ? 'up' : 'down'
                });
            }

            this.cachedPivots = pivots;
            this.cachedLegs = legs;
            this.activePivot = isBullish
                ? { barIndex: phaseHighIdx, price: phaseHigh, type: 'high' }
                : { barIndex: phaseLowIdx, price: phaseLow, type: 'low' };

            this.lastCalculatedLength = len;
            this.lastStateHash = stateHash;
            return;
        }

        // =========================================================================
        // MODE 2: Higher Timeframe (HTF Resampled Strict CBC)
        // =========================================================================
        interface HtfBar {
            time: number;
            open: number;
            high: number;
            low: number;
            close: number;
            firstChartBar: number;
            lastChartBar: number;
            peakChartBar: number;
            troughChartBar: number;
        }

        const data = ds.data;
        const htfBars: HtfBar[] = [];
        let currBucketTime = -1;
        let currHtfBar: HtfBar | null = null;

        for (let i = 0; i < len; i++) {
            const base = i * 6;
            const t = data[base];
            const o = data[base + 1];
            const h = data[base + 2];
            const l = data[base + 3];
            const c = data[base + 4];

            const bTime = TimeframeResampler.getBucketStart(t, tfMs);
            if (bTime !== currBucketTime) {
                currBucketTime = bTime;
                currHtfBar = {
                    time: bTime,
                    open: o,
                    high: h,
                    low: l,
                    close: c,
                    firstChartBar: i,
                    lastChartBar: i,
                    peakChartBar: i,
                    troughChartBar: i
                };
                htfBars.push(currHtfBar);
            } else if (currHtfBar) {
                currHtfBar.lastChartBar = i;
                currHtfBar.close = c;
                if (h > currHtfBar.high) {
                    currHtfBar.high = h;
                    currHtfBar.peakChartBar = i;
                }
                if (l < currHtfBar.low) {
                    currHtfBar.low = l;
                    currHtfBar.troughChartBar = i;
                }
            }
        }

        const htfLen = htfBars.length;
        if (htfLen === 0) {
            this.cachedPivots = [];
            this.cachedLegs = [];
            this.activePivot = null;
            this.lastCalculatedLength = len;
            this.lastStateHash = stateHash;
            return;
        }

        const pivots: StrictZigZagPivot[] = [];
        let nextPivotId = 1;

        let anchorHigh = htfBars[0].high;
        let anchorLow = htfBars[0].low;
        let isBullish = true;

        let phaseHigh = htfBars[0].high;
        let phaseHighChartIdx = htfBars[0].peakChartBar;
        let phaseLow = htfBars[0].low;
        let phaseLowChartIdx = htfBars[0].troughChartBar;

        let lastHighPrice: number | null = null;
        let lastLowPrice: number | null = null;

        for (let b = 0; b < htfLen; b++) {
            const bar = htfBars[b];
            const o = bar.open;
            const h = bar.high;
            const l = bar.low;
            const c = bar.close;

            const isBuy = c > o;
            const isSell = c < o;

            const bearishFlip = isBullish && isSell && (c < anchorLow);
            const bullishFlip = !isBullish && isBuy && (c > anchorHigh);

            if (isBullish) {
                if (h > phaseHigh) {
                    phaseHigh = h;
                    phaseHighChartIdx = bar.peakChartBar;
                }
            } else {
                if (l < phaseLow) {
                    phaseLow = l;
                    phaseLowChartIdx = bar.troughChartBar;
                }
            }

            if (bearishFlip) {
                isBullish = false;

                const label: 'HH' | 'LH' = (lastHighPrice === null || phaseHigh >= lastHighPrice) ? 'HH' : 'LH';
                lastHighPrice = phaseHigh;

                const highPivot: StrictZigZagPivot = {
                    id: nextPivotId++,
                    barIndex: phaseHighChartIdx,
                    time: data[phaseHighChartIdx * 6],
                    price: phaseHigh,
                    type: 'high',
                    label,
                    confirmedBarIndex: bar.lastChartBar
                };
                pivots.push(highPivot);
                this.pivotTypes[phaseHighChartIdx] = 1;
                this.pivotPrices[phaseHighChartIdx] = phaseHigh;

                phaseLow = l;
                phaseLowChartIdx = bar.troughChartBar;

                if (b === htfLen - 1) {
                    this.dispatchPivotAlert(highPivot);
                }
            }

            if (bullishFlip) {
                isBullish = true;

                const label: 'LL' | 'HL' = (lastLowPrice === null || phaseLow <= lastLowPrice) ? 'LL' : 'HL';
                lastLowPrice = phaseLow;

                const lowPivot: StrictZigZagPivot = {
                    id: nextPivotId++,
                    barIndex: phaseLowChartIdx,
                    time: data[phaseLowChartIdx * 6],
                    price: phaseLow,
                    type: 'low',
                    label,
                    confirmedBarIndex: bar.lastChartBar
                };
                pivots.push(lowPivot);
                this.pivotTypes[phaseLowChartIdx] = -1;
                this.pivotPrices[phaseLowChartIdx] = phaseLow;

                phaseHigh = h;
                phaseHighChartIdx = bar.peakChartBar;

                if (b === htfLen - 1) {
                    this.dispatchPivotAlert(lowPivot);
                }
            }

            const validContinuation = (isBullish && c > anchorHigh) || (!isBullish && c < anchorLow);
            if (validContinuation || bearishFlip || bullishFlip) {
                anchorHigh = h;
                anchorLow = l;
            }

            const fBar = bar.firstChartBar;
            const lBar = Math.min(len - 1, bar.lastChartBar);
            for (let k = fBar; k <= lBar; k++) {
                this.trends[k] = isBullish ? 1 : -1;
            }
        }

        const legs: StrictZigZagLeg[] = [];
        for (let k = 1; k < pivots.length; k++) {
            const prev = pivots[k - 1];
            const curr = pivots[k];
            legs.push({
                from: prev,
                to: curr,
                direction: curr.price >= prev.price ? 'up' : 'down'
            });
        }

        this.cachedPivots = pivots;
        this.cachedLegs = legs;
        this.activePivot = isBullish
            ? { barIndex: phaseHighChartIdx, price: phaseHigh, type: 'high' }
            : { barIndex: phaseLowChartIdx, price: phaseLow, type: 'low' };

        this.lastCalculatedLength = len;
        this.lastStateHash = stateHash;
    }

    /**
     * Hardware-accelerated GPU Rendering
     * Batched draw calls for lines, active developing swing, and pivot dots.
     */
    public render(r: ChartRenderer, layout: IndicatorLayout, g: Graphics): void {
        if (!this.visible || r.dataStore.length === 0) return;

        if (this.cachedPivots.length === 0 || this.lastCalculatedLength !== r.dataStore.length) {
            this.buildCachedPivots(r.dataStore);
        }

        const pivots = this.cachedPivots;
        const legs = this.cachedLegs;
        if (pivots.length === 0) return;

        const lineWidth = Math.max(1, this.getParam<number>('lineWidth', 2));
        const upLegColor = parseColorAndAlpha(this.getParam<string>('upLegColor', '#26A69A'), 1.0);
        const downLegColor = parseColorAndAlpha(this.getParam<string>('downLegColor', '#EF5350'), 1.0);

        const showPivots = this.getParam<boolean>('showPivots', true);
        const pivotRadius = Math.max(1.5, this.getParam<number>('pivotRadius', 3.5));
        const highColor = parseColorAndAlpha(this.getParam<string>('highColor', '#EF5350'), 1.0);
        const lowColor = parseColorAndAlpha(this.getParam<string>('lowColor', '#26A69A'), 1.0);

        const showActiveLeg = this.getParam<boolean>('showActiveLeg', true);
        const screenW = layout.chartWidth;
        const minX = -40;
        const maxX = screenW + 40;

        // --- 1. RENDER CONFIRMED UP LEGS (Single Batch) ---
        g.beginPath();
        let hasUp = false;
        for (let i = 0; i < legs.length; i++) {
            const leg = legs[i];
            if (leg.direction !== 'up') continue;

            const x1 = r.getCandleCenterX(leg.from.barIndex);
            const x2 = r.getCandleCenterX(leg.to.barIndex);
            if (Math.max(x1, x2) < minX || Math.min(x1, x2) > maxX) continue;

            const y1 = r.priceToY(leg.from.price);
            const y2 = r.priceToY(leg.to.price);

            g.moveTo(x1, y1).lineTo(x2, y2);
            hasUp = true;
        }
        if (hasUp) {
            g.stroke({ color: upLegColor.color, width: lineWidth, alpha: upLegColor.alpha });
        }

        // --- 2. RENDER CONFIRMED DOWN LEGS (Single Batch) ---
        g.beginPath();
        let hasDown = false;
        for (let i = 0; i < legs.length; i++) {
            const leg = legs[i];
            if (leg.direction !== 'down') continue;

            const x1 = r.getCandleCenterX(leg.from.barIndex);
            const x2 = r.getCandleCenterX(leg.to.barIndex);
            if (Math.max(x1, x2) < minX || Math.min(x1, x2) > maxX) continue;

            const y1 = r.priceToY(leg.from.price);
            const y2 = r.priceToY(leg.to.price);

            g.moveTo(x1, y1).lineTo(x2, y2);
            hasDown = true;
        }
        if (hasDown) {
            g.stroke({ color: downLegColor.color, width: lineWidth, alpha: downLegColor.alpha });
        }

        // --- 3. RENDER ACTIVE UNCONFIRMED DEVELOPING LEG ---
        if (showActiveLeg && this.activePivot && pivots.length > 0) {
            const lastPivot = pivots[pivots.length - 1];
            const x1 = r.getCandleCenterX(lastPivot.barIndex);
            const y1 = r.priceToY(lastPivot.price);

            const x2 = r.getCandleCenterX(this.activePivot.barIndex);
            const y2 = r.priceToY(this.activePivot.price);

            if (!(Math.max(x1, x2) < minX || Math.min(x1, x2) > maxX)) {
                const isUp = this.activePivot.price >= lastPivot.price;
                const activeColor = isUp ? upLegColor : downLegColor;

                g.beginPath();
                g.moveTo(x1, y1).lineTo(x2, y2);
                g.stroke({
                    color: activeColor.color,
                    width: Math.max(1, lineWidth - 0.5),
                    alpha: 0.65
                });
            }
        }

        // --- 4. RENDER PIVOT DOTS & RINGS ---
        if (showPivots) {
            // High Pivot Markers (Red)
            g.beginPath();
            let hasHighDots = false;
            for (let i = 0; i < pivots.length; i++) {
                const p = pivots[i];
                if (p.type !== 'high') continue;
                const px = r.getCandleCenterX(p.barIndex);
                if (px < minX || px > maxX) continue;
                const py = r.priceToY(p.price);

                g.circle(px, py, pivotRadius);
                hasHighDots = true;
            }
            if (hasHighDots) {
                g.fill({ color: highColor.color, alpha: highColor.alpha });
                g.stroke({ color: 0xffffff, width: 1, alpha: 0.85 });
            }

            // Low Pivot Markers (Green)
            g.beginPath();
            let hasLowDots = false;
            for (let i = 0; i < pivots.length; i++) {
                const p = pivots[i];
                if (p.type !== 'low') continue;
                const px = r.getCandleCenterX(p.barIndex);
                if (px < minX || px > maxX) continue;
                const py = r.priceToY(p.price);

                g.circle(px, py, pivotRadius);
                hasLowDots = true;
            }
            if (hasLowDots) {
                g.fill({ color: lowColor.color, alpha: lowColor.alpha });
                g.stroke({ color: 0xffffff, width: 1, alpha: 0.85 });
            }
        }
    }

    /**
     * Crosshair Telemetry Inspector: Reports market swing state, latest pivot, and HH/HL structure.
     */
    public override getValueAt(idx: number, ds: DataStore, _isDark: boolean, defaultTextClr: number) {
        if (idx < 0 || idx >= ds.length) {
            return { label: this.name, valueStr: '—', valueColor: defaultTextClr };
        }

        const pType = this.pivotTypes[idx];
        const pPrice = this.pivotPrices[idx];
        const trend = this.trends[idx];

        const upClr = parseColor(this.getParam('upLegColor', '#26A69A'));
        const downClr = parseColor(this.getParam('downLegColor', '#EF5350'));

        const fmt = (p: number) => {
            if (isNaN(p) || !isFinite(p) || p === 0) return '—';
            return p >= 10 ? p.toFixed(2) : p.toPrecision(5);
        };

        let valueStr = '';
        let valueColor = defaultTextClr;

        if (pType === 1) {
            valueStr = `Swing High Pivot: $${fmt(pPrice)}`;
            valueColor = downClr;
        } else if (pType === -1) {
            valueStr = `Swing Low Pivot: $${fmt(pPrice)}`;
            valueColor = upClr;
        } else if (trend === 1) {
            valueStr = `Bullish Leg ↗ (Latest H: $${fmt(this.activePivot?.price || 0)})`;
            valueColor = upClr;
        } else if (trend === -1) {
            valueStr = `Bearish Leg ↘ (Latest L: $${fmt(this.activePivot?.price || 0)})`;
            valueColor = downClr;
        } else {
            valueStr = `Active Pivots: ${this.cachedPivots.length}`;
        }

        return {
            label: this.name,
            valueStr,
            valueColor
        };
    }

    public destroy(): void {
        this.cachedPivots = [];
        this.cachedLegs = [];
        this.activePivot = null;
    }
}