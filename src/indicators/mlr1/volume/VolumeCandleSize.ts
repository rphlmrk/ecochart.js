import type { VolumeCandleSizeState } from '../ML1FeatureTypes';

export function computeRawVolumeCandleSize(
    high: number,
    low: number,
    volume: number
): { jam1: number; isValid: boolean } {
    if (!Number.isFinite(high) || !Number.isFinite(low) || !Number.isFinite(volume) || volume < 0) {
        return { jam1: 0, isValid: false };
    }

    const range = high - low;
    const hl2 = low + range * 0.5;
    if (!Number.isFinite(range) || range < 0 || !Number.isFinite(hl2) || hl2 <= 0) {
        return { jam1: 0, isValid: false };
    }

    // Mirrors Pine: yilmaz = high - low + hl2 / 2000; mehrdad = yilmaz / hl2
    const relSpread = range / hl2 + 1 / 2000;
    if (!Number.isFinite(relSpread) || relSpread <= 0) {
        return { jam1: 0, isValid: false };
    }

    const jam1 = (volume * hl2) / (1e7 * relSpread);
    if (!Number.isFinite(jam1) || jam1 < 0) {
        return { jam1: 0, isValid: false };
    }

    return { jam1, isValid: true };
}

export function updateVolumeCandleSize(
    high: number,
    low: number,
    volume: number,
    period: number,
    prevState: VolumeCandleSizeState | undefined,
    isDiscontinuity: boolean
): {
    nextState: VolumeCandleSizeState;
    ratio: number;
    isRatioValid: boolean;
    zScore: number;
    isZScoreValid: boolean;
    regime: number;
    isRegimeValid: boolean;
} {
    if (!Number.isSafeInteger(period) || period < 2) {
        throw new Error(`VolumeCandleSize Error: Period must be an integer >= 2, got ${period}.`);
    }

    const raw = computeRawVolumeCandleSize(high, low, volume);
    if (!raw.isValid) {
        return {
            nextState: Object.freeze({ jamHistory: Object.freeze([]), unbrokenRun: 0 }),
            ratio: 0,
            isRatioValid: false,
            zScore: 0,
            isZScoreValid: false,
            regime: 0,
            isRegimeValid: false
        };
    }

    const baselineState: VolumeCandleSizeState =
        isDiscontinuity || !prevState
            ? Object.freeze({ jamHistory: Object.freeze([]), unbrokenRun: 0 })
            : prevState;

    let ratio = 0;
    let isRatioValid = false;
    let zScore = 0;
    let isZScoreValid = false;
    let regime = 0;
    let isRegimeValid = false;

    // Prior-window baseline: strictly evaluates against preceding N completed bars [t-period .. t-1]
    if (baselineState.unbrokenRun >= period && baselineState.jamHistory.length >= period) {
        const hist = baselineState.jamHistory;
        const startIdx = hist.length - period;

        let sum = 0;
        let allEqual = true;
        const first = hist[startIdx];
        for (let i = startIdx; i < hist.length; i++) {
            const val = hist[i];
            if (val !== first) allEqual = false;
            sum += val;
        }
        const priorMean = allEqual ? first : sum / period;

        if (Number.isFinite(priorMean) && priorMean > 0) {
            const candidateRatio = raw.jam1 / priorMean;
            if (Number.isFinite(candidateRatio) && candidateRatio >= 0) {
                ratio = candidateRatio;
                isRatioValid = true;
                regime = candidateRatio > 2.0 ? 2 : candidateRatio > 1.0 ? 1 : 0;
                isRegimeValid = true;
            }
        }

        let priorStd = 0;
        if (!allEqual) {
            let varSum = 0;
            for (let i = startIdx; i < hist.length; i++) {
                const diff = hist[i] - priorMean;
                varSum += diff * diff;
            }
            priorStd = Math.sqrt(varSum / period);
        }

        if (Number.isFinite(priorStd) && priorStd > 0) {
            const candidateZ = (raw.jam1 - priorMean) / priorStd;
            if (Number.isFinite(candidateZ)) {
                zScore = candidateZ;
                isZScoreValid = true;
            }
        }
    }

    const nextHistory = Object.freeze([...baselineState.jamHistory, raw.jam1].slice(-period));
    const nextState: VolumeCandleSizeState = Object.freeze({
        jamHistory: nextHistory,
        unbrokenRun: baselineState.unbrokenRun + 1
    });

    return {
        nextState,
        ratio,
        isRatioValid,
        zScore,
        isZScoreValid,
        regime,
        isRegimeValid
    };
}
