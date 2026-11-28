import type { ML1Candle } from '../ML1FeatureTypes';
import {
    type StrictCBCCandle,
    type StrictCBCState,
    type StrictZigZagPivot
} from '../../plugins/StrictCBCZigZagIndicator';
import { stepStrictCBCWithReset } from './StrategyEventTypes';
import {
    buildV5DtfxRetestEpisodeId,
    buildV5ZoneId,
    computeV5DepthMetrics,
    validateV5ZoneLifecycleRecord,
    type V5Direction,
    type V5DTFXLifecycleEventType,
    type V5ZoneActivityState,
    type V5ZoneTimeframe,
    type V5ZoneLifecycleRecord
} from '../pipeline/V5OutcomeContracts';

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

// =========================================================================
// V4 Contract (1m, 3m, 5m Only — 15m Excluded)
// =========================================================================
export type V4DTFXStrictCBCTimeframe = '1m' | '3m' | '5m';

export const V4_DTFX_STRICTCBC_TIMEFRAMES: readonly V4DTFXStrictCBCTimeframe[] = Object.freeze([
    '1m',
    '3m',
    '5m'
]);

export function createDefaultV4DTFXStrictCBCMultiConfigs(
    symbol: string,
    baseTimeframe: string,
    baseIntervalMs: number,
    timeframes: readonly V4DTFXStrictCBCTimeframe[] = V4_DTFX_STRICTCBC_TIMEFRAMES,
    options?: { maxActiveZones?: number; maxRetestsPerZone?: number; emitRetests?: boolean }
): DTFXStrictCBCConfig[] {
    if (!Array.isArray(timeframes) || timeframes.length === 0) {
        throw new Error('V4 DTFXStrictCBC Config Error: timeframes must be a non-empty array of 1m/3m/5m.');
    }
    const allowed = new Set<string>(V4_DTFX_STRICTCBC_TIMEFRAMES);
    const seen = new Set<string>();
    for (const tf of timeframes) {
        if (!allowed.has(tf)) {
            throw new Error(`V4 DTFXStrictCBC Config Error: unsupported timeframe '${String(tf)}' (15m excluded in V4).`);
        }
        if (seen.has(tf)) {
            throw new Error(`V4 DTFXStrictCBC Config Error: duplicate timeframe '${tf}'.`);
        }
        seen.add(tf);
    }
    return createDefaultDTFXStrictCBCMultiConfigs(symbol, baseTimeframe, baseIntervalMs, timeframes, options);
}

// =========================================================================
// V5 Lifecycle Extension (Preserves V4 Logic; Captures Breaks, Evictions & Gaps)
// =========================================================================

export interface V5DTFXZoneMeta {
    readonly v5ZoneId: string;
    readonly numericZoneId: number;
    readonly symbol: string;
    readonly zoneTimeframe: V5ZoneTimeframe;
    readonly zoneSide: 'DEMAND' | 'SUPPLY';
    readonly zoneDirection: V5Direction;
    readonly isChoch: boolean;
    readonly zoneTop: number;
    readonly zoneBot: number;
    readonly fib03: number;
    readonly fib05: number;
    readonly fib07: number;
    readonly createdSourceBarIndex: number;
    readonly createdSourceTimestamp: number;
    readonly createdBaseBarIndex: number;
    readonly createdConfirmationTimestamp: number;
    readonly createdNativeBarIndex: number;
    readonly v5RetestCount: number;
    readonly v5WasOutsideSinceLastEvent: boolean;
    readonly v5LastRetestBaseBarIndex: number;
}

export interface V5DTFXLifecycleEvent extends V5ZoneLifecycleRecord {
    readonly source: 'DTFX_STRICTCBC';
    readonly zoneSide: 'DEMAND' | 'SUPPLY';
    readonly eventType: V5DTFXLifecycleEventType;
    readonly isChoch: boolean;
    readonly fib03: number;
    readonly fib05: number;
    readonly fib07: number;
    readonly createdSourceBarIndex: number;
    readonly touchExtremePrice: number | null;
    readonly eventClosePrice: number;
}

export interface V5DTFXActiveZoneView {
    readonly meta: V5DTFXZoneMeta;
    readonly retestCount: number;
    readonly wasOutsideSinceLastEvent: boolean;
    readonly zoneAgeBaseBars: number;
    readonly zoneAgeHtfBars: number;
}

export interface V5DTFXStrictCBCState {
    readonly cbcState: DTFXStrictCBCState;
    readonly zoneMetaByNumericId: Readonly<Record<number, V5DTFXZoneMeta>>;
    readonly historicalDemandBreakCount: number;
    readonly historicalSupplyBreakCount: number;
}

export type V5DTFXStrictCBCMultiState = Readonly<Record<V5ZoneTimeframe, V5DTFXStrictCBCState>>;

export const V5_DTFX_STRICTCBC_TIMEFRAMES: readonly V5ZoneTimeframe[] = Object.freeze(['1m', '3m', '5m']);

export function createDefaultV5DTFXStrictCBCMultiConfigs(
    symbol: string,
    baseTimeframe: string,
    baseIntervalMs: number,
    timeframes: readonly V5ZoneTimeframe[] = V5_DTFX_STRICTCBC_TIMEFRAMES,
    options?: { maxActiveZones?: number }
): DTFXStrictCBCConfig[] {
    if (!Array.isArray(timeframes) || timeframes.length === 0) {
        throw new Error('V5 DTFX Config Error: timeframes must be a non-empty array of 1m/3m/5m.');
    }
    const allowed = new Set<string>(V5_DTFX_STRICTCBC_TIMEFRAMES);
    const seen = new Set<string>();
    for (const tf of timeframes) {
        if (!allowed.has(tf)) {
            throw new Error(`V5 DTFX Config Error: unsupported timeframe '${String(tf)}'.`);
        }
        if (seen.has(tf)) {
            throw new Error(`V5 DTFX Config Error: duplicate timeframe '${tf}'.`);
        }
        seen.add(tf);
    }
    const maxActiveZones = options?.maxActiveZones ?? 100;
    if (!Number.isSafeInteger(maxActiveZones) || maxActiveZones < 1) {
        throw new Error(`V5 DTFX Config Error: maxActiveZones must be >= 1, got ${maxActiveZones}.`);
    }
    // Unlimited retest episode counting (never silently stops after 3)
    return createDefaultDTFXStrictCBCMultiConfigs(symbol, baseTimeframe, baseIntervalMs, timeframes, {
        maxActiveZones,
        maxRetestsPerZone: Number.MAX_SAFE_INTEGER,
        emitRetests: true
    });
}

export function createInitialV5DTFXStrictCBCState(): V5DTFXStrictCBCState {
    return Object.freeze({
        cbcState: createInitialDTFXStrictCBCState(),
        zoneMetaByNumericId: Object.freeze({}),
        historicalDemandBreakCount: 0,
        historicalSupplyBreakCount: 0
    });
}

export function createInitialV5DTFXStrictCBCMultiState(): V5DTFXStrictCBCMultiState {
    return Object.freeze({
        '1m': createInitialV5DTFXStrictCBCState(),
        '3m': createInitialV5DTFXStrictCBCState(),
        '5m': createInitialV5DTFXStrictCBCState()
    });
}

export function assertV5DTFXStrictCBCStateConsistency(
    state: V5DTFXStrictCBCState,
    config: DTFXStrictCBCConfig
): void {
    const activeZones = state.cbcState.activeZones;
    const metaKeys = Object.keys(state.zoneMetaByNumericId);
    if (metaKeys.length !== activeZones.length) {
        throw new Error(
            `V5 DTFX Consistency Error: metadata count (${metaKeys.length}) !== activeZones count (${activeZones.length}).`
        );
    }
    const seenV5Ids = new Set<string>();
    for (const z of activeZones) {
        const meta = state.zoneMetaByNumericId[z.zoneId];
        if (!meta) {
            throw new Error(`V5 DTFX Consistency Error: active zoneId ${z.zoneId} missing metadata.`);
        }
        if (meta.symbol !== config.symbol || meta.zoneTimeframe !== config.zoneTimeframe) {
            throw new Error(`V5 DTFX Consistency Error: zone ${meta.v5ZoneId} symbol/tf mismatch.`);
        }
        if (!Number.isFinite(meta.zoneTop) || !Number.isFinite(meta.zoneBot) || meta.zoneTop <= meta.zoneBot ||
            meta.zoneTop !== z.zoneTop || meta.zoneBot !== z.zoneBot) {
            throw new Error(`V5 DTFX Consistency Error: zone ${meta.v5ZoneId} bounds mismatch.`);
        }
        if (!Number.isSafeInteger(meta.v5RetestCount) || meta.v5RetestCount < z.retestCount) {
            throw new Error(`V5 DTFX Consistency Error: zone ${meta.v5ZoneId} v5RetestCount (${meta.v5RetestCount}) < canonical (${z.retestCount}).`);
        }
        if (seenV5Ids.has(meta.v5ZoneId)) {
            throw new Error(`V5 DTFX Consistency Error: duplicate v5ZoneId '${meta.v5ZoneId}'.`);
        }
        seenV5Ids.add(meta.v5ZoneId);
    }
}

function buildV5DTFXLifecycleEvent(params: {
    readonly meta: V5DTFXZoneMeta;
    readonly eventType: V5DTFXLifecycleEventType;
    readonly zoneActivity: V5ZoneActivityState;
    readonly eventDirection: V5Direction | null;
    readonly retestCount: number;
    readonly barIndex: number;
    readonly completedNativeCount: number;
    readonly candle: ML1Candle;
    readonly atr14: number | null;
    readonly touchExtremePrice: number | null;
}): V5DTFXLifecycleEvent {
    const {
        meta, eventType, zoneActivity, eventDirection, retestCount,
        barIndex, completedNativeCount, candle, atr14, touchExtremePrice
    } = params;

    const atr14Valid = atr14 !== null && Number.isFinite(atr14) && atr14 > 0;
    const zoneWidthAtr = atr14Valid ? (meta.zoneTop - meta.zoneBot) / atr14! : null;

    const closeDepth = computeV5DepthMetrics(meta.zoneTop, meta.zoneBot, candle.close, meta.zoneDirection);
    const touchDepth = touchExtremePrice !== null
        ? computeV5DepthMetrics(meta.zoneTop, meta.zoneBot, touchExtremePrice, meta.zoneDirection)
        : null;

    const confirmationNativeBarIndex = Math.max(meta.createdNativeBarIndex, completedNativeCount - 1);
    const retestEpisodeId = eventType === 'RETESTED'
        ? buildV5DtfxRetestEpisodeId(meta.v5ZoneId, retestCount, candle.time)
        : null;
    const lifecycleSuffix = eventType === 'RETESTED' ? `RETESTED:R${retestCount}` : eventType;
    const lifecycleId = `${meta.v5ZoneId}:${lifecycleSuffix}:${barIndex}`;

    const record: V5DTFXLifecycleEvent = Object.freeze({
        lifecycleId,
        zoneId: meta.v5ZoneId,
        symbol: meta.symbol,
        source: 'DTFX_STRICTCBC' as const,
        zoneTimeframe: meta.zoneTimeframe,
        zoneSide: meta.zoneSide,
        zoneDirection: meta.zoneDirection,
        eventType,
        eventDirection,
        zoneActivity,
        eventRole: 'ZONE_LIFECYCLE' as const,
        outcomeEligible: false as const,
        retestCount,
        retestEpisodeId,
        zoneTop: meta.zoneTop,
        zoneBot: meta.zoneBot,
        createdSourceTimestamp: meta.createdSourceTimestamp,
        createdConfirmationTimestamp: meta.createdConfirmationTimestamp,
        confirmationTimestamp: candle.time,
        createdBaseBarIndex: meta.createdBaseBarIndex,
        confirmationBaseBarIndex: barIndex,
        createdNativeBarIndex: meta.createdNativeBarIndex,
        confirmationNativeBarIndex,
        zoneAgeBaseBars: barIndex - meta.createdBaseBarIndex,
        zoneAgeNativeBars: confirmationNativeBarIndex - meta.createdNativeBarIndex,
        touchDepthNormRaw: touchDepth ? touchDepth.raw : null,
        touchDepthNormClamped: touchDepth ? touchDepth.clamped : null,
        closeDepthNormRaw: closeDepth.raw,
        closeDepthNormClamped: closeDepth.clamped,
        atr14Valid,
        zoneWidthAtr,
        supersededByZoneId: null,
        isChoch: meta.isChoch,
        fib03: meta.fib03,
        fib05: meta.fib05,
        fib07: meta.fib07,
        createdSourceBarIndex: meta.createdSourceBarIndex,
        touchExtremePrice,
        eventClosePrice: candle.close
    });

    validateV5ZoneLifecycleRecord(record);
    return record;
}

/**
 * Classifies explicit and inferred discontinuities before stepping canonical state.
 * Note: confirmationNativeBarIndex always represents the 0-based index of the most
 * recently COMPLETED native-timeframe candle (it never advances mid-bucket).
 */
export function classifyV5DTFXDiscontinuity(
    candle: ML1Candle,
    prevCbc: DTFXStrictCBCState,
    config: DTFXStrictCBCConfig,
    isDiscontinuity: boolean
): {
    readonly effectiveDiscontinuity: boolean;
    readonly explicitDiscontinuity: boolean;
    readonly hasMissingBaseCandle: boolean;
    readonly isGenuineIncompleteBucket: boolean;
} {
    const validTs = Number.isSafeInteger(candle?.time) && candle.time > 0 && candle.time % config.baseIntervalMs === 0;
    const bucketStart = validTs ? Math.floor(candle.time / config.zoneIntervalMs) * config.zoneIntervalMs : 0;
    const hasMissingBaseCandle =
        validTs &&
        prevCbc.lastProcessedTimestamp !== null &&
        candle.time > prevCbc.lastProcessedTimestamp &&
        candle.time !== prevCbc.lastProcessedTimestamp + config.baseIntervalMs;
    const isGenuineIncompleteBucket =
        validTs &&
        prevCbc.formingBucket !== null &&
        bucketStart > prevCbc.formingBucket.bucketStart &&
        prevCbc.formingBucket.lastCandleTime <
            prevCbc.formingBucket.bucketStart + config.zoneIntervalMs - config.baseIntervalMs;
    return Object.freeze({
        effectiveDiscontinuity: isDiscontinuity || hasMissingBaseCandle || isGenuineIncompleteBucket,
        explicitDiscontinuity: isDiscontinuity,
        hasMissingBaseCandle,
        isGenuineIncompleteBucket
    });
}

export function stepDTFXStrictCBCV5(
    candle: ML1Candle,
    barIndex: number,
    state: V5DTFXStrictCBCState,
    config: DTFXStrictCBCConfig,
    isDiscontinuity: boolean,
    atr14: number | null
): {
    readonly nextState: V5DTFXStrictCBCState;
    readonly lifecycleEvents: readonly V5DTFXLifecycleEvent[];
} {
    if (config.zoneTimeframe === '15m') {
        throw new Error('V5 DTFX Error: 15m timeframe is excluded in V5.');
    }
    if (!config.emitRetests) {
        throw new Error('V5 DTFX Error: config.emitRetests must be true in V5.');
    }
    const zoneTf = config.zoneTimeframe as V5ZoneTimeframe;
    const prevCbc = state.cbcState;
    assertV5DTFXStrictCBCStateConsistency(state, config);

    // 1. Classify explicit and inferred discontinuities safely before canonical step
    const { effectiveDiscontinuity } = classifyV5DTFXDiscontinuity(candle, prevCbc, config, isDiscontinuity);

    // 2. Pass effectiveDiscontinuity INTO canonical step so canonical activeZones & V5 metadata reset together
    const stepRes = stepDTFXStrictCBC(candle, barIndex, prevCbc, config, effectiveDiscontinuity, atr14);
    const nextCbc = stepRes.nextState;

    const lifecycleEvents: V5DTFXLifecycleEvent[] = [];
    let demandBreaks = state.historicalDemandBreakCount;
    let supplyBreaks = state.historicalSupplyBreakCount;

    // 3. Discontinuity / gap reset: confirm canonical activeZones cleared, emit GAP_RESET (eventDirection: null)
    if (effectiveDiscontinuity) {
        if (nextCbc.activeZones.length !== 0) {
            throw new Error(
                `V5 DTFX Gap Reset Error: canonical state failed to clear ${nextCbc.activeZones.length} activeZones on discontinuity.`
            );
        }
        for (const prevZ of prevCbc.activeZones) {
            const meta = state.zoneMetaByNumericId[prevZ.zoneId];
            lifecycleEvents.push(buildV5DTFXLifecycleEvent({
                meta,
                eventType: 'GAP_RESET',
                zoneActivity: 'GAP_RESET',
                eventDirection: null,
                retestCount: meta.v5RetestCount,
                barIndex,
                completedNativeCount: prevCbc.htfBarIndex,
                candle,
                atr14,
                touchExtremePrice: null
            }));
        }
        const resetState: V5DTFXStrictCBCState = Object.freeze({
            cbcState: nextCbc,
            zoneMetaByNumericId: Object.freeze({}),
            historicalDemandBreakCount: demandBreaks,
            historicalSupplyBreakCount: supplyBreaks
        });
        assertV5DTFXStrictCBCStateConsistency(resetState, config);
        return {
            nextState: resetState,
            lifecycleEvents: Object.freeze(lifecycleEvents)
        };
    }

    // 4. Explicit canonical event classification without overwriting
    const retestsByZoneId = new Map<number, DTFXStrictCBCTeacherEvent[]>();
    const createdEvents: DTFXStrictCBCTeacherEvent[] = [];
    for (const ev of stepRes.events) {
        const zId = ev.structuralContext.zoneId;
        if (ev.eventType === 'DTFX_CBC_DEMAND_CREATED' || ev.eventType === 'DTFX_CBC_SUPPLY_CREATED') {
            if (ev.structuralContext.zoneStatus !== 'CREATED') {
                throw new Error(`V5 DTFX Event Error: '${ev.eventType}' disagrees with zoneStatus.`);
            }
            createdEvents.push(ev);
        } else if (ev.eventType === 'DTFX_CBC_DEMAND_RETEST' || ev.eventType === 'DTFX_CBC_SUPPLY_RETEST') {
            if (ev.structuralContext.zoneStatus !== 'RETESTED') {
                throw new Error(`V5 DTFX Event Error: '${ev.eventType}' disagrees with zoneStatus.`);
            }
            const bucket = retestsByZoneId.get(zId) ?? [];
            bucket.push(ev);
            if (bucket.length > 1) {
                throw new Error(`V5 DTFX Event Error: multiple retests emitted for zoneId ${zId} on bar ${barIndex}.`);
            }
            retestsByZoneId.set(zId, bucket);
        } else {
            throw new Error(`V5 DTFX Event Error: unexpected canonical eventType '${String(ev.eventType)}'.`);
        }
    }

    const nextActiveById = new Map<number, DTFXStrictCBCActiveZone>();
    for (const nz of nextCbc.activeZones) {
        nextActiveById.set(nz.zoneId, nz);
    }

    const nextMetaMutable: Record<number, V5DTFXZoneMeta> = {};

    // 5. Process BROKEN, EVICTED, and uncapped RETESTED on prior active zones
    for (const prevZ of prevCbc.activeZones) {
        const meta = state.zoneMetaByNumericId[prevZ.zoneId];

        const brokeOnBar = prevZ.direction === 'bull'
            ? candle.close < prevZ.zoneBot
            : candle.close > prevZ.zoneTop;

        if (brokeOnBar) {
            if (retestsByZoneId.has(prevZ.zoneId)) {
                throw new Error(`V5 DTFX Event Error: broken zone ${prevZ.zoneId} also emitted a retest on bar ${barIndex}.`);
            }
            if (prevZ.direction === 'bull') demandBreaks++;
            else supplyBreaks++;

            lifecycleEvents.push(buildV5DTFXLifecycleEvent({
                meta,
                eventType: 'BROKEN',
                zoneActivity: 'BROKEN',
                eventDirection: prevZ.direction === 'bull' ? 'bear' : 'bull',
                retestCount: meta.v5RetestCount,
                barIndex,
                completedNativeCount: nextCbc.htfBarIndex,
                candle,
                atr14,
                touchExtremePrice: null
            }));
            continue;
        }

        const surviving = nextActiveById.get(prevZ.zoneId);
        if (!surviving) {
            lifecycleEvents.push(buildV5DTFXLifecycleEvent({
                meta,
                eventType: 'EVICTED',
                zoneActivity: 'EVICTED',
                eventDirection: null,
                retestCount: meta.v5RetestCount,
                barIndex,
                completedNativeCount: nextCbc.htfBarIndex,
                candle,
                atr14,
                touchExtremePrice: null
            }));
            continue;
        }

        // Independent uncapped V5 retest episode tracker with explicit range-intersection check
        const touchedZone = candle.high >= meta.zoneBot && candle.low <= meta.zoneTop;
        const outsideNow = meta.zoneDirection === 'bull'
            ? candle.low > meta.zoneTop
            : candle.high < meta.zoneBot;
        const v5RetestTriggered =
            touchedZone &&
            meta.v5WasOutsideSinceLastEvent &&
            barIndex > meta.createdBaseBarIndex &&
            barIndex > meta.v5LastRetestBaseBarIndex;

        const canonicalRetestTriggered = retestsByZoneId.has(prevZ.zoneId);
        if (meta.v5RetestCount < config.maxRetestsPerZone && canonicalRetestTriggered !== v5RetestTriggered) {
            throw new Error(
                `V5 DTFX Parity Error: canonical retest (${canonicalRetestTriggered}) != V5 episode (${v5RetestTriggered}) on zone ${meta.v5ZoneId} bar ${barIndex}.`
            );
        }

        if (v5RetestTriggered) {
            const nextCount = meta.v5RetestCount + 1;
            const updatedMeta: V5DTFXZoneMeta = Object.freeze({
                ...meta,
                v5RetestCount: nextCount,
                v5WasOutsideSinceLastEvent: false,
                v5LastRetestBaseBarIndex: barIndex
            });
            nextMetaMutable[prevZ.zoneId] = updatedMeta;

            const touchExtreme = meta.zoneDirection === 'bull' ? candle.low : candle.high;
            lifecycleEvents.push(buildV5DTFXLifecycleEvent({
                meta: updatedMeta,
                eventType: 'RETESTED',
                zoneActivity: 'ACTIVE',
                eventDirection: updatedMeta.zoneDirection,
                retestCount: nextCount,
                barIndex,
                completedNativeCount: nextCbc.htfBarIndex,
                candle,
                atr14,
                touchExtremePrice: touchExtreme
            }));
        } else {
            nextMetaMutable[prevZ.zoneId] = Object.freeze({
                ...meta,
                v5WasOutsideSinceLastEvent: meta.v5WasOutsideSinceLastEvent || outsideNow
            });
        }
    }

    // 6. Register newly CREATED zones (handles immediate same-bar eviction if capacity reached)
    for (const ev of createdEvents) {
        const ctx = ev.structuralContext;
        const zId = ctx.zoneId;
        const zoneDirection = ev.eventDirection;
        const zoneSide: 'DEMAND' | 'SUPPLY' = zoneDirection === 'bull' ? 'DEMAND' : 'SUPPLY';
        const v5ZoneId = buildV5ZoneId({
            symbol: config.symbol,
            source: 'DTFX_STRICTCBC',
            timeframe: zoneTf,
            side: zoneSide,
            createdSourceTimestamp: ev.sourceTimestamp,
            createdConfirmationTimestamp: ev.confirmationTimestamp
        });

        const newMeta: V5DTFXZoneMeta = Object.freeze({
            v5ZoneId,
            numericZoneId: zId,
            symbol: config.symbol,
            zoneTimeframe: zoneTf,
            zoneSide,
            zoneDirection,
            isChoch: ctx.isChoch,
            zoneTop: ctx.zoneTop,
            zoneBot: ctx.zoneBot,
            fib03: ctx.fib03,
            fib05: ctx.fib05,
            fib07: ctx.fib07,
            createdSourceBarIndex: ctx.zoneCreatedSourceBarIndex,
            createdSourceTimestamp: ev.sourceTimestamp,
            createdBaseBarIndex: ctx.zoneCreatedConfirmationBarIndex,
            createdConfirmationTimestamp: ev.confirmationTimestamp,
            createdNativeBarIndex: Math.max(0, nextCbc.htfBarIndex - 1),
            v5RetestCount: 0,
            v5WasOutsideSinceLastEvent: zoneDirection === 'bull'
                ? candle.close > ctx.zoneTop
                : candle.close < ctx.zoneBot,
            v5LastRetestBaseBarIndex: -1
        });

        lifecycleEvents.push(buildV5DTFXLifecycleEvent({
            meta: newMeta,
            eventType: 'CREATED',
            zoneActivity: 'ACTIVE',
            eventDirection: newMeta.zoneDirection,
            retestCount: 0,
            barIndex,
            completedNativeCount: nextCbc.htfBarIndex,
            candle,
            atr14,
            touchExtremePrice: null
        }));

        if (nextActiveById.has(zId)) {
            nextMetaMutable[zId] = newMeta;
        } else {
            lifecycleEvents.push(buildV5DTFXLifecycleEvent({
                meta: newMeta,
                eventType: 'EVICTED',
                zoneActivity: 'EVICTED',
                eventDirection: null,
                retestCount: 0,
                barIndex,
                completedNativeCount: nextCbc.htfBarIndex,
                candle,
                atr14,
                touchExtremePrice: null
            }));
        }
    }

    const nextState: V5DTFXStrictCBCState = Object.freeze({
        cbcState: nextCbc,
        zoneMetaByNumericId: Object.freeze(nextMetaMutable),
        historicalDemandBreakCount: demandBreaks,
        historicalSupplyBreakCount: supplyBreaks
    });
    assertV5DTFXStrictCBCStateConsistency(nextState, config);

    return {
        nextState,
        lifecycleEvents: Object.freeze(lifecycleEvents)
    };
}

export function stepDTFXStrictCBCV5Multi(
    candle: ML1Candle,
    barIndex: number,
    state: V5DTFXStrictCBCMultiState,
    configs: readonly DTFXStrictCBCConfig[],
    isDiscontinuity: boolean,
    atr14: number | null
): {
    readonly nextState: V5DTFXStrictCBCMultiState;
    readonly lifecycleEvents: readonly V5DTFXLifecycleEvent[];
} {
    if (!Array.isArray(configs as unknown) || configs.length === 0) {
        throw new Error('V5 DTFX Multi Error: configs must be non-empty.');
    }
    const baseSymbol = configs[0].symbol;
    const seenTfs = new Set<V5ZoneTimeframe>();
    const mutableState: Record<V5ZoneTimeframe, V5DTFXStrictCBCState> = { ...state };
    const allEvents: V5DTFXLifecycleEvent[] = [];

    for (const cfg of configs) {
        if (cfg.zoneTimeframe === '15m') {
            throw new Error('V5 DTFX Multi Error: 15m timeframe is excluded in V5.');
        }
        if (cfg.symbol !== baseSymbol) {
            throw new Error(`V5 DTFX Multi Error: mixed symbols '${cfg.symbol}' vs '${baseSymbol}'.`);
        }
        const tf = cfg.zoneTimeframe as V5ZoneTimeframe;
        if (seenTfs.has(tf)) {
            throw new Error(`V5 DTFX Multi Error: duplicate timeframe '${tf}'.`);
        }
        seenTfs.add(tf);
        const res = stepDTFXStrictCBCV5(candle, barIndex, mutableState[tf], cfg, isDiscontinuity, atr14);
        mutableState[tf] = res.nextState;
        allEvents.push(...res.lifecycleEvents);
    }

    allEvents.sort((a, b) =>
        a.confirmationBaseBarIndex - b.confirmationBaseBarIndex ||
        a.zoneTimeframe.localeCompare(b.zoneTimeframe) ||
        a.eventType.localeCompare(b.eventType) ||
        a.lifecycleId.localeCompare(b.lifecycleId)
    );

    return {
        nextState: Object.freeze(mutableState),
        lifecycleEvents: Object.freeze(allEvents)
    };
}

export function getV5DTFXActiveZoneViews(
    multiState: V5DTFXStrictCBCMultiState,
    currentBarIndex: number,
    timeframes: readonly V5ZoneTimeframe[] = V5_DTFX_STRICTCBC_TIMEFRAMES
): readonly V5DTFXActiveZoneView[] {
    const views: V5DTFXActiveZoneView[] = [];
    for (const tf of timeframes) {
        const tfState = multiState[tf];
        const currentNativeIdx = Math.max(0, tfState.cbcState.htfBarIndex - 1);
        for (const z of tfState.cbcState.activeZones) {
            const meta = tfState.zoneMetaByNumericId[z.zoneId];
            if (!meta) {
                throw new Error(`V5 DTFX View Error: missing metadata for active zoneId ${z.zoneId} on ${tf}.`);
            }
            views.push(Object.freeze({
                meta,
                retestCount: meta.v5RetestCount,
                wasOutsideSinceLastEvent: meta.v5WasOutsideSinceLastEvent,
                zoneAgeBaseBars: currentBarIndex - meta.createdBaseBarIndex,
                zoneAgeHtfBars: currentNativeIdx - meta.createdNativeBarIndex
            }));
        }
    }
    return Object.freeze(views);
}
