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

export interface DTFXClockCheckpoint {
    readonly barIndex: number;
    readonly time: number;
}

export interface DTFXState {
    readonly stateVersion: 1;
    readonly clockCheckpoints: readonly DTFXClockCheckpoint[];
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
        clockCheckpoints: Object.freeze([]),
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

function resolveExpectedDTFXTime(
    barIndex: number,
    checkpoints: readonly DTFXClockCheckpoint[],
    intervalMs: number
): number | null {
    if (checkpoints.length === 0 || barIndex < checkpoints[0].barIndex) return null;
    let activeCp = checkpoints[0];
    for (let i = 1; i < checkpoints.length; i++) {
        if (checkpoints[i].barIndex <= barIndex) {
            activeCp = checkpoints[i];
        } else {
            break;
        }
    }
    return activeCp.time + (barIndex - activeCp.barIndex) * intervalMs;
}

export function validateDTFXState(
    state: DTFXState,
    maxWin: number,
    maxActiveZones: number,
    intervalMs: number
): void {
    if (!Number.isSafeInteger(maxWin) || maxWin < 2) {
        throw new Error(`DTFX State Integrity Error: maxWin must be an integer >= 2, got ${maxWin}.`);
    }
    if (!Number.isSafeInteger(maxActiveZones) || maxActiveZones < 1) {
        throw new Error(`DTFX State Integrity Error: maxActiveZones must be a positive safe integer, got ${maxActiveZones}.`);
    }
    if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
        throw new Error(`DTFX State Integrity Error: intervalMs must be a positive safe integer, got ${intervalMs}.`);
    }
    if (!state || typeof state !== 'object' || state.stateVersion !== 1 ||
        !Array.isArray(state.clockCheckpoints)) {
        throw new Error('DTFX State Integrity Error: invalid DTFX state, stateVersion, or clockCheckpoints.');
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
    if (!Array.isArray(state.activeZones) || state.activeZones.length > maxActiveZones) {
        throw new Error('DTFX State Integrity Error: activeZones must be an array within maxActiveZones.');
    }
    if (state.window.length === 0) {
        if (state.clockCheckpoints.length !== 0 ||
            state.dir !== 0 || state.tDir !== 0 ||
            state.t !== null || state.b !== null ||
            state.prevTPrice !== null || state.prevBPrice !== null || state.prevClose !== null ||
            state.bosUpCheck || state.bosDownCheck ||
            state.activeZones.length !== 0) {
            throw new Error('DTFX State Integrity Error: empty window must have empty zones, swings, checkpoints, and initial flags.');
        }
    } else if (state.clockCheckpoints.length === 0) {
        throw new Error('DTFX State Integrity Error: non-empty window requires clockCheckpoints.');
    }

    let prevCpIdx = -1;
    let prevCpTime = -1;
    for (const cp of state.clockCheckpoints) {
        if (!cp || typeof cp !== 'object' ||
            !Number.isSafeInteger(cp.barIndex) || cp.barIndex < 0 ||
            !Number.isSafeInteger(cp.time) || cp.time < 0) {
            throw new Error('DTFX State Integrity Error: malformed clockCheckpoint.');
        }
        if (prevCpIdx !== -1) {
            const dBar = cp.barIndex - prevCpIdx;
            const dTime = cp.time - prevCpTime;
            if (dBar <= 0 || dTime <= 0 || dTime % intervalMs !== 0 || dTime < dBar * intervalMs) {
                throw new Error('DTFX State Integrity Error: non-monotonic or invalid clockCheckpoints.');
            }
        }
        prevCpIdx = cp.barIndex;
        prevCpTime = cp.time;
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
            w.high < w.low || w.high < Math.max(w.open, w.close) || w.low > Math.min(w.open, w.close)) {
            throw new Error('DTFX State Integrity Error: malformed OHLCV/index/time in window.');
        }
        if (prevIdx !== -1 && (w.barIndex <= prevIdx || w.time <= prevTime || (w.time - prevTime) % intervalMs !== 0)) {
            throw new Error('DTFX State Integrity Error: window bars must be strictly chronological and interval-aligned.');
        }
        if (resolveExpectedDTFXTime(w.barIndex, state.clockCheckpoints, intervalMs) !== w.time) {
            throw new Error(`DTFX State Integrity Error: window bar ${w.barIndex} disagrees with clockCheckpoints.`);
        }
        windowByIdx.set(w.barIndex, w);
        prevIdx = w.barIndex;
        prevTime = w.time;
    }

    const minBarIdx = state.window.length > 0 ? state.window[0].barIndex : null;
    const minTime = state.window.length > 0 ? state.window[0].time : null;
    const maxBarIdx = prevIdx === -1 ? null : prevIdx;
    const maxTime = prevTime === -1 ? null : prevTime;
    const latestBar = state.window.length > 0 ? state.window[state.window.length - 1] : null;

    if (prevCpIdx !== -1 && maxBarIdx !== null && maxTime !== null &&
        (prevCpIdx > maxBarIdx || prevCpTime > maxTime)) {
        throw new Error('DTFX State Integrity Error: clockCheckpoint exceeds latest retained window bar.');
    }

    const verifyClockRef = (label: string, idx: number, time: number) => {
        if (!Number.isSafeInteger(idx) || idx < 0 ||
            !Number.isSafeInteger(time) || time < 0) {
            throw new Error(`DTFX State Integrity Error: malformed ${label} clock reference.`);
        }
        if (minBarIdx === null || maxBarIdx === null || minTime === null || maxTime === null) {
            throw new Error(`DTFX State Integrity Error: ${label} cannot exist with empty window.`);
        }
        if (idx > maxBarIdx || time > maxTime) {
            throw new Error(`DTFX State Integrity Error: ${label} exceeds latest window bar.`);
        }
        if (state.clockCheckpoints.length > 0) {
            const expectedTime = resolveExpectedDTFXTime(idx, state.clockCheckpoints, intervalMs);
            if (expectedTime === null || time !== expectedTime) {
                throw new Error(`DTFX State Integrity Error: ${label} index/time relationship is inconsistent with clockCheckpoints.`);
            }
        }
        if (idx < minBarIdx) {
            if (time >= minTime) {
                throw new Error(`DTFX State Integrity Error: expired ${label} timestamp (${time}) >= window start (${minTime}).`);
            }
        } else {
            const w = windowByIdx.get(idx);
            if (!w || w.time !== time) {
                throw new Error(`DTFX State Integrity Error: ${label} disagrees with stored window bar ${idx}.`);
            }
        }
    };

    const verifyPairSpan = (
        label: string,
        earlierIdx: number,
        earlierTime: number,
        laterIdx: number,
        laterTime: number,
        requireStrictlyLater: boolean
    ) => {
        const badOrder = requireStrictlyLater
            ? laterIdx <= earlierIdx || laterTime <= earlierTime
            : laterIdx < earlierIdx || laterTime < earlierTime;
        if (badOrder) {
            throw new Error(`DTFX State Integrity Error: invalid ${label} chronological ordering.`);
        }
        if (state.clockCheckpoints.length > 0) {
            const expEarlier = resolveExpectedDTFXTime(earlierIdx, state.clockCheckpoints, intervalMs);
            const expLater = resolveExpectedDTFXTime(laterIdx, state.clockCheckpoints, intervalMs);
            if (expEarlier === null || expLater === null || expEarlier !== earlierTime || expLater !== laterTime) {
                throw new Error(`DTFX State Integrity Error: ${label} pair disagrees with historical clockCheckpoints.`);
            }
        }
    };

    for (const [label, pt, field] of [['t', state.t, 'high'], ['b', state.b, 'low']] as const) {
        if (pt !== null) {
            if (typeof pt !== 'object' || !Number.isFinite(pt.price) || pt.price <= 0) {
                throw new Error(`DTFX State Integrity Error: corrupted swing point '${label}'.`);
            }
            verifyClockRef(`swing '${label}'`, pt.barIndex, pt.time);
            const wb = windowByIdx.get(pt.barIndex);
            if (wb !== undefined && wb[field] !== pt.price) {
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
        verifyClockRef(`zone ${z.zoneId} createdSource`, z.createdSourceBarIndex, z.createdSourceTimestamp);
        verifyClockRef(`zone ${z.zoneId} createdConfirmation`, z.createdConfirmationBarIndex, z.createdConfirmationTimestamp);
        // Zone swing source (i - structureLen) MUST strictly precede confirmation bar (i)
        verifyPairSpan(
            `zone ${z.zoneId} creation`,
            z.createdSourceBarIndex,
            z.createdSourceTimestamp,
            z.createdConfirmationBarIndex,
            z.createdConfirmationTimestamp,
            true
        );

        if (z.createdConfirmationBarIndex < z.createdSourceBarIndex ||
            z.createdConfirmationTimestamp < z.createdSourceTimestamp ||
            (z.createdConfirmationBarIndex === z.createdSourceBarIndex &&
                z.createdConfirmationTimestamp !== z.createdSourceTimestamp) ||
            (z.createdConfirmationBarIndex > z.createdSourceBarIndex &&
                (z.createdConfirmationTimestamp <= z.createdSourceTimestamp ||
                    (z.createdConfirmationTimestamp - z.createdSourceTimestamp) % intervalMs !== 0))) {
            throw new Error(`DTFX State Integrity Error: corrupted creation provenance for zone ${z.zoneId}.`);
        }

        const latestInvalidatesZone =
            latestBar !== null &&
            (z.direction === 'bull' ? latestBar.close < z.bot : latestBar.close > z.top);
        const latestTouchesZone =
            latestBar !== null && latestBar.low <= z.top && latestBar.high >= z.bot;

        if (latestBar !== null && z.createdConfirmationBarIndex < latestBar.barIndex && latestInvalidatesZone) {
            throw new Error(`DTFX State Integrity Error: active zone ${z.zoneId} was invalidated on latest window bar.`);
        }

        if (z.status === 'ACTIVE') {
            if (z.retestCount !== 0 ||
                z.firstRetestBarIndex !== null ||
                z.firstRetestTimestamp !== null ||
                z.lastRetestBarIndex !== null ||
                z.lastRetestTimestamp !== null ||
                z.isCurrentlyInZone) {
                throw new Error(`DTFX State Integrity Error: ACTIVE zone ${z.zoneId} cannot have retest metadata.`);
            }
            if (latestBar !== null && z.createdConfirmationBarIndex < latestBar.barIndex && latestTouchesZone) {
                throw new Error(
                    `DTFX State Integrity Error: ACTIVE zone ${z.zoneId} overlaps latest window bar without RETESTED transition.`
                );
            }
        } else {
            if (!Number.isSafeInteger(z.retestCount) || z.retestCount < 1 ||
                z.firstRetestBarIndex === null || z.firstRetestTimestamp === null ||
                z.lastRetestBarIndex === null || z.lastRetestTimestamp === null ||
                !Number.isSafeInteger(z.firstRetestBarIndex) || !Number.isSafeInteger(z.firstRetestTimestamp) ||
                !Number.isSafeInteger(z.lastRetestBarIndex) || !Number.isSafeInteger(z.lastRetestTimestamp) ||
                z.firstRetestBarIndex <= z.createdConfirmationBarIndex ||
                z.firstRetestTimestamp <= z.createdConfirmationTimestamp ||
                (z.retestCount === 1 &&
                    (z.lastRetestBarIndex !== z.firstRetestBarIndex || z.lastRetestTimestamp !== z.firstRetestTimestamp)) ||
                (z.retestCount > 1 &&
                    (z.lastRetestBarIndex <= z.firstRetestBarIndex || z.lastRetestTimestamp <= z.firstRetestTimestamp))) {
                throw new Error(`DTFX State Integrity Error: corrupted RETESTED metadata for zone ${z.zoneId}.`);
            }
            if (maxBarIdx !== null && maxTime !== null &&
                (z.lastRetestBarIndex > maxBarIdx || z.lastRetestTimestamp > maxTime)) {
                throw new Error(`DTFX State Integrity Error: zone ${z.zoneId} lastRetest exceeds latest retained bar.`);
            }
            verifyClockRef(`zone ${z.zoneId} firstRetest`, z.firstRetestBarIndex, z.firstRetestTimestamp);
            verifyClockRef(`zone ${z.zoneId} lastRetest`, z.lastRetestBarIndex, z.lastRetestTimestamp);
            // First retest MUST strictly follow creation confirmation bar
            verifyPairSpan(
                `zone ${z.zoneId} firstRetest vs creation`,
                z.createdConfirmationBarIndex,
                z.createdConfirmationTimestamp,
                z.firstRetestBarIndex,
                z.firstRetestTimestamp,
                true
            );
            // Last retest equals first retest iff retestCount === 1; strictly later when retestCount > 1
            verifyPairSpan(
                `zone ${z.zoneId} lastRetest vs firstRetest`,
                z.firstRetestBarIndex,
                z.firstRetestTimestamp,
                z.lastRetestBarIndex,
                z.lastRetestTimestamp,
                z.retestCount > 1
            );

            const firstRW = windowByIdx.get(z.firstRetestBarIndex);
            if (firstRW &&
                (firstRW.low > z.top || firstRW.high < z.bot ||
                    (z.direction === 'bull' ? firstRW.close < z.bot : firstRW.close > z.top))) {
                throw new Error(`DTFX State Integrity Error: zone ${z.zoneId} firstRetest disagrees with stored window bar.`);
            }
            const lastRW = windowByIdx.get(z.lastRetestBarIndex);
            if (lastRW &&
                (lastRW.low > z.top || lastRW.high < z.bot ||
                    (z.direction === 'bull' ? lastRW.close < z.bot : lastRW.close > z.top))) {
                throw new Error(`DTFX State Integrity Error: zone ${z.zoneId} lastRetest disagrees with stored window bar.`);
            }
            if (latestBar !== null) {
                if (z.createdConfirmationBarIndex >= latestBar.barIndex) {
                    throw new Error(`DTFX State Integrity Error: zone ${z.zoneId} cannot be RETESTED on creation bar.`);
                }
                if (z.isCurrentlyInZone !== latestTouchesZone) {
                    throw new Error(
                        `DTFX State Integrity Error: zone ${z.zoneId} isCurrentlyInZone disagrees with latest window bar overlap.`
                    );
                }
                if (!latestTouchesZone && z.lastRetestBarIndex === latestBar.barIndex) {
                    throw new Error(
                        `DTFX State Integrity Error: zone ${z.zoneId} lastRetestBarIndex cannot equal non-overlapping latest window bar.`
                    );
                }
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
    validateDTFXState(previousState, len + 1, config.maxActiveZones, config.intervalMs);

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
    let nextClockCheckpoints = baseState.clockCheckpoints;
    if (nextClockCheckpoints.length === 0) {
        nextClockCheckpoints = Object.freeze([Object.freeze({ barIndex, time: candle.time })]);
    } else {
        const expected = resolveExpectedDTFXTime(barIndex, nextClockCheckpoints, config.intervalMs);
        if (expected !== candle.time) {
            nextClockCheckpoints = Object.freeze([
                ...nextClockCheckpoints,
                Object.freeze({ barIndex, time: candle.time })
            ]);
        }
    }

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
        const zTop = t.price;
        const zBot = dir === -1 ? lower : dir === 1 && b !== null ? b.price : lower;
        if (Number.isFinite(zTop) && Number.isFinite(zBot) && zBot > 0 && zTop > zBot) {
            bosUpCheck = false;
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
        const zTop = dir === 1 ? upper : dir === -1 && t !== null ? t.price : upper;
        const zBot = b.price;
        if (Number.isFinite(zTop) && Number.isFinite(zBot) && zBot > 0 && zTop > zBot) {
            bosDownCheck = false;
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
        clockCheckpoints: nextClockCheckpoints,
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
