import type { 
    ML1Candle, 
    ValidatedML1FeatureConfig,
    ML1FeatureState, 
    ML1Observation, 
    ML1FeatureValues, 
    ML1FeatureValidity 
} from './ML1FeatureTypes';
import { calculateCandleAnatomy } from './candle/CandleAnatomy';

/**
 * Validates the global configuration and returns a frozen, immutable defensive copy.
 */
export function validateML1Config(config: any): ValidatedML1FeatureConfig {
    if (!config || typeof config !== 'object') {
        throw new Error("Configuration Error: config must be a valid object.");
    }
    if (typeof config.symbol !== 'string' || config.symbol.trim() === '') {
        throw new Error("Configuration Error: symbol must be a non-empty string.");
    }
    if (typeof config.timeframe !== 'string' || config.timeframe.trim() === '') {
        throw new Error("Configuration Error: timeframe must be a non-empty string.");
    }
    if (!Number.isFinite(config.expectedIntervalMs) || config.expectedIntervalMs <= 0) {
        throw new Error("Configuration Error: expectedIntervalMs must be a positive finite number.");
    }
    if (!Number.isFinite(config.gapDiscontinuityThresholdMs) || config.gapDiscontinuityThresholdMs < config.expectedIntervalMs) {
        throw new Error("Configuration Error: gapDiscontinuityThresholdMs must be >= expectedIntervalMs.");
    }

    const validateAndFreezePeriods = (arr: any, name: string): readonly number[] => {
        if (!Array.isArray(arr)) {
            throw new Error(`Configuration Error: ${name} must be an array.`);
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
        return Object.freeze([...arr]);
    };

    const validatedCopy = {
        symbol: config.symbol,
        timeframe: config.timeframe,
        expectedIntervalMs: config.expectedIntervalMs,
        gapDiscontinuityThresholdMs: config.gapDiscontinuityThresholdMs,
        emaPeriods: validateAndFreezePeriods(config.emaPeriods, 'emaPeriods'),
        atrPeriods: validateAndFreezePeriods(config.atrPeriods, 'atrPeriods'),
        rollingRangePeriods: validateAndFreezePeriods(config.rollingRangePeriods, 'rollingRangePeriods'),
        momentumPeriods: validateAndFreezePeriods(config.momentumPeriods, 'momentumPeriods'),
        volumeSmaPeriods: validateAndFreezePeriods(config.volumeSmaPeriods, 'volumeSmaPeriods')
    };

    return Object.freeze(validatedCopy) as ValidatedML1FeatureConfig;
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
    // 1. Strict Contract Enforcements & Restored State Consistency
    if (!previousState || previousState.stateVersion !== 1) {
        throw new Error(`State Integrity Error: Incompatible state version or malformed state.`);
    }
    
    const hasIdx = previousState.lastBarIndex !== null;
    const hasTs = previousState.lastTimestamp !== null;
    const hasClose = previousState.lastClose !== null;
    
    if ((hasIdx || hasTs || hasClose) && !(hasIdx && hasTs && hasClose)) {
        throw new Error(`State Integrity Error: Partial state detected. Index, Timestamp, and Close must all be null or all be populated.`);
    }

    if (hasIdx && (!Number.isSafeInteger(previousState.lastBarIndex) || previousState.lastBarIndex! < 0)) {
        throw new Error(`State Integrity Error: Corrupted lastBarIndex in restored state.`);
    }
    if (hasTs && !Number.isFinite(previousState.lastTimestamp)) {
        throw new Error(`State Integrity Error: Corrupted lastTimestamp in restored state.`);
    }
    if (hasClose && !Number.isFinite(previousState.lastClose)) {
        throw new Error(`State Integrity Error: Corrupted lastClose in restored state.`);
    }

    const features: ML1FeatureValues = {};
    const validity: ML1FeatureValidity = {};

    // 2. Data Integrity & Base Metrics
    const isValidOhlcv = isOhlcvValid(candle);
    features['IsValidOHLCV'] = isValidOhlcv ? 1 : 0;
    validity['IsValidOHLCV'] = true;

    const hasSyntheticMetadata = typeof candle.isSynthetic === 'boolean';
    features['IsSynthetic'] = candle.isSynthetic === true ? 1 : 0;
    validity['IsSynthetic'] = hasSyntheticMetadata;

    const isFlat = isValidOhlcv && candle.high === candle.low && candle.close === candle.open;
    features['IsFlatCandle'] = isFlat ? 1 : 0;
    validity['IsFlatCandle'] = isValidOhlcv;
    
    const isZeroVolume = isValidOhlcv && candle.volume === 0;
    features['IsZeroVolume'] = isZeroVolume ? 1 : 0;
    validity['IsZeroVolume'] = isValidOhlcv;

    // 3. Phase 2B: Candle Anatomy (Calculated independently of state acceptance)
    if (isValidOhlcv) {
        const anatomy = calculateCandleAnatomy(candle);
        Object.assign(features, anatomy.features);
        Object.assign(validity, anatomy.validity);
    }

    // 4. Independent Index Validation
    const isSafeIndex = Number.isSafeInteger(barIndex) && barIndex >= 0;
    let isInvalidIndex = !isSafeIndex;
    
    if (isSafeIndex && previousState.lastBarIndex !== null) {
        if (barIndex <= previousState.lastBarIndex) {
            isInvalidIndex = true;
        }
    }
    
    features['IsInvalidIndex'] = isInvalidIndex ? 1 : 0;
    validity['IsInvalidIndex'] = true;

    // 5. Chronology & Gap Detection
    let hasDataGap = false;
    let isDiscontinuity = false;
    let isDuplicate = false;
    let isOutOfOrder = false;
    let isUnexpectedInterval = false;

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
    } else {
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

    // 6. State Rejection Gate
    const isRejected = !isValidOhlcv || isDuplicate || isOutOfOrder || isInvalidIndex || isUnexpectedInterval;

    if (!isRejected) {
        // -------------------------------------------------------------
        // Future phases (2C-2F) will calculate rolling indicators and mutate 
        // `features`, `validity`, and build sub-state replacements here.
        // -------------------------------------------------------------
    }

    // 6. Assemble final observation
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

    // 7. Immutably advance state (or return exact reference if rejected)
    const nextState: ML1FeatureState = isRejected 
        ? previousState 
        : {
            ...previousState,
            lastBarIndex: barIndex,
            lastTimestamp: candle.time,
            lastClose: candle.close
        };

    return { observation, nextState };
}
