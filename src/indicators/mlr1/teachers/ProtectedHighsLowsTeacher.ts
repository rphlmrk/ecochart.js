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
}

export interface PHLState {
    readonly stateVersion: 1;
    readonly window: readonly PHLWindowBar[];
    readonly bull: boolean | null; // null until first break
    readonly ph: PHLPivotSlot | null;
    readonly pl: PHLPivotSlot | null;
    readonly pbFromHigh: PHLPullbackTracker;
    readonly pbFromLow: PHLPullbackTracker;
    readonly lastHigh: number | null;
    readonly lastHighIdx: number | null;
    readonly lastLow: number | null;
    readonly lastLowIdx: number | null;
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
        window: Object.freeze([]),
        bull: null,
        ph: null,
        pl: null,
        pbFromHigh: Object.freeze({ price: null, idx: null, valid: false, bull: true }),
        pbFromLow: Object.freeze({ price: null, idx: null, valid: false, bull: false }),
        lastHigh: null,
        lastHighIdx: null,
        lastLow: null,
        lastLowIdx: null,
        trackHigh: null,
        trackHighIdx: null,
        trackHighTime: null,
        trackLow: null,
        trackLowIdx: null,
        trackLowTime: null
    });
}

function validatePHLState(state: PHLState, maxWin: number): void {
    if (!state || state.stateVersion !== 1 || !Array.isArray(state.window) || state.window.length > maxWin) {
        throw new Error('PHL State Integrity Error: invalid PHL state or window length.');
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
    const ps = config.pivotStrength;
    if (!Number.isSafeInteger(ps) || ps < 1) {
        throw new Error(`PHL Config Error: pivotStrength must be >= 1, got ${ps}.`);
    }
    const maxWindowLen = 2 * ps + 4; // Extra 3 bars support extraValidPullbacks lookback
    validatePHLState(previousState, maxWindowLen);

    const baseState = isDiscontinuity ? createInitialPHLState() : previousState;
    const bar: PHLWindowBar = Object.freeze({
        barIndex,
        time: candle.time,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close
    });
    const nextWindow = Object.freeze([...baseState.window, bar].slice(-maxWindowLen));

    let bull = baseState.bull;
    let ph = baseState.ph;
    let pl = baseState.pl;
    let pbFromHigh = baseState.pbFromHigh;
    let pbFromLow = baseState.pbFromLow;
    let lastHigh = baseState.lastHigh;
    let lastHighIdx = baseState.lastHighIdx;
    let lastLow = baseState.lastLow;
    let lastLowIdx = baseState.lastLowIdx;
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
                let pbPrice = cand.high;
                if (config.extraValidPullbacks) {
                    for (let offset = 0; offset <= 3 && candPos - offset >= 0; offset++) {
                        const look = nextWindow[candPos - offset];
                        if (look.close < look.open) {
                            pbPrice = look.high;
                            break;
                        }
                    }
                }
                pbFromLow = Object.freeze({ price: pbPrice, idx: barIndex, valid: false, bull: false });

                if (lastLow === null || cand.low < lastLow) {
                    lastLow = cand.low;
                    lastLowIdx = cand.barIndex;
                }
            }
        }

        if (isPivotHigh) {
            confirmedPivotHigh = Object.freeze({ price: cand.high, barIndex: cand.barIndex, time: cand.time });
            if (ph === null) {
                ph = confirmedPivotHigh;
                let pbPrice = cand.low;
                if (config.extraValidPullbacks) {
                    for (let offset = 0; offset <= 3 && candPos - offset >= 0; offset++) {
                        const look = nextWindow[candPos - offset];
                        if (look.close > look.open) {
                            pbPrice = look.low;
                            break;
                        }
                    }
                }
                pbFromHigh = Object.freeze({ price: pbPrice, idx: barIndex, valid: false, bull: true });

                if (lastHigh === null || cand.high > lastHigh) {
                    lastHigh = cand.high;
                    lastHighIdx = cand.barIndex;
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
        window: nextWindow,
        bull,
        ph,
        pl,
        pbFromHigh,
        pbFromLow,
        lastHigh,
        lastHighIdx,
        lastLow,
        lastLowIdx,
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
