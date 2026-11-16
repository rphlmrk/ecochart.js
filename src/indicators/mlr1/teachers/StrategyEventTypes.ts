import type { StrictZigZagPivot } from '../../plugins/StrictCBCZigZagIndicator';
import { STRICT_CBC_ZIGZAG_TEACHER_VERSION } from '../../plugins/StrictCBCZigZagIndicator';
import type { VAMStepOutput } from '../trend/VolatilityAdjustedMean';

export type StrategyId = 'STRICT_CBC' | 'PHL_BOS_MSS' | 'DTFX_ZONES' | 'VAM_REVERSAL';

export type StrategyEventType =
    | 'CBC_HIGH_HH'
    | 'CBC_HIGH_LH'
    | 'CBC_LOW_HL'
    | 'CBC_LOW_LL'
    | 'PHL_BOS_BULL'
    | 'PHL_BOS_BEAR'
    | 'PHL_MSS_BULL'
    | 'PHL_MSS_BEAR'
    | 'DTFX_DEMAND_CREATED'
    | 'DTFX_SUPPLY_CREATED'
    | 'DTFX_DEMAND_RETEST'
    | 'DTFX_SUPPLY_RETEST'
    | 'VAM_BUY'
    | 'VAM_SELL';

export type StrategyContextValue = number | string | boolean;

export interface StrategyEvent {
    readonly eventId: string;
    readonly eventDiscriminator: string;
    readonly strategyId: StrategyId;
    readonly strategyVersion: string;
    readonly eventType: StrategyEventType;
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

    readonly structuralContext: Readonly<Record<string, StrategyContextValue>>;
}

export interface CreateStrategyEventParams {
    readonly strategyId: StrategyId;
    readonly strategyVersion: string;
    readonly symbol: string;
    readonly timeframe: string;
    readonly intervalMs: number;
    readonly eventType: StrategyEventType;
    readonly eventDirection: 'bull' | 'bear';
    readonly eventDiscriminator: string;
    readonly sourceBarIndex: number;
    readonly sourceTimestamp: number;
    readonly confirmationBarIndex: number;
    readonly confirmationTimestamp: number;
    readonly entryTimestamp: number | null;
    readonly structuralContext: Readonly<Record<string, StrategyContextValue>>;
}

const STRATEGY_EVENT_ALLOWLIST: Readonly<Record<StrategyId, readonly StrategyEventType[]>> = Object.freeze({
    STRICT_CBC: Object.freeze(['CBC_HIGH_HH', 'CBC_HIGH_LH', 'CBC_LOW_HL', 'CBC_LOW_LL'] as const),
    PHL_BOS_MSS: Object.freeze(['PHL_BOS_BULL', 'PHL_BOS_BEAR', 'PHL_MSS_BULL', 'PHL_MSS_BEAR'] as const),
    DTFX_ZONES: Object.freeze([
        'DTFX_DEMAND_CREATED',
        'DTFX_SUPPLY_CREATED',
        'DTFX_DEMAND_RETEST',
        'DTFX_SUPPLY_RETEST'
    ] as const),
    VAM_REVERSAL: Object.freeze(['VAM_BUY', 'VAM_SELL'] as const)
});

export function buildStrategyEventId(params: {
    readonly strategyId: StrategyId;
    readonly strategyVersion: string;
    readonly symbol: string;
    readonly timeframe: string;
    readonly eventType: StrategyEventType;
    readonly sourceBarIndex: number;
    readonly confirmationBarIndex: number;
    readonly eventDiscriminator: string;
}): string {
    return `${params.strategyId}_${params.strategyVersion}_${params.symbol}_${params.timeframe}_${params.eventType}_${params.sourceBarIndex}_${params.confirmationBarIndex}_${params.eventDiscriminator}`;
}

export function createStrategyEvent(params: CreateStrategyEventParams): StrategyEvent {
    const allowed = STRATEGY_EVENT_ALLOWLIST[params.strategyId];
    if (!allowed || !allowed.includes(params.eventType)) {
        throw new Error(
            `StrategyEvent Contract Error: eventType '${params.eventType}' is invalid for strategy '${params.strategyId}'.`
        );
    }
    if (typeof params.strategyVersion !== 'string' || params.strategyVersion.trim() === '') {
        throw new Error('StrategyEvent Contract Error: strategyVersion must be a non-empty string.');
    }
    if (typeof params.symbol !== 'string' || params.symbol.trim() === '' ||
        typeof params.timeframe !== 'string' || params.timeframe.trim() === '') {
        throw new Error('StrategyEvent Contract Error: symbol and timeframe must be non-empty strings.');
    }
    if (typeof params.eventDiscriminator !== 'string' || params.eventDiscriminator.trim() === '') {
        throw new Error('StrategyEvent Contract Error: eventDiscriminator must be a non-empty string.');
    }
    if (!Number.isSafeInteger(params.intervalMs) || params.intervalMs <= 0) {
        throw new Error(`StrategyEvent Contract Error: intervalMs must be a positive safe integer, got ${params.intervalMs}.`);
    }
    if (!Number.isSafeInteger(params.sourceBarIndex) || params.sourceBarIndex < 0 ||
        !Number.isSafeInteger(params.confirmationBarIndex) || params.confirmationBarIndex < params.sourceBarIndex) {
        throw new Error(
            `StrategyEvent Contract Error: invalid bar indices (source=${params.sourceBarIndex}, confirmation=${params.confirmationBarIndex}).`
        );
    }
    if (!Number.isSafeInteger(params.sourceTimestamp) || params.sourceTimestamp < 0 ||
        !Number.isSafeInteger(params.confirmationTimestamp) || params.confirmationTimestamp < params.sourceTimestamp) {
        throw new Error(
            `StrategyEvent Contract Error: invalid timestamps (source=${params.sourceTimestamp}, confirmation=${params.confirmationTimestamp}).`
        );
    }

    const observationTimestamp = params.confirmationTimestamp + params.intervalMs;
    if (!Number.isSafeInteger(observationTimestamp)) {
        throw new Error('StrategyEvent Contract Error: observationTimestamp exceeds safe integer range.');
    }

    if (params.entryTimestamp !== null) {
        if (!Number.isSafeInteger(params.entryTimestamp) || params.entryTimestamp <= params.confirmationTimestamp) {
            throw new Error(
                `StrategyEvent Contract Error: entryTimestamp (${params.entryTimestamp}) must be null or strictly greater than confirmationTimestamp (${params.confirmationTimestamp}).`
            );
        }
    }

    const frozenContext: Record<string, StrategyContextValue> = {};
    for (const [key, value] of Object.entries(params.structuralContext)) {
        if (typeof value === 'number' && !Number.isFinite(value)) {
            throw new Error(`StrategyEvent Contract Error: non-finite structuralContext['${key}'].`);
        }
        if (typeof value !== 'number' && typeof value !== 'string' && typeof value !== 'boolean') {
            throw new Error(`StrategyEvent Contract Error: unsupported type in structuralContext['${key}'].`);
        }
        frozenContext[key] = value;
    }

    const eventId = buildStrategyEventId({
        strategyId: params.strategyId,
        strategyVersion: params.strategyVersion,
        symbol: params.symbol,
        timeframe: params.timeframe,
        eventType: params.eventType,
        sourceBarIndex: params.sourceBarIndex,
        confirmationBarIndex: params.confirmationBarIndex,
        eventDiscriminator: params.eventDiscriminator
    });

    return Object.freeze({
        eventId,
        eventDiscriminator: params.eventDiscriminator,
        strategyId: params.strategyId,
        strategyVersion: params.strategyVersion,
        eventType: params.eventType,
        eventDirection: params.eventDirection,
        sourceBarIndex: params.sourceBarIndex,
        sourceTimestamp: params.sourceTimestamp,
        confirmationBarIndex: params.confirmationBarIndex,
        confirmationTimestamp: params.confirmationTimestamp,
        confirmationLagBars: params.confirmationBarIndex - params.sourceBarIndex,
        observationBarIndex: params.confirmationBarIndex,
        observationTimestamp,
        entryBarIndex: params.confirmationBarIndex + 1,
        entryTimestamp: params.entryTimestamp,
        structuralContext: Object.freeze(frozenContext)
    });
}

function compareAscii(a: string, b: string): number {
    return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Deterministic ordering comparator: (confirmationBarIndex, strategyId, eventType, eventId).
 * Uses codepoint ordering to stay invariant across locales.
 */
export function compareStrategyEvents(a: StrategyEvent, b: StrategyEvent): number {
    if (a.confirmationBarIndex !== b.confirmationBarIndex) {
        return a.confirmationBarIndex - b.confirmationBarIndex;
    }
    const strategyCmp = compareAscii(a.strategyId, b.strategyId);
    if (strategyCmp !== 0) return strategyCmp;
    const typeCmp = compareAscii(a.eventType, b.eventType);
    if (typeCmp !== 0) return typeCmp;
    return compareAscii(a.eventId, b.eventId);
}

/**
 * Validates global eventId uniqueness and returns a frozen array in canonical deterministic order.
 */
export function sortAndVerifyUniqueStrategyEvents(
    events: readonly StrategyEvent[]
): readonly StrategyEvent[] {
    const seenIds = new Set<string>();
    for (const ev of events) {
        if (!ev || typeof ev.eventId !== 'string' || ev.eventId.trim() === '') {
            throw new Error('StrategyEvent Uniqueness Error: missing or invalid eventId.');
        }
        if (seenIds.has(ev.eventId)) {
            throw new Error(`StrategyEvent Collision Error: duplicate eventId '${ev.eventId}'.`);
        }
        seenIds.add(ev.eventId);
    }
    return Object.freeze([...events].sort(compareStrategyEvents));
}

/**
 * Resolves actual next accepted candle open timestamps without fabricating confirmationTimestamp + intervalMs across gaps.
 * Sets entryTimestamp = null if confirmationBarIndex is the final accepted bar.
 */
export function resolveStrategyEventsEntryTimestamps(
    events: readonly StrategyEvent[],
    acceptedTimestampsByBarIndex: readonly number[]
): readonly StrategyEvent[] {
    return Object.freeze(
        events.map(ev => {
            const actualNextTs =
                ev.entryBarIndex < acceptedTimestampsByBarIndex.length
                    ? acceptedTimestampsByBarIndex[ev.entryBarIndex]
                    : null;
            if (actualNextTs !== null && (!Number.isSafeInteger(actualNextTs) || actualNextTs <= ev.confirmationTimestamp)) {
                throw new Error(
                    `StrategyEvent Chronology Error: resolved entryTimestamp (${actualNextTs}) invalid for confirmationTimestamp (${ev.confirmationTimestamp}).`
                );
            }
            if (ev.entryTimestamp === actualNextTs) return ev;
            return Object.freeze({
                ...ev,
                entryTimestamp: actualNextTs
            });
        })
    );
}

// =========================================================================
// Adapter A: StrictCBCZigZag -> StrategyEvent
// =========================================================================

export function adaptStrictCBCtoStrategyEvent(params: {
    readonly pivot: StrictZigZagPivot;
    readonly prevPivot: StrictZigZagPivot | null;
    readonly confirmationTimestamp: number;
    readonly entryTimestamp: number | null;
    readonly atr14AtConfirmation: number | null;
    readonly symbol: string;
    readonly timeframe: string;
    readonly intervalMs: number;
}): StrategyEvent {
    const { pivot, prevPivot, atr14AtConfirmation } = params;
    const eventType: StrategyEventType =
        pivot.type === 'high'
            ? pivot.label === 'HH'
                ? 'CBC_HIGH_HH'
                : 'CBC_HIGH_LH'
            : pivot.label === 'HL'
              ? 'CBC_LOW_HL'
              : 'CBC_LOW_LL';

    const eventDirection: 'bull' | 'bear' = pivot.type === 'high' ? 'bear' : 'bull';
    const legDistanceAtr =
        prevPivot !== null && atr14AtConfirmation !== null && atr14AtConfirmation > 0
            ? (pivot.price - prevPivot.price) / atr14AtConfirmation
            : 0;

    return createStrategyEvent({
        strategyId: 'STRICT_CBC',
        strategyVersion: STRICT_CBC_ZIGZAG_TEACHER_VERSION,
        symbol: params.symbol,
        timeframe: params.timeframe,
        intervalMs: params.intervalMs,
        eventType,
        eventDirection,
        eventDiscriminator: String(pivot.id),
        sourceBarIndex: pivot.barIndex,
        sourceTimestamp: pivot.time,
        confirmationBarIndex: pivot.confirmedBarIndex,
        confirmationTimestamp: params.confirmationTimestamp,
        entryTimestamp: params.entryTimestamp,
        structuralContext: {
            pivotId: pivot.id,
            pivotType: pivot.type,
            pivotLabel: pivot.label,
            pivotPrice: pivot.price,
            hasPrevPivot: prevPivot !== null,
            prevPivotPrice: prevPivot ? prevPivot.price : 0,
            barsSinceLastPivot: prevPivot ? pivot.confirmedBarIndex - prevPivot.confirmedBarIndex : 0,
            legDistanceAtr
        }
    });
}

// =========================================================================
// Adapter D: VolatilityAdjustedMean -> StrategyEvent
// =========================================================================

export const VAM_TEACHER_VERSION = 'VAM_v1';

export function adaptVAMtoStrategyEvent(params: {
    readonly vamOutput: VAMStepOutput;
    readonly confirmationBarIndex: number;
    readonly confirmationTimestamp: number;
    readonly sourceBarIndex: number;
    readonly sourceTimestamp: number;
    readonly entryTimestamp: number | null;
    readonly symbol: string;
    readonly timeframe: string;
    readonly intervalMs: number;
}): StrategyEvent | null {
    const { vamOutput } = params;
    if (vamOutput.signal === 0) return null;

    const isBuy = vamOutput.signal === 1;
    return createStrategyEvent({
        strategyId: 'VAM_REVERSAL',
        strategyVersion: VAM_TEACHER_VERSION,
        symbol: params.symbol,
        timeframe: params.timeframe,
        intervalMs: params.intervalMs,
        eventType: isBuy ? 'VAM_BUY' : 'VAM_SELL',
        eventDirection: isBuy ? 'bull' : 'bear',
        eventDiscriminator: isBuy ? 'BUY' : 'SELL',
        sourceBarIndex: params.sourceBarIndex,
        sourceTimestamp: params.sourceTimestamp,
        confirmationBarIndex: params.confirmationBarIndex,
        confirmationTimestamp: params.confirmationTimestamp,
        entryTimestamp: params.entryTimestamp,
        structuralContext: {
            vamTrendPostTransition: vamOutput.trend,
            centerDistAtr: vamOutput.centerDistAtr,
            slope3Atr: vamOutput.slope3Atr,
            adx14: vamOutput.adx14,
            diSpread14: vamOutput.diSpread14,
            rsi14: vamOutput.rsi14,
            buyStreak: vamOutput.buyStreak,
            sellStreak: vamOutput.sellStreak
        }
    });
}
