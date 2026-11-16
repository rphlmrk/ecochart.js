import {
    createInitialStrictCBCState,
    stepStrictCBC,
    STRICT_CBC_ZIGZAG_TEACHER_VERSION,
    type StrictCBCCandle,
    type StrictCBCState,
    type StrictZigZagPivot
} from '../../plugins/StrictCBCZigZagIndicator';
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
    readonly acceptedTimestampsByBarIndex?: readonly number[];
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

function encodeLengthPrefixedField(raw: string): string {
    return `${raw.length}:${raw}`;
}

/**
 * Unambiguous prefix-free canonical event identity encoding.
 * Prevents collisions across delimiters ('_', '|', ':') or variable-length segments.
 */
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
    const parts = [
        params.strategyId,
        params.strategyVersion,
        params.symbol,
        params.timeframe,
        params.eventType,
        String(params.sourceBarIndex),
        String(params.confirmationBarIndex),
        params.eventDiscriminator
    ];
    return `SE1|${parts.map(encodeLengthPrefixedField).join('|')}`;
}

export function validateAcceptedTimestampsSequence(
    acceptedTimestampsByBarIndex: readonly number[]
): void {
    if (!Array.isArray(acceptedTimestampsByBarIndex)) {
        throw new Error('StrategyEvent Chronology Error: acceptedTimestampsByBarIndex must be an array.');
    }
    let prev = -1;
    for (let i = 0; i < acceptedTimestampsByBarIndex.length; i++) {
        const ts = acceptedTimestampsByBarIndex[i];
        if (!Number.isSafeInteger(ts) || ts < 0) {
            throw new Error(
                `StrategyEvent Chronology Error: invalid accepted timestamp at index ${i} (${ts}).`
            );
        }
        if (i > 0 && ts <= prev) {
            throw new Error(
                `StrategyEvent Chronology Error: accepted timestamps must be strictly ascending (index ${i}: ${ts} <= ${prev}).`
            );
        }
        prev = ts;
    }
}

export function createStrategyEvent(params: CreateStrategyEventParams): StrategyEvent {
    const allowed = STRATEGY_EVENT_ALLOWLIST[params.strategyId];
    if (!allowed || !allowed.includes(params.eventType)) {
        throw new Error(
            `StrategyEvent Contract Error: eventType '${params.eventType}' is invalid for strategy '${params.strategyId}'.`
        );
    }
    if (params.eventDirection !== 'bull' && params.eventDirection !== 'bear') {
        throw new Error(
            `StrategyEvent Contract Error: eventDirection must be 'bull' or 'bear', got '${String(params.eventDirection)}'.`
        );
    }
    for (const [name, val] of [
        ['strategyVersion', params.strategyVersion],
        ['symbol', params.symbol],
        ['timeframe', params.timeframe],
        ['eventDiscriminator', params.eventDiscriminator]
    ] as const) {
        if (typeof val !== 'string' || val.trim() === '' || /[\r\n\0]/.test(val)) {
            throw new Error(`StrategyEvent Contract Error: ${name} must be a valid non-empty single-line string.`);
        }
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

    if (params.strategyId === 'VAM_REVERSAL') {
        if (params.sourceBarIndex !== params.confirmationBarIndex ||
            params.sourceTimestamp !== params.confirmationTimestamp) {
            throw new Error(
                'StrategyEvent Chronology Error: VAM_REVERSAL must have sourceBarIndex === confirmationBarIndex and sourceTimestamp === confirmationTimestamp.'
            );
        }
    }

    const entryBarIndex = params.confirmationBarIndex + 1;
    if (!Number.isSafeInteger(entryBarIndex)) {
        throw new Error('StrategyEvent Contract Error: entryBarIndex exceeds safe integer range.');
    }

    if (params.acceptedTimestampsByBarIndex !== undefined) {
        validateAcceptedTimestampsSequence(params.acceptedTimestampsByBarIndex);
        if (params.confirmationBarIndex >= params.acceptedTimestampsByBarIndex.length) {
            throw new Error('StrategyEvent Chronology Error: confirmationBarIndex out of accepted timestamps bounds.');
        }
        if (params.acceptedTimestampsByBarIndex[params.sourceBarIndex] !== params.sourceTimestamp) {
            throw new Error('StrategyEvent Chronology Error: sourceTimestamp disagrees with accepted clock.');
        }
        if (params.acceptedTimestampsByBarIndex[params.confirmationBarIndex] !== params.confirmationTimestamp) {
            throw new Error('StrategyEvent Chronology Error: confirmationTimestamp disagrees with accepted clock.');
        }
        if (params.entryTimestamp !== null) {
            const expectedEntryTs =
                entryBarIndex < params.acceptedTimestampsByBarIndex.length
                    ? params.acceptedTimestampsByBarIndex[entryBarIndex]
                    : null;
            if (params.entryTimestamp !== expectedEntryTs) {
                throw new Error(
                    `StrategyEvent Chronology Error: entryTimestamp (${params.entryTimestamp}) disagrees with accepted clock at index ${entryBarIndex} (${String(expectedEntryTs)}).`
                );
            }
        }
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

    if (params.structuralContext === null || typeof params.structuralContext !== 'object' ||
        Array.isArray(params.structuralContext)) {
        throw new Error('StrategyEvent Contract Error: structuralContext must be a non-null plain object.');
    }
    const proto = Object.getPrototypeOf(params.structuralContext);
    if (proto !== Object.prototype && proto !== null) {
        throw new Error('StrategyEvent Contract Error: structuralContext must be a plain object.');
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
        entryBarIndex,
        entryTimestamp: params.entryTimestamp,
        structuralContext: Object.freeze(frozenContext)
    });
}

function compareAscii(a: string, b: string): number {
    return a < b ? -1 : a > b ? 1 : 0;
}

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
 * Validates the complete accepted timestamp clock, checks each event's source & confirmation indices/timestamps,
 * and resolves actual next accepted candle open timestamps (setting entryTimestamp = null on final bar).
 */
export function resolveStrategyEventsEntryTimestamps(
    events: readonly StrategyEvent[],
    acceptedTimestampsByBarIndex: readonly number[],
    expectedIntervalMs?: number
): readonly StrategyEvent[] {
    validateAcceptedTimestampsSequence(acceptedTimestampsByBarIndex);

    if (expectedIntervalMs !== undefined) {
        if (!Number.isSafeInteger(expectedIntervalMs) || expectedIntervalMs <= 0) {
            throw new Error(
                `StrategyEvent Chronology Error: expectedIntervalMs must be a positive safe integer, got ${expectedIntervalMs}.`
            );
        }
        for (let i = 1; i < acceptedTimestampsByBarIndex.length; i++) {
            const deltaMs = acceptedTimestampsByBarIndex[i] - acceptedTimestampsByBarIndex[i - 1];
            if (deltaMs < expectedIntervalMs || deltaMs % expectedIntervalMs !== 0) {
                throw new Error(
                    `StrategyEvent Chronology Error: timestamp delta (${deltaMs}) at index ${i} is not a positive multiple of intervalMs (${expectedIntervalMs}).`
                );
            }
        }
    }

    return Object.freeze(
        events.map(ev => {
            if (!Number.isSafeInteger(ev.confirmationBarIndex) ||
                ev.confirmationBarIndex < 0 ||
                ev.confirmationBarIndex >= acceptedTimestampsByBarIndex.length) {
                throw new Error(
                    `StrategyEvent Chronology Error: confirmationBarIndex ${ev.confirmationBarIndex} out of bounds [0, ${acceptedTimestampsByBarIndex.length - 1}].`
                );
            }
            if (!Number.isSafeInteger(ev.sourceBarIndex) ||
                ev.sourceBarIndex < 0 ||
                ev.sourceBarIndex > ev.confirmationBarIndex) {
                throw new Error(
                    `StrategyEvent Chronology Error: invalid sourceBarIndex ${ev.sourceBarIndex} for confirmationBarIndex ${ev.confirmationBarIndex}.`
                );
            }
            if (acceptedTimestampsByBarIndex[ev.confirmationBarIndex] !== ev.confirmationTimestamp) {
                throw new Error(
                    `StrategyEvent Chronology Error: event confirmationTimestamp (${ev.confirmationTimestamp}) disagrees with accepted clock at index ${ev.confirmationBarIndex} (${acceptedTimestampsByBarIndex[ev.confirmationBarIndex]}).`
                );
            }
            if (acceptedTimestampsByBarIndex[ev.sourceBarIndex] !== ev.sourceTimestamp) {
                throw new Error(
                    `StrategyEvent Chronology Error: event sourceTimestamp (${ev.sourceTimestamp}) disagrees with accepted clock at index ${ev.sourceBarIndex} (${acceptedTimestampsByBarIndex[ev.sourceBarIndex]}).`
                );
            }
            if (ev.strategyId === 'VAM_REVERSAL' &&
                (ev.sourceBarIndex !== ev.confirmationBarIndex || ev.sourceTimestamp !== ev.confirmationTimestamp)) {
                throw new Error(
                    'StrategyEvent Chronology Error: VAM_REVERSAL event must have source === confirmation bar/timestamp.'
                );
            }
            if (ev.observationBarIndex !== ev.confirmationBarIndex) {
                throw new Error(
                    `StrategyEvent Chronology Error: invalid observationBarIndex ${ev.observationBarIndex} (expected ${ev.confirmationBarIndex}).`
                );
            }
            if (ev.confirmationLagBars !== ev.confirmationBarIndex - ev.sourceBarIndex) {
                throw new Error(
                    `StrategyEvent Chronology Error: invalid confirmationLagBars ${ev.confirmationLagBars}.`
                );
            }
            if (expectedIntervalMs !== undefined) {
                const expectedObsTs = ev.confirmationTimestamp + expectedIntervalMs;
                if (!Number.isSafeInteger(expectedObsTs) || ev.observationTimestamp !== expectedObsTs) {
                    throw new Error(
                        `StrategyEvent Chronology Error: observationTimestamp (${ev.observationTimestamp}) disagrees with confirmationTimestamp + expectedIntervalMs (${expectedObsTs}).`
                    );
                }
            } else if (!Number.isSafeInteger(ev.observationTimestamp) || ev.observationTimestamp <= ev.confirmationTimestamp) {
                throw new Error(
                    `StrategyEvent Chronology Error: invalid observationTimestamp ${ev.observationTimestamp}.`
                );
            }
            if (!Number.isSafeInteger(ev.entryBarIndex) || ev.entryBarIndex !== ev.confirmationBarIndex + 1) {
                throw new Error(
                    `StrategyEvent Chronology Error: invalid entryBarIndex ${ev.entryBarIndex} (expected ${ev.confirmationBarIndex + 1}).`
                );
            }

            const actualNextTs =
                ev.entryBarIndex < acceptedTimestampsByBarIndex.length
                    ? acceptedTimestampsByBarIndex[ev.entryBarIndex]
                    : null;
            if (ev.entryTimestamp === actualNextTs) return ev;
            return Object.freeze({
                ...ev,
                entryTimestamp: actualNextTs
            });
        })
    );
}

// =========================================================================
// Adapter A: StrictCBCZigZag -> StrategyEvent (With Discontinuity Reset)
// =========================================================================

/**
 * Pure discontinuity-aware StrictCBC wrapper.
 * Does NOT modify frozen StrictCBCZigZagIndicator.ts; resets anchor/phase state and prevPivot
 * on discontinuity while keeping nextPivotId strictly monotonic.
 */
export function stepStrictCBCWithReset(
    candle: StrictCBCCandle,
    barIndex: number,
    previousState: StrictCBCState | null,
    previousPivot: StrictZigZagPivot | null,
    isDiscontinuity: boolean
): {
    readonly nextState: StrictCBCState;
    readonly confirmedPivot: StrictZigZagPivot | null;
    readonly prevPivotForEvent: StrictZigZagPivot | null;
    readonly nextPrevPivot: StrictZigZagPivot | null;
} {
    if (barIndex === 0 || previousState === null || isDiscontinuity) {
        const nextPivotId = previousState ? previousState.nextPivotId : 1;
        const resetState: StrictCBCState = {
            ...createInitialStrictCBCState(candle),
            phaseHighIdx: barIndex,
            phaseLowIdx: barIndex,
            nextPivotId
        };
        return {
            nextState: resetState,
            confirmedPivot: null,
            prevPivotForEvent: null,
            nextPrevPivot: null
        };
    }

    const stepRes = stepStrictCBC(candle, barIndex, previousState);
    return {
        nextState: stepRes.nextState,
        confirmedPivot: stepRes.confirmedPivot,
        prevPivotForEvent: previousPivot,
        nextPrevPivot: stepRes.confirmedPivot ?? previousPivot
    };
}

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

    if (!pivot || typeof pivot !== 'object' ||
        !Number.isSafeInteger(pivot.id) || pivot.id < 1 ||
        !Number.isFinite(pivot.price) || pivot.price <= 0 ||
        !Number.isSafeInteger(pivot.barIndex) || pivot.barIndex < 0 ||
        !Number.isSafeInteger(pivot.confirmedBarIndex) || pivot.confirmedBarIndex < pivot.barIndex ||
        !Number.isSafeInteger(pivot.time) || pivot.time < 0) {
        throw new Error('StrictCBC Adapter Error: invalid pivot metadata.');
    }
    if (atr14AtConfirmation !== null &&
        (!Number.isFinite(atr14AtConfirmation) || atr14AtConfirmation <= 0)) {
        throw new Error(
            `StrictCBC Adapter Error: atr14AtConfirmation must be null or a positive finite number, got ${atr14AtConfirmation}.`
        );
    }
    if (prevPivot !== null) {
        if (!Number.isFinite(prevPivot.price) || prevPivot.price <= 0 ||
            !Number.isSafeInteger(prevPivot.confirmedBarIndex) || prevPivot.confirmedBarIndex < 0 ||
            prevPivot.confirmedBarIndex > pivot.confirmedBarIndex) {
            throw new Error('StrictCBC Adapter Error: invalid prevPivot metadata.');
        }
    }

    let eventType: StrategyEventType;
    let eventDirection: 'bull' | 'bear';

    if (pivot.type === 'high') {
        if (pivot.label === 'HH') eventType = 'CBC_HIGH_HH';
        else if (pivot.label === 'LH') eventType = 'CBC_HIGH_LH';
        else throw new Error(`StrictCBC Adapter Error: invalid label '${pivot.label}' for high pivot.`);
        eventDirection = 'bear';
    } else if (pivot.type === 'low') {
        if (pivot.label === 'HL') eventType = 'CBC_LOW_HL';
        else if (pivot.label === 'LL') eventType = 'CBC_LOW_LL';
        else throw new Error(`StrictCBC Adapter Error: invalid label '${pivot.label}' for low pivot.`);
        eventDirection = 'bull';
    } else {
        throw new Error(`StrictCBC Adapter Error: unsupported pivot.type '${String((pivot as any).type)}'.`);
    }

    const legDistanceAtr =
        prevPivot !== null && atr14AtConfirmation !== null
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

/**
 * Synchronous bar-close signal adapter: sourceBarIndex === confirmationBarIndex (lag 0).
 */
export function adaptVAMtoStrategyEvent(params: {
    readonly vamOutput: VAMStepOutput;
    readonly confirmationBarIndex: number;
    readonly confirmationTimestamp: number;
    readonly entryTimestamp: number | null;
    readonly symbol: string;
    readonly timeframe: string;
    readonly intervalMs: number;
}): StrategyEvent | null {
    const { vamOutput } = params;
    if (vamOutput.signal === 0) return null;
    if (vamOutput.signal !== 1 && vamOutput.signal !== -1) {
        throw new Error(`VAM Adapter Error: unexpected signal value ${String(vamOutput.signal)}.`);
    }

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
        sourceBarIndex: params.confirmationBarIndex,
        sourceTimestamp: params.confirmationTimestamp,
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
