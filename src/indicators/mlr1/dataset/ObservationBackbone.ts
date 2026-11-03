import type { ML1Observation } from '../ML1FeatureTypes';
import type { DataQualityStatus } from './DatasetTypes';
import type { IntegrityPolicy } from './DatasetConfig';

export interface BackboneStats {
    readonly sourceRowCount: number;
    readonly acceptedObservationCount: number;
    readonly rejectedObservationCount: number;
    readonly missingIntervalCount: number;
    readonly unexpectedIntervalCount: number;
    readonly duplicateTimestampCount: number;
    readonly outOfOrderCount: number;
    readonly invalidOhlcvCount: number;
    readonly lastSourceTimestamp: number | null;
}

export function createInitialBackboneStats(): BackboneStats {
    return Object.freeze({
        sourceRowCount: 0,
        acceptedObservationCount: 0,
        rejectedObservationCount: 0,
        missingIntervalCount: 0,
        unexpectedIntervalCount: 0,
        duplicateTimestampCount: 0,
        outOfOrderCount: 0,
        invalidOhlcvCount: 0,
        lastSourceTimestamp: null
    });
}

export interface SourceAcceptanceResult {
    readonly isAccepted: boolean;
    readonly rejectionReasons: readonly string[];
    readonly dataQuality: DataQualityStatus;
}

export interface ProcessSourceResult {
    readonly nextStats: BackboneStats;
    readonly acceptance: SourceAcceptanceResult;
    readonly observationTimestamp: number;
}

export interface DatasetUptimeEvaluation {
    readonly isUptimeValid: boolean;
    readonly sourceAvailabilityFraction: number;
    readonly usableObservationFraction: number;
    readonly totalExpectedObservations: number;
}

/**
 * 🔒 IDENTITY CONTRACT
 * Generates a deterministic, stable identifier for the observation row.
 */
export function generateObservationId(
    symbol: string,
    timeframe: string,
    sourceTimestamp: number,
    datasetVersion: number
): string {
    return `OBS_${symbol}_${timeframe}_V${datasetVersion}_${sourceTimestamp}`;
}

/**
 * 🔒 TIMESTAMP CONTRACT
 * Calculates the exact exclusive close boundary when the observation becomes available.
 */
export function calculateObservationTimestamp(
    sourceTimestamp: number,
    sourceIntervalMs: number
): number {
    if (!Number.isSafeInteger(sourceTimestamp) || sourceTimestamp < 0) {
        throw new Error('Invalid sourceTimestamp: Must be a non-negative safe integer.');
    }
    if (!Number.isSafeInteger(sourceIntervalMs) || sourceIntervalMs <= 0) {
        throw new Error('Invalid sourceIntervalMs: Must be a positive safe integer.');
    }
    const result = sourceTimestamp + sourceIntervalMs;
    if (!Number.isSafeInteger(result)) {
        throw new Error('Calculated observation timestamp exceeds safe integer range.');
    }
    return result;
}

/**
 * Maps the native ML1FeatureEngine telemetry into the dataset schema.
 */
export function extractDataQuality(obs: ML1Observation): DataQualityStatus {
    const features = obs.features;
    const requiredKeys = [
        'IsSourceValid',
        'HasDataGap',
        'IsDiscontinuity',
        'IsDuplicateTimestamp',
        'IsOutOfOrder',
        'IsUnexpectedInterval'
    ] as const;

    for (const key of requiredKeys) {
        const value = features[key];
        if (typeof value !== 'number' || !Number.isFinite(value) || (value !== 0 && value !== 1)) {
            throw new Error(`DataQuality Extraction Error: Telemetry field '${key}' must be strictly 0 or 1, got ${value}.`);
        }
    }

    return Object.freeze({
        isSourceValid: features['IsSourceValid'] === 1,
        hasDataGap: features['HasDataGap'] === 1,
        isDiscontinuity: features['IsDiscontinuity'] === 1,
        isDuplicate: features['IsDuplicateTimestamp'] === 1,
        isOutOfOrder: features['IsOutOfOrder'] === 1,
        isUnexpectedInterval: features['IsUnexpectedInterval'] === 1
    });
}

/**
 * Evaluates acceptance against the configured integrity policy.
 */
export function evaluateAcceptance(
    dataQuality: DataQualityStatus,
    policy: IntegrityPolicy,
    isValidOhlcv = true
): SourceAcceptanceResult {
    const reasons: string[] = [];

    if (policy.rejectInvalidSource && !dataQuality.isSourceValid) {
        reasons.push('INVALID_SOURCE');
    }
    if (policy.rejectInvalidSource && !isValidOhlcv) {
        reasons.push('INVALID_OHLCV');
    }
    if (policy.rejectDuplicateTimestamp && dataQuality.isDuplicate) {
        reasons.push('DUPLICATE_TIMESTAMP');
    }
    if (policy.rejectOutOfOrder && dataQuality.isOutOfOrder) {
        reasons.push('OUT_OF_ORDER');
    }

    return Object.freeze({
        isAccepted: reasons.length === 0,
        rejectionReasons: Object.freeze(reasons),
        dataQuality
    });
}

/**
 * Audits minimum uptime using source availability and accepted observations.
 */
export function evaluateDatasetUptime(
    stats: BackboneStats,
    policy: IntegrityPolicy
): DatasetUptimeEvaluation {
    const minRequired = policy.requireMinimumUptimeFraction;
    if (minRequired !== undefined && (!Number.isFinite(minRequired) || minRequired < 0 || minRequired > 1)) {
        throw new Error(
            `IntegrityPolicy Error: requireMinimumUptimeFraction must be a finite number between 0 and 1, got ${minRequired}.`
        );
    }

    const totalExpectedObservations = stats.sourceRowCount + stats.missingIntervalCount;
    if (totalExpectedObservations === 0) {
        return Object.freeze({
            isUptimeValid: false,
            sourceAvailabilityFraction: 0,
            usableObservationFraction: 0,
            totalExpectedObservations: 0
        });
    }

    const sourceAvailabilityFraction = stats.sourceRowCount / totalExpectedObservations;
    const usableObservationFraction = stats.acceptedObservationCount / totalExpectedObservations;

    return Object.freeze({
        isUptimeValid: minRequired === undefined || usableObservationFraction >= minRequired,
        sourceAvailabilityFraction,
        usableObservationFraction,
        totalExpectedObservations
    });
}

/**
 * Processes one source candle in arrival order, applying internal chronology
 * checks and the configured policy before updating immutable statistics.
 */
export function processSourceObservation(
    prevStats: BackboneStats,
    sourceTimestamp: number,
    dataQuality: DataQualityStatus,
    isValidOhlcv: boolean,
    policy: IntegrityPolicy,
    expectedIntervalMs: number
): ProcessSourceResult {
    if (!Number.isSafeInteger(sourceTimestamp) || sourceTimestamp < 0) {
        throw new Error(`Invalid sourceTimestamp: Expected non-negative safe integer, got ${sourceTimestamp}`);
    }
    if (!Number.isSafeInteger(expectedIntervalMs) || expectedIntervalMs <= 0) {
        throw new Error(`Invalid expectedIntervalMs: Expected positive safe integer, got ${expectedIntervalMs}`);
    }

    let internalDuplicate = false;
    let internalOutOfOrder = false;
    let internalUnexpectedInterval = false;
    let missingIntervalAddition = 0;

    if (prevStats.lastSourceTimestamp !== null) {
        const deltaMs = sourceTimestamp - prevStats.lastSourceTimestamp;
        if (deltaMs === 0) {
            internalDuplicate = true;
        } else if (deltaMs < 0) {
            internalOutOfOrder = true;
        } else if (deltaMs < expectedIntervalMs) {
            internalUnexpectedInterval = true;
        } else if (deltaMs > expectedIntervalMs) {
            const remainder = deltaMs % expectedIntervalMs;
            if (remainder === 0) {
                missingIntervalAddition = deltaMs / expectedIntervalMs - 1;
            } else {
                internalUnexpectedInterval = true;
            }
        }
    }

    const combinedQuality: DataQualityStatus = Object.freeze({
        ...dataQuality,
        isDuplicate: dataQuality.isDuplicate || internalDuplicate,
        isOutOfOrder: dataQuality.isOutOfOrder || internalOutOfOrder,
        isUnexpectedInterval: dataQuality.isUnexpectedInterval || internalUnexpectedInterval
    });
    const acceptance = evaluateAcceptance(combinedQuality, policy, isValidOhlcv);
    const nextWatermark = prevStats.lastSourceTimestamp === null || sourceTimestamp > prevStats.lastSourceTimestamp
        ? sourceTimestamp
        : prevStats.lastSourceTimestamp;

    const nextStats: BackboneStats = Object.freeze({
        sourceRowCount: prevStats.sourceRowCount + 1,
        acceptedObservationCount: prevStats.acceptedObservationCount + (acceptance.isAccepted ? 1 : 0),
        rejectedObservationCount: prevStats.rejectedObservationCount + (acceptance.isAccepted ? 0 : 1),
        missingIntervalCount: prevStats.missingIntervalCount + missingIntervalAddition,
        unexpectedIntervalCount: prevStats.unexpectedIntervalCount + (combinedQuality.isUnexpectedInterval ? 1 : 0),
        duplicateTimestampCount: prevStats.duplicateTimestampCount + (combinedQuality.isDuplicate ? 1 : 0),
        outOfOrderCount: prevStats.outOfOrderCount + (combinedQuality.isOutOfOrder ? 1 : 0),
        invalidOhlcvCount: prevStats.invalidOhlcvCount + (isValidOhlcv ? 0 : 1),
        lastSourceTimestamp: nextWatermark
    });

    return Object.freeze({
        nextStats,
        acceptance,
        observationTimestamp: calculateObservationTimestamp(sourceTimestamp, expectedIntervalMs)
    });
}

/**
 * Alias for callers that prefer the stats-oriented function name.
 */
export function updateBackboneStats(
    prevStats: BackboneStats,
    sourceTimestamp: number,
    dataQuality: DataQualityStatus,
    isValidOhlcv: boolean,
    policy: IntegrityPolicy,
    expectedIntervalMs: number
): ProcessSourceResult {
    return processSourceObservation(
        prevStats,
        sourceTimestamp,
        dataQuality,
        isValidOhlcv,
        policy,
        expectedIntervalMs
    );
}
