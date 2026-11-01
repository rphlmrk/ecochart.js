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

    const tr = calculateTrueRange(high, low, isDiscontinuity ? null : prevClose);

    // If TR is non-finite (e.g. overflow) or negative, mark invalid and do not pollute state
    if (!Number.isFinite(tr) || tr < 0) {
        return {
            nextState: prevState || Object.freeze({ count: 0, seedSum: 0, atr: null, isSeeded: false }),
            atrValue: 0,
            isValid: false
        };
    }

    // Discontinuity or initial bar reset
    if (isDiscontinuity || !prevState || !Number.isFinite(prevState.count) || prevState.count <= 0) {
        return {
            nextState: Object.freeze({
                count: 1,
                seedSum: tr,
                atr: null,
                isSeeded: false
            }),
            atrValue: 0,
            isValid: false
        };
    }

    // 1. Accumulating SMA seed phase
    if (!prevState.isSeeded) {
        const nextCount = prevState.count + 1;
        const nextSeedSum = prevState.seedSum + tr;

        if (!Number.isFinite(nextSeedSum)) {
            return {
                nextState: prevState,
                atrValue: 0,
                isValid: false
            };
        }

        if (nextCount === period) {
            const initialAtr = nextSeedSum / period;
            const isValidAtr = Number.isFinite(initialAtr) && initialAtr > 0;
            return {
                nextState: Object.freeze({
                    count: nextCount,
                    seedSum: nextSeedSum,
                    atr: isValidAtr ? initialAtr : null,
                    isSeeded: isValidAtr
                }),
                atrValue: isValidAtr ? initialAtr : 0,
                isValid: isValidAtr
            };
        }

        return {
            nextState: Object.freeze({
                count: nextCount,
                seedSum: nextSeedSum,
                atr: null,
                isSeeded: false
            }),
            atrValue: 0,
            isValid: false
        };
    }

    // 2. Wilder's recursive smoothing phase
    const prevAtr = prevState.atr!;
    const nextAtr = (prevAtr * (period - 1) + tr) / period;
    const isValidAtr = Number.isFinite(nextAtr) && nextAtr > 0;

    return {
        nextState: Object.freeze({
            count: prevState.count + 1,
            seedSum: prevState.seedSum,
            atr: isValidAtr ? nextAtr : prevAtr,
            isSeeded: isValidAtr
        }),
        atrValue: isValidAtr ? nextAtr : 0,
        isValid: isValidAtr
    };
}
