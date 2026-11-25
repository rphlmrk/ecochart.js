import type { 
    MTFTimeframeState, 
    MTFCandle, 
    HTFIncompleteDiagnostic,
    MTFState,
    V4MTFTimeframeState,
    V4MTFCandle,
    V4HTFIncompleteDiagnostic,
    V4MTFState
} from './MTFTypes';
import type {
    MTFTimeframeConfig,
    ValidatedMTFGlobalConfig,
    V4MTFTimeframeConfig,
    ValidatedV4MTFGlobalConfig
} from './MTFConfig';
import type { ML1Candle, ML1Observation } from '../ML1FeatureTypes';
import {
    stepML1Features,
    createInitialML1FeatureState,
    stepML1FeaturesV6,
    createInitialML1FeatureStateV6
} from '../ML1FeatureEngine';
import { stepMTFAggregation, stepV4MTFAggregation } from './MTFAggregator';
import {
    validateV4CompletedCandle,
    validateV4Diagnostic,
    validateV4MTFState,
    validateV4MTFTimeframeState
} from './MTFState';

export interface HTFFeatureStepResult {
    readonly nextTimeframeState: MTFTimeframeState;
    readonly observation: ML1Observation | null;
}

export interface MTFFeatureEngineStepResult {
    readonly nextState: MTFState;
    readonly observation15m: ML1Observation | null;
    readonly observation1h: ML1Observation | null;
}

/**
 * Resets the feature stream after an incomplete or skipped aggregation window.
 */
function resetFeatureState(state: MTFTimeframeState): MTFTimeframeState {
    return Object.freeze({
        ...state,
        featureEngineState: createInitialML1FeatureState(),
        lastCompletedBarIndex: null,
        lastCompletedCandleOpenTimestamp: state.lastCompletedCandleOpenTimestamp,
        latestFeatures: Object.freeze({}),
        latestValidity: Object.freeze({})
    });
}

/**
 * Processes a verified, chronologically ordered completed candle.
 */
function processCompletedCandle(
    state: MTFTimeframeState,
    completedCandle: MTFCandle,
    config: MTFTimeframeConfig
): HTFFeatureStepResult {
    if (completedCandle.completeness !== 'COMPLETE') {
        throw new Error(`MTF Feature Engine Error: Rejected candle with non-COMPLETE status '${completedCandle.completeness}'`);
    }

    if (
        !Number.isSafeInteger(completedCandle.openTimestamp) ||
        !Number.isSafeInteger(completedCandle.closeTimestamp) ||
        completedCandle.closeTimestamp <= completedCandle.openTimestamp
    ) {
        throw new Error(
            `MTF Feature Engine Error: Invalid completed candle interval [${completedCandle.openTimestamp}, ${completedCandle.closeTimestamp})`
        );
    }

    if (completedCandle.timeframe !== config.timeframe) {
        throw new Error(`MTF Feature Engine Error: Candle timeframe '${completedCandle.timeframe}' does not match config '${config.timeframe}'`);
    }

    if (
        state.lastCompletedCandleOpenTimestamp !== null &&
        completedCandle.openTimestamp <= state.lastCompletedCandleOpenTimestamp
    ) {
        throw new Error(
            `MTF Feature Engine Error: Duplicate or out-of-order completed candle at ${completedCandle.openTimestamp} <= ${state.lastCompletedCandleOpenTimestamp}`
        );
    }

    const ml1Candle: ML1Candle = Object.freeze({
        time: completedCandle.openTimestamp,
        open: completedCandle.open,
        high: completedCandle.high,
        low: completedCandle.low,
        close: completedCandle.close,
        volume: completedCandle.volume,
        isSynthetic: false
    });

    const nextBarIndex = state.lastCompletedBarIndex !== null
        ? state.lastCompletedBarIndex + 1
        : 0;
    const m2Res = stepML1Features(
        ml1Candle,
        nextBarIndex,
        state.featureEngineState,
        config.featureConfig
    );

    const nextTimeframeState: MTFTimeframeState = Object.freeze({
        ...state,
        featureEngineState: m2Res.nextState,
        lastCompletedBarIndex: nextBarIndex,
        lastCompletedCandleOpenTimestamp: completedCandle.openTimestamp,
        latestFeatures: Object.freeze({ ...m2Res.observation.features }),
        latestValidity: Object.freeze({ ...m2Res.observation.validity })
    });

    return { nextTimeframeState, observation: m2Res.observation };
}

/**
 * Consumes completed candles and diagnostics in verified chronological order.
 * If both arrive together, overlapping intervals are rejected.
 */
export function stepTimeframeFeatureEngine(
    previousState: MTFTimeframeState,
    completedCandle: MTFCandle | null,
    diagnostic: HTFIncompleteDiagnostic | null,
    config: MTFTimeframeConfig
): HTFFeatureStepResult {
    if (diagnostic !== null) {
        if (diagnostic.timeframe !== config.timeframe) {
            throw new Error(
                `MTF Feature Engine Error: Diagnostic timeframe '${diagnostic.timeframe}' does not match config '${config.timeframe}'`
            );
        }
        if (
            !Number.isSafeInteger(diagnostic.openTimestamp) ||
            !Number.isSafeInteger(diagnostic.closeTimestamp) ||
            diagnostic.closeTimestamp <= diagnostic.openTimestamp
        ) {
            throw new Error(
                `MTF Feature Engine Error: Invalid diagnostic interval [${diagnostic.openTimestamp}, ${diagnostic.closeTimestamp})`
            );
        }
    }

    if (completedCandle !== null && diagnostic !== null) {
        if (completedCandle.closeTimestamp <= diagnostic.openTimestamp) {
            const candleStep = processCompletedCandle(previousState, completedCandle, config);
            return {
                nextTimeframeState: resetFeatureState(candleStep.nextTimeframeState),
                observation: candleStep.observation
            };
        }

        if (diagnostic.closeTimestamp <= completedCandle.openTimestamp) {
            return processCompletedCandle(
                resetFeatureState(previousState),
                completedCandle,
                config
            );
        }

        throw new Error(
            'MTF Feature Engine Error: Diagnostic and completed candle intervals overlap or have ambiguous ordering'
        );
    }

    if (diagnostic !== null) {
        return { nextTimeframeState: resetFeatureState(previousState), observation: null };
    }

    if (completedCandle !== null) {
        return processCompletedCandle(previousState, completedCandle, config);
    }

    return { nextTimeframeState: previousState, observation: null };
}

/**
 * Steps the unified MTF Feature Engine across both 15m and 1h with complete independence.
 */
export function stepMTFFeatureEngine(
    previousMTFState: MTFState,
    completed15m: MTFCandle | null,
    diagnostic15m: HTFIncompleteDiagnostic | null,
    completed1h: MTFCandle | null,
    diagnostic1h: HTFIncompleteDiagnostic | null,
    config: ValidatedMTFGlobalConfig
): MTFFeatureEngineStepResult {
    // 15m Feature Step
    const res15m = stepTimeframeFeatureEngine(
        previousMTFState.state15m,
        completed15m,
        diagnostic15m,
        config.config15m
    );

    // 1h Feature Step (100% independent from 15m)
    const res1h = stepTimeframeFeatureEngine(
        previousMTFState.state1h,
        completed1h,
        diagnostic1h,
        config.config1h
    );

    const nextState: MTFState = Object.freeze({
        ...previousMTFState,
        state15m: Object.freeze({
            ...previousMTFState.state15m,
            featureEngineState: res15m.nextTimeframeState.featureEngineState,
            lastCompletedBarIndex: res15m.nextTimeframeState.lastCompletedBarIndex,
            lastCompletedCandleOpenTimestamp: res15m.nextTimeframeState.lastCompletedCandleOpenTimestamp,
            latestFeatures: res15m.nextTimeframeState.latestFeatures,
            latestValidity: res15m.nextTimeframeState.latestValidity
        }),
        state1h: Object.freeze({
            ...previousMTFState.state1h,
            featureEngineState: res1h.nextTimeframeState.featureEngineState,
            lastCompletedBarIndex: res1h.nextTimeframeState.lastCompletedBarIndex,
            lastCompletedCandleOpenTimestamp: res1h.nextTimeframeState.lastCompletedCandleOpenTimestamp,
            latestFeatures: res1h.nextTimeframeState.latestFeatures,
            latestValidity: res1h.nextTimeframeState.latestValidity
        })
    });

    return {
        nextState,
        observation15m: res15m.observation,
        observation1h: res1h.observation
    };
}

/**
 * Combined Phase 3B + Phase 3C execution step:
 * Aggregates incoming 1m candle and computes HTF features upon candle completion.
 */
export function stepMTFCombined(
    candle: ML1Candle,
    isSourceValid: boolean,
    previousMTFState: MTFState,
    config: ValidatedMTFGlobalConfig,
    barIndex?: number
): {
    nextState: MTFState;
    completed15m: MTFCandle | null;
    completed1h: MTFCandle | null;
    observation15m: ML1Observation | null;
    observation1h: ML1Observation | null;
    diagnostic15m: HTFIncompleteDiagnostic | null;
    diagnostic1h: HTFIncompleteDiagnostic | null;
} {
    // Step 1: Aggregation (Phase 3B)
    const aggRes = stepMTFAggregation(candle, isSourceValid, previousMTFState, config, barIndex);

    // Step 2: Feature Calculation (Phase 3C)
    const featRes = stepMTFFeatureEngine(
        aggRes.nextState,
        aggRes.completed15m,
        aggRes.diagnostic15m,
        aggRes.completed1h,
        aggRes.diagnostic1h,
        config
    );

    return {
        nextState: featRes.nextState,
        completed15m: aggRes.completed15m,
        completed1h: aggRes.completed1h,
        observation15m: featRes.observation15m,
        observation1h: featRes.observation1h,
        diagnostic15m: aggRes.diagnostic15m,
        diagnostic1h: aggRes.diagnostic1h
    };
}

// =========================================================================
// V4 MTF Feature Engine (3m & 5m via stepML1FeaturesV6)
// =========================================================================
export interface V4HTFFeatureStepResult {
    readonly nextTimeframeState: V4MTFTimeframeState;
    readonly observation: ML1Observation | null;
}

export interface V4MTFFeatureEngineStepResult {
    readonly nextState: V4MTFState;
    readonly observation3m: ML1Observation | null;
    readonly observation5m: ML1Observation | null;
}

function resetV4FeatureState(
    state: V4MTFTimeframeState,
    config: V4MTFTimeframeConfig,
    diagnostic: V4HTFIncompleteDiagnostic
): V4MTFTimeframeState {
    return Object.freeze({
        ...state,
        aggregation: Object.freeze({
            ...state.aggregation,
            lastCompletedCandle: null,
            lastDiagnostic: diagnostic
        }),
        featureEngineState: createInitialML1FeatureStateV6(config.featureConfig),
        lastCompletedBarIndex: null,
        lastCompletedCandleOpenTimestamp: state.lastCompletedCandleOpenTimestamp,
        latestFeatures: Object.freeze({}),
        latestValidity: Object.freeze({})
    });
}

function processV4CompletedCandle(
    state: V4MTFTimeframeState,
    completedCandle: V4MTFCandle,
    config: V4MTFTimeframeConfig
): V4HTFFeatureStepResult {
    if (completedCandle.completeness !== 'COMPLETE') {
        throw new Error(`V4 MTF Feature Engine Error: Rejected candle with non-COMPLETE status '${completedCandle.completeness}'`);
    }
    if (
        !Number.isSafeInteger(completedCandle.openTimestamp) ||
        !Number.isSafeInteger(completedCandle.closeTimestamp) ||
        completedCandle.closeTimestamp <= completedCandle.openTimestamp
    ) {
        throw new Error(
            `V4 MTF Feature Engine Error: Invalid completed candle interval [${completedCandle.openTimestamp}, ${completedCandle.closeTimestamp})`
        );
    }
    if (completedCandle.timeframe !== config.timeframe) {
        throw new Error(`V4 MTF Feature Engine Error: Candle timeframe '${completedCandle.timeframe}' does not match config '${config.timeframe}'`);
    }
    if (
        state.lastCompletedCandleOpenTimestamp !== null &&
        completedCandle.openTimestamp <= state.lastCompletedCandleOpenTimestamp
    ) {
        throw new Error(
            `V4 MTF Feature Engine Error: Duplicate or out-of-order completed candle at ${completedCandle.openTimestamp} <= ${state.lastCompletedCandleOpenTimestamp}`
        );
    }

    const ml1Candle: ML1Candle = Object.freeze({
        time: completedCandle.openTimestamp,
        open: completedCandle.open,
        high: completedCandle.high,
        low: completedCandle.low,
        close: completedCandle.close,
        volume: completedCandle.volume,
        isSynthetic: false
    });

    const nextBarIndex = state.lastCompletedBarIndex !== null ? state.lastCompletedBarIndex + 1 : 0;
    const v6Res = stepML1FeaturesV6(
        ml1Candle,
        nextBarIndex,
        state.featureEngineState,
        config.featureConfig
    );

    const nextTimeframeState: V4MTFTimeframeState = Object.freeze({
        ...state,
        aggregation: Object.freeze({
            ...state.aggregation,
            lastCompletedCandle: completedCandle
        }),
        featureEngineState: v6Res.nextState,
        lastCompletedBarIndex: nextBarIndex,
        lastCompletedCandleOpenTimestamp: completedCandle.openTimestamp,
        latestFeatures: Object.freeze({ ...v6Res.observation.features }),
        latestValidity: Object.freeze({ ...v6Res.observation.validity })
    });

    return { nextTimeframeState, observation: v6Res.observation };
}

export function stepV4TimeframeFeatureEngine(
    previousState: V4MTFTimeframeState,
    completedCandle: V4MTFCandle | null,
    diagnostic: V4HTFIncompleteDiagnostic | null,
    config: V4MTFTimeframeConfig
): V4HTFFeatureStepResult {
    validateV4MTFTimeframeState(previousState, config);

    if (completedCandle !== null) {
        validateV4CompletedCandle(completedCandle, config);
    }
    if (diagnostic !== null) {
        validateV4Diagnostic(diagnostic, config);
    }

    if (completedCandle !== null && diagnostic !== null) {
        if (completedCandle.closeTimestamp <= diagnostic.openTimestamp) {
            const candleStep = processV4CompletedCandle(previousState, completedCandle, config);
            return {
                nextTimeframeState: resetV4FeatureState(candleStep.nextTimeframeState, config, diagnostic),
                observation: candleStep.observation
            };
        }
        if (diagnostic.closeTimestamp <= completedCandle.openTimestamp) {
            return processV4CompletedCandle(
                resetV4FeatureState(previousState, config, diagnostic),
                completedCandle,
                config
            );
        }
        throw new Error('V4 MTF Feature Engine Error: Diagnostic and completed candle intervals overlap or have ambiguous ordering');
    }

    if (diagnostic !== null) {
        return { nextTimeframeState: resetV4FeatureState(previousState, config, diagnostic), observation: null };
    }
    if (completedCandle !== null) {
        return processV4CompletedCandle(previousState, completedCandle, config);
    }
    return { nextTimeframeState: previousState, observation: null };
}

export function stepV4MTFFeatureEngine(
    previousMTFState: V4MTFState,
    completed3m: V4MTFCandle | null,
    diagnostic3m: V4HTFIncompleteDiagnostic | null,
    completed5m: V4MTFCandle | null,
    diagnostic5m: V4HTFIncompleteDiagnostic | null,
    config: ValidatedV4MTFGlobalConfig
): V4MTFFeatureEngineStepResult {
    validateV4MTFState(previousMTFState, config);
    if (completed3m !== null) validateV4CompletedCandle(completed3m, config.config3m);
    if (diagnostic3m !== null) validateV4Diagnostic(diagnostic3m, config.config3m);
    if (completed5m !== null) validateV4CompletedCandle(completed5m, config.config5m);
    if (diagnostic5m !== null) validateV4Diagnostic(diagnostic5m, config.config5m);

    const res3m = stepV4TimeframeFeatureEngine(
        previousMTFState.state3m,
        completed3m,
        diagnostic3m,
        config.config3m
    );
    const res5m = stepV4TimeframeFeatureEngine(
        previousMTFState.state5m,
        completed5m,
        diagnostic5m,
        config.config5m
    );

    const nextState: V4MTFState = Object.freeze({
        ...previousMTFState,
        state3m: res3m.nextTimeframeState,
        state5m: res5m.nextTimeframeState
    });

    return {
        nextState,
        observation3m: res3m.observation,
        observation5m: res5m.observation
    };
}

export function stepV4MTFCombined(
    candle: ML1Candle,
    isSourceValid: boolean,
    previousMTFState: V4MTFState,
    config: ValidatedV4MTFGlobalConfig,
    barIndex?: number
): {
    nextState: V4MTFState;
    completed3m: V4MTFCandle | null;
    completed5m: V4MTFCandle | null;
    observation3m: ML1Observation | null;
    observation5m: ML1Observation | null;
    diagnostic3m: V4HTFIncompleteDiagnostic | null;
    diagnostic5m: V4HTFIncompleteDiagnostic | null;
} {
    validateV4MTFState(previousMTFState, config);
    const aggRes = stepV4MTFAggregation(candle, isSourceValid, previousMTFState, config, barIndex);
    const featRes = stepV4MTFFeatureEngine(
        previousMTFState,
        aggRes.completed3m,
        aggRes.diagnostic3m,
        aggRes.completed5m,
        aggRes.diagnostic5m,
        config
    );

    const nextState: V4MTFState = Object.freeze({
        stateVersion: 2 as const,
        last1mBarIndex: aggRes.nextState.last1mBarIndex,
        last1mTimestamp: aggRes.nextState.last1mTimestamp,
        state3m: Object.freeze({
            ...featRes.nextState.state3m,
            aggregation: aggRes.nextState.state3m.aggregation
        }),
        state5m: Object.freeze({
            ...featRes.nextState.state5m,
            aggregation: aggRes.nextState.state5m.aggregation
        })
    });

    validateV4MTFState(nextState, config);

    return {
        nextState,
        completed3m: aggRes.completed3m,
        completed5m: aggRes.completed5m,
        observation3m: featRes.observation3m,
        observation5m: featRes.observation5m,
        diagnostic3m: aggRes.diagnostic3m,
        diagnostic5m: aggRes.diagnostic5m
    };
}