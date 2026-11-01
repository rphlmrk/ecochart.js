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
export interface ATRPeriodState {
    readonly count: number;
    readonly seedMean: number;
    readonly atr: number | null;
    readonly isSeeded: boolean;
}

export interface RollingRangePeriodState {
    readonly highs: readonly number[];
    readonly lows: readonly number[];
}

export interface EMAPeriodState {
    readonly count: number;
    readonly seedMean: number;
    readonly ema: number | null;
    readonly isSeeded: boolean;
    readonly history: readonly number[]; // Trailing EMA values for slope calculations
    readonly unbrokenRun: number;        // Consecutive expected-interval bars
}

export interface ML1FeatureState {
    readonly stateVersion: number;
    readonly lastBarIndex: number | null;
    readonly lastTimestamp: number | null;
    readonly lastClose: number | null;

    // Sub-Module States
    readonly atrState: Readonly<Record<number, ATRPeriodState>>;
    readonly rollingRangeState: Readonly<Record<number, RollingRangePeriodState>>;
    readonly emaState: Readonly<Record<number, EMAPeriodState>>;
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
