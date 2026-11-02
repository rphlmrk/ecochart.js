import { createInitialML1FeatureState } from '../ML1FeatureEngine';
import type {
    HTFAggregationState,
    HTFContextAvailability,
    MTFCandle,
    MTFContext,
    MTFState,
    MTFTimeframeContext,
    MTFTimeframeState,
    SupportedMTFTimeframe
} from './MTFTypes';
import type { ML1FeatureValidity, ML1FeatureValues } from '../ML1FeatureTypes';

/**
 * Returns UTC-aligned half-open window boundaries: [openTimestamp, closeTimestamp).
 */
export function getUTCWindowBoundaries(
    timestamp: number,
    durationMs: number
): { openTimestamp: number; closeTimestamp: number } {
    if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
        throw new Error(`MTF Boundary Error: Timestamp must be a safe non-negative integer, got ${timestamp}`);
    }
    if (!Number.isSafeInteger(durationMs) || durationMs <= 0) {
        throw new Error(`MTF Boundary Error: DurationMs must be a positive safe integer, got ${durationMs}`);
    }

    const openTimestamp = Math.floor(timestamp / durationMs) * durationMs;
    const closeTimestamp = openTimestamp + durationMs;
    if (!Number.isSafeInteger(openTimestamp) || !Number.isSafeInteger(closeTimestamp)) {
        throw new Error('MTF Boundary Error: Calculated boundaries exceed safe integer range.');
    }
    return { openTimestamp, closeTimestamp };
}

/**
 * Checks whether a source timestamp belongs to the half-open interval [open, close).
 */
export function isSourceTimestampInWindow(
    sourceTime: number,
    windowOpen: number,
    windowClose: number
): boolean {
    if (
        !Number.isSafeInteger(sourceTime) ||
        !Number.isSafeInteger(windowOpen) ||
        !Number.isSafeInteger(windowClose) ||
        sourceTime < 0 ||
        windowOpen < 0 ||
        windowClose <= windowOpen
    ) {
        return false;
    }
    return sourceTime >= windowOpen && sourceTime < windowClose;
}

/**
 * A completed HTF candle is available at its exclusive close boundary.
 */
export function isHTFCandleAvailableAt(
    observationTime: number,
    htfCloseTimestamp: number
): boolean {
    if (
        !Number.isSafeInteger(observationTime) ||
        !Number.isSafeInteger(htfCloseTimestamp) ||
        observationTime < 0 ||
        htfCloseTimestamp <= 0
    ) {
        return false;
    }
    return observationTime >= htfCloseTimestamp;
}

/**
 * Returns null when the HTF candle is not yet available.
 */
export function calculateContextAgeMs(
    observationTime: number,
    htfCloseTimestamp: number
): number | null {
    if (
        !Number.isSafeInteger(observationTime) ||
        !Number.isSafeInteger(htfCloseTimestamp) ||
        observationTime < 0 ||
        htfCloseTimestamp <= 0
    ) {
        return null;
    }
    if (observationTime < htfCloseTimestamp) return null;
    return observationTime - htfCloseTimestamp;
}

/**
 * Resolves whether completed HTF context is eligible for consumption.
 * The last candle and its age remain available to diagnostics when stale.
 */
export function resolveHTFAvailability(
    lastCompletedCandle: MTFCandle | null,
    contextAgeMs: number | null,
    isWarmupComplete: boolean,
    maxStalenessMs?: number
): {
    isAvailable: boolean;
    availabilityStatus: HTFContextAvailability;
} {
    if (maxStalenessMs !== undefined) {
        if (!Number.isSafeInteger(maxStalenessMs) || maxStalenessMs <= 0) {
            throw new Error(
                `MTF Staleness Error: maxStalenessMs must be a positive safe integer if defined, got ${maxStalenessMs}`
            );
        }
    }

    if (!lastCompletedCandle || lastCompletedCandle.completeness !== 'COMPLETE') {
        return { isAvailable: false, availabilityStatus: 'UNAVAILABLE' };
    }

    if (contextAgeMs === null || !Number.isSafeInteger(contextAgeMs) || contextAgeMs < 0) {
        return { isAvailable: false, availabilityStatus: 'UNAVAILABLE' };
    }

    if (maxStalenessMs !== undefined && contextAgeMs > maxStalenessMs) {
        return { isAvailable: false, availabilityStatus: 'STALE' };
    }

    if (!isWarmupComplete) {
        return { isAvailable: true, availabilityStatus: 'WARMING_UP' };
    }
    return { isAvailable: true, availabilityStatus: 'AVAILABLE_VALID' };
}

/**
 * Builds an immutable timeframe context, retaining stale candle data for diagnostics
 * while preventing stale context from being consumed.
 */
export function createMTFTimeframeContext(
    timeframe: SupportedMTFTimeframe,
    lastCompletedCandle: MTFCandle | null,
    observationTimestamp: number,
    isWarmupComplete: boolean,
    features: ML1FeatureValues = {},
    validity: ML1FeatureValidity = {},
    maxStalenessMs?: number
): MTFTimeframeContext {
    if (lastCompletedCandle !== null && lastCompletedCandle.timeframe !== timeframe) {
        throw new Error(
            `MTF Context Error: Candle timeframe ${lastCompletedCandle.timeframe} does not match requested context timeframe ${timeframe}`
        );
    }

    const candleSnapshot = lastCompletedCandle === null
        ? null
        : Object.freeze({ ...lastCompletedCandle });
    const closeTimestamp = candleSnapshot?.closeTimestamp ?? null;
    const contextAgeMs = closeTimestamp !== null && Number.isSafeInteger(observationTimestamp)
        ? calculateContextAgeMs(observationTimestamp, closeTimestamp)
        : null;
    const { isAvailable, availabilityStatus } = resolveHTFAvailability(
        candleSnapshot,
        contextAgeMs,
        isWarmupComplete,
        maxStalenessMs
    );

    return Object.freeze({
        timeframe,
        lastCompletedCandle: candleSnapshot,
        lastCompletedOpenTimestamp: candleSnapshot?.openTimestamp ?? null,
        lastCompletedCloseTimestamp: closeTimestamp,
        contextAgeMs,
        isAvailable,
        availabilityStatus,
        isWarmupComplete,
        features: Object.isFrozen(features) ? features : Object.freeze({ ...features }),
        validity: Object.isFrozen(validity) ? validity : Object.freeze({ ...validity })
    });
}

export function createInitialHTFAggregationState(): HTFAggregationState {
    return Object.freeze({
        currentWindowOpen: null,
        currentWindowClose: null,
        sourceCandles: Object.freeze([]),
        sourceTimestamps: Object.freeze([]),
        observedTimestamps: Object.freeze([]),
        actualSourceCount: 0,
        runningOpen: null,
        runningHigh: null,
        runningLow: null,
        runningClose: null,
        runningVolume: 0,
        duplicateCount: 0,
        invalidSourceCount: 0,
        lastObservedSourceTimestamp: null,
        lastAcceptedSourceTimestamp: null,
        lastCompletedCandle: null,
        lastDiagnostic: null
    });
}

export function createInitialMTFTimeframeState(timeframe: SupportedMTFTimeframe): MTFTimeframeState {
    return Object.freeze({
        timeframe,
        aggregation: createInitialHTFAggregationState(),
        featureEngineState: createInitialML1FeatureState(),
        lastCompletedBarIndex: null,
        latestFeatures: Object.freeze({}),
        latestValidity: Object.freeze({})
    });
}

export function createInitialMTFState(): MTFState {
    return Object.freeze({
        stateVersion: 1,
        last1mBarIndex: null,
        last1mTimestamp: null,
        state15m: createInitialMTFTimeframeState('15m'),
        state1h: createInitialMTFTimeframeState('1h')
    });
}

export function createEmptyMTFTimeframeContext(timeframe: SupportedMTFTimeframe): MTFTimeframeContext {
    return Object.freeze({
        timeframe,
        lastCompletedCandle: null,
        lastCompletedOpenTimestamp: null,
        lastCompletedCloseTimestamp: null,
        contextAgeMs: null,
        isAvailable: false,
        availabilityStatus: 'UNAVAILABLE',
        isWarmupComplete: false,
        features: Object.freeze({}),
        validity: Object.freeze({})
    });
}

export function createEmptyMTFContext(observationTimestamp: number, symbol: string): MTFContext {
    return Object.freeze({
        observationTimestamp,
        symbol,
        context15m: createEmptyMTFTimeframeContext('15m'),
        context1h: createEmptyMTFTimeframeContext('1h')
    });
}
