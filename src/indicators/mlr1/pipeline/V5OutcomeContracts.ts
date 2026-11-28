import {
    MLR1_V5_MODEL_INPUT_SCHEMA_VERSION,
    MLR1_V5_REPRESENTATION_SCHEMA_VERSION
} from '../dataset/DatasetSchema';
import {
    V4_HORIZONS,
    V4_MAX_HORIZON_BARS,
    V4_STOP_ATR_MULT,
    V4_TARGET_R_MULT,
    V4_TRADE_COST_R,
    type V4TierAAtConfirmation
} from './V4OutcomeContracts';

export const V5_DATASET_VERSION = 5 as const;
export const V5_REPRESENTATION_SCHEMA_VERSION = MLR1_V5_REPRESENTATION_SCHEMA_VERSION;
export const V5_MODEL_INPUT_SCHEMA_VERSION = MLR1_V5_MODEL_INPUT_SCHEMA_VERSION;
export const V5_TEACHER_VERSION = 'CHRONOS_V5_PHL_ENTRY_ZONES_AND_DTFX_DS_v1';

// Inherit pinned counterfactual execution economics without modifying V4
export const V5_HORIZONS = V4_HORIZONS;
export const V5_MAX_HORIZON_BARS = V4_MAX_HORIZON_BARS;
export const V5_STOP_ATR_MULT = V4_STOP_ATR_MULT;
export const V5_TARGET_R_MULT = V4_TARGET_R_MULT;
export const V5_TRADE_COST_R = V4_TRADE_COST_R;
export const V5_OUTCOME_CONFIG_VERSION = 'MLR1_V5_H60_120_180_SL1.5ATR_RR2.0_COST0.05R';

// Phase 0 Decision 1: Timeframe evaluation rules
export const V5_TIMEFRAME_EVALUATION_CONTRACT = Object.freeze({
    dtfx: Object.freeze({
        zoneCreation: 'ZONE_TIMEFRAME_CLOSE',
        retestEvaluation: '1M_CLOSE',
        breakEvaluation: '1M_CLOSE'
    }),
    phl: Object.freeze({
        zoneCreation: 'ZONE_TIMEFRAME_CLOSE',
        structuralInvalidation: 'ZONE_TIMEFRAME_CLOSE',
        supersessionEvaluation: 'ZONE_TIMEFRAME_CLOSE',
        retestInteraction: '1M_CLOSE'
    })
} as const);

export type V5ZoneTimeframe = '1m' | '3m' | '5m';
export type V5ZoneSource = 'PHL' | 'DTFX_STRICTCBC';
export type V5ZoneSide = 'DEMAND' | 'SUPPLY' | 'PHL_BUY_ZONE' | 'PHL_SELL_ZONE';
export type V5Direction = 'bull' | 'bear';
export type V5EventRole = 'TRADE_CANDIDATE' | 'ZONE_LIFECYCLE';

// DTFX cannot emit SUPERSEDED by design; PHL can emit all six
export type V5DTFXLifecycleEventType =
    | 'CREATED'
    | 'RETESTED'
    | 'BROKEN'
    | 'EVICTED'
    | 'GAP_RESET';

export type V5ZoneLifecycleEvent = V5DTFXLifecycleEventType | 'SUPERSEDED';

export type V5ZoneActivityState =
    | 'ACTIVE'
    | 'BROKEN'
    | 'EVICTED'
    | 'SUPERSEDED'
    | 'GAP_RESET';

// Re-export V4 Tier A confirmation type without altering its fields
export type V5TierAConfirmationBaseline = V4TierAAtConfirmation;

// Phase 0 Safeguard A: Deterministic IDs linking Zone -> Episode -> Candidate
export function buildV5ZoneId(params: {
    readonly symbol: string;
    readonly source: V5ZoneSource;
    readonly timeframe: V5ZoneTimeframe;
    readonly side: V5ZoneSide;
    readonly createdSourceTimestamp: number;
    readonly createdConfirmationTimestamp: number;
}): string {
    if (typeof params.symbol !== 'string' || params.symbol.trim().length === 0) {
        throw new Error('V5 Contract Error: symbol must be a non-empty string.');
    }
    if (!Number.isSafeInteger(params.createdSourceTimestamp) || params.createdSourceTimestamp <= 0 ||
        !Number.isSafeInteger(params.createdConfirmationTimestamp) || params.createdConfirmationTimestamp < params.createdSourceTimestamp) {
        throw new Error('V5 Contract Error: zone timestamps must be ordered positive safe integers.');
    }
    return `${params.symbol.trim()}_${params.source}_${params.timeframe}_${params.side}_${params.createdSourceTimestamp}_${params.createdConfirmationTimestamp}`;
}

export function buildV5DtfxRetestEpisodeId(
    dtfxZoneId: string,
    retestCount: number,
    episodeConfirmationTimestamp: number
): string {
    if (!Number.isSafeInteger(retestCount) || retestCount < 1) {
        throw new Error(`V5 Contract Error: DTFX retestCount must be >= 1, got ${retestCount}.`);
    }
    return `${dtfxZoneId}:DS_EP${retestCount}:${episodeConfirmationTimestamp}`;
}

export function buildV5PhlRetestEpisodeId(
    phlZoneId: string,
    retestCount: number,
    episodeConfirmationTimestamp: number
): string {
    if (!Number.isSafeInteger(retestCount) || retestCount < 1) {
        throw new Error(`V5 Contract Error: retestCount must be >= 1, got ${retestCount}.`);
    }
    return `${phlZoneId}:EP${retestCount}:${episodeConfirmationTimestamp}`;
}

export function buildV5CandidateEventId(
    phlRetestEpisodeId: string,
    direction: V5Direction
): string {
    return `CAND:${phlRetestEpisodeId}:${direction}`;
}

// Phase 0 Decision 2 & Safeguards A/B: Record schemas
export interface V5ZoneLifecycleRecord {
    readonly lifecycleId: string;
    readonly zoneId: string;
    readonly symbol: string;
    readonly source: V5ZoneSource;
    readonly zoneTimeframe: V5ZoneTimeframe;
    readonly zoneSide: V5ZoneSide;
    readonly zoneDirection: V5Direction;
    readonly eventType: V5ZoneLifecycleEvent;
    readonly eventDirection: V5Direction | null;
    readonly zoneActivity: V5ZoneActivityState;
    readonly eventRole: 'ZONE_LIFECYCLE';
    readonly outcomeEligible: false;
    readonly retestCount: number;
    readonly retestEpisodeId: string | null;
    readonly zoneTop: number;
    readonly zoneBot: number;
    readonly createdSourceTimestamp: number;
    readonly createdConfirmationTimestamp: number;
    readonly confirmationTimestamp: number;
    readonly createdBaseBarIndex: number;
    readonly confirmationBaseBarIndex: number;
    readonly createdNativeBarIndex: number;
    readonly confirmationNativeBarIndex: number;
    readonly zoneAgeBaseBars: number;
    readonly zoneAgeNativeBars: number;
    readonly touchDepthNormRaw: number | null;
    readonly touchDepthNormClamped: number | null;
    readonly closeDepthNormRaw: number | null;
    readonly closeDepthNormClamped: number | null;
    readonly atr14Valid: boolean;
    readonly zoneWidthAtr: number | null;
    readonly supersededByZoneId: string | null;
}

export interface V5PhlRetestCandidateRecord {
    readonly eventId: string;
    readonly phlZoneId: string;
    readonly phlRetestEpisodeId: string;
    readonly zoneTimeframe: V5ZoneTimeframe;
    readonly zoneSide: 'PHL_BUY_ZONE' | 'PHL_SELL_ZONE';
    readonly direction: V5Direction;
    readonly eventRole: 'TRADE_CANDIDATE';
    readonly outcomeEligible: true;
    readonly retestCount: number;
    readonly confirmationBarIndex: number;
    readonly confirmationTimestamp: number;
    readonly touchDepthNormRaw: number;
    readonly touchDepthNormClamped: number;
    readonly closeDepthNormRaw: number;
    readonly closeDepthNormClamped: number;
    readonly entryConfirmation: boolean;
    readonly entryConfirmationScore: number;
    readonly entryConfirmationTimestamp: number | null;
}

// Phase 0 Safeguard B: Active Demand/Supply strictly separate from historical breaks
export interface V5ActiveAndHistoricalDsSnapshot {
    readonly activeDemandCount: number;
    readonly activeSupplyCount: number;
    readonly historicalDemandBreakCount: number;
    readonly historicalSupplyBreakCount: number;
    readonly bestOverlapPhlToDsRatio: number;
    readonly bestOverlapDsZoneId: string | null;
    readonly bestOverlapDsTimeframe: V5ZoneTimeframe | null;
    readonly alignedActiveDsCount: number;
    readonly opposedActiveDsCount: number;
}

// Frozen math helpers: raw & clamped pullback depth + PHL-to-DTFX overlap
export function computeV5DepthMetrics(
    zoneTop: number,
    zoneBot: number,
    price: number,
    zoneDirection: V5Direction
): { readonly raw: number; readonly clamped: number } {
    if (!Number.isFinite(zoneTop) || !Number.isFinite(zoneBot) || !Number.isFinite(price) || zoneTop <= zoneBot) {
        throw new Error(`V5 Depth Error: invalid bounds [${zoneBot}, ${zoneTop}] or price ${price}.`);
    }
    const width = zoneTop - zoneBot;
    const raw = zoneDirection === 'bull' ? (zoneTop - price) / width : (price - zoneBot) / width;
    const clamped = Math.min(1, Math.max(0, raw));
    return { raw, clamped };
}

export function computeV5PhlDsOverlapRatio(
    phlTop: number,
    phlBot: number,
    dsTop: number,
    dsBot: number
): number {
    if (!Number.isFinite(phlTop) || !Number.isFinite(phlBot) || phlTop <= phlBot) {
        throw new Error(`V5 Overlap Error: invalid PHL bounds [${phlBot}, ${phlTop}].`);
    }
    if (!Number.isFinite(dsTop) || !Number.isFinite(dsBot) || dsTop <= dsBot) {
        throw new Error(`V5 Overlap Error: invalid DS bounds [${dsBot}, ${dsTop}].`);
    }
    const intersection = Math.max(0, Math.min(phlTop, dsTop) - Math.max(phlBot, dsBot));
    return intersection / (phlTop - phlBot);
}

export function isV5PhlDsAligned(
    phlSide: 'PHL_BUY_ZONE' | 'PHL_SELL_ZONE',
    dsSide: 'DEMAND' | 'SUPPLY'
): boolean {
    return (phlSide === 'PHL_BUY_ZONE' && dsSide === 'DEMAND') ||
        (phlSide === 'PHL_SELL_ZONE' && dsSide === 'SUPPLY');
}

const VALID_V5_SOURCES = new Set<string>(['DTFX_STRICTCBC', 'PHL']);
const VALID_V5_TIMEFRAMES = new Set<string>(['1m', '3m', '5m']);
const VALID_V5_LIFECYCLE_EVENTS = new Set<string>(['CREATED', 'RETESTED', 'BROKEN', 'EVICTED', 'SUPERSEDED', 'GAP_RESET']);

export function validateV5ZoneLifecycleRecord(r: V5ZoneLifecycleRecord): void {
    if (!r || typeof r !== 'object') {
        throw new Error('V5 Lifecycle Error: record must be an object.');
    }
    if (typeof r.lifecycleId !== 'string' || r.lifecycleId.trim().length === 0 ||
        typeof r.zoneId !== 'string' || r.zoneId.trim().length === 0 ||
        typeof r.symbol !== 'string' || r.symbol.trim().length === 0) {
        throw new Error('V5 Lifecycle Error: lifecycleId, zoneId, and symbol must be non-empty trimmed strings.');
    }
    if (!VALID_V5_SOURCES.has(r.source)) {
        throw new Error(`V5 Lifecycle Error: unsupported source '${String(r.source)}'.`);
    }
    if (!VALID_V5_TIMEFRAMES.has(r.zoneTimeframe)) {
        throw new Error(`V5 Lifecycle Error: unsupported zoneTimeframe '${String(r.zoneTimeframe)}'.`);
    }
    if (!VALID_V5_LIFECYCLE_EVENTS.has(r.eventType)) {
        throw new Error(`V5 Lifecycle Error: unsupported eventType '${String(r.eventType)}'.`);
    }
    if (r.eventRole !== 'ZONE_LIFECYCLE' || r.outcomeEligible !== false) {
        throw new Error('V5 Lifecycle Error: lifecycle record must have eventRole=ZONE_LIFECYCLE and outcomeEligible=false.');
    }

    if (r.source === 'DTFX_STRICTCBC') {
        if (r.eventType === 'SUPERSEDED' || r.zoneActivity === 'SUPERSEDED') {
            throw new Error('V5 Lifecycle Error: DTFX_STRICTCBC cannot emit SUPERSEDED.');
        }
        if (r.zoneSide !== 'DEMAND' && r.zoneSide !== 'SUPPLY') {
            throw new Error(`V5 Lifecycle Error: invalid DTFX zoneSide '${String(r.zoneSide)}'.`);
        }
    } else {
        if (r.zoneSide !== 'PHL_BUY_ZONE' && r.zoneSide !== 'PHL_SELL_ZONE') {
            throw new Error(`V5 Lifecycle Error: invalid PHL zoneSide '${String(r.zoneSide)}'.`);
        }
    }

    const expectedZoneDir: V5Direction =
        (r.zoneSide === 'DEMAND' || r.zoneSide === 'PHL_BUY_ZONE') ? 'bull' : 'bear';
    if (r.zoneDirection !== expectedZoneDir) {
        throw new Error(`V5 Lifecycle Error: zoneSide '${r.zoneSide}' requires zoneDirection '${expectedZoneDir}', got '${String(r.zoneDirection)}'.`);
    }

    const expectedActivity: Record<V5ZoneLifecycleEvent, V5ZoneActivityState> = {
        CREATED: 'ACTIVE',
        RETESTED: 'ACTIVE',
        BROKEN: 'BROKEN',
        EVICTED: 'EVICTED',
        SUPERSEDED: 'SUPERSEDED',
        GAP_RESET: 'GAP_RESET'
    };
    if (r.zoneActivity !== expectedActivity[r.eventType]) {
        throw new Error(`V5 Lifecycle Error: eventType '${r.eventType}' requires zoneActivity '${expectedActivity[r.eventType]}', got '${String(r.zoneActivity)}'.`);
    }

    if (r.eventType === 'CREATED' || r.eventType === 'RETESTED') {
        if (r.eventDirection !== expectedZoneDir) {
            throw new Error(`V5 Lifecycle Error: ${r.zoneSide} ${r.eventType} requires eventDirection '${expectedZoneDir}'.`);
        }
    } else if (r.eventType === 'BROKEN') {
        const expectedBreakDir: V5Direction = expectedZoneDir === 'bull' ? 'bear' : 'bull';
        if (r.eventDirection !== expectedBreakDir) {
            throw new Error(`V5 Lifecycle Error: ${r.zoneSide} BROKEN requires eventDirection '${expectedBreakDir}'.`);
        }
    } else {
        if (r.eventDirection !== null) {
            throw new Error(`V5 Lifecycle Error: ${r.eventType} must have null eventDirection.`);
        }
    }

    if (r.eventType === 'SUPERSEDED') {
        if (r.source !== 'PHL' || !r.supersededByZoneId || r.supersededByZoneId.trim().length === 0 || r.supersededByZoneId === r.zoneId) {
            throw new Error('V5 Lifecycle Error: SUPERSEDED must belong to PHL and reference a distinct supersededByZoneId.');
        }
    } else if (r.supersededByZoneId !== null) {
        throw new Error('V5 Lifecycle Error: supersededByZoneId must be null unless eventType is SUPERSEDED.');
    }

    if (!Number.isFinite(r.zoneTop) || !Number.isFinite(r.zoneBot) || r.zoneTop <= r.zoneBot) {
        throw new Error(`V5 Lifecycle Error: invalid zone bounds [${r.zoneBot}, ${r.zoneTop}].`);
    }
    if (!Number.isSafeInteger(r.createdSourceTimestamp) || r.createdSourceTimestamp <= 0 ||
        !Number.isSafeInteger(r.createdConfirmationTimestamp) || r.createdConfirmationTimestamp < r.createdSourceTimestamp ||
        !Number.isSafeInteger(r.confirmationTimestamp) || r.confirmationTimestamp < r.createdConfirmationTimestamp) {
        throw new Error('V5 Lifecycle Error: timestamps violate causal ordering.');
    }
    if (!Number.isSafeInteger(r.retestCount) || r.retestCount < 0) {
        throw new Error(`V5 Lifecycle Error: invalid retestCount ${r.retestCount}.`);
    }
    if (!Number.isSafeInteger(r.createdBaseBarIndex) || r.createdBaseBarIndex < 0 ||
        !Number.isSafeInteger(r.confirmationBaseBarIndex) || r.confirmationBaseBarIndex < r.createdBaseBarIndex ||
        !Number.isSafeInteger(r.createdNativeBarIndex) || r.createdNativeBarIndex < 0 ||
        !Number.isSafeInteger(r.confirmationNativeBarIndex) || r.confirmationNativeBarIndex < r.createdNativeBarIndex) {
        throw new Error('V5 Lifecycle Error: invalid base or native bar indices.');
    }
    if (r.zoneAgeBaseBars !== r.confirmationBaseBarIndex - r.createdBaseBarIndex ||
        r.zoneAgeNativeBars !== r.confirmationNativeBarIndex - r.createdNativeBarIndex) {
        throw new Error('V5 Lifecycle Error: zoneAgeBaseBars/zoneAgeNativeBars disagree with indices.');
    }
    if (r.eventType === 'RETESTED' && (!r.retestEpisodeId || r.retestCount < 1)) {
        throw new Error('V5 Lifecycle Error: RETESTED must have retestEpisodeId and retestCount >= 1.');
    }
    if (r.eventType !== 'RETESTED' && r.retestEpisodeId !== null) {
        throw new Error('V5 Lifecycle Error: retestEpisodeId must be null on non-retest events.');
    }
    if (r.atr14Valid && (r.zoneWidthAtr === null || !Number.isFinite(r.zoneWidthAtr) || r.zoneWidthAtr <= 0)) {
        throw new Error('V5 Lifecycle Error: atr14Valid=true requires finite positive zoneWidthAtr.');
    }
    if (!r.atr14Valid && r.zoneWidthAtr !== null) {
        throw new Error('V5 Lifecycle Error: atr14Valid=false requires zoneWidthAtr=null.');
    }
}

export interface V5ZoneLifecycleAccountingSummary {
    readonly dtfxCreatedCount: number;
    readonly dtfxRetestedCount: number;
    readonly dtfxBrokenCount: number;
    readonly dtfxEvictedCount: number;
    readonly dtfxGapResetCount: number;
    readonly phlCreatedCount: number;
    readonly phlRetestedCount: number;
    readonly phlBrokenCount: number;
    readonly phlEvictedCount: number;
    readonly phlSupersededCount: number;
    readonly phlGapResetCount: number;
}

export function summarizeV5ZoneLifecycleAccounting(
    records: readonly V5ZoneLifecycleRecord[]
): V5ZoneLifecycleAccountingSummary {
    let dtfxCreatedCount = 0, dtfxRetestedCount = 0, dtfxBrokenCount = 0, dtfxEvictedCount = 0, dtfxGapResetCount = 0;
    let phlCreatedCount = 0, phlRetestedCount = 0, phlBrokenCount = 0, phlEvictedCount = 0, phlSupersededCount = 0, phlGapResetCount = 0;

    for (const r of records) {
        validateV5ZoneLifecycleRecord(r);
        if (r.source === 'DTFX_STRICTCBC') {
            if (r.eventType === 'CREATED') dtfxCreatedCount++;
            else if (r.eventType === 'RETESTED') dtfxRetestedCount++;
            else if (r.eventType === 'BROKEN') dtfxBrokenCount++;
            else if (r.eventType === 'EVICTED') dtfxEvictedCount++;
            else if (r.eventType === 'GAP_RESET') dtfxGapResetCount++;
        } else if (r.source === 'PHL') {
            if (r.eventType === 'CREATED') phlCreatedCount++;
            else if (r.eventType === 'RETESTED') phlRetestedCount++;
            else if (r.eventType === 'BROKEN') phlBrokenCount++;
            else if (r.eventType === 'EVICTED') phlEvictedCount++;
            else if (r.eventType === 'SUPERSEDED') phlSupersededCount++;
            else if (r.eventType === 'GAP_RESET') phlGapResetCount++;
        } else {
            throw new Error(`V5 Lifecycle Accounting Error: unknown source '${String(r.source)}'.`);
        }
    }

    return Object.freeze({
        dtfxCreatedCount,
        dtfxRetestedCount,
        dtfxBrokenCount,
        dtfxEvictedCount,
        dtfxGapResetCount,
        phlCreatedCount,
        phlRetestedCount,
        phlBrokenCount,
        phlEvictedCount,
        phlSupersededCount,
        phlGapResetCount
    });
}

export function assertV5ZoneLifecycleManifestReconciliation(
    records: readonly V5ZoneLifecycleRecord[],
    manifestAccounting: V5ZoneLifecycleAccountingSummary
): void {
    const actual = summarizeV5ZoneLifecycleAccounting(records);
    const keys: readonly (keyof V5ZoneLifecycleAccountingSummary)[] = [
        'dtfxCreatedCount', 'dtfxRetestedCount', 'dtfxBrokenCount', 'dtfxEvictedCount', 'dtfxGapResetCount',
        'phlCreatedCount', 'phlRetestedCount', 'phlBrokenCount', 'phlEvictedCount', 'phlSupersededCount', 'phlGapResetCount'
    ];
    for (const k of keys) {
        if (actual[k] !== manifestAccounting[k]) {
            throw new Error(
                `V5 Lifecycle Reconciliation Error: manifest.${k} (${manifestAccounting[k]}) !== actual CSV count (${actual[k]}).`
            );
        }
    }
}
