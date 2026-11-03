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
        invalidOhlcvCount: 0
    });
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
    ];

    for (const key of requiredKeys) {
        if (typeof f[key] !== 'number') {
            throw new Error(`DataQuality Extraction Error: Required telemetry field '${key}' is missing or undefined.`);
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
 * Decouples source-quality classification from the final dataset acceptance decision,
 * strictly enforcing the provided IntegrityPolicy.
 */
export function evaluateAcceptance(
    dataQuality: DataQualityStatus,
    isValidOhlcv: boolean,
    policy: IntegrityPolicy
): boolean {
    if (policy.rejectInvalidSource && !isValidOhlcv) return false;
    if (policy.rejectDuplicateTimestamp && dataQuality.isDuplicate) return false;
    if (policy.rejectOutOfOrder && dataQuality.isOutOfOrder) return false;

    if (!dataQuality.isSourceValid) return false;

    return true;
}

/**
 * Immutably accumulates dataset tracking statistics for the final manifest.
 * Enforces the core invariant: sourceRowCount = accepted + rejected.
 */
export function updateBackboneStats(
    prevStats: BackboneStats,
    dataQuality: DataQualityStatus,
    isValidOhlcv: boolean,
    isAccepted: boolean,
    timeDeltaSeconds: number,
    expectedIntervalSeconds: number
): BackboneStats {
    let missingCount = prevStats.missingIntervalCount;
    let unexpectedCount = prevStats.unexpectedIntervalCount;

    if (timeDeltaSeconds > 0 && !dataQuality.isDuplicate && !dataQuality.isOutOfOrder) {
        if (timeDeltaSeconds > expectedIntervalSeconds) {
            const remainder = timeDeltaSeconds % expectedIntervalSeconds;
            if (remainder === 0) {
                missingCount += Math.floor(timeDeltaSeconds / expectedIntervalSeconds) - 1;
            } else {
                unexpectedCount += 1;
            }
        } else if (timeDeltaSeconds < expectedIntervalSeconds) {
            unexpectedCount += 1;
        }
    } else if (timeDeltaSeconds < 0 && !dataQuality.isOutOfOrder) {
        unexpectedCount += 1;
    }

    return Object.freeze({
        sourceRowCount: prevStats.sourceRowCount + 1,
        acceptedObservationCount: prevStats.acceptedObservationCount + (isAccepted ? 1 : 0),
        rejectedObservationCount: prevStats.rejectedObservationCount + (isAccepted ? 0 : 1),
        missingIntervalCount: missingCount,
        unexpectedIntervalCount: unexpectedCount,
        duplicateTimestampCount: prevStats.duplicateTimestampCount + (dataQuality.isDuplicate ? 1 : 0),
        outOfOrderCount: prevStats.outOfOrderCount + (dataQuality.isOutOfOrder ? 1 : 0),
        invalidOhlcvCount: prevStats.invalidOhlcvCount + (!isValidOhlcv ? 1 : 0)
    });
}
