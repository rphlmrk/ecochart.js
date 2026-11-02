import { createInitialML1FeatureState } from '../ML1FeatureEngine';
import type {
    HTFAggregationState,
    MTFContext,
    MTFState,
    MTFTimeframeContext,
    MTFTimeframeState,
    SupportedMTFTimeframe
} from './MTFTypes';

/**
 * Returns UTC-aligned half-open window boundaries: [openTimestamp, closeTimestamp).
 */
export function getUTCWindowBoundaries(
    timestamp: number,
    durationMs: number
): { openTimestamp: number; closeTimestamp: number } {
    if (!Number.isFinite(timestamp) || timestamp < 0) {
        throw new Error(`MTF Boundary Error: Invalid timestamp ${timestamp}`);
    }
    if (!Number.isFinite(durationMs) || durationMs <= 0) {
        throw new Error(`MTF Boundary Error: Invalid durationMs ${durationMs}`);
    }

    const openTimestamp = Math.floor(timestamp / durationMs) * durationMs;
    return { openTimestamp, closeTimestamp: openTimestamp + durationMs };
}

/**
 * Checks whether a source timestamp belongs to the half-open interval [open, close).
 */
export function isSourceTimestampInWindow(
    sourceTime: number,
    windowOpen: number,
    windowClose: number
): boolean {
    return sourceTime >= windowOpen && sourceTime < windowClose;
}

/**
 * A completed HTF candle is available at its exclusive close boundary.
 */
export function isHTFCandleAvailableAt(
    observationTime: number,
    htfCloseTimestamp: number
): boolean {
    return observationTime >= htfCloseTimestamp;
}

/**
 * Returns null when the HTF candle is not yet available.
 */
export function calculateContextAgeMs(
    observationTime: number,
    htfCloseTimestamp: number
): number | null {
    if (observationTime < htfCloseTimestamp) return null;
    return observationTime - htfCloseTimestamp;
}

export function createInitialHTFAggregationState(): HTFAggregationState {
    return Object.freeze({
        currentWindowOpen: null,
        currentWindowClose: null,
        sourceCandles: Object.freeze([]),
        sourceTimestamps: Object.freeze([]),
        actualSourceCount: 0,
        runningOpen: null,
        runningHigh: null,
        runningLow: null,
        runningClose: null,
        runningVolume: 0,
        duplicateCount: 0,
        invalidSourceCount: 0,
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
        lastCompletedBarIndex: null
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
