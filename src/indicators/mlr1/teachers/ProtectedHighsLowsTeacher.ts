import type { ML1Candle } from '../ML1FeatureTypes';
import { createStrategyEvent, type StrategyEvent } from './StrategyEventTypes';

export const PHL_TEACHER_VERSION = 'PHL_BOS_MSS_v1';

export interface PHLConfig {
    readonly symbol: string;
    readonly timeframe: string;
    readonly intervalMs: number;
    readonly pivotStrength: number; // default 3
    readonly useValidPullbacks: boolean; // default true
    readonly extraValidPullbacks: boolean; // default false
}

export interface PHLPivotSlot {
    readonly price: number;
    readonly barIndex: number;
    readonly time: number;
}

export interface PHLPullbackTracker {
    readonly price: number | null;
    readonly idx: number | null;
    readonly valid: boolean;
    readonly bull: boolean;
}

export interface PHLWindowBar {
    readonly barIndex: number;
    readonly time: number;
    readonly open: number;
    readonly high: number;
    readonly low: number;
    readonly close: number;
    readonly volume: number;
}

export interface PHLClockCheckpoint {
    readonly barIndex: number;
    readonly time: number;
}

export interface PHLState {
    readonly stateVersion: 1;
    readonly clockCheckpoints: readonly PHLClockCheckpoint[];
    readonly window: readonly PHLWindowBar[];
    readonly bull: boolean | null; // null until first break
    readonly ph: PHLPivotSlot | null;
    readonly pl: PHLPivotSlot | null;
    readonly pbFromHigh: PHLPullbackTracker;
    readonly pbFromLow: PHLPullbackTracker;
    readonly lastHigh: number | null;
    readonly lastHighIdx: number | null;
    readonly lastHighTime: number | null;
    readonly lastLow: number | null;
    readonly lastLowIdx: number | null;
    readonly lastLowTime: number | null;
    readonly trackHigh: number | null;
    readonly trackHighIdx: number | null;
    readonly trackHighTime: number | null;
    readonly trackLow: number | null;
    readonly trackLowIdx: number | null;
    readonly trackLowTime: number | null;
}

export interface PHLStepResult {
    readonly nextState: PHLState;
    readonly events: readonly StrategyEvent[];
    readonly confirmedPivotHigh: PHLPivotSlot | null;
    readonly confirmedPivotLow: PHLPivotSlot | null;
    readonly activeProtectedHigh: PHLPivotSlot | null;
    readonly activeProtectedLow: PHLPivotSlot | null;
}

export function createDefaultPHLConfig(
    symbol = 'SOLUSDT',
    timeframe = '1m',
    intervalMs = 60_000
): PHLConfig {
    return Object.freeze({
        symbol,
        timeframe,
        intervalMs,
        pivotStrength: 3,
        useValidPullbacks: true,
        extraValidPullbacks: false
    });
}

export function createInitialPHLState(): PHLState {
    return Object.freeze({
        stateVersion: 1 as const,
        clockCheckpoints: Object.freeze([]),
        window: Object.freeze([]),
        bull: null,
        ph: null,
        pl: null,
        pbFromHigh: Object.freeze({ price: null, idx: null, valid: false, bull: true }),
        pbFromLow: Object.freeze({ price: null, idx: null, valid: false, bull: false }),
        lastHigh: null,
        lastHighIdx: null,
        lastHighTime: null,
        lastLow: null,
        lastLowIdx: null,
        lastLowTime: null,
        trackHigh: null,
        trackHighIdx: null,
        trackHighTime: null,
        trackLow: null,
        trackLowIdx: null,
        trackLowTime: null
    });
}

export function validatePHLConfig(config: PHLConfig): void {
    if (!config || typeof config !== 'object') {
        throw new Error('PHL Config Error: config must be an object.');
    }
    if (typeof config.symbol !== 'string' || config.symbol.trim() === '' ||
        typeof config.timeframe !== 'string' || config.timeframe.trim() === '') {
        throw new Error('PHL Config Error: symbol and timeframe must be non-empty strings.');
    }
    if (!Number.isSafeInteger(config.intervalMs) || config.intervalMs <= 0) {
        throw new Error(`PHL Config Error: intervalMs must be a positive safe integer, got ${config.intervalMs}.`);
    }
    if (!Number.isSafeInteger(config.pivotStrength) || config.pivotStrength < 1) {
        throw new Error(`PHL Config Error: pivotStrength must be >= 1, got ${config.pivotStrength}.`);
    }
    if (typeof config.useValidPullbacks !== 'boolean' || typeof config.extraValidPullbacks !== 'boolean') {
        throw new Error('PHL Config Error: useValidPullbacks and extraValidPullbacks must be booleans.');
    }
}

function isValidSlot(slot: PHLPivotSlot | null, maxBarIdx: number | null, maxTime: number | null): boolean {
    if (slot === null) return true;
    if (typeof slot !== 'object' ||
        !Number.isFinite(slot.price) || slot.price <= 0 ||
        !Number.isSafeInteger(slot.barIndex) || slot.barIndex < 0 ||
        !Number.isSafeInteger(slot.time) || slot.time < 0) {
        return false;
    }
    if (maxBarIdx !== null && slot.barIndex > maxBarIdx) return false;
    if (maxTime !== null && slot.time > maxTime) return false;
    return true;
}

function isValidTracker(
    tracker: PHLPullbackTracker,
    expectedBull: boolean,
    maxBarIdx: number | null
): boolean {
    if (!tracker || typeof tracker !== 'object' ||
        tracker.bull !== expectedBull || typeof tracker.valid !== 'boolean') {
        return false;
    }
    if (tracker.price === null && tracker.idx === null) {
        return !tracker.valid;
    }
    if (tracker.price === null || !Number.isFinite(tracker.price) || tracker.price <= 0 ||
        tracker.idx === null || !Number.isSafeInteger(tracker.idx) || tracker.idx < 0) {
        return false;
    }
    if (maxBarIdx !== null && tracker.idx > maxBarIdx) return false;
    return true;
}

function resolveExpectedPHLTime(
    barIndex: number,
    checkpoints: readonly PHLClockCheckpoint[],
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

export function validatePHLState(state: PHLState, maxWin: number, intervalMs: number): void {
    if (!Number.isSafeInteger(maxWin) || maxWin < 1) {
        throw new Error(`PHL State Integrity Error: maxWin must be a positive safe integer, got ${maxWin}.`);
    }
    if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
        throw new Error(`PHL State Integrity Error: intervalMs must be a positive safe integer, got ${intervalMs}.`);
    }
    if (!state || typeof state !== 'object' || state.stateVersion !== 1 ||
        !Array.isArray(state.clockCheckpoints)) {
        throw new Error('PHL State Integrity Error: invalid PHL state, stateVersion, or clockCheckpoints.');
    }
    if (state.bull !== null && typeof state.bull !== 'boolean') {
        throw new Error('PHL State Integrity Error: bull must be boolean or null.');
    }
    if (!Array.isArray(state.window) || state.window.length > maxWin) {
        throw new Error('PHL State Integrity Error: invalid window container or length.');
    }

    const prelimMaxBarIdx = state.window.length > 0 ? state.window[state.window.length - 1].barIndex : null;
    if (!isValidTracker(state.pbFromHigh, true, prelimMaxBarIdx) ||
        !isValidTracker(state.pbFromLow, false, prelimMaxBarIdx)) {
        throw new Error('PHL State Integrity Error: corrupted pullback tracker.');
    }

    if (state.window.length === 0) {
        if (state.clockCheckpoints.length !== 0 ||
            state.bull !== null ||
            state.ph !== null ||
            state.pl !== null ||
            state.lastHigh !== null || state.lastHighIdx !== null || state.lastHighTime !== null ||
            state.lastLow !== null || state.lastLowIdx !== null || state.lastLowTime !== null ||
            state.trackHigh !== null || state.trackHighIdx !== null || state.trackHighTime !== null ||
            state.trackLow !== null || state.trackLowIdx !== null || state.trackLowTime !== null ||
            state.pbFromHigh.price !== null || state.pbFromHigh.idx !== null || state.pbFromHigh.valid ||
            state.pbFromLow.price !== null || state.pbFromLow.idx !== null || state.pbFromLow.valid) {
            throw new Error('PHL State Integrity Error: empty window must have null historical references and initial state.');
        }
    } else if (state.clockCheckpoints.length === 0) {
        throw new Error('PHL State Integrity Error: non-empty window requires clockCheckpoints.');
    }

    let prevCpIdx = -1;
    let prevCpTime = -1;
    for (const cp of state.clockCheckpoints) {
        if (!cp || typeof cp !== 'object' ||
            !Number.isSafeInteger(cp.barIndex) || cp.barIndex < 0 ||
            !Number.isSafeInteger(cp.time) || cp.time < 0) {
            throw new Error('PHL State Integrity Error: malformed clockCheckpoint.');
        }
        if (prevCpIdx !== -1) {
            const dBar = cp.barIndex - prevCpIdx;
            const dTime = cp.time - prevCpTime;
            if (dBar <= 0 || dTime <= 0 || dTime % intervalMs !== 0 || dTime < dBar * intervalMs) {
                throw new Error('PHL State Integrity Error: non-monotonic or invalid clockCheckpoints.');
            }
        }
        prevCpIdx = cp.barIndex;
        prevCpTime = cp.time;
    }

    let prevIdx = -1;
    let prevTime = -1;
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
            throw new Error('PHL State Integrity Error: malformed OHLCV/index/time in window.');
        }
        if (prevIdx !== -1 && (w.barIndex <= prevIdx || w.time <= prevTime || (w.time - prevTime) % intervalMs !== 0)) {
            throw new Error('PHL State Integrity Error: window bars must be strictly chronological.');
        }
        if (resolveExpectedPHLTime(w.barIndex, state.clockCheckpoints, intervalMs) !== w.time) {
            throw new Error(`PHL State Integrity Error: window bar ${w.barIndex} disagrees with clockCheckpoints.`);
        }
        prevIdx = w.barIndex;
        prevTime = w.time;
    }

    const minBarIdx = state.window.length > 0 ? state.window[0].barIndex : null;
    const minTime = state.window.length > 0 ? state.window[0].time : null;
    const maxBarIdx = prevIdx === -1 ? null : prevIdx;
    const maxTime = prevTime === -1 ? null : prevTime;

    if (prevCpIdx !== -1 && maxBarIdx !== null && maxTime !== null &&
        (prevCpIdx > maxBarIdx || prevCpTime > maxTime)) {
        throw new Error('PHL State Integrity Error: clockCheckpoint exceeds latest retained window bar.');
    }

    if (!isValidSlot(state.ph, maxBarIdx, maxTime) || !isValidSlot(state.pl, maxBarIdx, maxTime)) {
        throw new Error('PHL State Integrity Error: corrupted ph/pl slot.');
    }
    if (!isValidTracker(state.pbFromHigh, true, maxBarIdx) || !isValidTracker(state.pbFromLow, false, maxBarIdx)) {
        throw new Error('PHL State Integrity Error: corrupted pullback tracker.');
    }

    const checkTriple = (price: number | null, idx: number | null, time: number | null, label: string) => {
        if (price === null && idx === null && time === null) return;
        if (price === null || !Number.isFinite(price) || price <= 0 ||
            idx === null || !Number.isSafeInteger(idx) || idx < 0 ||
            time === null || !Number.isSafeInteger(time) || time < 0 ||
            (maxBarIdx !== null && idx > maxBarIdx) ||
            (maxTime !== null && time > maxTime)) {
            throw new Error(`PHL State Integrity Error: inconsistent ${label} price/index/time triple.`);
        }
    };
    checkTriple(state.lastHigh, state.lastHighIdx, state.lastHighTime, 'lastHigh');
    checkTriple(state.lastLow, state.lastLowIdx, state.lastLowTime, 'lastLow');
    checkTriple(state.trackHigh, state.trackHighIdx, state.trackHighTime, 'trackHigh');
    checkTriple(state.trackLow, state.trackLowIdx, state.trackLowTime, 'trackLow');

    const windowByIdx = new Map(state.window.map(w => [w.barIndex, w] as const));
    const checkWindowRef = (label: string, idx: number, time: number, price: number, kind: 'high' | 'low') => {
        if (minBarIdx !== null && minTime !== null) {
            if (idx < minBarIdx) {
                const expectedTime = resolveExpectedPHLTime(idx, state.clockCheckpoints, intervalMs);
                if (expectedTime === null || time >= minTime || time !== expectedTime) {
                    throw new Error(
                        `PHL State Integrity Error: expired ${label} index/time relationship is inconsistent.`
                    );
                }
            } else {
                const w = windowByIdx.get(idx);
                if (!w) {
                    throw new Error(`PHL State Integrity Error: ${label} index ${idx} missing from retained window.`);
                }
                const expectedPrice = kind === 'high' ? w.high : w.low;
                if (w.time !== time || price !== expectedPrice) {
                    throw new Error(`PHL State Integrity Error: ${label} disagrees with stored window bar ${idx}.`);
                }
            }
        }
    };

    if (state.ph !== null) checkWindowRef('ph', state.ph.barIndex, state.ph.time, state.ph.price, 'high');
    if (state.pl !== null) checkWindowRef('pl', state.pl.barIndex, state.pl.time, state.pl.price, 'low');
    if (state.lastHighIdx !== null && state.lastHighTime !== null && state.lastHigh !== null) {
        checkWindowRef('lastHigh', state.lastHighIdx, state.lastHighTime, state.lastHigh, 'high');
    }
    if (state.lastLowIdx !== null && state.lastLowTime !== null && state.lastLow !== null) {
        checkWindowRef('lastLow', state.lastLowIdx, state.lastLowTime, state.lastLow, 'low');
    }
    if (state.trackHighIdx !== null && state.trackHighTime !== null && state.trackHigh !== null) {
        checkWindowRef('trackHigh', state.trackHighIdx, state.trackHighTime, state.trackHigh, 'high');
    }
    if (state.trackLowIdx !== null && state.trackLowTime !== null && state.trackLow !== null) {
        checkWindowRef('trackLow', state.trackLowIdx, state.trackLowTime, state.trackLow, 'low');
    }
}

export function stepPHL(
    candle: ML1Candle,
    barIndex: number,
    previousState: PHLState,
    config: PHLConfig,
    isDiscontinuity = false,
    atr14AtConfirmation: number | null = null,
    entryTimestamp: number | null = null
): PHLStepResult {
    validatePHLConfig(config);
    const ps = config.pivotStrength;
    const maxWindowLen = 2 * ps + 4;
    validatePHLState(previousState, maxWindowLen, config.intervalMs);

    // 1. Validate discontinuity flag.
    if (typeof isDiscontinuity !== 'boolean') {
        throw new Error('PHL Input Error: isDiscontinuity must be a boolean.');
    }

    // 2. Validate ATR.
    if (atr14AtConfirmation !== null &&
        (typeof atr14AtConfirmation !== 'number' || !Number.isFinite(atr14AtConfirmation) || atr14AtConfirmation <= 0)) {
        throw new Error('PHL Input Error: atr14AtConfirmation must be null or a positive finite number.');
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
        throw new Error(`PHL Input Error: invalid candle OHLCV or barIndex (${barIndex}).`);
    }

    // 4. Only now is candle.time safe to access.
    if (entryTimestamp !== null &&
        (!Number.isSafeInteger(entryTimestamp) || entryTimestamp <= candle.time)) {
        throw new Error('PHL Input Error: entryTimestamp must be null or a safe integer > candle.time.');
    }

    if (previousState.window.length > 0) {
        const prevBar = previousState.window[previousState.window.length - 1];
        if (barIndex <= prevBar.barIndex || candle.time <= prevBar.time) {
            throw new Error(
                `PHL Chronology Error: incoming bar (${barIndex}, ${candle.time}) must strictly exceed previous (${prevBar.barIndex}, ${prevBar.time}).`
            );
        }
        const deltaMs = candle.time - prevBar.time;
        if (deltaMs < config.intervalMs || deltaMs % config.intervalMs !== 0) {
            throw new Error(
                `PHL Chronology Error: timestamp delta (${deltaMs}) must be a positive multiple of intervalMs (${config.intervalMs}).`
            );
        }
    }

    const baseState = isDiscontinuity ? createInitialPHLState() : previousState;
    let nextClockCheckpoints = baseState.clockCheckpoints;
    if (nextClockCheckpoints.length === 0) {
        nextClockCheckpoints = Object.freeze([Object.freeze({ barIndex, time: candle.time })]);
    } else {
        const expected = resolveExpectedPHLTime(barIndex, nextClockCheckpoints, config.intervalMs);
        if (expected !== candle.time) {
            nextClockCheckpoints = Object.freeze([
                ...nextClockCheckpoints,
                Object.freeze({ barIndex, time: candle.time })
            ]);
        }
    }
    const bar: PHLWindowBar = Object.freeze({
        barIndex,
        time: candle.time,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: candle.volume
    });
    const nextWindow = Object.freeze([...baseState.window, bar].slice(-maxWindowLen));

    let bull = baseState.bull;
    let ph = baseState.ph;
    let pl = baseState.pl;
    let pbFromHigh = baseState.pbFromHigh;
    let pbFromLow = baseState.pbFromLow;
    let lastHigh = baseState.lastHigh;
    let lastHighIdx = baseState.lastHighIdx;
    let lastHighTime = baseState.lastHighTime;
    let lastLow = baseState.lastLow;
    let lastLowIdx = baseState.lastLowIdx;
    let lastLowTime = baseState.lastLowTime;
    let trackHigh = baseState.trackHigh;
    let trackHighIdx = baseState.trackHighIdx;
    let trackHighTime = baseState.trackHighTime;
    let trackLow = baseState.trackLow;
    let trackLowIdx = baseState.trackLowIdx;
    let trackLowTime = baseState.trackLowTime;

    let confirmedPivotHigh: PHLPivotSlot | null = null;
    let confirmedPivotLow: PHLPivotSlot | null = null;

    // 1. Causal pivot detection (confirms cand at barIndex - ps when window has >= 2*ps + 1 bars)
    if (nextWindow.length >= 2 * ps + 1) {
        const candPos = nextWindow.length - 1 - ps;
        const cand = nextWindow[candPos];

        let isPivotHigh = true;
        let isPivotLow = true;

        for (let k = 1; k <= ps; k++) {
            const leftBar = nextWindow[candPos - k];
            const rightBar = nextWindow[candPos + k];
            // Pine tie rule: strictly greater/less than right R bars, >=/<= left L bars
            if (leftBar.high > cand.high || rightBar.high >= cand.high) {
                isPivotHigh = false;
            }
            if (leftBar.low < cand.low || rightBar.low <= cand.low) {
                isPivotLow = false;
            }
        }

        if (isPivotLow) {
            confirmedPivotLow = Object.freeze({ price: cand.low, barIndex: cand.barIndex, time: cand.time });
            if (pl === null) {
                pl = confirmedPivotLow;
                if (config.extraValidPullbacks) {
                    for (let offset = 0; offset <= 3 && candPos - offset >= 0; offset++) {
                        const look = nextWindow[candPos - offset];
                        if (look.close < look.open) {
                            pbFromLow = Object.freeze({ price: look.high, idx: barIndex, valid: false, bull: false });
                            break;
                        }
                    }
                } else {
                    pbFromLow = Object.freeze({ price: cand.high, idx: barIndex, valid: false, bull: false });
                }

                if (lastLow === null || cand.low < lastLow) {
                    lastLow = cand.low;
                    lastLowIdx = cand.barIndex;
                    lastLowTime = cand.time;
                }
            }
        }

        if (isPivotHigh) {
            confirmedPivotHigh = Object.freeze({ price: cand.high, barIndex: cand.barIndex, time: cand.time });
            if (ph === null) {
                ph = confirmedPivotHigh;
                if (config.extraValidPullbacks) {
                    for (let offset = 0; offset <= 3 && candPos - offset >= 0; offset++) {
                        const look = nextWindow[candPos - offset];
                        if (look.close > look.open) {
                            pbFromHigh = Object.freeze({ price: look.low, idx: barIndex, valid: false, bull: true });
                            break;
                        }
                    }
                } else {
                    pbFromHigh = Object.freeze({ price: cand.low, idx: barIndex, valid: false, bull: true });
                }

                if (lastHigh === null || cand.high > lastHigh) {
                    lastHigh = cand.high;
                    lastHighIdx = cand.barIndex;
                    lastHighTime = cand.time;
                }
            }
        }
    }

    // 2. Pullback validation (check_pb)
    if (pbFromHigh.price !== null && !pbFromHigh.valid && candle.close < pbFromHigh.price) {
        pbFromHigh = Object.freeze({ ...pbFromHigh, valid: true });
    }
    if (pbFromLow.price !== null && !pbFromLow.valid && candle.close > pbFromLow.price) {
        pbFromLow = Object.freeze({ ...pbFromLow, valid: true });
    }

    // 3. Track protected high / low candidates
    if (confirmedPivotHigh !== null) {
        const pbOk = !config.useValidPullbacks || pbFromLow.valid;
        const replaceHigh =
            trackHigh === null ||
            confirmedPivotHigh.price > trackHigh ||
            (lastLowIdx !== null && (trackHighIdx === null || lastLowIdx >= trackHighIdx));
        if (replaceHigh && pbOk) {
            trackHigh = confirmedPivotHigh.price;
            trackHighIdx = confirmedPivotHigh.barIndex;
            trackHighTime = confirmedPivotHigh.time;
        }
    }

    if (confirmedPivotLow !== null) {
        const pbOk = !config.useValidPullbacks || pbFromHigh.valid;
        const replaceLow =
            trackLow === null ||
            confirmedPivotLow.price < trackLow ||
            (lastHighIdx !== null && (trackLowIdx === null || lastHighIdx >= trackLowIdx));
        if (replaceLow && pbOk) {
            trackLow = confirmedPivotLow.price;
            trackLowIdx = confirmedPivotLow.barIndex;
            trackLowTime = confirmedPivotLow.time;
        }
    }

    // 4. Structure Breaks (BOS / MSS) — Frozen single-break-per-bar against pre-break levels
    const events: StrategyEvent[] = [];
    const phPreBreak = ph;
    const plPreBreak = pl;
    const atrUsable = atr14AtConfirmation !== null && Number.isFinite(atr14AtConfirmation) && atr14AtConfirmation > 0;

    if (phPreBreak !== null && candle.close > phPreBreak.price) {
        const isBos = bull === true;
        const eventType = isBos ? 'PHL_BOS_BULL' : 'PHL_MSS_BULL';
        bull = true;

        // clear_all() then seed protected low from trackLow
        ph = null;
        pl = null;
        if (trackLow !== null && trackLowIdx !== null && trackLowTime !== null) {
            pl = Object.freeze({ price: trackLow, barIndex: trackLowIdx, time: trackLowTime });
            lastHigh = null;
            lastHighIdx = null;
            lastHighTime = null;
        }

        const distProtectedAtr =
            pl !== null && atrUsable ? (candle.close - pl.price) / atr14AtConfirmation! : 0;

        events.push(
            createStrategyEvent({
                strategyId: 'PHL_BOS_MSS',
                strategyVersion: PHL_TEACHER_VERSION,
                symbol: config.symbol,
                timeframe: config.timeframe,
                intervalMs: config.intervalMs,
                eventType,
                eventDirection: 'bull',
                eventDiscriminator: 'PH',
                sourceBarIndex: phPreBreak.barIndex,
                sourceTimestamp: phPreBreak.time,
                confirmationBarIndex: barIndex,
                confirmationTimestamp: candle.time,
                entryTimestamp,
                structuralContext: {
                    breakType: isBos ? 'BOS' : 'MSS',
                    brokenLevelPrice: phPreBreak.price,
                    hasProtectedLevel: pl !== null,
                    protectedLevelPrice: pl !== null ? pl.price : 0,
                    distToProtectedAtr: distProtectedAtr,
                    pbFromLowValid: pbFromLow.valid,
                    pbFromHighValid: pbFromHigh.valid
                }
            })
        );
    } else if (plPreBreak !== null && candle.close < plPreBreak.price) {
        const isBos = bull === false;
        const eventType = isBos ? 'PHL_BOS_BEAR' : 'PHL_MSS_BEAR';
        bull = false;

        // clear_all() then seed protected high from trackHigh
        ph = null;
        pl = null;
        if (trackHigh !== null && trackHighIdx !== null && trackHighTime !== null) {
            ph = Object.freeze({ price: trackHigh, barIndex: trackHighIdx, time: trackHighTime });
            lastLow = null;
            lastLowIdx = null;
            lastLowTime = null;
        }

        const distProtectedAtr =
            ph !== null && atrUsable ? (ph.price - candle.close) / atr14AtConfirmation! : 0;

        events.push(
            createStrategyEvent({
                strategyId: 'PHL_BOS_MSS',
                strategyVersion: PHL_TEACHER_VERSION,
                symbol: config.symbol,
                timeframe: config.timeframe,
                intervalMs: config.intervalMs,
                eventType,
                eventDirection: 'bear',
                eventDiscriminator: 'PL',
                sourceBarIndex: plPreBreak.barIndex,
                sourceTimestamp: plPreBreak.time,
                confirmationBarIndex: barIndex,
                confirmationTimestamp: candle.time,
                entryTimestamp,
                structuralContext: {
                    breakType: isBos ? 'BOS' : 'MSS',
                    brokenLevelPrice: plPreBreak.price,
                    hasProtectedLevel: ph !== null,
                    protectedLevelPrice: ph !== null ? ph.price : 0,
                    distToProtectedAtr: distProtectedAtr,
                    pbFromLowValid: pbFromLow.valid,
                    pbFromHighValid: pbFromHigh.valid
                }
            })
        );
    }

    const nextState: PHLState = Object.freeze({
        stateVersion: 1 as const,
        clockCheckpoints: nextClockCheckpoints,
        window: nextWindow,
        bull,
        ph,
        pl,
        pbFromHigh,
        pbFromLow,
        lastHigh,
        lastHighIdx,
        lastHighTime,
        lastLow,
        lastLowIdx,
        lastLowTime,
        trackHigh,
        trackHighIdx,
        trackHighTime,
        trackLow,
        trackLowIdx,
        trackLowTime
    });

    return {
        nextState,
        events: Object.freeze(events),
        confirmedPivotHigh,
        confirmedPivotLow,
        activeProtectedHigh: ph,
        activeProtectedLow: pl
    };
}
