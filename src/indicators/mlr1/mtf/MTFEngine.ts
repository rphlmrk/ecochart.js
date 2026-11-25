import type {
    ML1Candle,
    ML1Observation,
    ValidatedML1FeatureConfig,
    ML1FeatureState,
    ValidatedML1FeatureConfigV6,
    ML1FeatureStateV6
} from '../ML1FeatureTypes';
import {
    stepML1Features,
    createInitialML1FeatureState,
    stepML1FeaturesV6,
    createInitialML1FeatureStateV6
} from '../ML1FeatureEngine';
import type { MTFState, MTFContext, V4MTFState, V4MTFContext } from './MTFTypes';
import type { ValidatedMTFGlobalConfig, ValidatedV4MTFGlobalConfig } from './MTFConfig';
import { createInitialMTFState, createInitialV4MTFState } from './MTFState';
import { stepMTFCombined, stepV4MTFCombined } from './MTFFeatureEngine';
import { alignMTFContext, alignV4MTFContext } from './MTFAligner';

/**
 * Coherent Integrated Observation combining 1m native features and aligned HTF context.
 */
export interface IntegratedMTFObservation {
    readonly observation1m: ML1Observation;
    readonly mtfContext: MTFContext;
}

/**
 * Unified pipeline state combining Milestone 2 and Milestone 3 state machines.
 */
export interface IntegratedMTFState {
    readonly m1State: ML1FeatureState;
    readonly mtfState: MTFState;
}

export function createInitialIntegratedMTFState(): IntegratedMTFState {
    return Object.freeze({
        m1State: createInitialML1FeatureState(),
        mtfState: createInitialMTFState()
    });
}

/**
 * Pure Single-Step Integration Function for the complete MTF Pipeline.
 */
export function stepIntegratedMTFPipeline(
    candle: ML1Candle,
    barIndex: number,
    previousState: IntegratedMTFState,
    config: {
        m1Config: ValidatedML1FeatureConfig;
        mtfConfig: ValidatedMTFGlobalConfig;
    }
): {
    nextState: IntegratedMTFState;
    observation: IntegratedMTFObservation;
} {
    // 1. Native 1m Feature Engine (Milestone 2)
    const m1Res = stepML1Features(
        candle,
        barIndex,
        previousState.m1State,
        config.m1Config
    );

    const isSourceValid = m1Res.observation.features['IsSourceValid'] === 1;

    // 2. MTF Aggregation + HTF Feature Engine (Milestone 3 Phases 3B & 3C)
    const combinedMTF = stepMTFCombined(
        candle,
        isSourceValid,
        previousState.mtfState,
        config.mtfConfig,
        barIndex
    );

    // 3. Causal MTF Alignment (Milestone 3 Phase 3D)
    const mtfContext = alignMTFContext(
        candle.time,
        config.mtfConfig.symbol,
        combinedMTF.nextState,
        config.mtfConfig
    );

    const nextState: IntegratedMTFState = Object.freeze({
        m1State: m1Res.nextState,
        mtfState: combinedMTF.nextState
    });

    const observation: IntegratedMTFObservation = Object.freeze({
        observation1m: m1Res.observation,
        mtfContext
    });

    return Object.freeze({ nextState, observation });
}

// =========================================================================
// V4 Integrated MTF Pipeline (1m CONFIG_D + 3m & 5m MTF)
// =========================================================================
export interface IntegratedV4MTFObservation {
    readonly observation1m: ML1Observation;
    readonly mtfContext: V4MTFContext;
}

export interface IntegratedV4MTFState {
    readonly m1State: ML1FeatureStateV6;
    readonly mtfState: V4MTFState;
}

export function validateIntegratedV4MTFConfig(config: {
    m1Config: ValidatedML1FeatureConfigV6;
    mtfConfig: ValidatedV4MTFGlobalConfig;
}): void {
    if (!config || !config.m1Config || !config.mtfConfig) {
        throw new Error('V4 Integrated Config Error: m1Config and mtfConfig are required.');
    }
    if (config.m1Config.symbol !== config.mtfConfig.symbol ||
        config.mtfConfig.config3m.featureConfig.symbol !== config.m1Config.symbol ||
        config.mtfConfig.config5m.featureConfig.symbol !== config.m1Config.symbol) {
        throw new Error(
            `V4 Integrated Config Error: symbol mismatch between 1m (${config.m1Config.symbol}) ` +
            `and MTF (${config.mtfConfig.symbol}).`
        );
    }
    if (config.m1Config.timeframe !== '1m' || config.m1Config.expectedIntervalMs !== 60_000 || config.mtfConfig.baseTimeframe !== '1m') {
        throw new Error('V4 Integrated Config Error: base pipeline must be 1m (60000ms).');
    }
    if (config.mtfConfig.config3m.timeframe !== '3m' || config.mtfConfig.config5m.timeframe !== '5m') {
        throw new Error('V4 Integrated Config Error: MTF timeframes must be 3m and 5m.');
    }
}

export function createInitialIntegratedV4MTFState(config: {
    m1Config: ValidatedML1FeatureConfigV6;
    mtfConfig: ValidatedV4MTFGlobalConfig;
}): IntegratedV4MTFState {
    validateIntegratedV4MTFConfig(config);
    return Object.freeze({
        m1State: createInitialML1FeatureStateV6(config.m1Config),
        mtfState: createInitialV4MTFState(config.mtfConfig)
    });
}

export function stepIntegratedV4MTFPipeline(
    candle: ML1Candle,
    barIndex: number,
    previousState: IntegratedV4MTFState,
    config: {
        m1Config: ValidatedML1FeatureConfigV6;
        mtfConfig: ValidatedV4MTFGlobalConfig;
    }
): {
    nextState: IntegratedV4MTFState;
    observation: IntegratedV4MTFObservation;
} {
    validateIntegratedV4MTFConfig(config);
    const m1Res = stepML1FeaturesV6(
        candle,
        barIndex,
        previousState.m1State,
        config.m1Config
    );

    const isSourceValid = m1Res.observation.features['IsSourceValid'] === 1;

    const combinedMTF = stepV4MTFCombined(
        candle,
        isSourceValid,
        previousState.mtfState,
        config.mtfConfig,
        barIndex
    );

    const mtfContext = alignV4MTFContext(
        candle.time,
        config.mtfConfig.symbol,
        combinedMTF.nextState,
        config.mtfConfig
    );

    const nextState: IntegratedV4MTFState = Object.freeze({
        m1State: m1Res.nextState,
        mtfState: combinedMTF.nextState
    });

    const observation: IntegratedV4MTFObservation = Object.freeze({
        observation1m: m1Res.observation,
        mtfContext
    });

    return Object.freeze({ nextState, observation });
}