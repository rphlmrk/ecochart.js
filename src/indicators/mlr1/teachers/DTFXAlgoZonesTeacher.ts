import type { ML1Candle } from '../ML1FeatureTypes';
import { createStrategyEvent, type StrategyEvent } from './StrategyEventTypes';

export const DTFX_TEACHER_VERSION = 'DTFX_ZONES_v1';

export interface DTFXConfig {
    readonly symbol: string;
    readonly timeframe: string;
    readonly intervalMs: number;
    readonly structureLen: number; // default 10
    readonly fibLevels: readonly [number, number, number]; // [0.3, 0.5, 0.7]
    readonly maxActiveZones: number; // default 256
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
    readonly firstRetestTimestamp: number | null;
    readonly lastRetestBarIndex: number | null;
    readonly lastRetestTimestamp: number | null;
    readonly isCurrentlyInZone: boolean;
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
    readonly open: number;
    readonly high: number;
    readonly low: number;
    readonly close: number;
    readonly volume: number;
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
        fibLevels: Object.freeze([0.3, 0.5, 0.7] as const),
        maxActiveZones: 256
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

export function validateDTFXConfig(config: DTFXConfig): void {
    if (!config || typeof config !== 'object') {
        throw new Error('DTFX Config Error: config must be an object.');
    }
    if (typeof config.symbol !== 'string' || config.symbol.trim() === '' ||
        typeof config.timeframe !== 'string' || config.timeframe.trim() === '') {
        throw new Error('DTFX Config Error: symbol and timeframe must be non-empty strings.');
    }
    if (!Number.isSafeInteger(config.intervalMs) || config.intervalMs <= 0) {
        throw new Error(`DTFX Config Error: intervalMs must be a positive safe integer, got ${config.intervalMs}.`);
    }
    if (!Number.isSafeInteger(config.structureLen) || config.structureLen < 2) {
        throw new Error(`DTFX Config Error: structureLen must be >= 2, got ${config.structureLen}.`);
    }
    if (!Number.isSafeInteger(config.maxActiveZones) || config.maxActiveZones < 1) {
        throw new Error(`DTFX Config Error: maxActiveZones must be >= 1, got ${config.maxActiveZones}.`);
    }
    if (!Array.isArray(config.fibLevels) || config.fibLevels.length !== 3) {
        throw new Error('DTFX Config Error: fibLevels must contain exactly 3 numeric levels.');
    }
    for (let i = 0; i < 3; i++) {
        const lvl = config.fibLevels[i];
        if (typeof lvl !== 'number' || !Number.isFinite(lvl) || lvl <= 0 || lvl >= 1) {
            throw new Error(`DTFX Config Error: fibLevels[${i}] must be finite strictly inside (0, 1), got ${lvl}.`);
        }
        if (i > 0 && lvl <= config.fibLevels[i - 1]) {
            throw new Error('DTFX Config Error: fibLevels must be strictly ascending without duplicates.');
        }
    }
}

function validateDTFXState(state: DTFXState, maxWin: number, maxActiveZones: number): void {
    if (!state || typeof state !== 'object' || state.stateVersion !== 1) {
        throw new Error('DTFX State Integrity Error: invalid DTFX state or stateVersion.');
    }
    if ((state.dir !== -1 && state.dir !== 0 && state.dir !== 1) ||
        (state.tDir !== -1 && state.tDir !== 0 && state.tDir !== 1)) {
        throw new Error('DTFX State Integrity Error: invalid dir or tDir.');
    }
    if (typeof state.bosUpCheck !== 'boolean' || typeof state.bosDownCheck !== 'boolean') {
        throw new Error('DTFX State Integrity Error: bosUpCheck and bosDownCheck must be booleans.');
    }
    if (!Number.isSafeInteger(state.nextZoneId) || state.nextZoneId < 1) {
        throw new Error('DTFX State Integrity Error: invalid nextZoneId.');
    }
    if (!Array.isArray(state.window) || state.window.length > maxWin) {
        throw new Error('DTFX State Integrity Error: invalid window container or length.');
    }

    let prevIdx = -1;
    let prevTime = -1;
    const windowByIdx = new Map<number, DTFXWindowBar>();
    for (const w of state.window) {
        if (!w || typeof w !== 'object' ||
            !Number.isSafeInteger(w.barIndex) || w.barIndex < 0 ||
            !Number.isSafeInteger(w.time) || w.time < 0 ||
            !Number.isFinite(w.open) || w.open <= 0 ||
            !Number.isFinite(w.high) || w.high <= 0 ||
            !Number.isFinite(w.low) || w.low <= 0 ||
            !Number.isFinite(w.close) || w.close <= 0 ||
            !Number.isFinite(w.volume) || w.volume < 0 ||
            w.high < w.low ||
            w.high < Math.max(w.open, w.close) ||
            w.low > Math.min(w.open, w.close)) {
            throw new Error('DTFX State Integrity Error: malformed OHLCV bar in window.');
        }
        if (prevIdx !== -1 && (w.barIndex <= prevIdx || w.time <= prevTime)) {
            throw new Error('DTFX State Integrity Error: window bars must be strictly chronological.');
        }
        windowByIdx.set(w.barIndex, w);
        prevIdx = w.barIndex;
        prevTime = w.time;
    }

    const maxBarIdx = prevIdx === -1 ? null : prevIdx;
    const maxTime = prevTime === -1 ? null : prevTime;

    for (const [label, pt, field] of [['t', state.t, 'high'], ['b', state.b, 'low']] as const) {
        if (pt !== null) {
            if (typeof pt !== 'object' || !Number.isFinite(pt.price) || pt.price <= 0 ||
                !Number.isSafeInteger(pt.barIndex) || pt.barIndex < 0 ||
                !Number.isSafeInteger(pt.time) || pt.time < 0 ||
                (maxBarIdx !== null && pt.barIndex > maxBarIdx) ||
                (maxTime !== null && pt.time > maxTime)) {
                throw new Error(`DTFX State Integrity Error: corrupted swing point '${label}'.`);
            }
            const wb = windowByIdx.get(pt.barIndex);
            if (wb !== undefined && (wb.time !== pt.time || wb[field] !== pt.price)) {
                throw new Error(`DTFX State Integrity Error: swing point '${label}' disagrees with window bar.`);
            }
        }
    }

    for (const [label, val] of [
        ['prevTPrice', state.prevTPrice],
        ['prevBPrice', state.prevBPrice],
        ['prevClose', state.prevClose]
    ] as const) {
        if (val !== null && (!Number.isFinite(val) || val <= 0)) {
            throw new Error(`DTFX State Integrity Error: corrupted ${label}.`);
        }
    }

    if (!Array.isArray(state.activeZones) || state.activeZones.length > maxActiveZones) {
        throw new Error(`DTFX State Integrity Error: activeZones must be an array with length <= ${maxActiveZones}.`);
    }
    const seenZoneIds = new Set<number>();
    for (const z of state.activeZones) {
        if (!z || typeof z !== 'object' ||
            !Number.isSafeInteger(z.zoneId) || z.zoneId < 1 || z.zoneId >= state.nextZoneId ||
            seenZoneIds.has(z.zoneId)) {
            throw new Error('DTFX State Integrity Error: invalid or duplicate zoneId in activeZones.');
        }
        seenZoneIds.add(z.zoneId);

        if ((z.direction !== 'bull' && z.direction !== 'bear') ||
            (z.status !== 'ACTIVE' && z.status !== 'RETESTED') ||
            typeof z.isCurrentlyInZone !== 'boolean' ||
            z.invalidationBarIndex !== null) {
            throw new Error(`DTFX State Integrity Error: invalid active zone status/direction for zone ${z.zoneId}.`);
        }
        if (!Number.isFinite(z.top) || !Number.isFinite(z.bot) || z.bot <= 0 || z.top <= z.bot) {
            throw new Error(`DTFX State Integrity Error: invalid zone geometry for zone ${z.zoneId}.`);
        }
        for (const f of [z.fib03, z.fib05, z.fib07]) {
            if (!Number.isFinite(f) || f <= z.bot || f >= z.top) {
                throw new Error(`DTFX State Integrity Error: fib level out of bounds for zone ${z.zoneId}.`);
            }
        }
        if (!Number.isSafeInteger(z.createdSourceBarIndex) || z.createdSourceBarIndex < 0 ||
            !Number.isSafeInteger(z.createdConfirmationBarIndex) ||
            z.createdConfirmationBarIndex < z.createdSourceBarIndex ||
            !Number.isSafeInteger(z.createdSourceTimestamp) || z.createdSourceTimestamp < 0 ||
            !Number.isSafeInteger(z.createdConfirmationTimestamp) ||
            z.createdConfirmationTimestamp < z.createdSourceTimestamp ||
            (maxBarIdx !== null && z.createdConfirmationBarIndex > maxBarIdx)) {
            throw new Error(`DTFX State Integrity Error: corrupted creation provenance for zone ${z.zoneId}.`);
        }
        const srcWb = windowByIdx.get(z.createdSourceBarIndex);
        if (srcWb !== undefined && srcWb.time !== z.createdSourceTimestamp) {
            throw new Error(`DTFX State Integrity Error: zone ${z.zoneId} createdSourceTimestamp disagrees with window bar.`);
        }
        const confWb = windowByIdx.get(z.createdConfirmationBarIndex);
        if (confWb !== undefined && confWb.time !== z.createdConfirmationTimestamp) {
            throw new Error(`DTFX State Integrity Error: zone ${z.zoneId} createdConfirmationTimestamp disagrees with window bar.`);
        }

        if (z.status === 'ACTIVE' &&
            (z.retestCount !== 0 ||
                z.firstRetestBarIndex !== null ||
                z.firstRetestTimestamp !== null ||
                z.lastRetestBarIndex !== null ||
                z.lastRetestTimestamp !== null ||
                z.isCurrentlyInZone)) {
            throw new Error(`DTFX State Integrity Error: ACTIVE zone ${z.zoneId} cannot have retest metadata.`);
        }
        if (z.status === 'RETESTED') {
            if (!Number.isSafeInteger(z.retestCount) || z.retestCount < 1 ||
                z.firstRetestBarIndex === null || z.firstRetestTimestamp === null ||
                z.lastRetestBarIndex === null || z.lastRetestTimestamp === null ||
                !Number.isSafeInteger(z.firstRetestBarIndex) || !Number.isSafeInteger(z.firstRetestTimestamp) ||
                !Number.isSafeInteger(z.lastRetestBarIndex) || !Number.isSafeInteger(z.lastRetestTimestamp) ||
                z.firstRetestBarIndex <= z.createdConfirmationBarIndex ||
                z.firstRetestTimestamp <= z.createdConfirmationTimestamp ||
                z.lastRetestBarIndex < z.firstRetestBarIndex ||
                z.lastRetestTimestamp < z.firstRetestTimestamp ||
                (z.retestCount === 1 && (z.lastRetestBarIndex !== z.firstRetestBarIndex || z.lastRetestTimestamp !== z.firstRetestTimestamp)) ||
                (z.retestCount > 1 && (z.lastRetestBarIndex <= z.firstRetestBarIndex || z.lastRetestTimestamp <= z.firstRetestTimestamp)) ||
                (maxBarIdx !== null && z.lastRetestBarIndex > maxBarIdx)) {
                throw new Error(`DTFX State Integrity Error: corrupted RETESTED metadata for zone ${z.zoneId}.`);
            }
            const firstRW = windowByIdx.get(z.firstRetestBarIndex);
            if (firstRW && (firstRW.time !== z.firstRetestTimestamp || firstRW.low > z.top || firstRW.high < z.bot)) {
                throw new Error(`DTFX State Integrity Error: zone ${z.zoneId} firstRetest disagrees with stored window bar.`);
            }
            const lastRW = windowByIdx.get(z.lastRetestBarIndex);
            if (lastRW && (lastRW.time !== z.lastRetestTimestamp || lastRW.low > z.top || lastRW.high < z.bot)) {
                throw new Error(`DTFX State Integrity Error: zone ${z.zoneId} lastRetest disagrees with stored window bar.`);
            }
        }
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
    validateDTFXConfig(config);
    const len = config.structureLen;
    validateDTFXState(previousState, len + 1, config.maxActiveZones);

    // 1. Validate discontinuity flag.
    if (typeof isDiscontinuity !== 'boolean') {
        throw new Error('DTFX Input Error: isDiscontinuity must be a boolean.');
    }

    // 2. Validate ATR.
    if (atr14AtConfirmation !== null &&
        (typeof atr14AtConfirmation !== 'number' || !Number.isFinite(atr14AtConfirmation) || atr14AtConfirmation <= 0)) {
        throw new Error('DTFX Input Error: atr14AtConfirmation must be null or a positive finite number.');
    }

    // 3. Validate candle and barIndex completely.
    if (!candle || typeof candle !== 'object' ||
        !Number.isSafeInteger(barIndex) || barIndex < 0 ||
        !Number.isSafeInteger(candle.time) || candle.time < 0 ||
        !Number.isFinite(candle.open) || candle.open <= 0 ||
        !Number.isFinite(candle.high) || candle.high <= 0 ||
        !Number.isFinite(candle.low) || candle.low <= 0 ||
        !Number.isFinite(candle.close) || candle.close <= 0 ||
        !Number.isFinite(candle.volume) || candle.volume < 0 ||
        candle.high < candle.low ||
        candle.high < Math.max(candle.open, candle.close) ||
        candle.low > Math.min(candle.open, candle.close)) {
        throw new Error(`DTFX Input Error: invalid candle OHLCV or barIndex (${barIndex}).`);
    }

    // 4. Only now is candle.time safe to access.
    if (entryTimestamp !== null &&
        (!Number.isSafeInteger(entryTimestamp) || entryTimestamp <= candle.time)) {
        throw new Error('DTFX Input Error: entryTimestamp must be null or a safe integer > candle.time.');
    }

    if (previousState.window.length > 0) {
        const prevBar = previousState.window[previousState.window.length - 1];
        if (barIndex <= prevBar.barIndex || candle.time <= prevBar.time) {
            throw new Error(
                `DTFX Chronology Error: incoming bar (${barIndex}, ${candle.time}) must strictly exceed previous (${prevBar.barIndex}, ${prevBar.time}).`
            );
        }
        const deltaMs = candle.time - prevBar.time;
        if (deltaMs < config.intervalMs || deltaMs % config.intervalMs !== 0) {
            throw new Error(
                `DTFX Chronology Error: timestamp delta (${deltaMs}) must be a positive multiple of intervalMs (${config.intervalMs}).`
            );
        }
    }

    // Preserve monotonic nextZoneId across discontinuities so eventIds never collide
    const baseState = isDiscontinuity
        ? createInitialDTFXState(previousState.nextZoneId)
        : previousState;

    const bar: DTFXWindowBar = Object.freeze({
        barIndex,
        time: candle.time,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: candle.volume
    });
    const nextWindow = Object.freeze([...baseState.window, bar].slice(-(len + 1)));

    const atrUsable =
        atr14AtConfirmation !== null && Number.isFinite(atr14AtConfirmation) && atr14AtConfirmation > 0;

    const events: StrategyEvent[] = [];
    const createdZones: DTFXZoneRecord[] = [];
    const retestedZones: DTFXZoneRecord[] = [];
    const invalidatedZones: DTFXZoneRecord[] = [];
    const remainingZones: DTFXZoneRecord[] = [];

    // 1. Evaluate existing active zones (Invalidation strictly precedes Retest; distinct-visit retests)
    for (const zone of baseState.activeZones) {
        const isInvalidated =
            zone.direction === 'bull' ? candle.close < zone.bot : candle.close > zone.top;

        if (isInvalidated) {
            invalidatedZones.push(
                Object.freeze({
                    ...zone,
                    status: 'INVALIDATED' as const,
                    isCurrentlyInZone: false,
                    invalidationBarIndex: barIndex
                })
            );
            continue;
        }

        const touchesZone = candle.low <= zone.top && candle.high >= zone.bot;
        if (touchesZone) {
            if (!zone.isCurrentlyInZone) {
                const nextRetestCount = zone.retestCount + 1;
                const retested: DTFXZoneRecord = Object.freeze({
                    ...zone,
                    status: 'RETESTED' as const,
                    retestCount: nextRetestCount,
                    isCurrentlyInZone: true,
                    firstRetestBarIndex: zone.firstRetestBarIndex ?? barIndex,
                    firstRetestTimestamp: zone.firstRetestTimestamp ?? candle.time,
                    lastRetestBarIndex: barIndex,
                    lastRetestTimestamp: candle.time
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
                        eventDiscriminator: `${zone.zoneId}_R${nextRetestCount}`,
                        sourceBarIndex: barIndex, // Retest candle itself, NOT creation pivot
                        sourceTimestamp: candle.time,
                        confirmationBarIndex: barIndex,
                        confirmationTimestamp: candle.time,
                        entryTimestamp,
                        structuralContext: {
                            zoneId: zone.zoneId,
                            zoneStatus: 'RETESTED',
                            retestCount: nextRetestCount,
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
        } else if (zone.isCurrentlyInZone) {
            remainingZones.push(
                Object.freeze({
                    ...zone,
                    isCurrentlyInZone: false
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
        if (Number.isFinite(zTop) && Number.isFinite(zBot) && zBot > 0 && zTop > zBot) {
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
                isCurrentlyInZone: false,
                firstRetestBarIndex: null,
                firstRetestTimestamp: null,
                lastRetestBarIndex: null,
                lastRetestTimestamp: null,
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
    }

    if (mssDown && b !== null) {
        bosDownCheck = false;
        const zTop = dir === 1 ? upper : dir === -1 && t !== null ? t.price : upper;
        const zBot = b.price;
        if (Number.isFinite(zTop) && Number.isFinite(zBot) && zBot > 0 && zTop > zBot) {
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
                isCurrentlyInZone: false,
                firstRetestBarIndex: null,
                firstRetestTimestamp: null,
                lastRetestBarIndex: null,
                lastRetestTimestamp: null,
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
    }

    const boundedZones =
        remainingZones.length > config.maxActiveZones
            ? remainingZones.slice(remainingZones.length - config.maxActiveZones)
            : remainingZones;

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
        activeZones: Object.freeze(boundedZones)
    });

    return {
        nextState,
        events: Object.freeze(events),
        createdZones: Object.freeze(createdZones),
        retestedZones: Object.freeze(retestedZones),
        invalidatedZones: Object.freeze(invalidatedZones)
    };
}
