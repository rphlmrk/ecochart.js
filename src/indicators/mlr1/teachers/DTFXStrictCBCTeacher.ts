import type { ML1Candle } from '../ML1FeatureTypes';
import {
    type StrictCBCCandle,
    type StrictCBCState,
    type StrictZigZagPivot
} from '../../plugins/StrictCBCZigZagIndicator';
import { stepStrictCBCWithReset } from './StrategyEventTypes';

export type DTFXStrictCBCTimeframe = '1m' | '3m' | '5m' | '15m';

export type DTFXStrictCBCEventType =
    | 'DTFX_CBC_DEMAND_CREATED'
    | 'DTFX_CBC_SUPPLY_CREATED'
    | 'DTFX_CBC_DEMAND_RETEST'
    | 'DTFX_CBC_SUPPLY_RETEST';

export const DTFX_STRICTCBC_TIMEFRAME_MS: Readonly<Record<DTFXStrictCBCTimeframe, number>> = {
    '1m': 60_000,
    '3m': 180_000,
    '5m': 300_000,
    '15m': 900_000
};

export interface DTFXStrictCBCStructuralContext {
    readonly zoneTimeframe: DTFXStrictCBCTimeframe;
    readonly zoneId: number;
    readonly zoneStatus: 'CREATED' | 'RETESTED';
    readonly isChoch: boolean;
    readonly retestCount: number;
    readonly zoneCreatedSourceBarIndex: number;
    readonly zoneCreatedConfirmationBarIndex: number;
    readonly zoneTop: number;
    readonly zoneBot: number;
    readonly fib03: number;
    readonly fib05: number;
    readonly fib07: number;
    readonly atr14Valid: boolean;
    readonly zoneWidthAtr: number | null;
    readonly fib05DistAtr: number | null;
}

export interface DTFXStrictCBCTeacherEvent {
    readonly strategyId: 'DTFX_STRICTCBC';
    readonly strategyVersion: 'DTFX_STRICTCBC_v1';
    readonly symbol: string;
    readonly timeframe: string;
    readonly eventType: DTFXStrictCBCEventType;
    readonly eventDirection: 'bull' | 'bear';
    readonly eventDiscriminator: string;
    readonly sourceBarIndex: number;
    readonly sourceTimestamp: number;
    readonly confirmationBarIndex: number;
    readonly confirmationTimestamp: number;
    readonly zoneTimeframe: DTFXStrictCBCTimeframe;
    readonly structuralContext: DTFXStrictCBCStructuralContext;
}

export interface DTFXStrictCBCConfig {
    readonly symbol: string;
    readonly baseTimeframe: string;
    readonly baseIntervalMs: number;
    readonly zoneTimeframe: DTFXStrictCBCTimeframe;
    readonly zoneIntervalMs: number;
    readonly expectedBarsPerBucket: number;
    readonly maxActiveZones: number;
    readonly maxRetestsPerZone: number;
    readonly emitRetests: boolean;
}

export interface DTFXStrictCBCActiveZone {
    readonly zoneId: number;
    readonly direction: 'bull' | 'bear';
    readonly isChoch: boolean;
    readonly createdSourceBarIndex: number;
    readonly createdSourceTimestamp: number;
    readonly createdConfirmationBarIndex: number;
    readonly createdConfirmationTimestamp: number;
    readonly zoneTop: number;
    readonly zoneBot: number;
    readonly fib03: number;
    readonly fib05: number;
    readonly fib07: number;
    readonly retestCount: number;
    readonly wasOutsideSinceLastEvent: boolean;
    readonly lastRetestBarIndex: number;
}

interface FormingHtfBucket {
    readonly bucketStart: number;
    readonly open: number;
    readonly high: number;
    readonly low: number;
    readonly close: number;
    readonly peakChartBar: number;
    readonly peakChartTime: number;
    readonly troughChartBar: number;
    readonly troughChartTime: number;
    readonly lastCandleTime: number;
    readonly barCount: number;
    readonly isCorrupt: boolean;
}

interface ChartAnchor {
    readonly bar: number;
    readonly time: number;
}

interface PivotBound {
    readonly price: number;
    readonly bar: number;
    readonly time: number;
}

export interface DTFXStrictCBCState {
    readonly cbcState: StrictCBCState | null;
    readonly prevPivot: StrictZigZagPivot | null;
    readonly htfBarIndex: number;
    readonly formingBucket: FormingHtfBucket | null;
    readonly phaseHighChart: ChartAnchor | null;
    readonly phaseLowChart: ChartAnchor | null;
    readonly dir: 1 | -1 | 0;
    readonly tDir: 1 | -1 | 0;
    readonly t: PivotBound | null;
    readonly b: PivotBound | null;
    readonly bosUpCheck: boolean;
    readonly bosDownCheck: boolean;
    readonly prevHtfClose: number | null;
    readonly nextZoneId: number;
    readonly activeZones: readonly DTFXStrictCBCActiveZone[];
    readonly lastProcessedTimestamp: number | null;
    readonly lastProcessedBarIndex: number | null;
}

function parseTimeframeToMs(tf: string): number {
    const match = /^([1-9]\d*)(m|h|d)$/.exec(tf.trim());
    if (!match) {
        throw new Error(`Unsupported baseTimeframe format '${tf}'. Expected e.g. '1m', '3m', '5m', '15m', '1h'.`);
    }
    const count = Number(match[1]);
    const unitMs = match[2] === 'm' ? 60_000 : match[2] === 'h' ? 3_600_000 : 86_400_000;
    return count * unitMs;
}

export function createDefaultDTFXStrictCBCConfig(
    symbol: string,
    baseTimeframe: string,
    baseIntervalMs: number,
    zoneTimeframe: DTFXStrictCBCTimeframe,
    options?: {
        maxActiveZones?: number;
        maxRetestsPerZone?: number;
        emitRetests?: boolean;
    }
): DTFXStrictCBCConfig {
    if (typeof symbol !== 'string' || symbol.trim().length === 0) {
        throw new Error('symbol must be a non-empty string.');
    }
    if (typeof baseTimeframe !== 'string' || baseTimeframe.trim().length === 0) {
        throw new Error('baseTimeframe must be a non-empty string.');
    }
    if (!Number.isSafeInteger(baseIntervalMs) || baseIntervalMs <= 0) {
        throw new Error(`Invalid baseIntervalMs: ${baseIntervalMs}`);
    }
    const parsedBaseMs = parseTimeframeToMs(baseTimeframe);
    if (parsedBaseMs !== baseIntervalMs) {
        throw new Error(
            `Config Error: baseTimeframe '${baseTimeframe}' (${parsedBaseMs}ms) does not match baseIntervalMs (${baseIntervalMs}ms).`
        );
    }

    const zoneIntervalMs = DTFX_STRICTCBC_TIMEFRAME_MS[zoneTimeframe];
    if (!zoneIntervalMs) {
        throw new Error(`Unsupported zoneTimeframe: ${String(zoneTimeframe)}`);
    }
    if (zoneIntervalMs < baseIntervalMs || zoneIntervalMs % baseIntervalMs !== 0) {
        throw new Error(
            `zoneTimeframe (${zoneTimeframe}=${zoneIntervalMs}ms) must be an integer multiple of baseIntervalMs (${baseIntervalMs}ms).`
        );
    }

    const maxActiveZones = options?.maxActiveZones ?? 20;
    const maxRetestsPerZone = options?.maxRetestsPerZone ?? 3;
    if (!Number.isSafeInteger(maxActiveZones) || maxActiveZones < 1) {
        throw new Error(`maxActiveZones must be a positive integer, got ${maxActiveZones}`);
    }
    if (!Number.isSafeInteger(maxRetestsPerZone) || maxRetestsPerZone < 0) {
        throw new Error(`maxRetestsPerZone must be a non-negative integer, got ${maxRetestsPerZone}`);
    }

    return {
        symbol,
        baseTimeframe,
        baseIntervalMs,
        zoneTimeframe,
        zoneIntervalMs,
        expectedBarsPerBucket: zoneIntervalMs / baseIntervalMs,
        maxActiveZones,
        maxRetestsPerZone,
        emitRetests: options?.emitRetests ?? true
    };
}

export function createInitialDTFXStrictCBCState(): DTFXStrictCBCState {
    return {
        cbcState: null,
        prevPivot: null,
        htfBarIndex: 0,
        formingBucket: null,
        phaseHighChart: null,
        phaseLowChart: null,
        dir: 0,
        tDir: 0,
        t: null,
        b: null,
        bosUpCheck: false,
        bosDownCheck: false,
        prevHtfClose: null,
        nextZoneId: 1,
        activeZones: [],
        lastProcessedTimestamp: null,
        lastProcessedBarIndex: null
    };
}

function validateInputBoundary(
    candle: ML1Candle,
    barIndex: number,
    state: DTFXStrictCBCState,
    config: DTFXStrictCBCConfig
): void {
    if (!Number.isSafeInteger(barIndex) || barIndex < 0) {
        throw new Error(`Chronology Error: barIndex must be a non-negative safe integer, got ${barIndex}`);
    }
    if (state.lastProcessedBarIndex === null) {
        if (barIndex !== 0) {
            throw new Error(`Chronology Error: initial barIndex must be 0, got ${barIndex}`);
        }
    } else if (barIndex !== state.lastProcessedBarIndex + 1) {
        throw new Error(
            `Chronology Error: barIndex must increment by 1 (expected ${state.lastProcessedBarIndex + 1}, got ${barIndex})`
        );
    }

    if (!Number.isSafeInteger(candle.time) || candle.time <= 0) {
        throw new Error(`Chronology Error: invalid candle timestamp ${candle.time}`);
    }
    if (candle.time % config.baseIntervalMs !== 0) {
        throw new Error(
            `Grid Error: candle timestamp ${candle.time} is not aligned to baseIntervalMs=${config.baseIntervalMs}`
        );
    }
    if (state.lastProcessedTimestamp !== null && candle.time <= state.lastProcessedTimestamp) {
        throw new Error(
            `Chronology Error: out-of-order or duplicate timestamp ${candle.time} <= ${state.lastProcessedTimestamp}`
        );
    }

    if (
        !Number.isFinite(candle.open) || candle.open <= 0 ||
        !Number.isFinite(candle.high) || candle.high <= 0 ||
        !Number.isFinite(candle.low) || candle.low <= 0 ||
        !Number.isFinite(candle.close) || candle.close <= 0 ||
        !Number.isFinite(candle.volume) || candle.volume < 0 ||
        candle.high < candle.low ||
        candle.high < Math.max(candle.open, candle.close) ||
        candle.low > Math.min(candle.open, candle.close)
    ) {
        throw new Error(`OHLCV Error: invalid candle geometry at barIndex=${barIndex}, time=${candle.time}`);
    }
}

function computeZoneFibs(top: number, bot: number, direction: 'bull' | 'bear') {
    const rng = direction === 'bull' ? (top - bot) : (bot - top);
    const anchor = direction === 'bull' ? bot : top;
    return {
        fib03: anchor + rng * 0.3,
        fib05: anchor + rng * 0.5,
        fib07: anchor + rng * 0.7
    };
}

function computeAtrMetrics(
    zoneTop: number,
    zoneBot: number,
    fib05: number,
    closePrice: number,
    atr14: number | null
): { atr14Valid: boolean; zoneWidthAtr: number | null; fib05DistAtr: number | null } {
    const atr14Valid = atr14 !== null && Number.isFinite(atr14) && atr14 > 0;
    if (!atr14Valid) {
        return { atr14Valid: false, zoneWidthAtr: null, fib05DistAtr: null };
    }
    return {
        atr14Valid: true,
        zoneWidthAtr: Math.abs(zoneTop - zoneBot) / atr14,
        fib05DistAtr: Math.abs(closePrice - fib05) / atr14
    };
}

function makeZoneEvent(
    config: DTFXStrictCBCConfig,
    zone: DTFXStrictCBCActiveZone,
    status: 'CREATED' | 'RETESTED',
    confirmationBarIndex: number,
    confirmationTimestamp: number,
    closePrice: number,
    atr14: number | null
): DTFXStrictCBCTeacherEvent {
    const eventType: DTFXStrictCBCEventType =
        zone.direction === 'bull'
            ? (status === 'CREATED' ? 'DTFX_CBC_DEMAND_CREATED' : 'DTFX_CBC_DEMAND_RETEST')
            : (status === 'CREATED' ? 'DTFX_CBC_SUPPLY_CREATED' : 'DTFX_CBC_SUPPLY_RETEST');

    const { atr14Valid, zoneWidthAtr, fib05DistAtr } = computeAtrMetrics(
        zone.zoneTop,
        zone.zoneBot,
        zone.fib05,
        closePrice,
        atr14
    );

    // Globally unique across symbol, base timeframe, zone timeframe, direction, and immutable UTC timestamps
    const discSuffix = status === 'CREATED' ? 'C' : `R${zone.retestCount}`;
    const eventDiscriminator = [
        config.symbol,
        config.baseTimeframe,
        config.zoneTimeframe,
        zone.direction,
        zone.createdSourceTimestamp,
        zone.createdConfirmationTimestamp,
        discSuffix
    ].join(':');

    return {
        strategyId: 'DTFX_STRICTCBC',
        strategyVersion: 'DTFX_STRICTCBC_v1',
        symbol: config.symbol,
        timeframe: config.baseTimeframe,
        eventType,
        eventDirection: zone.direction,
        eventDiscriminator,
        sourceBarIndex: zone.createdSourceBarIndex,
        sourceTimestamp: zone.createdSourceTimestamp,
        confirmationBarIndex,
        confirmationTimestamp,
        zoneTimeframe: config.zoneTimeframe,
        structuralContext: {
            zoneTimeframe: config.zoneTimeframe,
            zoneId: zone.zoneId,
            zoneStatus: status,
            isChoch: zone.isChoch,
            retestCount: zone.retestCount,
            zoneCreatedSourceBarIndex: zone.createdSourceBarIndex,
            zoneCreatedConfirmationBarIndex: zone.createdConfirmationBarIndex,
            zoneTop: zone.zoneTop,
            zoneBot: zone.zoneBot,
            fib03: zone.fib03,
            fib05: zone.fib05,
            fib07: zone.fib07,
            atr14Valid,
            zoneWidthAtr,
            fib05DistAtr
        }
    };
}

function stepCompletedHtfBucket(
    completedBucket: FormingHtfBucket,
    confirmChartBarIndex: number,
    confirmChartTimestamp: number,
    atr14: number | null,
    config: DTFXStrictCBCConfig,
    prevState: {
        cbcState: StrictCBCState | null;
        prevPivot: StrictZigZagPivot | null;
        htfBarIndex: number;
        phaseHighChart: ChartAnchor | null;
        phaseLowChart: ChartAnchor | null;
        dir: 1 | -1 | 0;
        tDir: 1 | -1 | 0;
        t: PivotBound | null;
        b: PivotBound | null;
        bosUpCheck: boolean;
        bosDownCheck: boolean;
        prevHtfClose: number | null;
        nextZoneId: number;
        activeZones: DTFXStrictCBCActiveZone[];
    }
): {
    nextState: DTFXStrictCBCState;
    createdEvents: DTFXStrictCBCTeacherEvent[];
    confirmedPivot: StrictZigZagPivot | null;
} {
    const htfCandle: StrictCBCCandle = {
        time: completedBucket.bucketStart,
        open: completedBucket.open,
        high: completedBucket.high,
        low: completedBucket.low,
        close: completedBucket.close
    };

    const htfIdx = prevState.htfBarIndex;
    const isFreshInit = prevState.cbcState === null;
    const cbcStep = stepStrictCBCWithReset(htfCandle, htfIdx, prevState.cbcState, prevState.prevPivot, isFreshInit);
    const cbcState = cbcStep.nextState;

    let phaseHighChart: ChartAnchor = prevState.phaseHighChart ?? {
        bar: completedBucket.peakChartBar,
        time: completedBucket.peakChartTime
    };
    let phaseLowChart: ChartAnchor = prevState.phaseLowChart ?? {
        bar: completedBucket.troughChartBar,
        time: completedBucket.troughChartTime
    };

    let dir = prevState.dir;
    let tDir = prevState.tDir;
    let t = prevState.t;
    let b = prevState.b;
    let bosUpCheck = prevState.bosUpCheck;
    let bosDownCheck = prevState.bosDownCheck;
    let nextZoneId = prevState.nextZoneId;
    const activeZones = [...prevState.activeZones];
    const createdEvents: DTFXStrictCBCTeacherEvent[] = [];

    const rawPivot = cbcStep.confirmedPivot;
    let mappedPivot: StrictZigZagPivot | null = null;

    if (rawPivot) {
        if (rawPivot.type === 'high') {
            const pivotBar = rawPivot.barIndex === htfIdx ? completedBucket.peakChartBar : phaseHighChart.bar;
            const pivotTime = rawPivot.barIndex === htfIdx ? completedBucket.peakChartTime : phaseHighChart.time;
            mappedPivot = {
                ...rawPivot,
                barIndex: pivotBar,
                time: pivotTime,
                confirmedBarIndex: confirmChartBarIndex
            };
            t = { price: rawPivot.price, bar: pivotBar, time: pivotTime };
            bosUpCheck = true;
            dir = -1;
            phaseLowChart = { bar: completedBucket.troughChartBar, time: completedBucket.troughChartTime };
        } else {
            const pivotBar = rawPivot.barIndex === htfIdx ? completedBucket.troughChartBar : phaseLowChart.bar;
            const pivotTime = rawPivot.barIndex === htfIdx ? completedBucket.troughChartTime : phaseLowChart.time;
            mappedPivot = {
                ...rawPivot,
                barIndex: pivotBar,
                time: pivotTime,
                confirmedBarIndex: confirmChartBarIndex
            };
            b = { price: rawPivot.price, bar: pivotBar, time: pivotTime };
            bosDownCheck = true;
            dir = 1;
            phaseHighChart = { bar: completedBucket.peakChartBar, time: completedBucket.peakChartTime };
        }
    } else {
        if (cbcState.phaseHighIdx === htfIdx) {
            phaseHighChart = { bar: completedBucket.peakChartBar, time: completedBucket.peakChartTime };
        }
        if (cbcState.phaseLowIdx === htfIdx) {
            phaseLowChart = { bar: completedBucket.troughChartBar, time: completedBucket.troughChartTime };
        }
    }

    if (htfIdx > 0 && prevState.prevHtfClose !== null) {
        const prevClose = prevState.prevHtfClose;
        const currClose = completedBucket.close;

        const crossoverUp = t !== null && prevClose <= t.price && currClose > t.price;
        const crossunderDown = b !== null && prevClose >= b.price && currClose < b.price;

        const chochUp = crossoverUp && tDir <= 0;
        const chochDown = crossunderDown && tDir >= 0;

        if (chochUp) tDir = 1;
        if (chochDown) tDir = -1;

        const bosUp = crossoverUp && bosUpCheck && tDir >= 0;
        const bosDown = crossunderDown && bosDownCheck && tDir <= 0;

        if ((bosUp || chochUp) && t !== null) {
            bosUpCheck = false;
            const zoneTop = t.price;
            const zoneBot = dir === -1 ? cbcState.phaseLow : (b !== null ? b.price : cbcState.phaseLow);
            if (zoneTop > zoneBot) {
                const { fib03, fib05, fib07 } = computeZoneFibs(zoneTop, zoneBot, 'bull');
                const newZone: DTFXStrictCBCActiveZone = {
                    zoneId: nextZoneId++,
                    direction: 'bull',
                    isChoch: chochUp,
                    createdSourceBarIndex: t.bar,
                    createdSourceTimestamp: t.time,
                    createdConfirmationBarIndex: confirmChartBarIndex,
                    createdConfirmationTimestamp: confirmChartTimestamp,
                    zoneTop,
                    zoneBot,
                    fib03,
                    fib05,
                    fib07,
                    retestCount: 0,
                    wasOutsideSinceLastEvent: completedBucket.close > zoneTop,
                    lastRetestBarIndex: -1
                };
                activeZones.push(newZone);
                while (activeZones.length > config.maxActiveZones) {
                    activeZones.shift();
                }
                createdEvents.push(
                    makeZoneEvent(
                        config,
                        newZone,
                        'CREATED',
                        confirmChartBarIndex,
                        confirmChartTimestamp,
                        completedBucket.close,
                        atr14
                    )
                );
            }
        }

        if ((bosDown || chochDown) && b !== null) {
            bosDownCheck = false;
            const zoneTop = dir === 1 ? cbcState.phaseHigh : (t !== null ? t.price : cbcState.phaseHigh);
            const zoneBot = b.price;
            if (zoneTop > zoneBot) {
                const { fib03, fib05, fib07 } = computeZoneFibs(zoneTop, zoneBot, 'bear');
                const newZone: DTFXStrictCBCActiveZone = {
                    zoneId: nextZoneId++,
                    direction: 'bear',
                    isChoch: chochDown,
                    createdSourceBarIndex: b.bar,
                    createdSourceTimestamp: b.time,
                    createdConfirmationBarIndex: confirmChartBarIndex,
                    createdConfirmationTimestamp: confirmChartTimestamp,
                    zoneTop,
                    zoneBot,
                    fib03,
                    fib05,
                    fib07,
                    retestCount: 0,
                    wasOutsideSinceLastEvent: completedBucket.close < zoneBot,
                    lastRetestBarIndex: -1
                };
                activeZones.push(newZone);
                while (activeZones.length > config.maxActiveZones) {
                    activeZones.shift();
                }
                createdEvents.push(
                    makeZoneEvent(
                        config,
                        newZone,
                        'CREATED',
                        confirmChartBarIndex,
                        confirmChartTimestamp,
                        completedBucket.close,
                        atr14
                    )
                );
            }
        }
    }

    return {
        nextState: {
            cbcState,
            prevPivot: rawPivot ?? prevState.prevPivot,
            htfBarIndex: htfIdx + 1,
            formingBucket: null,
            phaseHighChart,
            phaseLowChart,
            dir,
            tDir,
            t,
            b,
            bosUpCheck,
            bosDownCheck,
            prevHtfClose: completedBucket.close,
            nextZoneId,
            activeZones,
            lastProcessedTimestamp: confirmChartTimestamp,
            lastProcessedBarIndex: confirmChartBarIndex
        },
        createdEvents,
        confirmedPivot: mappedPivot
    };
}

/**
 * Pure causal streaming step for DTFX (StrictCBC) on a grid-aligned base feed.
 * Gap / Continuity Contract:
 *   - Enforces internal consecutive base-timestamp continuity (`candle.time === lastProcessedTimestamp + baseIntervalMs`)
 *     independently of `isDiscontinuity`.
 *   - Any missing candle (at a bucket boundary, inside a bucket, or in 1m mode) clears `activeZones`,
 *     resets StrictCBC/MSS state, and seeds a new bucket ONLY if the candle sits at a bucket start.
 */
export function stepDTFXStrictCBC(
    candle: ML1Candle,
    barIndex: number,
    state: DTFXStrictCBCState,
    config: DTFXStrictCBCConfig,
    isDiscontinuity: boolean,
    atr14: number | null
): {
    readonly nextState: DTFXStrictCBCState;
    readonly events: readonly DTFXStrictCBCTeacherEvent[];
    readonly confirmedPivot: StrictZigZagPivot | null;
} {
    validateInputBoundary(candle, barIndex, state, config);

    const bucketStart = Math.floor(candle.time / config.zoneIntervalMs) * config.zoneIntervalMs;

    // 1. Internal Base-Grid Continuity + Explicit Discontinuity Check (BEFORE any retest evaluation)
    const hasMissingBaseCandle =
        state.lastProcessedTimestamp !== null &&
        candle.time !== state.lastProcessedTimestamp + config.baseIntervalMs;
    const effectiveDiscontinuity = isDiscontinuity || hasMissingBaseCandle;

    if (effectiveDiscontinuity) {
        const clean = createInitialDTFXStrictCBCState();
        if (config.expectedBarsPerBucket === 1) {
            const singleBucket: FormingHtfBucket = {
                bucketStart: candle.time,
                open: candle.open,
                high: candle.high,
                low: candle.low,
                close: candle.close,
                peakChartBar: barIndex,
                peakChartTime: candle.time,
                troughChartBar: barIndex,
                troughChartTime: candle.time,
                lastCandleTime: candle.time,
                barCount: 1,
                isCorrupt: false
            };
            const stepped = stepCompletedHtfBucket(singleBucket, barIndex, candle.time, atr14, config, {
                cbcState: null,
                prevPivot: null,
                htfBarIndex: 0,
                phaseHighChart: null,
                phaseLowChart: null,
                dir: 0,
                tDir: 0,
                t: null,
                b: null,
                bosUpCheck: false,
                bosDownCheck: false,
                prevHtfClose: null,
                nextZoneId: state.nextZoneId,
                activeZones: []
            });
            return { nextState: stepped.nextState, events: [], confirmedPivot: null };
        }

        // HTF mode: seed a new bucket ONLY if this post-gap candle starts cleanly on a bucket boundary
        const startsOnBucket = candle.time === bucketStart;
        return {
            nextState: {
                ...clean,
                nextZoneId: state.nextZoneId,
                lastProcessedTimestamp: candle.time,
                lastProcessedBarIndex: barIndex,
                formingBucket: startsOnBucket
                    ? {
                        bucketStart,
                        open: candle.open,
                        high: candle.high,
                        low: candle.low,
                        close: candle.close,
                        peakChartBar: barIndex,
                        peakChartTime: candle.time,
                        troughChartBar: barIndex,
                        troughChartTime: candle.time,
                        lastCandleTime: candle.time,
                        barCount: 1,
                        isCorrupt: false
                    }
                    : null
            },
            events: [],
            confirmedPivot: null
        };
    }

    // 2. Defense-in-Depth Corrupt/Abandoned Bucket Check
    let cbcState = state.cbcState;
    let prevPivot = state.prevPivot;
    let htfBarIndex = state.htfBarIndex;
    let phaseHighChart = state.phaseHighChart;
    let phaseLowChart = state.phaseLowChart;
    let dir = state.dir;
    let tDir = state.tDir;
    let t = state.t;
    let b = state.b;
    let bosUpCheck = state.bosUpCheck;
    let bosDownCheck = state.bosDownCheck;
    let prevHtfClose = state.prevHtfClose;
    let activeBucket = state.formingBucket;
    let activeZonesSource: readonly DTFXStrictCBCActiveZone[] = state.activeZones;

    if (activeBucket !== null && bucketStart > activeBucket.bucketStart) {
        cbcState = null;
        prevPivot = null;
        htfBarIndex = 0;
        phaseHighChart = null;
        phaseLowChart = null;
        dir = 0;
        tDir = 0;
        t = null;
        b = null;
        bosUpCheck = false;
        bosDownCheck = false;
        prevHtfClose = null;
        activeZonesSource = [];
        activeBucket = null;
    }

    // 3. Causal 1m Retests & Invalidation on Surviving Active Zones
    const emittedEvents: DTFXStrictCBCTeacherEvent[] = [];
    const updatedZones: DTFXStrictCBCActiveZone[] = [];

    for (const z of activeZonesSource) {
        if (z.direction === 'bull') {
            if (candle.close < z.zoneBot) continue;
            const touchedZone = candle.low <= z.zoneTop;
            const outsideNow = candle.low > z.zoneTop;

            if (
                config.emitRetests &&
                touchedZone &&
                z.wasOutsideSinceLastEvent &&
                z.retestCount < config.maxRetestsPerZone &&
                barIndex > z.createdConfirmationBarIndex &&
                barIndex > z.lastRetestBarIndex
            ) {
                const nextZone: DTFXStrictCBCActiveZone = {
                    ...z,
                    retestCount: z.retestCount + 1,
                    wasOutsideSinceLastEvent: false,
                    lastRetestBarIndex: barIndex
                };
                emittedEvents.push(makeZoneEvent(config, nextZone, 'RETESTED', barIndex, candle.time, candle.close, atr14));
                updatedZones.push(nextZone);
            } else {
                updatedZones.push({
                    ...z,
                    wasOutsideSinceLastEvent: z.wasOutsideSinceLastEvent || outsideNow
                });
            }
        } else {
            if (candle.close > z.zoneTop) continue;
            const touchedZone = candle.high >= z.zoneBot;
            const outsideNow = candle.high < z.zoneBot;

            if (
                config.emitRetests &&
                touchedZone &&
                z.wasOutsideSinceLastEvent &&
                z.retestCount < config.maxRetestsPerZone &&
                barIndex > z.createdConfirmationBarIndex &&
                barIndex > z.lastRetestBarIndex
            ) {
                const nextZone: DTFXStrictCBCActiveZone = {
                    ...z,
                    retestCount: z.retestCount + 1,
                    wasOutsideSinceLastEvent: false,
                    lastRetestBarIndex: barIndex
                };
                emittedEvents.push(makeZoneEvent(config, nextZone, 'RETESTED', barIndex, candle.time, candle.close, atr14));
                updatedZones.push(nextZone);
            } else {
                updatedZones.push({
                    ...z,
                    wasOutsideSinceLastEvent: z.wasOutsideSinceLastEvent || outsideNow
                });
            }
        }
    }

    // 4. Accumulate HTF Bucket
    if (activeBucket === null) {
        if (candle.time === bucketStart) {
            activeBucket = {
                bucketStart,
                open: candle.open,
                high: candle.high,
                low: candle.low,
                close: candle.close,
                peakChartBar: barIndex,
                peakChartTime: candle.time,
                troughChartBar: barIndex,
                troughChartTime: candle.time,
                lastCandleTime: candle.time,
                barCount: 1,
                isCorrupt: false
            };
        }
    } else if (bucketStart === activeBucket.bucketStart && !activeBucket.isCorrupt) {
        const newHigh = candle.high > activeBucket.high;
        const newLow = candle.low < activeBucket.low;
        activeBucket = {
            ...activeBucket,
            high: newHigh ? candle.high : activeBucket.high,
            low: newLow ? candle.low : activeBucket.low,
            close: candle.close,
            peakChartBar: newHigh ? barIndex : activeBucket.peakChartBar,
            peakChartTime: newHigh ? candle.time : activeBucket.peakChartTime,
            troughChartBar: newLow ? barIndex : activeBucket.troughChartBar,
            troughChartTime: newLow ? candle.time : activeBucket.troughChartTime,
            lastCandleTime: candle.time,
            barCount: activeBucket.barCount + 1
        };
    }

    const expectedCloseTime = bucketStart + config.zoneIntervalMs - config.baseIntervalMs;
    const isBucketComplete =
        activeBucket !== null &&
        !activeBucket.isCorrupt &&
        activeBucket.barCount === config.expectedBarsPerBucket &&
        candle.time === expectedCloseTime;

    if (!isBucketComplete) {
        return {
            nextState: {
                cbcState,
                prevPivot,
                htfBarIndex,
                formingBucket: activeBucket,
                phaseHighChart,
                phaseLowChart,
                dir,
                tDir,
                t,
                b,
                bosUpCheck,
                bosDownCheck,
                prevHtfClose,
                nextZoneId: state.nextZoneId,
                activeZones: updatedZones,
                lastProcessedTimestamp: candle.time,
                lastProcessedBarIndex: barIndex
            },
            events: emittedEvents,
            confirmedPivot: null
        };
    }

    // 5. Completed HTF Bucket -> Step Canonical StrictCBC & DTFX MSS Zone Creation
    const stepped = stepCompletedHtfBucket(activeBucket!, barIndex, candle.time, atr14, config, {
        cbcState,
        prevPivot,
        htfBarIndex,
        phaseHighChart,
        phaseLowChart,
        dir,
        tDir,
        t,
        b,
        bosUpCheck,
        bosDownCheck,
        prevHtfClose,
        nextZoneId: state.nextZoneId,
        activeZones: updatedZones
    });

    return {
        nextState: stepped.nextState,
        events: [...emittedEvents, ...stepped.createdEvents],
        confirmedPivot: stepped.confirmedPivot
    };
}

// =========================================================================
// Multi-Timeframe Coordinator (1m, 3m, 5m, 15m selectable independently)
// =========================================================================

export type DTFXStrictCBCMultiState = Readonly<Record<DTFXStrictCBCTimeframe, DTFXStrictCBCState>>;

export function createDefaultDTFXStrictCBCMultiConfigs(
    symbol: string,
    baseTimeframe: string,
    baseIntervalMs: number,
    timeframes: readonly DTFXStrictCBCTimeframe[],
    options?: { maxActiveZones?: number; maxRetestsPerZone?: number; emitRetests?: boolean }
): DTFXStrictCBCConfig[] {
    const uniqueTfs = Array.from(new Set(timeframes));
    return uniqueTfs.map(tf =>
        createDefaultDTFXStrictCBCConfig(symbol, baseTimeframe, baseIntervalMs, tf, options)
    );
}

export function createInitialDTFXStrictCBCMultiState(): DTFXStrictCBCMultiState {
    return {
        '1m': createInitialDTFXStrictCBCState(),
        '3m': createInitialDTFXStrictCBCState(),
        '5m': createInitialDTFXStrictCBCState(),
        '15m': createInitialDTFXStrictCBCState()
    };
}

export function stepDTFXStrictCBCMulti(
    candle: ML1Candle,
    barIndex: number,
    state: DTFXStrictCBCMultiState,
    configs: readonly DTFXStrictCBCConfig[],
    isDiscontinuity: boolean,
    atr14: number | null
): {
    readonly nextState: DTFXStrictCBCMultiState;
    readonly events: readonly DTFXStrictCBCTeacherEvent[];
} {
    const mutableState: Record<DTFXStrictCBCTimeframe, DTFXStrictCBCState> = { ...state };
    const allEvents: DTFXStrictCBCTeacherEvent[] = [];

    for (const cfg of configs) {
        const res = stepDTFXStrictCBC(
            candle,
            barIndex,
            mutableState[cfg.zoneTimeframe],
            cfg,
            isDiscontinuity,
            atr14
        );
        mutableState[cfg.zoneTimeframe] = res.nextState;
        allEvents.push(...res.events);
    }

    allEvents.sort((a, b) =>
        a.confirmationBarIndex - b.confirmationBarIndex ||
        a.eventType.localeCompare(b.eventType) ||
        a.eventDiscriminator.localeCompare(b.eventDiscriminator)
    );

    return { nextState: mutableState, events: allEvents };
}
