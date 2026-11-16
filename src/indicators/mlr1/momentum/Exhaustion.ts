import type { ExhaustionPeriodState } from '../ML1FeatureTypes';

export function updateExhaustionCCI(
    high: number,
    low: number,
    close: number,
    period: number,
    prevState: ExhaustionPeriodState | undefined,
    isDiscontinuity: boolean
): { nextState: ExhaustionPeriodState; cciValue: number; isValid: boolean } {
    if (!Number.isSafeInteger(period) || period < 2) {
        throw new Error(`Exhaustion CCI Error: Period must be an integer >= 2, got ${period}.`);
    }

    // Rejected source observations are gated upstream in ML1FeatureEngine and never reach this helper.
    // This guard protects against malformed direct calls or extreme IEEE-754 overflow.
    const isValidOhlc =
        Number.isFinite(high) &&
        Number.isFinite(low) &&
        Number.isFinite(close) &&
        high >= low &&
        high >= close &&
        low <= close;

    const tp = isValidOhlc ? high / 3 + low / 3 + close / 3 : NaN;
    if (!Number.isFinite(tp)) {
        return {
            nextState: Object.freeze({ tpHistory: Object.freeze([]), unbrokenRun: 0 }),
            cciValue: 0,
            isValid: false
        };
    }

    if (isDiscontinuity || !prevState || prevState.tpHistory.length === 0) {
        return {
            nextState: Object.freeze({
                tpHistory: Object.freeze([tp]),
                unbrokenRun: 1
            }),
            cciValue: 0,
            isValid: false
        };
    }

    const nextHistory = Object.freeze([...prevState.tpHistory, tp].slice(-period));
    const nextRun = prevState.unbrokenRun + 1;
    const nextState: ExhaustionPeriodState = Object.freeze({
        tpHistory: nextHistory,
        unbrokenRun: nextRun
    });

    if (nextRun < period || nextHistory.length < period) {
        return { nextState, cciValue: 0, isValid: false };
    }

    let sum = 0;
    let allEqual = true;
    const first = nextHistory[0];
    for (let i = 0; i < period; i++) {
        const val = nextHistory[i];
        if (val !== first) allEqual = false;
        sum += val;
    }
    const sma = allEqual ? first : sum / period;
    if (!Number.isFinite(sma)) {
        return {
            nextState: Object.freeze({ tpHistory: Object.freeze([]), unbrokenRun: 0 }),
            cciValue: 0,
            isValid: false
        };
    }

    if (allEqual) {
        return { nextState, cciValue: 0, isValid: false };
    }

    let madSum = 0;
    for (let i = 0; i < period; i++) {
        madSum += Math.abs(nextHistory[i] - sma);
    }
    const mad = madSum / period;

    if (!Number.isFinite(mad) || mad <= 0) {
        return { nextState, cciValue: 0, isValid: false };
    }

    const raw = (tp - sma) / (0.015 * mad);
    if (!Number.isFinite(raw)) {
        return { nextState, cciValue: 0, isValid: false };
    }

    const cciValue = Math.max(-300, Math.min(300, raw));
    return { nextState, cciValue, isValid: true };
}
