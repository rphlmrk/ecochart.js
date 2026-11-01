import type { 
    ML1Candle, 
    ML1FeatureConfig, 
    ValidatedML1FeatureConfig,
    ML1FeatureState, 
    ML1Observation, 
    ML1FeatureValues, 
    ML1FeatureValidity 
} from './ML1FeatureTypes';

/**
 * Validates the global configuration to prevent silent mathematical corruption.
 * Returns a branded ValidatedML1FeatureConfig type required by the transition engine.
 */
export function validateML1Config(config: ML1FeatureConfig): ValidatedML1FeatureConfig {
    if (!config.symbol || config.symbol.trim() === '') {
        throw new Error("Configuration Error: symbol must be a non-empty string.");
    }
    if (!config.timeframe || config.timeframe.trim() === '') {
        throw new Error("Configuration Error: timeframe must be a non-empty string.");
    }
    if (!Number.isFinite(config.expectedIntervalMs) || config.expectedIntervalMs <= 0) {
        throw new Error("Configuration Error: expectedIntervalMs must be a positive finite number.");
    }
    if (!Number.isFinite(config.gapDiscontinuityThresholdMs) || config.gapDiscontinuityThresholdMs < config.expectedIntervalMs) {
        throw new Error("Configuration Error: gapDiscontinuityThresholdMs must be >= expectedIntervalMs.");
    }

    const validatePeriods = (arr: number[], name: string) => {
        if (!Array.isArray(arr) || arr.length === 0) {
            throw new Error(`Configuration Error: ${name} must be a non-empty array.`);
        }
        const seen = new Set<number>();
        for (const p of arr) {
            if (!Number.isSafeInteger(p) || p <= 0) {
                throw new Error(`Configuration Error: ${name} must contain only positive safe integers.`);
            }
            if (seen.has(p)) {
                throw new Error(`Configuration Error: ${name} contains duplicate periods.`);
            }
            seen.add(p);
        }
    };

    validatePeriods(config.emaPeriods, 'emaPeriods');
    validatePeriods(config.atrPeriods, 'atrPeriods');
    validatePeriods(config.rollingRangePeriods, 'rollingRangePeriods');
    validatePeriods(config.momentumPeriods, 'momentumPeriods');
    validatePeriods(config.volumeSmaPeriods, 'volumeSmaPeriods');

    return config as ValidatedML1FeatureConfig;
}

/**
 * Initializes the pure causal state machine.
 */
export function createInitialML1FeatureState(): ML1FeatureState {
    return {
        stateVersion: 1,
        lastBarIndex: null,
        lastTimestamp: null,
        lastClose: null
    };
}

/**
 * Validates base OHLCV sanity, ensuring no NaN/Inf or impossible wicks/volumes.
 */
function isOhlcvValid(c: ML1Candle): boolean {
    if (!Number.isFinite(c.time) || !Number.isFinite(c.open) || !Number.isFinite(c.high) || 
        !Number.isFinite(c.low) || !Number.isFinite(c.close) || !Number.isFinite(c.volume)) return false;
    
    // Structural integrity
    if (c.high < c.low) return false;
    if (c.high < Math.max(c.open, c.close)) return false;
    if (c.low > Math.min(c.open, c.close)) return false;
    if (c.volume < 0) return false;
    
    return true;
}

/**
 * Pure Single-Bar Transition Function for Tier A Features.
 */
export function stepML1Features(
    candle: ML1Candle,
    barIndex: number,
    previousState: ML1FeatureState,
    config: ValidatedML1FeatureConfig
): {
    observation: ML1Observation;
    nextState: ML1FeatureState;
} {
    // 1. Strict Contract Enforcements
    if (previousState.stateVersion !== 1) {
        throw new Error(`State Integrity Error: Incompatible state version. Expected 1, got ${previousState.stateVersion}.`);
    }

    const features: ML1FeatureValues = {};
    const validity: ML1FeatureValidity = {};

    // 2. Data Integrity & Base Metrics
    const isValidOhlcv = isOhlcvValid(candle);
    features['IsValidOHLCV'] = isValidOhlcv ? 1 : 0;
    validity['IsValidOHLCV'] = true;

    // Explicit boolean requirement for synthetic metadata
    const hasSyntheticMetadata = typeof candle.isSynthetic === 'boolean';
    features['IsSynthetic'] = candle.isSynthetic === true ? 1 : 0;
    validity['IsSynthetic'] = hasSyntheticMetadata;

    const isFlat = isValidOhlcv && candle.high === candle.low && candle.close === candle.open;
    features['IsFlatCandle'] = isFlat ? 1 : 0;
    validity['IsFlatCandle'] = isValidOhlcv;
    
    const isZeroVolume = isValidOhlcv && candle.volume === 0;
    features['IsZeroVolume'] = isZeroVolume ? 1 : 0;
    validity['IsZeroVolume'] = isValidOhlcv;

    // 3. Chronology & Gap Detection
    let hasDataGap = false;
    let isDiscontinuity = false;
    let isDuplicate = false;
    let isOutOfOrder = false;
    let isUnexpectedInterval = false;
    
    const isSafeIndex = Number.isSafeInteger(barIndex) && barIndex >= 0;
    let isInvalidIndex = !isSafeIndex;

    if (previousState.lastTimestamp !== null) {
        const timeDelta = candle.time - previousState.lastTimestamp;
        
        if (Number.isNaN(timeDelta) || !Number.isFinite(timeDelta)) {
            isOutOfOrder = true;
        } else if (timeDelta === 0) {
            isDuplicate = true;
        } else if (timeDelta < 0) {
            isOutOfOrder = true;
        } else if (timeDelta < config.expectedIntervalMs) {
            isUnexpectedInterval = true;
        } else if (timeDelta > config.expectedIntervalMs) {
            hasDataGap = true;
            if (timeDelta >= config.gapDiscontinuityThresholdMs) {
                isDiscontinuity = true;
            }
        }
        
        features['HasDataGap'] = hasDataGap ? 1 : 0;
        validity['HasDataGap'] = true;

        if (isSafeIndex && previousState.lastBarIndex !== null) {
            if (barIndex <= previousState.lastBarIndex) {
                isInvalidIndex = true;
            }
        }
    } else {
        // First observation: gap and sequence status are strictly unobservable
        features['HasDataGap'] = 0;
        validity['HasDataGap'] = false;
    }

    features['IsDiscontinuity'] = isDiscontinuity ? 1 : 0;
    validity['IsDiscontinuity'] = previousState.lastTimestamp !== null;
    
    features['IsUnexpectedInterval'] = isUnexpectedInterval ? 1 : 0;
    validity['IsUnexpectedInterval'] = previousState.lastTimestamp !== null;

    features['IsDuplicateTimestamp'] = isDuplicate ? 1 : 0;
    validity['IsDuplicateTimestamp'] = previousState.lastTimestamp !== null;
    
    features['IsOutOfOrder'] = isOutOfOrder ? 1 : 0;
    validity['IsOutOfOrder'] = previousState.lastTimestamp !== null;

    features['IsInvalidIndex'] = isInvalidIndex ? 1 : 0;
    validity['IsInvalidIndex'] = true;

    // 4. State Rejection Gate
    // If chronology is corrupted, OHLCV is invalid, or interval is unexpectedly short,
    // we MUST NOT advance the accepted state.
    const isRejected = !isValidOhlcv || isDuplicate || isOutOfOrder || isInvalidIndex || isUnexpectedInterval;

    if (!isRejected) {
        // -------------------------------------------------------------
        // Future phases (2B-2F) will calculate indicators and mutate 
        // `features`, `validity`, and build sub-state replacements here.
        // Nested states must be explicitly shallow/deep copied.
        // -------------------------------------------------------------
    }

    // 5. Assemble final observation
    const observation: ML1Observation = {
        timestamp: candle.time,
        symbol: config.symbol,
        timeframe: config.timeframe,
        barIndex,
        sourceOpen: candle.open,
        sourceHigh: candle.high,
        sourceLow: candle.low,
        sourceClose: candle.close,
        sourceVolume: candle.volume,
        features,
        validity
    };

    // 6. Immutably advance state (or return existing if rejected)
    const nextState: ML1FeatureState = isRejected ? previousState : {
        ...previousState,
        lastBarIndex: barIndex,
        lastTimestamp: candle.time,
        lastClose: candle.close
        // Future: spread nested objects explicitly to enforce immutability:
        // emaState: { ...previousState.emaState } 
    };

    return { observation, nextState };
}
