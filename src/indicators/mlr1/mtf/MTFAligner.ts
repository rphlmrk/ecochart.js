import type {
    MTFTimeframeContext,
    MTFContext,
    MTFState,
    V4MTFTimeframeContext,
    V4MTFContext,
    V4MTFState
} from './MTFTypes';
import type {
    ValidatedMTFGlobalConfig,
    MTFTimeframeConfig,
    ValidatedV4MTFGlobalConfig,
    V4MTFTimeframeConfig
} from './MTFConfig';
import {
    createMTFTimeframeContext,
    createV4MTFTimeframeContext,
    isHTFCandleAvailableAt,
    validateV4MTFTimeframeState,
    validateV4MTFState
} from './MTFState';

/**
 * Validates that an observation timestamp is a safe, non-negative integer.
 */
export function validateObservationTimestamp(timestamp: number): void {
    if (
        !Number.isSafeInteger(timestamp) ||
        timestamp < 0 ||
        timestamp > Number.MAX_SAFE_INTEGER
    ) {
        throw new Error(`MTF Alignment Error: Invalid observation timestamp ${timestamp}`);
    }
}

/**
 * Pure causal alignment of one timeframe's context onto a 1m observation.
 *
 * Completed candles are exposed only at or after their exclusive close boundary.
 * Feature warm-up and context availability remain separate dimensions.
 */
export function alignTimeframeContext(
    observationTimestamp: number,
    timeframeState: MTFState['state15m'] | MTFState['state1h'],
    config: MTFTimeframeConfig
): MTFTimeframeContext {
    validateObservationTimestamp(observationTimestamp);

    const candle = timeframeState.aggregation.lastCompletedCandle;
    if (!candle) {
        return createMTFTimeframeContext(
            config.timeframe,
            null,
            observationTimestamp,
            false,
            false,
            Object.freeze({}),
            Object.freeze({}),
            config.maxStalenessMs
        );
    }

    if (
        candle.completeness !== 'COMPLETE' ||
        candle.timeframe !== config.timeframe ||
        !Number.isSafeInteger(candle.openTimestamp) ||
        !Number.isSafeInteger(candle.closeTimestamp) ||
        candle.closeTimestamp <= candle.openTimestamp
    ) {
        throw new Error('MTF Alignment Error: Invalid completed HTF candle in timeframe state');
    }

    if (timeframeState.lastCompletedCandleOpenTimestamp !== candle.openTimestamp) {
        throw new Error(
            `MTF Alignment Error: State inconsistency. Aggregation candle open (${candle.openTimestamp}) does not match feature engine watermark (${timeframeState.lastCompletedCandleOpenTimestamp})`
        );
    }

    if (!isHTFCandleAvailableAt(observationTimestamp, candle.closeTimestamp)) {
        return createMTFTimeframeContext(
            config.timeframe,
            null,
            observationTimestamp,
            false,
            false,
            Object.freeze({}),
            Object.freeze({}),
            config.maxStalenessMs
        );
    }

    const isWarmupComplete = timeframeState.latestFeatures['IsWarmupComplete'] === 1;
    return createMTFTimeframeContext(
        config.timeframe,
        candle,
        observationTimestamp,
        true,
        isWarmupComplete,
        timeframeState.latestFeatures,
        timeframeState.latestValidity,
        config.maxStalenessMs
    );
}

/**
 * Aligns completed 15m and 1h context onto a 1m observation independently.
 */
export function alignMTFContext(
    observationTimestamp: number,
    symbol: string,
    mtfState: MTFState,
    config: ValidatedMTFGlobalConfig
): MTFContext {
    validateObservationTimestamp(observationTimestamp);

    const context15m = alignTimeframeContext(
        observationTimestamp,
        mtfState.state15m,
        config.config15m
    );
    const context1h = alignTimeframeContext(
        observationTimestamp,
        mtfState.state1h,
        config.config1h
    );

    return Object.freeze({
        observationTimestamp,
        symbol,
        context15m,
        context1h
    });
}

// =========================================================================
// V4 MTF Causal Aligner (3m & 5m)
// =========================================================================
export function alignV4TimeframeContext(
    observationTimestamp: number,
    timeframeState: V4MTFState['state3m'] | V4MTFState['state5m'],
    config: V4MTFTimeframeConfig
): V4MTFTimeframeContext {
    validateObservationTimestamp(observationTimestamp);
    validateV4MTFTimeframeState(timeframeState, config);

    const candle = timeframeState.aggregation.lastCompletedCandle;
    const diag = timeframeState.aggregation.lastDiagnostic;
    if (!candle || (diag !== null && diag.closeTimestamp > candle.openTimestamp)) {
        return createV4MTFTimeframeContext(
            config.timeframe,
            null,
            observationTimestamp,
            false,
            false,
            Object.freeze({}),
            Object.freeze({}),
            config.maxStalenessMs
        );
    }

    if (!isHTFCandleAvailableAt(observationTimestamp, candle.closeTimestamp)) {
        return createV4MTFTimeframeContext(
            config.timeframe,
            null,
            observationTimestamp,
            false,
            false,
            Object.freeze({}),
            Object.freeze({}),
            config.maxStalenessMs
        );
    }

    const isWarmupComplete = timeframeState.latestFeatures['IsWarmupComplete'] === 1;
    return createV4MTFTimeframeContext(
        config.timeframe,
        candle,
        observationTimestamp,
        true,
        isWarmupComplete,
        timeframeState.latestFeatures,
        timeframeState.latestValidity,
        config.maxStalenessMs
    );
}

export function alignV4MTFContext(
    observationTimestamp: number,
    symbol: string,
    mtfState: V4MTFState,
    config: ValidatedV4MTFGlobalConfig
): V4MTFContext {
    validateObservationTimestamp(observationTimestamp);
    if (symbol !== config.symbol ||
        config.config3m.featureConfig.symbol !== config.symbol ||
        config.config5m.featureConfig.symbol !== config.symbol) {
        throw new Error(
            `V4 MTF Alignment Error: symbol mismatch ('${symbol}' vs config '${config.symbol}').`
        );
    }
    validateV4MTFState(mtfState, config);

    const context3m = alignV4TimeframeContext(
        observationTimestamp,
        mtfState.state3m,
        config.config3m
    );
    const context5m = alignV4TimeframeContext(
        observationTimestamp,
        mtfState.state5m,
        config.config5m
    );

    return Object.freeze({
        observationTimestamp,
        symbol,
        context3m,
        context5m
    });
}

