import type { ATRPeriodState, ML1Candle } from '../ML1FeatureTypes';
import { updateWilderATR } from '../volatility/ATR';
import { createStrategyEvent, type StrategyEvent } from './StrategyEventTypes';
import {
    buildV5CandidateEventId,
    buildV5PhlRetestEpisodeId,
    buildV5ZoneId,
    computeV5DepthMetrics,
    validateV5ZoneLifecycleRecord,
    type V5Direction,
    type V5PhlRetestCandidateRecord,
    type V5ZoneActivityState,
    type V5ZoneLifecycleEvent,
    type V5ZoneLifecycleRecord,
    type V5ZoneTimeframe
} from '../pipeline/V5OutcomeContracts';

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

// =========================================================================
// V4 HTF Multi-Timeframe PHL Teacher (1m, 3m, 5m — Default pivotStrength = 8)
// =========================================================================
export type PHLTimeframe = '1m' | '3m' | '5m';

export const PHL_V4_TEACHER_VERSION = 'PHL_BOS_MSS_HTF_v2';

export const PHL_TIMEFRAME_MS: Readonly<Record<PHLTimeframe, number>> = Object.freeze({
    '1m': 60_000,
    '3m': 180_000,
    '5m': 300_000
});

export interface PHLV4StructuralContext {
    readonly phlTimeframe: PHLTimeframe;
    readonly breakType: 'BOS' | 'MSS';
    readonly brokenLevelPrice: number;
    readonly hasProtectedLevel: boolean;
    readonly protectedLevelPrice: number | null;
    readonly protectedLevelBarIndex: number | null;
    readonly protectedLevelTimestamp: number | null;
    readonly atr14Valid: boolean;
    readonly distToProtectedAtr: number | null;
    readonly pbFromLowValid: boolean;
    readonly pbFromHighValid: boolean;
}

export interface PHLV4TeacherEvent {
    readonly strategyId: 'PHL_BOS_MSS';
    readonly strategyVersion: typeof PHL_V4_TEACHER_VERSION;
    readonly symbol: string;
    readonly timeframe: string;
    readonly phlTimeframe: PHLTimeframe;
    readonly eventType: 'PHL_BOS_BULL' | 'PHL_BOS_BEAR' | 'PHL_MSS_BULL' | 'PHL_MSS_BEAR';
    readonly eventDirection: 'bull' | 'bear';
    readonly eventDiscriminator: string;
    readonly sourceBarIndex: number;
    readonly sourceTimestamp: number;
    readonly confirmationBarIndex: number;
    readonly confirmationTimestamp: number;
    readonly structuralContext: PHLV4StructuralContext;
}

export interface PHLV4Config {
    readonly symbol: string;
    readonly baseTimeframe: string;
    readonly baseIntervalMs: number;
    readonly phlTimeframe: PHLTimeframe;
    readonly phlIntervalMs: number;
    readonly expectedBarsPerBucket: number;
    readonly pivotStrength: number; // Default 8
    readonly useValidPullbacks: boolean;
    readonly extraValidPullbacks: boolean;
}

interface FormingPHLBucket {
    readonly bucketStart: number;
    readonly open: number;
    readonly high: number;
    readonly low: number;
    readonly close: number;
    readonly volume: number;
    readonly peakChartBar: number;
    readonly peakChartTime: number;
    readonly troughChartBar: number;
    readonly troughChartTime: number;
    readonly lastCandleTime: number;
    readonly barCount: number;
    readonly isCorrupt: boolean;
}

interface PHLChartBarAnchor {
    readonly peakBar: number;
    readonly peakTime: number;
    readonly troughBar: number;
    readonly troughTime: number;
}

export interface PHLV4State {
    readonly stateVersion: 2;
    readonly phlState: PHLState;
    readonly htfAtrState: ATRPeriodState | null;
    readonly prevHtfClose: number | null;
    readonly htfBarIndex: number;
    readonly htfBarAnchors: Readonly<Record<number, PHLChartBarAnchor>>;
    readonly formingBucket: FormingPHLBucket | null;
    readonly lastProcessedTimestamp: number | null;
    readonly lastProcessedBarIndex: number | null;
}

function parsePHLBaseTfToMs(tf: string): number {
    const match = /^([1-9]\d*)(m|h|d)$/.exec(tf.trim());
    if (!match) throw new Error(`Unsupported PHL baseTimeframe '${tf}'.`);
    const count = Number(match[1]);
    const unitMs = match[2] === 'm' ? 60_000 : match[2] === 'h' ? 3_600_000 : 86_400_000;
    return count * unitMs;
}

export function validatePHLV4Config(config: PHLV4Config): void {
    if (!config || typeof config !== 'object') {
        throw new Error('PHL V4 Config Error: config must be an object.');
    }
    if (typeof config.symbol !== 'string' || config.symbol.trim().length === 0 ||
        typeof config.baseTimeframe !== 'string' || config.baseTimeframe.trim().length === 0) {
        throw new Error('PHL V4 Config Error: symbol and baseTimeframe must be non-empty strings.');
    }
    if (!Number.isSafeInteger(config.baseIntervalMs) || config.baseIntervalMs <= 0) {
        throw new Error(`PHL V4 Config Error: invalid baseIntervalMs ${config.baseIntervalMs}.`);
    }
    if (parsePHLBaseTfToMs(config.baseTimeframe) !== config.baseIntervalMs) {
        throw new Error(`PHL V4 Config Error: baseTimeframe '${config.baseTimeframe}' disagrees with baseIntervalMs ${config.baseIntervalMs}.`);
    }
    const expectedMs = PHL_TIMEFRAME_MS[config.phlTimeframe];
    if (!expectedMs || config.phlIntervalMs !== expectedMs) {
        throw new Error(`PHL V4 Config Error: invalid phlTimeframe '${String(config.phlTimeframe)}' or phlIntervalMs ${config.phlIntervalMs}.`);
    }
    if (config.phlIntervalMs < config.baseIntervalMs ||
        config.phlIntervalMs % config.baseIntervalMs !== 0 ||
        config.expectedBarsPerBucket !== config.phlIntervalMs / config.baseIntervalMs) {
        throw new Error('PHL V4 Config Error: expectedBarsPerBucket must equal phlIntervalMs / baseIntervalMs.');
    }
    if (!Number.isSafeInteger(config.pivotStrength) || config.pivotStrength < 1) {
        throw new Error(`PHL V4 Config Error: pivotStrength must be >= 1, got ${config.pivotStrength}.`);
    }
    if (typeof config.useValidPullbacks !== 'boolean' || typeof config.extraValidPullbacks !== 'boolean') {
        throw new Error('PHL V4 Config Error: boolean flags required.');
    }
}

export function createDefaultPHLV4Config(
    symbol: string,
    baseTimeframe: string,
    baseIntervalMs: number,
    phlTimeframe: PHLTimeframe,
    options?: {
        pivotStrength?: number;
        useValidPullbacks?: boolean;
        extraValidPullbacks?: boolean;
    }
): PHLV4Config {
    const phlIntervalMs = PHL_TIMEFRAME_MS[phlTimeframe];
    if (!phlIntervalMs) {
        throw new Error(`PHL V4 Config Error: unsupported phlTimeframe '${String(phlTimeframe)}'.`);
    }
    const cfg: PHLV4Config = Object.freeze({
        symbol,
        baseTimeframe,
        baseIntervalMs,
        phlTimeframe,
        phlIntervalMs,
        expectedBarsPerBucket: phlIntervalMs / baseIntervalMs,
        pivotStrength: options?.pivotStrength ?? 8,
        useValidPullbacks: options?.useValidPullbacks ?? true,
        extraValidPullbacks: options?.extraValidPullbacks ?? false
    });
    validatePHLV4Config(cfg);
    return cfg;
}

export function createInitialPHLV4State(): PHLV4State {
    return Object.freeze({
        stateVersion: 2 as const,
        phlState: createInitialPHLState(),
        htfAtrState: null,
        prevHtfClose: null,
        htfBarIndex: 0,
        htfBarAnchors: Object.freeze({}),
        formingBucket: null,
        lastProcessedTimestamp: null,
        lastProcessedBarIndex: null
    });
}

export function validatePHLV4State(state: PHLV4State, config: PHLV4Config): void {
    validatePHLV4Config(config);
    if (!state || typeof state !== 'object' || state.stateVersion !== 2) {
        throw new Error(`PHL V4 State Error: expected stateVersion=2, got ${(state as any)?.stateVersion}.`);
    }
    if (!Number.isSafeInteger(state.htfBarIndex) || state.htfBarIndex < 0) {
        throw new Error(`PHL V4 State Error: invalid htfBarIndex ${String(state.htfBarIndex)}.`);
    }
    const hasTs = state.lastProcessedTimestamp !== null;
    const hasIdx = state.lastProcessedBarIndex !== null;
    if (hasTs !== hasIdx) {
        throw new Error('PHL V4 State Error: lastProcessedTimestamp and lastProcessedBarIndex must both be null or both populated.');
    }
    if (hasIdx) {
        if (!Number.isSafeInteger(state.lastProcessedBarIndex) || state.lastProcessedBarIndex! < 0 ||
            !Number.isSafeInteger(state.lastProcessedTimestamp) || state.lastProcessedTimestamp! <= 0 ||
            state.lastProcessedTimestamp! % config.baseIntervalMs !== 0) {
            throw new Error('PHL V4 State Error: invalid lastProcessedBarIndex or lastProcessedTimestamp.');
        }
    } else if (state.htfBarIndex !== 0 || state.formingBucket !== null || state.htfAtrState !== null || state.prevHtfClose !== null) {
        throw new Error('PHL V4 State Error: initial state before bar 0 must have zero htfBarIndex, null bucket, and null HTF ATR.');
    }

    const maxWindowLen = 2 * config.pivotStrength + 4;
    validatePHLState(state.phlState, maxWindowLen, config.phlIntervalMs);
    if (state.htfBarIndex === 0) {
        if (state.phlState.window.length !== 0) {
            throw new Error('PHL V4 State Error: phlState window must be empty when htfBarIndex === 0.');
        }
    } else {
        if (state.phlState.window.length === 0 ||
            state.phlState.window[state.phlState.window.length - 1].barIndex !== state.htfBarIndex - 1) {
            throw new Error('PHL V4 State Error: htfBarIndex disagrees with phlState latest window bar.');
        }
    }

    // Validate HTF ATR state
    if (config.expectedBarsPerBucket === 1) {
        if (state.htfAtrState !== null || state.prevHtfClose !== null) {
            throw new Error('PHL V4 State Error: 1m PHL state must keep htfAtrState and prevHtfClose null.');
        }
    } else if (state.htfBarIndex === 0) {
        if (state.htfAtrState !== null || state.prevHtfClose !== null) {
            throw new Error('PHL V4 State Error: htfAtrState and prevHtfClose must be null when htfBarIndex === 0.');
        }
    } else {
        const latestHtfClose = state.phlState.window[state.phlState.window.length - 1].close;
        if (state.prevHtfClose === null || !Number.isFinite(state.prevHtfClose) || state.prevHtfClose !== latestHtfClose) {
            throw new Error('PHL V4 State Error: prevHtfClose disagrees with latest completed HTF candle.');
        }
        const atr = state.htfAtrState;
        if (!atr || typeof atr !== 'object' ||
            !Number.isSafeInteger(atr.count) || atr.count !== state.htfBarIndex ||
            !Number.isFinite(atr.seedMean) || atr.seedMean < 0 ||
            typeof atr.isSeeded !== 'boolean' || atr.isSeeded !== (atr.count >= 14) ||
            (atr.isSeeded ? (atr.atr === null || !Number.isFinite(atr.atr) || atr.atr < 0) : atr.atr !== null)) {
            throw new Error('PHL V4 State Error: corrupted htfAtrState.');
        }
    }

    // Validate htfBarAnchors
    if (!state.htfBarAnchors || typeof state.htfBarAnchors !== 'object' || Array.isArray(state.htfBarAnchors)) {
        throw new Error('PHL V4 State Error: malformed htfBarAnchors.');
    }
    for (const [kStr, anchor] of Object.entries(state.htfBarAnchors)) {
        const k = Number(kStr);
        if (!Number.isSafeInteger(k) || k < 0 || k >= state.htfBarIndex) {
            throw new Error(`PHL V4 State Error: out-of-range anchor key '${kStr}'.`);
        }
        if (!anchor || typeof anchor !== 'object' ||
            !Number.isSafeInteger(anchor.peakBar) || anchor.peakBar < 0 || anchor.peakBar > state.lastProcessedBarIndex! ||
            !Number.isSafeInteger(anchor.troughBar) || anchor.troughBar < 0 || anchor.troughBar > state.lastProcessedBarIndex! ||
            !Number.isSafeInteger(anchor.peakTime) || anchor.peakTime <= 0 || anchor.peakTime > state.lastProcessedTimestamp! ||
            anchor.peakTime % config.baseIntervalMs !== 0 ||
            !Number.isSafeInteger(anchor.troughTime) || anchor.troughTime <= 0 || anchor.troughTime > state.lastProcessedTimestamp! ||
            anchor.troughTime % config.baseIntervalMs !== 0) {
            throw new Error(`PHL V4 State Error: invalid anchor entry at HTF index ${kStr}.`);
        }
    }
    if (state.htfBarIndex > 0) {
        const requiredIndices: number[] = [];
        if (state.phlState.ph) requiredIndices.push(state.phlState.ph.barIndex);
        if (state.phlState.pl) requiredIndices.push(state.phlState.pl.barIndex);
        if (state.phlState.trackHighIdx !== null) requiredIndices.push(state.phlState.trackHighIdx);
        if (state.phlState.trackLowIdx !== null) requiredIndices.push(state.phlState.trackLowIdx);
        if (state.phlState.lastHighIdx !== null) requiredIndices.push(state.phlState.lastHighIdx);
        if (state.phlState.lastLowIdx !== null) requiredIndices.push(state.phlState.lastLowIdx);
        for (const reqIdx of requiredIndices) {
            if (!Object.prototype.hasOwnProperty.call(state.htfBarAnchors, String(reqIdx))) {
                throw new Error(`PHL V4 State Error: missing chart anchor for active PHL HTF index ${reqIdx}.`);
            }
        }
    }

    // Validate formingBucket
    if (state.formingBucket !== null) {
        if (config.expectedBarsPerBucket === 1) {
            throw new Error('PHL V4 State Error: 1m PHL cannot have an open formingBucket.');
        }
        const fb = state.formingBucket;
        if (!fb || typeof fb !== 'object' ||
            typeof fb.isCorrupt !== 'boolean' ||
            !Number.isSafeInteger(fb.bucketStart) || fb.bucketStart <= 0 || fb.bucketStart % config.phlIntervalMs !== 0 ||
            !Number.isSafeInteger(fb.barCount) || fb.barCount < 1 || fb.barCount >= config.expectedBarsPerBucket ||
            !Number.isSafeInteger(fb.lastCandleTime) || fb.lastCandleTime !== fb.bucketStart + (fb.barCount - 1) * config.baseIntervalMs ||
            fb.lastCandleTime !== state.lastProcessedTimestamp ||
            !Number.isFinite(fb.open) || fb.open <= 0 ||
            !Number.isFinite(fb.high) || fb.high <= 0 ||
            !Number.isFinite(fb.low) || fb.low <= 0 ||
            !Number.isFinite(fb.close) || fb.close <= 0 ||
            !Number.isFinite(fb.volume) || fb.volume < 0 ||
            fb.high < fb.low || fb.high < Math.max(fb.open, fb.close) || fb.low > Math.min(fb.open, fb.close) ||
            !Number.isSafeInteger(fb.peakChartBar) || fb.peakChartBar < 0 || fb.peakChartBar > state.lastProcessedBarIndex! ||
            !Number.isSafeInteger(fb.troughChartBar) || fb.troughChartBar < 0 || fb.troughChartBar > state.lastProcessedBarIndex! ||
            !Number.isSafeInteger(fb.peakChartTime) || fb.peakChartTime < fb.bucketStart || fb.peakChartTime > fb.lastCandleTime ||
            fb.peakChartTime % config.baseIntervalMs !== 0 ||
            !Number.isSafeInteger(fb.troughChartTime) || fb.troughChartTime < fb.bucketStart || fb.troughChartTime > fb.lastCandleTime ||
            fb.troughChartTime % config.baseIntervalMs !== 0) {
            throw new Error('PHL V4 State Error: corrupted formingBucket.');
        }
    }
}

function validatePHLV4InputBoundary(
    candle: ML1Candle,
    barIndex: number,
    state: PHLV4State,
    config: PHLV4Config,
    isDiscontinuity: boolean,
    atr14: number | null
): void {
    validatePHLV4State(state, config);
    if (typeof isDiscontinuity !== 'boolean') {
        throw new Error('PHL V4 Input Error: isDiscontinuity must be a boolean.');
    }
    if (atr14 !== null && (typeof atr14 !== 'number' || !Number.isFinite(atr14) || atr14 <= 0)) {
        throw new Error('PHL V4 Input Error: atr14 must be null or a positive finite number.');
    }
    if (!Number.isSafeInteger(barIndex) || barIndex < 0) {
        throw new Error(`PHL V4 Chronology Error: invalid barIndex ${barIndex}.`);
    }
    if (state.lastProcessedBarIndex === null) {
        if (barIndex !== 0) {
            throw new Error(`PHL V4 Chronology Error: initial barIndex must be 0, got ${barIndex}.`);
        }
    } else if (barIndex !== state.lastProcessedBarIndex + 1) {
        throw new Error(
            `PHL V4 Chronology Error: barIndex must increment by 1 (expected ${state.lastProcessedBarIndex + 1}, got ${barIndex}).`
        );
    }
    if (!candle || typeof candle !== 'object' ||
        !Number.isSafeInteger(candle.time) || candle.time <= 0 ||
        candle.time % config.baseIntervalMs !== 0 ||
        !Number.isFinite(candle.open) || candle.open <= 0 ||
        !Number.isFinite(candle.high) || candle.high <= 0 ||
        !Number.isFinite(candle.low) || candle.low <= 0 ||
        !Number.isFinite(candle.close) || candle.close <= 0 ||
        !Number.isFinite(candle.volume) || candle.volume < 0 ||
        candle.high < candle.low ||
        candle.high < Math.max(candle.open, candle.close) ||
        candle.low > Math.min(candle.open, candle.close)) {
        throw new Error(`PHL V4 Input Error: invalid candle OHLCV or off-grid timestamp at bar ${barIndex}.`);
    }
    if (state.lastProcessedTimestamp !== null && candle.time <= state.lastProcessedTimestamp) {
        throw new Error(
            `PHL V4 Chronology Error: out-of-order or duplicate timestamp ${candle.time} <= ${state.lastProcessedTimestamp}.`
        );
    }
}

function stepCompletedPHLBucket(
    completedBucket: FormingPHLBucket,
    confirmChartBarIndex: number,
    confirmChartTimestamp: number,
    callerAtr14: number | null,
    config: PHLV4Config,
    prevState: PHLV4State,
    isBucketDiscontinuity: boolean
): {
    readonly nextState: PHLV4State;
    readonly events: readonly PHLV4TeacherEvent[];
    readonly confirmedPivotHigh: PHLPivotSlot | null;
    readonly confirmedPivotLow: PHLPivotSlot | null;
} {
    const htfIdx = prevState.htfBarIndex;
    const htfCandle: ML1Candle = {
        time: completedBucket.bucketStart,
        open: completedBucket.open,
        high: completedBucket.high,
        low: completedBucket.low,
        close: completedBucket.close,
        volume: completedBucket.volume,
        isSynthetic: false
    };

    // For 1m: use caller-supplied native 1m ATR; for 3m/5m HTF: compute canonical HTF Wilder ATR(14) from completed HTF buckets
    let effectiveAtr14: number | null = callerAtr14;
    let nextHtfAtrState: ATRPeriodState | null = null;
    let nextPrevHtfClose: number | null = null;

    if (config.expectedBarsPerBucket > 1) {
        const atrStep = updateWilderATR(
            completedBucket.high,
            completedBucket.low,
            prevState.prevHtfClose,
            14,
            prevState.htfAtrState ?? undefined,
            isBucketDiscontinuity
        );
        nextHtfAtrState = atrStep.nextState;
        nextPrevHtfClose = completedBucket.close;
        effectiveAtr14 = atrStep.isValid && atrStep.atrValue > 0 ? atrStep.atrValue : null;
    }

    const nextAnchorsMutable: Record<number, PHLChartBarAnchor> = {
        ...prevState.htfBarAnchors,
        [htfIdx]: Object.freeze({
            peakBar: completedBucket.peakChartBar,
            peakTime: completedBucket.peakChartTime,
            troughBar: completedBucket.troughChartBar,
            troughTime: completedBucket.troughChartTime
        })
    };

    const innerCfg: PHLConfig = {
        symbol: config.symbol,
        timeframe: config.phlTimeframe,
        intervalMs: config.phlIntervalMs,
        pivotStrength: config.pivotStrength,
        useValidPullbacks: config.useValidPullbacks,
        extraValidPullbacks: config.extraValidPullbacks
    };

    const step = stepPHL(htfCandle, htfIdx, prevState.phlState, innerCfg, isBucketDiscontinuity, effectiveAtr14, null);
    const nextPhl = step.nextState;

    const mapHighSlot = (slot: PHLPivotSlot | null): PHLPivotSlot | null => {
        if (!slot) return null;
        const a = nextAnchorsMutable[slot.barIndex];
        if (!a) {
            throw new Error(`PHL V4 State Error: missing HTF-to-chart anchor for high slot ${slot.barIndex}.`);
        }
        return Object.freeze({ price: slot.price, barIndex: a.peakBar, time: a.peakTime });
    };
    const mapLowSlot = (slot: PHLPivotSlot | null): PHLPivotSlot | null => {
        if (!slot) return null;
        const a = nextAnchorsMutable[slot.barIndex];
        if (!a) {
            throw new Error(`PHL V4 State Error: missing HTF-to-chart anchor for low slot ${slot.barIndex}.`);
        }
        return Object.freeze({ price: slot.price, barIndex: a.troughBar, time: a.troughTime });
    };

    const atr14Valid = effectiveAtr14 !== null && Number.isFinite(effectiveAtr14) && effectiveAtr14 > 0;
    const outEvents: PHLV4TeacherEvent[] = [];

    // stepPHL uses mutually exclusive if/else-if single-break-per-bar semantics; enforce explicitly
    if (step.events.length > 1) {
        throw new Error(`PHL V4 Contract Error: expected <= 1 event per step, got ${step.events.length}.`);
    }

    for (const rawEv of step.events) {
        if (rawEv.eventDirection !== 'bull' && rawEv.eventDirection !== 'bear') {
            throw new Error(`PHL V4 Contract Error: invalid eventDirection '${String(rawEv.eventDirection)}'.`);
        }
        const ctx = rawEv.structuralContext;
        if (!ctx || typeof ctx !== 'object') {
            throw new Error('PHL V4 Contract Error: missing rawEv.structuralContext.');
        }
        const breakType = ctx['breakType'];
        const brokenLevelPrice = ctx['brokenLevelPrice'];
        const hasProtectedLevel = ctx['hasProtectedLevel'];
        const rawProtPrice = ctx['protectedLevelPrice'];
        const pbFromLowValid = ctx['pbFromLowValid'];
        const pbFromHighValid = ctx['pbFromHighValid'];

        if (breakType !== 'BOS' && breakType !== 'MSS') {
            throw new Error(`PHL V4 Contract Error: invalid breakType '${String(breakType)}'.`);
        }
        if (typeof brokenLevelPrice !== 'number' || !Number.isFinite(brokenLevelPrice) || brokenLevelPrice <= 0) {
            throw new Error(`PHL V4 Contract Error: invalid brokenLevelPrice '${String(brokenLevelPrice)}'.`);
        }
        if (typeof hasProtectedLevel !== 'boolean' ||
            typeof pbFromLowValid !== 'boolean' ||
            typeof pbFromHighValid !== 'boolean') {
            throw new Error('PHL V4 Contract Error: hasProtectedLevel and pullback flags must be strict booleans.');
        }

        const isBull = rawEv.eventDirection === 'bull';
        // rawEv.sourceBarIndex from stepPHL is an HTF bar index; require valid anchor mapping
        const srcAnchor = nextAnchorsMutable[rawEv.sourceBarIndex];
        if (!srcAnchor) {
            throw new Error(`PHL V4 State Error: missing HTF-to-chart anchor for sourceBarIndex ${rawEv.sourceBarIndex}.`);
        }
        const sourceBarIndex = isBull ? srcAnchor.peakBar : srcAnchor.troughBar;
        const sourceTimestamp = isBull ? srcAnchor.peakTime : srcAnchor.troughTime;

        let protPrice: number | null = null;
        let protBarIndex: number | null = null;
        let protTimestamp: number | null = null;

        const rawOptBar = (ctx as Record<string, unknown>)['protectedLevelBarIndex'];
        const rawOptTime = (ctx as Record<string, unknown>)['protectedLevelTimestamp'];

        if (hasProtectedLevel) {
            if (typeof rawProtPrice !== 'number' || !Number.isFinite(rawProtPrice) || rawProtPrice <= 0) {
                throw new Error('PHL V4 Contract Error: hasProtectedLevel=true requires finite positive protectedLevelPrice.');
            }
            protPrice = rawProtPrice;

            // Optional protectedLevelBarIndex/Timestamp, if present on ctx, are already in 1m chart coordinates
            if (rawOptBar !== undefined && rawOptBar !== null) {
                if (typeof rawOptBar !== 'number' || !Number.isSafeInteger(rawOptBar) || rawOptBar < 0 || rawOptBar > confirmChartBarIndex) {
                    throw new Error(`PHL V4 Contract Error: invalid chart protectedLevelBarIndex '${String(rawOptBar)}'.`);
                }
                protBarIndex = rawOptBar;
            }
            if (rawOptTime !== undefined && rawOptTime !== null) {
                if (typeof rawOptTime !== 'number' || !Number.isSafeInteger(rawOptTime) || rawOptTime <= 0 || rawOptTime > confirmChartTimestamp) {
                    throw new Error(`PHL V4 Contract Error: invalid protectedLevelTimestamp '${String(rawOptTime)}'.`);
                }
                protTimestamp = rawOptTime;
            }

            if (protBarIndex === null || protTimestamp === null) {
                const stepSlot = isBull ? step.activeProtectedLow : step.activeProtectedHigh;
                const mappedProt = isBull ? mapLowSlot(stepSlot) : mapHighSlot(stepSlot);
                // Fallback to stepSlot (HTF index mapped to chart coords) only when price & optional coords match identically
                if (stepSlot !== null &&
                    mappedProt !== null &&
                    stepSlot.price === protPrice &&
                    (protBarIndex === null || protBarIndex === mappedProt.barIndex) &&
                    (protTimestamp === null || protTimestamp === mappedProt.time)) {
                    protBarIndex = protBarIndex ?? mappedProt.barIndex;
                    protTimestamp = protTimestamp ?? mappedProt.time;
                }
            }
        } else {
            // Frozen stepPHL emits 0 sentinel when hasProtectedLevel=false; V4 normalizes output to null
            if ((rawProtPrice !== undefined && rawProtPrice !== null && rawProtPrice !== 0) ||
                (rawOptBar !== undefined && rawOptBar !== null) ||
                (rawOptTime !== undefined && rawOptTime !== null)) {
                throw new Error('PHL V4 Contract Error: hasProtectedLevel=false must not carry non-zero protected-level metadata.');
            }
        }

        const distToProtectedAtr =
            hasProtectedLevel && protPrice !== null && atr14Valid
                ? (isBull
                    ? (completedBucket.close - protPrice) / effectiveAtr14!
                    : (protPrice - completedBucket.close) / effectiveAtr14!)
                : null;

        const eventDiscriminator = [
            config.symbol,
            config.baseTimeframe,
            config.phlTimeframe,
            breakType,
            rawEv.eventDirection,
            sourceTimestamp,
            confirmChartTimestamp
        ].join(':');

        outEvents.push(
            Object.freeze({
                strategyId: 'PHL_BOS_MSS' as const,
                strategyVersion: PHL_V4_TEACHER_VERSION,
                symbol: config.symbol,
                timeframe: config.baseTimeframe,
                phlTimeframe: config.phlTimeframe,
                eventType: rawEv.eventType as PHLV4TeacherEvent['eventType'],
                eventDirection: rawEv.eventDirection,
                eventDiscriminator,
                sourceBarIndex,
                sourceTimestamp,
                confirmationBarIndex: confirmChartBarIndex,
                confirmationTimestamp: confirmChartTimestamp,
                structuralContext: Object.freeze({
                    phlTimeframe: config.phlTimeframe,
                    breakType,
                    brokenLevelPrice,
                    hasProtectedLevel,
                    protectedLevelPrice: protPrice,
                    protectedLevelBarIndex: protBarIndex,
                    protectedLevelTimestamp: protTimestamp,
                    atr14Valid,
                    distToProtectedAtr,
                    pbFromLowValid,
                    pbFromHighValid
                })
            })
        );
    }

    const keepMinIndices: number[] = [];
    if (nextPhl.window.length > 0) keepMinIndices.push(nextPhl.window[0].barIndex);
    if (nextPhl.ph) keepMinIndices.push(nextPhl.ph.barIndex);
    if (nextPhl.pl) keepMinIndices.push(nextPhl.pl.barIndex);
    if (nextPhl.trackHighIdx !== null) keepMinIndices.push(nextPhl.trackHighIdx);
    if (nextPhl.trackLowIdx !== null) keepMinIndices.push(nextPhl.trackLowIdx);
    if (nextPhl.lastHighIdx !== null) keepMinIndices.push(nextPhl.lastHighIdx);
    if (nextPhl.lastLowIdx !== null) keepMinIndices.push(nextPhl.lastLowIdx);
    const minKeep = keepMinIndices.length > 0 ? Math.min(...keepMinIndices) : htfIdx;
    for (const k of Object.keys(nextAnchorsMutable)) {
        if (Number(k) < minKeep) delete nextAnchorsMutable[Number(k)];
    }

    return {
        nextState: Object.freeze({
            stateVersion: 2 as const,
            phlState: nextPhl,
            htfAtrState: nextHtfAtrState,
            prevHtfClose: nextPrevHtfClose,
            htfBarIndex: htfIdx + 1,
            htfBarAnchors: Object.freeze(nextAnchorsMutable),
            formingBucket: null,
            lastProcessedTimestamp: confirmChartTimestamp,
            lastProcessedBarIndex: confirmChartBarIndex
        }),
        events: Object.freeze(outEvents),
        confirmedPivotHigh: mapHighSlot(step.confirmedPivotHigh),
        confirmedPivotLow: mapLowSlot(step.confirmedPivotLow)
    };
}

export function stepPHLV4(
    candle: ML1Candle,
    barIndex: number,
    state: PHLV4State,
    config: PHLV4Config,
    isDiscontinuity: boolean,
    atr14: number | null
): {
    readonly nextState: PHLV4State;
    readonly events: readonly PHLV4TeacherEvent[];
    readonly confirmedPivotHigh: PHLPivotSlot | null;
    readonly confirmedPivotLow: PHLPivotSlot | null;
} {
    validatePHLV4InputBoundary(candle, barIndex, state, config, isDiscontinuity, atr14);

    const bucketStart = Math.floor(candle.time / config.phlIntervalMs) * config.phlIntervalMs;
    const hasMissingBaseCandle =
        state.lastProcessedTimestamp !== null &&
        candle.time !== state.lastProcessedTimestamp + config.baseIntervalMs;
    const effectiveDiscontinuity = isDiscontinuity || hasMissingBaseCandle;

    if (effectiveDiscontinuity) {
        const clean = createInitialPHLV4State();
        if (config.expectedBarsPerBucket === 1) {
            const singleBucket: FormingPHLBucket = {
                bucketStart: candle.time,
                open: candle.open,
                high: candle.high,
                low: candle.low,
                close: candle.close,
                volume: candle.volume,
                peakChartBar: barIndex,
                peakChartTime: candle.time,
                troughChartBar: barIndex,
                troughChartTime: candle.time,
                lastCandleTime: candle.time,
                barCount: 1,
                isCorrupt: false
            };
            const stepped = stepCompletedPHLBucket(singleBucket, barIndex, candle.time, atr14, config, clean, true);
            return { nextState: stepped.nextState, events: Object.freeze([]), confirmedPivotHigh: null, confirmedPivotLow: null };
        }

        const startsOnBucket = candle.time === bucketStart;
        return {
            nextState: Object.freeze({
                ...clean,
                lastProcessedTimestamp: candle.time,
                lastProcessedBarIndex: barIndex,
                formingBucket: startsOnBucket
                    ? Object.freeze({
                        bucketStart,
                        open: candle.open,
                        high: candle.high,
                        low: candle.low,
                        close: candle.close,
                        volume: candle.volume,
                        peakChartBar: barIndex,
                        peakChartTime: candle.time,
                        troughChartBar: barIndex,
                        troughChartTime: candle.time,
                        lastCandleTime: candle.time,
                        barCount: 1,
                        isCorrupt: false
                    })
                    : null
            }),
            events: Object.freeze([]),
            confirmedPivotHigh: null,
            confirmedPivotLow: null
        };
    }

    let workingState = state;
    let activeBucket = state.formingBucket;
    if (activeBucket !== null && bucketStart > activeBucket.bucketStart) {
        workingState = {
            ...createInitialPHLV4State(),
            lastProcessedTimestamp: state.lastProcessedTimestamp,
            lastProcessedBarIndex: state.lastProcessedBarIndex
        };
        activeBucket = null;
    }

    if (activeBucket === null) {
        if (candle.time === bucketStart) {
            activeBucket = Object.freeze({
                bucketStart,
                open: candle.open,
                high: candle.high,
                low: candle.low,
                close: candle.close,
                volume: candle.volume,
                peakChartBar: barIndex,
                peakChartTime: candle.time,
                troughChartBar: barIndex,
                troughChartTime: candle.time,
                lastCandleTime: candle.time,
                barCount: 1,
                isCorrupt: false
            });
        }
    } else if (bucketStart === activeBucket.bucketStart && !activeBucket.isCorrupt) {
        const newHigh = candle.high > activeBucket.high;
        const newLow = candle.low < activeBucket.low;
        activeBucket = Object.freeze({
            ...activeBucket,
            high: newHigh ? candle.high : activeBucket.high,
            low: newLow ? candle.low : activeBucket.low,
            close: candle.close,
            volume: activeBucket.volume + candle.volume,
            peakChartBar: newHigh ? barIndex : activeBucket.peakChartBar,
            peakChartTime: newHigh ? candle.time : activeBucket.peakChartTime,
            troughChartBar: newLow ? barIndex : activeBucket.troughChartBar,
            troughChartTime: newLow ? candle.time : activeBucket.troughChartTime,
            lastCandleTime: candle.time,
            barCount: activeBucket.barCount + 1
        });
    }

    const expectedCloseTime = bucketStart + config.phlIntervalMs - config.baseIntervalMs;
    const isBucketComplete =
        activeBucket !== null &&
        !activeBucket.isCorrupt &&
        activeBucket.barCount === config.expectedBarsPerBucket &&
        candle.time === expectedCloseTime;

    if (!isBucketComplete) {
        return {
            nextState: Object.freeze({
                ...workingState,
                formingBucket: activeBucket,
                lastProcessedTimestamp: candle.time,
                lastProcessedBarIndex: barIndex
            }),
            events: Object.freeze([]),
            confirmedPivotHigh: null,
            confirmedPivotLow: null
        };
    }

    // If this completed bucket is the first HTF candle after a reset (htfBarIndex === 0), propagate isBucketDiscontinuity=true
    const isBucketDisc = workingState.htfBarIndex === 0;
    return stepCompletedPHLBucket(activeBucket!, barIndex, candle.time, atr14, config, workingState, isBucketDisc);
}

// =========================================================================
// V4 PHL Multi-Timeframe Coordinator (1m, 3m, 5m)
// =========================================================================
export const V4_PHL_TIMEFRAMES: readonly PHLTimeframe[] = Object.freeze(['1m', '3m', '5m']);

export type PHLV4MultiState = Readonly<Record<PHLTimeframe, PHLV4State>>;

export function createDefaultPHLV4MultiConfigs(
    symbol: string,
    baseTimeframe: string,
    baseIntervalMs: number,
    timeframes: readonly PHLTimeframe[] = V4_PHL_TIMEFRAMES,
    options?: { pivotStrength?: number; useValidPullbacks?: boolean; extraValidPullbacks?: boolean }
): PHLV4Config[] {
    if (!Array.isArray(timeframes) || timeframes.length === 0) {
        throw new Error('PHL V4 Multi Config Error: timeframes must be a non-empty array of 1m/3m/5m.');
    }
    const allowed = new Set<string>(V4_PHL_TIMEFRAMES);
    const seen = new Set<string>();
    for (const tf of timeframes) {
        if (!allowed.has(tf)) {
            throw new Error(`PHL V4 Multi Config Error: unsupported timeframe '${String(tf)}'.`);
        }
        if (seen.has(tf)) {
            throw new Error(`PHL V4 Multi Config Error: duplicate timeframe '${tf}'.`);
        }
        seen.add(tf);
    }
    return timeframes.map(tf => createDefaultPHLV4Config(symbol, baseTimeframe, baseIntervalMs, tf, options));
}

export function createInitialPHLV4MultiState(): PHLV4MultiState {
    return Object.freeze({
        '1m': createInitialPHLV4State(),
        '3m': createInitialPHLV4State(),
        '5m': createInitialPHLV4State()
    });
}

export function validatePHLV4MultiState(
    state: PHLV4MultiState,
    configs: readonly PHLV4Config[]
): void {
    if (!state || typeof state !== 'object') {
        throw new Error('PHL V4 Multi State Error: state must be an object.');
    }
    if (!Array.isArray(configs as unknown) || configs.length === 0) {
        throw new Error('PHL V4 Multi Config Error: configs must be non-empty.');
    }
    const baseCfg = configs[0];
    validatePHLV4Config(baseCfg);
    const seen = new Set<PHLTimeframe>();
    for (const cfg of configs) {
        validatePHLV4Config(cfg);
        if (cfg.symbol !== baseCfg.symbol ||
            cfg.baseTimeframe !== baseCfg.baseTimeframe ||
            cfg.baseIntervalMs !== baseCfg.baseIntervalMs) {
            throw new Error(
                `PHL V4 Multi Config Error: mixed symbol/baseTimeframe configs rejected ` +
                `('${cfg.symbol}/${cfg.baseTimeframe}/${cfg.baseIntervalMs}' vs '${baseCfg.symbol}/${baseCfg.baseTimeframe}/${baseCfg.baseIntervalMs}').`
            );
        }
        if (seen.has(cfg.phlTimeframe)) {
            throw new Error(`PHL V4 Multi Config Error: duplicate timeframe config '${cfg.phlTimeframe}'.`);
        }
        seen.add(cfg.phlTimeframe);
        validatePHLV4State(state[cfg.phlTimeframe], cfg);
    }
}

export function stepPHLV4Multi(
    candle: ML1Candle,
    barIndex: number,
    state: PHLV4MultiState,
    configs: readonly PHLV4Config[],
    isDiscontinuity: boolean,
    atr14: number | null
): {
    readonly nextState: PHLV4MultiState;
    readonly events: readonly PHLV4TeacherEvent[];
} {
    validatePHLV4MultiState(state, configs);
    const mutableState: Record<PHLTimeframe, PHLV4State> = { ...state };
    const allEvents: PHLV4TeacherEvent[] = [];

    for (const cfg of configs) {
        const res = stepPHLV4(candle, barIndex, mutableState[cfg.phlTimeframe], cfg, isDiscontinuity, atr14);
        mutableState[cfg.phlTimeframe] = res.nextState;
        allEvents.push(...res.events);
    }

    allEvents.sort((a, b) =>
        a.confirmationBarIndex - b.confirmationBarIndex ||
        a.eventType.localeCompare(b.eventType) ||
        a.eventDiscriminator.localeCompare(b.eventDiscriminator)
    );

    return { nextState: Object.freeze(mutableState), events: Object.freeze(allEvents) };
}

// =========================================================================
// V5 PHL Directional Entry Zones (Preserves Frozen Phase 2 stepPHL & V4)
// =========================================================================

export const V5_PHL_TIMEFRAMES: readonly V5ZoneTimeframe[] = Object.freeze(['1m', '3m', '5m']);

export interface V5PHLActiveZone {
    readonly zoneId: string;
    readonly symbol: string;
    readonly zoneTimeframe: V5ZoneTimeframe;
    readonly zoneSide: 'PHL_BUY_ZONE' | 'PHL_SELL_ZONE';
    readonly zoneDirection: V5Direction;
    readonly breakType: 'BOS' | 'MSS';
    readonly zoneTop: number;
    readonly zoneBot: number;
    readonly previousLevelPrice: number;
    readonly previousLevelBaseBarIndex: number;
    readonly previousLevelTimestamp: number;
    readonly protectedLevelPrice: number;
    readonly protectedLevelBaseBarIndex: number;
    readonly protectedLevelTimestamp: number;
    readonly createdBaseBarIndex: number;
    readonly createdSourceTimestamp: number;
    readonly createdConfirmationTimestamp: number;
    readonly createdNativeBarIndex: number;
    readonly retestCount: number;
    readonly wasOutsideSinceLastEvent: boolean;
    readonly lastRetestBaseBarIndex: number;
}

export interface V5PHLLifecycleEvent extends V5ZoneLifecycleRecord {
    readonly source: 'PHL';
    readonly zoneSide: 'PHL_BUY_ZONE' | 'PHL_SELL_ZONE';
    readonly breakType: 'BOS' | 'MSS';
    readonly previousLevelPrice: number;
    readonly previousLevelBaseBarIndex: number;
    readonly previousLevelTimestamp: number;
    readonly protectedLevelPrice: number;
    readonly protectedLevelBaseBarIndex: number;
    readonly protectedLevelTimestamp: number;
    readonly touchExtremePrice: number | null;
    readonly eventClosePrice: number;
}

export interface V5PHLActiveZoneView {
    readonly zone: V5PHLActiveZone;
    readonly zoneAgeBaseBars: number;
    readonly zoneAgeHtfBars: number;
}

export interface V5PHLState {
    readonly phlV4State: PHLV4State;
    readonly activeZones: readonly V5PHLActiveZone[];
    readonly historicalBrokenBuyCount: number;
    readonly historicalBrokenSellCount: number;
    readonly historicalSupersededCount: number;
}

export type V5PHLMultiState = Readonly<Record<V5ZoneTimeframe, V5PHLState>>;

export function createDefaultV5PHLMultiConfigs(
    symbol: string,
    baseTimeframe: string,
    baseIntervalMs: number,
    timeframes: readonly V5ZoneTimeframe[] = V5_PHL_TIMEFRAMES,
    options?: { pivotStrength?: number; useValidPullbacks?: boolean; extraValidPullbacks?: boolean }
): PHLV4Config[] {
    return createDefaultPHLV4MultiConfigs(symbol, baseTimeframe, baseIntervalMs, timeframes, {
        pivotStrength: options?.pivotStrength ?? 8,
        useValidPullbacks: options?.useValidPullbacks ?? true,
        extraValidPullbacks: options?.extraValidPullbacks ?? false
    });
}

export function createInitialV5PHLState(): V5PHLState {
    return Object.freeze({
        phlV4State: createInitialPHLV4State(),
        activeZones: Object.freeze([]),
        historicalBrokenBuyCount: 0,
        historicalBrokenSellCount: 0,
        historicalSupersededCount: 0
    });
}

export function createInitialV5PHLMultiState(): V5PHLMultiState {
    return Object.freeze({
        '1m': createInitialV5PHLState(),
        '3m': createInitialV5PHLState(),
        '5m': createInitialV5PHLState()
    });
}

export function classifyV5PHLDiscontinuity(
    candle: ML1Candle,
    prevPhl: PHLV4State,
    config: PHLV4Config,
    isDiscontinuity: boolean
): {
    readonly effectiveDiscontinuity: boolean;
    readonly explicitDiscontinuity: boolean;
    readonly hasMissingBaseCandle: boolean;
    readonly isGenuineIncompleteBucket: boolean;
} {
    const validTs = Number.isSafeInteger(candle?.time) && candle.time > 0 && candle.time % config.baseIntervalMs === 0;
    const bucketStart = validTs ? Math.floor(candle.time / config.phlIntervalMs) * config.phlIntervalMs : 0;
    const hasMissingBaseCandle =
        validTs &&
        prevPhl.lastProcessedTimestamp !== null &&
        candle.time > prevPhl.lastProcessedTimestamp &&
        candle.time !== prevPhl.lastProcessedTimestamp + config.baseIntervalMs;
    const isGenuineIncompleteBucket =
        validTs &&
        prevPhl.formingBucket !== null &&
        bucketStart > prevPhl.formingBucket.bucketStart &&
        prevPhl.formingBucket.lastCandleTime <
        prevPhl.formingBucket.bucketStart + config.phlIntervalMs - config.baseIntervalMs;
    return Object.freeze({
        effectiveDiscontinuity: isDiscontinuity || hasMissingBaseCandle || isGenuineIncompleteBucket,
        explicitDiscontinuity: isDiscontinuity,
        hasMissingBaseCandle,
        isGenuineIncompleteBucket
    });
}

export function assertV5PHLStateConsistency(state: V5PHLState, config: PHLV4Config): void {
    validatePHLV4State(state.phlV4State, config);
    const seenIds = new Set<string>();
    for (const z of state.activeZones) {
        if (z.symbol !== config.symbol || z.zoneTimeframe !== config.phlTimeframe) {
            throw new Error(`V5 PHL Consistency Error: zone ${z.zoneId} symbol/tf mismatch.`);
        }
        if (!Number.isFinite(z.zoneTop) || !Number.isFinite(z.zoneBot) || z.zoneTop <= z.zoneBot) {
            throw new Error(`V5 PHL Consistency Error: zone ${z.zoneId} invalid bounds.`);
        }
        if (!Number.isSafeInteger(z.retestCount) || z.retestCount < 0) {
            throw new Error(`V5 PHL Consistency Error: zone ${z.zoneId} invalid retestCount ${z.retestCount}.`);
        }
        if (seenIds.has(z.zoneId)) {
            throw new Error(`V5 PHL Consistency Error: duplicate active zoneId '${z.zoneId}'.`);
        }
        seenIds.add(z.zoneId);
    }
}

function buildV5PHLLifecycleEvent(params: {
    readonly zone: V5PHLActiveZone;
    readonly eventType: V5ZoneLifecycleEvent;
    readonly zoneActivity: V5ZoneActivityState;
    readonly eventDirection: V5Direction | null;
    readonly retestCount: number;
    readonly retestEpisodeId: string | null;
    readonly barIndex: number;
    readonly completedNativeCount: number;
    readonly candle: ML1Candle;
    readonly effectiveAtr14: number | null;
    readonly touchExtremePrice: number | null;
    readonly eventClosePrice: number;
    readonly supersededByZoneId: string | null;
}): V5PHLLifecycleEvent {
    const {
        zone, eventType, zoneActivity, eventDirection, retestCount, retestEpisodeId,
        barIndex, completedNativeCount, candle, effectiveAtr14, touchExtremePrice,
        eventClosePrice, supersededByZoneId
    } = params;

    const atr14Valid = effectiveAtr14 !== null && Number.isFinite(effectiveAtr14) && effectiveAtr14 > 0;
    const zoneWidthAtr = atr14Valid ? (zone.zoneTop - zone.zoneBot) / effectiveAtr14! : null;

    const closeDepth = computeV5DepthMetrics(zone.zoneTop, zone.zoneBot, eventClosePrice, zone.zoneDirection);
    const touchDepth = touchExtremePrice !== null
        ? computeV5DepthMetrics(zone.zoneTop, zone.zoneBot, touchExtremePrice, zone.zoneDirection)
        : null;

    const confirmationNativeBarIndex = Math.max(zone.createdNativeBarIndex, completedNativeCount - 1);
    const suffix = eventType === 'RETESTED' ? `RETESTED:R${retestCount}` : eventType;
    const lifecycleId = `${zone.zoneId}:${suffix}:${barIndex}`;

    const record: V5PHLLifecycleEvent = Object.freeze({
        lifecycleId,
        zoneId: zone.zoneId,
        symbol: zone.symbol,
        source: 'PHL' as const,
        zoneTimeframe: zone.zoneTimeframe,
        zoneSide: zone.zoneSide,
        zoneDirection: zone.zoneDirection,
        eventType,
        eventDirection,
        zoneActivity,
        eventRole: 'ZONE_LIFECYCLE' as const,
        outcomeEligible: false as const,
        retestCount,
        retestEpisodeId,
        zoneTop: zone.zoneTop,
        zoneBot: zone.zoneBot,
        createdSourceTimestamp: zone.createdSourceTimestamp,
        createdConfirmationTimestamp: zone.createdConfirmationTimestamp,
        confirmationTimestamp: candle.time,
        createdBaseBarIndex: zone.createdBaseBarIndex,
        confirmationBaseBarIndex: barIndex,
        createdNativeBarIndex: zone.createdNativeBarIndex,
        confirmationNativeBarIndex,
        zoneAgeBaseBars: barIndex - zone.createdBaseBarIndex,
        zoneAgeNativeBars: confirmationNativeBarIndex - zone.createdNativeBarIndex,
        touchDepthNormRaw: touchDepth ? touchDepth.raw : null,
        touchDepthNormClamped: touchDepth ? touchDepth.clamped : null,
        closeDepthNormRaw: closeDepth.raw,
        closeDepthNormClamped: closeDepth.clamped,
        atr14Valid,
        zoneWidthAtr,
        supersededByZoneId,
        breakType: zone.breakType,
        previousLevelPrice: zone.previousLevelPrice,
        previousLevelBaseBarIndex: zone.previousLevelBaseBarIndex,
        previousLevelTimestamp: zone.previousLevelTimestamp,
        protectedLevelPrice: zone.protectedLevelPrice,
        protectedLevelBaseBarIndex: zone.protectedLevelBaseBarIndex,
        protectedLevelTimestamp: zone.protectedLevelTimestamp,
        touchExtremePrice,
        eventClosePrice
    });

    validateV5ZoneLifecycleRecord(record);
    return record;
}

function computeV5BarReactionScore(candle: ML1Candle, direction: V5Direction, z: V5PHLActiveZone): {
    readonly confirmed: boolean;
    readonly score: number;
} {
    const range = Math.max(candle.high - candle.low, 1e-12);
    const body = Math.abs(candle.close - candle.open);
    const bodyRatio = Math.min(1, body / range);

    if (direction === 'bull') {
        const confirmed = candle.close > candle.open && candle.close >= z.zoneBot;
        if (!confirmed) return { confirmed: false, score: 0 };
        const lowerWick = Math.max(0, Math.min(candle.open, candle.close) - candle.low);
        const wickRatio = Math.min(1, lowerWick / range);
        return { confirmed: true, score: Math.min(1, Math.max(0, 0.5 * bodyRatio + 0.5 * wickRatio)) };
    }
    const confirmed = candle.close < candle.open && candle.close <= z.zoneTop;
    if (!confirmed) return { confirmed: false, score: 0 };
    const upperWick = Math.max(0, candle.high - Math.max(candle.open, candle.close));
    const wickRatio = Math.min(1, upperWick / range);
    return { confirmed: true, score: Math.min(1, Math.max(0, 0.5 * bodyRatio + 0.5 * wickRatio)) };
}

export function stepPHLV5(
    candle: ML1Candle,
    barIndex: number,
    state: V5PHLState,
    config: PHLV4Config,
    isDiscontinuity: boolean,
    atr14_1m: number | null
): {
    readonly nextState: V5PHLState;
    readonly lifecycleEvents: readonly V5PHLLifecycleEvent[];
    readonly retestCandidates: readonly V5PhlRetestCandidateRecord[];
} {
    assertV5PHLStateConsistency(state, config);
    const prevPhl = state.phlV4State;
    const { effectiveDiscontinuity } = classifyV5PHLDiscontinuity(candle, prevPhl, config, isDiscontinuity);

    // 1. Step canonical V4 PHL teacher (passes effectiveDiscontinuity so canonical state resets cleanly)
    const stepRes = stepPHLV4(candle, barIndex, prevPhl, config, effectiveDiscontinuity, atr14_1m);
    const nextPhl = stepRes.nextState;

    const effectiveAtr14 = config.expectedBarsPerBucket === 1
        ? atr14_1m
        : (nextPhl.htfAtrState?.isSeeded && nextPhl.htfAtrState.atr !== null && nextPhl.htfAtrState.atr > 0
            ? nextPhl.htfAtrState.atr
            : null);

    const lifecycleEvents: V5PHLLifecycleEvent[] = [];
    const retestCandidates: V5PhlRetestCandidateRecord[] = [];
    let brokenBuyCount = state.historicalBrokenBuyCount;
    let brokenSellCount = state.historicalBrokenSellCount;
    let supersededCount = state.historicalSupersededCount;

    // 2. Discontinuity: emit GAP_RESET (eventDirection: null) for all active PHL zones and clear
    if (effectiveDiscontinuity) {
        if (nextPhl.phlState.ph !== null || nextPhl.phlState.pl !== null) {
            throw new Error('V5 PHL Gap Reset Error: canonical PHL state retained active levels after discontinuity.');
        }
        const preGapAtr = config.expectedBarsPerBucket === 1
            ? atr14_1m
            : (prevPhl.htfAtrState?.isSeeded && prevPhl.htfAtrState.atr !== null && prevPhl.htfAtrState.atr > 0
                ? prevPhl.htfAtrState.atr
                : null);

        for (const prevZ of state.activeZones) {
            lifecycleEvents.push(buildV5PHLLifecycleEvent({
                zone: prevZ,
                eventType: 'GAP_RESET',
                zoneActivity: 'GAP_RESET',
                eventDirection: null,
                retestCount: prevZ.retestCount,
                retestEpisodeId: null,
                barIndex,
                completedNativeCount: prevPhl.htfBarIndex,
                candle,
                effectiveAtr14: preGapAtr,
                touchExtremePrice: null,
                eventClosePrice: candle.close,
                supersededByZoneId: null
            }));
        }
        const resetState: V5PHLState = Object.freeze({
            phlV4State: nextPhl,
            activeZones: Object.freeze([]),
            historicalBrokenBuyCount: brokenBuyCount,
            historicalBrokenSellCount: brokenSellCount,
            historicalSupersededCount: supersededCount
        });
        assertV5PHLStateConsistency(resetState, config);
        return {
            nextState: resetState,
            lifecycleEvents: Object.freeze(lifecycleEvents),
            retestCandidates: Object.freeze([])
        };
    }

    const nativeBucketCompleted = nextPhl.htfBarIndex > prevPhl.htfBarIndex;
    const completedNativeClose = nativeBucketCompleted && nextPhl.phlState.window.length > 0
        ? nextPhl.phlState.window[nextPhl.phlState.window.length - 1].close
        : null;

    let survivingZones: V5PHLActiveZone[] = [...state.activeZones];

    // 3. Structural invalidation (BROKEN) & creation/supersession ONLY on completed native-timeframe candles
    if (nativeBucketCompleted && completedNativeClose !== null) {
        // 3a. Evaluate BROKEN FIRST (close past protected boundary always produces BROKEN, never SUPERSEDED)
        const notBroken: V5PHLActiveZone[] = [];
        for (const z of survivingZones) {
            const brokeStructurally = z.zoneDirection === 'bull'
                ? completedNativeClose < z.zoneBot
                : completedNativeClose > z.zoneTop;

            if (brokeStructurally) {
                if (z.zoneDirection === 'bull') brokenBuyCount++;
                else brokenSellCount++;

                lifecycleEvents.push(buildV5PHLLifecycleEvent({
                    zone: z,
                    eventType: 'BROKEN',
                    zoneActivity: 'BROKEN',
                    eventDirection: z.zoneDirection === 'bull' ? 'bear' : 'bull',
                    retestCount: z.retestCount,
                    retestEpisodeId: null,
                    barIndex,
                    completedNativeCount: nextPhl.htfBarIndex,
                    candle,
                    effectiveAtr14,
                    touchExtremePrice: null,
                    eventClosePrice: completedNativeClose,
                    supersededByZoneId: null
                }));
            } else {
                notBroken.push(z);
            }
        }
        survivingZones = notBroken;

        // 3b. Evaluate newly created PHL directional entry zone from canonical BOS/MSS
        for (const ev of stepRes.events) {
            const ctx = ev.structuralContext;
            if (!ctx.hasProtectedLevel ||
                ctx.protectedLevelPrice === null ||
                ctx.protectedLevelBarIndex === null ||
                ctx.protectedLevelTimestamp === null) {
                continue;
            }

            const zoneDirection: V5Direction = ev.eventDirection;
            const zoneSide: 'PHL_BUY_ZONE' | 'PHL_SELL_ZONE' =
                zoneDirection === 'bull' ? 'PHL_BUY_ZONE' : 'PHL_SELL_ZONE';

            const zoneTop = zoneDirection === 'bull' ? ctx.brokenLevelPrice : ctx.protectedLevelPrice;
            const zoneBot = zoneDirection === 'bull' ? ctx.protectedLevelPrice : ctx.brokenLevelPrice;
            if (!Number.isFinite(zoneTop) || !Number.isFinite(zoneBot) || zoneTop <= zoneBot) {
                continue;
            }

            const newZoneId = buildV5ZoneId({
                symbol: config.symbol,
                source: 'PHL',
                timeframe: config.phlTimeframe,
                side: zoneSide,
                createdSourceTimestamp: ev.sourceTimestamp,
                createdConfirmationTimestamp: ev.confirmationTimestamp
            });

            // Any non-broken prior zone on this same timeframe is SUPERSEDED by the new zone
            for (const oldZ of survivingZones) {
                supersededCount++;
                lifecycleEvents.push(buildV5PHLLifecycleEvent({
                    zone: oldZ,
                    eventType: 'SUPERSEDED',
                    zoneActivity: 'SUPERSEDED',
                    eventDirection: null,
                    retestCount: oldZ.retestCount,
                    retestEpisodeId: null,
                    barIndex,
                    completedNativeCount: nextPhl.htfBarIndex,
                    candle,
                    effectiveAtr14,
                    touchExtremePrice: null,
                    eventClosePrice: completedNativeClose,
                    supersededByZoneId: newZoneId
                }));
            }

            const newZone: V5PHLActiveZone = Object.freeze({
                zoneId: newZoneId,
                symbol: config.symbol,
                zoneTimeframe: config.phlTimeframe,
                zoneSide,
                zoneDirection,
                breakType: ctx.breakType,
                zoneTop,
                zoneBot,
                previousLevelPrice: ctx.brokenLevelPrice,
                previousLevelBaseBarIndex: ev.sourceBarIndex,
                previousLevelTimestamp: ev.sourceTimestamp,
                protectedLevelPrice: ctx.protectedLevelPrice,
                protectedLevelBaseBarIndex: ctx.protectedLevelBarIndex,
                protectedLevelTimestamp: ctx.protectedLevelTimestamp,
                createdBaseBarIndex: barIndex,
                createdSourceTimestamp: ev.sourceTimestamp,
                createdConfirmationTimestamp: ev.confirmationTimestamp,
                createdNativeBarIndex: Math.max(0, nextPhl.htfBarIndex - 1),
                retestCount: 0,
                wasOutsideSinceLastEvent: zoneDirection === 'bull'
                    ? completedNativeClose > zoneTop
                    : completedNativeClose < zoneBot,
                lastRetestBaseBarIndex: -1
            });

            survivingZones = [newZone];
            lifecycleEvents.push(buildV5PHLLifecycleEvent({
                zone: newZone,
                eventType: 'CREATED',
                zoneActivity: 'ACTIVE',
                eventDirection: newZone.zoneDirection,
                retestCount: 0,
                retestEpisodeId: null,
                barIndex,
                completedNativeCount: nextPhl.htfBarIndex,
                candle,
                effectiveAtr14,
                touchExtremePrice: null,
                eventClosePrice: completedNativeClose,
                supersededByZoneId: null
            }));
        }
    }

    // 4. Evaluate 1m retest episodes & trade candidates on pre-existing surviving zones (never on creation/terminal bars)
    const nextActiveZones: V5PHLActiveZone[] = [];
    for (const z of survivingZones) {
        if (z.createdBaseBarIndex === barIndex) {
            nextActiveZones.push(z);
            continue;
        }

        const touchedZone = candle.high >= z.zoneBot && candle.low <= z.zoneTop;
        const outsideNow = z.zoneDirection === 'bull'
            ? candle.low > z.zoneTop
            : candle.high < z.zoneBot;

        if (touchedZone && z.wasOutsideSinceLastEvent && barIndex > z.lastRetestBaseBarIndex) {
            const nextCount = z.retestCount + 1;
            const touchExtreme = z.zoneDirection === 'bull' ? candle.low : candle.high;
            const episodeId = buildV5PhlRetestEpisodeId(z.zoneId, nextCount, candle.time);
            const candidateId = buildV5CandidateEventId(episodeId, z.zoneDirection);

            const updatedZ: V5PHLActiveZone = Object.freeze({
                ...z,
                retestCount: nextCount,
                wasOutsideSinceLastEvent: false,
                lastRetestBaseBarIndex: barIndex
            });
            nextActiveZones.push(updatedZ);

            lifecycleEvents.push(buildV5PHLLifecycleEvent({
                zone: updatedZ,
                eventType: 'RETESTED',
                zoneActivity: 'ACTIVE',
                eventDirection: updatedZ.zoneDirection,
                retestCount: nextCount,
                retestEpisodeId: episodeId,
                barIndex,
                completedNativeCount: nextPhl.htfBarIndex,
                candle,
                effectiveAtr14,
                touchExtremePrice: touchExtreme,
                eventClosePrice: candle.close,
                supersededByZoneId: null
            }));

            const touchDepth = computeV5DepthMetrics(updatedZ.zoneTop, updatedZ.zoneBot, touchExtreme, updatedZ.zoneDirection);
            const closeDepth = computeV5DepthMetrics(updatedZ.zoneTop, updatedZ.zoneBot, candle.close, updatedZ.zoneDirection);
            const reaction = computeV5BarReactionScore(candle, updatedZ.zoneDirection, updatedZ);

            retestCandidates.push(Object.freeze({
                eventId: candidateId,
                phlZoneId: updatedZ.zoneId,
                phlRetestEpisodeId: episodeId,
                zoneTimeframe: updatedZ.zoneTimeframe,
                zoneSide: updatedZ.zoneSide,
                direction: updatedZ.zoneDirection,
                eventRole: 'TRADE_CANDIDATE' as const,
                outcomeEligible: true as const,
                retestCount: nextCount,
                confirmationBarIndex: barIndex,
                confirmationTimestamp: candle.time,
                touchDepthNormRaw: touchDepth.raw,
                touchDepthNormClamped: touchDepth.clamped,
                closeDepthNormRaw: closeDepth.raw,
                closeDepthNormClamped: closeDepth.clamped,
                entryConfirmation: reaction.confirmed,
                entryConfirmationScore: reaction.score,
                entryConfirmationTimestamp: reaction.confirmed ? candle.time : null
            }));
        } else {
            nextActiveZones.push(Object.freeze({
                ...z,
                wasOutsideSinceLastEvent: z.wasOutsideSinceLastEvent || outsideNow
            }));
        }
    }

    const nextState: V5PHLState = Object.freeze({
        phlV4State: nextPhl,
        activeZones: Object.freeze(nextActiveZones),
        historicalBrokenBuyCount: brokenBuyCount,
        historicalBrokenSellCount: brokenSellCount,
        historicalSupersededCount: supersededCount
    });
    assertV5PHLStateConsistency(nextState, config);

    return {
        nextState,
        lifecycleEvents: Object.freeze(lifecycleEvents),
        retestCandidates: Object.freeze(retestCandidates)
    };
}

export function stepPHLV5Multi(
    candle: ML1Candle,
    barIndex: number,
    state: V5PHLMultiState,
    configs: readonly PHLV4Config[],
    isDiscontinuity: boolean,
    atr14_1m: number | null
): {
    readonly nextState: V5PHLMultiState;
    readonly lifecycleEvents: readonly V5PHLLifecycleEvent[];
    readonly retestCandidates: readonly V5PhlRetestCandidateRecord[];
} {
    if (!Array.isArray(configs as unknown) || configs.length === 0) {
        throw new Error('V5 PHL Multi Error: configs must be non-empty.');
    }
    const baseSymbol = configs[0].symbol;
    const seenTfs = new Set<V5ZoneTimeframe>();
    const mutableState: Record<V5ZoneTimeframe, V5PHLState> = { ...state };
    const allLifecycle: V5PHLLifecycleEvent[] = [];
    const allCandidates: V5PhlRetestCandidateRecord[] = [];

    for (const cfg of configs) {
        if (cfg.symbol !== baseSymbol) {
            throw new Error(`V5 PHL Multi Error: mixed symbols '${cfg.symbol}' vs '${baseSymbol}'.`);
        }
        if (seenTfs.has(cfg.phlTimeframe)) {
            throw new Error(`V5 PHL Multi Error: duplicate timeframe '${cfg.phlTimeframe}'.`);
        }
        seenTfs.add(cfg.phlTimeframe);
        const res = stepPHLV5(candle, barIndex, mutableState[cfg.phlTimeframe], cfg, isDiscontinuity, atr14_1m);
        mutableState[cfg.phlTimeframe] = res.nextState;
        allLifecycle.push(...res.lifecycleEvents);
        allCandidates.push(...res.retestCandidates);
    }

    allLifecycle.sort((a, b) =>
        a.confirmationBaseBarIndex - b.confirmationBaseBarIndex ||
        a.zoneTimeframe.localeCompare(b.zoneTimeframe) ||
        a.eventType.localeCompare(b.eventType) ||
        a.lifecycleId.localeCompare(b.lifecycleId)
    );
    allCandidates.sort((a, b) =>
        a.confirmationBarIndex - b.confirmationBarIndex ||
        a.zoneTimeframe.localeCompare(b.zoneTimeframe) ||
        a.eventId.localeCompare(b.eventId)
    );

    return {
        nextState: Object.freeze(mutableState),
        lifecycleEvents: Object.freeze(allLifecycle),
        retestCandidates: Object.freeze(allCandidates)
    };
}

export function getV5PHLActiveZoneViews(
    multiState: V5PHLMultiState,
    currentBarIndex: number,
    timeframes: readonly V5ZoneTimeframe[] = V5_PHL_TIMEFRAMES
): readonly V5PHLActiveZoneView[] {
    const views: V5PHLActiveZoneView[] = [];
    for (const tf of timeframes) {
        const tfState = multiState[tf];
        const currentNativeIdx = Math.max(0, tfState.phlV4State.htfBarIndex - 1);
        for (const z of tfState.activeZones) {
            views.push(Object.freeze({
                zone: z,
                zoneAgeBaseBars: currentBarIndex - z.createdBaseBarIndex,
                zoneAgeHtfBars: currentNativeIdx - z.createdNativeBarIndex
            }));
        }
    }
    return Object.freeze(views);
}
