import type { ML1Candle } from '../ML1FeatureTypes';
import { createStrategyEvent, type StrategyEvent } from './StrategyEventTypes';

export const DTFX_TEACHER_VERSION = 'DTFX_ZONES_v1';

export interface DTFXConfig {
    readonly symbol: string;
    readonly timeframe: string;
    readonly intervalMs: number;
    readonly structureLen: number; // default 10
    readonly fibLevels: readonly [number, number, number]; // [0.3, 0.5, 0.7]
}

export type DTFXZoneStatus = 'ACTIVE' | 'RETESTED' | 'INVALIDATED';

export interface DTFXZoneRecord {
    readonly zoneId: number;
    readonly direction: 'bull' | 'bear';
    readonly top: number;
    readonly bot: number;
    readonly fib03: number;
    readonly fib05: number;
    readonly fib07: number;
    readonly createdSourceBarIndex: number;
    readonly createdSourceTimestamp: number;
    readonly createdConfirmationBarIndex: number;
    readonly createdConfirmationTimestamp: number;
    readonly status: DTFXZoneStatus;
    readonly retestCount: number;
    readonly firstRetestBarIndex: number | null;
    readonly invalidationBarIndex: number | null;
}

export interface DTFXSwingPoint {
    readonly price: number;
    readonly barIndex: number;
    readonly time: number;
}

export interface DTFXWindowBar {
    readonly barIndex: number;
    readonly time: number;
    readonly high: number;
    readonly low: number;
    readonly close: number;
}

export interface DTFXState {
    readonly stateVersion: 1;
    readonly window: readonly DTFXWindowBar[];
    readonly dir: -1 | 0 | 1;
    readonly tDir: -1 | 0 | 1;
    readonly t: DTFXSwingPoint | null;
    readonly b: DTFXSwingPoint | null;
    readonly prevTPrice: number | null;
    readonly prevBPrice: number | null;
    readonly prevClose: number | null;
    readonly bosUpCheck: boolean;
    readonly bosDownCheck: boolean;
    readonly nextZoneId: number;
    readonly activeZones: readonly DTFXZoneRecord[];
}

export interface DTFXStepResult {
    readonly nextState: DTFXState;
    readonly events: readonly StrategyEvent[];
    readonly createdZones: readonly DTFXZoneRecord[];
    readonly retestedZones: readonly DTFXZoneRecord[];
    readonly invalidatedZones: readonly DTFXZoneRecord[];
}

export function createDefaultDTFXConfig(
    symbol = 'SOLUSDT',
    timeframe = '1m',
    intervalMs = 60_000
): DTFXConfig {
    return Object.freeze({
        symbol,
        timeframe,
        intervalMs,
        structureLen: 10,
        fibLevels: Object.freeze([0.3, 0.5, 0.7] as const)
    });
}

export function createInitialDTFXState(nextZoneId = 1): DTFXState {
    return Object.freeze({
        stateVersion: 1 as const,
        window: Object.freeze([]),
        dir: 0 as const,
        tDir: 0 as const,
        t: null,
        b: null,
        prevTPrice: null,
        prevBPrice: null,
        prevClose: null,
        bosUpCheck: false,
        bosDownCheck: false,
        nextZoneId,
        activeZones: Object.freeze([])
    });
}

function validateDTFXState(state: DTFXState, maxWin: number): void {
    if (!state || state.stateVersion !== 1 || !Array.isArray(state.window) ||
        state.window.length > maxWin || !Array.isArray(state.activeZones) ||
        !Number.isSafeInteger(state.nextZoneId) || state.nextZoneId < 1) {
        throw new Error('DTFX State Integrity Error: invalid DTFX state structure.');
    }
}

function computeFibs(
    top: number,
    bot: number,
    dirFlag: 1 | -1,
    levels: readonly [number, number, number]
): [number, number, number] {
    const rng = dirFlag === 1 ? top - bot : bot - top;
    const anchor = dirFlag === 1 ? bot : top;
    return [anchor + rng * levels[0], anchor + rng * levels[1], anchor + rng * levels[2]];
}

export function stepDTFX(
    candle: ML1Candle,
    barIndex: number,
    previousState: DTFXState,
    config: DTFXConfig,
    isDiscontinuity = false,
    atr14AtConfirmation: number | null = null,
    entryTimestamp: number | null = null
): DTFXStepResult {
    const len = config.structureLen;
    if (!Number.isSafeInteger(len) || len < 2) {
        throw new Error(`DTFX Config Error: structureLen must be >= 2, got ${len}.`);
    }
    validateDTFXState(previousState, len + 1);

    // Preserve monotonic nextZoneId across discontinuities so eventIds never collide
    const baseState = isDiscontinuity
        ? createInitialDTFXState(previousState.nextZoneId)
        : previousState;

    const bar: DTFXWindowBar = Object.freeze({
        barIndex,
        time: candle.time,
        high: candle.high,
        low: candle.low,
        close: candle.close
    });
    const nextWindow = Object.freeze([...baseState.window, bar].slice(-(len + 1)));

    const atrUsable =
        atr14AtConfirmation !== null && Number.isFinite(atr14AtConfirmation) && atr14AtConfirmation > 0;

    const events: StrategyEvent[] = [];
    const createdZones: DTFXZoneRecord[] = [];
    const retestedZones: DTFXZoneRecord[] = [];
    const invalidatedZones: DTFXZoneRecord[] = [];
    const remainingZones: DTFXZoneRecord[] = [];

    // 1. Evaluate existing active zones (Invalidation strictly precedes Retest on same bar)
    for (const zone of baseState.activeZones) {
        const isInvalidated =
            zone.direction === 'bull' ? candle.close < zone.bot : candle.close > zone.top;

        if (isInvalidated) {
            invalidatedZones.push(
                Object.freeze({
                    ...zone,
                    status: 'INVALIDATED' as const,
                    invalidationBarIndex: barIndex
                })
            );
            continue;
        }

        const touchesZone = candle.low <= zone.top && candle.high >= zone.bot;
        if (touchesZone && zone.retestCount === 0) {
            const retested: DTFXZoneRecord = Object.freeze({
                ...zone,
                status: 'RETESTED' as const,
                retestCount: 1,
                firstRetestBarIndex: barIndex
            });
            retestedZones.push(retested);
            remainingZones.push(retested);

            const zoneWidthAtr = atrUsable ? (zone.top - zone.bot) / atr14AtConfirmation! : 0;
            const fib05DistAtr = atrUsable ? (candle.close - zone.fib05) / atr14AtConfirmation! : 0;

            events.push(
                createStrategyEvent({
                    strategyId: 'DTFX_ZONES',
                    strategyVersion: DTFX_TEACHER_VERSION,
                    symbol: config.symbol,
                    timeframe: config.timeframe,
                    intervalMs: config.intervalMs,
                    eventType: zone.direction === 'bull' ? 'DTFX_DEMAND_RETEST' : 'DTFX_SUPPLY_RETEST',
                    eventDirection: zone.direction,
                    eventDiscriminator: `${zone.zoneId}_R1`,
                    sourceBarIndex: barIndex, // Retest candle itself, NOT creation pivot
                    sourceTimestamp: candle.time,
                    confirmationBarIndex: barIndex,
                    confirmationTimestamp: candle.time,
                    entryTimestamp,
                    structuralContext: {
                        zoneId: zone.zoneId,
                        zoneStatus: 'RETESTED',
                        retestCount: 1,
                        zoneCreatedSourceBarIndex: zone.createdSourceBarIndex,
                        zoneCreatedConfirmationBarIndex: zone.createdConfirmationBarIndex,
                        zoneTop: zone.top,
                        zoneBot: zone.bot,
                        fib03: zone.fib03,
                        fib05: zone.fib05,
                        fib07: zone.fib07,
                        zoneWidthAtr,
                        fib05DistAtr
                    }
                })
            );
        } else {
            remainingZones.push(zone);
        }
    }

    // 2. Swing confirmation & upper/lower window (matches dtfx.txt lines 102-119)
    let dir = baseState.dir;
    let tDir = baseState.tDir;
    let t = baseState.t;
    let b = baseState.b;
    let bosUpCheck = baseState.bosUpCheck;
    let bosDownCheck = baseState.bosDownCheck;
    let nextZoneId = baseState.nextZoneId;

    // upper / lower over the most recent `len` bars [i - len + 1 .. i]
    const recentSlice = nextWindow.slice(-len);
    let upper = -Infinity;
    let lower = Infinity;
    for (const w of recentSlice) {
        if (w.high > upper) upper = w.high;
        if (w.low < lower) lower = w.low;
    }

    if (nextWindow.length === len + 1) {
        const cand = nextWindow[0]; // bar_index - structureLen
        if (dir >= 0 && cand.high > upper) {
            dir = -1;
            t = Object.freeze({ price: cand.high, barIndex: cand.barIndex, time: cand.time });
            bosUpCheck = true;
        }
        if (dir <= 0 && cand.low < lower) {
            dir = 1;
            b = Object.freeze({ price: cand.low, barIndex: cand.barIndex, time: cand.time });
            bosDownCheck = true;
        }
    }

    // 3. Crossover / Crossunder MSS & BOS triggers (matches dtfx.txt lines 135-177)
    const crossoverUp =
        baseState.prevClose !== null &&
        baseState.prevTPrice !== null &&
        t !== null &&
        baseState.prevClose <= baseState.prevTPrice &&
        candle.close > t.price;

    const crossunderDown =
        baseState.prevClose !== null &&
        baseState.prevBPrice !== null &&
        b !== null &&
        baseState.prevClose >= baseState.prevBPrice &&
        candle.close < b.price;

    const chochUp = crossoverUp && candle.high === upper && tDir <= 0;
    const chochDown = crossunderDown && candle.low === lower && tDir >= 0;

    if (chochUp) tDir = 1;
    if (chochDown) tDir = -1;

    const bosUp = crossoverUp && bosUpCheck && tDir >= 0;
    const bosDown = crossunderDown && bosDownCheck && tDir <= 0;

    const mssUp = bosUp || chochUp;
    const mssDown = bosDown || chochDown;

    if (mssUp && t !== null) {
        bosUpCheck = false;
        const zTop = t.price;
        const zBot = dir === -1 ? lower : dir === 1 && b !== null ? b.price : lower;
        const [fib03, fib05, fib07] = computeFibs(zTop, zBot, 1, config.fibLevels);

        const zone: DTFXZoneRecord = Object.freeze({
            zoneId: nextZoneId++,
            direction: 'bull',
            top: zTop,
            bot: zBot,
            fib03,
            fib05,
            fib07,
            createdSourceBarIndex: t.barIndex,
            createdSourceTimestamp: t.time,
            createdConfirmationBarIndex: barIndex,
            createdConfirmationTimestamp: candle.time,
            status: 'ACTIVE',
            retestCount: 0,
            firstRetestBarIndex: null,
            invalidationBarIndex: null
        });
        remainingZones.push(zone);
        createdZones.push(zone);

        const zoneWidthAtr = atrUsable ? (zTop - zBot) / atr14AtConfirmation! : 0;
        const fib05DistAtr = atrUsable ? (candle.close - fib05) / atr14AtConfirmation! : 0;

        events.push(
            createStrategyEvent({
                strategyId: 'DTFX_ZONES',
                strategyVersion: DTFX_TEACHER_VERSION,
                symbol: config.symbol,
                timeframe: config.timeframe,
                intervalMs: config.intervalMs,
                eventType: 'DTFX_DEMAND_CREATED',
                eventDirection: 'bull',
                eventDiscriminator: String(zone.zoneId),
                sourceBarIndex: t.barIndex,
                sourceTimestamp: t.time,
                confirmationBarIndex: barIndex,
                confirmationTimestamp: candle.time,
                entryTimestamp,
                structuralContext: {
                    zoneId: zone.zoneId,
                    zoneStatus: 'ACTIVE',
                    isChoch: chochUp,
                    zoneTop: zTop,
                    zoneBot: zBot,
                    fib03,
                    fib05,
                    fib07,
                    zoneWidthAtr,
                    fib05DistAtr
                }
            })
        );
    }

    if (mssDown && b !== null) {
        bosDownCheck = false;
        const zTop = dir === 1 ? upper : dir === -1 && t !== null ? t.price : upper;
        const zBot = b.price;
        const [fib03, fib05, fib07] = computeFibs(zTop, zBot, -1, config.fibLevels);

        const zone: DTFXZoneRecord = Object.freeze({
            zoneId: nextZoneId++,
            direction: 'bear',
            top: zTop,
            bot: zBot,
            fib03,
            fib05,
            fib07,
            createdSourceBarIndex: b.barIndex,
            createdSourceTimestamp: b.time,
            createdConfirmationBarIndex: barIndex,
            createdConfirmationTimestamp: candle.time,
            status: 'ACTIVE',
            retestCount: 0,
            firstRetestBarIndex: null,
            invalidationBarIndex: null
        });
        remainingZones.push(zone);
        createdZones.push(zone);

        const zoneWidthAtr = atrUsable ? (zTop - zBot) / atr14AtConfirmation! : 0;
        const fib05DistAtr = atrUsable ? (candle.close - fib05) / atr14AtConfirmation! : 0;

        events.push(
            createStrategyEvent({
                strategyId: 'DTFX_ZONES',
                strategyVersion: DTFX_TEACHER_VERSION,
                symbol: config.symbol,
                timeframe: config.timeframe,
                intervalMs: config.intervalMs,
                eventType: 'DTFX_SUPPLY_CREATED',
                eventDirection: 'bear',
                eventDiscriminator: String(zone.zoneId),
                sourceBarIndex: b.barIndex,
                sourceTimestamp: b.time,
                confirmationBarIndex: barIndex,
                confirmationTimestamp: candle.time,
                entryTimestamp,
                structuralContext: {
                    zoneId: zone.zoneId,
                    zoneStatus: 'ACTIVE',
                    isChoch: chochDown,
                    zoneTop: zTop,
                    zoneBot: zBot,
                    fib03,
                    fib05,
                    fib07,
                    zoneWidthAtr,
                    fib05DistAtr
                }
            })
        );
    }

    const nextState: DTFXState = Object.freeze({
        stateVersion: 1 as const,
        window: nextWindow,
        dir,
        tDir,
        t,
        b,
        prevTPrice: t ? t.price : null,
        prevBPrice: b ? b.price : null,
        prevClose: candle.close,
        bosUpCheck,
        bosDownCheck,
        nextZoneId,
        activeZones: Object.freeze(remainingZones)
    });

    return {
        nextState,
        events: Object.freeze(events),
        createdZones: Object.freeze(createdZones),
        retestedZones: Object.freeze(retestedZones),
        invalidatedZones: Object.freeze(invalidatedZones)
    };
}
