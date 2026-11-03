import type { ML1Candle, ML1FeatureValues, ML1FeatureValidity } from '../ML1FeatureTypes';
import type { MTFTimeframeContext, HTFIncompleteDiagnostic } from '../mtf/MTFTypes';

export interface DataQualityStatus {
    readonly isSourceValid: boolean;
    readonly hasDataGap: boolean;
    readonly isDiscontinuity: boolean;
    readonly isDuplicate: boolean;
    readonly isOutOfOrder: boolean;
    readonly isUnexpectedInterval: boolean;
}

/**
 * 🔒 TIMESTAMP & AVAILABILITY CONTRACT
 *
 * - sourceTimestamp:
 *   Exact opening timestamp of the original 1m source candle.
 *
 * - observationTimestamp:
 *   Exact time the completed observation becomes available.
 *   This is the exclusive close boundary of the source candle.
 *
 * Observation availability is independent of downstream strategy
 * decisions and execution timing.
 *
 * Any mapping to decision or execution timestamps belongs to a
 * separately versioned execution contract.
 */
export interface ContinuousObservationRow {
    readonly observationId: string;
    readonly sourceTimestamp: number;
    readonly observationTimestamp: number;
    readonly symbol: string;
    readonly timeframe: string;

    readonly sourceOHLCV: ML1Candle;
    readonly dataQuality: DataQualityStatus;

    readonly tierAFeatures: ML1FeatureValues;
    readonly tierAValidity: ML1FeatureValidity;
    readonly context15m: MTFTimeframeContext;
    readonly context1h: MTFTimeframeContext;
    readonly htf15mDiagnostic: HTFIncompleteDiagnostic | null;
    readonly htf1hDiagnostic: HTFIncompleteDiagnostic | null;

    readonly structuralEventId: string | null;
}

export interface OutcomeRecord {
    readonly observationId: string;
    readonly outcomeDefinition: string;
    readonly horizonBars: number;
    readonly horizonEndTimestamp: number;
    readonly forwardReturns: Record<string, number>;
    readonly maximumFavorableExcursion: number;
    readonly maximumAdverseExcursion: number;
    readonly maturityStatus: 'MATURE' | 'IMMATURE' | 'INVALID' | 'UNAVAILABLE';
    readonly isOutcomeValid: boolean;
    readonly outcomeCompletionTimestamp: number | null;
}
