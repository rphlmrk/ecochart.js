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

/**
 * 🔒 IDENTITY CONTRACT
 * Generates a deterministic, stable identifier for the observation row.
 * Does not rely on unstable array indices.
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
    if (!Number.isFinite(sourceTimestamp) || sourceTimestamp < 0) {
        throw new Error('Invalid sourceTimestamp: Must be a non-negative finite number.');
    }
    if (!Number.isFinite(sourceIntervalMs) || sourceIntervalMs <= 0) {
        throw new Error('Invalid sourceIntervalMs: Must be a positive finite number.');
    }
    const result = sourceTimestamp + sourceIntervalMs;
    if (!Number.isSafeInteger(result)) {
        throw new Error('Calculated observation timestamp exceeds safe integer range.');
    }
    return result;
}

/**
 * Maps the native ML1FeatureEngine telemetry directly into the strict Dataset schema.
 * Prevents missing/undefined telemetry from silently resolving to 'false' (healthy).
 */
export function extractDataQuality(obs: ML1Observation): DataQualityStatus {
    const f = obs.features;
    const requiredKeys = [
        'IsSourceValid', 'HasDataGap', 'IsDiscontinuity',
        'IsDuplicateTimestamp', 'IsOutOfOrder', 'IsUnexpectedInterval'
    ] as const;

    for (const key of requiredKeys) {
        const val = f[key];
        if (typeof val !== 'number' || !Number.isFinite(val) || (val !== 0 && val !== 1)) {
            throw new Error(`DataQuality Extraction Error: Required telemetry field '${key}' must be strictly 0 or 1, got ${val}.`);
        }
    }

    return Object.freeze({
        isSourceValid: f['IsSourceValid'] === 1,
        hasDataGap: f['HasDataGap'] === 1,
        isDiscontinuity: f['IsDiscontinuity'] === 1,
        isDuplicate: f['IsDuplicateTimestamp'] === 1,
        isOutOfOrder: f['IsOutOfOrder'] === 1,
        isUnexpectedInterval: f['IsUnexpectedInterval'] === 1
    });
}

/**
 * Evaluates observation acceptance strictly against the configured policy.
 */
export function evaluateAcceptance(
    dataQuality: DataQualityStatus,
    policy: IntegrityPolicy,
    isValidOhlcv = true
): SourceAcceptanceResult {
    const reasons: string[] = [];

    if (policy.rejectInvalidSource && (!dataQuality.isSourceValid || !isValidOhlcv)) {
        reasons.push('INVALID_SOURCE');
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
 * Audits minimum uptime requirement across a completed dataset manifest.
 */
export function evaluateDatasetUptime(
    stats: BackboneStats,
    policy: IntegrityPolicy
): { isUptimeValid: boolean; actualUptimeFraction: number } {
    const minRequired = policy.requireMinimumUptimeFraction;
    if (minRequired === undefined || minRequired <= 0) {
        return { isUptimeValid: true, actualUptimeFraction: 1.0 };
    }
    const totalExpectedObservations = stats.acceptedObservationCount + stats.missingIntervalCount;
    if (totalExpectedObservations === 0) {
        return { isUptimeValid: false, actualUptimeFraction: 0 };
    }
    const actualUptimeFraction = stats.acceptedObservationCount / totalExpectedObservations;
    return {
        isUptimeValid: actualUptimeFraction >= minRequired,
        actualUptimeFraction
    };
}

/**
 * Immutably updates backbone statistics and independently audits source chronology.
 */
export function updateBackboneStats(
    prevStats: BackboneStats,
    sourceTimestamp: number,
    acceptance: SourceAcceptanceResult,
    expectedIntervalMs: number,
    isValidOhlcv = true
): BackboneStats {
    if (!Number.isSafeInteger(sourceTimestamp) || sourceTimestamp < 0) {
        throw new Error(`Invalid sourceTimestamp: Expected non-negative safe integer, got ${sourceTimestamp}`);
    }
    if (!Number.isSafeInteger(expectedIntervalMs) || expectedIntervalMs <= 0) {
        throw new Error(`Invalid expectedIntervalMs: Expected positive safe integer, got ${expectedIntervalMs}`);
    }

    const dq = acceptance.dataQuality;
    let missingCount = prevStats.missingIntervalCount;
    let unexpectedCount = prevStats.unexpectedIntervalCount;
    let isInternalDup = false;
    let isInternalOutOfOrder = false;

    if (prevStats.lastSourceTimestamp !== null) {
        const deltaMs = sourceTimestamp - prevStats.lastSourceTimestamp;

        if (deltaMs === 0) {
            isInternalDup = true;
        } else if (deltaMs < 0) {
            isInternalOutOfOrder = true;
        } else if (deltaMs > expectedIntervalMs) {
            const remainder = deltaMs % expectedIntervalMs;
            if (remainder === 0) {
                missingCount += (deltaMs / expectedIntervalMs) - 1;
            } else {
                unexpectedCount += 1;
            }
        } else if (deltaMs < expectedIntervalMs) {
            unexpectedCount += 1;
        }
    }

    if (
        dq.isUnexpectedInterval &&
        !isInternalOutOfOrder &&
        !isInternalDup &&
        prevStats.lastSourceTimestamp !== null &&
        sourceTimestamp - prevStats.lastSourceTimestamp === expectedIntervalMs
    ) {
        unexpectedCount += 1;
    }

    const nextWatermark = prevStats.lastSourceTimestamp === null || sourceTimestamp > prevStats.lastSourceTimestamp
        ? sourceTimestamp
        : prevStats.lastSourceTimestamp;
    const hasDuplicate = dq.isDuplicate || isInternalDup;
    const hasOutOfOrder = dq.isOutOfOrder || isInternalOutOfOrder;
    const isInvalidOhlcv = !isValidOhlcv ||
        (!dq.isSourceValid && !hasDuplicate && !hasOutOfOrder && !dq.isUnexpectedInterval);

    return Object.freeze({
        sourceRowCount: prevStats.sourceRowCount + 1,
        acceptedObservationCount: prevStats.acceptedObservationCount + (acceptance.isAccepted ? 1 : 0),
        rejectedObservationCount: prevStats.rejectedObservationCount + (acceptance.isAccepted ? 0 : 1),
        missingIntervalCount: missingCount,
        unexpectedIntervalCount: unexpectedCount,
        duplicateTimestampCount: prevStats.duplicateTimestampCount + (hasDuplicate ? 1 : 0),
        outOfOrderCount: prevStats.outOfOrderCount + (hasOutOfOrder ? 1 : 0),
        invalidOhlcvCount: prevStats.invalidOhlcvCount + (isInvalidOhlcv ? 1 : 0),
        lastSourceTimestamp: nextWatermark
    });
}
