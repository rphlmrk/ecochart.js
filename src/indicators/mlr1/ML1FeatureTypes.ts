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

export interface MomentumState {
    readonly closeHistory: readonly number[]; // Trailing closes up to max lookback + 1
    readonly unbrokenRun: number;            // Number of consecutive observations without discontinuity
}

export interface VolumeState {
    readonly volumeHistory: readonly number[]; // Trailing volumes up to max lookback (50)
    readonly unbrokenRun: number;             // Consecutive observations without discontinuity
}

export interface ExhaustionPeriodState {
    readonly tpHistory: readonly number[];
    readonly unbrokenRun: number;
}

export interface VolumeCandleSizeState {
    readonly jamHistory: readonly number[];
    readonly unbrokenRun: number;
}

export interface VAMState {
    readonly unbrokenRun: number;
    readonly prevHigh: number | null;
    readonly prevLow: number | null;
    readonly prevClose: number | null;
    readonly hlc3History: readonly number[];
    readonly adaptive: number | null;
    readonly centerSeedCount: number;
    readonly centerSeedMean: number;
    readonly center: number | null;
    readonly centerHistory: readonly number[];
    readonly atrState: ATRPeriodState;
    readonly dmiCount: number;
    readonly trSeedMean: number;
    readonly plusDmSeedMean: number;
    readonly minusDmSeedMean: number;
    readonly trRma: number | null;
    readonly plusDmRma: number | null;
    readonly minusDmRma: number | null;
    readonly dxHistoryCount: number;
    readonly dxSeedMean: number;
    readonly adx: number | null;
    readonly rsiCount: number;
    readonly avgGainSeedMean: number;
    readonly avgLossSeedMean: number;
    readonly avgGain: number | null;
    readonly avgLoss: number | null;
    readonly trend: -1 | 0 | 1;
    readonly buyStreak: number;
    readonly sellStreak: number;
    readonly lastSignalAcceptedIndex: number | null;
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
    readonly momentumState: MomentumState;
    readonly volumeState: VolumeState;
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

export interface ML1FeatureConfigV5 extends ML1FeatureConfig {
    cciPeriods: number[];
    volumeCandleSizePeriods: number[];
    enableVAM: boolean;
}

declare const validatedConfigV5Brand: unique symbol;

export type ValidatedML1FeatureConfigV5 = {
    readonly symbol: string;
    readonly timeframe: string;
    readonly expectedIntervalMs: number;
    readonly gapDiscontinuityThresholdMs: number;
    readonly emaPeriods: readonly number[];
    readonly atrPeriods: readonly number[];
    readonly rollingRangePeriods: readonly number[];
    readonly momentumPeriods: readonly number[];
    readonly volumeSmaPeriods: readonly number[];
    readonly cciPeriods: readonly number[];
    readonly volumeCandleSizePeriods: readonly number[];
    readonly enableVAM: boolean;
    readonly [validatedConfigV5Brand]: true;
};

export interface ML1FeatureStateV5 {
    readonly stateVersion: 5;
    readonly configFingerprint: string;
    readonly baseState: ML1FeatureState; // Isolates frozen v4 state cleanly
    readonly exhaustionState: Readonly<Record<number, ExhaustionPeriodState>>;
    readonly volumeCandleSizeState: Readonly<Record<number, VolumeCandleSizeState>>;
    readonly vamState: VAMState | null;
}

export interface SMAPeriodState {
    readonly closeHistory: readonly number[];
    readonly smaHistory: readonly number[];
    readonly unbrokenRun: number;
}

export interface MACDState {
    readonly fastEma: EMAPeriodState | null;
    readonly slowEma: EMAPeriodState | null;
    readonly signalEma: EMAPeriodState | null;
}

export interface BollingerBandState {
    readonly closeHistory: readonly number[];
    readonly unbrokenRun: number;
}

export interface ML1FeatureConfigV6 extends ML1FeatureConfigV5 {
    smaPeriods: number[];
    enableMACD: boolean;
    bbPeriod: number | null;
    bbStdMult: number;
}

declare const validatedConfigV6Brand: unique symbol;

export type ValidatedML1FeatureConfigV6 = {
    readonly symbol: string;
    readonly timeframe: string;
    readonly expectedIntervalMs: number;
    readonly gapDiscontinuityThresholdMs: number;
    readonly emaPeriods: readonly number[];
    readonly atrPeriods: readonly number[];
    readonly rollingRangePeriods: readonly number[];
    readonly momentumPeriods: readonly number[];
    readonly volumeSmaPeriods: readonly number[];
    readonly cciPeriods: readonly number[];
    readonly volumeCandleSizePeriods: readonly number[];
    readonly enableVAM: boolean;
    readonly smaPeriods: readonly number[];
    readonly enableMACD: boolean;
    readonly bbPeriod: number | null;
    readonly bbStdMult: number;
    readonly [validatedConfigV6Brand]: true;
};

export interface ML1FeatureStateV6 {
    readonly stateVersion: 6;
    readonly configFingerprint: string;
    readonly v5State: ML1FeatureStateV5;
    readonly smaState: Readonly<Record<number, SMAPeriodState>>;
    readonly macdState: MACDState | null;
    readonly bbState: BollingerBandState | null;
}

