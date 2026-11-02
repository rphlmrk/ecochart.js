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
    readonly diagnostics: readonly HTFIncompleteDiagnostic[];
}

export interface MTFAggregatorStepResult {
    readonly nextState: MTFState;
    readonly completed15m: MTFCandle | null;
    readonly diagnostic15m: HTFIncompleteDiagnostic | null;
    readonly diagnostics15m: readonly HTFIncompleteDiagnostic[];
    readonly completed1h: MTFCandle | null;
    readonly diagnostic1h: HTFIncompleteDiagnostic | null;
    readonly diagnostics1h: readonly HTFIncompleteDiagnostic[];
}

/**
 * Pure Single-Timeframe Aggregation Step.
 * Tracks observed stream chronology and timestamps, diagnoses every closed or
 * skipped window, and executes REJECT_AND_RESET for incomplete windows.
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
    const emittedDiagnostics: HTFIncompleteDiagnostic[] = [];
    let lastCompleted = previousState.lastCompletedCandle;
    let lastDiag = previousState.lastDiagnostic;

    const currentWinOpen = previousState.currentWindowOpen;
    const currentWinClose = previousState.currentWindowClose;
    const lastObserved = previousState.lastObservedSourceTimestamp;

    if (lastObserved !== null && candle.time <= lastObserved) {
        if (previousState.observedTimestamps.includes(candle.time)) {
            return {
                nextState: Object.freeze({
                    ...previousState,
                    duplicateCount: previousState.duplicateCount + 1
                }),
                completedCandle: null,
                diagnostic: null,
                diagnostics: Object.freeze([])
            };
        }
        return {
            nextState: Object.freeze({
                ...previousState,
                invalidSourceCount: previousState.invalidSourceCount + 1
            }),
            completedCandle: null,
            diagnostic: null,
            diagnostics: Object.freeze([])
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

            const activeDiagnostic = Object.freeze({
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

            emittedDiagnostics.push(activeDiagnostic);
            lastDiag = activeDiagnostic;
            lastCompleted = null;
        }
    }

    const targetBounds = getUTCWindowBoundaries(candle.time, durationMs);
    const targetWinOpen = targetBounds.openTimestamp;
    const targetWinClose = targetBounds.closeTimestamp;

    if (currentWinClose !== null && targetWinOpen > currentWinClose) {
        for (let skipOpen = currentWinClose; skipOpen < targetWinOpen; skipOpen += durationMs) {
            const skipClose = skipOpen + durationMs;
            const skippedTimestamps: number[] = [];
            for (let t = skipOpen; t < skipClose; t += 60_000) {
                skippedTimestamps.push(t);
            }
            const skippedDiagnostic: HTFIncompleteDiagnostic = Object.freeze({
                timeframe: config.timeframe,
                openTimestamp: skipOpen,
                closeTimestamp: skipClose,
                expectedSourceCount: expectedCount,
                actualSourceCount: 0,
                missingTimestamps: Object.freeze(skippedTimestamps),
                duplicateCount: 0,
                invalidSourceCount: 0,
                completeness: 'INCOMPLETE_MISSING'
            });
            emittedDiagnostics.push(skippedDiagnostic);
            lastDiag = skippedDiagnostic;
        }
        lastCompleted = null;
    }

    const isNewWindow = isWindowClosed || currentWinOpen === null || currentWinOpen !== targetWinOpen;
    const sourceSnapshot: ML1Candle = Object.freeze({ ...candle });
    const latestDiagnostic = emittedDiagnostics.length > 0
        ? emittedDiagnostics[emittedDiagnostics.length - 1]
        : null;

    if (isNewWindow) {
        if (!isSourceValid) {
            const nextState: HTFAggregationState = Object.freeze({
                currentWindowOpen: targetWinOpen,
                currentWindowClose: targetWinClose,
                sourceCandles: Object.freeze([]),
                sourceTimestamps: Object.freeze([]),
                observedTimestamps: Object.freeze([candle.time]),
                actualSourceCount: 0,
                runningOpen: null,
                runningHigh: null,
                runningLow: null,
                runningClose: null,
                runningVolume: 0,
                duplicateCount: 0,
                invalidSourceCount: 1,
                lastObservedSourceTimestamp: candle.time,
                lastAcceptedSourceTimestamp: null,
                lastCompletedCandle: lastCompleted,
                lastDiagnostic: lastDiag
            });
            return {
                nextState,
                completedCandle,
                diagnostic: latestDiagnostic,
                diagnostics: Object.freeze(emittedDiagnostics)
            };
        }

        const nextState: HTFAggregationState = Object.freeze({
            currentWindowOpen: targetWinOpen,
            currentWindowClose: targetWinClose,
            sourceCandles: Object.freeze([sourceSnapshot]),
            sourceTimestamps: Object.freeze([candle.time]),
            observedTimestamps: Object.freeze([candle.time]),
            actualSourceCount: 1,
            runningOpen: candle.open,
            runningHigh: candle.high,
            runningLow: candle.low,
            runningClose: candle.close,
            runningVolume: candle.volume,
            duplicateCount: 0,
            invalidSourceCount: 0,
            lastObservedSourceTimestamp: candle.time,
            lastAcceptedSourceTimestamp: candle.time,
            lastCompletedCandle: lastCompleted,
            lastDiagnostic: lastDiag
        });
        return {
            nextState,
            completedCandle,
            diagnostic: latestDiagnostic,
            diagnostics: Object.freeze(emittedDiagnostics)
        };
    }

    const isInside = currentWinOpen !== null &&
        currentWinClose !== null &&
        isSourceTimestampInWindow(candle.time, currentWinOpen, currentWinClose);

    if (!isSourceValid) {
        const nextState: HTFAggregationState = Object.freeze({
            ...previousState,
            observedTimestamps: Object.freeze([...previousState.observedTimestamps, candle.time]),
            invalidSourceCount: previousState.invalidSourceCount + 1,
            lastObservedSourceTimestamp: candle.time,
            lastCompletedCandle: lastCompleted,
            lastDiagnostic: lastDiag
        });
        return {
            nextState,
            completedCandle,
            diagnostic: latestDiagnostic,
            diagnostics: Object.freeze(emittedDiagnostics)
        };
    }

    if (!isInside) {
        const nextState: HTFAggregationState = Object.freeze({
            ...previousState,
            observedTimestamps: Object.freeze([...previousState.observedTimestamps, candle.time]),
            invalidSourceCount: previousState.invalidSourceCount + 1,
            lastObservedSourceTimestamp: candle.time,
            lastCompletedCandle: lastCompleted,
            lastDiagnostic: lastDiag
        });
        return {
            nextState,
            completedCandle,
            diagnostic: latestDiagnostic,
            diagnostics: Object.freeze(emittedDiagnostics)
        };
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
        observedTimestamps: Object.freeze([...previousState.observedTimestamps, candle.time]),
        actualSourceCount: previousState.actualSourceCount + 1,
        runningOpen: rOpen,
        runningHigh: rHigh,
        runningLow: rLow,
        runningClose: rClose,
        runningVolume: rVol,
        lastObservedSourceTimestamp: candle.time,
        lastAcceptedSourceTimestamp: candle.time,
        lastCompletedCandle: lastCompleted,
        lastDiagnostic: lastDiag
    });

    return {
        nextState,
        completedCandle,
        diagnostic: latestDiagnostic,
        diagnostics: Object.freeze(emittedDiagnostics)
    };
}

/**
 * Steps the unified MTF Aggregator and keeps its 1m clock monotonic.
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

    const isBackwardsOrDuplicate = previousMTFState.last1mTimestamp !== null &&
        candle.time <= previousMTFState.last1mTimestamp;
    const next1mTimestamp = isBackwardsOrDuplicate
        ? previousMTFState.last1mTimestamp
        : candle.time;
    const requestedBarIndex = barIndex !== undefined ? barIndex : previousMTFState.last1mBarIndex;
    const nextBarIndex = isBackwardsOrDuplicate
        ? previousMTFState.last1mBarIndex
        : requestedBarIndex !== null &&
            previousMTFState.last1mBarIndex !== null &&
            requestedBarIndex < previousMTFState.last1mBarIndex
            ? previousMTFState.last1mBarIndex
            : requestedBarIndex;
    const nextState: MTFState = Object.freeze({
        stateVersion: previousMTFState.stateVersion,
        last1mBarIndex: nextBarIndex,
        last1mTimestamp: next1mTimestamp,
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
        diagnostics15m: res15m.diagnostics,
        completed1h: res1h.completedCandle,
        diagnostic1h: res1h.diagnostic,
        diagnostics1h: res1h.diagnostics
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
        diagnostics15m.push(...res.diagnostics15m);
        if (res.completed1h) completed1hCandles.push(res.completed1h);
        diagnostics1h.push(...res.diagnostics1h);
    }

    return {
        finalState: state,
        completed15mCandles,
        completed1hCandles,
        diagnostics15m,
        diagnostics1h
    };
}