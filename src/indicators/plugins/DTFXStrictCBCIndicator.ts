import { BaseIndicator, parseColorAndAlpha, parseColor, type IndicatorLayout } from '../Indicator';
import type { DataStore } from '../../data/DataStore';
import type { ChartRenderer } from '../../renderer/ChartRenderer';
import { TimeframeResampler } from '../../data/TimeframeResampler';
import { stepStrictCBCWithReset } from '../mlr1/teachers/StrategyEventTypes';
import {
    type StrictCBCCandle,
    type StrictCBCState,
    type StrictZigZagPivot
} from './StrictCBCZigZagIndicator';
import { Graphics } from 'pixi.js';

export type DTFXStrictCBCLineStyle = '___' | '- - -' | '. . .';

export interface DTFXStrictCBCFibLine {
    slot: 1 | 2 | 3 | 4 | 5;
    enabled: boolean;
    price: number;
    style: DTFXStrictCBCLineStyle;
    color: string;
}

export interface DTFXStrictCBCZone {
    id: number;
    direction: 1 | -1; // 1 = Bullish, -1 = Bearish
    leftBar: number;
    rightBar: number;
    top: number;
    bottom: number;
    fibStartBar: number;
    fibEndBar: number;
    fibs: DTFXStrictCBCFibLine[];
}

interface PivotBound {
    price: number;
    bar: number;
}

interface FibSlotConfig {
    slot: 1 | 2 | 3 | 4 | 5;
    enabled: boolean;
    level: number;
    style: DTFXStrictCBCLineStyle;
    bullColor: string;
    bearColor: string;
}

/**
 * DTFX Algo Zones (StrictCBC Pivot Engine)
 *
 * Ports LuxAlgo's DTFX Algo Zones to the EcoChart engine using
 * StrictCBCZigZagIndicator's causal Strict CBC state machine for swing pivots:
 * - Swing Highs confirmed on Bearish CBC Flips (close < anchorLow)
 * - Swing Lows confirmed on Bullish CBC Flips (close > anchorHigh)
 * - BOS / CHoCH -> Market Structure Shift (MSS) Zone creation
 * - 5 configurable Fib levels with solid/dashed/dotted styles & clean overlap trimming
 * - Native & Higher Timeframe (HTF) support + batched PixiJS GPU rendering
 */
export class DTFXStrictCBCIndicator extends BaseIndicator {
    public cachedPivots: StrictZigZagPivot[] = [];
    public cachedZones: DTFXStrictCBCZone[] = [];

    private lastCalculatedLength = -1;
    private lastStateHash = '';

    // Per-bar telemetry buffers for crosshair inspection
    public pivotTypes: Int8Array = new Int8Array(20000);  // 1 = High, -1 = Low, 0 = None
    public pivotPrices: Float64Array = new Float64Array(20000);
    public trends: Int8Array = new Int8Array(20000);       // 1 = Bullish MSS, -1 = Bearish MSS, 0 = Neutral

    constructor() {
        super('DTFX_STRICTCBC_ZONES', 'DTFX Algo Zones (StrictCBC)');
        this.isOscillator = false;
        this.layerType = 'main';

        this.params = [
            // Timeframe (Strict CBC pivot resolution)
            {
                id: 'timeframe',
                name: 'Timeframe',
                type: 'select',
                value: 'Current',
                options: ['Current', '1m', '3m', '5m', '15m', '30m', '45m', '1h', '2h', '3h', '4h', '6h', '8h', '12h', '1d', '3d', '1w', 'Custom HTF']
            },
            { id: 'customTfMins', name: 'Custom HTF Minutes', type: 'number', value: 60, min: 1, max: 43200, step: 1 },

            // Structure / Swing Points
            { id: 'showPivots', name: 'Show Swing Points', type: 'boolean', value: true },
            { id: 'pivotRadius', name: 'Swing Dot Radius', type: 'number', value: 3.5, min: 1, max: 10, step: 0.5 },
            { id: 'structureColor', name: 'Swing Point Color', type: 'color', value: '#787B86' },

            // Zones
            { id: 'zoneDispNum', name: 'Show Last', type: 'number', value: 1, min: 0, max: 200, step: 1 },
            { id: 'dispAll', name: 'Display All Zones', type: 'boolean', value: true },
            {
                id: 'zoneFilter',
                name: 'Zone Display',
                type: 'select',
                value: 'Both',
                options: ['Bullish Only', 'Bearish Only', 'Both']
            },
            { id: 'noOverlap', name: 'Clean-Up Level Overlap', type: 'boolean', value: true },
            { id: 'bullZoneColor', name: 'Bullish Zone Color', type: 'color', value: '#089981' },
            { id: 'bearZoneColor', name: 'Bearish Zone Color', type: 'color', value: '#F23645' },
            { id: 'zoneAlpha', name: 'Zone Fill Opacity', type: 'number', value: 0.2, min: 0.05, max: 1.0, step: 0.05 },
            { id: 'fibLineWidth', name: 'Fib Line Thickness', type: 'number', value: 1, min: 1, max: 4, step: 0.5 },

            // Fib 1
            { id: 'f1Tog', name: 'Fib 1 Enabled', type: 'boolean', value: false },
            { id: 'f1Lvl', name: 'Fib 1 Level', type: 'number', value: 0, min: -5, max: 5, step: 0.05 },
            { id: 'f1Style', name: 'Fib 1 Style', type: 'select', value: '. . .', options: ['___', '- - -', '. . .'] },
            { id: 'f1BullColor', name: 'Fib 1 Bull Color', type: 'color', value: '#089981' },
            { id: 'f1BearColor', name: 'Fib 1 Bear Color', type: 'color', value: '#F23645' },

            // Fib 2
            { id: 'f2Tog', name: 'Fib 2 Enabled', type: 'boolean', value: true },
            { id: 'f2Lvl', name: 'Fib 2 Level', type: 'number', value: 0.3, min: -5, max: 5, step: 0.05 },
            { id: 'f2Style', name: 'Fib 2 Style', type: 'select', value: '- - -', options: ['___', '- - -', '. . .'] },
            { id: 'f2BullColor', name: 'Fib 2 Bull Color', type: 'color', value: '#089981' },
            { id: 'f2BearColor', name: 'Fib 2 Bear Color', type: 'color', value: '#F23645' },

            // Fib 3
            { id: 'f3Tog', name: 'Fib 3 Enabled', type: 'boolean', value: true },
            { id: 'f3Lvl', name: 'Fib 3 Level', type: 'number', value: 0.5, min: -5, max: 5, step: 0.05 },
            { id: 'f3Style', name: 'Fib 3 Style', type: 'select', value: '___', options: ['___', '- - -', '. . .'] },
            { id: 'f3BullColor', name: 'Fib 3 Bull Color', type: 'color', value: '#089981' },
            { id: 'f3BearColor', name: 'Fib 3 Bear Color', type: 'color', value: '#F23645' },

            // Fib 4
            { id: 'f4Tog', name: 'Fib 4 Enabled', type: 'boolean', value: true },
            { id: 'f4Lvl', name: 'Fib 4 Level', type: 'number', value: 0.7, min: -5, max: 5, step: 0.05 },
            { id: 'f4Style', name: 'Fib 4 Style', type: 'select', value: '- - -', options: ['___', '- - -', '. . .'] },
            { id: 'f4BullColor', name: 'Fib 4 Bull Color', type: 'color', value: '#089981' },
            { id: 'f4BearColor', name: 'Fib 4 Bear Color', type: 'color', value: '#F23645' },

            // Fib 5
            { id: 'f5Tog', name: 'Fib 5 Enabled', type: 'boolean', value: false },
            { id: 'f5Lvl', name: 'Fib 5 Level', type: 'number', value: 1, min: -5, max: 5, step: 0.05 },
            { id: 'f5Style', name: 'Fib 5 Style', type: 'select', value: '. . .', options: ['___', '- - -', '. . .'] },
            { id: 'f5BullColor', name: 'Fib 5 Bull Color', type: 'color', value: '#089981' },
            { id: 'f5BearColor', name: 'Fib 5 Bear Color', type: 'color', value: '#F23645' }
        ];
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
        this.cachedZones = [];
        const tf = this.getParam<string>('timeframe', 'Current');
        this.name = tf === 'Current' ? 'DTFX Algo Zones (StrictCBC)' : `DTFX Algo Zones (StrictCBC) [${tf}]`;
    }

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
    }

    public override reset(): void {
        this.cachedPivots = [];
        this.cachedZones = [];
        this.lastCalculatedLength = -1;
        this.lastStateHash = '';
        this.pivotTypes.fill(0);
        this.pivotPrices.fill(0);
        this.trends.fill(0);
        super.reset();
    }

    public calculate(ds: DataStore): void {
        this.ensureTelemetryCapacity(ds.length);
        this.buildZones(ds);
    }

    public override update(ds: DataStore, isClosedTick: boolean): void {
        this.ensureTelemetryCapacity(ds.length);
        this.buildZones(ds);
        super.update(ds, isClosedTick);
    }

    private getFibConfigs(): FibSlotConfig[] {
        return ([1, 2, 3, 4, 5] as const).map((slot) => ({
            slot,
            enabled: this.getParam<boolean>(`f${slot}Tog`, slot >= 2 && slot <= 4),
            level: this.getParam<number>(`f${slot}Lvl`, [0, 0.3, 0.5, 0.7, 1][slot - 1]),
            style: this.getParam<DTFXStrictCBCLineStyle>(`f${slot}Style`, ['. . .', '- - -', '___', '- - -', '. . .'][slot - 1] as DTFXStrictCBCLineStyle),
            bullColor: this.getParam<string>(`f${slot}BullColor`, '#089981'),
            bearColor: this.getParam<string>(`f${slot}BearColor`, '#F23645')
        }));
    }

    private computeFibs(top: number, bot: number, dir: 1 | -1, configs: FibSlotConfig[]): DTFXStrictCBCFibLine[] {
        const rng = dir === 1 ? (top - bot) : (bot - top);
        const anchor = dir === 1 ? bot : top;
        return configs.map((cfg) => ({
            slot: cfg.slot,
            enabled: cfg.enabled,
            price: anchor + rng * cfg.level,
            style: cfg.style,
            color: dir === 1 ? cfg.bullColor : cfg.bearColor
        }));
    }

    private applyZonePostProcess(
        zones: DTFXStrictCBCZone[],
        noOverlap: boolean,
        dispAll: boolean,
        zoneDispNum: number
    ): void {
        if (!dispAll) {
            while (zones.length > zoneDispNum) {
                zones.shift();
            }
        }
        if (noOverlap && zones.length > 1) {
            const lastZone = zones[zones.length - 2];
            const liveZone = zones[zones.length - 1];
            if (lastZone.fibEndBar > liveZone.fibStartBar) {
                const boundary = Math.max(liveZone.leftBar, lastZone.rightBar);
                lastZone.fibEndBar = boundary;
                liveZone.fibStartBar = boundary;
            }
        }
    }

    private buildZones(ds: DataStore): void {
        const len = ds.length;
        if (len === 0) {
            this.cachedPivots = [];
            this.cachedZones = [];
            this.lastCalculatedLength = 0;
            this.lastStateHash = '';
            return;
        }

        const chartTfMs = (len >= 2 && ds.data[6] > ds.data[0]) ? (ds.data[6] - ds.data[0]) : 60000;
        const tfMs = this.getEffectiveTfMs(chartTfMs);
        const isHTF = tfMs > chartTfMs;

        const zoneDispNum = Math.max(0, Math.floor(this.getParam<number>('zoneDispNum', 1)));
        const dispAll = this.getParam<boolean>('dispAll', true);
        const zoneFilter = this.getParam<string>('zoneFilter', 'Both');
        const noOverlap = this.getParam<boolean>('noOverlap', true);
        const fibConfigs = this.getFibConfigs();
        const fibSig = fibConfigs
            .map((f) => `${f.enabled ? 1 : 0}:${f.level}:${f.style}:${f.bullColor}:${f.bearColor}`)
            .join('|');

        const baseLast = (len - 1) * 6;
        const dsRevision = (ds as any).revision ?? 0;
        const stateHash = `${tfMs}:${isHTF}:${len}:${dsRevision}:${ds.data[0]}:${ds.data[baseLast]}:${ds.data[baseLast + 1]}:${ds.data[baseLast + 2]}:${ds.data[baseLast + 3]}:${ds.data[baseLast + 4]}:${zoneDispNum}:${dispAll}:${zoneFilter}:${noOverlap}:${fibSig}`;

        if (this.lastStateHash === stateHash && this.lastCalculatedLength === len) {
            return;
        }

        this.pivotTypes.fill(0);
        this.pivotPrices.fill(0);
        this.trends.fill(0);

        const data = ds.data;
        const pivots: StrictZigZagPivot[] = [];
        const zones: DTFXStrictCBCZone[] = [];
        let nextZoneId = 1;

        // =====================================================================
        // MODE 1: Native Chart Timeframe (Strict CBC via stepStrictCBC)
        // =====================================================================
        if (!isHTF) {
            const discThresholdMs = Math.max(300_000, chartTfMs * 5);
            let state: StrictCBCState | null = null;
            let prevPivot: StrictZigZagPivot | null = null;
            let prevTime = -1;
            let prevClose = data[4];

            // DTFX Structure State
            let dir: 1 | -1 | 0 = 0;
            let tDir: 1 | -1 | 0 = 0;
            let t: PivotBound | null = null;
            let b: PivotBound | null = null;
            let bosUpCheck = false;
            let bosDownCheck = false;

            for (let i = 0; i < len; i++) {
                const base = i * 6;
                const candle: StrictCBCCandle = {
                    time: data[base],
                    open: data[base + 1],
                    high: data[base + 2],
                    low: data[base + 3],
                    close: data[base + 4]
                };

                const isDiscontinuity = prevTime !== -1 && (candle.time - prevTime) >= discThresholdMs;
                prevTime = candle.time;

                const stepResult = stepStrictCBCWithReset(candle, i, state, prevPivot, isDiscontinuity);
                const currentState: StrictCBCState = stepResult.nextState;
                state = currentState;

                if (isDiscontinuity) {
                    prevPivot = null;
                    dir = 0;
                    tDir = 0;
                    t = null;
                    b = null;
                    bosUpCheck = false;
                    bosDownCheck = false;
                    prevClose = candle.close;
                    continue;
                }

                const confirmedPivot = stepResult.confirmedPivot;
                if (confirmedPivot) {
                    prevPivot = confirmedPivot;
                    pivots.push(confirmedPivot);
                    this.pivotTypes[confirmedPivot.barIndex] = confirmedPivot.type === 'high' ? 1 : -1;
                    this.pivotPrices[confirmedPivot.barIndex] = confirmedPivot.price;

                    if (confirmedPivot.type === 'high') {
                        t = { price: confirmedPivot.price, bar: confirmedPivot.barIndex };
                        bosUpCheck = true;
                        dir = -1;
                    } else {
                        b = { price: confirmedPivot.price, bar: confirmedPivot.barIndex };
                        bosDownCheck = true;
                        dir = 1;
                    }
                }

                if (i > 0) {
                    const crossoverUp = t !== null && prevClose <= t.price && candle.close > t.price;
                    const crossunderDown = b !== null && prevClose >= b.price && candle.close < b.price;

                    const chochUp = crossoverUp && tDir <= 0;
                    const chochDown = crossunderDown && tDir >= 0;

                    if (chochUp) tDir = 1;
                    if (chochDown) tDir = -1;

                    const bosUp = crossoverUp && bosUpCheck && tDir >= 0;
                    const bosDown = crossunderDown && bosDownCheck && tDir <= 0;

                    const mssUp = bosUp || chochUp;
                    const mssDown = bosDown || chochDown;

                    if (mssUp && t !== null) {
                        bosUpCheck = false;
                        if (zoneFilter !== 'Bearish Only') {
                            const topPrice = t.price;
                            const botPrice = dir === -1
                                ? currentState.phaseLow
                                : (b !== null ? b.price : currentState.phaseLow);

                            zones.push({
                                id: nextZoneId++,
                                direction: 1,
                                leftBar: t.bar,
                                rightBar: i,
                                top: topPrice,
                                bottom: botPrice,
                                fibStartBar: t.bar,
                                fibEndBar: i,
                                fibs: this.computeFibs(topPrice, botPrice, 1, fibConfigs)
                            });
                            this.applyZonePostProcess(zones, noOverlap, dispAll, zoneDispNum);
                        }
                    }

                    if (mssDown && b !== null) {
                        bosDownCheck = false;
                        if (zoneFilter !== 'Bullish Only') {
                            const topPrice = dir === 1
                                ? currentState.phaseHigh
                                : (t !== null ? t.price : currentState.phaseHigh);
                            const botPrice = b.price;

                            zones.push({
                                id: nextZoneId++,
                                direction: -1,
                                leftBar: b.bar,
                                rightBar: i,
                                top: topPrice,
                                bottom: botPrice,
                                fibStartBar: b.bar,
                                fibEndBar: i,
                                fibs: this.computeFibs(topPrice, botPrice, -1, fibConfigs)
                            });
                            this.applyZonePostProcess(zones, noOverlap, dispAll, zoneDispNum);
                        }
                    }
                }

                // Extend active zone's Fib lines to the current bar
                if (zones.length > 0) {
                    zones[zones.length - 1].fibEndBar = i;
                }

                this.trends[i] = tDir;
                prevClose = candle.close;
            }

            this.cachedPivots = pivots;
            this.cachedZones = zones;
            this.lastCalculatedLength = len;
            this.lastStateHash = stateHash;
            return;
        }

        // =====================================================================
        // MODE 2: Higher Timeframe (HTF Resampled Strict CBC)
        // =====================================================================
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
            hasGap: boolean;
        }

        const rawDiscThresholdMs = Math.max(300_000, chartTfMs * 5);
        const htfBars: HtfBar[] = [];
        let currBucketTime = -1;
        let currHtfBar: HtfBar | null = null;
        let prevRawTime = -1;

        for (let i = 0; i < len; i++) {
            const base = i * 6;
            const tTime = data[base];
            const o = data[base + 1];
            const h = data[base + 2];
            const l = data[base + 3];
            const c = data[base + 4];

            const isRawGap = prevRawTime !== -1 && (tTime - prevRawTime) >= rawDiscThresholdMs;
            prevRawTime = tTime;

            const bTime = TimeframeResampler.getBucketStart(tTime, tfMs);
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
                    troughChartBar: i,
                    hasGap: isRawGap
                };
                htfBars.push(currHtfBar);
            } else if (currHtfBar) {
                if (isRawGap) currHtfBar.hasGap = true;
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

        if (htfBars.length === 0) {
            this.cachedPivots = [];
            this.cachedZones = [];
            this.lastCalculatedLength = len;
            this.lastStateHash = stateHash;
            return;
        }

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

        const htfDiscThresholdMs = Math.max(300_000, tfMs * 2);
        let prevHtfTime = -1;

        let dir: 1 | -1 | 0 = 0;
        let tDir: 1 | -1 | 0 = 0;
        let t: PivotBound | null = null;
        let b: PivotBound | null = null;
        let bosUpCheck = false;
        let bosDownCheck = false;
        let prevClose = htfBars[0].close;

        for (let idx = 0; idx < htfBars.length; idx++) {
            const bar = htfBars[idx];
            const isHtfDiscontinuity = bar.hasGap || (prevHtfTime !== -1 && (bar.time - prevHtfTime) >= htfDiscThresholdMs);
            prevHtfTime = bar.time;

            if (isHtfDiscontinuity) {
                anchorHigh = bar.high;
                anchorLow = bar.low;
                isBullish = true;
                phaseHigh = bar.high;
                phaseHighChartIdx = bar.peakChartBar;
                phaseLow = bar.low;
                phaseLowChartIdx = bar.troughChartBar;
                lastHighPrice = null;
                lastLowPrice = null;
                dir = 0;
                tDir = 0;
                t = null;
                b = null;
                bosUpCheck = false;
                bosDownCheck = false;
                prevClose = bar.close;
                continue;
            }

            const isBuy = bar.close > bar.open;
            const isSell = bar.close < bar.open;

            const bearishFlip = isBullish && isSell && (bar.close < anchorLow);
            const bullishFlip = !isBullish && isBuy && (bar.close > anchorHigh);

            if (isBullish) {
                if (bar.high > phaseHigh) {
                    phaseHigh = bar.high;
                    phaseHighChartIdx = bar.peakChartBar;
                }
            } else {
                if (bar.low < phaseLow) {
                    phaseLow = bar.low;
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

                t = { price: phaseHigh, bar: phaseHighChartIdx };
                bosUpCheck = true;
                dir = -1;

                phaseLow = bar.low;
                phaseLowChartIdx = bar.troughChartBar;
            } else if (bullishFlip) {
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

                b = { price: phaseLow, bar: phaseLowChartIdx };
                bosDownCheck = true;
                dir = 1;

                phaseHigh = bar.high;
                phaseHighChartIdx = bar.peakChartBar;
            }

            const validContinuation = (isBullish && bar.close > anchorHigh) || (!isBullish && bar.close < anchorLow);
            if (validContinuation || bearishFlip || bullishFlip) {
                anchorHigh = bar.high;
                anchorLow = bar.low;
            }

            if (idx > 0) {
                const crossoverUp = t !== null && prevClose <= t.price && bar.close > t.price;
                const crossunderDown = b !== null && prevClose >= b.price && bar.close < b.price;

                const chochUp = crossoverUp && tDir <= 0;
                const chochDown = crossunderDown && tDir >= 0;

                if (chochUp) tDir = 1;
                if (chochDown) tDir = -1;

                const bosUp = crossoverUp && bosUpCheck && tDir >= 0;
                const bosDown = crossunderDown && bosDownCheck && tDir <= 0;

                if ((bosUp || chochUp) && t !== null) {
                    bosUpCheck = false;
                    if (zoneFilter !== 'Bearish Only') {
                        const topPrice = t.price;
                        const botPrice = dir === -1 ? phaseLow : (b !== null ? b.price : phaseLow);
                        zones.push({
                            id: nextZoneId++,
                            direction: 1,
                            leftBar: t.bar,
                            rightBar: bar.lastChartBar,
                            top: topPrice,
                            bottom: botPrice,
                            fibStartBar: t.bar,
                            fibEndBar: bar.lastChartBar,
                            fibs: this.computeFibs(topPrice, botPrice, 1, fibConfigs)
                        });
                        this.applyZonePostProcess(zones, noOverlap, dispAll, zoneDispNum);
                    }
                }

                if ((bosDown || chochDown) && b !== null) {
                    bosDownCheck = false;
                    if (zoneFilter !== 'Bullish Only') {
                        const topPrice = dir === 1 ? phaseHigh : (t !== null ? t.price : phaseHigh);
                        const botPrice = b.price;
                        zones.push({
                            id: nextZoneId++,
                            direction: -1,
                            leftBar: b.bar,
                            rightBar: bar.lastChartBar,
                            top: topPrice,
                            bottom: botPrice,
                            fibStartBar: b.bar,
                            fibEndBar: bar.lastChartBar,
                            fibs: this.computeFibs(topPrice, botPrice, -1, fibConfigs)
                        });
                        this.applyZonePostProcess(zones, noOverlap, dispAll, zoneDispNum);
                    }
                }
            }

            if (zones.length > 0) {
                zones[zones.length - 1].fibEndBar = bar.lastChartBar;
            }

            const lBar = Math.min(len - 1, bar.lastChartBar);
            for (let k = bar.firstChartBar; k <= lBar; k++) {
                this.trends[k] = tDir;
            }
            prevClose = bar.close;
        }

        this.cachedPivots = pivots;
        this.cachedZones = zones;
        this.lastCalculatedLength = len;
        this.lastStateHash = stateHash;
    }

    private drawStyledHLine(
        g: Graphics,
        x1: number,
        x2: number,
        y: number,
        style: DTFXStrictCBCLineStyle,
        minX: number,
        maxX: number
    ): void {
        const startX = Math.max(Math.min(x1, x2), minX);
        const endX = Math.min(Math.max(x1, x2), maxX);
        if (endX <= startX) return;

        if (style === '___') {
            g.moveTo(startX, y).lineTo(endX, y);
            return;
        }

        const segLen = style === '- - -' ? 6 : 2;
        const gapLen = 4;
        const step = segLen + gapLen;

        for (let x = startX; x < endX; x += step) {
            const xEnd = Math.min(x + segLen, endX);
            g.moveTo(x, y).lineTo(xEnd, y);
        }
    }

    public render(r: ChartRenderer, layout: IndicatorLayout, g: Graphics): void {
        if (!this.visible || r.dataStore.length === 0) return;

        if (this.lastCalculatedLength !== r.dataStore.length) {
            this.buildZones(r.dataStore);
        }

        const screenW = layout.chartWidth;
        const minX = -40;
        const maxX = screenW + 40;

        // --- 1. RENDER ZONES (Batched Bullish & Bearish Boxes) ---
        const defaultZoneAlpha = Math.max(0.05, Math.min(1, this.getParam<number>('zoneAlpha', 0.2)));
        const bullClr = parseColorAndAlpha(this.getParam<string>('bullZoneColor', '#089981'), defaultZoneAlpha);
        const bearClr = parseColorAndAlpha(this.getParam<string>('bearZoneColor', '#F23645'), defaultZoneAlpha);

        for (const [targetDir, clr] of [[1, bullClr], [-1, bearClr]] as const) {
            g.beginPath();
            let hasBoxes = false;
            for (let i = 0; i < this.cachedZones.length; i++) {
                const z = this.cachedZones[i];
                if (z.direction !== targetDir) continue;

                const x1 = r.getCandleCenterX(z.leftBar);
                const x2 = r.getCandleCenterX(z.rightBar);
                if (Math.max(x1, x2) < minX || Math.min(x1, x2) > maxX) continue;

                const yTop = r.priceToY(z.top);
                const yBot = r.priceToY(z.bottom);
                const rx = Math.min(x1, x2);
                const rw = Math.max(1, Math.abs(x2 - x1));
                const ry = Math.min(yTop, yBot);
                const rh = Math.max(1, Math.abs(yBot - yTop));

                g.rect(rx, ry, rw, rh);
                hasBoxes = true;
            }
            if (hasBoxes) {
                g.fill({ color: clr.color, alpha: clr.alpha });
            }
        }

        // --- 2. RENDER FIB LINES (Batched by Color) ---
        const fibLineWidth = Math.max(1, this.getParam<number>('fibLineWidth', 1));
        const fibPathsByColor = new Map<string, Array<{ x1: number; x2: number; y: number; style: DTFXStrictCBCLineStyle }>>();

        for (let i = 0; i < this.cachedZones.length; i++) {
            const z = this.cachedZones[i];
            const x1 = r.getCandleCenterX(z.fibStartBar);
            const x2 = r.getCandleCenterX(z.fibEndBar);
            if (Math.max(x1, x2) < minX || Math.min(x1, x2) > maxX) continue;

            for (let j = 0; j < z.fibs.length; j++) {
                const fib = z.fibs[j];
                if (!fib.enabled || !isFinite(fib.price)) continue;

                const y = r.priceToY(fib.price);
                let bucket = fibPathsByColor.get(fib.color);
                if (!bucket) {
                    bucket = [];
                    fibPathsByColor.set(fib.color, bucket);
                }
                bucket.push({ x1, x2, y, style: fib.style });
            }
        }

        for (const [colorHex, lines] of fibPathsByColor) {
            const parsed = parseColorAndAlpha(colorHex, 1.0);
            g.beginPath();
            for (let i = 0; i < lines.length; i++) {
                const ln = lines[i];
                this.drawStyledHLine(g, ln.x1, ln.x2, ln.y, ln.style, minX, maxX);
            }
            g.stroke({ color: parsed.color, width: fibLineWidth, alpha: parsed.alpha });
        }

        // --- 3. RENDER STRICT CBC SWING POINTS ---
        const showPivots = this.getParam<boolean>('showPivots', true);
        if (showPivots && this.cachedPivots.length > 0) {
            const radius = Math.max(1.5, this.getParam<number>('pivotRadius', 3.5));
            const structClr = parseColorAndAlpha(this.getParam<string>('structureColor', '#787B86'), 1.0);

            g.beginPath();
            let hasDots = false;
            for (let i = 0; i < this.cachedPivots.length; i++) {
                const p = this.cachedPivots[i];
                const px = r.getCandleCenterX(p.barIndex);
                if (px < minX || px > maxX) continue;
                const py = r.priceToY(p.price);

                g.circle(px, py, radius);
                hasDots = true;
            }
            if (hasDots) {
                g.fill({ color: structClr.color, alpha: structClr.alpha });
            }
        }
    }

    public override getValueAt(idx: number, ds: DataStore, _isDark: boolean, defaultTextClr: number) {
        if (idx < 0 || idx >= ds.length) {
            return { label: this.name, valueStr: '—', valueColor: defaultTextClr };
        }

        const pType = this.pivotTypes[idx];
        const pPrice = this.pivotPrices[idx];
        const trend = this.trends[idx];

        const bullClr = parseColor(this.getParam('bullZoneColor', '#089981'));
        const bearClr = parseColor(this.getParam('bearZoneColor', '#F23645'));

        const fmt = (p: number) => {
            if (isNaN(p) || !isFinite(p) || p === 0) return '—';
            return p >= 10 ? p.toFixed(2) : p.toPrecision(5);
        };

        if (pType === 1) {
            return { label: this.name, valueStr: `Swing High: $${fmt(pPrice)}`, valueColor: bearClr };
        }
        if (pType === -1) {
            return { label: this.name, valueStr: `Swing Low: $${fmt(pPrice)}`, valueColor: bullClr };
        }
        if (trend === 1) {
            return { label: this.name, valueStr: `Bullish Structure (Zones: ${this.cachedZones.length})`, valueColor: bullClr };
        }
        if (trend === -1) {
            return { label: this.name, valueStr: `Bearish Structure (Zones: ${this.cachedZones.length})`, valueColor: bearClr };
        }
        return { label: this.name, valueStr: `Zones: ${this.cachedZones.length}`, valueColor: defaultTextClr };
    }

    public destroy(): void {
        this.cachedPivots = [];
        this.cachedZones = [];
    }
}
