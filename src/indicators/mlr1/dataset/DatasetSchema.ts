/**
 * 🔒 FROZEN SCHEMA CONTRACT
 * Enforces explicit whitelisting of Tier A inputs and strict quarantining of Tier C outcomes.
 */

export const TIER_A_ALLOWLIST = [
    'observationId',
    'sourceTimestamp',
    'observationTimestamp',
    'symbol',
    'timeframe',
    'sourceOHLCV',
    'tierAFeatures',
    'tierAValidity',
    'context15m',
    'context1h'
] as const;

export const TIER_C_QUARANTINE_LIST = [
    'outcomeDefinition',
    'forwardReturns',
    'maximumFavorableExcursion',
    'maximumAdverseExcursion',
    'maturityStatus',
    'isOutcomeValid',
    'outcomeCompletionTimestamp'
] as const;
