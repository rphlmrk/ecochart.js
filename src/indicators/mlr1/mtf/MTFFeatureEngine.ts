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
 * Pure Single-Timeframe Feature Step.
 * Consumes completed MTFCandles only.
 * Resets featureEngineState on diagnostics (REJECT_AND_RESET).
 */
export function stepTimeframeFeatureEngine(
    previousState: MTFTimeframeState,
    completedCandle: MTFCandle | null,
    diagnostic: HTFIncompleteDiagnostic | null,
    config: MTFTimeframeConfig
): HTFFeatureStepResult {
    // 1. REJECT_AND_RESET Recovery: Reset feature state when an incomplete or skipped window is diagnosed
    if (diagnostic !== null) {
        const nextTimeframeState: MTFTimeframeState = Object.freeze({
            ...previousState,
            featureEngineState: createInitialML1FeatureState(),
            lastCompletedBarIndex: null,
            latestFeatures: Object.freeze({}),
            latestValidity: Object.freeze({})
        });
        return { nextTimeframeState, observation: null };
    }

    // 2. If no completed candle arrived, feature state is unchanged (accumulating window in progress)
    if (completedCandle === null) {
        return { nextTimeframeState: previousState, observation: null };
    }

    // 3. Strict Invariant: Only COMPLETE candles may enter the feature engine
    if (completedCandle.completeness !== 'COMPLETE') {
        throw new Error(`MTF Feature Engine Error: Rejected candle with non-COMPLETE status '${completedCandle.completeness}'`);
    }

    // 4. Timeframe matching invariant
    if (completedCandle.timeframe !== config.timeframe) {
        throw new Error(`MTF Feature Engine Error: Candle timeframe '${completedCandle.timeframe}' does not match config '${config.timeframe}'`);
    }

    // 5. Convert MTFCandle to ML1Candle for Milestone 2 feature engine
    const ml1Candle: ML1Candle = Object.freeze({
        time: completedCandle.openTimestamp,
        open: completedCandle.open,
        high: completedCandle.high,
        low: completedCandle.low,
        close: completedCandle.close,
        volume: completedCandle.volume,
        isSynthetic: false
    });

    const nextBarIndex = previousState.lastCompletedBarIndex !== null
        ? previousState.lastCompletedBarIndex + 1
        : 0;

    // 6. Execute frozen Milestone 2 feature engine mathematics
    const m2Res = stepML1Features(
        ml1Candle,
        nextBarIndex,
        previousState.featureEngineState,
        config.featureConfig
    );

    const nextTimeframeState: MTFTimeframeState = Object.freeze({
        ...previousState,
        featureEngineState: m2Res.nextState,
        lastCompletedBarIndex: nextBarIndex,
        latestFeatures: m2Res.observation.features,
        latestValidity: m2Res.observation.validity
    });

    return {
        nextTimeframeState,
        observation: m2Res.observation
    };
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
            latestFeatures: res15m.nextTimeframeState.latestFeatures,
            latestValidity: res15m.nextTimeframeState.latestValidity
        }),
        state1h: Object.freeze({
            ...previousMTFState.state1h,
            featureEngineState: res1h.nextTimeframeState.featureEngineState,
            lastCompletedBarIndex: res1h.nextTimeframeState.lastCompletedBarIndex,
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