import type { MTFTimeframeContext, MTFContext, MTFState } from './MTFTypes';
import type { ValidatedMTFGlobalConfig, MTFTimeframeConfig } from './MTFConfig';
import { createMTFTimeframeContext, isHTFCandleAvailableAt } from './MTFState';

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

    if (
        timeframeState.lastCompletedCandleOpenTimestamp !== null &&
        timeframeState.lastCompletedCandleOpenTimestamp !== candle.openTimestamp
    ) {
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
