import type {
    ML1Candle,
    ML1FeatureState,
    ML1FeatureStateV6,
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
/**
 * Completed HTF candle for [openTimestamp, closeTimestamp).
 * Incomplete windows are represented only by HTFIncompleteDiagnostic.
 */
export interface MTFCandle {
    readonly timeframe: SupportedMTFTimeframe;
    readonly openTimestamp: number; // Inclusive window start
    readonly closeTimestamp: number; // Exclusive close boundary
    readonly open: number;
    readonly high: number;
    readonly low: number;
    readonly close: number;
    readonly volume: number;
    readonly sourceObservationCount: number;
    readonly completeness: 'COMPLETE';
}

/**
 * Context Availability & Freshness Status Contract:
 *
 * | Status          | Meaning                                                             | isAvailable |
 * | --------------- | ------------------------------------------------------------------- | ----------- |
 * | UNAVAILABLE     | No eligible completed candle exists or reset is underway            | false       |
 * | WARMING_UP      | Completed candle exists; context is available but features are warm | true        |
 * | AVAILABLE_VALID | Completed candle exists and requested features are valid            | true        |
 * | STALE           | Candle age exceeds maxStalenessMs; excluded from consumption        | false       |
 */
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
    readonly observedTimestamps: readonly number[];
    readonly actualSourceCount: number;
    readonly runningOpen: number | null;
    readonly runningHigh: number | null;
    readonly runningLow: number | null;
    readonly runningClose: number | null;
    readonly runningVolume: number;
    readonly duplicateCount: number;
    readonly invalidSourceCount: number;
    readonly lastObservedSourceTimestamp: number | null;
    readonly lastAcceptedSourceTimestamp: number | null;
    readonly lastCompletedCandle: MTFCandle | null;
    readonly lastDiagnostic: HTFIncompleteDiagnostic | null;
}

export interface MTFTimeframeState {
    readonly timeframe: SupportedMTFTimeframe;
    readonly aggregation: HTFAggregationState;
    readonly featureEngineState: ML1FeatureState;
    readonly lastCompletedBarIndex: number | null;
    readonly lastCompletedCandleOpenTimestamp: number | null;
    readonly latestFeatures: ML1FeatureValues;
    readonly latestValidity: ML1FeatureValidity;
}

export interface MTFState {
    readonly stateVersion: number;
    readonly last1mBarIndex: number | null;
    readonly last1mTimestamp: number | null;
    readonly state15m: MTFTimeframeState;
    readonly state1h: MTFTimeframeState;
}

// =========================================================================
// V4 MTF Contracts (3m & 5m Only; 15m & 1h Excluded)
// =========================================================================
export type SupportedV4MTFTimeframe = '3m' | '5m';

export interface V4HTFIncompleteDiagnostic {
    readonly timeframe: SupportedV4MTFTimeframe;
    readonly openTimestamp: number;
    readonly closeTimestamp: number;
    readonly expectedSourceCount: number;
    readonly actualSourceCount: number;
    readonly missingTimestamps: readonly number[];
    readonly duplicateCount: number;
    readonly invalidSourceCount: number;
    readonly completeness: HTFWindowCompleteness;
}

export interface V4MTFCandle {
    readonly timeframe: SupportedV4MTFTimeframe;
    readonly openTimestamp: number;
    readonly closeTimestamp: number;
    readonly open: number;
    readonly high: number;
    readonly low: number;
    readonly close: number;
    readonly volume: number;
    readonly sourceObservationCount: number;
    readonly completeness: 'COMPLETE';
}

export interface V4MTFTimeframeContext {
    readonly timeframe: SupportedV4MTFTimeframe;
    readonly lastCompletedCandle: V4MTFCandle | null;
    readonly lastCompletedOpenTimestamp: number | null;
    readonly lastCompletedCloseTimestamp: number | null;
    readonly contextAgeMs: number | null;
    readonly isAvailable: boolean;
    readonly availabilityStatus: HTFContextAvailability;
    readonly isWarmupComplete: boolean;
    readonly features: ML1FeatureValues;
    readonly validity: ML1FeatureValidity;
}

export interface V4MTFContext {
    readonly observationTimestamp: number;
    readonly symbol: string;
    readonly context3m: V4MTFTimeframeContext;
    readonly context5m: V4MTFTimeframeContext;
}

export interface V4HTFAggregationState {
    readonly currentWindowOpen: number | null;
    readonly currentWindowClose: number | null;
    readonly sourceCandles: readonly ML1Candle[];
    readonly sourceTimestamps: readonly number[];
    readonly observedTimestamps: readonly number[];
    readonly actualSourceCount: number;
    readonly runningOpen: number | null;
    readonly runningHigh: number | null;
    readonly runningLow: number | null;
    readonly runningClose: number | null;
    readonly runningVolume: number;
    readonly duplicateCount: number;
    readonly invalidSourceCount: number;
    readonly lastObservedSourceTimestamp: number | null;
    readonly lastAcceptedSourceTimestamp: number | null;
    readonly lastCompletedCandle: V4MTFCandle | null;
    readonly lastDiagnostic: V4HTFIncompleteDiagnostic | null;
}

export interface V4MTFTimeframeState {
    readonly timeframe: SupportedV4MTFTimeframe;
    readonly aggregation: V4HTFAggregationState;
    readonly featureEngineState: ML1FeatureStateV6;
    readonly lastCompletedBarIndex: number | null;
    readonly lastCompletedCandleOpenTimestamp: number | null;
    readonly latestFeatures: ML1FeatureValues;
    readonly latestValidity: ML1FeatureValidity;
}

export interface V4MTFState {
    readonly stateVersion: 2;
    readonly last1mBarIndex: number | null;
    readonly last1mTimestamp: number | null;
    readonly state3m: V4MTFTimeframeState;
    readonly state5m: V4MTFTimeframeState;
}

