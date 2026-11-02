import type {
    HTFAggregationState,
    MTFCandle,
    HTFIncompleteDiagnostic,
    HTFWindowCompleteness,
    MTFState
} from './MTFTypes';
import type { MTFTimeframeConfig, ValidatedMTFGlobalConfig } from './MTFConfig';
import type { ML1Candle } from '../ML1FeatureTypes';
import { createInitialMTFState, getUTCWindowBoundaries, isSourceTimestampInWindow } from './MTFState';

export interface HTFAggregationStepResult {
    readonly nextState: HTFAggregationState;
    readonly completedCandle: MTFCandle | null;
    readonly diagnostic: HTFIncompleteDiagnostic | null;
}

export interface MTFAggregatorStepResult {
    readonly nextState: MTFState;
    readonly completed15m: MTFCandle | null;
    readonly diagnostic15m: HTFIncompleteDiagnostic | null;
    readonly completed1h: MTFCandle | null;
    readonly diagnostic1h: HTFIncompleteDiagnostic | null;
}

/**
 * Pure Single-Timeframe Aggregation Step.
 * Evaluates window closure, enforces 15/60 exact source completeness,
 * and executes REJECT_AND_RESET upon any missing or corrupt source record.
 */
export function stepHTFAggregation(
    candle: ML1Candle,
    isSourceValid: boolean,
    previousState: HTFAggregationState,
    config: MTFTimeframeConfig
): HTFAggregationStepResult {
    const durationMs = config.durationMs;
    const expectedCount = Math.round(durationMs / 60_000);

    let completedCandle: MTFCandle | null = null;
    let diagnostic: HTFIncompleteDiagnostic | null = null;
    let lastCompleted = previousState.lastCompletedCandle;
    let lastDiag = previousState.lastDiagnostic;

    const currentWinOpen = previousState.currentWindowOpen;
    const currentWinClose = previousState.currentWindowClose;

    if (previousState.lastAcceptedSourceTimestamp !== null &&
        candle.time <= previousState.lastAcceptedSourceTimestamp) {
        if (previousState.sourceTimestamps.includes(candle.time)) {
            return {
                nextState: Object.freeze({
                    ...previousState,
                    duplicateCount: previousState.duplicateCount + 1
                }),
                completedCandle: null,
                diagnostic: null
            };
        }
        return {
            nextState: Object.freeze({
                ...previousState,
                invalidSourceCount: previousState.invalidSourceCount + 1
            }),
            completedCandle: null,
            diagnostic: null
        };
    }

    // Close the active window only when the incoming record reaches/passes its exclusive end.
    const isWindowClosed = currentWinOpen !== null &&
        currentWinClose !== null &&
        candle.time >= currentWinClose;

    if (isWindowClosed) {
        const expectedTimestamps: number[] = [];
        for (let t = currentWinOpen; t < currentWinClose!; t += 60_000) {
            expectedTimestamps.push(t);
        }

        const recordedSet = new Set(previousState.sourceTimestamps);
        const missingTimestamps = expectedTimestamps.filter(t => !recordedSet.has(t));

        const isExactCount = previousState.actualSourceCount === expectedCount;
        const noMissing = missingTimestamps.length === 0;
        const noDuplicates = previousState.duplicateCount === 0;
        const noInvalids = previousState.invalidSourceCount === 0;

        const isWindowComplete = isExactCount &&
            noMissing &&
            noDuplicates &&
            noInvalids &&
            previousState.runningOpen !== null;

        if (isWindowComplete) {
            completedCandle = Object.freeze({
                timeframe: config.timeframe,
                openTimestamp: currentWinOpen,
                closeTimestamp: currentWinClose,
                open: previousState.runningOpen,
                high: previousState.runningHigh!,
                low: previousState.runningLow!,
                close: previousState.runningClose!,
                volume: previousState.runningVolume,
                sourceObservationCount: previousState.actualSourceCount,
                completeness: 'COMPLETE'
            });
            lastCompleted = completedCandle;
        } else {
            // Window failed completeness: classify cause and execute REJECT_AND_RESET
            let failureReason: HTFWindowCompleteness = 'INCOMPLETE_MISSING';
            if (!noInvalids) {
                failureReason = 'INCOMPLETE_INVALID';
            } else if (!noDuplicates) {
                failureReason = 'INCOMPLETE_DUPLICATE';
            }

            diagnostic = Object.freeze({
                timeframe: config.timeframe,
                openTimestamp: currentWinOpen,
                closeTimestamp: currentWinClose,
                expectedSourceCount: expectedCount,
                actualSourceCount: previousState.actualSourceCount,
                missingTimestamps: Object.freeze(missingTimestamps),
                duplicateCount: previousState.duplicateCount,
                invalidSourceCount: previousState.invalidSourceCount,
                completeness: failureReason
            });

            lastDiag = diagnostic;
            lastCompleted = null;
        }
    }

    const targetBounds = getUTCWindowBoundaries(candle.time, durationMs);
    const targetWinOpen = targetBounds.openTimestamp;
    const targetWinClose = targetBounds.closeTimestamp;

    if (currentWinClose !== null && targetWinOpen > currentWinClose) {
        const skippedTimestamps: number[] = [];
        for (let t = currentWinClose; t < currentWinClose + durationMs; t += 60_000) {
            skippedTimestamps.push(t);
        }
        diagnostic = Object.freeze({
            timeframe: config.timeframe,
            openTimestamp: currentWinClose,
            closeTimestamp: currentWinClose + durationMs,
            expectedSourceCount: expectedCount,
            actualSourceCount: 0,
            missingTimestamps: Object.freeze(skippedTimestamps),
            duplicateCount: 0,
            invalidSourceCount: 0,
            completeness: 'INCOMPLETE_MISSING'
        });
        lastDiag = diagnostic;
        lastCompleted = null;
    }

    const isNewWindow = isWindowClosed || currentWinOpen === null || currentWinOpen !== targetWinOpen;
    const sourceSnapshot: ML1Candle = Object.freeze({ ...candle });

    if (isNewWindow) {
        if (!isSourceValid) {
            const nextState: HTFAggregationState = Object.freeze({
                currentWindowOpen: targetWinOpen,
                currentWindowClose: targetWinClose,
                sourceCandles: Object.freeze([]),
                sourceTimestamps: Object.freeze([]),
                actualSourceCount: 0,
                runningOpen: null,
                runningHigh: null,
                runningLow: null,
                runningClose: null,
                runningVolume: 0,
                duplicateCount: 0,
                invalidSourceCount: 1,
                lastAcceptedSourceTimestamp: null,
                lastCompletedCandle: lastCompleted,
                lastDiagnostic: lastDiag
            });
            return { nextState, completedCandle, diagnostic };
        }

        const nextState: HTFAggregationState = Object.freeze({
            currentWindowOpen: targetWinOpen,
            currentWindowClose: targetWinClose,
            sourceCandles: Object.freeze([sourceSnapshot]),
            sourceTimestamps: Object.freeze([candle.time]),
            actualSourceCount: 1,
            runningOpen: candle.open,
            runningHigh: candle.high,
            runningLow: candle.low,
            runningClose: candle.close,
            runningVolume: candle.volume,
            duplicateCount: 0,
            invalidSourceCount: 0,
            lastAcceptedSourceTimestamp: candle.time,
            lastCompletedCandle: lastCompleted,
            lastDiagnostic: lastDiag
        });
        return { nextState, completedCandle, diagnostic };
    }

    const isInside = currentWinOpen !== null &&
        currentWinClose !== null &&
        isSourceTimestampInWindow(candle.time, currentWinOpen, currentWinClose);

    if (!isSourceValid) {
        const nextState: HTFAggregationState = Object.freeze({
            ...previousState,
            invalidSourceCount: previousState.invalidSourceCount + 1,
            lastCompletedCandle: lastCompleted,
            lastDiagnostic: lastDiag
        });
        return { nextState, completedCandle, diagnostic };
    }

    if (!isInside) {
        const nextState: HTFAggregationState = Object.freeze({
            ...previousState,
            invalidSourceCount: previousState.invalidSourceCount + 1,
            lastCompletedCandle: lastCompleted,
            lastDiagnostic: lastDiag
        });
        return { nextState, completedCandle, diagnostic };
    }

    const rOpen = previousState.runningOpen === null ? candle.open : previousState.runningOpen;
    const rHigh = previousState.runningHigh === null ? candle.high : Math.max(previousState.runningHigh, candle.high);
    const rLow = previousState.runningLow === null ? candle.low : Math.min(previousState.runningLow, candle.low);
    const rClose = candle.close;
    const rVol = previousState.runningVolume + candle.volume;

    const nextState: HTFAggregationState = Object.freeze({
        ...previousState,
        sourceCandles: Object.freeze([...previousState.sourceCandles, sourceSnapshot]),
        sourceTimestamps: Object.freeze([...previousState.sourceTimestamps, candle.time]),
        actualSourceCount: previousState.actualSourceCount + 1,
        runningOpen: rOpen,
        runningHigh: rHigh,
        runningLow: rLow,
        runningClose: rClose,
        runningVolume: rVol,
        lastAcceptedSourceTimestamp: candle.time,
        lastCompletedCandle: lastCompleted,
        lastDiagnostic: lastDiag
    });

    return { nextState, completedCandle, diagnostic };
}

/**
 * Steps the unified MTF Aggregator, advancing 15m and 1h with complete independence.
 */
export function stepMTFAggregation(
    candle: ML1Candle,
    isSourceValid: boolean,
    previousMTFState: MTFState,
    config: ValidatedMTFGlobalConfig,
    barIndex?: number
): MTFAggregatorStepResult {
    // 15m Step
    const res15m = stepHTFAggregation(
        candle,
        isSourceValid,
        previousMTFState.state15m.aggregation,
        config.config15m
    );

    // 1h Step (Independent execution)
    const res1h = stepHTFAggregation(
        candle,
        isSourceValid,
        previousMTFState.state1h.aggregation,
        config.config1h
    );

    const prev15mIdx = previousMTFState.state15m.lastCompletedBarIndex;
    const next15mIdx = res15m.completedCandle ? (prev15mIdx !== null ? prev15mIdx + 1 : 0) : prev15mIdx;

    const prev1hIdx = previousMTFState.state1h.lastCompletedBarIndex;
    const next1hIdx = res1h.completedCandle ? (prev1hIdx !== null ? prev1hIdx + 1 : 0) : prev1hIdx;

    const nextBarIndex = barIndex !== undefined ? barIndex : previousMTFState.last1mBarIndex;
    const nextState: MTFState = Object.freeze({
        stateVersion: previousMTFState.stateVersion,
        last1mBarIndex: nextBarIndex,
        last1mTimestamp: candle.time,
        state15m: Object.freeze({
            ...previousMTFState.state15m,
            aggregation: res15m.nextState,
            lastCompletedBarIndex: next15mIdx
        }),
        state1h: Object.freeze({
            ...previousMTFState.state1h,
            aggregation: res1h.nextState,
            lastCompletedBarIndex: next1hIdx
        })
    });

    return {
        nextState,
        completed15m: res15m.completedCandle,
        diagnostic15m: res15m.diagnostic,
        completed1h: res1h.completedCandle,
        diagnostic1h: res1h.diagnostic
    };
}

/**
 * Batch processing helper for testing batch-wrapper-versus-streaming equivalence.
 */
export function processMTFAggregationBatch(
    candles: { candle: ML1Candle; isSourceValid?: boolean }[],
    config: ValidatedMTFGlobalConfig,
    initialState?: MTFState
): {
    finalState: MTFState;
    completed15mCandles: MTFCandle[];
    completed1hCandles: MTFCandle[];
    diagnostics15m: HTFIncompleteDiagnostic[];
    diagnostics1h: HTFIncompleteDiagnostic[];
} {
    let state = initialState ?? createInitialMTFState();

    const completed15mCandles: MTFCandle[] = [];
    const completed1hCandles: MTFCandle[] = [];
    const diagnostics15m: HTFIncompleteDiagnostic[] = [];
    const diagnostics1h: HTFIncompleteDiagnostic[] = [];

    for (let i = 0; i < candles.length; i++) {
        const item = candles[i];
        const valid = item.isSourceValid ?? true;
        const res = stepMTFAggregation(item.candle, valid, state, config);
        state = res.nextState;

        if (res.completed15m) completed15mCandles.push(res.completed15m);
        if (res.diagnostic15m) diagnostics15m.push(res.diagnostic15m);
        if (res.completed1h) completed1hCandles.push(res.completed1h);
        if (res.diagnostic1h) diagnostics1h.push(res.diagnostic1h);
    }

    return {
        finalState: state,
        completed15mCandles,
        completed1hCandles,
        diagnostics15m,
        diagnostics1h
    };
}