import {
    createInitialML1FeatureState,
    createInitialML1FeatureStateV6,
    computeML1ConfigV6Fingerprint,
    stepML1FeaturesV6
} from '../ML1FeatureEngine';
import type {
    HTFAggregationState,
    HTFContextAvailability,
    MTFCandle,
    MTFContext,
    MTFState,
    MTFTimeframeContext,
    MTFTimeframeState,
    SupportedMTFTimeframe,
    SupportedV4MTFTimeframe,
    V4HTFAggregationState,
    V4HTFIncompleteDiagnostic,
    V4MTFCandle,
    V4MTFContext,
    V4MTFState,
    V4MTFTimeframeContext,
    V4MTFTimeframeState
} from './MTFTypes';
import type { ML1FeatureValidity, ML1FeatureValues, ValidatedML1FeatureConfigV6 } from '../ML1FeatureTypes';
import type { ValidatedV4MTFGlobalConfig, V4MTFTimeframeConfig } from './MTFConfig';

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
 * Resolves HTF context availability and consumption eligibility independently
 * from feature warm-up readiness.
 */
export function resolveHTFAvailability(
    lastCompletedCandle: { readonly completeness: 'COMPLETE' } | null,
    contextAgeMs: number | null,
    isCandleAvailable: boolean,
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

    if (!lastCompletedCandle || lastCompletedCandle.completeness !== 'COMPLETE' || !isCandleAvailable) {
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
 * Builds an immutable timeframe context with separate candle-availability and
 * feature warm-up dimensions.
 */
export function createMTFTimeframeContext(
    timeframe: SupportedMTFTimeframe,
    lastCompletedCandle: MTFCandle | null,
    observationTimestamp: number,
    isCandleAvailable: boolean,
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

    const candleSnapshot = lastCompletedCandle && isCandleAvailable
        ? Object.freeze({ ...lastCompletedCandle })
        : null;
    const closeTimestamp = candleSnapshot?.closeTimestamp ?? null;
    const contextAgeMs = closeTimestamp !== null &&
        Number.isSafeInteger(observationTimestamp) &&
        isCandleAvailable
        ? calculateContextAgeMs(observationTimestamp, closeTimestamp)
        : null;
    const { isAvailable, availabilityStatus } = resolveHTFAvailability(
        candleSnapshot,
        contextAgeMs,
        isCandleAvailable,
        isWarmupComplete,
        maxStalenessMs
    );
    const effectiveWarmup = candleSnapshot !== null && isCandleAvailable
        ? isWarmupComplete
        : false;

    return Object.freeze({
        timeframe,
        lastCompletedCandle: candleSnapshot,
        lastCompletedOpenTimestamp: candleSnapshot?.openTimestamp ?? null,
        lastCompletedCloseTimestamp: closeTimestamp,
        contextAgeMs,
        isAvailable,
        availabilityStatus,
        isWarmupComplete: effectiveWarmup,
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
        lastCompletedCandleOpenTimestamp: null,
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

// =========================================================================
// V4 MTF State & Context Factories (3m & 5m)
// =========================================================================
export function createV4MTFTimeframeContext(
    timeframe: SupportedV4MTFTimeframe,
    lastCompletedCandle: V4MTFCandle | null,
    observationTimestamp: number,
    isCandleAvailable: boolean,
    isWarmupComplete: boolean,
    features: ML1FeatureValues = {},
    validity: ML1FeatureValidity = {},
    maxStalenessMs?: number
): V4MTFTimeframeContext {
    if (lastCompletedCandle !== null && lastCompletedCandle.timeframe !== timeframe) {
        throw new Error(
            `V4 MTF Context Error: Candle timeframe ${lastCompletedCandle.timeframe} does not match ${timeframe}`
        );
    }

    const candleSnapshot = lastCompletedCandle && isCandleAvailable
        ? Object.freeze({ ...lastCompletedCandle })
        : null;
    const closeTimestamp = candleSnapshot?.closeTimestamp ?? null;
    const contextAgeMs = closeTimestamp !== null &&
        Number.isSafeInteger(observationTimestamp) &&
        isCandleAvailable
        ? calculateContextAgeMs(observationTimestamp, closeTimestamp)
        : null;

    const { isAvailable, availabilityStatus } = resolveHTFAvailability(
        candleSnapshot,
        contextAgeMs,
        isCandleAvailable,
        isWarmupComplete,
        maxStalenessMs
    );
    const effectiveWarmup = candleSnapshot !== null && isCandleAvailable ? isWarmupComplete : false;

    return Object.freeze({
        timeframe,
        lastCompletedCandle: candleSnapshot,
        lastCompletedOpenTimestamp: candleSnapshot?.openTimestamp ?? null,
        lastCompletedCloseTimestamp: closeTimestamp,
        contextAgeMs,
        isAvailable,
        availabilityStatus,
        isWarmupComplete: effectiveWarmup,
        features: Object.isFrozen(features) ? features : Object.freeze({ ...features }),
        validity: Object.isFrozen(validity) ? validity : Object.freeze({ ...validity })
    });
}

export function createInitialV4HTFAggregationState(): V4HTFAggregationState {
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

export function createInitialV4MTFTimeframeState(
    timeframe: SupportedV4MTFTimeframe,
    featureConfig: ValidatedML1FeatureConfigV6
): V4MTFTimeframeState {
    return Object.freeze({
        timeframe,
        aggregation: createInitialV4HTFAggregationState(),
        featureEngineState: createInitialML1FeatureStateV6(featureConfig),
        lastCompletedBarIndex: null,
        lastCompletedCandleOpenTimestamp: null,
        latestFeatures: Object.freeze({}),
        latestValidity: Object.freeze({})
    });
}

export function createInitialV4MTFState(config: ValidatedV4MTFGlobalConfig): V4MTFState {
    return Object.freeze({
        stateVersion: 2 as const,
        last1mBarIndex: null,
        last1mTimestamp: null,
        state3m: createInitialV4MTFTimeframeState('3m', config.config3m.featureConfig),
        state5m: createInitialV4MTFTimeframeState('5m', config.config5m.featureConfig)
    });
}

export function createEmptyV4MTFTimeframeContext(timeframe: SupportedV4MTFTimeframe): V4MTFTimeframeContext {
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

export function createEmptyV4MTFContext(observationTimestamp: number, symbol: string): V4MTFContext {
    return Object.freeze({
        observationTimestamp,
        symbol,
        context3m: createEmptyV4MTFTimeframeContext('3m'),
        context5m: createEmptyV4MTFTimeframeContext('5m')
    });
}

const CANONICAL_V6_FEATURE_KEYS_BY_FP = new Map<string, ReadonlySet<string>>();

export function getCanonicalV4MTFFeatureKeys(featureConfig: ValidatedML1FeatureConfigV6): ReadonlySet<string> {
    if (featureConfig.volumeCandleSizePeriods.length > 0) {
        throw new Error('V4 MTF Schema Error: HTF featureConfig must have empty volumeCandleSizePeriods.');
    }
    const fp = computeML1ConfigV6Fingerprint(featureConfig);
    let keys = CANONICAL_V6_FEATURE_KEYS_BY_FP.get(fp);
    if (!keys) {
        const probe = stepML1FeaturesV6(
            { time: 0, open: 100, high: 101, low: 99, close: 100, volume: 100, isSynthetic: false },
            0,
            createInitialML1FeatureStateV6(featureConfig),
            featureConfig
        );
        const keyList = Object.keys(probe.observation.features);
        if (keyList.length !== 147) {
            throw new Error(`V4 MTF Schema Error: expected 147 canonical HTF features, got ${keyList.length}.`);
        }
        keys = new Set(keyList);
        CANONICAL_V6_FEATURE_KEYS_BY_FP.set(fp, keys);
    }
    return keys;
}

export function validateV4CompletedCandle(
    candle: V4MTFCandle,
    config: V4MTFTimeframeConfig
): void {
    const expectedSourceCount = Math.round(config.durationMs / 60_000);
    if (!candle || typeof candle !== 'object' ||
        candle.completeness !== 'COMPLETE' ||
        candle.timeframe !== config.timeframe ||
        !Number.isSafeInteger(candle.openTimestamp) || candle.openTimestamp < 0 || candle.openTimestamp % config.durationMs !== 0 ||
        !Number.isSafeInteger(candle.closeTimestamp) || candle.closeTimestamp !== candle.openTimestamp + config.durationMs ||
        candle.sourceObservationCount !== expectedSourceCount ||
        !Number.isFinite(candle.open) || candle.open <= 0 ||
        !Number.isFinite(candle.high) || candle.high <= 0 ||
        !Number.isFinite(candle.low) || candle.low <= 0 ||
        !Number.isFinite(candle.close) || candle.close <= 0 ||
        !Number.isFinite(candle.volume) || candle.volume < 0 ||
        candle.high < candle.low ||
        candle.high < Math.max(candle.open, candle.close) ||
        candle.low > Math.min(candle.open, candle.close)) {
        throw new Error(`V4 MTF State Integrity Error: invalid completedCandle for ${config.timeframe}.`);
    }
}

export function validateV4Diagnostic(
    d: V4HTFIncompleteDiagnostic,
    config: V4MTFTimeframeConfig
): void {
    const expectedSourceCount = Math.round(config.durationMs / 60_000);
    const validDiagCompleteness = new Set(['INCOMPLETE_MISSING', 'INCOMPLETE_INVALID', 'INCOMPLETE_DUPLICATE']);
    if (!d || typeof d !== 'object' ||
        d.timeframe !== config.timeframe ||
        !Number.isSafeInteger(d.openTimestamp) || d.openTimestamp < 0 || d.openTimestamp % config.durationMs !== 0 ||
        !Number.isSafeInteger(d.closeTimestamp) || d.closeTimestamp !== d.openTimestamp + config.durationMs ||
        d.expectedSourceCount !== expectedSourceCount ||
        !Number.isSafeInteger(d.actualSourceCount) || d.actualSourceCount < 0 || d.actualSourceCount > expectedSourceCount ||
        !Number.isSafeInteger(d.duplicateCount) || d.duplicateCount < 0 ||
        !Number.isSafeInteger(d.invalidSourceCount) || d.invalidSourceCount < 0 ||
        !validDiagCompleteness.has(d.completeness) ||
        !Array.isArray(d.missingTimestamps) ||
        d.actualSourceCount + d.missingTimestamps.length !== expectedSourceCount) {
        throw new Error(`V4 MTF State Integrity Error: invalid diagnostic for ${config.timeframe}.`);
    }

    // Enforce exact MTFAggregator diagnostic precedence:
    // INCOMPLETE_INVALID > INCOMPLETE_DUPLICATE > INCOMPLETE_MISSING
    if (d.invalidSourceCount > 0) {
        if (d.completeness !== 'INCOMPLETE_INVALID') {
            throw new Error(
                `V4 MTF State Integrity Error: invalidSourceCount (${d.invalidSourceCount}) > 0 requires INCOMPLETE_INVALID.`
            );
        }
    } else if (d.duplicateCount > 0) {
        if (d.completeness !== 'INCOMPLETE_DUPLICATE') {
            throw new Error(
                `V4 MTF State Integrity Error: duplicateCount (${d.duplicateCount}) > 0 with 0 invalids requires INCOMPLETE_DUPLICATE.`
            );
        }
    } else {
        if (d.completeness !== 'INCOMPLETE_MISSING' ||
            d.missingTimestamps.length === 0 ||
            d.actualSourceCount >= expectedSourceCount) {
            throw new Error(
                `V4 MTF State Integrity Error: INCOMPLETE_MISSING requires missingTimestamps > 0 with zero duplicates/invalids.`
            );
        }
    }

    const seenMissing = new Set<number>();
    for (const mt of d.missingTimestamps) {
        if (typeof mt !== 'number' || !Number.isSafeInteger(mt) ||
            mt < d.openTimestamp || mt >= d.closeTimestamp || (mt - d.openTimestamp) % 60_000 !== 0 ||
            seenMissing.has(mt)) {
            throw new Error(`V4 MTF State Integrity Error: invalid or duplicate missingTimestamp in ${config.timeframe} diagnostic.`);
        }
        seenMissing.add(mt);
    }
}

export function validateV4MTFTimeframeState(
    state: V4MTFTimeframeState,
    config: V4MTFTimeframeConfig
): void {
    if (!state || typeof state !== 'object') {
        throw new Error(`V4 MTF State Integrity Error: missing ${config.timeframe} timeframe state.`);
    }
    if (state.timeframe !== config.timeframe) {
        throw new Error(
            `V4 MTF State Integrity Error: timeframe '${String((state as any).timeframe)}' != expected '${config.timeframe}'.`
        );
    }
    const agg = state.aggregation;
    if (!agg || typeof agg !== 'object') {
        throw new Error(`V4 MTF State Integrity Error: missing ${config.timeframe} aggregation state.`);
    }
    const expectedSourceCount = Math.round(config.durationMs / 60_000);
    if (!Array.isArray(agg.sourceCandles) || !Array.isArray(agg.sourceTimestamps) || !Array.isArray(agg.observedTimestamps)) {
        throw new Error(`V4 MTF State Integrity Error: malformed ${config.timeframe} aggregation arrays.`);
    }
    if (!Number.isSafeInteger(agg.actualSourceCount) || agg.actualSourceCount < 0 || agg.actualSourceCount > expectedSourceCount ||
        !Number.isSafeInteger(agg.duplicateCount) || agg.duplicateCount < 0 ||
        !Number.isSafeInteger(agg.invalidSourceCount) || agg.invalidSourceCount < 0 ||
        !Number.isFinite(agg.runningVolume) || agg.runningVolume < 0) {
        throw new Error(`V4 MTF State Integrity Error: invalid ${config.timeframe} aggregation counters/volume.`);
    }
    if (agg.sourceCandles.length !== agg.actualSourceCount || agg.sourceTimestamps.length !== agg.actualSourceCount) {
        throw new Error(`V4 MTF State Integrity Error: ${config.timeframe} sourceCandles/sourceTimestamps count mismatch.`);
    }
    if (agg.observedTimestamps.length < agg.actualSourceCount || agg.observedTimestamps.length > expectedSourceCount) {
        throw new Error(`V4 MTF State Integrity Error: ${config.timeframe} observedTimestamps length out of bounds.`);
    }
    if (agg.lastObservedSourceTimestamp !== null &&
        (!Number.isSafeInteger(agg.lastObservedSourceTimestamp) || agg.lastObservedSourceTimestamp < 0)) {
        throw new Error(`V4 MTF State Integrity Error: invalid ${config.timeframe} lastObservedSourceTimestamp.`);
    }
    if (agg.lastAcceptedSourceTimestamp !== null &&
        (!Number.isSafeInteger(agg.lastAcceptedSourceTimestamp) || agg.lastAcceptedSourceTimestamp < 0)) {
        throw new Error(`V4 MTF State Integrity Error: invalid ${config.timeframe} lastAcceptedSourceTimestamp.`);
    }
    if (agg.currentWindowOpen === null || agg.currentWindowClose === null) {
        if (agg.currentWindowOpen !== agg.currentWindowClose ||
            agg.actualSourceCount !== 0 || agg.duplicateCount !== 0 || agg.invalidSourceCount !== 0 ||
            agg.observedTimestamps.length !== 0 ||
            agg.lastObservedSourceTimestamp !== null || agg.lastAcceptedSourceTimestamp !== null ||
            agg.runningOpen !== null || agg.runningHigh !== null || agg.runningLow !== null || agg.runningClose !== null ||
            agg.runningVolume !== 0) {
            throw new Error(`V4 MTF State Integrity Error: uninitialized ${config.timeframe} forming window has dirty state.`);
        }
    } else {
        if (!Number.isSafeInteger(agg.currentWindowOpen) || agg.currentWindowOpen < 0 || agg.currentWindowOpen % config.durationMs !== 0 ||
            !Number.isSafeInteger(agg.currentWindowClose) || agg.currentWindowClose !== agg.currentWindowOpen + config.durationMs) {
            throw new Error(`V4 MTF State Integrity Error: invalid ${config.timeframe} forming window boundaries.`);
        }
        if (agg.lastObservedSourceTimestamp === null ||
            agg.lastObservedSourceTimestamp < agg.currentWindowOpen ||
            agg.lastObservedSourceTimestamp >= agg.currentWindowClose ||
            agg.observedTimestamps.length === 0 ||
            agg.observedTimestamps[agg.observedTimestamps.length - 1] !== agg.lastObservedSourceTimestamp) {
            throw new Error(`V4 MTF State Integrity Error: ${config.timeframe} lastObservedSourceTimestamp inconsistent with forming window.`);
        }
        if (agg.actualSourceCount === 0) {
            if (agg.lastAcceptedSourceTimestamp !== null ||
                agg.runningOpen !== null || agg.runningHigh !== null || agg.runningLow !== null || agg.runningClose !== null ||
                agg.runningVolume !== 0) {
                throw new Error(`V4 MTF State Integrity Error: empty ${config.timeframe} forming window has non-null OHLCV.`);
            }
        } else {
            if (agg.lastAcceptedSourceTimestamp === null ||
                agg.lastAcceptedSourceTimestamp < agg.currentWindowOpen ||
                agg.lastAcceptedSourceTimestamp > agg.lastObservedSourceTimestamp ||
                agg.sourceTimestamps[agg.sourceTimestamps.length - 1] !== agg.lastAcceptedSourceTimestamp ||
                agg.runningOpen === null || !Number.isFinite(agg.runningOpen) || agg.runningOpen <= 0 ||
                agg.runningHigh === null || !Number.isFinite(agg.runningHigh) || agg.runningHigh <= 0 ||
                agg.runningLow === null || !Number.isFinite(agg.runningLow) || agg.runningLow <= 0 ||
                agg.runningClose === null || !Number.isFinite(agg.runningClose) || agg.runningClose <= 0 ||
                agg.runningHigh < agg.runningLow ||
                agg.runningHigh < Math.max(agg.runningOpen, agg.runningClose) ||
                agg.runningLow > Math.min(agg.runningOpen, agg.runningClose)) {
                throw new Error(`V4 MTF State Integrity Error: invalid ${config.timeframe} forming-window OHLCV or accepted watermark.`);
            }
        }
    }
    if (!state.featureEngineState || typeof state.featureEngineState !== 'object' || state.featureEngineState.stateVersion !== 6) {
        throw new Error(`V4 MTF State Integrity Error: missing or invalid V6 featureEngineState for ${config.timeframe}.`);
    }
    const expFp = computeML1ConfigV6Fingerprint(config.featureConfig);
    if (state.featureEngineState.configFingerprint !== expFp) {
        throw new Error(`V4 MTF State Integrity Error: ${config.timeframe} featureEngineState configFingerprint mismatch.`);
    }
    const v5State = (state.featureEngineState as any).v5State;
    if (!v5State || typeof v5State !== 'object' || v5State.stateVersion !== 5 ||
        !v5State.baseState || typeof v5State.baseState !== 'object' || v5State.baseState.stateVersion !== 4) {
        throw new Error(`V4 MTF State Integrity Error: corrupted nested v5State/baseState for ${config.timeframe}.`);
    }
    if (!state.latestFeatures || typeof state.latestFeatures !== 'object' || Array.isArray(state.latestFeatures) ||
        !state.latestValidity || typeof state.latestValidity !== 'object' || Array.isArray(state.latestValidity)) {
        throw new Error(`V4 MTF State Integrity Error: malformed latestFeatures/latestValidity containers for ${config.timeframe}.`);
    }

    if (agg.lastDiagnostic !== null) {
        validateV4Diagnostic(agg.lastDiagnostic, config);
    }

    const candle = agg.lastCompletedCandle;
    const feBase = v5State.baseState;
    if (candle === null) {
        if (state.lastCompletedBarIndex !== null ||
            Object.keys(state.latestFeatures).length !== 0 ||
            Object.keys(state.latestValidity).length !== 0 ||
            feBase.lastBarIndex !== null ||
            feBase.lastTimestamp !== null ||
            feBase.lastClose !== null) {
            throw new Error(
                `V4 MTF State Integrity Error: null ${config.timeframe} lastCompletedCandle requires clean reset feature state.`
            );
        }
    } else {
        validateV4CompletedCandle(candle, config);
        if (agg.lastDiagnostic !== null &&
            agg.lastDiagnostic.openTimestamp < candle.closeTimestamp &&
            agg.lastDiagnostic.closeTimestamp > candle.openTimestamp) {
            throw new Error(
                `V4 MTF State Integrity Error: ${config.timeframe} lastDiagnostic overlaps active lastCompletedCandle.`
            );
        }
        if (state.lastCompletedCandleOpenTimestamp !== candle.openTimestamp ||
            state.lastCompletedBarIndex === null ||
            !Number.isSafeInteger(state.lastCompletedBarIndex) ||
            state.lastCompletedBarIndex < 0) {
            throw new Error(`V4 MTF State Integrity Error: ${config.timeframe} aggregation/feature watermark mismatch.`);
        }
        if (feBase.lastBarIndex !== state.lastCompletedBarIndex ||
            feBase.lastTimestamp !== candle.openTimestamp ||
            feBase.lastClose !== candle.close) {
            throw new Error(`V4 MTF State Integrity Error: ${config.timeframe} featureEngineState watermark/close disagrees with candle.`);
        }

        const canonicalKeys = getCanonicalV4MTFFeatureKeys(config.featureConfig);
        const fKeys = Object.keys(state.latestFeatures);
        const vKeys = Object.keys(state.latestValidity);
        if (fKeys.length !== canonicalKeys.size || vKeys.length !== canonicalKeys.size) {
            throw new Error(
                `V4 MTF State Integrity Error: ${config.timeframe} feature/validity count (${fKeys.length}/${vKeys.length}) ` +
                `!= canonical (${canonicalKeys.size}).`
            );
        }
        for (const k of canonicalKeys) {
            if (!Object.prototype.hasOwnProperty.call(state.latestFeatures, k) ||
                !Object.prototype.hasOwnProperty.call(state.latestValidity, k)) {
                throw new Error(`V4 MTF State Integrity Error: ${config.timeframe} missing canonical key '${k}'.`);
            }
            if (typeof state.latestFeatures[k] !== 'number' || !Number.isFinite(state.latestFeatures[k])) {
                throw new Error(`V4 MTF State Integrity Error: ${config.timeframe} non-finite feature '${k}'.`);
            }
            if (typeof state.latestValidity[k] !== 'boolean') {
                throw new Error(`V4 MTF State Integrity Error: ${config.timeframe} non-boolean validity '${k}'.`);
            }
        }
    }
}

export function validateV4MTFState(
    state: V4MTFState,
    config: ValidatedV4MTFGlobalConfig
): void {
    if (!state || typeof state !== 'object' || state.stateVersion !== 2) {
        throw new Error(`V4 MTF State Integrity Error: expected stateVersion=2, got ${(state as any)?.stateVersion}.`);
    }
    if (!state.state3m || typeof state.state3m !== 'object' ||
        !state.state5m || typeof state.state5m !== 'object') {
        throw new Error('V4 MTF State Integrity Error: missing state3m or state5m container.');
    }
    if (state.last1mBarIndex !== null &&
        (!Number.isSafeInteger(state.last1mBarIndex) || state.last1mBarIndex < 0)) {
        throw new Error(`V4 MTF State Integrity Error: invalid last1mBarIndex (${String(state.last1mBarIndex)}).`);
    }
    if (state.last1mTimestamp !== null &&
        (!Number.isSafeInteger(state.last1mTimestamp) || state.last1mTimestamp < 0)) {
        throw new Error(`V4 MTF State Integrity Error: invalid last1mTimestamp (${String(state.last1mTimestamp)}).`);
    }
    if (state.last1mTimestamp === null && state.last1mBarIndex !== null) {
        throw new Error('V4 MTF State Integrity Error: last1mBarIndex cannot be populated when last1mTimestamp is null.');
    }

    validateV4MTFTimeframeState(state.state3m, config.config3m);
    validateV4MTFTimeframeState(state.state5m, config.config5m);

    if (state.last1mTimestamp === null) {
        if (state.state3m.aggregation.lastObservedSourceTimestamp !== null ||
            state.state5m.aggregation.lastObservedSourceTimestamp !== null) {
            throw new Error('V4 MTF State Integrity Error: HTF source observations cannot pre-date null last1mTimestamp.');
        }
    } else {
        for (const tfState of [state.state3m, state.state5m] as const) {
            const agg = tfState.aggregation;
            if (agg.lastObservedSourceTimestamp !== null && agg.lastObservedSourceTimestamp > state.last1mTimestamp) {
                throw new Error(
                    `V4 MTF State Integrity Error: ${tfState.timeframe} lastObservedSourceTimestamp exceeds last1mTimestamp.`
                );
            }
            if (agg.lastCompletedCandle !== null && agg.lastCompletedCandle.closeTimestamp > state.last1mTimestamp) {
                throw new Error(
                    `V4 MTF State Integrity Error: ${tfState.timeframe} lastCompletedCandle.closeTimestamp exceeds last1mTimestamp.`
                );
            }
            if (agg.lastDiagnostic !== null && agg.lastDiagnostic.closeTimestamp > state.last1mTimestamp) {
                throw new Error(
                    `V4 MTF State Integrity Error: ${tfState.timeframe} lastDiagnostic.closeTimestamp exceeds last1mTimestamp.`
                );
            }
        }
    }
}

