import type { SMAPeriodState } from '../ML1FeatureTypes';

export function updateSMA(
    close: number,
    period: number,
    prevState: SMAPeriodState | undefined,
    isDiscontinuity: boolean,
    hasDataGap: boolean
): { nextState: SMAPeriodState; smaValue: number; isValid: boolean } {
    if (!Number.isSafeInteger(period) || period < 2) {
        throw new Error(`SMA Period Error: Period must be an integer >= 2, got ${period}.`);
    }

    if (!Number.isFinite(close)) {
        return {
            nextState: prevState || Object.freeze({
                closeHistory: Object.freeze([]),
                smaHistory: Object.freeze([]),
                unbrokenRun: 0
            }),
            smaValue: 0,
            isValid: false
        };
    }

    // Both major discontinuities and ordinary data gaps clear unweighted rolling history
    if (isDiscontinuity || hasDataGap || !prevState || prevState.closeHistory.length === 0) {
        return {
            nextState: Object.freeze({
                closeHistory: Object.freeze([close]),
                smaHistory: Object.freeze([]),
                unbrokenRun: 1
            }),
            smaValue: 0,
            isValid: false
        };
    }

    const nextCloses = Object.freeze([...prevState.closeHistory, close].slice(-period));
    const nextUnbrokenRun = prevState.unbrokenRun + 1;

    if (nextCloses.length < period) {
        return {
            nextState: Object.freeze({
                closeHistory: nextCloses,
                smaHistory: Object.freeze([]),
                unbrokenRun: nextUnbrokenRun
            }),
            smaValue: 0,
            isValid: false
        };
    }

    let sum = 0;
    for (let i = 0; i < nextCloses.length; i++) {
        sum += nextCloses[i];
    }
    const smaValue = sum / period;
    if (!Number.isFinite(smaValue)) {
        return {
            nextState: Object.freeze({
                closeHistory: Object.freeze([]),
                smaHistory: Object.freeze([]),
                unbrokenRun: 0
            }),
            smaValue: 0,
            isValid: false
        };
    }

    const nextSmaHistory = Object.freeze([...prevState.smaHistory, smaValue].slice(-11));
    return {
        nextState: Object.freeze({
            closeHistory: nextCloses,
            smaHistory: nextSmaHistory,
            unbrokenRun: nextUnbrokenRun
        }),
        smaValue,
        isValid: true
    };
}

export function calculateSMASlope(
    smaHistory: readonly number[],
    lookback: number,
    atr14: number,
    unbrokenRun: number
): { slope: number; isValid: boolean } {
    if (!Number.isSafeInteger(lookback) || lookback < 1 || lookback > 10) {
        throw new Error(`SMA Slope Error: lookback must be an integer in [1, 10], got ${lookback}.`);
    }
    if (unbrokenRun < lookback + 1 || smaHistory.length < lookback + 1 || atr14 <= 0 || !Number.isFinite(atr14)) {
        return { slope: 0, isValid: false };
    }

    const currentSma = smaHistory[smaHistory.length - 1];
    const pastSma = smaHistory[smaHistory.length - 1 - lookback];
    const slope = (currentSma - pastSma) / (lookback * atr14);
    const isValid = Number.isFinite(slope);

    return { slope: isValid ? slope : 0, isValid };
}
