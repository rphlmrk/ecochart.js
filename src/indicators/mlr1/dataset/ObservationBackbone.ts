import type { ML1Candle, ML1Observation } from '../ML1FeatureTypes';
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
    readonly invalidSourceCount: number;
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
        invalidSourceCount: 0,
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

export interface SourceBackboneInputItem {
    readonly candle: ML1Candle;
    readonly observation: ML1Observation;
    readonly isValidOhlcv: boolean;
}

export interface SourceBackboneAcceptedRow {
    readonly observationId: string;
    readonly sourceTimestamp: number;
    readonly observationTimestamp: number;
    readonly candle: ML1Candle;
    readonly dataQuality: DataQualityStatus;
}

export interface SourceBackboneRejectedRow {
    readonly sourceTimestamp: number;
    readonly candle: ML1Candle;
    readonly reasons: readonly string[];
}

export interface SourceBackboneBuildResult {
    readonly acceptedRows: readonly SourceBackboneAcceptedRow[];
    readonly rejectedRows: readonly SourceBackboneRejectedRow[];
    readonly stats: BackboneStats;
    readonly uptime: DatasetUptimeEvaluation;
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
 * Rejects non-binary values and missing telemetry fields.
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

function validatePolicy(policy: IntegrityPolicy): void {
    if (!policy || typeof policy !== 'object') {
        throw new Error('Runtime Contract Error: policy must be a valid object.');
    }
    if (
        typeof policy.rejectInvalidSource !== 'boolean' ||
        typeof policy.rejectDuplicateTimestamp !== 'boolean' ||
        typeof policy.rejectOutOfOrder !== 'boolean'
    ) {
        throw new Error('Runtime Contract Error: required policy switches must be booleans.');
    }
    if (policy.rejectInvalidOhlcv !== undefined && typeof policy.rejectInvalidOhlcv !== 'boolean') {
        throw new Error('Runtime Contract Error: rejectInvalidOhlcv must be a boolean when provided.');
    }
}

function validateDataQuality(dataQuality: DataQualityStatus): void {
    const qualityFields: readonly (keyof DataQualityStatus)[] = [
        'isSourceValid',
        'hasDataGap',
        'isDiscontinuity',
        'isDuplicate',
        'isOutOfOrder',
        'isUnexpectedInterval'
    ];
    if (!dataQuality || typeof dataQuality !== 'object' ||
        qualityFields.some(field => typeof dataQuality[field] !== 'boolean')) {
        throw new Error('Runtime Contract Error: dataQuality fields must all be booleans.');
    }
}

function validateRuntimeInputs(
    sourceTimestamp: number,
    dataQuality: DataQualityStatus,
    isValidOhlcv: boolean,
    policy: IntegrityPolicy,
    expectedIntervalMs: number
): void {
    if (!Number.isSafeInteger(sourceTimestamp) || sourceTimestamp < 0) {
        throw new Error(`Runtime Contract Error: sourceTimestamp must be a non-negative safe integer, got ${sourceTimestamp}`);
    }
    if (!Number.isSafeInteger(expectedIntervalMs) || expectedIntervalMs <= 0) {
        throw new Error(`Runtime Contract Error: expectedIntervalMs must be a positive safe integer, got ${expectedIntervalMs}`);
    }
    if (typeof isValidOhlcv !== 'boolean') {
        throw new Error(`Runtime Contract Error: isValidOhlcv must be a boolean, got ${typeof isValidOhlcv}`);
    }
    validateDataQuality(dataQuality);
    validatePolicy(policy);
}

/**
 * Standalone evaluation of acceptance against static quality status and policy.
 */
export function evaluateAcceptance(
    dataQuality: DataQualityStatus,
    policy: IntegrityPolicy,
    isValidOhlcv = true
): SourceAcceptanceResult {
    validateDataQuality(dataQuality);
    validatePolicy(policy);
    if (typeof isValidOhlcv !== 'boolean') {
        throw new Error('Runtime Contract Error: isValidOhlcv must be a boolean.');
    }

    const reasons: string[] = [];
    if (policy.rejectInvalidSource && !dataQuality.isSourceValid) {
        reasons.push('INVALID_SOURCE');
    }
    const rejectOhlcv = policy.rejectInvalidOhlcv ?? policy.rejectInvalidSource;
    if (rejectOhlcv && !isValidOhlcv) {
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
    validateRuntimeInputs(sourceTimestamp, dataQuality, isValidOhlcv, policy, expectedIntervalMs);
    if (!prevStats || typeof prevStats !== 'object') {
        throw new Error('Runtime Contract Error: prevStats must be a valid object.');
    }
    if (
        !Number.isSafeInteger(prevStats.sourceRowCount) || prevStats.sourceRowCount < 0 ||
        !Number.isSafeInteger(prevStats.acceptedObservationCount) || prevStats.acceptedObservationCount < 0 ||
        !Number.isSafeInteger(prevStats.rejectedObservationCount) || prevStats.rejectedObservationCount < 0 ||
        !Number.isSafeInteger(prevStats.missingIntervalCount) || prevStats.missingIntervalCount < 0 ||
        !Number.isSafeInteger(prevStats.unexpectedIntervalCount) || prevStats.unexpectedIntervalCount < 0 ||
        !Number.isSafeInteger(prevStats.duplicateTimestampCount) || prevStats.duplicateTimestampCount < 0 ||
        !Number.isSafeInteger(prevStats.outOfOrderCount) || prevStats.outOfOrderCount < 0 ||
        !Number.isSafeInteger(prevStats.invalidOhlcvCount) || prevStats.invalidOhlcvCount < 0 ||
        !Number.isSafeInteger(prevStats.invalidSourceCount) || prevStats.invalidSourceCount < 0 ||
        (prevStats.lastSourceTimestamp !== null &&
            (!Number.isSafeInteger(prevStats.lastSourceTimestamp) || prevStats.lastSourceTimestamp < 0))
    ) {
        throw new Error('Runtime Contract Error: prevStats contains invalid counters or timestamp watermark.');
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
            if (deltaMs % expectedIntervalMs === 0) {
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
        invalidSourceCount: prevStats.invalidSourceCount + (dataQuality.isSourceValid ? 0 : 1),
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

/**
 * Evaluates dataset uptime using total timeline slots, including rejected rows.
 */
export function evaluateDatasetUptime(
    stats: BackboneStats,
    policy: IntegrityPolicy
): DatasetUptimeEvaluation {
    validatePolicy(policy);
    const minRequired = policy.requireMinimumUptimeFraction;
    if (minRequired !== undefined && (!Number.isFinite(minRequired) || minRequired < 0 || minRequired > 1)) {
        throw new Error(
            `IntegrityPolicy Error: requireMinimumUptimeFraction must be a finite number in range [0, 1], got ${minRequired}`
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
 * Builds accepted and rejected rows from source candles in arrival order.
 * Does not sort or synthesize missing observations.
 */
export function buildSourceBackbone(
    stream: readonly SourceBackboneInputItem[],
    symbol: string,
    timeframe: string,
    datasetVersion: number,
    policy: IntegrityPolicy,
    expectedIntervalMs: number
): SourceBackboneBuildResult {
    if (!Array.isArray(stream)) {
        throw new Error('Runtime Contract Error: stream must be an array.');
    }
    if (typeof symbol !== 'string' || symbol.length === 0) {
        throw new Error('Runtime Contract Error: symbol must be a non-empty string.');
    }
    if (typeof timeframe !== 'string' || timeframe.length === 0) {
        throw new Error('Runtime Contract Error: timeframe must be a non-empty string.');
    }
    if (!Number.isSafeInteger(datasetVersion) || datasetVersion < 0) {
        throw new Error('Runtime Contract Error: datasetVersion must be a non-negative safe integer.');
    }
    validatePolicy(policy);
    calculateObservationTimestamp(0, expectedIntervalMs);

    let stats = createInitialBackboneStats();
    const acceptedRows: SourceBackboneAcceptedRow[] = [];
    const rejectedRows: SourceBackboneRejectedRow[] = [];

    for (const item of stream) {
        if (!item || typeof item !== 'object' || !item.candle || !item.observation) {
            throw new Error('Runtime Contract Error: each stream item must include a candle and observation.');
        }
        const dataQuality = extractDataQuality(item.observation);
        const result = processSourceObservation(
            stats,
            item.candle.time,
            dataQuality,
            item.isValidOhlcv,
            policy,
            expectedIntervalMs
        );
        stats = result.nextStats;
        const candle = Object.freeze({ ...item.candle });

        if (result.acceptance.isAccepted) {
            acceptedRows.push(Object.freeze({
                observationId: generateObservationId(symbol, timeframe, item.candle.time, datasetVersion),
                sourceTimestamp: item.candle.time,
                observationTimestamp: result.observationTimestamp,
                candle,
                dataQuality: result.acceptance.dataQuality
            }));
        } else {
            rejectedRows.push(Object.freeze({
                sourceTimestamp: item.candle.time,
                candle,
                reasons: result.acceptance.rejectionReasons
            }));
        }
    }

    return Object.freeze({
        acceptedRows: Object.freeze(acceptedRows),
        rejectedRows: Object.freeze(rejectedRows),
        stats,
        uptime: evaluateDatasetUptime(stats, policy)
    });
}
