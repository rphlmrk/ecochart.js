import type { ML1Candle, ML1Observation, ValidatedML1FeatureConfig, ML1FeatureState } from '../ML1FeatureTypes';
import { stepML1Features, createInitialML1FeatureState } from '../ML1FeatureEngine';
import type { MTFState, MTFContext } from './MTFTypes';
import type { ValidatedMTFGlobalConfig } from './MTFConfig';
import { createInitialMTFState } from './MTFState';
import { stepMTFCombined } from './MTFFeatureEngine';
import { alignMTFContext } from './MTFAligner';

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