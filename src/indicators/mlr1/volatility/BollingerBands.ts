import type { BollingerBandState } from '../ML1FeatureTypes';

export function createInitialBollingerBandState(): BollingerBandState {
    return Object.freeze({
        closeHistory: Object.freeze([]),
        unbrokenRun: 0
    });
}

export function updateBollingerBands(
    close: number,
    period: number,
    stdMult: number,
    prevState: BollingerBandState | undefined,
    isDiscontinuity: boolean,
    hasDataGap: boolean
): {
    nextState: BollingerBandState;
    bbWidth: number;
    bbPctB: number;
    isWidthValid: boolean;
    isPctBValid: boolean;
} {
    if (!Number.isSafeInteger(period) || period < 2) {
        throw new Error(`BollingerBands Error: Period must be an integer >= 2, got ${period}.`);
    }
    if (!Number.isFinite(stdMult) || stdMult <= 0) {
        throw new Error(`BollingerBands Error: stdMult must be finite > 0, got ${stdMult}.`);
    }

    if (!Number.isFinite(close)) {
        return {
            nextState: prevState || createInitialBollingerBandState(),
            bbWidth: 0,
            bbPctB: 0,
            isWidthValid: false,
            isPctBValid: false
        };
    }

    // Both major discontinuities and ordinary data gaps clear unweighted rolling history
    const shouldReset = isDiscontinuity || hasDataGap || !prevState || prevState.closeHistory.length === 0;
    const baseState = shouldReset ? createInitialBollingerBandState() : prevState;
    const nextCloses = Object.freeze([...baseState.closeHistory, close].slice(-period));
    const nextState: BollingerBandState = Object.freeze({
        closeHistory: nextCloses,
        unbrokenRun: baseState.unbrokenRun + 1
    });

    if (nextCloses.length < period) {
        return {
            nextState,
            bbWidth: 0,
            bbPctB: 0,
            isWidthValid: false,
            isPctBValid: false
        };
    }

    let sum = 0;
    for (let i = 0; i < period; i++) {
        sum += nextCloses[i];
    }
    const mean = sum / period;

    let varSum = 0;
    for (let i = 0; i < period; i++) {
        const diff = nextCloses[i] - mean;
        varSum += diff * diff;
    }
    const std = Math.sqrt(varSum / period);

    if (!Number.isFinite(mean) || !Number.isFinite(std)) {
        return {
            nextState: createInitialBollingerBandState(),
            bbWidth: 0,
            bbPctB: 0,
            isWidthValid: false,
            isPctBValid: false
        };
    }

    const upper = mean + stdMult * std;
    const lower = mean - stdMult * std;
    const bandSpan = upper - lower;

    const rawWidth = mean > 0 ? bandSpan / mean : NaN;
    const isWidthValid = Number.isFinite(rawWidth) && rawWidth >= 0;

    const rawPctB = bandSpan > 0 ? (close - lower) / bandSpan : NaN;
    const isPctBValid = Number.isFinite(rawPctB);

    return {
        nextState,
        bbWidth: isWidthValid ? rawWidth : 0,
        bbPctB: isPctBValid ? rawPctB : 0,
        isWidthValid,
        isPctBValid
    };
}
