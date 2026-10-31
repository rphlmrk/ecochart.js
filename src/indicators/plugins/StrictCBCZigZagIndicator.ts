import { BaseIndicator, parseColorAndAlpha, parseColor, type IndicatorLayout } from '../Indicator';
import type { DataStore } from '../../data/DataStore';
import type { ChartRenderer } from '../../renderer/ChartRenderer';
import { TimeframeResampler } from '../../data/TimeframeResampler';
import { Graphics } from 'pixi.js';

export interface ConfirmedCBCEvent {
    eventId: string;
    symbol: string;
    timeframe: string;
    pivotBarIndex: number;
    confirmedBarIndex: number;
    pivotPrice: number;
    pivotType: 'high' | 'low';
    pivotLabel: 'HH' | 'LH' | 'HL' | 'LL';
    legDirection: 'up' | 'down';
    confirmationTimeMs: number;
    pivotTimeMs: number;
}

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
 * Lightweight candle interface for the pure state machine
 */
export interface StrictCBCCandle {
    time: number;
    open: number;
    high: number;
    low: number;
    close: number;
}

/**
 * Full internal state required to causally step the Strict CBC state machine
 */
export interface StrictCBCState {
    anchorHigh: number;
    anchorLow: number;
    isBullish: boolean;
    phaseHigh: number;
    phaseHighIdx: number;
    phaseHighTime: number;
    phaseLow: number;
    phaseLowIdx: number;
    phaseLowTime: number;
    lastHighPrice: number | null;
    lastLowPrice: number | null;
    nextPivotId: number;
}

/**
 * Milestone 1: Point-in-Time Teacher Snapshot per candle.
 * Guaranteed zero forward lookahead or historical backfilling.
 */
export interface StrictCBCCandleTeacher {
    barIndex: number;
    timestamp: number;
    trend: 1 | -1;

    anchorHigh: number;
    anchorLow: number;

    candidateType: 'high' | 'low';
    candidatePrice: number;
    candidateBarIndex: number;
    candidateAgeBars: number;

    confirmedPivotEvent: 1 | -1 | 0;
    confirmedPivotId: number;                           // 0 if none
    confirmedPivotPrice: number;                        // 0 if none
    confirmedPivotBarIndex: number;                     // -1 if none
    confirmedPivotConfirmedBarIndex: number;            // -1 if none
    confirmedPivotLabel: 'HH' | 'LH' | 'HL' | 'LL' | 'NONE';
    confirmedPivotLagBars: number;                      // 0 if none
}

/**
 * Factory for initial state on bar 0
 */
export function createInitialStrictCBCState(candle0: StrictCBCCandle): StrictCBCState {
    return {
        anchorHigh: candle0.high,
        anchorLow: candle0.low,
        isBullish: true,
        phaseHigh: candle0.high,
        phaseHighIdx: 0,
        phaseHighTime: candle0.time,
        phaseLow: candle0.low,
        phaseLowIdx: 0,
        phaseLowTime: candle0.time,
        lastHighPrice: null,
        lastLowPrice: null,
        nextPivotId: 1
    };
}

/**
 * Pure Single-Bar Transition Function (Issue 2 Fix):
 * Preserves the exact order of operations:
 * 1. Checks flip condition against existing anchors.
 * 2. Updates phase extreme (allowing flip candle's own extreme to be confirmed).
 * 3. Confirms pivot and resets opposite phase on flip.
 * 4. Advances anchors on continuation or flip.
 * 5. Returns post-transition point-in-time candidate snapshot.
 */
export function stepStrictCBC(
    candle: StrictCBCCandle,
    barIndex: number,
    state: StrictCBCState
): {
    nextState: StrictCBCState;
    teacher: StrictCBCCandleTeacher;
    confirmedPivot: StrictZigZagPivot | null;
} {
    if (barIndex === 0) {
        const initialState = createInitialStrictCBCState(candle);
        return {
            nextState: initialState,
            teacher: {
                barIndex: 0,
                timestamp: candle.time,
                trend: 1,
                anchorHigh: candle.high,
                anchorLow: candle.low,
                candidateType: 'high',
                candidatePrice: candle.high,
                candidateBarIndex: 0,
                candidateAgeBars: 0,
                confirmedPivotEvent: 0,
                confirmedPivotId: 0,
                confirmedPivotPrice: 0,
                confirmedPivotBarIndex: -1,
                confirmedPivotConfirmedBarIndex: -1,
                confirmedPivotLabel: 'NONE',
                confirmedPivotLagBars: 0
            },
            confirmedPivot: null
        };
    }

    const isBuy = candle.close > candle.open;
    const isSell = candle.close < candle.open;

    const bearishFlip = state.isBullish && isSell && (candle.close < state.anchorLow);
    const bullishFlip = !state.isBullish && isBuy && (candle.close > state.anchorHigh);

    let phaseHigh = state.phaseHigh;
    let phaseHighIdx = state.phaseHighIdx;
    let phaseHighTime = state.phaseHighTime;

    let phaseLow = state.phaseLow;
    let phaseLowIdx = state.phaseLowIdx;
    let phaseLowTime = state.phaseLowTime;

    // Preserved sequence: update active extreme prior to processing flip
    if (state.isBullish) {
        if (candle.high > phaseHigh) {
            phaseHigh = candle.high;
            phaseHighIdx = barIndex;
            phaseHighTime = candle.time;
        }
    } else {
        if (candle.low < phaseLow) {
            phaseLow = candle.low;
            phaseLowIdx = barIndex;
            phaseLowTime = candle.time;
        }
    }

    let isBullish = state.isBullish;
    let lastHighPrice = state.lastHighPrice;
    let lastLowPrice = state.lastLowPrice;
    let nextPivotId = state.nextPivotId;

    let confirmedPivot: StrictZigZagPivot | null = null;
    let confirmedPivotEvent: 1 | -1 | 0 = 0;
    let confirmedPivotId = 0;
    let confirmedPivotPrice = 0;
    let confirmedPivotBarIndex = -1;
    let confirmedPivotConfirmedBarIndex = -1;
    let confirmedPivotLabel: 'HH' | 'LH' | 'HL' | 'LL' | 'NONE' = 'NONE';
    let confirmedPivotLagBars = 0;

    if (bearishFlip) {
        isBullish = false;
        const label: 'HH' | 'LH' = (lastHighPrice === null || phaseHigh >= lastHighPrice) ? 'HH' : 'LH';
        lastHighPrice = phaseHigh;

        confirmedPivot = {
            id: nextPivotId++,
            barIndex: phaseHighIdx,
            time: phaseHighTime,
            price: phaseHigh,
            type: 'high',
            label,
            confirmedBarIndex: barIndex
        };

        confirmedPivotEvent = 1;
        confirmedPivotId = confirmedPivot.id;
        confirmedPivotPrice = phaseHigh;
        confirmedPivotBarIndex = phaseHighIdx;
        confirmedPivotConfirmedBarIndex = barIndex;
        confirmedPivotLabel = label;
        confirmedPivotLagBars = barIndex - phaseHighIdx;

        // Post-transition contraction phase begins immediately on this candle's low
        phaseLow = candle.low;
        phaseLowIdx = barIndex;
        phaseLowTime = candle.time;
    } else if (bullishFlip) {
        isBullish = true;
        const label: 'LL' | 'HL' = (lastLowPrice === null || phaseLow <= lastLowPrice) ? 'LL' : 'HL';
        lastLowPrice = phaseLow;

        confirmedPivot = {
            id: nextPivotId++,
            barIndex: phaseLowIdx,
            time: phaseLowTime,
            price: phaseLow,
            type: 'low',
            label,
            confirmedBarIndex: barIndex
        };

        confirmedPivotEvent = -1;
        confirmedPivotId = confirmedPivot.id;
        confirmedPivotPrice = phaseLow;
        confirmedPivotBarIndex = phaseLowIdx;
        confirmedPivotConfirmedBarIndex = barIndex;
        confirmedPivotLabel = label;
        confirmedPivotLagBars = barIndex - phaseLowIdx;

        // Post-transition expansion phase begins immediately on this candle's high
        phaseHigh = candle.high;
        phaseHighIdx = barIndex;
        phaseHighTime = candle.time;
    }

    let anchorHigh = state.anchorHigh;
    let anchorLow = state.anchorLow;
    const validContinuation = (isBullish && candle.close > anchorHigh) || (!isBullish && candle.close < anchorLow);
    if (validContinuation || bearishFlip || bullishFlip) {
        anchorHigh = candle.high;
        anchorLow = candle.low;
    }

    const candidateType: 'high' | 'low' = isBullish ? 'high' : 'low';
    const candidatePrice = isBullish ? phaseHigh : phaseLow;
    const candidateBarIndex = isBullish ? phaseHighIdx : phaseLowIdx;
    const candidateAgeBars = barIndex - candidateBarIndex;

    const nextState: StrictCBCState = {
        anchorHigh,
        anchorLow,
        isBullish,
        phaseHigh,
        phaseHighIdx,
        phaseHighTime,
        phaseLow,
        phaseLowIdx,
        phaseLowTime,
        lastHighPrice,
        lastLowPrice,
        nextPivotId
    };

    const teacher: StrictCBCCandleTeacher = {
        barIndex,
        timestamp: candle.time,
        trend: isBullish ? 1 : -1,
        anchorHigh,
        anchorLow,
        candidateType,
        candidatePrice,
        candidateBarIndex,
        candidateAgeBars,
        confirmedPivotEvent,
        confirmedPivotId,
        confirmedPivotPrice,
        confirmedPivotBarIndex,
        confirmedPivotConfirmedBarIndex,
        confirmedPivotLabel,
        confirmedPivotLagBars
    };

    return { nextState, teacher, confirmedPivot };
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

    // Milestone 1: Point-in-Time Causal Candidate & Anchor Tracking (Zero Backfill)
    public candidateTypes: Int8Array = new Int8Array(20000);       // 1 = High, -1 = Low
    public candidatePrices: Float64Array = new Float64Array(20000);
    public candidateBarIndices: Int32Array = new Int32Array(20000);
    public candidateAges: Int32Array = new Int32Array(20000);
    public anchorHighs: Float64Array = new Float64Array(20000);
    public anchorLows: Float64Array = new Float64Array(20000);
    public confirmedEvents: Int8Array = new Int8Array(20000);      // 1 = High, -1 = Low, 0 = None
    public confirmedPrices: Float64Array = new Float64Array(20000);
    public confirmedLags: Int32Array = new Int32Array(20000);

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

    /**
     * Issue 3 Fix: Unified telemetry array resizer called by both calculate() and update().
     * Guarantees 50,000+ candle buffers never suffer out-of-bounds silent truncation.
     */
    private ensureTelemetryCapacity(requiredLength: number): void {
        if (requiredLength <= this.pivotTypes.length) return;

        const cap = Math.max(requiredLength * 2, 20000);
        const resize = <T extends ArrayBufferView>(arr: any, TypedArray: new (len: number) => T): T => {
            const next = new TypedArray(cap);
            (next as any).set(arr);
            return next;
        };

        this.pivotTypes = resize(this.pivotTypes, Int8Array);
        this.pivotPrices = resize(this.pivotPrices, Float64Array);
        this.trends = resize(this.trends, Int8Array);
        this.candidateTypes = resize(this.candidateTypes, Int8Array);
        this.candidatePrices = resize(this.candidatePrices, Float64Array);
        this.candidateBarIndices = resize(this.candidateBarIndices, Int32Array);
        this.candidateAges = resize(this.candidateAges, Int32Array);
        this.anchorHighs = resize(this.anchorHighs, Float64Array);
        this.anchorLows = resize(this.anchorLows, Float64Array);
        this.confirmedEvents = resize(this.confirmedEvents, Int8Array);
        this.confirmedPrices = resize(this.confirmedPrices, Float64Array);
        this.confirmedLags = resize(this.confirmedLags, Int32Array);
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
        this.candidateTypes.fill(0);
        this.candidatePrices.fill(0);
        this.candidateBarIndices.fill(0);
        this.candidateAges.fill(0);
        this.anchorHighs.fill(0);
        this.anchorLows.fill(0);
        this.confirmedEvents.fill(0);
        this.confirmedPrices.fill(0);
        this.confirmedLags.fill(0);
        super.reset();
    }

    public calculate(ds: DataStore): void {
        this.ensureTelemetryCapacity(ds.length);
        this.buildCachedPivots(ds, false); // Historical reconstruction: NO live alert events emitted
    }

    public override update(ds: DataStore, isClosedTick: boolean): void {
        this.ensureTelemetryCapacity(ds.length);
        this.buildCachedPivots(ds, isClosedTick);
        super.update(ds, isClosedTick);
    }

    private emitMLR1Event(pivot: StrictZigZagPivot, isClosedTick: boolean, confirmationTimeMs: number): void {
        // 🛑 STRICT RULE 1: Never emit events from unclosed intra-bar ghost pivots
        if (!isClosedTick) return;

        const sym = this.currentSymbol || 'BTCUSDT';
        const tf = this.getParam<string>('timeframe', 'Current');
        const indVersion = 'v1';
        
        // 🛑 STRICT RULE 2: Idempotent Event Identity (No duplicates ever)
        const eventId = `MLR1_${sym}_${tf}_${indVersion}_${confirmationTimeMs}_${pivot.time}_${pivot.type}`;

        if (this.notifiedPivots.has(eventId)) return;

        this.notifiedPivots.add(eventId);
        if (this.notifiedPivots.size > 200) {
            const firstKey = this.notifiedPivots.values().next().value;
            if (firstKey) this.notifiedPivots.delete(firstKey);
        }

        const isHigh = pivot.type === 'high';
        
        // 1. Standard UI Alert
        window.dispatchEvent(new CustomEvent('ecochart-alert', {
            detail: {
                id: this.id,
                title: `${isHigh ? 'Swing High' : 'Swing Low'} Confirmed [${pivot.label}]`,
                message: `${sym}: Confirmed ${pivot.label} at $${pivot.price.toFixed(2)}`
            }
        }));

        // 2. Immutable ML-R1 Event Dispatch
        const mlEvent: ConfirmedCBCEvent = {
            eventId: eventId,
            symbol: sym,
            timeframe: tf,
            pivotBarIndex: pivot.barIndex,
            confirmedBarIndex: pivot.confirmedBarIndex,
            pivotPrice: pivot.price,
            pivotType: pivot.type,
            pivotLabel: pivot.label,
            legDirection: isHigh ? 'down' : 'up', // If High confirmed, developing leg is now down
            confirmationTimeMs: confirmationTimeMs,
            pivotTimeMs: pivot.time
        };

        window.dispatchEvent(new CustomEvent('ecochart-ml-r1-event', {
            detail: mlEvent
        }));
    }

    /**
     * Builds and caches Strict CBC ZigZag Pivots and Legs
     */
    private buildCachedPivots(ds: DataStore, isClosedTick: boolean = false): void {
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
        const firstT = ds.data[0];             // Detects historical prepends/origin shifts
        const lastT = ds.data[baseLast];        // Detects timestamp advances
        const lastO = ds.data[baseLast + 1];    // Detects open-price revisions
        const lastH = ds.data[baseLast + 2];
        const lastL = ds.data[baseLast + 3];
        const lastC = ds.data[baseLast + 4];

        // Comprehensive Cache Identity: includes origin, timing, OHLC, and close state
        const stateHash = `${tfMs}:${isHTF}:${len}:${firstT}:${lastT}:${lastO}:${lastH}:${lastL}:${lastC}:closed=${isClosedTick ? 1 : 0}`;
        if (this.lastStateHash === stateHash && this.lastCalculatedLength === len) {
            return;
        }

        this.pivotTypes.fill(0);
        this.pivotPrices.fill(0);
        this.trends.fill(0);

        // =========================================================================
        // MODE 1: Native Chart Timeframe (Uses Pure stepStrictCBC)
        // =========================================================================
        if (!isHTF) {
            const data = ds.data;
            const pivots: StrictZigZagPivot[] = [];

            const candle0: StrictCBCCandle = {
                time: data[0],
                open: data[1],
                high: data[2],
                low: data[3],
                close: data[4]
            };
            let state = createInitialStrictCBCState(candle0);

            for (let i = 0; i < len; i++) {
                const base = i * 6;
                const candle: StrictCBCCandle = {
                    time: data[base],
                    open: data[base + 1],
                    high: data[base + 2],
                    low: data[base + 3],
                    close: data[base + 4]
                };

                // Issue 2 Fix: Call the single shared transition step
                const stepResult = stepStrictCBC(candle, i, state);
                state = stepResult.nextState;

                const teacher = stepResult.teacher;
                const confirmedPivot = stepResult.confirmedPivot;

                // Sync Class Telemetry Arrays
                this.trends[i] = teacher.trend;
                this.anchorHighs[i] = teacher.anchorHigh;
                this.anchorLows[i] = teacher.anchorLow;
                this.candidateTypes[i] = teacher.candidateType === 'high' ? 1 : -1;
                this.candidatePrices[i] = teacher.candidatePrice;
                this.candidateBarIndices[i] = teacher.candidateBarIndex;
                this.candidateAges[i] = teacher.candidateAgeBars;
                this.confirmedEvents[i] = teacher.confirmedPivotEvent;
                this.confirmedPrices[i] = teacher.confirmedPivotPrice;
                this.confirmedLags[i] = teacher.confirmedPivotLagBars;

                if (confirmedPivot) {
                    pivots.push(confirmedPivot);
                    this.pivotTypes[confirmedPivot.barIndex] = confirmedPivot.type === 'high' ? 1 : -1;
                    this.pivotPrices[confirmedPivot.barIndex] = confirmedPivot.price;

                    // Issue 1 Fix: Fire event on latest bar only if officially confirmed closed
                    if (i >= len - 2) {
                        this.emitMLR1Event(confirmedPivot, isClosedTick, candle.time);
                    }
                }
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
            this.activePivot = state.isBullish
                ? { barIndex: state.phaseHighIdx, price: state.phaseHigh, type: 'high' }
                : { barIndex: state.phaseLowIdx, price: state.phaseLow, type: 'low' };

            this.lastCalculatedLength = len;
            this.lastStateHash = stateHash;
            return;
        }

        // =========================================================================
        // MODE 2: Higher Timeframe (Issue 4 Scope Boundary)
        // Note: Milestone 1 Teacher telemetry is frozen as Native-Timeframe only.
        // Teacher arrays are safely zeroed out when HTF mode is active.
        // =========================================================================
        this.candidateTypes.fill(0);
        this.candidatePrices.fill(0);
        this.candidateBarIndices.fill(0);
        this.candidateAges.fill(0);
        this.anchorHighs.fill(0);
        this.anchorLows.fill(0);
        this.confirmedEvents.fill(0);
        this.confirmedPrices.fill(0);
        this.confirmedLags.fill(0);

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

                if (b >= htfLen - 2) {
                    this.emitMLR1Event(highPivot, isClosedTick, data[bar.lastChartBar * 6]);
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

                if (b >= htfLen - 2) {
                    this.emitMLR1Event(lowPivot, isClosedTick, data[bar.lastChartBar * 6]);
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

    /**
     * Milestone 1 Headless Teacher Engine (Issue 2 Fix):
     * Directly delegates every candle to stepStrictCBC().
     * Produces identical pivot IDs, bar indices, confirmation indices, and teacher snapshots.
     */
    public static extractPointInTimeTeacher(ds: { data: Float64Array; length: number }): {
        teachers: StrictCBCCandleTeacher[];
        pivots: StrictZigZagPivot[];
    } {
        const len = ds.length;
        const data = ds.data;
        const teachers: StrictCBCCandleTeacher[] = new Array(len);
        const pivots: StrictZigZagPivot[] = [];

        if (len === 0) return { teachers, pivots };

        const candle0: StrictCBCCandle = {
            time: data[0],
            open: data[1],
            high: data[2],
            low: data[3],
            close: data[4]
        };
        let state = createInitialStrictCBCState(candle0);

        for (let i = 0; i < len; i++) {
            const base = i * 6;
            const candle: StrictCBCCandle = {
                time: data[base],
                open: data[base + 1],
                high: data[base + 2],
                low: data[base + 3],
                close: data[base + 4]
            };

            const stepResult = stepStrictCBC(candle, i, state);
            state = stepResult.nextState;

            teachers[i] = stepResult.teacher;
            if (stepResult.confirmedPivot) {
                pivots.push(stepResult.confirmedPivot);
            }
        }

        return { teachers, pivots };
    }
}