import type { ML1Candle, ML1FeatureValues, ML1FeatureValidity } from '../ML1FeatureTypes';

export function calculateCandleAnatomy(candle: ML1Candle): {
    features: ML1FeatureValues;
    validity: ML1FeatureValidity;
} {
    const { open, high, low, close } = candle;

    const range = high - low;
    const bodySize = Math.abs(close - open);
    const upperWick = high - Math.max(open, close);
    const lowerWick = Math.min(open, close) - low;
    const direction = close > open ? 1 : (close < open ? -1 : 0);

    // Safeguard: Ensure derived metrics are finite (protects against Infinity calculations)
    const isFiniteMath = Number.isFinite(range) && Number.isFinite(bodySize);
    
    // Flat-candle semantic: mathematically undefined ratios safely return 0 but flag as invalid.
    const hasRange = isFiniteMath && range > 0;

    return {
        features: {
            CandleRange: isFiniteMath ? range : 0,
            BodySize: isFiniteMath ? bodySize : 0,
            UpperWick: isFiniteMath ? upperWick : 0,
            LowerWick: isFiniteMath ? lowerWick : 0,
            CandleDirection: isFiniteMath ? direction : 0,
            
            CloseLocation: hasRange ? (close - low) / range : 0,
            BodyToRange: hasRange ? bodySize / range : 0,
            UpperWickRatio: hasRange ? upperWick / range : 0,
            LowerWickRatio: hasRange ? lowerWick / range : 0
        },
        validity: {
            CandleRange: isFiniteMath,
            BodySize: isFiniteMath,
            UpperWick: isFiniteMath,
            LowerWick: isFiniteMath,
            CandleDirection: isFiniteMath,
            
            CloseLocation: hasRange,
            BodyToRange: hasRange,
            UpperWickRatio: hasRange,
            LowerWickRatio: hasRange
        }
    };
}
