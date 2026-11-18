import type { StrategyEvent, StrategyId } from '../teachers/StrategyEventTypes';
import { TIER_C_QUARANTINE_LIST } from '../dataset/DatasetSchema';

export const V3_DATASET_VERSION = 3;
export const V3_REPRESENTATION_SCHEMA_VERSION = 'MLR1_REPRESENTATION_V3';
export const V3_MODEL_INPUT_SCHEMA_VERSION = 'MLR1_MODEL_INPUT_V3';
export const V3_OUTCOME_CONFIG_VERSION = 'MLR1_V3_H60_120_180';

export const V3_STOP_ATR_MULT = 1.5;
export const V3_TARGET_R_MULT = 2.0;
export const V3_HORIZONS = [60, 120, 180] as const;
export const V3_MAX_HORIZON_BARS = 180;
export const V3_TRADE_COST_R = 0.05;

export type V3HorizonOutcomeClass =
    | 'full_target'
    | 'hard_stop'
    | 'timeout_net_gain'
    | 'timeout_net_loss';

export interface V3HorizonSnapshot {
    readonly exitPrice: number;
    readonly netR: number;
    readonly outcome: V3HorizonOutcomeClass;
}

export interface V3TierAAtConfirmation {
    readonly tierAObservationId: string;
    readonly atr14: number;
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
    readonly context15mAvailable: boolean;
    readonly context15mStatus: string;
}

export interface V3StrategyEventRow {
    // Tier B: Event Identity, Chronology & Structural Context
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

    // Tier A snapshot at confirmation
    readonly tierA_atr_14: number;
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
    readonly tierA_context_15m_available: number;
    readonly tierA_context_15m_status: string;

    // Tier C: Execution & Independent 60 / 120 / 180 Outcomes (QUARANTINED)
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

export const V3_REPRESENTATION_COLUMNS = [
    'tierA_observation_id',
    'tierA_atr_14',
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
    'tierA_context_15m_available',
    'tierA_context_15m_status',
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

export const V3_STRATEGY_EVENT_COLUMNS: readonly (keyof V3StrategyEventRow)[] = Object.freeze([
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
    'tierA_context_15m_available',
    'tierA_context_15m_status',
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

export type V3RepresentationColumn = (typeof V3_REPRESENTATION_COLUMNS)[number];

export interface V3RepresentationRow {
    readonly tierA_observation_id: string;
    readonly tierA_atr_14: number;
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
    readonly tierA_context_15m_available: number;
    readonly tierA_context_15m_status: string;
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

export function assertV3RepresentationZeroTierCLeakage(columns: readonly string[]): void {
    const forbidden = new Set(TIER_C_QUARANTINE_LIST.map(f => f.toLowerCase()));
    if (columns.length !== V3_REPRESENTATION_COLUMNS.length ||
        columns.some((col, idx) => col !== V3_REPRESENTATION_COLUMNS[idx])) {
        throw new Error('V3 Representation Contract Error: column list differs from frozen V3_REPRESENTATION_COLUMNS.');
    }
    for (const col of columns) {
        const lower = col.toLowerCase();
        const stripped = lower.replace(/^tiera_|^tierb_/, '');
        if (forbidden.has(lower) || forbidden.has(stripped) ||
            /(^|_)(entry|exit|stop|target|net_r|outcome)(_|$)/.test(stripped)) {
            throw new Error(`V3 Leakage Error: forbidden Tier C field '${col}' detected in representation schema.`);
        }
    }
}

export const V3_STRUCTURAL_CONTEXT_ALLOWLIST: Readonly<Record<StrategyId, readonly string[]>> = Object.freeze({
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
        'breakType',
        'brokenLevelPrice',
        'hasProtectedLevel',
        'protectedLevelPrice',
        'distToProtectedAtr',
        'pbFromLowValid',
        'pbFromHighValid'
    ]),
    DTFX_ZONES: Object.freeze([
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

const PROHIBITED_CONTEXT_TERMS = new Set([
    ...TIER_C_QUARANTINE_LIST.map(k => k.toLowerCase()),
    'entry_bar_index',
    'entry_time',
    'entry_price',
    'exit_price',
    'stop_price',
    'target_price',
    'net_r',
    'outcome',
    'forward',
    'future',
    'horizon',
    'mfe',
    'mae'
]);

function assertSafeContextKey(key: string): void {
    const lower = key.toLowerCase();
    if (PROHIBITED_CONTEXT_TERMS.has(lower) ||
        /(entry|exit|stop|target|net_r|outcome|forward|future|horizon|mfe|mae)/.test(lower)) {
        throw new Error(`V3 Structural Context Leakage Error: prohibited key '${key}' detected.`);
    }
}

export function serializeAndValidateStructuralContext(
    strategyId: StrategyId,
    structuralContext: Readonly<Record<string, unknown>>
): string {
    if (structuralContext === null || typeof structuralContext !== 'object' || Array.isArray(structuralContext)) {
        throw new Error('V3 Structural Context Error: structuralContext must be a non-null plain object.');
    }
    const proto = Object.getPrototypeOf(structuralContext);
    if (proto !== Object.prototype && proto !== null) {
        throw new Error('V3 Structural Context Error: structuralContext must have Object.prototype or null prototype.');
    }
    for (const rawKey of Reflect.ownKeys(structuralContext)) {
        if (typeof rawKey !== 'string') {
            throw new Error('V3 Structural Context Error: symbol keys are not permitted.');
        }
        const desc = Object.getOwnPropertyDescriptor(structuralContext, rawKey);
        if (!desc || !('value' in desc) || !desc.enumerable) {
            throw new Error(
                `V3 Structural Context Error: property '${rawKey}' must be an enumerable data property.`
            );
        }
    }
    const allowedKeys = V3_STRUCTURAL_CONTEXT_ALLOWLIST[strategyId];
    if (!allowedKeys) {
        throw new Error(`V3 Structural Context Error: unknown strategyId '${strategyId}'.`);
    }
    const allowedSet = new Set(allowedKeys);
    const ordered: Record<string, number | string | boolean> = {};

    for (const key of Object.keys(structuralContext).sort()) {
        assertSafeContextKey(key);
        if (!allowedSet.has(key)) {
            throw new Error(
                `V3 Structural Context Error: key '${key}' is not allowlisted for strategy '${strategyId}'.`
            );
        }
        const val = structuralContext[key];
        if (typeof val === 'number') {
            if (!Number.isFinite(val)) {
                throw new Error(`V3 Structural Context Error: non-finite number on '${key}'.`);
            }
        } else if (typeof val !== 'string' && typeof val !== 'boolean') {
            throw new Error(
                `V3 Structural Context Error: nested object or unsupported value type on '${key}'.`
            );
        }
        ordered[key] = val;
    }

    return JSON.stringify(ordered);
}

export function assertV3RepresentationRowZeroLeakage(row: V3RepresentationRow): void {
    const keys = Object.keys(row);
    assertV3RepresentationZeroTierCLeakage(keys);

    let parsed: unknown;
    try {
        parsed = JSON.parse(row.tierB_structural_context_json);
    } catch {
        throw new Error('V3 Representation Leakage Error: tierB_structural_context_json is invalid JSON.');
    }
    serializeAndValidateStructuralContext(
        row.tierB_strategy_id as StrategyId,
        parsed as Record<string, unknown>
    );
}

export function buildV3RepresentationRow(row: V3StrategyEventRow): V3RepresentationRow {
    return Object.freeze({
        tierA_observation_id: row.tierA_observation_id,
        tierA_atr_14: row.tierA_atr_14,
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
        tierA_context_15m_available: row.tierA_context_15m_available,
        tierA_context_15m_status: row.tierA_context_15m_status,
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

interface PendingV3OutcomeEvent {
    readonly event: StrategyEvent;
    readonly symbol: string;
    readonly timeframe: string;
    readonly tierA: V3TierAAtConfirmation;
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

function finalizeHorizonSnapshot(
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
    const netR = grossR - V3_TRADE_COST_R;
    const outcome: V3HorizonOutcomeClass = resolved
        ? barrierKind
        : netR > 0
          ? 'timeout_net_gain'
          : 'timeout_net_loss';
    return Object.freeze({ exitPrice, netR, outcome });
}

export interface V3OutcomeAccounting {
    readonly totalCandidateEvents: number;
    readonly excludedMissingNextOpen: number;
    readonly excludedUnwarmedAtr: number;
    readonly excludedIncompleteHorizon: number;
    readonly eligibleEvents: number;
    readonly countsByStrategy: Readonly<Record<string, number>>;
    readonly countsByEventType: Readonly<Record<string, number>>;
}

/**
 * Bounded-memory incremental outcome replay engine (retains only pending events within 180-bar horizon).
 * Shared identically by batch (AIExporter) and streaming (StreamingDatasetExporter) pipelines.
 */
export class MultiHorizonOutcomeTracker {
    private readonly pending: PendingV3OutcomeEvent[] = [];
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

    /**
     * Advances all active pending events on bar `barIndex` and returns any events whose 180-bar horizon resolved on this bar.
     */
    public stepBar(
        barIndex: number,
        candle: { readonly time: number; readonly open: number; readonly high: number; readonly low: number; readonly close: number }
    ): readonly V3StrategyEventRow[] {
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
                ev.lStop = ev.entryPrice - ev.tierA.atr14 * V3_STOP_ATR_MULT;
                ev.lTarget = ev.entryPrice + ev.tierA.atr14 * V3_STOP_ATR_MULT * V3_TARGET_R_MULT;
                ev.lRisk = ev.entryPrice - ev.lStop;
                ev.sStop = ev.entryPrice + ev.tierA.atr14 * V3_STOP_ATR_MULT;
                ev.sTarget = ev.entryPrice - ev.tierA.atr14 * V3_STOP_ATR_MULT * V3_TARGET_R_MULT;
                ev.sRisk = ev.sStop - ev.entryPrice;
            }

            if (ev.initialized) {
                if (!ev.lResolved) {
                    if (candle.open <= ev.lStop) {
                        ev.lBarrierExitPrice = candle.open;
                        ev.lBarrierKind = 'hard_stop';
                        ev.lResolved = true;
                    } else if (candle.open >= ev.lTarget) {
                        ev.lBarrierExitPrice = candle.open;
                        ev.lBarrierKind = 'full_target';
                        ev.lResolved = true;
                    } else {
                        const hitSL = candle.low <= ev.lStop;
                        const hitTP = candle.high >= ev.lTarget;
                        if (hitSL) {
                            ev.lBarrierExitPrice = ev.lStop;
                            ev.lBarrierKind = 'hard_stop';
                            ev.lResolved = true;
                        } else if (hitTP) {
                            ev.lBarrierExitPrice = ev.lTarget;
                            ev.lBarrierKind = 'full_target';
                            ev.lResolved = true;
                        }
                    }
                }

                if (!ev.sResolved) {
                    if (candle.open >= ev.sStop) {
                        ev.sBarrierExitPrice = candle.open;
                        ev.sBarrierKind = 'hard_stop';
                        ev.sResolved = true;
                    } else if (candle.open <= ev.sTarget) {
                        ev.sBarrierExitPrice = candle.open;
                        ev.sBarrierKind = 'full_target';
                        ev.sResolved = true;
                    } else {
                        const hitSL = candle.high >= ev.sStop;
                        const hitTP = candle.low <= ev.sTarget;
                        if (hitSL) {
                            ev.sBarrierExitPrice = ev.sStop;
                            ev.sBarrierKind = 'hard_stop';
                            ev.sResolved = true;
                        } else if (hitTP) {
                            ev.sBarrierExitPrice = ev.sTarget;
                            ev.sBarrierKind = 'full_target';
                            ev.sResolved = true;
                        }
                    }
                }

                if (barIndex === ev.horizonEnd60) {
                    ev.lSnap60 = finalizeHorizonSnapshot(true, ev.lResolved, ev.lBarrierExitPrice, ev.lBarrierKind, candle.close, ev.entryPrice, ev.lRisk);
                    ev.sSnap60 = finalizeHorizonSnapshot(false, ev.sResolved, ev.sBarrierExitPrice, ev.sBarrierKind, candle.close, ev.entryPrice, ev.sRisk);
                }
                if (barIndex === ev.horizonEnd120) {
                    ev.lSnap120 = finalizeHorizonSnapshot(true, ev.lResolved, ev.lBarrierExitPrice, ev.lBarrierKind, candle.close, ev.entryPrice, ev.lRisk);
                    ev.sSnap120 = finalizeHorizonSnapshot(false, ev.sResolved, ev.sBarrierExitPrice, ev.sBarrierKind, candle.close, ev.entryPrice, ev.sRisk);
                }
                if (barIndex === ev.horizonEnd180) {
                    ev.lSnap180 = finalizeHorizonSnapshot(true, ev.lResolved, ev.lBarrierExitPrice, ev.lBarrierKind, candle.close, ev.entryPrice, ev.lRisk);
                    ev.sSnap180 = finalizeHorizonSnapshot(false, ev.sResolved, ev.sBarrierExitPrice, ev.sBarrierKind, candle.close, ev.entryPrice, ev.sRisk);
                }
            }
        }

        const completed: V3StrategyEventRow[] = [];
        while (this.pending.length > 0 && this.pending[0].horizonEnd180 === barIndex) {
            const done = this.pending.shift()!;
            if (!done.lSnap60 || !done.sSnap60 || !done.lSnap120 || !done.sSnap120 || !done.lSnap180 || !done.sSnap180) {
                throw new Error(`MultiHorizonOutcomeTracker Error: incomplete snapshots for event '${done.event.eventId}'.`);
            }
            const ev = done.event;
            const row: V3StrategyEventRow = Object.freeze({
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
                structural_context_json: serializeAndValidateStructuralContext(ev.strategyId, ev.structuralContext),

                tierA_atr_14: done.tierA.atr14,
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
                tierA_context_15m_available: done.tierA.context15mAvailable ? 1 : 0,
                tierA_context_15m_status: done.tierA.context15mStatus,

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

    /**
     * Registers confirmed events from `barIndex` in canonical sorted order.
     */
    public enqueueEvents(
        sortedBarEvents: readonly StrategyEvent[],
        symbol: string,
        timeframe: string,
        tierA: V3TierAAtConfirmation,
        atrValid: boolean
    ): void {
        for (const ev of sortedBarEvents) {
            if (ev.observationBarIndex !== ev.confirmationBarIndex) {
                throw new Error(
                    `V3 Outcome Contract Error: event '${ev.eventId}' violates observationBarIndex === confirmationBarIndex (${ev.observationBarIndex} !== ${ev.confirmationBarIndex}).`
                );
            }
        }
        for (const ev of sortedBarEvents) {
            this.totalCandidates++;
            const entryBar = ev.entryBarIndex;
            this.pending.push({
                event: ev,
                symbol,
                timeframe,
                tierA,
                atrValid,
                entryBar,
                horizonEnd60: entryBar + 60 - 1,
                horizonEnd120: entryBar + 120 - 1,
                horizonEnd180: entryBar + V3_MAX_HORIZON_BARS - 1,
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
    }

    /**
     * Accounts end-of-stream censored events using exact v2 precedence:
     * 1. missing next open -> 2. unwarmed ATR -> 3. incomplete 180-bar horizon.
     */
    public finalizeEndOfStream(totalAcceptedBars: number): V3OutcomeAccounting {
        for (const leftover of this.pending) {
            if (leftover.entryBar >= totalAcceptedBars) {
                this.excludedMissingNextOpen++;
            } else if (!leftover.atrValid) {
                this.excludedUnwarmedAtr++;
            } else {
                this.excludedIncompleteHorizon++;
            }
        }
        this.pending.length = 0;

        const accounted =
            this.excludedMissingNextOpen +
            this.excludedUnwarmedAtr +
            this.excludedIncompleteHorizon +
            this.eligibleCount;
        if (accounted !== this.totalCandidates) {
            throw new Error(
                `V3 Outcome Reconciliation Error: accounted=${accounted} !== totalCandidates=${this.totalCandidates}.`
            );
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
