import type { RollingRangePeriodState } from '../ML1FeatureTypes';

export function updateRollingRange(
    high: number,
    low: number,
    close: number,
    period: number,
    prevState: RollingRangePeriodState | undefined,
    isDiscontinuity: boolean
): {
    nextState: RollingRangePeriodState;
    highestHigh: number;
    lowestLow: number;
    rangeWidth: number;
    closePosition: number;
    isValid: boolean;
} {
    if (!Number.isSafeInteger(period) || period <= 0) {
        throw new Error(`Rolling Range Error: Period must be a positive integer, got ${period}.`);
    }

    if (!Number.isFinite(high) || !Number.isFinite(low) || !Number.isFinite(close)) {
        return {
            nextState: prevState || Object.freeze({ highs: Object.freeze([]), lows: Object.freeze([]) }),
            highestHigh: 0,
            lowestLow: 0,
            rangeWidth: 0,
            closePosition: 0,
            isValid: false
        };
    }

    if (isDiscontinuity || !prevState) {
        const nextState: RollingRangePeriodState = Object.freeze({
            highs: Object.freeze([high]),
            lows: Object.freeze([low])
        });
        const isValid = period === 1;
        const width = high - low;
        const isWidthFinite = Number.isFinite(width) && width >= 0;
        return {
            nextState,
            highestHigh: high,
            lowestLow: low,
            rangeWidth: isWidthFinite ? width : 0,
            closePosition: isWidthFinite && width > 0 ? (close - low) / width : 0.5,
            isValid: isValid && isWidthFinite
        };
    }

    const nextHighs = Object.freeze([...prevState.highs, high].slice(-period));
    const nextLows = Object.freeze([...prevState.lows, low].slice(-period));

    const nextState: RollingRangePeriodState = Object.freeze({
        highs: nextHighs,
        lows: nextLows
    });

    const isWarmedUp = nextHighs.length === period;
    if (!isWarmedUp) {
        return {
            nextState,
            highestHigh: 0,
            lowestLow: 0,
            rangeWidth: 0,
            closePosition: 0,
            isValid: false
        };
    }

    let highestHigh = -Infinity;
    let lowestLow = Infinity;
    for (let i = 0; i < period; i++) {
        if (nextHighs[i] > highestHigh) highestHigh = nextHighs[i];
        if (nextLows[i] < lowestLow) lowestLow = nextLows[i];
    }

    const rangeWidth = highestHigh - lowestLow;
    const isExtremesFinite = Number.isFinite(highestHigh) && Number.isFinite(lowestLow);
    const isWidthFinite = isExtremesFinite && Number.isFinite(rangeWidth) && rangeWidth >= 0;
    const closePosition = isWidthFinite && rangeWidth > 0 ? (close - lowestLow) / rangeWidth : 0.5;
    const isPosFinite = Number.isFinite(closePosition);

    const isValid = isWidthFinite && isPosFinite;

    return {
        nextState,
        highestHigh: isValid ? highestHigh : 0,
        lowestLow: isValid ? lowestLow : 0,
        rangeWidth: isValid ? rangeWidth : 0,
        closePosition: isValid ? closePosition : 0,
        isValid
    };
}
