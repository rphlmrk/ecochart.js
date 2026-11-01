import type { MomentumState } from '../ML1FeatureTypes';

export function updateMomentumState(
    close: number,
    prevState: MomentumState | undefined,
    isDiscontinuity: boolean,
    maxLookback: number = 20
): MomentumState {
    if (!Number.isFinite(close)) {
        return prevState || Object.freeze({ closeHistory: Object.freeze([]), unbrokenRun: 0 });
    }

    if (isDiscontinuity || !prevState || prevState.closeHistory.length === 0) {
        return Object.freeze({
            closeHistory: Object.freeze([close]),
            unbrokenRun: 1
        });
    }

    const nextHistory = Object.freeze([...prevState.closeHistory, close].slice(-(maxLookback + 1)));
    const nextRun = prevState.unbrokenRun + 1;

    return Object.freeze({
        closeHistory: nextHistory,
        unbrokenRun: nextRun
    });
}

export function calculateReturn(
    history: readonly number[],
    unbrokenRun: number,
    lookback: number
): { returnVal: number; isValid: boolean } {
    if (unbrokenRun < lookback + 1 || history.length < lookback + 1) {
        return { returnVal: 0, isValid: false };
    }

    const currentClose = history[history.length - 1];
    const pastClose = history[history.length - 1 - lookback];

    if (!Number.isFinite(currentClose) || !Number.isFinite(pastClose) || pastClose <= 0) {
        return { returnVal: 0, isValid: false };
    }

    const returnVal = (currentClose - pastClose) / pastClose;
    const isValid = Number.isFinite(returnVal);
    return { returnVal: isValid ? returnVal : 0, isValid };
}

export function calculateMomentum(
    history: readonly number[],
    unbrokenRun: number,
    lookback: number
): { momentumVal: number; isValid: boolean } {
    if (unbrokenRun < lookback + 1 || history.length < lookback + 1) {
        return { momentumVal: 0, isValid: false };
    }

    const currentClose = history[history.length - 1];
    const pastClose = history[history.length - 1 - lookback];

    if (!Number.isFinite(currentClose) || !Number.isFinite(pastClose)) {
        return { momentumVal: 0, isValid: false };
    }

    const momentumVal = currentClose - pastClose;
    const isValid = Number.isFinite(momentumVal);
    return { momentumVal: isValid ? momentumVal : 0, isValid };
}

export function calculateDirectionalEfficiency(
    history: readonly number[],
    unbrokenRun: number,
    lookback: number
): { efficiency: number; isValid: boolean } {
    if (unbrokenRun < lookback + 1 || history.length < lookback + 1) {
        return { efficiency: 0, isValid: false };
    }

    const currentClose = history[history.length - 1];
    const pastClose = history[history.length - 1 - lookback];
    const netDisplacement = Math.abs(currentClose - pastClose);

    let pathSum = 0;
    const startIndex = history.length - 1 - lookback;
    for (let i = startIndex; i < history.length - 1; i++) {
        const step = Math.abs(history[i + 1] - history[i]);
        if (!Number.isFinite(step)) return { efficiency: 0, isValid: false };
        pathSum += step;
    }

    // Zero-division / flat price protection: if no travel occurred, efficiency is undefined (validity = false)
    if (!Number.isFinite(pathSum) || pathSum <= 0) {
        return { efficiency: 0, isValid: false };
    }

    const efficiency = netDisplacement / pathSum;
    const isValid = Number.isFinite(efficiency) && efficiency >= 0 && efficiency <= 1.000001;
    return { efficiency: isValid ? Math.min(1.0, efficiency) : 0, isValid };
}

/**
 * Calculates PositiveReturnFraction and ReturnBalance across trailing N bars.
 * Note: Flat 1-bar intervals (Close[i] === Close[i-1]) contribute 0 to the positive count
 * and are treated strictly as neutral (neither positive nor negative).
 */
export function calculateReturnConsistency(
    history: readonly number[],
    unbrokenRun: number,
    lookback: number
): { positiveFraction: number; isFractionValid: boolean; balance: number; isBalanceValid: boolean } {
    if (unbrokenRun < lookback + 1 || history.length < lookback + 1) {
        return { positiveFraction: 0, isFractionValid: false, balance: 0, isBalanceValid: false };
    }

    let positiveCount = 0;
    let netSum = 0;
    let absSum = 0;

    const startIndex = history.length - 1 - lookback;
    for (let i = startIndex; i < history.length - 1; i++) {
        const diff = history[i + 1] - history[i];
        if (!Number.isFinite(diff)) {
            return { positiveFraction: 0, isFractionValid: false, balance: 0, isBalanceValid: false };
        }
        if (diff > 0) positiveCount++;
        netSum += diff;
        absSum += Math.abs(diff);
    }

    const positiveFraction = positiveCount / lookback;
    const isFractionValid = Number.isFinite(positiveFraction);

    const isBalanceValid = Number.isFinite(absSum) && absSum > 0;
    const balance = isBalanceValid ? netSum / absSum : 0;

    return {
        positiveFraction: isFractionValid ? positiveFraction : 0,
        isFractionValid,
        balance: isBalanceValid ? Math.max(-1.0, Math.min(1.0, balance)) : 0,
        isBalanceValid: isBalanceValid && Number.isFinite(balance)
    };
}
