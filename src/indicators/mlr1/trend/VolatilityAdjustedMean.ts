import type { VAMState } from '../ML1FeatureTypes';
import { calculateTrueRange, updateWilderATR } from '../volatility/ATR';

export interface VAMStepOutput {
    readonly nextState: VAMState;
    readonly centerDistAtr: number;
    readonly isCenterDistValid: boolean;
    readonly slope3Atr: number;
    readonly isSlopeValid: boolean;
    readonly efficiency: number;
    readonly isEfficiencyValid: boolean;
    readonly adx14: number;
    readonly isAdxValid: boolean;
    readonly diSpread14: number;
    readonly isDiSpreadValid: boolean;
    readonly rsi14: number;
    readonly isRsiValid: boolean;
    readonly trend: number;
    readonly isTrendValid: boolean;
    readonly buyStreak: number;
    readonly sellStreak: number;
    readonly signal: 1 | -1 | 0; // +1 = VAM_BUY, -1 = VAM_SELL, 0 = None
}

export function createInitialVAMState(): VAMState {
    return Object.freeze({
        unbrokenRun: 0,
        prevHigh: null,
        prevLow: null,
        prevClose: null,
        hlc3History: Object.freeze([]),
        adaptive: null,
        centerSeedCount: 0,
        centerSeedMean: 0,
        center: null,
        centerHistory: Object.freeze([]),
        atrState: Object.freeze({ count: 0, seedMean: 0, atr: null, isSeeded: false }),
        dmiCount: 0,
        trSeedMean: 0,
        plusDmSeedMean: 0,
        minusDmSeedMean: 0,
        trRma: null,
        plusDmRma: null,
        minusDmRma: null,
        dxHistoryCount: 0,
        dxSeedMean: 0,
        adx: null,
        rsiCount: 0,
        avgGainSeedMean: 0,
        avgLossSeedMean: 0,
        avgGain: null,
        avgLoss: null,
        trend: 0,
        buyStreak: 0,
        sellStreak: 0,
        lastSignalAcceptedIndex: null
    });
}

export function stepVolatilityAdjustedMean(
    high: number,
    low: number,
    close: number,
    prevState: VAMState | undefined,
    isDiscontinuity: boolean
): VAMStepOutput {
    const CENTER_LEN = 18;
    const FAST_LEN = 4;
    const SLOW_LEN = 30;
    const CENTER_SMOOTH = 5;
    const ATR_LEN = 14;
    const ADX_LEN = 14;
    const RSI_LEN = 14;
    const BREAKOUT_ATR = 0.50;
    const SLOPE_BARS = 3;
    const MIN_ADX = 20.0;
    const RSI_BULL = 52.0;
    const RSI_BEAR = 48.0;
    const MIN_SLOPE_ATR = 0.12;
    const CONFIRMATION_BARS = 2;
    const COOLDOWN_BARS = 6;

    const baseState: VAMState =
        isDiscontinuity || !prevState ? createInitialVAMState() : prevState;

    const hlc3 = high / 3 + low / 3 + close / 3;
    if (!Number.isFinite(hlc3) || !Number.isFinite(high) || !Number.isFinite(low) || !Number.isFinite(close)) {
        return {
            nextState: createInitialVAMState(),
            centerDistAtr: 0,
            isCenterDistValid: false,
            slope3Atr: 0,
            isSlopeValid: false,
            efficiency: 0,
            isEfficiencyValid: false,
            adx14: 0,
            isAdxValid: false,
            diSpread14: 0,
            isDiSpreadValid: false,
            rsi14: 0,
            isRsiValid: false,
            trend: 0,
            isTrendValid: false,
            buyStreak: 0,
            sellStreak: 0,
            signal: 0
        };
    }

    const nextRun = baseState.unbrokenRun + 1;
    const nextHlc3History = Object.freeze([...baseState.hlc3History, hlc3].slice(-(CENTER_LEN + 1)));

    // 1. Efficiency Ratio (Pine: 0.0 during warmup bars 0..17, valid from bar 18)
    let efficiency = 0;
    let isEfficiencyValid = false;
    if (nextHlc3History.length === CENTER_LEN + 1) {
        const changeAbs = Math.abs(nextHlc3History[CENTER_LEN] - nextHlc3History[0]);
        let noise = 0;
        for (let k = 1; k <= CENTER_LEN; k++) {
            noise += Math.abs(nextHlc3History[k] - nextHlc3History[k - 1]);
        }
        if (Number.isFinite(changeAbs) && Number.isFinite(noise)) {
            efficiency = noise > 0 ? changeAbs / noise : 0;
            isEfficiencyValid = Number.isFinite(efficiency);
        }
    }

    // 2. Adaptive Center Line + EMA(5) smoothing
    const fastSC = 2.0 / (FAST_LEN + 1.0);
    const slowSC = 2.0 / (SLOW_LEN + 1.0);
    const sc = Math.pow(efficiency * (fastSC - slowSC) + slowSC, 2);
    const nextAdaptive =
        baseState.adaptive === null
            ? hlc3
            : baseState.adaptive + sc * (hlc3 - baseState.adaptive);

    let nextCenterSeedCount = baseState.centerSeedCount;
    let nextCenterSeedMean = baseState.centerSeedMean;
    let nextCenter: number | null = baseState.center;

    if (nextCenter === null) {
        nextCenterSeedCount += 1;
        nextCenterSeedMean += (nextAdaptive - nextCenterSeedMean) / nextCenterSeedCount;
        if (nextCenterSeedCount === CENTER_SMOOTH) {
            nextCenter = nextCenterSeedMean;
        }
    } else {
        const alphaCenter = 2.0 / (CENTER_SMOOTH + 1.0);
        nextCenter = nextCenter * (1 - alphaCenter) + nextAdaptive * alphaCenter;
    }

    const nextCenterHistory =
        nextCenter !== null && Number.isFinite(nextCenter)
            ? Object.freeze([...baseState.centerHistory, nextCenter].slice(-(SLOPE_BARS + 1)))
            : baseState.centerHistory;

    // 3. Wilder ATR(14)
    const atrStep = updateWilderATR(high, low, baseState.prevClose, ATR_LEN, baseState.atrState, isDiscontinuity);
    const isAtrUsable = atrStep.isValid && Number.isFinite(atrStep.atrValue) && atrStep.atrValue > 0;

    // 4. Wilder DMI(14, 14) & ADX(14)
    let nextDmiCount = baseState.dmiCount;
    let nextTrSeedMean = baseState.trSeedMean;
    let nextPlusDmSeedMean = baseState.plusDmSeedMean;
    let nextMinusDmSeedMean = baseState.minusDmSeedMean;
    let nextTrRma = baseState.trRma;
    let nextPlusDmRma = baseState.plusDmRma;
    let nextMinusDmRma = baseState.minusDmRma;
    let nextDxHistoryCount = baseState.dxHistoryCount;
    let nextDxSeedMean = baseState.dxSeedMean;
    let nextAdx = baseState.adx;

    let plusDI = 0;
    let minusDI = 0;
    let isDiValid = false;

    if (baseState.prevHigh !== null && baseState.prevLow !== null && baseState.prevClose !== null) {
        const upMove = high - baseState.prevHigh;
        const downMove = baseState.prevLow - low;
        const plusDM = upMove > downMove && upMove > 0 ? upMove : 0;
        const minusDM = downMove > upMove && downMove > 0 ? downMove : 0;
        const tr = calculateTrueRange(high, low, baseState.prevClose);

        if (Number.isFinite(tr) && Number.isFinite(plusDM) && Number.isFinite(minusDM)) {
            if (nextTrRma === null) {
                nextDmiCount += 1;
                nextTrSeedMean += (tr - nextTrSeedMean) / nextDmiCount;
                nextPlusDmSeedMean += (plusDM - nextPlusDmSeedMean) / nextDmiCount;
                nextMinusDmSeedMean += (minusDM - nextMinusDmSeedMean) / nextDmiCount;
                if (nextDmiCount === ADX_LEN) {
                    nextTrRma = nextTrSeedMean;
                    nextPlusDmRma = nextPlusDmSeedMean;
                    nextMinusDmRma = nextMinusDmSeedMean;
                }
            } else {
                nextDmiCount += 1;
                nextTrRma = nextTrRma + (tr - nextTrRma) / ADX_LEN;
                nextPlusDmRma = nextPlusDmRma! + (plusDM - nextPlusDmRma!) / ADX_LEN;
                nextMinusDmRma = nextMinusDmRma! + (minusDM - nextMinusDmRma!) / ADX_LEN;
            }

            if (nextTrRma !== null && nextPlusDmRma !== null && nextMinusDmRma !== null) {
                plusDI = nextTrRma > 0 ? (100 * nextPlusDmRma) / nextTrRma : 0;
                minusDI = nextTrRma > 0 ? (100 * nextMinusDmRma) / nextTrRma : 0;
                isDiValid = Number.isFinite(plusDI) && Number.isFinite(minusDI);

                const diSum = plusDI + minusDI;
                const dx = diSum > 0 ? (100 * Math.abs(plusDI - minusDI)) / diSum : 0;

                if (nextAdx === null) {
                    nextDxHistoryCount += 1;
                    nextDxSeedMean += (dx - nextDxSeedMean) / nextDxHistoryCount;
                    if (nextDxHistoryCount === ADX_LEN) {
                        nextAdx = nextDxSeedMean;
                    }
                } else {
                    nextDxHistoryCount += 1;
                    nextAdx = nextAdx + (dx - nextAdx) / ADX_LEN;
                }
            }
        }
    }

    const isAdxValid = nextAdx !== null && Number.isFinite(nextAdx);
    const adx14 = isAdxValid ? nextAdx! : 0;
    const diSpread14 = isDiValid ? plusDI - minusDI : 0;

    // 5. Wilder RSI(14)
    let nextRsiCount = baseState.rsiCount;
    let nextAvgGainSeed = baseState.avgGainSeedMean;
    let nextAvgLossSeed = baseState.avgLossSeedMean;
    let nextAvgGain = baseState.avgGain;
    let nextAvgLoss = baseState.avgLoss;
    let rsi14 = 0;
    let isRsiValid = false;

    if (baseState.prevClose !== null) {
        const diff = close - baseState.prevClose;
        const gain = diff > 0 ? diff : 0;
        const loss = diff < 0 ? -diff : 0;

        if (nextAvgGain === null || nextAvgLoss === null) {
            nextRsiCount += 1;
            nextAvgGainSeed += (gain - nextAvgGainSeed) / nextRsiCount;
            nextAvgLossSeed += (loss - nextAvgLossSeed) / nextRsiCount;
            if (nextRsiCount === RSI_LEN) {
                nextAvgGain = nextAvgGainSeed;
                nextAvgLoss = nextAvgLossSeed;
            }
        } else {
            nextRsiCount += 1;
            nextAvgGain = nextAvgGain + (gain - nextAvgGain) / RSI_LEN;
            nextAvgLoss = nextAvgLoss + (loss - nextAvgLoss) / RSI_LEN;
        }

        if (nextAvgGain !== null && nextAvgLoss !== null) {
            if (nextAvgLoss === 0) {
                rsi14 = nextAvgGain === 0 ? 50 : 100;
            } else {
                const rs = nextAvgGain / nextAvgLoss;
                rsi14 = 100 - 100 / (1 + rs);
            }
            isRsiValid = Number.isFinite(rsi14);
        }
    }

    // 6. Normalized Center Distance & Slope
    const isCenterReady = nextCenter !== null && Number.isFinite(nextCenter);
    const isSlopeReady = nextCenterHistory.length === SLOPE_BARS + 1;
    const centerPast = isSlopeReady ? nextCenterHistory[0] : 0;

    const rawCenterDist = isCenterReady && isAtrUsable ? (close - nextCenter!) / atrStep.atrValue : NaN;
    const isCenterDistValid = Number.isFinite(rawCenterDist);
    const centerDistAtr = isCenterDistValid ? rawCenterDist : 0;

    const rawSlopeDiff = isSlopeReady ? nextCenter! - centerPast : NaN;
    const rawSlopeAtr = isSlopeReady && isAtrUsable ? rawSlopeDiff / atrStep.atrValue : NaN;
    const isSlopeValid = Number.isFinite(rawSlopeAtr);
    const slope3Atr = isSlopeValid ? rawSlopeAtr : 0;

    // 7. Exact Pine Trend Initialization, Streaks, Signals & Trend Transitions
    let nextTrend = baseState.trend;
    if (nextTrend === 0 && isSlopeReady && isCenterReady) {
        nextTrend = close >= nextCenter! ? 1 : -1;
    }

    let nextBuyStreak = baseState.buyStreak;
    let nextSellStreak = baseState.sellStreak;
    let nextLastSignalBar = baseState.lastSignalAcceptedIndex;
    let signal: 1 | -1 | 0 = 0;

    const canEvaluateConditions =
        isCenterReady && isSlopeReady && isAtrUsable && isAdxValid && isDiValid && isRsiValid;

    if (canEvaluateConditions) {
        const atrVal = atrStep.atrValue;
        const upwardSlope = nextCenter! > centerPast;
        const downwardSlope = nextCenter! < centerPast;
        const strongSlopeUp = nextCenter! - centerPast >= atrVal * MIN_SLOPE_ATR;
        const strongSlopeDown = centerPast - nextCenter! >= atrVal * MIN_SLOPE_ATR;

        const allowBuy = adx14 >= MIN_ADX && plusDI > minusDI && rsi14 > RSI_BULL && strongSlopeUp;
        const allowSell = adx14 >= MIN_ADX && minusDI > plusDI && rsi14 < RSI_BEAR && strongSlopeDown;

        const qualifiedBuy = close > nextCenter! + atrVal * BREAKOUT_ATR && upwardSlope && allowBuy;
        const qualifiedSell = close < nextCenter! - atrVal * BREAKOUT_ATR && downwardSlope && allowSell;

        nextBuyStreak = qualifiedBuy ? nextBuyStreak + 1 : 0;
        nextSellStreak = qualifiedSell ? nextSellStreak + 1 : 0;

        const currentAcceptedIndex = nextRun - 1;
        const cooldownPassed =
            nextLastSignalBar === null || currentAcceptedIndex - nextLastSignalBar > COOLDOWN_BARS;

        const buySignal = nextTrend === -1 && nextBuyStreak >= CONFIRMATION_BARS && cooldownPassed;
        const sellSignal = nextTrend === 1 && nextSellStreak >= CONFIRMATION_BARS && cooldownPassed;

        if (buySignal) {
            nextTrend = 1;
            nextLastSignalBar = currentAcceptedIndex;
            signal = 1;
        } else if (sellSignal) {
            nextTrend = -1;
            nextLastSignalBar = currentAcceptedIndex;
            signal = -1;
        }
    } else {
        nextBuyStreak = 0;
        nextSellStreak = 0;
    }

    const nextState: VAMState = Object.freeze({
        unbrokenRun: nextRun,
        prevHigh: high,
        prevLow: low,
        prevClose: close,
        hlc3History: nextHlc3History,
        adaptive: nextAdaptive,
        centerSeedCount: nextCenterSeedCount,
        centerSeedMean: nextCenterSeedMean,
        center: nextCenter,
        centerHistory: nextCenterHistory,
        atrState: atrStep.nextState,
        dmiCount: nextDmiCount,
        trSeedMean: nextTrSeedMean,
        plusDmSeedMean: nextPlusDmSeedMean,
        minusDmSeedMean: nextMinusDmSeedMean,
        trRma: nextTrRma,
        plusDmRma: nextPlusDmRma,
        minusDmRma: nextMinusDmRma,
        dxHistoryCount: nextDxHistoryCount,
        dxSeedMean: nextDxSeedMean,
        adx: nextAdx,
        rsiCount: nextRsiCount,
        avgGainSeedMean: nextAvgGainSeed,
        avgLossSeedMean: nextAvgLossSeed,
        avgGain: nextAvgGain,
        avgLoss: nextAvgLoss,
        trend: nextTrend,
        buyStreak: nextBuyStreak,
        sellStreak: nextSellStreak,
        lastSignalAcceptedIndex: nextLastSignalBar
    });

    return {
        nextState,
        centerDistAtr,
        isCenterDistValid,
        slope3Atr,
        isSlopeValid,
        efficiency,
        isEfficiencyValid,
        adx14,
        isAdxValid,
        diSpread14,
        isDiSpreadValid: isDiValid && Number.isFinite(diSpread14),
        rsi14,
        isRsiValid,
        trend: nextTrend,
        isTrendValid: nextTrend !== 0,
        buyStreak: nextBuyStreak,
        sellStreak: nextSellStreak,
        signal
    };
}
