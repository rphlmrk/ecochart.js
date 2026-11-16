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
import { updateEMA, calculateEMASlope } from './trend/EMA';
import { 
    updateMomentumState, 
    calculateReturn, 
    calculateMomentum, 
    calculateDirectionalEfficiency, 
    calculateReturnConsistency 
} from './momentum/Momentum';
import { 
    updateVolumeState, 
    calculateBaseVolume, 
    calculateRelativeVolume, 
    calculateVolumeZScore 
} from './volume/VolumeFeatures';
import { calculateTemporalFeatures } from './temporal/TimeFeatures';
import type { EMAPeriodState, MomentumState, VolumeState } from './ML1FeatureTypes';
import { updateExhaustionCCI } from './momentum/Exhaustion';
import { updateVolumeCandleSize } from './volume/VolumeCandleSize';
import { createInitialVAMState, stepVolatilityAdjustedMean } from './trend/VolatilityAdjustedMean';
import type {
    ExhaustionPeriodState,
    VolumeCandleSizeState,
    VAMState,
    ML1FeatureStateV5,
    ValidatedML1FeatureConfigV5
} from './ML1FeatureTypes';

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
            if (name === 'momentumPeriods' && p > 20) {
                throw new Error(`Configuration Error: momentumPeriods cannot exceed maximum lookback of 20, got ${p}.`);
            }
            if (name === 'volumeSmaPeriods' && p > 50) {
                throw new Error(`Configuration Error: volumeSmaPeriods cannot exceed maximum lookback of 50, got ${p}.`);
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
        stateVersion: 4, // Version 4: Enforces Phase 2F Volume state schema
        lastBarIndex: null,
        lastTimestamp: null,
        lastClose: null,
        atrState: Object.freeze({}),
        rollingRangeState: Object.freeze({}),
        emaState: Object.freeze({}),
        momentumState: Object.freeze({ closeHistory: Object.freeze([]), unbrokenRun: 0 }),
        volumeState: Object.freeze({ volumeHistory: Object.freeze([]), unbrokenRun: 0 })
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
    if (!previousState || previousState.stateVersion !== 4) {
        throw new Error(`State Integrity Error: Incompatible state version. Expected 4, got ${previousState?.stateVersion}.`);
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

    // Validate restored Phase 2D EMA state
    if (!previousState.emaState || typeof previousState.emaState !== 'object') {
        throw new Error(`State Integrity Error: Missing or malformed emaState container.`);
    }

    for (const [periodStr, eState] of Object.entries(previousState.emaState)) {
        const period = Number(periodStr);
        if (!Number.isSafeInteger(period) || period <= 0) {
            throw new Error(`State Integrity Error: Invalid period key '${periodStr}' in emaState.`);
        }
        if (!config.emaPeriods.includes(period)) {
            throw new Error(`State Integrity Error: Unexpected period key '${periodStr}' in emaState not found in configuration.`);
        }
        if (!eState || typeof eState !== 'object') {
            throw new Error(`State Integrity Error: Malformed emaState for period ${period}.`);
        }
        if (!Number.isSafeInteger(eState.count) || eState.count < 0) {
            throw new Error(`State Integrity Error: Corrupted count in emaState for period ${period}.`);
        }
        if (!Number.isFinite(eState.seedMean)) {
            throw new Error(`State Integrity Error: Corrupted seedMean in emaState for period ${period}.`);
        }
        if (typeof eState.isSeeded !== 'boolean') {
            throw new Error(`State Integrity Error: Corrupted isSeeded in emaState for period ${period}.`);
        }
        if (!Array.isArray(eState.history) || eState.history.length > 11) {
            throw new Error(`State Integrity Error: History in emaState must be an array of length <= 11 for period ${period}.`);
        }
        for (let h = 0; h < eState.history.length; h++) {
            if (!Number.isFinite(eState.history[h])) {
                throw new Error(`State Integrity Error: Non-finite value in emaState history for period ${period}.`);
            }
        }
        if (eState.isSeeded) {
            if (eState.count < period || eState.ema === null || !Number.isFinite(eState.ema)) {
                throw new Error(`State Integrity Error: Seeded EMA must have count >= ${period} and finite non-null ema for period ${period}.`);
            }
            if (eState.history.length === 0 || eState.history[eState.history.length - 1] !== eState.ema) {
                throw new Error(`State Integrity Error: EMA history does not match current EMA for period ${period}.`);
            }
        } else {
            if (eState.count >= period) {
                throw new Error(`State Integrity Error: Unseeded state cannot have completed count ${eState.count} >= ${period}.`);
            }
            if (eState.ema !== null) {
                throw new Error(`State Integrity Error: Unseeded EMA must have ema === null for period ${period}.`);
            }
            if (eState.history.length !== 0) {
                throw new Error(`State Integrity Error: Unseeded EMA must have empty history for period ${period}.`);
            }
        }
        if (!Number.isSafeInteger(eState.unbrokenRun) || eState.unbrokenRun < 0 || eState.unbrokenRun > eState.count) {
            throw new Error(`State Integrity Error: Corrupted unbrokenRun (${eState.unbrokenRun} > count ${eState.count}) in emaState for period ${period}.`);
        }
    }

    // Validate restored Phase 2E Momentum state
    if (!previousState.momentumState || typeof previousState.momentumState !== 'object') {
        throw new Error(`State Integrity Error: Missing or malformed momentumState container.`);
    }
    const mState = previousState.momentumState;
    if (!Array.isArray(mState.closeHistory) || mState.closeHistory.length > 21) {
        throw new Error(`State Integrity Error: Malformed closeHistory in momentumState (must be array of length <= 21).`);
    }
    for (let c = 0; c < mState.closeHistory.length; c++) {
        if (!Number.isFinite(mState.closeHistory[c])) {
            throw new Error(`State Integrity Error: Non-finite value in momentumState closeHistory.`);
        }
    }
    if (!Number.isSafeInteger(mState.unbrokenRun) || mState.unbrokenRun < 0) {
        throw new Error(`State Integrity Error: Invalid unbrokenRun in momentumState.`);
    }
    if (mState.closeHistory.length === 0 && mState.unbrokenRun !== 0) {
        throw new Error(`State Integrity Error: Empty closeHistory requires unbrokenRun = 0.`);
    }
    if (mState.closeHistory.length > 0 && mState.unbrokenRun < mState.closeHistory.length) {
        throw new Error(`State Integrity Error: unbrokenRun cannot be smaller than closeHistory length.`);
    }
    if (mState.closeHistory.length < 21 && mState.unbrokenRun !== mState.closeHistory.length) {
        throw new Error(`State Integrity Error: Inconsistent momentumState history and unbrokenRun before capacity.`);
    }

    // Validate restored Phase 2F Volume state
    if (!previousState.volumeState || typeof previousState.volumeState !== 'object') {
        throw new Error(`State Integrity Error: Missing or malformed volumeState container.`);
    }
    const vState = previousState.volumeState;
    if (!Array.isArray(vState.volumeHistory) || vState.volumeHistory.length > 50) {
        throw new Error(`State Integrity Error: Malformed volumeHistory in volumeState (must be array of length <= 50).`);
    }
    for (let v = 0; v < vState.volumeHistory.length; v++) {
        if (!Number.isFinite(vState.volumeHistory[v]) || vState.volumeHistory[v] < 0) {
            throw new Error(`State Integrity Error: Non-finite or negative value in volumeState volumeHistory.`);
        }
    }
    if (!Number.isSafeInteger(vState.unbrokenRun) || vState.unbrokenRun < 0) {
        throw new Error(`State Integrity Error: Invalid unbrokenRun in volumeState.`);
    }
    if (vState.volumeHistory.length === 0 && vState.unbrokenRun !== 0) {
        throw new Error(`State Integrity Error: Empty volumeHistory requires unbrokenRun = 0.`);
    }
    if (vState.volumeHistory.length > 0 && vState.unbrokenRun < vState.volumeHistory.length) {
        throw new Error(`State Integrity Error: unbrokenRun cannot be smaller than volumeHistory length.`);
    }
    if (vState.volumeHistory.length < 50 && vState.unbrokenRun !== vState.volumeHistory.length) {
        throw new Error(`State Integrity Error: Inconsistent volumeState history and unbrokenRun before capacity.`);
    }

    const features: ML1FeatureValues = {};
    const validity: ML1FeatureValidity = {};

    // 2. Data Integrity & Base Metrics
    const isValidOhlcv = isOhlcvValid(candle);
    features['IsValidOHLCV'] = isValidOhlcv ? 1 : 0;
    validity['IsValidOHLCV'] = true;

    // Explicit timestamp validity check (finite, non-negative, and within valid JS Date range)
    const isValidTimestamp = Number.isFinite(candle.time) && 
        candle.time >= 0 && 
        Number.isFinite(new Date(candle.time).getTime());

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

    // Phase 2G: Temporal Features (Calculated causally from UTC timestamp)
    const temporal = calculateTemporalFeatures(candle.time);
    Object.assign(features, temporal.features);
    Object.assign(validity, temporal.validity);

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
        
        if (!isValidTimestamp || Number.isNaN(timeDelta) || !Number.isFinite(timeDelta)) {
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

    features['IsInvalidIndex'] = isInvalidIndex ? 1 : 0;
    validity['IsInvalidIndex'] = true;

    // Phase 2G: Data Quality & Continuity Context
    const hasPrev = previousState.lastTimestamp !== null;
    features['HasPreviousCandle'] = hasPrev ? 1 : 0;
    validity['HasPreviousCandle'] = true;

    const hasExpectedPrev = hasPrev && isValidTimestamp && !hasDataGap && !isUnexpectedInterval && !isDiscontinuity && !isDuplicate && !isOutOfOrder;
    features['HasExpectedPreviousTimestamp'] = hasExpectedPrev ? 1 : 0;
    validity['HasExpectedPreviousTimestamp'] = hasPrev && isValidTimestamp;

    const timeDeltaSec = (hasPrev && isValidTimestamp && !isOutOfOrder && !isDuplicate) ? (candle.time - previousState.lastTimestamp!) / 1000 : 0;
    const isDeltaValid = hasPrev && isValidTimestamp && !isOutOfOrder && !isDuplicate && Number.isFinite(timeDeltaSec) && timeDeltaSec >= 0;
    features['TimeDeltaSeconds'] = isDeltaValid ? timeDeltaSec : 0;
    validity['TimeDeltaSeconds'] = isDeltaValid;

    const isSourceValid = isValidOhlcv && isValidTimestamp && !isDuplicate && !isOutOfOrder && !isInvalidIndex && !isUnexpectedInterval;
    features['IsSourceValid'] = isSourceValid ? 1 : 0;
    validity['IsSourceValid'] = true;

    // 6. State Rejection Gate
    const isRejected = !isValidOhlcv || !isValidTimestamp || isDuplicate || isOutOfOrder || isInvalidIndex || isUnexpectedInterval;

    const nextAtrState: Record<number, ATRPeriodState> = { ...previousState.atrState };
    const nextRollingRangeState: Record<number, RollingRangePeriodState> = { ...previousState.rollingRangeState };
    const nextEmaState: Record<number, EMAPeriodState> = { ...previousState.emaState };
    let nextMomentumState: MomentumState = previousState.momentumState;
    let nextVolumeState: VolumeState = previousState.volumeState;

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

        // -------------------------------------------------------------
        // Phase 2D: Causal EMA Context Engine
        // -------------------------------------------------------------
        const atr14Val = features['ATR_14'];
        const isAtr14Usable = validity['ATR_14'] === true && Number.isFinite(atr14Val) && atr14Val > 0;

        for (const period of config.emaPeriods) {
            const res = updateEMA(
                candle.close,
                period,
                previousState.emaState[period],
                isDiscontinuity,
                hasDataGap
            );

            nextEmaState[period] = res.nextState;

            // Normalized Price-to-EMA Distance: (Close - EMA) / ATR14
            const dist = (res.isValid && isAtr14Usable) ? (candle.close - res.emaValue) / atr14Val : NaN;
            const isDistValid = Number.isFinite(dist);
            features[`EMA_${period}_Distance`] = isDistValid ? dist : 0;
            validity[`EMA_${period}_Distance`] = isDistValid;

            // EMA Slopes (Horizons k=3 and k=10)
            const slope3 = calculateEMASlope(res.nextState.history, 3, atr14Val, res.nextState.unbrokenRun);
            features[`EMA_${period}_Slope_3`] = slope3.isValid ? slope3.slope : 0;
            validity[`EMA_${period}_Slope_3`] = slope3.isValid;

            const slope10 = calculateEMASlope(res.nextState.history, 10, atr14Val, res.nextState.unbrokenRun);
            features[`EMA_${period}_Slope_10`] = slope10.isValid ? slope10.slope : 0;
            validity[`EMA_${period}_Slope_10`] = slope10.isValid;
        }

        // Pairwise EMA Relationships (Sorted adjacent pairs, e.g., 9-20, 20-50, etc.)
        const sortedPeriods = [...config.emaPeriods].sort((a, b) => a - b);
        for (let p = 0; p < sortedPeriods.length - 1; p++) {
            const p1 = sortedPeriods[p];
            const p2 = sortedPeriods[p + 1];

            const ema1 = nextEmaState[p1]?.ema;
            const ema2 = nextEmaState[p2]?.ema;
            const bothValid = nextEmaState[p1]?.isSeeded && nextEmaState[p2]?.isSeeded && Number.isFinite(ema1) && Number.isFinite(ema2);

            // 1. Directional Alignment: +1 if Fast > Slow, -1 if Fast < Slow, 0 if equal
            let alignment = 0;
            if (bothValid) {
                alignment = ema1! > ema2! ? 1 : (ema1! < ema2! ? -1 : 0);
            }
            features[`EMA_${p1}_Above_EMA_${p2}`] = alignment;
            validity[`EMA_${p1}_Above_EMA_${p2}`] = bothValid;

            // 2. Normalized Separation: (EMA_Fast - EMA_Slow) / ATR14
            const sep = (bothValid && isAtr14Usable) ? (ema1! - ema2!) / atr14Val : NaN;
            const isSepValid = Number.isFinite(sep);
            features[`EMA_${p1}_${p2}_Separation`] = isSepValid ? sep : 0;
            validity[`EMA_${p1}_${p2}_Separation`] = isSepValid;

            // 3. Spread Change: Current Separation - Previous Separation
            const prevEma1 = previousState.emaState[p1]?.ema;
            const prevEma2 = previousState.emaState[p2]?.ema;
            const prevAtr14 = previousState.atrState[14]?.atr;
            const prevAtrUsable = previousState.atrState[14]?.isSeeded && Number.isFinite(prevAtr14) && prevAtr14! > 0;
            const prevBothValid = previousState.emaState[p1]?.isSeeded && previousState.emaState[p2]?.isSeeded && Number.isFinite(prevEma1) && Number.isFinite(prevEma2);

            let spreadChange = 0;
            let isSpreadChangeValid = false;

            if (isSepValid && prevBothValid && prevAtrUsable && !hasDataGap && !isDiscontinuity) {
                const prevSep = (prevEma1! - prevEma2!) / prevAtr14!;
                const diff = sep - prevSep;
                if (Number.isFinite(diff)) {
                    spreadChange = diff;
                    isSpreadChangeValid = true;
                }
            }

            features[`EMA_SpreadChange_${p1}_${p2}`] = isSpreadChangeValid ? spreadChange : 0;
            validity[`EMA_SpreadChange_${p1}_${p2}`] = isSpreadChangeValid;
        }

        // -------------------------------------------------------------
        // Phase 2E: Momentum and Directional Efficiency
        // -------------------------------------------------------------
        nextMomentumState = updateMomentumState(candle.close, previousState.momentumState, isDiscontinuity, 20);

        // 1. Normalized Returns: (Close_t - Close_{t-N}) / Close_{t-N}
        const returnPeriods = [1, 3, 5, 10];
        for (const p of returnPeriods) {
            const res = calculateReturn(nextMomentumState.closeHistory, nextMomentumState.unbrokenRun, p);
            features[`Return_${p}`] = res.isValid ? res.returnVal : 0;
            validity[`Return_${p}`] = res.isValid;
        }

        // 2. Accumulated Momentum: Close_t - Close_{t-N}
        for (const p of config.momentumPeriods) {
            const res = calculateMomentum(nextMomentumState.closeHistory, nextMomentumState.unbrokenRun, p);
            features[`Momentum_${p}`] = res.isValid ? res.momentumVal : 0;
            validity[`Momentum_${p}`] = res.isValid;
        }

        // 3. Directional Efficiency, Positive Fraction, and Return Balance
        const efficiencyPeriods = [5, 10, 20];
        for (const p of efficiencyPeriods) {
            const deRes = calculateDirectionalEfficiency(nextMomentumState.closeHistory, nextMomentumState.unbrokenRun, p);
            features[`DirectionalEfficiency_${p}`] = deRes.isValid ? deRes.efficiency : 0;
            validity[`DirectionalEfficiency_${p}`] = deRes.isValid;

            const rcRes = calculateReturnConsistency(nextMomentumState.closeHistory, nextMomentumState.unbrokenRun, p);
            features[`PositiveReturnFraction_${p}`] = rcRes.isFractionValid ? rcRes.positiveFraction : 0;
            validity[`PositiveReturnFraction_${p}`] = rcRes.isFractionValid;

            features[`ReturnBalance_${p}`] = rcRes.isBalanceValid ? rcRes.balance : 0;
            validity[`ReturnBalance_${p}`] = rcRes.isBalanceValid;
        }

        // -------------------------------------------------------------
        // Phase 2F: Volume Features (Strict Historical Baseline)
        // -------------------------------------------------------------
        // A discontinuity starts a new independent volume-history segment.
        // The incoming candle must not use observations from the previous segment.
        const baselineVolState: VolumeState = isDiscontinuity
            ? Object.freeze({
                volumeHistory: Object.freeze([]),
                unbrokenRun: 0
            })
            : previousState.volumeState;

        // 1. Base Volume Transformations (changes evaluated against prior completed bars)
        const baseVol = calculateBaseVolume(candle.volume, baselineVolState.volumeHistory, baselineVolState.unbrokenRun);
        features['Volume'] = candle.volume;
        validity['Volume'] = true;

        features['LogVolume'] = baseVol.logVolume;
        validity['LogVolume'] = true;

        features['VolumeChange_1'] = baseVol.isChange1Valid ? baseVol.volChange1 : 0;
        validity['VolumeChange_1'] = baseVol.isChange1Valid;

        features['VolumeChange_3'] = baseVol.isChange3Valid ? baseVol.volChange3 : 0;
        validity['VolumeChange_3'] = baseVol.isChange3Valid;

        // 2. Relative Volume (strictly against preceding N completed candles, excluding current candle)
        for (const p of config.volumeSmaPeriods) {
            const relVol = calculateRelativeVolume(candle.volume, baselineVolState.volumeHistory, baselineVolState.unbrokenRun, p);
            features[`RelativeVolume_${p}`] = relVol.isValid ? relVol.relativeVolume : 0;
            validity[`RelativeVolume_${p}`] = relVol.isValid;
        }

        // 3. Volume Distribution Context (Z-Score strictly against preceding N completed candles)
        const zScorePeriods = [20, 50];
        for (const p of zScorePeriods) {
            if (config.volumeSmaPeriods.includes(p)) {
                const zRes = calculateVolumeZScore(candle.volume, baselineVolState.volumeHistory, baselineVolState.unbrokenRun, p);
                features[`VolumeZScore_${p}`] = zRes.isValid ? zRes.zScore : 0;
                validity[`VolumeZScore_${p}`] = zRes.isValid;
            }
        }

        // 4. Update volume state immutably for subsequent observations
        nextVolumeState = updateVolumeState(candle.volume, previousState.volumeState, isDiscontinuity, 50);

        // 4. Directional Volume Interaction: CandleDirection * RelativeVolume_20
        // NOTE: Descriptive interaction feature only; not inferred bid/ask delta
        const relVol20Valid = validity['RelativeVolume_20'] === true;
        const dirValid = validity['CandleDirection'] === true;
        const isSignedValid = relVol20Valid && dirValid;
        const signedVol = isSignedValid ? features['CandleDirection'] * features['RelativeVolume_20'] : 0;
        features['SignedVolume_20'] = isSignedValid ? signedVol : 0;
        validity['SignedVolume_20'] = isSignedValid;
    }

    // Dynamic State-Aware Warmup Completion (requires every configured sub-state to be warmed up)
    let isWarmupComplete = false;
    if (!isRejected) {
        const emaReady = config.emaPeriods.every(p => nextEmaState[p]?.isSeeded === true);
        const atrReady = config.atrPeriods.every(p => nextAtrState[p]?.isSeeded === true);
        const rrReady = config.rollingRangePeriods.every(p => nextRollingRangeState[p]?.highs.length >= p);
        const momReady = config.momentumPeriods.every(p => nextMomentumState.unbrokenRun >= p + 1);
        const volReady = config.volumeSmaPeriods.every(p => nextVolumeState.unbrokenRun >= p + 1);
        isWarmupComplete = emaReady && atrReady && rrReady && momReady && volReady;
    }
    features['IsWarmupComplete'] = isWarmupComplete ? 1 : 0;
    validity['IsWarmupComplete'] = !isRejected && isSafeIndex && isValidTimestamp;

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
            rollingRangeState: Object.freeze(nextRollingRangeState),
            emaState: Object.freeze(nextEmaState),
            momentumState: nextMomentumState,
            volumeState: nextVolumeState
        });

    return { observation, nextState };
}

// =========================================================================
// ML-R1 Phase 5D (stateVersion: 5) — Isolated CONFIG_C Engine
// =========================================================================

export function validateML1ConfigV5(config: any): ValidatedML1FeatureConfigV5 {
    const baseValidated = validateML1Config(config);

    const validateExtraPeriods = (arr: any, name: string, minPeriod: number): readonly number[] => {
        if (!Array.isArray(arr)) {
            throw new Error(`Configuration V5 Error: ${name} must be an array.`);
        }
        const seen = new Set<number>();
        for (const p of arr) {
            if (!Number.isSafeInteger(p) || p < minPeriod) {
                throw new Error(`Configuration V5 Error: ${name} periods must be integers >= ${minPeriod}, got ${p}.`);
            }
            if (seen.has(p)) {
                throw new Error(`Configuration V5 Error: ${name} contains duplicate periods.`);
            }
            seen.add(p);
        }
        return Object.freeze([...arr]);
    };

    if (typeof config.enableVAM !== 'boolean') {
        throw new Error('Configuration V5 Error: enableVAM must be a boolean.');
    }

    const validatedCciPeriods = validateExtraPeriods(config.cciPeriods, 'cciPeriods', 2);
    const validatedVcsPeriods = validateExtraPeriods(config.volumeCandleSizePeriods, 'volumeCandleSizePeriods', 2);

    if (validatedVcsPeriods.length > 0 && baseValidated.timeframe !== '1m') {
        throw new Error(
            `Configuration V5 Error: Volume Candle Size is supported on '1m' only, got '${baseValidated.timeframe}'.`
        );
    }

    return Object.freeze({
        symbol: baseValidated.symbol,
        timeframe: baseValidated.timeframe,
        expectedIntervalMs: baseValidated.expectedIntervalMs,
        gapDiscontinuityThresholdMs: baseValidated.gapDiscontinuityThresholdMs,
        emaPeriods: baseValidated.emaPeriods,
        atrPeriods: baseValidated.atrPeriods,
        rollingRangePeriods: baseValidated.rollingRangePeriods,
        momentumPeriods: baseValidated.momentumPeriods,
        volumeSmaPeriods: baseValidated.volumeSmaPeriods,
        cciPeriods: validatedCciPeriods,
        volumeCandleSizePeriods: validatedVcsPeriods,
        enableVAM: config.enableVAM
    }) as ValidatedML1FeatureConfigV5;
}

export function computeML1ConfigV5Fingerprint(config: ValidatedML1FeatureConfigV5): string {
    return JSON.stringify({
        symbol: config.symbol,
        timeframe: config.timeframe,
        expectedIntervalMs: config.expectedIntervalMs,
        gapDiscontinuityThresholdMs: config.gapDiscontinuityThresholdMs,
        emaPeriods: config.emaPeriods,
        atrPeriods: config.atrPeriods,
        rollingRangePeriods: config.rollingRangePeriods,
        momentumPeriods: config.momentumPeriods,
        volumeSmaPeriods: config.volumeSmaPeriods,
        cciPeriods: config.cciPeriods,
        volumeCandleSizePeriods: config.volumeCandleSizePeriods,
        enableVAM: config.enableVAM
    });
}

export function createInitialML1FeatureStateV5(config: ValidatedML1FeatureConfigV5): ML1FeatureStateV5 {
    return Object.freeze({
        stateVersion: 5 as const,
        configFingerprint: computeML1ConfigV5Fingerprint(config),
        baseState: createInitialML1FeatureState(),
        exhaustionState: Object.freeze({}),
        volumeCandleSizeState: Object.freeze({}),
        vamState: config.enableVAM ? createInitialVAMState() : null
    });
}

function validateVAMState(vs: VAMState): void {
    if (!vs || typeof vs !== 'object') {
        throw new Error('State Integrity Error: Missing or malformed vamState.');
    }
    if (!Number.isSafeInteger(vs.unbrokenRun) || vs.unbrokenRun < 0) {
        throw new Error('State Integrity Error: Invalid unbrokenRun in vamState.');
    }
    if (!Array.isArray(vs.hlc3History) || vs.hlc3History.length > 19 ||
        vs.hlc3History.some(v => typeof v !== 'number' || !Number.isFinite(v))) {
        throw new Error('State Integrity Error: Invalid hlc3History in vamState (max length 19).');
    }
    if (vs.unbrokenRun === 0) {
        if (vs.prevHigh !== null || vs.prevLow !== null || vs.prevClose !== null ||
            vs.adaptive !== null || vs.center !== null ||
            vs.hlc3History.length !== 0 || vs.centerHistory.length !== 0 ||
            vs.centerSeedCount !== 0 || vs.dmiCount !== 0 || vs.rsiCount !== 0 ||
            vs.dxHistoryCount !== 0 || vs.trend !== 0 || vs.lastSignalAcceptedIndex !== null) {
            throw new Error('State Integrity Error: Initial vamState with unbrokenRun=0 must be empty.');
        }
    } else {
        if (vs.prevHigh === null || !Number.isFinite(vs.prevHigh) ||
            vs.prevLow === null || !Number.isFinite(vs.prevLow) ||
            vs.prevClose === null || !Number.isFinite(vs.prevClose) ||
            vs.prevHigh < vs.prevLow || vs.prevHigh < vs.prevClose || vs.prevLow > vs.prevClose) {
            throw new Error('State Integrity Error: Corrupted prevHigh/prevLow/prevClose in vamState.');
        }
        if (vs.adaptive === null || !Number.isFinite(vs.adaptive)) {
            throw new Error('State Integrity Error: adaptive must be finite when unbrokenRun > 0.');
        }
        const expectedHlc3Len = Math.min(19, vs.unbrokenRun);
        if (vs.hlc3History.length !== expectedHlc3Len) {
            throw new Error(`State Integrity Error: hlc3History length mismatch (${vs.hlc3History.length} !== ${expectedHlc3Len}).`);
        }
    }

    if (!Number.isSafeInteger(vs.centerSeedCount) || vs.centerSeedCount < 0 || vs.centerSeedCount > 5 ||
        !Number.isFinite(vs.centerSeedMean)) {
        throw new Error('State Integrity Error: Invalid center seed state in vamState.');
    }
    if (vs.centerSeedCount < 5) {
        if (vs.center !== null || vs.centerHistory.length !== 0) {
            throw new Error('State Integrity Error: Unseeded VAM center must have center=null and empty centerHistory.');
        }
    } else {
        if (vs.center === null || !Number.isFinite(vs.center)) {
            throw new Error('State Integrity Error: Seeded VAM center must be finite.');
        }
    }
    if (!Array.isArray(vs.centerHistory) || vs.centerHistory.length > 4 ||
        vs.centerHistory.some(v => typeof v !== 'number' || !Number.isFinite(v))) {
        throw new Error('State Integrity Error: Invalid centerHistory in vamState (max length 4).');
    }

    // Validate nested ATR state
    const atr = vs.atrState;
    if (!atr || typeof atr !== 'object' || !Number.isSafeInteger(atr.count) || atr.count < 0 ||
        !Number.isFinite(atr.seedMean) || atr.seedMean < 0 || typeof atr.isSeeded !== 'boolean' ||
        (atr.isSeeded
            ? (atr.count < 14 || atr.atr === null || !Number.isFinite(atr.atr) || atr.atr < 0)
            : (atr.count >= 14 || atr.atr !== null))) {
        throw new Error('State Integrity Error: Corrupted atrState inside vamState.');
    }

    // Validate DMI / ADX accumulators
    if (!Number.isSafeInteger(vs.dmiCount) || vs.dmiCount < 0 ||
        !Number.isFinite(vs.trSeedMean) || vs.trSeedMean < 0 ||
        !Number.isFinite(vs.plusDmSeedMean) || vs.plusDmSeedMean < 0 ||
        !Number.isFinite(vs.minusDmSeedMean) || vs.minusDmSeedMean < 0) {
        throw new Error('State Integrity Error: Corrupted DMI seed accumulators in vamState.');
    }
    const rmas = [vs.trRma, vs.plusDmRma, vs.minusDmRma];
    if (vs.dmiCount < 14) {
        if (rmas.some(r => r !== null)) {
            throw new Error('State Integrity Error: Unseeded DMI RMAs must be null.');
        }
    } else if (rmas.some(r => r === null || !Number.isFinite(r) || r < 0)) {
        throw new Error('State Integrity Error: Seeded DMI RMAs must be finite >= 0.');
    }
    if (!Number.isSafeInteger(vs.dxHistoryCount) || vs.dxHistoryCount < 0 ||
        !Number.isFinite(vs.dxSeedMean) || vs.dxSeedMean < 0) {
        throw new Error('State Integrity Error: Corrupted ADX accumulators in vamState.');
    }
    if (vs.dxHistoryCount < 14) {
        if (vs.adx !== null) throw new Error('State Integrity Error: Unseeded ADX must be null.');
    } else if (vs.adx === null || !Number.isFinite(vs.adx) || vs.adx < 0) {
        throw new Error('State Integrity Error: Seeded ADX must be finite >= 0.');
    }

    // Validate RSI accumulators
    if (!Number.isSafeInteger(vs.rsiCount) || vs.rsiCount < 0 ||
        !Number.isFinite(vs.avgGainSeedMean) || vs.avgGainSeedMean < 0 ||
        !Number.isFinite(vs.avgLossSeedMean) || vs.avgLossSeedMean < 0) {
        throw new Error('State Integrity Error: Corrupted RSI seed accumulators in vamState.');
    }
    if (vs.rsiCount < 14) {
        if (vs.avgGain !== null || vs.avgLoss !== null) {
            throw new Error('State Integrity Error: Unseeded RSI averages must be null.');
        }
    } else if (vs.avgGain === null || vs.avgLoss === null ||
        !Number.isFinite(vs.avgGain) || vs.avgGain < 0 ||
        !Number.isFinite(vs.avgLoss) || vs.avgLoss < 0) {
        throw new Error('State Integrity Error: Seeded RSI averages must be finite >= 0.');
    }

    // Validate trend, streaks & cooldown index
    if ((vs.trend !== -1 && vs.trend !== 0 && vs.trend !== 1) ||
        !Number.isSafeInteger(vs.buyStreak) || vs.buyStreak < 0 ||
        !Number.isSafeInteger(vs.sellStreak) || vs.sellStreak < 0) {
        throw new Error('State Integrity Error: Corrupted trend or streaks in vamState.');
    }
    if (vs.lastSignalAcceptedIndex !== null &&
        (!Number.isSafeInteger(vs.lastSignalAcceptedIndex) ||
            vs.lastSignalAcceptedIndex < 0 ||
            vs.lastSignalAcceptedIndex >= vs.unbrokenRun)) {
        throw new Error('State Integrity Error: Corrupted lastSignalAcceptedIndex in vamState.');
    }
}

function validateRestoredV5State(
    previousState: ML1FeatureStateV5,
    config: ValidatedML1FeatureConfigV5
): void {
    if (!previousState || previousState.stateVersion !== 5) {
        throw new Error(`State Integrity Error: Incompatible V5 state version. Expected 5, got ${(previousState as any)?.stateVersion}.`);
    }
    const expectedFingerprint = computeML1ConfigV5Fingerprint(config);
    if (previousState.configFingerprint !== expectedFingerprint) {
        throw new Error('State Integrity Error: V5 state configFingerprint does not match provided configuration.');
    }
    if (!previousState.baseState || typeof previousState.baseState !== 'object' ||
        previousState.baseState.stateVersion !== 4) {
        throw new Error('State Integrity Error: Embedded V4 baseState is missing or has invalid stateVersion.');
    }
    if (!previousState.exhaustionState || typeof previousState.exhaustionState !== 'object') {
        throw new Error('State Integrity Error: Missing or malformed exhaustionState container.');
    }
    for (const [periodStr, eState] of Object.entries(previousState.exhaustionState)) {
        const period = Number(periodStr);
        if (!Number.isSafeInteger(period) || !config.cciPeriods.includes(period)) {
            throw new Error(`State Integrity Error: Unexpected cciPeriod key '${periodStr}' in exhaustionState.`);
        }
        if (!eState || !Array.isArray(eState.tpHistory) || eState.tpHistory.length > period ||
            !Number.isSafeInteger(eState.unbrokenRun) || eState.unbrokenRun < eState.tpHistory.length ||
            (eState.tpHistory.length < period && eState.unbrokenRun !== eState.tpHistory.length)) {
            throw new Error(`State Integrity Error: Corrupted exhaustionState for period ${period}.`);
        }
        if (eState.tpHistory.some(v => typeof v !== 'number' || !Number.isFinite(v))) {
            throw new Error(`State Integrity Error: Non-finite tpHistory value for period ${period}.`);
        }
    }

    if (!previousState.volumeCandleSizeState || typeof previousState.volumeCandleSizeState !== 'object') {
        throw new Error('State Integrity Error: Missing or malformed volumeCandleSizeState container.');
    }
    for (const [periodStr, vcsState] of Object.entries(previousState.volumeCandleSizeState)) {
        const period = Number(periodStr);
        if (!Number.isSafeInteger(period) || !config.volumeCandleSizePeriods.includes(period)) {
            throw new Error(`State Integrity Error: Unexpected volumeCandleSizePeriod key '${periodStr}'.`);
        }
        if (!vcsState || !Array.isArray(vcsState.jamHistory) || vcsState.jamHistory.length > period ||
            !Number.isSafeInteger(vcsState.unbrokenRun) || vcsState.unbrokenRun < vcsState.jamHistory.length ||
            (vcsState.jamHistory.length < period && vcsState.unbrokenRun !== vcsState.jamHistory.length)) {
            throw new Error(`State Integrity Error: Corrupted volumeCandleSizeState for period ${period}.`);
        }
        if (vcsState.jamHistory.some(v => typeof v !== 'number' || !Number.isFinite(v) || v < 0)) {
            throw new Error(`State Integrity Error: Invalid jamHistory value for period ${period}.`);
        }
    }

    if (config.enableVAM) {
        if (!previousState.vamState) {
            throw new Error('State Integrity Error: vamState must be present when enableVAM is true.');
        }
        validateVAMState(previousState.vamState);
    } else if (previousState.vamState !== null) {
        throw new Error('State Integrity Error: vamState must be null when enableVAM is false.');
    }
}

export function stepML1FeaturesV5(
    candle: ML1Candle,
    barIndex: number,
    previousState: ML1FeatureStateV5,
    config: ValidatedML1FeatureConfigV5
): {
    observation: ML1Observation;
    nextState: ML1FeatureStateV5;
} {
    validateRestoredV5State(previousState, config);

    // Delegate frozen v4 computation using branded base config view
    const baseResult = stepML1Features(
        candle,
        barIndex,
        previousState.baseState,
        config as unknown as ValidatedML1FeatureConfig
    );

    const isRejected = baseResult.nextState === previousState.baseState;
    const isDiscontinuity = baseResult.observation.features['IsDiscontinuity'] === 1;

    const features: ML1FeatureValues = { ...baseResult.observation.features };
    const validity: ML1FeatureValidity = { ...baseResult.observation.validity };

    if (isRejected) {
        // Populate schema keys cleanly with invalid fallback 0 without mutating state
        for (const p of config.cciPeriods) {
            features[`Exhaustion_${p}`] = 0;
            validity[`Exhaustion_${p}`] = false;
        }
        for (const p of config.volumeCandleSizePeriods) {
            features[`VolumeCandleSize_Ratio_${p}`] = 0;
            validity[`VolumeCandleSize_Ratio_${p}`] = false;
            features[`VolumeCandleSize_ZScore_${p}`] = 0;
            validity[`VolumeCandleSize_ZScore_${p}`] = false;
            features[`VolumeCandleSize_Regime_${p}`] = 0;
            validity[`VolumeCandleSize_Regime_${p}`] = false;
        }
        if (config.enableVAM) {
            const vamKeys = [
                'VAM_Center_Dist_ATR', 'VAM_Slope_3_ATR', 'VAM_Efficiency',
                'VAM_ADX_14', 'VAM_DI_Spread_14', 'VAM_RSI_14',
                'VAM_Trend', 'VAM_BuyStreak', 'VAM_SellStreak', 'VAM_Signal'
            ];
            for (const k of vamKeys) {
                features[k] = 0;
                validity[k] = false;
            }
        }
        return {
            observation: { ...baseResult.observation, features, validity },
            nextState: previousState
        };
    }

    const nextExhaustionState: Record<number, ExhaustionPeriodState> = { ...previousState.exhaustionState };
    for (const period of config.cciPeriods) {
        const res = updateExhaustionCCI(
            candle.high,
            candle.low,
            candle.close,
            period,
            previousState.exhaustionState[period],
            isDiscontinuity
        );
        nextExhaustionState[period] = res.nextState;
        features[`Exhaustion_${period}`] = res.isValid ? res.cciValue : 0;
        validity[`Exhaustion_${period}`] = res.isValid;
    }

    const nextVolumeCandleSizeState: Record<number, VolumeCandleSizeState> = { ...previousState.volumeCandleSizeState };
    for (const period of config.volumeCandleSizePeriods) {
        const res = updateVolumeCandleSize(
            candle.high,
            candle.low,
            candle.volume,
            period,
            previousState.volumeCandleSizeState[period],
            isDiscontinuity
        );
        nextVolumeCandleSizeState[period] = res.nextState;
        features[`VolumeCandleSize_Ratio_${period}`] = res.isRatioValid ? res.ratio : 0;
        validity[`VolumeCandleSize_Ratio_${period}`] = res.isRatioValid;
        features[`VolumeCandleSize_ZScore_${period}`] = res.isZScoreValid ? res.zScore : 0;
        validity[`VolumeCandleSize_ZScore_${period}`] = res.isZScoreValid;
        features[`VolumeCandleSize_Regime_${period}`] = res.isRegimeValid ? res.regime : 0;
        validity[`VolumeCandleSize_Regime_${period}`] = res.isRegimeValid;
    }

    let nextVamState: VAMState | null = previousState.vamState;
    if (config.enableVAM) {
        const vamRes = stepVolatilityAdjustedMean(
            candle.high,
            candle.low,
            candle.close,
            previousState.vamState ?? undefined,
            isDiscontinuity
        );
        nextVamState = vamRes.nextState;
        features['VAM_Center_Dist_ATR'] = vamRes.isCenterDistValid ? vamRes.centerDistAtr : 0;
        validity['VAM_Center_Dist_ATR'] = vamRes.isCenterDistValid;
        features['VAM_Slope_3_ATR'] = vamRes.isSlopeValid ? vamRes.slope3Atr : 0;
        validity['VAM_Slope_3_ATR'] = vamRes.isSlopeValid;
        features['VAM_Efficiency'] = vamRes.isEfficiencyValid ? vamRes.efficiency : 0;
        validity['VAM_Efficiency'] = vamRes.isEfficiencyValid;
        features['VAM_ADX_14'] = vamRes.isAdxValid ? vamRes.adx14 : 0;
        validity['VAM_ADX_14'] = vamRes.isAdxValid;
        features['VAM_DI_Spread_14'] = vamRes.isDiSpreadValid ? vamRes.diSpread14 : 0;
        validity['VAM_DI_Spread_14'] = vamRes.isDiSpreadValid;
        features['VAM_RSI_14'] = vamRes.isRsiValid ? vamRes.rsi14 : 0;
        validity['VAM_RSI_14'] = vamRes.isRsiValid;
        features['VAM_Trend'] = vamRes.isTrendValid ? vamRes.trend : 0;
        validity['VAM_Trend'] = vamRes.isTrendValid;
        features['VAM_BuyStreak'] = vamRes.buyStreak;
        validity['VAM_BuyStreak'] = true;
        features['VAM_SellStreak'] = vamRes.sellStreak;
        validity['VAM_SellStreak'] = true;
        features['VAM_Signal'] = vamRes.signal;
        validity['VAM_Signal'] = vamRes.isAdxValid && vamRes.isRsiValid && vamRes.isSlopeValid;
    }

    const nextState: ML1FeatureStateV5 = Object.freeze({
        stateVersion: 5 as const,
        configFingerprint: previousState.configFingerprint,
        baseState: baseResult.nextState,
        exhaustionState: Object.freeze(nextExhaustionState),
        volumeCandleSizeState: Object.freeze(nextVolumeCandleSizeState),
        vamState: nextVamState
    });

    return {
        observation: { ...baseResult.observation, features, validity },
        nextState
    };
}

