import type { 
    MTFTimeframeState, 
    MTFCandle, 
    HTFIncompleteDiagnostic,
    MTFState
} from './MTFTypes';
import type { MTFTimeframeConfig, ValidatedMTFGlobalConfig } from './MTFConfig';
import type { ML1Candle, ML1Observation } from '../ML1FeatureTypes';
import { stepML1Features, createInitialML1FeatureState } from '../ML1FeatureEngine';
import { stepMTFAggregation } from './MTFAggregator';

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
        lastCompletedCandleOpenTimestamp: null,
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
 * Consumes completed candles and diagnostics in chronological order.
 * If both arrive together, the diagnostic resets whichever stream segment it follows.
 */
export function stepTimeframeFeatureEngine(
    previousState: MTFTimeframeState,
    completedCandle: MTFCandle | null,
    diagnostic: HTFIncompleteDiagnostic | null,
    config: MTFTimeframeConfig
): HTFFeatureStepResult {
    if (completedCandle !== null && diagnostic !== null) {
        if (completedCandle.closeTimestamp <= diagnostic.openTimestamp) {
            const candleStep = processCompletedCandle(previousState, completedCandle, config);
            return {
                nextTimeframeState: resetFeatureState(candleStep.nextTimeframeState),
                observation: candleStep.observation
            };
        }

        return processCompletedCandle(
            resetFeatureState(previousState),
            completedCandle,
            config
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