import { TIER_C_V4_QUARANTINE_LIST } from '../dataset/DatasetSchema';
import type { V3HorizonOutcomeClass, V3HorizonSnapshot } from './MultiHorizonOutcomeEngine';
import type { StrategyContextValue, StrategyEventType } from '../teachers/StrategyEventTypes';
import type { DTFXStrictCBCEventType } from '../teachers/DTFXStrictCBCTeacher';
import type { PHLV4TeacherEvent } from '../teachers/ProtectedHighsLowsTeacher';

export type V4PipelineStrategyId = 'STRICT_CBC' | 'PHL_BOS_MSS' | 'DTFX_STRICTCBC' | 'VAM_REVERSAL';
export type V4PipelineEventType = StrategyEventType | DTFXStrictCBCEventType | PHLV4TeacherEvent['eventType'];
export type V4PipelineContextValue = StrategyContextValue | null;

export interface V4PipelineStrategyEvent {
    readonly eventId: string;
    readonly eventDiscriminator: string;
    readonly strategyId: V4PipelineStrategyId;
    readonly strategyVersion: string;
    readonly eventType: V4PipelineEventType;
    readonly eventDirection: 'bull' | 'bear';
    readonly sourceBarIndex: number;
    readonly sourceTimestamp: number;
    readonly confirmationBarIndex: number;
    readonly confirmationTimestamp: number;
    readonly confirmationLagBars: number;
    readonly observationBarIndex: number;
    readonly observationTimestamp: number;
    readonly entryBarIndex: number;
    readonly entryTimestamp: number | null;
    readonly structuralContext: Readonly<Record<string, V4PipelineContextValue>>;
}

export const V4_FROZEN_TEACHERS = Object.freeze([
    'STRICT_CBC',
    'PHL_BOS_MSS',
    'DTFX_STRICTCBC',
    'VAM_REVERSAL'
] as const);

export const V4_TEACHER_VERSION = 'MULTI_TEACHER_CBC_PHL135_DTFX_STRICTCBC135_VAM_v2';
export const V4_DATASET_VERSION = 4;
export const V4_REPRESENTATION_SCHEMA_VERSION = 'MLR1_REPRESENTATION_V4';
export const V4_MODEL_INPUT_SCHEMA_VERSION = 'MLR1_MODEL_INPUT_V4';

// Explicit V4 Counterfactual Execution Contract (pinned independently of V3)
export const V4_HORIZONS = Object.freeze([60, 120, 180] as const);
export const V4_MAX_HORIZON_BARS = 180;
export const V4_STOP_ATR_MULT = 1.5;
export const V4_TARGET_R_MULT = 2.0;
export const V4_TRADE_COST_R = 0.05;
export const V4_OUTCOME_CONFIG_VERSION = 'MLR1_V4_H60_120_180_SL1.5ATR_RR2.0_COST0.05R';

export interface V4TierAAtConfirmation {
    readonly tierAObservationId: string;
    readonly atr14: number;
    readonly exhaustion14: number;
    readonly exhaustion14Valid: boolean;
    readonly exhaustion20: number;
    readonly exhaustion20Valid: boolean;
    readonly vcsRatio360: number;
    readonly vcsZScore360: number;
    readonly vcsRegime360: number;
    readonly vcsValid: boolean;
    readonly vamCenterDistAtr: number;
    readonly vamSlope3Atr: number;
    readonly vamEfficiency: number;
    readonly vamAdx14: number;
    readonly vamDiSpread14: number;
    readonly vamRsi14: number;
    readonly vamTrend: number;
    readonly vamValid: boolean;
    readonly sma20DistAtr: number;
    readonly sma50DistAtr: number;
    readonly sma200DistAtr: number;
    readonly sma20Above50: number;
    readonly sma50Above200: number;
    readonly smaValid: boolean;
    readonly macdLineAtr: number;
    readonly macdSignalAtr: number;
    readonly macdHistAtr: number;
    readonly macdValid: boolean;
    readonly bbWidth20: number;
    readonly bbPctB20: number;
    readonly bbValid: boolean;
    readonly context3mAvailable: boolean;
    readonly context3mStatus: string;
    readonly context5mAvailable: boolean;
    readonly context5mStatus: string;
}

export interface V4StrategyEventRow {
    readonly event_id: string;
    readonly event_discriminator: string;
    readonly strategy_id: string;
    readonly strategy_version: string;
    readonly symbol: string;
    readonly timeframe: string;
    readonly event_type: string;
    readonly event_direction: 'bull' | 'bear';
    readonly source_bar_index: number;
    readonly source_timestamp: number;
    readonly confirmation_bar_index: number;
    readonly confirmation_timestamp: number;
    readonly confirmation_lag_bars: number;
    readonly observation_bar_index: number;
    readonly observation_timestamp: number;
    readonly tierA_observation_id: string;
    readonly structural_context_json: string;

    readonly tierA_atr_14: number;
    readonly tierA_exhaustion_14: number;
    readonly tierA_exhaustion_14_valid: number;
    readonly tierA_exhaustion_20: number;
    readonly tierA_exhaustion_20_valid: number;
    readonly tierA_vcs_ratio_360: number;
    readonly tierA_vcs_zscore_360: number;
    readonly tierA_vcs_regime_360: number;
    readonly tierA_vcs_valid: number;
    readonly tierA_vam_center_dist_atr: number;
    readonly tierA_vam_slope_3_atr: number;
    readonly tierA_vam_efficiency: number;
    readonly tierA_vam_adx_14: number;
    readonly tierA_vam_di_spread_14: number;
    readonly tierA_vam_rsi_14: number;
    readonly tierA_vam_trend: number;
    readonly tierA_vam_valid: number;
    readonly tierA_sma_20_dist_atr: number;
    readonly tierA_sma_50_dist_atr: number;
    readonly tierA_sma_200_dist_atr: number;
    readonly tierA_sma_20_above_50: number;
    readonly tierA_sma_50_above_200: number;
    readonly tierA_sma_valid: number;
    readonly tierA_macd_line_atr: number;
    readonly tierA_macd_signal_atr: number;
    readonly tierA_macd_hist_atr: number;
    readonly tierA_macd_valid: number;
    readonly tierA_bb_width_20: number;
    readonly tierA_bb_pctb_20: number;
    readonly tierA_bb_valid: number;
    readonly tierA_context_3m_available: number;
    readonly tierA_context_3m_status: string;
    readonly tierA_context_5m_available: number;
    readonly tierA_context_5m_status: string;

    readonly entry_bar_index: number;
    readonly entry_time: number;
    readonly entry_price: number;
    readonly atr_at_confirmation: number;
    readonly long_stop_price: number;
    readonly long_target_price: number;
    readonly short_stop_price: number;
    readonly short_target_price: number;

    readonly long_exit_price_60: number;
    readonly long_net_r_60: number;
    readonly long_outcome_60: V3HorizonOutcomeClass;
    readonly short_exit_price_60: number;
    readonly short_net_r_60: number;
    readonly short_outcome_60: V3HorizonOutcomeClass;

    readonly long_exit_price_120: number;
    readonly long_net_r_120: number;
    readonly long_outcome_120: V3HorizonOutcomeClass;
    readonly short_exit_price_120: number;
    readonly short_net_r_120: number;
    readonly short_outcome_120: V3HorizonOutcomeClass;

    readonly long_exit_price_180: number;
    readonly long_net_r_180: number;
    readonly long_outcome_180: V3HorizonOutcomeClass;
    readonly short_exit_price_180: number;
    readonly short_net_r_180: number;
    readonly short_outcome_180: V3HorizonOutcomeClass;
}

export const V4_REPRESENTATION_COLUMNS = [
    'tierA_observation_id',
    'tierA_atr_14',
    'tierA_exhaustion_14',
    'tierA_exhaustion_14_valid',
    'tierA_exhaustion_20',
    'tierA_exhaustion_20_valid',
    'tierA_vcs_ratio_360',
    'tierA_vcs_zscore_360',
    'tierA_vcs_regime_360',
    'tierA_vcs_valid',
    'tierA_vam_center_dist_atr',
    'tierA_vam_slope_3_atr',
    'tierA_vam_efficiency',
    'tierA_vam_adx_14',
    'tierA_vam_di_spread_14',
    'tierA_vam_rsi_14',
    'tierA_vam_trend',
    'tierA_vam_valid',
    'tierA_sma_20_dist_atr',
    'tierA_sma_50_dist_atr',
    'tierA_sma_200_dist_atr',
    'tierA_sma_20_above_50',
    'tierA_sma_50_above_200',
    'tierA_sma_valid',
    'tierA_macd_line_atr',
    'tierA_macd_signal_atr',
    'tierA_macd_hist_atr',
    'tierA_macd_valid',
    'tierA_bb_width_20',
    'tierA_bb_pctb_20',
    'tierA_bb_valid',
    'tierA_context_3m_available',
    'tierA_context_3m_status',
    'tierA_context_5m_available',
    'tierA_context_5m_status',
    'tierB_event_id',
    'tierB_strategy_id',
    'tierB_strategy_version',
    'tierB_event_type',
    'tierB_event_direction',
    'tierB_event_discriminator',
    'tierB_source_bar_index',
    'tierB_confirmation_bar_index',
    'tierB_confirmation_lag_bars',
    'tierB_structural_context_json'
] as const;

export const V4_STRATEGY_EVENT_COLUMNS: readonly (keyof V4StrategyEventRow)[] = Object.freeze([
    'event_id',
    'event_discriminator',
    'strategy_id',
    'strategy_version',
    'symbol',
    'timeframe',
    'event_type',
    'event_direction',
    'source_bar_index',
    'source_timestamp',
    'confirmation_bar_index',
    'confirmation_timestamp',
    'confirmation_lag_bars',
    'observation_bar_index',
    'observation_timestamp',
    'tierA_observation_id',
    'structural_context_json',
    'tierA_atr_14',
    'tierA_exhaustion_14',
    'tierA_exhaustion_14_valid',
    'tierA_exhaustion_20',
    'tierA_exhaustion_20_valid',
    'tierA_vcs_ratio_360',
    'tierA_vcs_zscore_360',
    'tierA_vcs_regime_360',
    'tierA_vcs_valid',
    'tierA_vam_center_dist_atr',
    'tierA_vam_slope_3_atr',
    'tierA_vam_efficiency',
    'tierA_vam_adx_14',
    'tierA_vam_di_spread_14',
    'tierA_vam_rsi_14',
    'tierA_vam_trend',
    'tierA_vam_valid',
    'tierA_sma_20_dist_atr',
    'tierA_sma_50_dist_atr',
    'tierA_sma_200_dist_atr',
    'tierA_sma_20_above_50',
    'tierA_sma_50_above_200',
    'tierA_sma_valid',
    'tierA_macd_line_atr',
    'tierA_macd_signal_atr',
    'tierA_macd_hist_atr',
    'tierA_macd_valid',
    'tierA_bb_width_20',
    'tierA_bb_pctb_20',
    'tierA_bb_valid',
    'tierA_context_3m_available',
    'tierA_context_3m_status',
    'tierA_context_5m_available',
    'tierA_context_5m_status',
    'entry_bar_index',
    'entry_time',
    'entry_price',
    'atr_at_confirmation',
    'long_stop_price',
    'long_target_price',
    'short_stop_price',
    'short_target_price',
    'long_exit_price_60',
    'long_net_r_60',
    'long_outcome_60',
    'short_exit_price_60',
    'short_net_r_60',
    'short_outcome_60',
    'long_exit_price_120',
    'long_net_r_120',
    'long_outcome_120',
    'short_exit_price_120',
    'short_net_r_120',
    'short_outcome_120',
    'long_exit_price_180',
    'long_net_r_180',
    'long_outcome_180',
    'short_exit_price_180',
    'short_net_r_180',
    'short_outcome_180'
]);

export interface V4RepresentationRow {
    readonly tierA_observation_id: string;
    readonly tierA_atr_14: number;
    readonly tierA_exhaustion_14: number;
    readonly tierA_exhaustion_14_valid: number;
    readonly tierA_exhaustion_20: number;
    readonly tierA_exhaustion_20_valid: number;
    readonly tierA_vcs_ratio_360: number;
    readonly tierA_vcs_zscore_360: number;
    readonly tierA_vcs_regime_360: number;
    readonly tierA_vcs_valid: number;
    readonly tierA_vam_center_dist_atr: number;
    readonly tierA_vam_slope_3_atr: number;
    readonly tierA_vam_efficiency: number;
    readonly tierA_vam_adx_14: number;
    readonly tierA_vam_di_spread_14: number;
    readonly tierA_vam_rsi_14: number;
    readonly tierA_vam_trend: number;
    readonly tierA_vam_valid: number;
    readonly tierA_sma_20_dist_atr: number;
    readonly tierA_sma_50_dist_atr: number;
    readonly tierA_sma_200_dist_atr: number;
    readonly tierA_sma_20_above_50: number;
    readonly tierA_sma_50_above_200: number;
    readonly tierA_sma_valid: number;
    readonly tierA_macd_line_atr: number;
    readonly tierA_macd_signal_atr: number;
    readonly tierA_macd_hist_atr: number;
    readonly tierA_macd_valid: number;
    readonly tierA_bb_width_20: number;
    readonly tierA_bb_pctb_20: number;
    readonly tierA_bb_valid: number;
    readonly tierA_context_3m_available: number;
    readonly tierA_context_3m_status: string;
    readonly tierA_context_5m_available: number;
    readonly tierA_context_5m_status: string;
    readonly tierB_event_id: string;
    readonly tierB_strategy_id: string;
    readonly tierB_strategy_version: string;
    readonly tierB_event_type: string;
    readonly tierB_event_direction: 'bull' | 'bear';
    readonly tierB_event_discriminator: string;
    readonly tierB_source_bar_index: number;
    readonly tierB_confirmation_bar_index: number;
    readonly tierB_confirmation_lag_bars: number;
    readonly tierB_structural_context_json: string;
}

export const V4_STRUCTURAL_CONTEXT_ALLOWLIST: Readonly<Record<V4PipelineStrategyId, readonly string[]>> = Object.freeze({
    STRICT_CBC: Object.freeze([
        'pivotId',
        'pivotType',
        'pivotLabel',
        'pivotPrice',
        'hasPrevPivot',
        'prevPivotPrice',
        'barsSinceLastPivot',
        'legDistanceAtr'
    ]),
    PHL_BOS_MSS: Object.freeze([
        'phlTimeframe',
        'breakType',
        'brokenLevelPrice',
        'hasProtectedLevel',
        'protectedLevelPrice',
        'protectedLevelBarIndex',
        'protectedLevelTimestamp',
        'atr14Valid',
        'distToProtectedAtr',
        'pbFromLowValid',
        'pbFromHighValid'
    ]),
    DTFX_STRICTCBC: Object.freeze([
        'zoneTimeframe',
        'zoneId',
        'zoneStatus',
        'isChoch',
        'retestCount',
        'zoneCreatedSourceBarIndex',
        'zoneCreatedConfirmationBarIndex',
        'zoneTop',
        'zoneBot',
        'fib03',
        'fib05',
        'fib07',
        'atr14Valid',
        'zoneWidthAtr',
        'fib05DistAtr'
    ]),
    VAM_REVERSAL: Object.freeze([
        'vamTrendPostTransition',
        'centerDistAtr',
        'slope3Atr',
        'adx14',
        'diSpread14',
        'rsi14',
        'buyStreak',
        'sellStreak'
    ])
});

const PROHIBITED_TERMS = new Set([
    ...TIER_C_V4_QUARANTINE_LIST.map(k => k.toLowerCase()),
    'entry_bar_index', 'entry_time', 'entry_price', 'exit_price',
    'stop_price', 'target_price', 'net_r', 'outcome', 'forward', 'future', 'horizon', 'mfe', 'mae'
]);

const VALID_V4_HTF_TIMEFRAMES = new Set(['1m', '3m', '5m']);

export function assertV4RepresentationZeroTierCLeakage(columns: readonly string[]): void {
    if (columns.length !== V4_REPRESENTATION_COLUMNS.length ||
        columns.some((col, idx) => col !== V4_REPRESENTATION_COLUMNS[idx])) {
        throw new Error('V4 Representation Contract Error: column list differs from frozen V4_REPRESENTATION_COLUMNS.');
    }
    for (const col of columns) {
        const lower = col.toLowerCase();
        const stripped = lower.replace(/^tiera_|^tierb_/, '');
        if (PROHIBITED_TERMS.has(lower) || PROHIBITED_TERMS.has(stripped) ||
            /(^|_)(entry|exit|stop|target|net_r|outcome)(_|$)/.test(stripped)) {
            throw new Error(`V4 Leakage Error: forbidden Tier C field '${col}' detected.`);
        }
    }
}

export function serializeAndValidateV4StructuralContext(
    strategyId: V4PipelineStrategyId,
    structuralContext: Readonly<Record<string, unknown>>
): string {
    if (structuralContext === null || typeof structuralContext !== 'object' || Array.isArray(structuralContext)) {
        throw new Error('V4 Structural Context Error: structuralContext must be a non-null plain object.');
    }
    const proto = Object.getPrototypeOf(structuralContext);
    if (proto !== Object.prototype && proto !== null) {
        throw new Error('V4 Structural Context Error: structuralContext must have Object.prototype or null prototype.');
    }
    for (const rawKey of Reflect.ownKeys(structuralContext)) {
        if (typeof rawKey !== 'string') throw new Error('V4 Structural Context Error: symbol keys forbidden.');
        const desc = Object.getOwnPropertyDescriptor(structuralContext, rawKey);
        if (!desc || !('value' in desc) || !desc.enumerable) {
            throw new Error(`V4 Structural Context Error: property '${rawKey}' must be enumerable.`);
        }
    }

    const allowedKeys = V4_STRUCTURAL_CONTEXT_ALLOWLIST[strategyId];
    if (!allowedKeys) {
        throw new Error(`V4 Structural Context Error: unknown/retired strategyId '${String(strategyId)}'.`);
    }
    const allowedSet = new Set(allowedKeys);
    const ordered: Record<string, number | string | boolean | null> = {};

    for (const key of Object.keys(structuralContext).sort()) {
        const lower = key.toLowerCase();
        if (PROHIBITED_TERMS.has(lower) || /(entry|exit|stop|target|net_r|outcome|forward|future|horizon|mfe|mae)/.test(lower)) {
            throw new Error(`V4 Structural Context Leakage Error: prohibited key '${key}'.`);
        }
        if (!allowedSet.has(key)) {
            throw new Error(`V4 Structural Context Error: key '${key}' not allowlisted for '${strategyId}'.`);
        }
        const val = structuralContext[key];
        if (val === null) {
            const isNullableDtfx =
                strategyId === 'DTFX_STRICTCBC' &&
                (key === 'zoneWidthAtr' || key === 'fib05DistAtr') &&
                structuralContext['atr14Valid'] === false;
            const isNullablePhl =
                strategyId === 'PHL_BOS_MSS' &&
                ((key === 'protectedLevelPrice' || key === 'protectedLevelBarIndex' || key === 'protectedLevelTimestamp') &&
                    structuralContext['hasProtectedLevel'] === false ||
                    (key === 'distToProtectedAtr' &&
                        (structuralContext['hasProtectedLevel'] === false || structuralContext['atr14Valid'] === false)));
            if (!isNullableDtfx && !isNullablePhl) {
                throw new Error(`V4 Structural Context Error: null not permitted for '${key}' on '${strategyId}'.`);
            }
        } else if (typeof val === 'number') {
            if (!Number.isFinite(val)) throw new Error(`V4 Structural Context Error: non-finite number on '${key}'.`);
        } else if (typeof val !== 'string' && typeof val !== 'boolean') {
            throw new Error(`V4 Structural Context Error: unsupported type on '${key}'.`);
        }

        if (strategyId === 'DTFX_STRICTCBC' && key === 'zoneTimeframe' && !VALID_V4_HTF_TIMEFRAMES.has(String(val))) {
            throw new Error(`V4 Structural Context Error: invalid DTFX_STRICTCBC zoneTimeframe '${String(val)}' (15m excluded).`);
        }
        if (strategyId === 'PHL_BOS_MSS' && key === 'phlTimeframe' && !VALID_V4_HTF_TIMEFRAMES.has(String(val))) {
            throw new Error(`V4 Structural Context Error: invalid PHL_BOS_MSS phlTimeframe '${String(val)}'.`);
        }
        ordered[key] = val;
    }

    return JSON.stringify(ordered);
}

export function buildV4RepresentationRow(row: V4StrategyEventRow): V4RepresentationRow {
    return Object.freeze({
        tierA_observation_id: row.tierA_observation_id,
        tierA_atr_14: row.tierA_atr_14,
        tierA_exhaustion_14: row.tierA_exhaustion_14,
        tierA_exhaustion_14_valid: row.tierA_exhaustion_14_valid,
        tierA_exhaustion_20: row.tierA_exhaustion_20,
        tierA_exhaustion_20_valid: row.tierA_exhaustion_20_valid,
        tierA_vcs_ratio_360: row.tierA_vcs_ratio_360,
        tierA_vcs_zscore_360: row.tierA_vcs_zscore_360,
        tierA_vcs_regime_360: row.tierA_vcs_regime_360,
        tierA_vcs_valid: row.tierA_vcs_valid,
        tierA_vam_center_dist_atr: row.tierA_vam_center_dist_atr,
        tierA_vam_slope_3_atr: row.tierA_vam_slope_3_atr,
        tierA_vam_efficiency: row.tierA_vam_efficiency,
        tierA_vam_adx_14: row.tierA_vam_adx_14,
        tierA_vam_di_spread_14: row.tierA_vam_di_spread_14,
        tierA_vam_rsi_14: row.tierA_vam_rsi_14,
        tierA_vam_trend: row.tierA_vam_trend,
        tierA_vam_valid: row.tierA_vam_valid,
        tierA_sma_20_dist_atr: row.tierA_sma_20_dist_atr,
        tierA_sma_50_dist_atr: row.tierA_sma_50_dist_atr,
        tierA_sma_200_dist_atr: row.tierA_sma_200_dist_atr,
        tierA_sma_20_above_50: row.tierA_sma_20_above_50,
        tierA_sma_50_above_200: row.tierA_sma_50_above_200,
        tierA_sma_valid: row.tierA_sma_valid,
        tierA_macd_line_atr: row.tierA_macd_line_atr,
        tierA_macd_signal_atr: row.tierA_macd_signal_atr,
        tierA_macd_hist_atr: row.tierA_macd_hist_atr,
        tierA_macd_valid: row.tierA_macd_valid,
        tierA_bb_width_20: row.tierA_bb_width_20,
        tierA_bb_pctb_20: row.tierA_bb_pctb_20,
        tierA_bb_valid: row.tierA_bb_valid,
        tierA_context_3m_available: row.tierA_context_3m_available,
        tierA_context_3m_status: row.tierA_context_3m_status,
        tierA_context_5m_available: row.tierA_context_5m_available,
        tierA_context_5m_status: row.tierA_context_5m_status,
        tierB_event_id: row.event_id,
        tierB_strategy_id: row.strategy_id,
        tierB_strategy_version: row.strategy_version,
        tierB_event_type: row.event_type,
        tierB_event_direction: row.event_direction,
        tierB_event_discriminator: row.event_discriminator,
        tierB_source_bar_index: row.source_bar_index,
        tierB_confirmation_bar_index: row.confirmation_bar_index,
        tierB_confirmation_lag_bars: row.confirmation_lag_bars,
        tierB_structural_context_json: row.structural_context_json
    });
}

export function assertV4RepresentationRowZeroLeakage(row: V4RepresentationRow): void {
    assertV4RepresentationZeroTierCLeakage(Object.keys(row));
    let parsed: unknown;
    try {
        parsed = JSON.parse(row.tierB_structural_context_json);
    } catch {
        throw new Error('V4 Representation Leakage Error: invalid tierB_structural_context_json.');
    }
    serializeAndValidateV4StructuralContext(
        row.tierB_strategy_id as V4PipelineStrategyId,
        parsed as Record<string, unknown>
    );
}

interface PendingV4OutcomeEvent {
    readonly event: V4PipelineStrategyEvent;
    readonly symbol: string;
    readonly timeframe: string;
    readonly tierA: V4TierAAtConfirmation;
    readonly atrValid: boolean;
    readonly entryBar: number;
    readonly horizonEnd60: number;
    readonly horizonEnd120: number;
    readonly horizonEnd180: number;
    initialized: boolean;
    entryTime: number;
    entryPrice: number;
    lStop: number;
    lTarget: number;
    lRisk: number;
    sStop: number;
    sTarget: number;
    sRisk: number;
    lResolved: boolean;
    lBarrierExitPrice: number;
    lBarrierKind: 'hard_stop' | 'full_target';
    sResolved: boolean;
    sBarrierExitPrice: number;
    sBarrierKind: 'hard_stop' | 'full_target';
    lSnap60?: V3HorizonSnapshot;
    sSnap60?: V3HorizonSnapshot;
    lSnap120?: V3HorizonSnapshot;
    sSnap120?: V3HorizonSnapshot;
    lSnap180?: V3HorizonSnapshot;
    sSnap180?: V3HorizonSnapshot;
}

function finalizeSnapshot(
    isLong: boolean,
    resolved: boolean,
    barrierExitPrice: number,
    barrierKind: 'hard_stop' | 'full_target',
    barClose: number,
    entryPrice: number,
    risk: number
): V3HorizonSnapshot {
    const exitPrice = resolved ? barrierExitPrice : barClose;
    const grossR = isLong ? (exitPrice - entryPrice) / risk : (entryPrice - exitPrice) / risk;
    const netR = grossR - V4_TRADE_COST_R;
    const outcome: V3HorizonOutcomeClass = resolved ? barrierKind : netR > 0 ? 'timeout_net_gain' : 'timeout_net_loss';
    return Object.freeze({ exitPrice, netR, outcome });
}

export interface V4OutcomeAccounting {
    readonly totalCandidateEvents: number;
    readonly excludedMissingNextOpen: number;
    readonly excludedUnwarmedAtr: number;
    readonly excludedIncompleteHorizon: number;
    readonly eligibleEvents: number;
    readonly countsByStrategy: Readonly<Record<string, number>>;
    readonly countsByEventType: Readonly<Record<string, number>>;
}

const VALID_V4_STRATEGIES = new Set<string>(V4_FROZEN_TEACHERS);
const VALID_V4_AVAILABILITY = new Set<string>(['UNAVAILABLE', 'WARMING_UP', 'AVAILABLE_VALID', 'STALE']);
const VALID_V4_EVENT_TYPES_BY_STRATEGY: Readonly<Record<V4PipelineStrategyId, ReadonlySet<string>>> = Object.freeze({
    STRICT_CBC: new Set(['CBC_HIGH_HH', 'CBC_HIGH_LH', 'CBC_LOW_HL', 'CBC_LOW_LL']),
    PHL_BOS_MSS: new Set(['PHL_BOS_BULL', 'PHL_BOS_BEAR', 'PHL_MSS_BULL', 'PHL_MSS_BEAR']),
    DTFX_STRICTCBC: new Set(['DTFX_CBC_DEMAND_CREATED', 'DTFX_CBC_SUPPLY_CREATED', 'DTFX_CBC_DEMAND_RETEST', 'DTFX_CBC_SUPPLY_RETEST']),
    VAM_REVERSAL: new Set(['VAM_BUY', 'VAM_SELL'])
});
const TIER_A_V4_EXPECTED_KEYS = [
    'tierAObservationId', 'atr14',
    'exhaustion14', 'exhaustion14Valid', 'exhaustion20', 'exhaustion20Valid',
    'vcsRatio360', 'vcsZScore360', 'vcsRegime360', 'vcsValid',
    'vamCenterDistAtr', 'vamSlope3Atr', 'vamEfficiency', 'vamAdx14', 'vamDiSpread14', 'vamRsi14', 'vamTrend', 'vamValid',
    'sma20DistAtr', 'sma50DistAtr', 'sma200DistAtr', 'sma20Above50', 'sma50Above200', 'smaValid',
    'macdLineAtr', 'macdSignalAtr', 'macdHistAtr', 'macdValid',
    'bbWidth20', 'bbPctB20', 'bbValid',
    'context3mAvailable', 'context3mStatus', 'context5mAvailable', 'context5mStatus'
] as const;

function cmpAscii(a: string, b: string): number {
    return a < b ? -1 : a > b ? 1 : 0;
}

export class V4MultiHorizonOutcomeTracker {
    private readonly pending: PendingV4OutcomeEvent[] = [];
    private readonly seenEventIds = new Set<string>();
    private lastEnqueuedOrder: { confirmationBarIndex: number; strategyId: string; eventType: string; eventId: string } | null = null;
    private lastStepBarIndex: number | null = null;
    private lastStepBarTimestamp: number | null = null;
    private totalCandidates = 0;
    private excludedMissingNextOpen = 0;
    private excludedUnwarmedAtr = 0;
    private excludedIncompleteHorizon = 0;
    private eligibleCount = 0;
    private readonly countsByStrategy: Record<string, number> = {};
    private readonly countsByEventType: Record<string, number> = {};

    public getPendingCount(): number {
        return this.pending.length;
    }

    public getSeenEventIdCount(): number {
        return this.seenEventIds.size;
    }

    public getAccountingSnapshot(): V4OutcomeAccounting {
        return Object.freeze({
            totalCandidateEvents: this.totalCandidates,
            excludedMissingNextOpen: this.excludedMissingNextOpen,
            excludedUnwarmedAtr: this.excludedUnwarmedAtr,
            excludedIncompleteHorizon: this.excludedIncompleteHorizon,
            eligibleEvents: this.eligibleCount,
            countsByStrategy: Object.freeze({ ...this.countsByStrategy }),
            countsByEventType: Object.freeze({ ...this.countsByEventType })
        });
    }

    public stepBar(
        barIndex: number,
        candle: { readonly time: number; readonly open: number; readonly high: number; readonly low: number; readonly close: number }
    ): readonly V4StrategyEventRow[] {
        this.lastStepBarIndex = barIndex;
        this.lastStepBarTimestamp = candle.time;
        for (let idx = 0; idx < this.pending.length; idx++) {
            const ev = this.pending[idx];
            if (ev.entryBar === barIndex) {
                if (!ev.atrValid) {
                    this.excludedUnwarmedAtr++;
                    this.pending.splice(idx, 1);
                    idx--;
                    continue;
                }
                ev.initialized = true;
                ev.entryTime = candle.time;
                ev.entryPrice = candle.open;
                ev.lStop = ev.entryPrice - ev.tierA.atr14 * V4_STOP_ATR_MULT;
                ev.lTarget = ev.entryPrice + ev.tierA.atr14 * V4_STOP_ATR_MULT * V4_TARGET_R_MULT;
                ev.lRisk = ev.entryPrice - ev.lStop;
                ev.sStop = ev.entryPrice + ev.tierA.atr14 * V4_STOP_ATR_MULT;
                ev.sTarget = ev.entryPrice - ev.tierA.atr14 * V4_STOP_ATR_MULT * V4_TARGET_R_MULT;
                ev.sRisk = ev.sStop - ev.entryPrice;
            }
            if (ev.initialized) {
                if (!ev.lResolved) {
                    if (candle.open <= ev.lStop) { ev.lBarrierExitPrice = candle.open; ev.lBarrierKind = 'hard_stop'; ev.lResolved = true; }
                    else if (candle.open >= ev.lTarget) { ev.lBarrierExitPrice = candle.open; ev.lBarrierKind = 'full_target'; ev.lResolved = true; }
                    else if (candle.low <= ev.lStop) { ev.lBarrierExitPrice = ev.lStop; ev.lBarrierKind = 'hard_stop'; ev.lResolved = true; }
                    else if (candle.high >= ev.lTarget) { ev.lBarrierExitPrice = ev.lTarget; ev.lBarrierKind = 'full_target'; ev.lResolved = true; }
                }
                if (!ev.sResolved) {
                    if (candle.open >= ev.sStop) { ev.sBarrierExitPrice = candle.open; ev.sBarrierKind = 'hard_stop'; ev.sResolved = true; }
                    else if (candle.open <= ev.sTarget) { ev.sBarrierExitPrice = candle.open; ev.sBarrierKind = 'full_target'; ev.sResolved = true; }
                    else if (candle.high >= ev.sStop) { ev.sBarrierExitPrice = ev.sStop; ev.sBarrierKind = 'hard_stop'; ev.sResolved = true; }
                    else if (candle.low <= ev.sTarget) { ev.sBarrierExitPrice = ev.sTarget; ev.sBarrierKind = 'full_target'; ev.sResolved = true; }
                }
                if (barIndex === ev.horizonEnd60) {
                    ev.lSnap60 = finalizeSnapshot(true, ev.lResolved, ev.lBarrierExitPrice, ev.lBarrierKind, candle.close, ev.entryPrice, ev.lRisk);
                    ev.sSnap60 = finalizeSnapshot(false, ev.sResolved, ev.sBarrierExitPrice, ev.sBarrierKind, candle.close, ev.entryPrice, ev.sRisk);
                }
                if (barIndex === ev.horizonEnd120) {
                    ev.lSnap120 = finalizeSnapshot(true, ev.lResolved, ev.lBarrierExitPrice, ev.lBarrierKind, candle.close, ev.entryPrice, ev.lRisk);
                    ev.sSnap120 = finalizeSnapshot(false, ev.sResolved, ev.sBarrierExitPrice, ev.sBarrierKind, candle.close, ev.entryPrice, ev.sRisk);
                }
                if (barIndex === ev.horizonEnd180) {
                    ev.lSnap180 = finalizeSnapshot(true, ev.lResolved, ev.lBarrierExitPrice, ev.lBarrierKind, candle.close, ev.entryPrice, ev.lRisk);
                    ev.sSnap180 = finalizeSnapshot(false, ev.sResolved, ev.sBarrierExitPrice, ev.sBarrierKind, candle.close, ev.entryPrice, ev.sRisk);
                }
            }
        }

        const completed: V4StrategyEventRow[] = [];
        while (this.pending.length > 0 && this.pending[0].horizonEnd180 === barIndex) {
            const done = this.pending.shift()!;
            if (!done.lSnap60 || !done.sSnap60 || !done.lSnap120 || !done.sSnap120 || !done.lSnap180 || !done.sSnap180) {
                throw new Error(`V4MultiHorizonOutcomeTracker Error: incomplete snapshots for '${done.event.eventId}'.`);
            }
            const ev = done.event;
            const row: V4StrategyEventRow = Object.freeze({
                event_id: ev.eventId,
                event_discriminator: ev.eventDiscriminator,
                strategy_id: ev.strategyId,
                strategy_version: ev.strategyVersion,
                symbol: done.symbol,
                timeframe: done.timeframe,
                event_type: ev.eventType,
                event_direction: ev.eventDirection,
                source_bar_index: ev.sourceBarIndex,
                source_timestamp: ev.sourceTimestamp,
                confirmation_bar_index: ev.confirmationBarIndex,
                confirmation_timestamp: ev.confirmationTimestamp,
                confirmation_lag_bars: ev.confirmationLagBars,
                observation_bar_index: ev.observationBarIndex,
                observation_timestamp: ev.observationTimestamp,
                tierA_observation_id: done.tierA.tierAObservationId,
                structural_context_json: serializeAndValidateV4StructuralContext(ev.strategyId, ev.structuralContext),

                tierA_atr_14: done.tierA.atr14,
                tierA_exhaustion_14: done.tierA.exhaustion14,
                tierA_exhaustion_14_valid: done.tierA.exhaustion14Valid ? 1 : 0,
                tierA_exhaustion_20: done.tierA.exhaustion20,
                tierA_exhaustion_20_valid: done.tierA.exhaustion20Valid ? 1 : 0,
                tierA_vcs_ratio_360: done.tierA.vcsRatio360,
                tierA_vcs_zscore_360: done.tierA.vcsZScore360,
                tierA_vcs_regime_360: done.tierA.vcsRegime360,
                tierA_vcs_valid: done.tierA.vcsValid ? 1 : 0,
                tierA_vam_center_dist_atr: done.tierA.vamCenterDistAtr,
                tierA_vam_slope_3_atr: done.tierA.vamSlope3Atr,
                tierA_vam_efficiency: done.tierA.vamEfficiency,
                tierA_vam_adx_14: done.tierA.vamAdx14,
                tierA_vam_di_spread_14: done.tierA.vamDiSpread14,
                tierA_vam_rsi_14: done.tierA.vamRsi14,
                tierA_vam_trend: done.tierA.vamTrend,
                tierA_vam_valid: done.tierA.vamValid ? 1 : 0,
                tierA_sma_20_dist_atr: done.tierA.sma20DistAtr,
                tierA_sma_50_dist_atr: done.tierA.sma50DistAtr,
                tierA_sma_200_dist_atr: done.tierA.sma200DistAtr,
                tierA_sma_20_above_50: done.tierA.sma20Above50,
                tierA_sma_50_above_200: done.tierA.sma50Above200,
                tierA_sma_valid: done.tierA.smaValid ? 1 : 0,
                tierA_macd_line_atr: done.tierA.macdLineAtr,
                tierA_macd_signal_atr: done.tierA.macdSignalAtr,
                tierA_macd_hist_atr: done.tierA.macdHistAtr,
                tierA_macd_valid: done.tierA.macdValid ? 1 : 0,
                tierA_bb_width_20: done.tierA.bbWidth20,
                tierA_bb_pctb_20: done.tierA.bbPctB20,
                tierA_bb_valid: done.tierA.bbValid ? 1 : 0,
                tierA_context_3m_available: done.tierA.context3mAvailable ? 1 : 0,
                tierA_context_3m_status: done.tierA.context3mStatus,
                tierA_context_5m_available: done.tierA.context5mAvailable ? 1 : 0,
                tierA_context_5m_status: done.tierA.context5mStatus,

                entry_bar_index: done.entryBar,
                entry_time: done.entryTime,
                entry_price: done.entryPrice,
                atr_at_confirmation: done.tierA.atr14,
                long_stop_price: done.lStop,
                long_target_price: done.lTarget,
                short_stop_price: done.sStop,
                short_target_price: done.sTarget,

                long_exit_price_60: done.lSnap60.exitPrice,
                long_net_r_60: done.lSnap60.netR,
                long_outcome_60: done.lSnap60.outcome,
                short_exit_price_60: done.sSnap60.exitPrice,
                short_net_r_60: done.sSnap60.netR,
                short_outcome_60: done.sSnap60.outcome,

                long_exit_price_120: done.lSnap120.exitPrice,
                long_net_r_120: done.lSnap120.netR,
                long_outcome_120: done.lSnap120.outcome,
                short_exit_price_120: done.sSnap120.exitPrice,
                short_net_r_120: done.sSnap120.netR,
                short_outcome_120: done.sSnap120.outcome,

                long_exit_price_180: done.lSnap180.exitPrice,
                long_net_r_180: done.lSnap180.netR,
                long_outcome_180: done.lSnap180.outcome,
                short_exit_price_180: done.sSnap180.exitPrice,
                short_net_r_180: done.sSnap180.netR,
                short_outcome_180: done.sSnap180.outcome
            });

            completed.push(row);
            this.eligibleCount++;
            this.countsByStrategy[ev.strategyId] = (this.countsByStrategy[ev.strategyId] ?? 0) + 1;
            this.countsByEventType[ev.eventType] = (this.countsByEventType[ev.eventType] ?? 0) + 1;
        }
        return Object.freeze(completed);
    }

    public enqueueEvents(
        sortedBarEvents: readonly V4PipelineStrategyEvent[],
        symbol: string,
        timeframe: string,
        tierA: V4TierAAtConfirmation,
        atrValid: boolean
    ): void {
        if (!Array.isArray(sortedBarEvents as unknown)) {
            throw new Error('V4 Outcome Contract Error: sortedBarEvents must be an array.');
        }
        if (typeof symbol !== 'string' || symbol.trim().length === 0 || timeframe !== '1m') {
            throw new Error(`V4 Outcome Contract Error: invalid symbol '${String(symbol)}' or non-1m timeframe '${String(timeframe)}'.`);
        }
        if (typeof atrValid !== 'boolean') {
            throw new Error('V4 Outcome Contract Error: atrValid must be a boolean.');
        }
        if (!tierA || typeof tierA !== 'object' || Array.isArray(tierA)) {
            throw new Error('V4 Outcome Contract Error: tierA snapshot must be a plain object.');
        }
        const tierAKeys = Object.keys(tierA);
        if (tierAKeys.length !== TIER_A_V4_EXPECTED_KEYS.length ||
            TIER_A_V4_EXPECTED_KEYS.some(k => !Object.prototype.hasOwnProperty.call(tierA, k))) {
            throw new Error('V4 Outcome Contract Error: tierA snapshot does not match exact 35-key allowlist.');
        }
        if (typeof tierA.tierAObservationId !== 'string' || tierA.tierAObservationId.trim().length === 0) {
            throw new Error('V4 Outcome Contract Error: invalid tierAObservationId.');
        }
        for (const numVal of [
            tierA.atr14, tierA.exhaustion14, tierA.exhaustion20,
            tierA.vcsRatio360, tierA.vcsZScore360, tierA.vcsRegime360,
            tierA.vamCenterDistAtr, tierA.vamSlope3Atr, tierA.vamEfficiency,
            tierA.vamAdx14, tierA.vamDiSpread14, tierA.vamRsi14, tierA.vamTrend,
            tierA.sma20DistAtr, tierA.sma50DistAtr, tierA.sma200DistAtr,
            tierA.sma20Above50, tierA.sma50Above200,
            tierA.macdLineAtr, tierA.macdSignalAtr, tierA.macdHistAtr,
            tierA.bbWidth20, tierA.bbPctB20
        ]) {
            if (typeof numVal !== 'number' || !Number.isFinite(numVal)) {
                throw new Error('V4 Outcome Contract Error: non-finite numeric field in tierA snapshot.');
            }
        }
        if (atrValid && tierA.atr14 <= 0) {
            throw new Error('V4 Outcome Contract Error: atrValid=true requires tierA.atr14 > 0.');
        }
        for (const boolVal of [
            tierA.exhaustion14Valid, tierA.exhaustion20Valid, tierA.vcsValid,
            tierA.vamValid, tierA.smaValid, tierA.macdValid, tierA.bbValid,
            tierA.context3mAvailable, tierA.context5mAvailable
        ]) {
            if (typeof boolVal !== 'boolean') {
                throw new Error('V4 Outcome Contract Error: validity flags in tierA snapshot must be booleans.');
            }
        }
        if (!VALID_V4_AVAILABILITY.has(tierA.context3mStatus) ||
            !VALID_V4_AVAILABILITY.has(tierA.context5mStatus)) {
            throw new Error('V4 Outcome Contract Error: invalid MTF availability status in tierA snapshot.');
        }
        const exp3mAvail = tierA.context3mStatus === 'WARMING_UP' || tierA.context3mStatus === 'AVAILABLE_VALID';
        const exp5mAvail = tierA.context5mStatus === 'WARMING_UP' || tierA.context5mStatus === 'AVAILABLE_VALID';
        if (tierA.context3mAvailable !== exp3mAvail || tierA.context5mAvailable !== exp5mAvail) {
            throw new Error('V4 Outcome Contract Error: tierA context availability flag disagrees with status.');
        }

        // Freeze an immutable copy of tierA so caller mutation post-enqueue cannot alter stored outcomes
        const frozenTierA: V4TierAAtConfirmation = Object.freeze({ ...tierA });

        // Atomic pre-validation pass BEFORE mutating totalCandidates, seenEventIds, or pending
        const intervalMs = 60_000;
        const batchEventIds = new Set<string>();
        let simLastOrder = this.lastEnqueuedOrder;
        const preparedPending: PendingV4OutcomeEvent[] = [];

        for (const ev of sortedBarEvents) {
            if (!ev || typeof ev !== 'object') {
                throw new Error('V4 Outcome Contract Error: null/malformed event.');
            }
            if (typeof ev.eventId !== 'string' || ev.eventId.trim().length === 0 || /[\r\n\0]/.test(ev.eventId) ||
                typeof ev.eventDiscriminator !== 'string' || ev.eventDiscriminator.trim().length === 0 || /[\r\n\0]/.test(ev.eventDiscriminator) ||
                typeof ev.strategyVersion !== 'string' || ev.strategyVersion.trim().length === 0 || /[\r\n\0]/.test(ev.strategyVersion)) {
                throw new Error('V4 Outcome Contract Error: eventId, eventDiscriminator, and strategyVersion must be valid single-line strings.');
            }
            if (!VALID_V4_STRATEGIES.has(ev.strategyId)) {
                throw new Error(`V4 Outcome Contract Error: unsupported strategyId '${String(ev.strategyId)}'.`);
            }
            if (typeof ev.eventType !== 'string' || !VALID_V4_EVENT_TYPES_BY_STRATEGY[ev.strategyId].has(ev.eventType)) {
                throw new Error(`V4 Outcome Contract Error: invalid eventType '${String(ev.eventType)}' for '${ev.strategyId}'.`);
            }
            if (ev.eventDirection !== 'bull' && ev.eventDirection !== 'bear') {
                throw new Error(`V4 Outcome Contract Error: invalid eventDirection '${String(ev.eventDirection)}'.`);
            }
            if (!Number.isSafeInteger(ev.sourceBarIndex) || ev.sourceBarIndex < 0 ||
                !Number.isSafeInteger(ev.confirmationBarIndex) || ev.confirmationBarIndex < 0 ||
                !Number.isSafeInteger(ev.observationBarIndex) || ev.observationBarIndex < 0 ||
                !Number.isSafeInteger(ev.entryBarIndex) || ev.entryBarIndex < 0) {
                throw new Error(`V4 Outcome Contract Error: invalid bar indices on '${ev.eventId}'.`);
            }
            if (ev.sourceBarIndex > ev.confirmationBarIndex ||
                ev.confirmationLagBars !== ev.confirmationBarIndex - ev.sourceBarIndex ||
                ev.observationBarIndex !== ev.confirmationBarIndex ||
                ev.entryBarIndex !== ev.confirmationBarIndex + 1) {
                throw new Error(`V4 Outcome Contract Error: chronology index invariant violated on '${ev.eventId}'.`);
            }
            if (!Number.isSafeInteger(ev.sourceTimestamp) || ev.sourceTimestamp <= 0 ||
                !Number.isSafeInteger(ev.confirmationTimestamp) || ev.confirmationTimestamp < ev.sourceTimestamp ||
                !Number.isSafeInteger(ev.observationTimestamp) || ev.observationTimestamp !== ev.confirmationTimestamp + intervalMs) {
                throw new Error(`V4 Outcome Contract Error: timestamp/observation chronology violated on '${ev.eventId}'.`);
            }
            const tsSpan = ev.confirmationTimestamp - ev.sourceTimestamp;
            if (ev.confirmationLagBars === 0) {
                if (tsSpan !== 0) {
                    throw new Error(`V4 Outcome Contract Error: zero-lag event '${ev.eventId}' must have sourceTimestamp === confirmationTimestamp.`);
                }
            } else if (tsSpan < ev.confirmationLagBars * intervalMs || tsSpan % intervalMs !== 0) {
                throw new Error(`V4 Outcome Contract Error: source-to-confirmation timestamp span disagrees with lag on '${ev.eventId}'.`);
            }
            if (this.lastStepBarIndex !== null && this.lastStepBarTimestamp !== null &&
                ev.confirmationBarIndex === this.lastStepBarIndex &&
                ev.confirmationTimestamp !== this.lastStepBarTimestamp) {
                throw new Error(`V4 Outcome Contract Error: confirmationTimestamp disagrees with barIndex ${ev.confirmationBarIndex} clock.`);
            }
            if (ev.entryTimestamp !== null &&
                (!Number.isSafeInteger(ev.entryTimestamp) || ev.entryTimestamp <= ev.confirmationTimestamp)) {
                throw new Error(`V4 Outcome Contract Error: invalid entryTimestamp on '${ev.eventId}'.`);
            }

            // Validate structuralContext completely (including required keys for PHL/DTFX_STRICTCBC)
            serializeAndValidateV4StructuralContext(ev.strategyId, ev.structuralContext);
            if (ev.strategyId === 'PHL_BOS_MSS' || ev.strategyId === 'DTFX_STRICTCBC') {
                for (const reqKey of V4_STRUCTURAL_CONTEXT_ALLOWLIST[ev.strategyId]) {
                    if (!Object.prototype.hasOwnProperty.call(ev.structuralContext, reqKey)) {
                        throw new Error(`V4 Outcome Contract Error: '${ev.strategyId}' missing required context key '${reqKey}'.`);
                    }
                }
            }

            // Independent duplicate-ID detection (across all prior bars AND within current batch)
            if (this.seenEventIds.has(ev.eventId) || batchEventIds.has(ev.eventId)) {
                throw new Error(`V4 Outcome Contract Error: duplicate eventId '${ev.eventId}'.`);
            }
            batchEventIds.add(ev.eventId);

            // Canonical ordering validation (separate from duplicate detection)
            if (simLastOrder !== null) {
                const cmp =
                    (simLastOrder.confirmationBarIndex - ev.confirmationBarIndex) ||
                    cmpAscii(simLastOrder.strategyId, ev.strategyId) ||
                    cmpAscii(simLastOrder.eventType, ev.eventType) ||
                    cmpAscii(simLastOrder.eventId, ev.eventId);
                if (cmp >= 0) {
                    throw new Error(`V4 Outcome Contract Error: out-of-order event '${ev.eventId}'.`);
                }
            }
            simLastOrder = {
                confirmationBarIndex: ev.confirmationBarIndex,
                strategyId: ev.strategyId,
                eventType: ev.eventType,
                eventId: ev.eventId
            };

            const frozenEv: V4PipelineStrategyEvent = Object.freeze({
                ...ev,
                structuralContext: Object.freeze({ ...ev.structuralContext })
            });

            const entryBar = frozenEv.entryBarIndex;
            preparedPending.push({
                event: frozenEv,
                symbol,
                timeframe,
                tierA: frozenTierA,
                atrValid,
                entryBar,
                horizonEnd60: entryBar + 60 - 1,
                horizonEnd120: entryBar + 120 - 1,
                horizonEnd180: entryBar + V4_MAX_HORIZON_BARS - 1,
                initialized: false,
                entryTime: 0,
                entryPrice: 0,
                lStop: 0,
                lTarget: 0,
                lRisk: 0,
                sStop: 0,
                sTarget: 0,
                sRisk: 0,
                lResolved: false,
                lBarrierExitPrice: 0,
                lBarrierKind: 'hard_stop',
                sResolved: false,
                sBarrierExitPrice: 0,
                sBarrierKind: 'hard_stop'
            });
        }

        // All validated — commit atomically
        this.totalCandidates += preparedPending.length;
        this.lastEnqueuedOrder = simLastOrder;
        for (const id of batchEventIds) {
            this.seenEventIds.add(id);
        }
        for (const p of preparedPending) {
            this.pending.push(p);
        }
    }

    public finalizeEndOfStream(totalAcceptedBars: number): V4OutcomeAccounting {
        for (const leftover of this.pending) {
            if (leftover.entryBar >= totalAcceptedBars) this.excludedMissingNextOpen++;
            else if (!leftover.atrValid) this.excludedUnwarmedAtr++;
            else this.excludedIncompleteHorizon++;
        }
        this.pending.length = 0;

        for (const key of V4_FROZEN_TEACHERS) {
            if (!(key in this.countsByStrategy)) this.countsByStrategy[key] = 0;
        }
        return Object.freeze({
            totalCandidateEvents: this.totalCandidates,
            excludedMissingNextOpen: this.excludedMissingNextOpen,
            excludedUnwarmedAtr: this.excludedUnwarmedAtr,
            excludedIncompleteHorizon: this.excludedIncompleteHorizon,
            eligibleEvents: this.eligibleCount,
            countsByStrategy: Object.freeze({ ...this.countsByStrategy }),
            countsByEventType: Object.freeze({ ...this.countsByEventType })
        });
    }
}
