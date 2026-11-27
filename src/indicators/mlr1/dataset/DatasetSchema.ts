/**
 * 🔒 V3 SCHEMA CONTRACT
 * Enforces MTF allowlists, V3 model-input schema versions,
 * and strict quarantining of Tier C outcomes.
 */

// Deep MTF Schema Enforcement: Strictly matches HTFIncompleteDiagnostic from MTFTypes.ts
export const HTF_DIAGNOSTIC_ALLOWLIST = [
    'timeframe',
    'openTimestamp',
    'closeTimestamp',
    'expectedSourceCount',
    'actualSourceCount',
    'missingTimestamps',
    'duplicateCount',
    'invalidSourceCount',
    'completeness'
] as const;

// Nested MTF Schema Enforcement: Strictly matches MTFTimeframeContext from MTFTypes.ts
export const MTF_CONTEXT_ALLOWLIST = [
    'timeframe',
    'lastCompletedCandle',
    'lastCompletedOpenTimestamp',
    'lastCompletedCloseTimestamp',
    'contextAgeMs',
    'isAvailable',
    'availabilityStatus',
    'isWarmupComplete',
    'features',
    'validity'
] as const;

// Deep MTF Schema Enforcement: Strictly matches MTFCandle from MTFTypes.ts
export const MTF_COMPLETED_CANDLE_ALLOWLIST = [
    'timeframe',
    'openTimestamp',
    'closeTimestamp',
    'open',
    'high',
    'low',
    'close',
    'volume',
    'sourceObservationCount',
    'completeness'
] as const;

export const TIER_C_QUARANTINE_LIST = [
    'outcomeDefinition',
    'horizonBars',
    'horizonEndTimestamp',
    'horizon_start_timestamp',
    'horizon_end_timestamp',
    'forwardReturns',
    'forward_returns',
    'MFE',
    'MAE',
    'maximumFavorableExcursion',
    'maximumAdverseExcursion',
    'maturityStatus',
    'maturity',
    'is_mature',
    'isOutcomeValid',
    'outcome_valid',
    'outcomeCompletionTimestamp',
    'outcome_completion_timestamp',
    'exit_price',
    'net_r',
    'outcome_class',
    'barrier_result',
    'barrier_results',
    'execution_result',
    'execution_results',
    'entry_bar_index',
    'entry_time',
    'entry_price',
    'atr_at_confirmation',
    'long_stop_price',
    'long_target_price',
    'long_exit_price',
    'long_net_r',
    'long_outcome',
    'short_stop_price',
    'short_target_price',
    'short_exit_price',
    'short_net_r',
    'short_outcome'
] as const;

// =========================================================================
// V3 Multi-Teacher Schema Constants (15m-Only MTF + 60/120/180 Horizons)
// =========================================================================

export const MLR1_V3_REPRESENTATION_SCHEMA_VERSION = 'MLR1_REPRESENTATION_V3';
export const MLR1_V3_MODEL_INPUT_SCHEMA_VERSION = 'MLR1_MODEL_INPUT_V3';

export const TIER_A_V3_CONTINUOUS_MTF_COLUMNS = [
    'context15m',
    'htf15mDiagnostic'
] as const;

export const TIER_C_V3_QUARANTINE_LIST = [
    ...TIER_C_QUARANTINE_LIST,
    'long_exit_price_60', 'long_net_r_60', 'long_outcome_60',
    'short_exit_price_60', 'short_net_r_60', 'short_outcome_60',
    'long_exit_price_120', 'long_net_r_120', 'long_outcome_120',
    'short_exit_price_120', 'short_net_r_120', 'short_outcome_120',
    'long_exit_price_180', 'long_net_r_180', 'long_outcome_180',
    'short_exit_price_180', 'short_net_r_180', 'short_outcome_180'
] as const;

// =========================================================================
// V4 Multi-Teacher Schema Constants (3m & 5m MTF + 60/120/180 Horizons)
// =========================================================================

export const MLR1_V4_REPRESENTATION_SCHEMA_VERSION = 'MLR1_REPRESENTATION_V4';
export const MLR1_V4_MODEL_INPUT_SCHEMA_VERSION = 'MLR1_MODEL_INPUT_V4';

export const TIER_A_V4_CONTINUOUS_MTF_COLUMNS = [
    'context3m',
    'htf3mDiagnostic',
    'context5m',
    'htf5mDiagnostic'
] as const;

export const TIER_C_V4_QUARANTINE_LIST = TIER_C_V3_QUARANTINE_LIST;
