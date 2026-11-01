import type { 
    ML1Candle, 
    ValidatedML1FeatureConfig,
    ML1FeatureState, 
    ML1Observation, 
    ML1FeatureValues, 
    ML1FeatureValidity,
    ATRPeriodState,
    RollingRangePeriodState
} from './ML1FeatureTypes';
import { calculateCandleAnatomy } from './candle/CandleAnatomy';
import { updateWilderATR } from './volatility/ATR';
import { updateRollingRange } from './volatility/RollingRange';

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
    return Object.freeze({
        stateVersion: 1,
        lastBarIndex: null,
        lastTimestamp: null,
        lastClose: null,
        atrState: Object.freeze({}),
        rollingRangeState: Object.freeze({})
    });
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

    // Enforce that both sub-state containers exist and are valid objects
    if (!previousState.atrState || typeof previousState.atrState !== 'object') {
        throw new Error(`State Integrity Error: Missing or malformed atrState container.`);
    }
    if (!previousState.rollingRangeState || typeof previousState.rollingRangeState !== 'object') {
        throw new Error(`State Integrity Error: Missing or malformed rollingRangeState container.`);
    }

    for (const [periodStr, pState] of Object.entries(previousState.atrState)) {
        const period = Number(periodStr);
        if (!Number.isSafeInteger(period) || period <= 0) {
            throw new Error(`State Integrity Error: Invalid period key '${periodStr}' in atrState.`);
        }
        if (!config.atrPeriods.includes(period)) {
            throw new Error(`State Integrity Error: Unexpected period key '${periodStr}' in atrState not found in configuration.`);
        }
        if (!pState || typeof pState !== 'object') {
            throw new Error(`State Integrity Error: Malformed atrState for period ${period}.`);
        }
        if (!Number.isSafeInteger(pState.count) || pState.count < 0) {
            throw new Error(`State Integrity Error: Corrupted count in atrState for period ${period}.`);
        }
        if (!Number.isFinite(pState.seedMean) || pState.seedMean < 0) {
            throw new Error(`State Integrity Error: Corrupted seedMean in atrState for period ${period}.`);
        }
        if (typeof pState.isSeeded !== 'boolean') {
            throw new Error(`State Integrity Error: Corrupted isSeeded in atrState for period ${period}.`);
        }
        if (pState.isSeeded) {
            if (pState.count < period || !Number.isFinite(pState.atr) || pState.atr! < 0) {
                throw new Error(`State Integrity Error: Inconsistent seeded ATR in atrState for period ${period}.`);
            }
        } else {
            if (pState.count >= period) {
                throw new Error(`State Integrity Error: Unseeded state cannot have completed count ${pState.count} >= ${period}.`);
            }
            if (pState.atr !== null) {
                throw new Error(`State Integrity Error: Unseeded ATR must have atr === null for period ${period}.`);
            }
        }
    }

    for (const [periodStr, rState] of Object.entries(previousState.rollingRangeState)) {
        const period = Number(periodStr);
        if (!Number.isSafeInteger(period) || period <= 0) {
            throw new Error(`State Integrity Error: Invalid period key '${periodStr}' in rollingRangeState.`);
        }
        if (!config.rollingRangePeriods.includes(period)) {
            throw new Error(`State Integrity Error: Unexpected period key '${periodStr}' in rollingRangeState not found in configuration.`);
        }
        if (!rState || typeof rState !== 'object') {
            throw new Error(`State Integrity Error: Malformed rollingRangeState for period ${period}.`);
        }
        if (!Array.isArray(rState.highs) || !Array.isArray(rState.lows)) {
            throw new Error(`State Integrity Error: Rolling range buffers must be arrays for period ${period}.`);
        }
        if (rState.highs.length !== rState.lows.length || rState.highs.length > period) {
            throw new Error(`State Integrity Error: Inconsistent buffer length in rollingRangeState for period ${period}.`);
        }
        for (let k = 0; k < rState.highs.length; k++) {
            if (!Number.isFinite(rState.highs[k]) || !Number.isFinite(rState.lows[k])) {
                throw new Error(`State Integrity Error: Non-finite values in rollingRangeState for period ${period}.`);
            }
        }
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

    const nextAtrState: Record<number, ATRPeriodState> = { ...previousState.atrState };
    const nextRollingRangeState: Record<number, RollingRangePeriodState> = { ...previousState.rollingRangeState };

    if (!isRejected) {
        // -------------------------------------------------------------
        // Phase 2C: ATR & Rolling Volatility
        // -------------------------------------------------------------
        for (const period of config.atrPeriods) {
            const res = updateWilderATR(
                candle.high,
                candle.low,
                previousState.lastClose,
                period,
                previousState.atrState[period],
                isDiscontinuity
            );

            nextAtrState[period] = res.nextState;
            features[`ATR_${period}`] = res.isValid ? res.atrValue : 0;
            validity[`ATR_${period}`] = res.isValid;

            // Normalized ATR relative to Close price with finite check (safe against zero ATR)
            const normAtr = res.isValid && res.atrValue > 0 && candle.close > 0 ? res.atrValue / candle.close : NaN;
            const isNormValid = Number.isFinite(normAtr) && normAtr >= 0;
            features[`ATR_${period}_Normalized`] = isNormValid ? normAtr : 0;
            validity[`ATR_${period}_Normalized`] = isNormValid;
        }

        // ATR Ratio (e.g. ATR14 / ATR20) with finite check
        if (config.atrPeriods.includes(14) && config.atrPeriods.includes(20)) {
            const atr14Valid = validity['ATR_14'] === true;
            const atr20Valid = validity['ATR_20'] === true;
            const ratio = (atr14Valid && atr20Valid && features['ATR_20'] > 0)
                ? features['ATR_14'] / features['ATR_20']
                : NaN;
            const isRatioValid = Number.isFinite(ratio) && ratio > 0;
            features['ATR14_to_ATR20'] = isRatioValid ? ratio : 0;
            validity['ATR14_to_ATR20'] = isRatioValid;
        }

        // Rolling High-Low Ranges
        for (const period of config.rollingRangePeriods) {
            const res = updateRollingRange(
                candle.high,
                candle.low,
                candle.close,
                period,
                previousState.rollingRangeState[period],
                isDiscontinuity
            );

            nextRollingRangeState[period] = res.nextState;
            features[`RollingHighestHigh_${period}`] = res.isValid ? res.highestHigh : 0;
            validity[`RollingHighestHigh_${period}`] = res.isValid;

            features[`RollingLowestLow_${period}`] = res.isValid ? res.lowestLow : 0;
            validity[`RollingLowestLow_${period}`] = res.isValid;

            features[`RollingRangeWidth_${period}`] = res.isValid ? res.rangeWidth : 0;
            validity[`RollingRangeWidth_${period}`] = res.isValid;

            features[`PositionWithinRollingRange_${period}`] = res.isValid ? res.closePosition : 0;
            validity[`PositionWithinRollingRange_${period}`] = res.isValid && res.rangeWidth > 0;

            // Price distance to rolling extremes with finite safeguards
            const highDist = res.isValid ? res.highestHigh - candle.close : 0;
            const isHighDistValid = res.isValid && Number.isFinite(highDist);
            features[`RollingHighDistance_${period}`] = isHighDistValid ? highDist : 0;
            validity[`RollingHighDistance_${period}`] = isHighDistValid;

            const lowDist = res.isValid ? candle.close - res.lowestLow : 0;
            const isLowDistValid = res.isValid && Number.isFinite(lowDist);
            features[`RollingLowDistance_${period}`] = isLowDistValid ? lowDist : 0;
            validity[`RollingLowDistance_${period}`] = isLowDistValid;
        }

        // ATR-Normalized Candle Anatomy (Valid ONLY when ATR and ratio results are finite)
        if (validity['ATR_14'] === true && features['ATR_14'] > 0) {
            const atr14 = features['ATR_14'];
            const r14 = features['CandleRange'] / atr14;
            const b14 = features['BodySize'] / atr14;
            const r14Valid = validity['CandleRange'] === true && Number.isFinite(r14);
            const b14Valid = validity['BodySize'] === true && Number.isFinite(b14);

            features['RangeToATR14'] = r14Valid ? r14 : 0;
            validity['RangeToATR14'] = r14Valid;

            features['BodyToATR14'] = b14Valid ? b14 : 0;
            validity['BodyToATR14'] = b14Valid;
        } else {
            features['RangeToATR14'] = 0;
            validity['RangeToATR14'] = false;
            features['BodyToATR14'] = 0;
            validity['BodyToATR14'] = false;
        }

        if (validity['ATR_20'] === true && features['ATR_20'] > 0) {
            const atr20 = features['ATR_20'];
            const r20 = features['CandleRange'] / atr20;
            const b20 = features['BodySize'] / atr20;
            const r20Valid = validity['CandleRange'] === true && Number.isFinite(r20);
            const b20Valid = validity['BodySize'] === true && Number.isFinite(b20);

            features['RangeToATR20'] = r20Valid ? r20 : 0;
            validity['RangeToATR20'] = r20Valid;

            features['BodyToATR20'] = b20Valid ? b20 : 0;
            validity['BodyToATR20'] = b20Valid;
        } else {
            features['RangeToATR20'] = 0;
            validity['RangeToATR20'] = false;
            features['BodyToATR20'] = 0;
            validity['BodyToATR20'] = false;
        }
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
        : Object.freeze({
            ...previousState,
            lastBarIndex: barIndex,
            lastTimestamp: candle.time,
            lastClose: candle.close,
            atrState: Object.freeze(nextAtrState),
            rollingRangeState: Object.freeze(nextRollingRangeState)
        });

    return { observation, nextState };
}
