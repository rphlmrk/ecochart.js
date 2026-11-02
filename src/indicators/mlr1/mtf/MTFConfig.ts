import { ML1_CONFIG_A, ML1_CONFIG_B } from '../ML1FeatureConfigs';
import { validateML1Config } from '../ML1FeatureEngine';
import type { ValidatedML1FeatureConfig } from '../ML1FeatureTypes';
import type { SupportedMTFTimeframe } from './MTFTypes';

export interface MTFTimeframeConfig {
    readonly timeframe: SupportedMTFTimeframe;
    readonly durationMs: number;
    readonly alignment: 'UTC_HALF_OPEN';
    readonly expectedSourceIntervalMs: number;
    readonly gapPolicy: 'REJECT_AND_RESET';
    readonly maxStalenessMs?: number;
    readonly featureConfig: ValidatedML1FeatureConfig;
}

export interface MTFGlobalConfig {
    readonly symbol: string;
    readonly baseTimeframe: '1m';
    readonly config15m: MTFTimeframeConfig;
    readonly config1h: MTFTimeframeConfig;
}

declare const validatedMTFConfigBrand: unique symbol;

export type ValidatedMTFGlobalConfig = MTFGlobalConfig & {
    readonly [validatedMTFConfigBrand]: true;
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validates MTF configuration and returns an immutable, deeply frozen defensive copy.
 */
export function validateMTFConfig(rawConfig: unknown): ValidatedMTFGlobalConfig {
    if (!isRecord(rawConfig)) {
        throw new Error('MTF Configuration Error: rawConfig must be a valid object.');
    }
    if (typeof rawConfig.symbol !== 'string' || rawConfig.symbol.trim() === '') {
        throw new Error('MTF Configuration Error: symbol must be a non-empty string.');
    }
    if (rawConfig.baseTimeframe !== '1m') {
        throw new Error(`MTF Configuration Error: baseTimeframe must be strictly '1m', got '${rawConfig.baseTimeframe}'.`);
    }

    const validateTimeframeConfig = (
        rawTimeframeConfig: unknown,
        expectedTimeframe: SupportedMTFTimeframe,
        expectedDurationMs: number
    ): MTFTimeframeConfig => {
        if (!isRecord(rawTimeframeConfig)) {
            throw new Error(`MTF Configuration Error: config for ${expectedTimeframe} is missing or invalid.`);
        }
        if (rawTimeframeConfig.timeframe !== expectedTimeframe) {
            throw new Error(`MTF Configuration Error: timeframe identifier must be '${expectedTimeframe}', got '${rawTimeframeConfig.timeframe}'.`);
        }
        if (!Number.isSafeInteger(rawTimeframeConfig.durationMs) || rawTimeframeConfig.durationMs !== expectedDurationMs) {
            throw new Error(`MTF Configuration Error: ${expectedTimeframe} durationMs must be exactly ${expectedDurationMs}, got ${rawTimeframeConfig.durationMs}.`);
        }
        if (rawTimeframeConfig.alignment !== 'UTC_HALF_OPEN') {
            throw new Error(`MTF Configuration Error: alignment must be 'UTC_HALF_OPEN', got '${rawTimeframeConfig.alignment}'.`);
        }
        if (rawTimeframeConfig.expectedSourceIntervalMs !== 60_000) {
            throw new Error(`MTF Configuration Error: expectedSourceIntervalMs must be 60000, got ${rawTimeframeConfig.expectedSourceIntervalMs}.`);
        }
        if (!('gapPolicy' in rawTimeframeConfig) || rawTimeframeConfig.gapPolicy !== 'REJECT_AND_RESET') {
            throw new Error(`MTF Configuration Error: gapPolicy must be explicitly 'REJECT_AND_RESET', got '${rawTimeframeConfig.gapPolicy}'.`);
        }

        const maxStalenessMs = rawTimeframeConfig.maxStalenessMs;
        if (
            maxStalenessMs !== undefined &&
            (typeof maxStalenessMs !== 'number' || !Number.isSafeInteger(maxStalenessMs) || maxStalenessMs <= 0)
        ) {
            throw new Error(`MTF Configuration Error: maxStalenessMs must be a positive safe integer if defined, got ${maxStalenessMs}.`);
        }
        const rawFeatureConfig = rawTimeframeConfig.featureConfig;
        if (!isRecord(rawFeatureConfig)) {
            throw new Error(`MTF Configuration Error: featureConfig for ${expectedTimeframe} must be a valid ML1 configuration.`);
        }

        const rawGapThreshold = rawFeatureConfig.gapDiscontinuityThresholdMs;
        const featureConfig = validateML1Config({
            ...rawFeatureConfig,
            timeframe: expectedTimeframe,
            expectedIntervalMs: expectedDurationMs,
            gapDiscontinuityThresholdMs:
                typeof rawGapThreshold === 'number' && rawGapThreshold >= expectedDurationMs
                    ? rawGapThreshold
                    : expectedDurationMs * 5
        });
        const validatedConfig: MTFTimeframeConfig = {
            timeframe: expectedTimeframe,
            durationMs: expectedDurationMs,
            alignment: 'UTC_HALF_OPEN',
            expectedSourceIntervalMs: 60_000,
            gapPolicy: 'REJECT_AND_RESET',
            ...(maxStalenessMs === undefined ? {} : { maxStalenessMs }),
            featureConfig
        };
        return Object.freeze(validatedConfig);
    };

    const config15m = validateTimeframeConfig(rawConfig.config15m, '15m', 900_000);
    const config1h = validateTimeframeConfig(rawConfig.config1h, '1h', 3_600_000);

    return Object.freeze({
        symbol: rawConfig.symbol,
        baseTimeframe: '1m',
        config15m,
        config1h
    }) as ValidatedMTFGlobalConfig;
}

/**
 * Standard Profile A: EMA-ablated context on both higher timeframes.
 */
export const MTF_CONFIG_A: ValidatedMTFGlobalConfig = validateMTFConfig({
    symbol: 'SOLUSDT',
    baseTimeframe: '1m',
    config15m: {
        timeframe: '15m',
        durationMs: 900_000,
        alignment: 'UTC_HALF_OPEN',
        expectedSourceIntervalMs: 60_000,
        gapPolicy: 'REJECT_AND_RESET',
        featureConfig: ML1_CONFIG_A
    },
    config1h: {
        timeframe: '1h',
        durationMs: 3_600_000,
        alignment: 'UTC_HALF_OPEN',
        expectedSourceIntervalMs: 60_000,
        gapPolicy: 'REJECT_AND_RESET',
        featureConfig: ML1_CONFIG_A
    }
});

/**
 * Standard Profile B: full technical context, including EMA, on both timeframes.
 */
export const MTF_CONFIG_B: ValidatedMTFGlobalConfig = validateMTFConfig({
    symbol: 'SOLUSDT',
    baseTimeframe: '1m',
    config15m: {
        timeframe: '15m',
        durationMs: 900_000,
        alignment: 'UTC_HALF_OPEN',
        expectedSourceIntervalMs: 60_000,
        gapPolicy: 'REJECT_AND_RESET',
        featureConfig: ML1_CONFIG_B
    },
    config1h: {
        timeframe: '1h',
        durationMs: 3_600_000,
        alignment: 'UTC_HALF_OPEN',
        expectedSourceIntervalMs: 60_000,
        gapPolicy: 'REJECT_AND_RESET',
        featureConfig: ML1_CONFIG_B
    }
});
