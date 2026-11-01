import type { VolumeState } from '../ML1FeatureTypes';

export function updateVolumeState(
    volume: number,
    prevState: VolumeState | undefined,
    isDiscontinuity: boolean,
    maxLookback: number = 50
): VolumeState {
    if (!Number.isFinite(volume) || volume < 0) {
        return prevState || Object.freeze({ volumeHistory: Object.freeze([]), unbrokenRun: 0 });
    }

    if (isDiscontinuity || !prevState || prevState.volumeHistory.length === 0) {
        return Object.freeze({
            volumeHistory: Object.freeze([volume]),
            unbrokenRun: 1
        });
    }

    const nextHistory = Object.freeze([...prevState.volumeHistory, volume].slice(-maxLookback));
    const nextRun = prevState.unbrokenRun + 1;

    return Object.freeze({
        volumeHistory: nextHistory,
        unbrokenRun: nextRun
    });
}

export function calculateBaseVolume(
    volume: number,
    history: readonly number[],
    unbrokenRun: number
): {
    logVolume: number;
    volChange1: number;
    isChange1Valid: boolean;
    volChange3: number;
    isChange3Valid: boolean;
} {
    // Numerically stable log1p: ln(1 + Volume). When Volume = 0, LogVolume = 0.
    const logVolume = Number.isFinite(volume) && volume >= 0 ? Math.log1p(volume) : 0;

    // VolumeChange_1 requires at least 1 completed prior observation (history length >= 1)
    let volChange1 = 0;
    let isChange1Valid = false;
    if (unbrokenRun >= 1 && history.length >= 1) {
        const prevVol = history[history.length - 1];
        const diff1 = volume - prevVol;
        if (Number.isFinite(diff1)) {
            volChange1 = diff1;
            isChange1Valid = true;
        }
    }

    // VolumeChange_3 requires at least 3 completed prior observations (history length >= 3)
    let volChange3 = 0;
    let isChange3Valid = false;
    if (unbrokenRun >= 3 && history.length >= 3) {
        const pastVol = history[history.length - 3];
        const diff3 = volume - pastVol;
        if (Number.isFinite(diff3)) {
            volChange3 = diff3;
            isChange3Valid = true;
        }
    }

    return { logVolume, volChange1, isChange1Valid, volChange3, isChange3Valid };
}

/**
 * Calculates Relative Volume strictly against the preceding N completed candles (excluding current candle).
 */
export function calculateRelativeVolume(
    volume: number,
    history: readonly number[],
    unbrokenRun: number,
    period: number
): { relativeVolume: number; isValid: boolean } {
    if (unbrokenRun < period || history.length < period) {
        return { relativeVolume: 0, isValid: false };
    }

    let sum = 0;
    const startIndex = history.length - period;
    for (let i = startIndex; i < history.length; i++) {
        sum += history[i];
    }

    const mean = sum / period;
    // Zero-division guard: if historical baseline volume is zero, relative volume is undefined
    if (!Number.isFinite(mean) || mean <= 0) {
        return { relativeVolume: 0, isValid: false };
    }

    const relVol = volume / mean;
    const isValid = Number.isFinite(relVol) && relVol >= 0;
    return { relativeVolume: isValid ? relVol : 0, isValid };
}

/**
 * Calculates Volume Z-Score strictly against the preceding N completed candles (excluding current candle).
 */
export function calculateVolumeZScore(
    volume: number,
    history: readonly number[],
    unbrokenRun: number,
    period: number
): { zScore: number; isValid: boolean } {
    if (unbrokenRun < period || history.length < period) {
        return { zScore: 0, isValid: false };
    }

    let sum = 0;
    const startIndex = history.length - period;
    for (let i = startIndex; i < history.length; i++) {
        sum += history[i];
    }
    const mean = sum / period;

    let varSum = 0;
    for (let i = startIndex; i < history.length; i++) {
        const diff = history[i] - mean;
        varSum += diff * diff;
    }
    const std = Math.sqrt(varSum / period);

    // Zero-variance guard: if all historical volumes in the baseline are identical, Z-score is undefined
    if (!Number.isFinite(std) || std <= 0) {
        return { zScore: 0, isValid: false };
    }

    const z = (volume - mean) / std;
    const isValid = Number.isFinite(z);
    return { zScore: isValid ? z : 0, isValid };
}
