import type {
    ML1Candle,
    ML1FeatureState,
    ML1FeatureValidity,
    ML1FeatureValues
} from '../ML1FeatureTypes';

export type SupportedMTFTimeframe = '15m' | '1h';

export type HTFWindowCompleteness =
    | 'COMPLETE'
    | 'INCOMPLETE_MISSING'
    | 'INCOMPLETE_INVALID'
    | 'INCOMPLETE_DUPLICATE'
    | 'INCOMPLETE_UNFINISHED';

export interface HTFIncompleteDiagnostic {
    readonly timeframe: SupportedMTFTimeframe;
    readonly openTimestamp: number;
    readonly closeTimestamp: number;
    readonly expectedSourceCount: number;
    readonly actualSourceCount: number;
    readonly missingTimestamps: readonly number[];
    readonly duplicateCount: number;
    readonly invalidSourceCount: number;
    readonly completeness: HTFWindowCompleteness;
}

/**
 * Completed HTF candle for the half-open interval [openTimestamp, closeTimestamp).
 */
export interface MTFCandle {
    readonly timeframe: SupportedMTFTimeframe;
    readonly openTimestamp: number;
    readonly closeTimestamp: number;
    readonly open: number;
    readonly high: number;
    readonly low: number;
    readonly close: number;
    readonly volume: number;
    readonly sourceObservationCount: number;
    readonly isComplete: boolean;
}

export type HTFContextAvailability =
    | 'UNAVAILABLE'
    | 'WARMING_UP'
    | 'AVAILABLE_VALID'
    | 'STALE';

export interface MTFTimeframeContext {
    readonly timeframe: SupportedMTFTimeframe;
    readonly lastCompletedCandle: MTFCandle | null;
    readonly lastCompletedOpenTimestamp: number | null;
    readonly lastCompletedCloseTimestamp: number | null;
    readonly contextAgeMs: number | null;
    readonly isAvailable: boolean;
    readonly availabilityStatus: HTFContextAvailability;
    readonly isWarmupComplete: boolean;
    readonly features: ML1FeatureValues;
    readonly validity: ML1FeatureValidity;
}

export interface MTFContext {
    readonly observationTimestamp: number;
    readonly symbol: string;
    readonly context15m: MTFTimeframeContext;
    readonly context1h: MTFTimeframeContext;
}

export interface HTFAggregationState {
    readonly currentWindowOpen: number | null;
    readonly currentWindowClose: number | null;
    readonly sourceCandles: readonly ML1Candle[];
    readonly sourceTimestamps: readonly number[];
    readonly actualSourceCount: number;
    readonly runningOpen: number | null;
    readonly runningHigh: number | null;
    readonly runningLow: number | null;
    readonly runningClose: number | null;
    readonly runningVolume: number;
    readonly duplicateCount: number;
    readonly invalidSourceCount: number;
    readonly lastAcceptedSourceTimestamp: number | null;
    readonly lastCompletedCandle: MTFCandle | null;
    readonly lastDiagnostic: HTFIncompleteDiagnostic | null;
}

export interface MTFTimeframeState {
    readonly timeframe: SupportedMTFTimeframe;
    readonly aggregation: HTFAggregationState;
    readonly featureEngineState: ML1FeatureState;
    readonly lastCompletedBarIndex: number | null;
}

export interface MTFState {
    readonly stateVersion: number;
    readonly last1mBarIndex: number | null;
    readonly last1mTimestamp: number | null;
    readonly state15m: MTFTimeframeState;
    readonly state1h: MTFTimeframeState;
}
