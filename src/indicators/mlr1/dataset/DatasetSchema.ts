/**
 * 🔒 FROZEN SCHEMA CONTRACT
 * Enforces explicit whitelisting of Tier A inputs, structural boundaries for Tier B,
 * and strict quarantining of Tier C outcomes.
 */

/**
 * Source OHLCV is preserved for auditing and reconstruction,
 * but explicitly separated from the normalized ML tensor inputs.
 */
export const AUDIT_ONLY_ALLOWLIST = [
    'sourceOHLCV'
] as const;

export const TIER_A_ALLOWLIST = [
    'observationId',
    'sourceTimestamp',
    'observationTimestamp',
    'symbol',
    'timeframe',
    'dataQuality',
    'tierAFeatures',
    'tierAValidity',
    'context15m',
    'context1h',
    'htf15mDiagnostic',
    'htf1hDiagnostic'
] as const;

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

// Tier B Schema Enforcement: Strictly matches StrictCBCCandleTeacher from StrictCBCZigZagIndicator.ts
// (Plus structuralEventId for relational tracking)
export const TIER_B_ALLOWLIST = [
    'structuralEventId',
    'barIndex',
    'timestamp',
    'trend',
    'anchorHigh',
    'anchorLow',
    'candidateType',
    'candidatePrice',
    'candidateBarIndex',
    'candidateAgeBars',
    'confirmedPivotEvent',
    'confirmedPivotId',
    'confirmedPivotPrice',
    'confirmedPivotBarIndex',
    'confirmedPivotConfirmedBarIndex',
    'confirmedPivotLabel',
    'confirmedPivotLagBars'
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
