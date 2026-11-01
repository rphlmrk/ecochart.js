import type { ATRPeriodState } from '../ML1FeatureTypes';

export function calculateTrueRange(high: number, low: number, prevClose: number | null): number {
    if (!Number.isFinite(high) || !Number.isFinite(low)) return NaN;
    if (prevClose === null || !Number.isFinite(prevClose)) {
        const tr = high - low;
        return Number.isFinite(tr) && tr >= 0 ? tr : NaN;
    }
    const tr = Math.max(
        high - low,
        Math.abs(high - prevClose),
        Math.abs(low - prevClose)
    );
    return Number.isFinite(tr) && tr >= 0 ? tr : NaN;
}

export function updateWilderATR(
    high: number,
    low: number,
    prevClose: number | null,
    period: number,
    prevState: ATRPeriodState | undefined,
    isDiscontinuity: boolean
): { nextState: ATRPeriodState; atrValue: number; isValid: boolean } {
    if (!Number.isSafeInteger(period) || period < 2) {
        throw new Error(`ATR Period Error: Period must be an integer >= 2, got ${period}.`);
    }

    const isInitialBar = isDiscontinuity || !prevState || !Number.isFinite(prevState.count) || prevState.count <= 0;
    const tr = calculateTrueRange(high, low, isInitialBar ? null : prevClose);

    // If TR is non-finite or negative, reset to an unseeded initial state so subsequent candles restart fresh
    if (!Number.isFinite(tr) || tr < 0) {
        return {
            nextState: Object.freeze({ count: 0, seedMean: 0, atr: null, isSeeded: false }),
            atrValue: 0,
            isValid: false
        };
    }

    // Discontinuity or initial bar reset
    if (isInitialBar) {
        return {
            nextState: Object.freeze({
                count: 1,
                seedMean: tr,
                atr: null,
                isSeeded: false
            }),
            atrValue: 0,
            isValid: false
        };
    }

    // 1. Accumulating SMA seed phase via numerically stable incremental mean: M_n = M_{n-1} + (TR_n - M_{n-1}) / n
    if (!prevState.isSeeded) {
        const nextCount = prevState.count + 1;
        const nextSeedMean = prevState.seedMean + (tr - prevState.seedMean) / nextCount;

        if (!Number.isFinite(nextSeedMean) || nextSeedMean < 0) {
            return {
                nextState: Object.freeze({ count: 0, seedMean: 0, atr: null, isSeeded: false }),
                atrValue: 0,
                isValid: false
            };
        }

        if (nextCount === period) {
            // Mathematically valid even if initialAtr === 0 (e.g. perfectly flat market)
            const isValidAtr = Number.isFinite(nextSeedMean) && nextSeedMean >= 0;
            return {
                nextState: Object.freeze({
                    count: nextCount,
                    seedMean: nextSeedMean,
                    atr: isValidAtr ? nextSeedMean : null,
                    isSeeded: isValidAtr
                }),
                atrValue: isValidAtr ? nextSeedMean : 0,
                isValid: isValidAtr
            };
        }

        return {
            nextState: Object.freeze({
                count: nextCount,
                seedMean: nextSeedMean,
                atr: null,
                isSeeded: false
            }),
            atrValue: 0,
            isValid: false
        };
    }

    // 2. Wilder's recursive smoothing phase via numerically stable recurrence: ATR_t = ATR_{t-1} + (TR_t - ATR_{t-1}) / period
    const prevAtr = prevState.atr!;
    const nextAtr = prevAtr + (tr - prevAtr) / period;
    const isValidAtr = Number.isFinite(nextAtr) && nextAtr >= 0;

    return {
        nextState: Object.freeze({
            count: prevState.count + 1,
            seedMean: prevState.seedMean,
            atr: isValidAtr ? nextAtr : null,
            isSeeded: isValidAtr
        }),
        atrValue: isValidAtr ? nextAtr : 0,
        isValid: isValidAtr
    };
}
