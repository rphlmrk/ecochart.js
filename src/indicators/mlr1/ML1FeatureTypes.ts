import type { StrictCBCCandle } from '../plugins/StrictCBCZigZagIndicator';

/**
 * Extends the frozen Milestone 1 candle with Volume and optional upstream metadata.
 * Does not mutate the frozen StrictCBC interface.
 */
export interface ML1Candle extends StrictCBCCandle {
    volume: number;
    isSynthetic?: boolean;
}

/**
 * Global configuration parameters for the Tier A feature engine.
 */
export interface ML1FeatureConfig {
    symbol: string;
    timeframe: string;
    expectedIntervalMs: number;          
    gapDiscontinuityThresholdMs: number; 

    emaPeriods: number[];                
    atrPeriods: number[];                
    rollingRangePeriods: number[];       
    momentumPeriods: number[];           
    volumeSmaPeriods: number[];          
}

declare const validatedConfigBrand: unique symbol;

/**
 * Branded type enforcing that configuration has passed the engine's validation gate.
 * The engine MUST require this type to run. Features immutable period arrays.
 */
export type ValidatedML1FeatureConfig = {
    readonly symbol: string;
    readonly timeframe: string;
    readonly expectedIntervalMs: number;
    readonly gapDiscontinuityThresholdMs: number;
    readonly emaPeriods: readonly number[];
    readonly atrPeriods: readonly number[];
    readonly rollingRangePeriods: readonly number[];
    readonly momentumPeriods: readonly number[];
    readonly volumeSmaPeriods: readonly number[];
    readonly [validatedConfigBrand]: true;
};

export type ML1FeatureValidity = Record<string, boolean>;
export type ML1FeatureValues = Record<string, number>;

/**
 * Encapsulates all accumulated data required to process the next candle.
 * Modifying this interface defines the exact memory boundary of the state machine.
 */
export interface ML1FeatureState {
    readonly stateVersion: number;
    readonly lastBarIndex: number | null;
    readonly lastTimestamp: number | null;
    readonly lastClose: number | null;

    // Sub-module rolling state placeholders (Phase 2B - 2F)
    // readonly emaState: Record<number, { value: number; count: number }>;
    // readonly atrState: Record<number, { value: number; count: number }>;
    // ...
}

/**
 * The ultimate output of Milestone 2: One fully resolved, causal feature row.
 */
export interface ML1Observation {
    timestamp: number;
    symbol: string;
    timeframe: string;
    barIndex: number;

    // Original Source Data
    sourceOpen: number;
    sourceHigh: number;
    sourceLow: number;
    sourceClose: number;
    sourceVolume: number;

    // The Tier-A Vector
    features: ML1FeatureValues;
    validity: ML1FeatureValidity;
}
