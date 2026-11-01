import type { EMAPeriodState } from '../ML1FeatureTypes';

export function updateEMA(
    close: number,
    period: number,
    prevState: EMAPeriodState | undefined,
    isDiscontinuity: boolean,
    hasDataGap: boolean
): { nextState: EMAPeriodState; emaValue: number; isValid: boolean } {
    if (!Number.isSafeInteger(period) || period <= 0) {
        throw new Error(`EMA Period Error: Period must be a positive integer, got ${period}.`);
    }

    if (!Number.isFinite(close)) {
        return {
            nextState: prevState || Object.freeze({ count: 0, seedMean: 0, ema: null, isSeeded: false, history: Object.freeze([]), unbrokenRun: 0 }),
            emaValue: 0,
            isValid: false
        };
    }

    // Major discontinuity resets accumulator and history
    if (isDiscontinuity || !prevState || !Number.isFinite(prevState.count) || prevState.count <= 0) {
        const isPeriodOne = period === 1;
        return {
            nextState: Object.freeze({
                count: 1,
                seedMean: close,
                ema: isPeriodOne ? close : null,
                isSeeded: isPeriodOne,
                history: isPeriodOne ? Object.freeze([close]) : Object.freeze([]),
                unbrokenRun: 1
            }),
            emaValue: isPeriodOne ? close : 0,
            isValid: isPeriodOne
        };
    }

    const nextUnbrokenRun = (hasDataGap || isDiscontinuity) ? 1 : prevState.unbrokenRun + 1;

    // 1. Accumulating SMA seed phase via incremental mean
    if (!prevState.isSeeded) {
        const nextCount = prevState.count + 1;
        const nextSeedMean = prevState.seedMean + (close - prevState.seedMean) / nextCount;

        if (!Number.isFinite(nextSeedMean)) {
            return {
                nextState: Object.freeze({ count: 0, seedMean: 0, ema: null, isSeeded: false, history: Object.freeze([]), unbrokenRun: 0 }),
                emaValue: 0,
                isValid: false
            };
        }

        if (nextCount === period) {
            return {
                nextState: Object.freeze({
                    count: nextCount,
                    seedMean: nextSeedMean,
                    ema: nextSeedMean,
                    isSeeded: true,
                    history: Object.freeze([nextSeedMean]),
                    unbrokenRun: nextUnbrokenRun
                }),
                emaValue: nextSeedMean,
                isValid: true
            };
        }

        return {
            nextState: Object.freeze({
                count: nextCount,
                seedMean: nextSeedMean,
                ema: null,
                isSeeded: false,
                history: Object.freeze([]),
                unbrokenRun: nextUnbrokenRun
            }),
            emaValue: 0,
            isValid: false
        };
    }

    // 2. Convex combination recurrence: EMA_t = prevEma * (1 - alpha) + close * alpha
    // Numerically superior to prevEma + alpha * (close - prevEma) by avoiding intermediate subtraction overflow
    const alpha = 2 / (period + 1);
    const prevEma = prevState.ema!;
    const nextEma = prevEma * (1 - alpha) + close * alpha;
    const isValidEma = Number.isFinite(nextEma);

    if (!isValidEma) {
        // Calculation overflow/failure: reset to a consistent unseeded state to avoid corrupting the state machine
        return {
            nextState: Object.freeze({
                count: 0,
                seedMean: 0,
                ema: null,
                isSeeded: false,
                history: Object.freeze([]),
                unbrokenRun: 0
            }),
            emaValue: 0,
            isValid: false
        };
    }

    const nextHistory = Object.freeze([...prevState.history, nextEma].slice(-11));

    return {
        nextState: Object.freeze({
            count: prevState.count + 1,
            seedMean: prevState.seedMean,
            ema: nextEma,
            isSeeded: true,
            history: nextHistory,
            unbrokenRun: nextUnbrokenRun
        }),
        emaValue: nextEma,
        isValid: true
    };
}

export function calculateEMASlope(
    history: readonly number[],
    lookback: number,
    atr14: number,
    unbrokenRun: number
): { slope: number; isValid: boolean } {
    // Slopes require unbroken, expected-interval observations across the entire lookback
    if (unbrokenRun < lookback + 1 || history.length < lookback + 1 || atr14 <= 0 || !Number.isFinite(atr14)) {
        return { slope: 0, isValid: false };
    }

    const currentEma = history[history.length - 1];
    const pastEma = history[history.length - 1 - lookback];
    const slope = (currentEma - pastEma) / (lookback * atr14);

    const isValid = Number.isFinite(slope);
    return { slope: isValid ? slope : 0, isValid };
}
