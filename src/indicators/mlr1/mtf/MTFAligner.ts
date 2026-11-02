import type { MTFContext, MTFState, MTFTimeframeContext } from './MTFTypes';
import type { MTFTimeframeConfig, ValidatedMTFGlobalConfig } from './MTFConfig';
import { createMTFTimeframeContext, isHTFCandleAvailableAt } from './MTFState';

/**
 * Aligns one higher-timeframe state to a 1m observation without exposing future data.
 */
export function alignTimeframeContext(
    observationTimestamp: number,
    timeframeState: MTFState['state15m'] | MTFState['state1h'],
    config: MTFTimeframeConfig
): MTFTimeframeContext {
    const candle = timeframeState.aggregation.lastCompletedCandle;

    if (!candle || !isHTFCandleAvailableAt(observationTimestamp, candle.closeTimestamp)) {
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
 * Aligns independent 15m and 1h contexts onto a single 1m observation.
 */
export function alignMTFContext(
    observationTimestamp: number,
    symbol: string,
    mtfState: MTFState,
    config: ValidatedMTFGlobalConfig
): MTFContext {
    if (!Number.isSafeInteger(observationTimestamp) || observationTimestamp < 0) {
        throw new Error(`MTF Alignment Error: Invalid observation timestamp ${observationTimestamp}`);
    }

    return Object.freeze({
        observationTimestamp,
        symbol,
        context15m: alignTimeframeContext(observationTimestamp, mtfState.state15m, config.config15m),
        context1h: alignTimeframeContext(observationTimestamp, mtfState.state1h, config.config1h)
    });
}
