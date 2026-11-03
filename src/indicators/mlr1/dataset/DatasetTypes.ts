import type { ML1Candle, ML1FeatureValues, ML1FeatureValidity } from '../ML1FeatureTypes';
import type { MTFTimeframeContext } from '../mtf/MTFTypes';

export interface DataQualityStatus {
    readonly isSourceValid: boolean;
    readonly hasDataGap: boolean;
    readonly isDiscontinuity: boolean;
    readonly isDuplicate: boolean;
    readonly isOutOfOrder: boolean;
    readonly isUnexpectedInterval: boolean;
}

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
