import { validateML1Config } from './ML1FeatureEngine';
import type { ValidatedML1FeatureConfig } from './ML1FeatureTypes';

/**
 * ML-R1 Phase 2J — frozen configuration profiles.
 *
 * Both profiles use the same instrument, timeframe, interval, gap policy,
 * ATR, rolling-range, momentum, and volume periods.
 *
 * The sole ablation dimension is EMA context:
 *   A: emaPeriods = []
 *   B: emaPeriods = [9, 20, 50, 100, 200]
 *
 * validateML1Config() makes a defensive copy, freezes every period array,
 * and freezes the resulting configuration object.
 *
 * IMPORTANT:
 * - The Milestone 2 README identifies SOLUSDT 1m as the dataset contract.
 * - Do not change symbol/timeframe here independently of the project README.
 * - These profiles configure the feature engine; they do not create datasets
 *   or perform training, prediction, or trading.
 */

const COMMON_CONFIG = {
    symbol: 'SOLUSDT',
    timeframe: '1m',
    expectedIntervalMs: 60_000,
    gapDiscontinuityThresholdMs: 300_000,

    atrPeriods: [14, 20],
    rollingRangePeriods: [5, 10, 20, 50],
    momentumPeriods: [3, 5, 10, 20],
    volumeSmaPeriods: [10, 20, 50]
} as const;

/**
 * CONFIGURATION A — Baseline Technical Context (EMA Ablated)
 *
 * Contains candle anatomy, volatility, rolling-range, momentum,
 * volume, temporal, and data-quality context.
 * EMA state and EMA-derived feature outputs are disabled.
 */
export const ML1_CONFIG_A: ValidatedML1FeatureConfig = validateML1Config({
    ...COMMON_CONFIG,
    emaPeriods: []
});

/**
 * CONFIGURATION B — Full Technical Context (EMA Included)
 *
 * Identical to Configuration A except for the addition of EMA periods.
 * The engine emits normalized EMA distances, EMA slopes, and adjacent
 * pairwise EMA relationships. Raw EMA price levels remain internal state.
 */
export const ML1_CONFIG_B: ValidatedML1FeatureConfig = validateML1Config({
    ...COMMON_CONFIG,
    emaPeriods: [9, 20, 50, 100, 200]
});

/**
 * Optional named registry for downstream code that needs to iterate
 * over the two approved profiles without reconstructing configuration.
 */
export const ML1_FEATURE_CONFIGS = Object.freeze({
    A: ML1_CONFIG_A,
    B: ML1_CONFIG_B
});
