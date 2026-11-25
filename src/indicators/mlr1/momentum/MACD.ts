import type { MACDState } from '../ML1FeatureTypes';
import { updateEMA } from '../trend/EMA';

export function createInitialMACDState(): MACDState {
    return Object.freeze({
        fastEma: null,
        slowEma: null,
        signalEma: null
    });
}

export function updateMACD(
    close: number,
    prevState: MACDState | undefined,
    isDiscontinuity: boolean,
    hasDataGap: boolean,
    fastPeriod: number = 12,
    slowPeriod: number = 26,
    signalPeriod: number = 9
): {
    nextState: MACDState;
    macdLine: number;
    signalLine: number;
    histogram: number;
    isMacdValid: boolean;
    isSignalValid: boolean;
} {
    const shouldReset = isDiscontinuity || hasDataGap;
    const baseState = shouldReset || !prevState ? createInitialMACDState() : prevState;

    const fastRes = updateEMA(close, fastPeriod, baseState.fastEma ?? undefined, shouldReset, hasDataGap);
    const slowRes = updateEMA(close, slowPeriod, baseState.slowEma ?? undefined, shouldReset, hasDataGap);

    if (!fastRes.isValid || !slowRes.isValid) {
        return {
            nextState: Object.freeze({
                fastEma: fastRes.nextState,
                slowEma: slowRes.nextState,
                signalEma: null
            }),
            macdLine: 0,
            signalLine: 0,
            histogram: 0,
            isMacdValid: false,
            isSignalValid: false
        };
    }

    const macdLine = fastRes.emaValue - slowRes.emaValue;
    if (!Number.isFinite(macdLine)) {
        return {
            nextState: Object.freeze({
                fastEma: fastRes.nextState,
                slowEma: slowRes.nextState,
                signalEma: null
            }),
            macdLine: 0,
            signalLine: 0,
            histogram: 0,
            isMacdValid: false,
            isSignalValid: false
        };
    }

    const sigRes = updateEMA(macdLine, signalPeriod, baseState.signalEma ?? undefined, shouldReset, hasDataGap);
    const isSignalValid = sigRes.isValid && Number.isFinite(sigRes.emaValue);
    const signalLine = isSignalValid ? sigRes.emaValue : 0;
    const rawHist = isSignalValid ? macdLine - signalLine : 0;
    const histValid = isSignalValid && Number.isFinite(rawHist);

    return {
        nextState: Object.freeze({
            fastEma: fastRes.nextState,
            slowEma: slowRes.nextState,
            signalEma: sigRes.nextState
        }),
        macdLine,
        signalLine: histValid ? signalLine : 0,
        histogram: histValid ? rawHist : 0,
        isMacdValid: true,
        isSignalValid: histValid
    };
}
