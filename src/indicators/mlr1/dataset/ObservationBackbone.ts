import type { ML1Candle, ML1Observation } from '../ML1FeatureTypes';
import type { DataQualityStatus } from './DatasetTypes';
import type { DatasetConfig, DatasetDateRange, IntegrityPolicy } from './DatasetConfig';
import type { DatasetManifest, IntegrityAuditResults, MissingDataStatistics } from './DatasetManifest';

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
    readonly offGridTimestampCount: number;
    readonly outOfRangeTimestampCount: number;
    readonly uniqueSourceTimestampsCount: number;
    readonly uniqueAcceptedTimestampsCount: number;
    readonly firstSourceTimestamp: number | null;
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
        offGridTimestampCount: 0,
        outOfRangeTimestampCount: 0,
        uniqueSourceTimestampsCount: 0,
        uniqueAcceptedTimestampsCount: 0,
        firstSourceTimestamp: null,
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
    readonly isValidOhlcv?: boolean;
}

export interface UniqueTimestampTracking {
    readonly isUniqueSource: boolean;
    readonly isCandidateUniqueAccepted: boolean;
}

export interface SlotIntegrityContext {
    readonly isOnGrid?: boolean;
    readonly isWithinRange?: boolean;
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
    if (policy.requireMinimumUptimeFraction !== undefined &&
        (!Number.isFinite(policy.requireMinimumUptimeFraction) ||
            policy.requireMinimumUptimeFraction < 0 ||
            policy.requireMinimumUptimeFraction > 1)) {
        throw new Error('Runtime Contract Error: requireMinimumUptimeFraction must be a finite number between 0 and 1.');
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
    expectedIntervalMs: number,
    prevStats: BackboneStats
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
    if (!prevStats || typeof prevStats !== 'object') {
        throw new Error('Runtime Contract Error: prevStats must be a valid object.');
    }
    if (
        !Number.isSafeInteger(prevStats.sourceRowCount) || prevStats.sourceRowCount < 0 ||
        !Number.isSafeInteger(prevStats.acceptedObservationCount) || prevStats.acceptedObservationCount < 0 ||
        !Number.isSafeInteger(prevStats.rejectedObservationCount) || prevStats.rejectedObservationCount < 0 ||
        prevStats.sourceRowCount !== prevStats.acceptedObservationCount + prevStats.rejectedObservationCount
    ) {
        throw new Error('Runtime Contract Error: prevStats violates accounting invariant (sourceRowCount !== accepted + rejected).');
    }
    const counters = [
        prevStats.missingIntervalCount,
        prevStats.unexpectedIntervalCount,
        prevStats.duplicateTimestampCount,
        prevStats.outOfOrderCount,
        prevStats.invalidOhlcvCount,
        prevStats.invalidSourceCount,
        prevStats.offGridTimestampCount,
        prevStats.outOfRangeTimestampCount,
        prevStats.uniqueSourceTimestampsCount,
        prevStats.uniqueAcceptedTimestampsCount
    ];
    if (
        counters.some(counter => !Number.isSafeInteger(counter) || counter < 0) ||
        prevStats.uniqueSourceTimestampsCount > prevStats.sourceRowCount ||
        prevStats.uniqueAcceptedTimestampsCount > prevStats.uniqueSourceTimestampsCount ||
        prevStats.uniqueAcceptedTimestampsCount > prevStats.acceptedObservationCount
    ) {
        throw new Error('Runtime Contract Error: prevStats contains invalid counters.');
    }
    for (const timestamp of [prevStats.firstSourceTimestamp, prevStats.lastSourceTimestamp]) {
        if (timestamp !== null && (!Number.isSafeInteger(timestamp) || timestamp < 0)) {
            throw new Error('Runtime Contract Error: prevStats contains an invalid timestamp boundary.');
        }
    }
    if (
        (prevStats.sourceRowCount === 0 &&
            (prevStats.firstSourceTimestamp !== null || prevStats.lastSourceTimestamp !== null)) ||
        (prevStats.sourceRowCount > 0 &&
            (prevStats.firstSourceTimestamp === null || prevStats.lastSourceTimestamp === null)) ||
        (prevStats.firstSourceTimestamp !== null &&
            prevStats.lastSourceTimestamp !== null &&
            prevStats.firstSourceTimestamp > prevStats.lastSourceTimestamp)
    ) {
        throw new Error('Runtime Contract Error: prevStats contains inconsistent timestamp boundaries.');
    }
}

/**
 * Standalone evaluation of acceptance against static quality status and policy.
 */
export function evaluateAcceptance(
    dataQuality: DataQualityStatus,
    policy: IntegrityPolicy,
    isValidOhlcv = true,
    slotContext?: SlotIntegrityContext
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
    if (slotContext?.isOnGrid === false) {
        reasons.push('OFF_GRID_TIMESTAMP');
    }
    if (slotContext?.isWithinRange === false) {
        reasons.push('OUT_OF_RANGE_TIMESTAMP');
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
    expectedIntervalMs: number,
    knownUniqueTracking?: UniqueTimestampTracking,
    dateRange?: DatasetDateRange
): ProcessSourceResult {
    validateRuntimeInputs(sourceTimestamp, dataQuality, isValidOhlcv, policy, expectedIntervalMs, prevStats);
    if (knownUniqueTracking !== undefined &&
        (!knownUniqueTracking || typeof knownUniqueTracking !== 'object' ||
            typeof knownUniqueTracking.isUniqueSource !== 'boolean' ||
            typeof knownUniqueTracking.isCandidateUniqueAccepted !== 'boolean')) {
        throw new Error('Runtime Contract Error: knownUniqueTracking fields must be booleans.');
    }
    if (dateRange !== undefined &&
        (!dateRange || !Number.isSafeInteger(dateRange.startTimestamp) ||
            dateRange.startTimestamp < 0 || !Number.isSafeInteger(dateRange.endTimestamp) ||
            dateRange.endTimestamp < dateRange.startTimestamp ||
            !Number.isSafeInteger(dateRange.endTimestamp - dateRange.startTimestamp) ||
            (dateRange.endTimestamp - dateRange.startTimestamp) % expectedIntervalMs !== 0)) {
        throw new Error('Runtime Contract Error: dateRange must contain ordered, interval-aligned safe integer timestamps.');
    }

    const gridAnchor = dateRange?.startTimestamp ??
        prevStats.firstSourceTimestamp ?? sourceTimestamp;
    const isOnGrid = (sourceTimestamp - gridAnchor) % expectedIntervalMs === 0;
    const isWithinRange = dateRange === undefined ||
        (sourceTimestamp >= dateRange.startTimestamp && sourceTimestamp <= dateRange.endTimestamp);
    const isValidExpectedSlot = isOnGrid && isWithinRange;

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
    const acceptance = evaluateAcceptance(combinedQuality, policy, isValidOhlcv, {
        isOnGrid,
        isWithinRange
    });
    const nextWatermark = prevStats.lastSourceTimestamp === null || sourceTimestamp > prevStats.lastSourceTimestamp
        ? sourceTimestamp
        : prevStats.lastSourceTimestamp;
    const nextFirstTimestamp = prevStats.firstSourceTimestamp === null
        ? sourceTimestamp
        : Math.min(prevStats.firstSourceTimestamp, sourceTimestamp);
    const isUniqueSource = knownUniqueTracking !== undefined
        ? knownUniqueTracking.isUniqueSource && isValidExpectedSlot
        : !combinedQuality.isDuplicate && isValidExpectedSlot;
    const isUniqueAccepted = knownUniqueTracking !== undefined
        ? acceptance.isAccepted &&
            knownUniqueTracking.isCandidateUniqueAccepted && isUniqueSource
        : acceptance.isAccepted && isUniqueSource && !combinedQuality.isDuplicate;
    if (isUniqueAccepted &&
        (!isUniqueSource || !acceptance.isAccepted || combinedQuality.isDuplicate)) {
        throw new Error('Runtime Contract Error: a unique accepted timestamp must be unique, accepted, and non-duplicate.');
    }

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
        offGridTimestampCount: prevStats.offGridTimestampCount + (!isOnGrid ? 1 : 0),
        outOfRangeTimestampCount: prevStats.outOfRangeTimestampCount + (!isWithinRange ? 1 : 0),
        uniqueSourceTimestampsCount: prevStats.uniqueSourceTimestampsCount + (isUniqueSource ? 1 : 0),
        uniqueAcceptedTimestampsCount: prevStats.uniqueAcceptedTimestampsCount + (isUniqueAccepted ? 1 : 0),
        firstSourceTimestamp: nextFirstTimestamp,
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
    expectedIntervalMs: number,
    knownUniqueTracking?: UniqueTimestampTracking,
    dateRange?: DatasetDateRange
): ProcessSourceResult {
    return processSourceObservation(
        prevStats,
        sourceTimestamp,
        dataQuality,
        isValidOhlcv,
        policy,
        expectedIntervalMs,
        knownUniqueTracking,
        dateRange
    );
}

/**
 * Evaluates dataset uptime using total timeline slots, including rejected rows.
 */
export function evaluateDatasetUptime(
    stats: BackboneStats,
    policy: IntegrityPolicy,
    expectedIntervalMs = 60000,
    dateRange?: DatasetDateRange
): DatasetUptimeEvaluation {
    if (!stats || typeof stats !== 'object') {
        throw new Error('evaluateDatasetUptime Error: stats must be a valid BackboneStats object.');
    }
    validatePolicy(policy);
    if (!Number.isSafeInteger(expectedIntervalMs) || expectedIntervalMs <= 0) {
        throw new Error('Runtime Contract Error: expectedIntervalMs must be a positive safe integer.');
    }
    const minRequired = policy.requireMinimumUptimeFraction;
    if (minRequired !== undefined && (!Number.isFinite(minRequired) || minRequired < 0 || minRequired > 1)) {
        throw new Error('IntegrityPolicy Error: requireMinimumUptimeFraction must be a finite number between 0 and 1.');
    }

    const statCounters: readonly (keyof BackboneStats)[] = [
        'sourceRowCount',
        'acceptedObservationCount',
        'rejectedObservationCount',
        'missingIntervalCount',
        'unexpectedIntervalCount',
        'duplicateTimestampCount',
        'outOfOrderCount',
        'invalidOhlcvCount',
        'invalidSourceCount',
        'offGridTimestampCount',
        'outOfRangeTimestampCount',
        'uniqueSourceTimestampsCount',
        'uniqueAcceptedTimestampsCount'
    ];
    for (const counter of statCounters) {
        const value = stats[counter];
        if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
            throw new Error(`evaluateDatasetUptime Error: stats.${counter} must be a non-negative safe integer, got ${value}`);
        }
    }
    if (stats.firstSourceTimestamp !== null &&
        (!Number.isSafeInteger(stats.firstSourceTimestamp) || stats.firstSourceTimestamp < 0)) {
        throw new Error('evaluateDatasetUptime Error: firstSourceTimestamp must be null or a non-negative safe integer.');
    }
    if (stats.lastSourceTimestamp !== null &&
        (!Number.isSafeInteger(stats.lastSourceTimestamp) || stats.lastSourceTimestamp < 0)) {
        throw new Error('evaluateDatasetUptime Error: lastSourceTimestamp must be null or a non-negative safe integer.');
    }
    if (stats.firstSourceTimestamp !== null && stats.lastSourceTimestamp !== null &&
        stats.firstSourceTimestamp > stats.lastSourceTimestamp) {
        throw new Error('evaluateDatasetUptime Error: firstSourceTimestamp cannot exceed lastSourceTimestamp.');
    }
    if (stats.sourceRowCount !== stats.acceptedObservationCount + stats.rejectedObservationCount ||
        stats.uniqueAcceptedTimestampsCount > stats.uniqueSourceTimestampsCount ||
        stats.uniqueSourceTimestampsCount > stats.sourceRowCount ||
        stats.uniqueAcceptedTimestampsCount > stats.acceptedObservationCount) {
        throw new Error('evaluateDatasetUptime Error: stats counters violate source/unique timestamp invariants.');
    }

    let totalExpectedObservations = 0;
    if (dateRange !== undefined) {
        if (!dateRange || !Number.isSafeInteger(dateRange.startTimestamp) ||
            !Number.isSafeInteger(dateRange.endTimestamp) ||
            dateRange.startTimestamp < 0 || dateRange.endTimestamp < dateRange.startTimestamp) {
            throw new Error('IntegrityPolicy Error: dateRange must contain ordered non-negative safe integer timestamps.');
        }
        const rangeSpan = dateRange.endTimestamp - dateRange.startTimestamp;
        if (!Number.isSafeInteger(rangeSpan) || rangeSpan % expectedIntervalMs !== 0) {
            throw new Error('IntegrityPolicy Error: dateRange span must be an exact multiple of expectedIntervalMs.');
        }
        totalExpectedObservations =
            Math.floor(rangeSpan / expectedIntervalMs) + 1;
        if (!Number.isSafeInteger(totalExpectedObservations)) {
            throw new Error('evaluateDatasetUptime Error: configured date range exceeds safe timeline slot count.');
        }
    } else if (stats.firstSourceTimestamp !== null && stats.lastSourceTimestamp !== null) {
        const spanMs = stats.lastSourceTimestamp - stats.firstSourceTimestamp;
        if (spanMs >= 0) {
            totalExpectedObservations = Math.floor(spanMs / expectedIntervalMs) + 1;
        }
    }
    if (!Number.isSafeInteger(totalExpectedObservations)) {
        throw new Error('evaluateDatasetUptime Error: expected timeline slot count exceeds safe integer range.');
    }
    if (totalExpectedObservations === 0) {
        return Object.freeze({
            isUptimeValid: false,
            sourceAvailabilityFraction: 0,
            usableObservationFraction: 0,
            totalExpectedObservations: 0
        });
    }

    const sourceAvailabilityFraction = Math.min(
        1,
        stats.uniqueSourceTimestampsCount / totalExpectedObservations
    );
    const usableObservationFraction = Math.min(
        1,
        stats.uniqueAcceptedTimestampsCount / totalExpectedObservations
    );

    return Object.freeze({
        isUptimeValid: policy.requireMinimumUptimeFraction === undefined ||
            usableObservationFraction >= policy.requireMinimumUptimeFraction,
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
    expectedIntervalMs: number,
    dateRange?: DatasetDateRange
): SourceBackboneBuildResult {
    if (!Array.isArray(stream)) {
        throw new Error('Runtime Contract Error: stream must be an array.');
    }
    for (let index = 0; index < stream.length; index++) {
        const item = stream[index];
        if (!item || typeof item !== 'object' || !item.candle || !item.observation) {
            throw new Error(`buildSourceBackbone Error: item at index ${index} is missing candle or observation.`);
        }
        if (item.candle.time !== item.observation.timestamp) {
            throw new Error(
                `buildSourceBackbone Error: Timestamp mismatch at index ${index}. ` +
                `Candle time (${item.candle.time}) !== observation timestamp (${item.observation.timestamp}).`
            );
        }
    }
    if (typeof timeframe !== 'string' || timeframe.trim().length === 0) {
        throw new Error('Runtime Contract Error: timeframe must be a non-empty string.');
    }
    if (typeof symbol !== 'string' || symbol.trim().length === 0) {
        throw new Error('Runtime Contract Error: symbol must be a non-empty string.');
    }
    if (!Number.isSafeInteger(datasetVersion) || datasetVersion < 1) {
        throw new Error('Runtime Contract Error: datasetVersion must be a positive safe integer.');
    }
    validatePolicy(policy);
    if (!Number.isSafeInteger(expectedIntervalMs) || expectedIntervalMs <= 0) {
        throw new Error('Runtime Contract Error: expectedIntervalMs must be a positive safe integer.');
    }
    calculateObservationTimestamp(0, expectedIntervalMs);
    if (dateRange !== undefined &&
        (!dateRange || !Number.isSafeInteger(dateRange.startTimestamp) || dateRange.startTimestamp < 0 ||
            !Number.isSafeInteger(dateRange.endTimestamp) || dateRange.endTimestamp < dateRange.startTimestamp ||
            !Number.isSafeInteger(dateRange.endTimestamp - dateRange.startTimestamp) ||
            (dateRange.endTimestamp - dateRange.startTimestamp) % expectedIntervalMs !== 0)) {
        throw new Error('buildSourceBackbone Error: dateRange must be ordered safe integer timestamps with an interval-aligned span.');
    }

    let stats = createInitialBackboneStats();
    const acceptedRows: SourceBackboneAcceptedRow[] = [];
    const rejectedRows: SourceBackboneRejectedRow[] = [];
    const seenTimestamps = new Set<number>();
    const acceptedTimestamps = new Set<number>();

    for (const item of stream) {
        if (!item || typeof item !== 'object' || !item.candle || !item.observation) {
            throw new Error('Runtime Contract Error: each stream item must include a candle and observation.');
        }
        if (item.isValidOhlcv !== undefined && typeof item.isValidOhlcv !== 'boolean') {
            throw new Error('Runtime Contract Error: isValidOhlcv must be a boolean when provided.');
        }
        const dataQuality = extractDataQuality(item.observation);
        const timestamp = item.candle.time;
        const isUniqueSource = !seenTimestamps.has(timestamp);
        seenTimestamps.add(item.candle.time);
        const isCandidateUniqueAccepted = isUniqueSource &&
            !acceptedTimestamps.has(timestamp);
        const nativeValidOhlcv = validateCandleOhlcv(item.candle);
        const isValidOhlcv = nativeValidOhlcv && (item.isValidOhlcv ?? true);
        const result = processSourceObservation(
            stats,
            timestamp,
            dataQuality,
            isValidOhlcv,
            policy,
            expectedIntervalMs,
            {
                isUniqueSource,
                isCandidateUniqueAccepted
            },
            dateRange
        );
        stats = result.nextStats;
        const candle = Object.freeze({ ...item.candle });

        if (result.acceptance.isAccepted) {
            acceptedTimestamps.add(timestamp);
            acceptedRows.push(Object.freeze({
                observationId: generateObservationId(symbol, timeframe, timestamp, datasetVersion),
                sourceTimestamp: timestamp,
                observationTimestamp: result.observationTimestamp,
                candle,
                dataQuality: result.acceptance.dataQuality
            }));
        } else {
            rejectedRows.push(Object.freeze({
                sourceTimestamp: timestamp,
                candle,
                reasons: result.acceptance.rejectionReasons
            }));
        }
    }

    return Object.freeze({
        acceptedRows: Object.freeze(acceptedRows),
        rejectedRows: Object.freeze(rejectedRows),
        stats,
        uptime: evaluateDatasetUptime(stats, policy, expectedIntervalMs, dateRange)
    });
}

/**
 * Validates candle OHLCV structure before allowing it to contribute to the dataset.
 */
export function validateCandleOhlcv(candle: ML1Candle): boolean {
    return !!candle && typeof candle === 'object' &&
        Number.isSafeInteger(candle.time) && candle.time >= 0 &&
        Number.isFinite(candle.open) && Number.isFinite(candle.high) &&
        Number.isFinite(candle.low) && Number.isFinite(candle.close) &&
        Number.isFinite(candle.volume) &&
        candle.high >= candle.low &&
        candle.high >= Math.max(candle.open, candle.close) &&
        candle.low <= Math.min(candle.open, candle.close) &&
        candle.volume >= 0;
}

/**
 * Reconciles backbone accounting and uptime into the immutable dataset manifest.
 */
export function createDatasetManifest(
    datasetId: string,
    sourceIdentity: string,
    buildConfig: DatasetConfig,
    stats: BackboneStats,
    uptime: DatasetUptimeEvaluation,
    auditResults: IntegrityAuditResults,
    htfStatsOverhead?: Partial<MissingDataStatistics>
): DatasetManifest {
    if (!datasetId || !sourceIdentity) {
        throw new Error('DatasetManifest Error: datasetId and sourceIdentity must be non-empty strings.');
    }
    if (stats.sourceRowCount !== stats.acceptedObservationCount + stats.rejectedObservationCount) {
        throw new Error('DatasetManifest Error: source row accounting invariant failed.');
    }
    const missingDataStats: MissingDataStatistics = Object.freeze({
        missingIntervalCount: stats.missingIntervalCount,
        unexpectedIntervalCount: stats.unexpectedIntervalCount,
        duplicateTimestampCount: stats.duplicateTimestampCount,
        outOfOrderCount: stats.outOfOrderCount,
        invalidOhlcvCount: stats.invalidOhlcvCount,
        invalidSourceCount: stats.invalidSourceCount,
        offGridTimestampCount: stats.offGridTimestampCount +
            (htfStatsOverhead?.offGridTimestampCount ?? 0),
        outOfRangeTimestampCount: stats.outOfRangeTimestampCount +
            (htfStatsOverhead?.outOfRangeTimestampCount ?? 0),
        htf15mGapCount: htfStatsOverhead?.htf15mGapCount ?? 0,
        htf1hGapCount: htfStatsOverhead?.htf1hGapCount ?? 0,
        htf15mResetCount: htfStatsOverhead?.htf15mResetCount ?? 0,
        htf1hResetCount: htfStatsOverhead?.htf1hResetCount ?? 0,
        htf15mIncompleteWindowCount: htfStatsOverhead?.htf15mIncompleteWindowCount ?? 0,
        htf1hIncompleteWindowCount: htfStatsOverhead?.htf1hIncompleteWindowCount ?? 0
    });

    return Object.freeze({
        datasetId,
        sourceIdentity,
        symbol: buildConfig.symbol,
        timeframe: buildConfig.baseTimeframe,
        startTimestamp: buildConfig.dateRange.startTimestamp,
        endTimestamp: buildConfig.dateRange.endTimestamp,
        sourceRowCount: stats.sourceRowCount,
        acceptedObservationCount: stats.acceptedObservationCount,
        rejectedObservationCount: stats.rejectedObservationCount,
        totalExpectedObservations: uptime.totalExpectedObservations,
        sourceAvailabilityFraction: uptime.sourceAvailabilityFraction,
        usableObservationFraction: uptime.usableObservationFraction,
        isUptimeValid: uptime.isUptimeValid,
        featureVersion: buildConfig.featureConfigVersion,
        teacherVersion: buildConfig.teacherVersion,
        outcomeVersion: buildConfig.outcomeConfigVersion,
        missingDataStats,
        buildConfig,
        buildTimestamp: Date.now(),
        auditResults
    });
}
