import { 
    createInitialML1FeatureState, 
    stepML1Features, 
    validateML1Config 
} from '../indicators/mlr1/ML1FeatureEngine';
import type { ML1FeatureConfig, ML1Candle } from '../indicators/mlr1/ML1FeatureTypes';

function assert(condition: boolean, msg: string): asserts condition {
    if (!condition) throw new Error(`[AssertionFailed] ${msg}`);
}

export function runPhase2ATests(): boolean {
    console.log('🧪 Starting Milestone 2A Acceptance Suite...');
    let passed = 0;
    let failed = 0;

    const rawConfig: ML1FeatureConfig = {
        symbol: 'BTCUSDT', timeframe: '1m', expectedIntervalMs: 60000, gapDiscontinuityThresholdMs: 300000,
        emaPeriods: [9, 20, 50, 100, 200], atrPeriods: [14, 20], rollingRangePeriods: [5, 10, 20, 50], 
        momentumPeriods: [3, 5, 10, 20], volumeSmaPeriods: [10, 20, 50]
    };

    const runTest = (name: string, testFn: () => void) => {
        try {
            testFn();
            passed++;
            console.log(`  ✅ Passed: ${name}`);
        } catch (e: any) {
            failed++;
            console.error(`  ❌ Failed: ${name} - ${e.message}`);
        }
    };

    const validCandle = (t: number): ML1Candle => ({ time: t, open: 100, high: 105, low: 95, close: 102, volume: 1000 });

    // Helper that dynamically adjusts high and low so modifying close never produces an invalid OHLC candle
    const candleWithClose = (t: number, close: number): ML1Candle => ({
        time: t,
        open: 100,
        high: Math.max(105, close, 100),
        low: Math.min(95, close, 100),
        close,
        volume: 1000
    });

    // 1. Configuration Validation & Immutability (Phase 2A Polish)
    runTest('Configuration Validation & Immutability', () => {
        try { validateML1Config({ ...rawConfig, symbol: 123 as any }); assert(false, 'Non-string symbol'); } catch (e: any) { assert(e.message.includes('non-empty string'), e.message); }
        try { validateML1Config(null as any); assert(false, 'Null config'); } catch (e: any) { assert(e.message.includes('valid object'), e.message); }
        
        // Test Empty Array Acceptance (EMA Ablation)
        const emptyEmaConfig = validateML1Config({ ...rawConfig, emaPeriods: [] });
        assert(emptyEmaConfig.emaPeriods.length === 0, 'Did not accept empty EMA array');

        // Test Defensive Copy & Immutability
        const mutableConfig = { ...rawConfig, emaPeriods: [20] };
        const validConfig = validateML1Config(mutableConfig);
        
        mutableConfig.emaPeriods.push(50); // Mutate original
        assert(validConfig.emaPeriods.length === 1, 'Defensive copy failed: original mutation leaked');
        assert(Object.isFrozen(validConfig), 'Validated config object is not frozen');
        assert(Object.isFrozen(validConfig.emaPeriods), 'Validated config period array is not frozen');
    });

    const config = validateML1Config(rawConfig);

    // 2. Initial State & Restored State Consistency (Version 4)
    runTest('State Version & Consistency Enforcement', () => {
        const state = createInitialML1FeatureState();
        assert(state.stateVersion === 4, 'Initial state must be version 4');
        try { stepML1Features(validCandle(1000), 0, { ...state, stateVersion: 3 }, config); assert(false, 'Allowed outdated version 3'); } 
        catch (e: any) { assert(e.message.includes('Incompatible state version'), e.message); }

        // All-or-nothing consistency (has index but no timestamp)
        try { stepML1Features(validCandle(1000), 0, { ...state, lastBarIndex: 100 }, config); assert(false, 'Partial state allowed'); } 
        catch (e: any) { assert(e.message.includes('Partial state detected'), e.message); }
        
        // Corrupted close
        try { stepML1Features(validCandle(1000), 0, { ...state, lastBarIndex: 100, lastTimestamp: 1000, lastClose: NaN }, config); assert(false, 'Corrupted close'); } 
        catch (e: any) { assert(e.message.includes('Corrupted lastClose'), e.message); }
    });

    let state = createInitialML1FeatureState();

    // 3. Invalid First Bar Index
    runTest('Invalid First Bar Index', () => {
        const res = stepML1Features(validCandle(100000), NaN, state, config);
        assert(res.observation.features['IsInvalidIndex'] === 1, 'Did not flag NaN index');
        assert(res.nextState === state, 'State advanced on invalid first index');

        const res2 = stepML1Features(validCandle(100000), -1, state, config);
        assert(res2.observation.features['IsInvalidIndex'] === 1, 'Did not flag negative index');
        assert(res2.nextState === state, 'State advanced on negative first index');
    });

    // 4. First Candle & Unknown Synthetic Metadata
    runTest('First Candle & Unknown Synthetic Metadata', () => {
        const res = stepML1Features(validCandle(100000), 0, state, config);
        assert(res.observation.validity['HasDataGap'] === false, 'Gap validity should be false on first bar');
        assert(res.observation.validity['IsSynthetic'] === false, 'Synthetic validity should be false if undefined');
        state = res.nextState;
    });

    // 5. Explicit Synthetic & Normal Interval
    runTest('Explicit Synthetic False & Normal Interval', () => {
        const res = stepML1Features({ ...validCandle(160000), isSynthetic: false }, 1, state, config);
        assert(res.observation.validity['IsSynthetic'] === true, 'Synthetic validity should be true');
        assert(res.observation.features['IsSynthetic'] === 0, 'Synthetic value should be 0');
        assert(res.observation.features['HasDataGap'] === 0, 'Should not have gap');
        state = res.nextState;
    });

    // 6. Infinite / Invalid OHLCV values
    runTest('Infinite Timestamp and OHLCV', () => {
        const res1 = stepML1Features(validCandle(Infinity), 2, state, config);
        assert(res1.observation.features['IsValidOHLCV'] === 0, 'Did not flag infinite timestamp');
        assert(res1.nextState === state, 'Advanced on infinite timestamp');

        const res2 = stepML1Features({ ...validCandle(220000), high: Infinity }, 2, state, config);
        assert(res2.observation.features['IsValidOHLCV'] === 0, 'Did not flag infinite high');
        assert(res2.nextState === state, 'Advanced on infinite high');
    });

    // 7. Negative Volume
    runTest('Negative Volume', () => {
        const res = stepML1Features({ ...validCandle(220000), volume: -50 }, 2, state, config);
        assert(res.observation.features['IsValidOHLCV'] === 0, 'Did not flag negative volume');
        assert(res.nextState === state, 'Advanced on negative volume');
    });

    // 8. Unexpected Interval Rejection
    runTest('Unexpected Short Interval Rejection', () => {
        const res = stepML1Features(validCandle(190000), 2, state, config); // Only 30s delta
        assert(res.observation.features['IsUnexpectedInterval'] === 1, 'Did not flag unexpected interval');
        assert(res.nextState === state, 'Advanced on unexpected interval');
    });

    // 9. Accepted Ordinary Gaps
    runTest('Accepted Ordinary Gaps', () => {
        const res = stepML1Features(validCandle(280000), 2, state, config); // 120s delta
        assert(res.observation.features['HasDataGap'] === 1, 'Did not flag data gap');
        assert(res.observation.features['IsDiscontinuity'] === 0, 'Flagged as major discontinuity incorrectly');
        assert(res.nextState !== state, 'State did not advance on accepted gap');
        state = res.nextState;
    });

    // 10. Major Discontinuity Acceptance
    runTest('Major Discontinuity Acceptance', () => {
        const res = stepML1Features(validCandle(640000), 3, state, config); // 360s delta > 300s threshold
        assert(res.observation.features['HasDataGap'] === 1, 'Did not flag data gap');
        assert(res.observation.features['IsDiscontinuity'] === 1, 'Did not flag major discontinuity');
        assert(res.nextState !== state, 'State did not advance on major discontinuity');
        state = res.nextState;
    });

    // 11. Duplicate and Out-Of-Order Timestamps
    runTest('Duplicate and Out-Of-Order Timestamp Rejection', () => {
        const resDup = stepML1Features(validCandle(640000), 4, state, config);
        assert(resDup.observation.features['IsDuplicateTimestamp'] === 1, 'Did not flag duplicate');
        assert(resDup.nextState === state, 'State advanced on duplicate timestamp');

        const resOOO = stepML1Features(validCandle(600000), 4, state, config);
        assert(resOOO.observation.features['IsOutOfOrder'] === 1, 'Did not flag out of order');
        assert(resOOO.nextState === state, 'State advanced on out of order timestamp');
    });

    // 12. Decreasing / Repeated Bar Index
    runTest('Repeated and Decreasing Bar Index Rejection', () => {
        const resRep = stepML1Features(validCandle(700000), 3, state, config);
        assert(resRep.observation.features['IsInvalidIndex'] === 1, 'Did not flag repeated index');
        assert(resRep.nextState === state, 'State advanced on repeated index');

        const resDec = stepML1Features(validCandle(700000), 1, state, config);
        assert(resDec.observation.features['IsInvalidIndex'] === 1, 'Did not flag decreasing index');
        assert(resDec.nextState === state, 'State advanced on decreasing index');
    });

    // 13. Previous-State Immutability
    runTest('Previous-State Immutability', () => {
        const frozenState = Object.freeze({ ...state });
        const res = stepML1Features(validCandle(700000), 4, frozenState, config);
        assert(res.nextState !== frozenState, 'Did not create a new state object');
        assert(frozenState.lastTimestamp === 640000, 'Original state was mutated');
        state = res.nextState;
    });

    // 14. Deterministic Replay & State Serialization
    runTest('Deterministic Replay & State Serialization', () => {
        // Re-run the exact same sequence of events from a fresh state
        let replayState = createInitialML1FeatureState();
        replayState = stepML1Features(validCandle(100000), 0, replayState, config).nextState;
        replayState = stepML1Features({ ...validCandle(160000), isSynthetic: false }, 1, replayState, config).nextState;
        replayState = stepML1Features(validCandle(280000), 2, replayState, config).nextState;
        replayState = stepML1Features(validCandle(640000), 3, replayState, config).nextState;
        replayState = stepML1Features(validCandle(700000), 4, replayState, config).nextState;

        // Verify states match exactly
        assert(JSON.stringify(replayState) === JSON.stringify(state), 'Deterministic replay failed. State diverged.');
        
        // Serialization check
        const serialized = JSON.stringify(state);
        const restored = JSON.parse(serialized);
        const resOriginal = stepML1Features(validCandle(760000), 5, state, config);
        const resRestored = stepML1Features(validCandle(760000), 5, restored, config);
        
        assert(JSON.stringify(resOriginal.observation) === JSON.stringify(resRestored.observation), 'State restoration failed to produce identical observation.');
    });

    // 15. Test: State Advancement Logic (Accepted vs Rejected)
    runTest('State Advancement Logic (Accepted vs Rejected)', () => {
        const initState = createInitialML1FeatureState();
        const validCandleObj = validCandle(100000);
        
        // Accepted
        const acceptedRes = stepML1Features(validCandleObj, 0, initState, config);
        assert(acceptedRes.nextState !== initState, 'State did not advance (should be new object)');
        assert(acceptedRes.nextState.lastTimestamp === 100000, 'Timestamp not updated on accepted state');
        
        // Rejected (Duplicate)
        const rejectedRes = stepML1Features(validCandleObj, 0, acceptedRes.nextState, config);
        assert(rejectedRes.nextState === acceptedRes.nextState, 'State advanced on rejected observation (duplicate)');
        assert(rejectedRes.observation.features['IsDuplicateTimestamp'] === 1, 'Did not flag as duplicate');
    });

    console.log(`\n=======================================`);
    console.log(`📊 ML-R1 PHASE 2A FINAL AUDIT:`);
    console.log(`   ↳ Tests Executed:  ${passed + failed}`);
    console.log(`   ↳ Tests Passed:    ${passed}`);
    console.log(`   ↳ Tests Failed:    ${failed}`);
    console.log(`=======================================\n`);

    if (failed === 0) {
        console.log('✅ ALL PHASE 2A CONTRACT TESTS PASSED. The transition engine is secure and immutable.\n🔒 Phase 2A FROZEN.');
    } else {
        console.error('❌ PHASE 2A TESTS FAILED. DO NOT FREEZE.');
        return false;
    }

    // ====================================================================
    // Phase 2B: Candle Anatomy Tests
    // ====================================================================
    console.log('\n🧪 Starting Phase 2B Acceptance Tests...');
    let passed2B = 0;
    let failed2B = 0;

    const run2BTest = (name: string, testFn: () => void) => {
        try {
            testFn();
            passed2B++;
            console.log(`  ✅ Passed: ${name}`);
        } catch (e: any) {
            failed2B++;
            console.error(`  ❌ Failed: ${name} - ${e.message}`);
        }
    };

    const freshState = createInitialML1FeatureState();

    run2BTest('Bullish, Bearish, and Doji Detection', () => {
        // Bullish
        const bull = stepML1Features({ time: 1000, open: 100, high: 110, low: 90, close: 105, volume: 10 }, 0, freshState, config);
        assert(bull.observation.features['CandleDirection'] === 1, 'Bullish direction failed');
        assert(bull.observation.features['CandleRange'] === 20, 'Bullish range failed');
        assert(bull.observation.features['BodySize'] === 5, 'Bullish body size failed');
        
        // Bearish
        const bear = stepML1Features({ time: 1000, open: 105, high: 110, low: 90, close: 100, volume: 10 }, 0, freshState, config);
        assert(bear.observation.features['CandleDirection'] === -1, 'Bearish direction failed');
        
        // Doji
        const doji = stepML1Features({ time: 1000, open: 100, high: 110, low: 90, close: 100, volume: 10 }, 0, freshState, config);
        assert(doji.observation.features['CandleDirection'] === 0, 'Doji direction failed');
        assert(doji.observation.validity['CloseLocation'] === true, 'Doji CloseLocation should be valid (range > 0)');
    });

    run2BTest('Wicks and Anatomy Ratios', () => {
        const res = stepML1Features({ time: 1000, open: 10, high: 20, low: 0, close: 15, volume: 10 }, 0, freshState, config);
        // Range = 20, Body = 5. UpperWick = 20 - 15 = 5. LowerWick = 10 - 0 = 10.
        assert(res.observation.features['UpperWick'] === 5, 'UpperWick failed');
        assert(res.observation.features['LowerWick'] === 10, 'LowerWick failed');
        assert(res.observation.features['CloseLocation'] === 0.75, 'CloseLocation failed (15-0)/20');
        assert(res.observation.features['BodyToRange'] === 0.25, 'BodyToRange failed (5/20)');
        assert(res.observation.features['UpperWickRatio'] === 0.25, 'UpperWickRatio failed (5/20)');
        assert(res.observation.features['LowerWickRatio'] === 0.50, 'LowerWickRatio failed (10/20)');
    });

    run2BTest('Flat Candle Zero-Division Protection', () => {
        const flat = stepML1Features({ time: 1000, open: 100, high: 100, low: 100, close: 100, volume: 10 }, 0, freshState, config);
        assert(flat.observation.features['CandleRange'] === 0, 'Flat range failed');
        assert(flat.observation.features['CloseLocation'] === 0, 'Flat CloseLocation must safely return 0');
        assert(flat.observation.validity['CloseLocation'] === false, 'Flat CloseLocation MUST be marked invalid');
    });

    run2BTest('Extreme Finite Value Safeguard', () => {
        // Produces Infinity on subtraction: MAX_VALUE - (-MAX_VALUE)
        const extreme = stepML1Features({ 
            time: 1000, 
            open: -Number.MAX_VALUE, 
            high: Number.MAX_VALUE, 
            low: -Number.MAX_VALUE, 
            close: Number.MAX_VALUE, 
            volume: 10 
        }, 0, freshState, config);
        
        assert(extreme.observation.features['CandleRange'] === 0, 'Infinite range must fallback to 0');
        assert(extreme.observation.validity['CandleRange'] === false, 'Infinite range MUST be invalid');
        assert(extreme.observation.features['CloseLocation'] === 0, 'Derived ratio from Infinity must fallback to 0');
    });

    run2BTest('Duplicate Timestamp Anatomy Decoupling', () => {
        // First accepted candle
        const state1 = stepML1Features(validCandle(100000), 0, freshState, config).nextState;
        
        // Duplicate timestamp candle, but with different valid OHLC
        const dupCandle = { time: 100000, open: 200, high: 220, low: 180, close: 210, volume: 50 };
        const dupRes = stepML1Features(dupCandle, 0, state1, config);
        
        // Assert state was rejected (did not advance)
        assert(dupRes.nextState === state1, 'Duplicate timestamp advanced state incorrectly');
        // Assert anatomy was STILL calculated successfully
        assert(dupRes.observation.features['CandleRange'] === 40, 'Anatomy not calculated for duplicate candle');
        assert(dupRes.observation.validity['CandleRange'] === true, 'Anatomy validity incorrect for duplicate candle');
    });

    console.log(`\n=======================================`);
    console.log(`📊 ML-R1 PHASE 2B FINAL AUDIT:`);
    console.log(`   ↳ Tests Executed:  ${passed2B + failed2B}`);
    console.log(`   ↳ Tests Passed:    ${passed2B}`);
    console.log(`   ↳ Tests Failed:    ${failed2B}`);
    console.log(`=======================================\n`);

    if (failed2B === 0) {
        console.log('✅ ALL PHASE 2B TESTS PASSED. Candle Anatomy is secure and decoupled.\n🔒 Phase 2B FROZEN.');
    } else {
        console.error('❌ PHASE 2B TESTS FAILED. DO NOT PROCEED TO PHASE 2C.');
        return false;
    }

    // ====================================================================
    // Phase 2C: ATR & Rolling Volatility Acceptance Suite
    // ====================================================================
    console.log('\n🧪 Starting Phase 2C Acceptance Tests...');
    let passed2C = 0;
    let failed2C = 0;

    const run2CTest = (name: string, testFn: () => void) => {
        try {
            testFn();
            passed2C++;
            console.log(`  ✅ Passed: ${name}`);
        } catch (e: any) {
            failed2C++;
            console.error(`  ❌ Failed: ${name} - ${e.message}`);
        }
    };

    // 1. ATR14 Warmup & Incremental Mean SMA Seed
    run2CTest('ATR14 Warmup Boundary and Incremental Mean Seed', () => {
        let testState = createInitialML1FeatureState();
        for (let i = 0; i < 13; i++) {
            const res = stepML1Features(validCandle(100000 + i * 60000), i, testState, config);
            assert(res.observation.validity['ATR_14'] === false, `Bar ${i} should be invalid`);
            testState = res.nextState;
        }
        const res14 = stepML1Features(validCandle(100000 + 13 * 60000), 13, testState, config);
        assert(res14.observation.validity['ATR_14'] === true, 'Bar 13 must be seeded ATR');
        assert(res14.observation.features['ATR_14'] === 10, 'TR 10 SMA seed must be 10');
    });

    // 2. ATR20 Warmup & Seed
    run2CTest('ATR20 Warmup Boundary and Seed', () => {
        let testState = createInitialML1FeatureState();
        for (let i = 0; i < 19; i++) {
            const res = stepML1Features(validCandle(100000 + i * 60000), i, testState, config);
            assert(res.observation.validity['ATR_20'] === false, `Bar ${i} should be invalid for ATR20`);
            testState = res.nextState;
        }
        const res20 = stepML1Features(validCandle(100000 + 19 * 60000), 19, testState, config);
        assert(res20.observation.validity['ATR_20'] === true, 'Bar 19 must be seeded ATR20');
        assert(res20.observation.features['ATR_20'] === 10, 'TR 10 SMA seed must be 10');
    });

    // 3. Zero ATR Mathematical Legitimacy & Gated Normalization
    run2CTest('Zero ATR Handling and Gated Normalization', () => {
        let testState = createInitialML1FeatureState();
        // 14 perfectly flat candles with zero range and zero change
        for (let i = 0; i < 14; i++) {
            testState = stepML1Features({ time: 100000 + i * 60000, open: 100, high: 100, low: 100, close: 100, volume: 10 }, i, testState, config).nextState;
        }
        assert(testState.atrState[14].isSeeded === true, 'Zero ATR must be seeded on 14th bar');
        assert(testState.atrState[14].atr === 0, 'Zero ATR value must be exactly 0');
        
        // 15th flat bar
        const res = stepML1Features({ time: 100000 + 14 * 60000, open: 100, high: 100, low: 100, close: 100, volume: 10 }, 14, testState, config);
        assert(res.observation.validity['ATR_14'] === true, 'ATR_14 must be valid with value 0');
        assert(res.observation.features['ATR_14'] === 0, 'ATR_14 must be 0');
        assert(res.observation.validity['ATR_14_Normalized'] === false, 'ATR_14_Normalized must be invalid when ATR is 0');
        assert(res.observation.validity['RangeToATR14'] === false, 'RangeToATR14 must be invalid when ATR is 0');
    });

    // 4. ATR True-Range Normal Gap vs Discontinuity
    run2CTest('ATR True-Range Normal Gap vs Discontinuity', () => {
        let testState = createInitialML1FeatureState();
        for (let i = 0; i < 14; i++) {
            testState = stepML1Features(validCandle(100000 + i * 60000), i, testState, config).nextState;
        }
        const resGap = stepML1Features({ time: 100000 + 13 * 60000 + 120000, open: 115, high: 120, low: 110, close: 115, volume: 100 }, 14, testState, config);
        assert(resGap.observation.features['HasDataGap'] === 1, 'Did not detect gap');
        assert(resGap.observation.features['IsDiscontinuity'] === 0, 'Should not be discontinuity');
        assert(Math.abs(resGap.observation.features['ATR_14'] - (148 / 14)) < 1e-4, 'ATR did not use prevClose across gap');
    });

    // 5. Rolling Range Multi-Periods (5, 10, 20, 50)
    run2CTest('Rolling Range Context for Periods 5, 10, 20, 50', () => {
        let testState = createInitialML1FeatureState();
        for (let i = 0; i < 50; i++) {
            const res = stepML1Features({ time: 100000 + i * 60000, open: 100, high: 100 + i, low: 90, close: 95, volume: 10 }, i, testState, config);
            if (i < 4) assert(res.observation.validity['RollingRangeWidth_5'] === false, 'Period 5 warmup');
            if (i < 9) assert(res.observation.validity['RollingRangeWidth_10'] === false, 'Period 10 warmup');
            if (i < 19) assert(res.observation.validity['RollingRangeWidth_20'] === false, 'Period 20 warmup');
            if (i < 49) assert(res.observation.validity['RollingRangeWidth_50'] === false, 'Period 50 warmup');
            testState = res.nextState;
        }
        const res50 = stepML1Features({ time: 100000 + 50 * 60000, open: 100, high: 160, low: 80, close: 100, volume: 10 }, 50, testState, config);
        assert(res50.observation.validity['RollingRangeWidth_50'] === true, 'Period 50 must be valid');
        assert(res50.observation.features['RollingHighestHigh_50'] === 160, 'HH50 must be 160');
        assert(res50.observation.features['RollingLowestLow_50'] === 80, 'LL50 must be 80');
        assert(res50.observation.features['RollingRangeWidth_50'] === 80, 'Range width 50 must be 80');
        assert(res50.observation.validity['RollingHighDistance_50'] === true, 'RollingHighDistance_50 must be valid');
        assert(res50.observation.features['RollingHighDistance_50'] === 60, 'HH 160 - Close 100 must be 60');
    });

    // 6. ATR-Normalized Candle Anatomy Gating & Finite Check
    run2CTest('ATR-Normalized Anatomy Gating & Finite Ratios', () => {
        let testState = createInitialML1FeatureState();
        for (let i = 0; i < 14; i++) {
            testState = stepML1Features(validCandle(100000 + i * 60000), i, testState, config).nextState;
        }
        const resMature = stepML1Features(validCandle(100000 + 14 * 60000), 14, testState, config);
        assert(resMature.observation.validity['RangeToATR14'] === true, 'RangeToATR14 must be valid');
        assert(resMature.observation.features['RangeToATR14'] === 1.0, 'RangeToATR14 must be 1.0');
        assert(resMature.observation.validity['BodyToATR14'] === true, 'BodyToATR14 must be valid');
        assert(resMature.observation.features['BodyToATR14'] === 0.2, 'BodyToATR14 must be 0.2');
        assert(Number.isFinite(resMature.observation.features['RangeToATR14']), 'RangeToATR14 must be finite');
    });

    // 7. Recursive ATR Overflow Resistance & State Reset
    run2CTest('Recursive ATR Overflow Resistance & State Reset', () => {
        let testState = createInitialML1FeatureState();
        for (let i = 0; i < 14; i++) {
            testState = stepML1Features(validCandle(100000 + i * 60000), i, testState, config).nextState;
        }

        // Test numerically stable recurrence with large finite numbers near 1e308 (breaks naive multiplication: 1e308 * 13 overflows IEEE-754)
        const largeAtrState = {
            ...testState,
            atrState: {
                ...testState.atrState,
                14: { count: 14, seedMean: 1e308, atr: 1e308, isSeeded: true }
            }
        };
        const largeCandle: ML1Candle = { time: 100000 + 14 * 60000, open: 1e308, high: 1.05e308, low: 0.95e308, close: 1.02e308, volume: 100 };
        const resLarge = stepML1Features(largeCandle, 14, largeAtrState, config);
        assert(resLarge.observation.validity['ATR_14'] === true, 'Numerically stable recurrence failed on large numbers');
        assert(Number.isFinite(resLarge.observation.features['ATR_14']), 'Large ATR result must remain finite');

        // Test reset on actual non-finite overflow: MAX_VALUE - (-MAX_VALUE)
        const overflowCandle: ML1Candle = {
            time: 100000 + 15 * 60000,
            open: -Number.MAX_VALUE,
            high: Number.MAX_VALUE,
            low: -Number.MAX_VALUE,
            close: Number.MAX_VALUE,
            volume: 100
        };
        const resOverflow = stepML1Features(overflowCandle, 15, resLarge.nextState, config);
        assert(resOverflow.observation.validity['ATR_14'] === false, 'ATR14 must be marked invalid on overflow');
        assert(resOverflow.nextState.atrState[14].count === 0, 'ATR count must reset to 0 after overflow');
        assert(resOverflow.nextState.atrState[14].isSeeded === false, 'ATR must reset to unseeded after overflow');

        // Test recovery: fresh candles re-seed ATR from scratch
        let recoveryState = resOverflow.nextState;
        for (let k = 0; k < 14; k++) {
            recoveryState = stepML1Features(validCandle(100000 + (16 + k) * 60000), 16 + k, recoveryState, config).nextState;
        }
        assert(recoveryState.atrState[14].isSeeded === true, 'ATR failed to re-seed following an overflow reset');
        assert(recoveryState.atrState[14].atr === 10, 'Re-seeded ATR must equal 10');
    });

    // 8. Non-Finite Rolling Range, Combined Window Overflow & Recovery
    run2CTest('Non-Finite Rolling Range, Combined Window Overflow & Recovery', () => {
        let testState = createInitialML1FeatureState();
        for (let i = 0; i < 4; i++) {
            testState = stepML1Features(validCandle(100000 + i * 60000), i, testState, config).nextState;
        }

        // Test single candle range overflow
        const overflowCandle: ML1Candle = {
            time: 100000 + 4 * 60000,
            open: -Number.MAX_VALUE,
            high: Number.MAX_VALUE,
            low: -Number.MAX_VALUE,
            close: Number.MAX_VALUE,
            volume: 100
        };
        const res = stepML1Features(overflowCandle, 4, testState, config);
        assert(res.observation.validity['RollingRangeWidth_5'] === false, 'Width must be invalid on single-candle overflow');
        assert(res.nextState.rollingRangeState[5].highs.length === 0, 'Buffer must be emptied on overflow');

        // Test combined window overflow: candle A has low=-1e308, candle B has high=1e308 -> subtraction overflows
        let stateCombined = createInitialML1FeatureState();
        stateCombined = stepML1Features({ time: 100000, open: 0, high: 10, low: -1e308, close: 0, volume: 10 }, 0, stateCombined, config).nextState;
        const resCombined = stepML1Features({ time: 160000, open: 0, high: 1e308, low: -10, close: 0, volume: 10 }, 1, stateCombined, config);
        assert(resCombined.nextState.rollingRangeState[5].highs.length === 0, 'Buffer must be cleansed when combined window extremes overflow');

        // Test recovery: rebuilds rolling window from scratch
        let stateRecovery = resCombined.nextState;
        for (let k = 0; k < 5; k++) {
            const r = stepML1Features(validCandle(220000 + k * 60000), 2 + k, stateRecovery, config);
            stateRecovery = r.nextState;
            if (k < 4) assert(r.observation.validity['RollingRangeWidth_5'] === false, 'Buffer must warm up from scratch');
            else assert(r.observation.validity['RollingRangeWidth_5'] === true, 'Buffer must become valid after re-warming up');
        }
    });

    // 9. Restored-State Integrity for Containers & Configured Periods
    run2CTest('Restored-State Integrity for Containers & Configured Periods', () => {
        const baseState = createInitialML1FeatureState();
        // Missing container
        try {
            stepML1Features(validCandle(1000), 0, { ...baseState, atrState: null as any }, config);
            assert(false, 'Allowed null atrState');
        } catch (e: any) { assert(e.message.includes('Missing or malformed atrState'), e.message); }

        // Negative period key
        try {
            stepML1Features(validCandle(1000), 0, {
                ...baseState,
                atrState: { [-14]: { count: 0, seedMean: 0, atr: null, isSeeded: false } }
            }, config);
            assert(false, 'Allowed negative period key');
        } catch (e: any) { assert(e.message.includes('Invalid period key'), e.message); }

        // Unexpected unconfigured period key
        try {
            stepML1Features(validCandle(1000), 0, {
                ...baseState,
                atrState: { 999: { count: 0, seedMean: 0, atr: null, isSeeded: false } }
            }, config);
            assert(false, 'Allowed unexpected unconfigured period key');
        } catch (e: any) { assert(e.message.includes('Unexpected period key'), e.message); }

        // Unseeded state with count >= period
        try {
            stepML1Features(validCandle(1000), 0, {
                ...baseState,
                atrState: { 14: { count: 14, seedMean: 10, atr: null, isSeeded: false } }
            }, config);
            assert(false, 'Allowed unseeded state with count >= period');
        } catch (e: any) { assert(e.message.includes('Unseeded state cannot have completed count'), e.message); }
    });

    // 10. Discontinuity Reset Policy on ATR and Rolling Ranges
    run2CTest('Discontinuity Reset Policy on ATR and Rolling Ranges', () => {
        let testState = createInitialML1FeatureState();
        for (let i = 0; i < 15; i++) {
            testState = stepML1Features(validCandle(100000 + i * 60000), i, testState, config).nextState;
        }
        assert(testState.atrState[14].isSeeded === true, 'ATR must be seeded prior to gap');

        // Inject 10-minute gap (> 300,000ms threshold)
        const resDiscontinuity = stepML1Features(validCandle(100000 + 14 * 60000 + 600000), 15, testState, config);
        assert(resDiscontinuity.observation.features['IsDiscontinuity'] === 1, 'Must flag discontinuity');
        assert(resDiscontinuity.observation.validity['ATR_14'] === false, 'ATR must reset to unseeded on discontinuity');
        assert(resDiscontinuity.observation.validity['RollingRangeWidth_5'] === false, 'Rolling ranges must reset on discontinuity');
        assert(resDiscontinuity.nextState.atrState[14].isSeeded === false, 'State must reset seed flag');
        assert(resDiscontinuity.nextState.rollingRangeState[5].highs.length === 1, 'Rolling buffer must reset to length 1');
    });

    // 11. Deterministic Replay Parity
    run2CTest('Deterministic Replay Parity', () => {
        const streamCandles = [
            validCandle(100000),
            validCandle(160000),
            { time: 220000, open: 102, high: 115, low: 98, close: 112, volume: 500 },
            { time: 280000, open: 112, high: 125, low: 105, close: 120, volume: 600 },
            validCandle(340000)
        ];

        let stateA = createInitialML1FeatureState();
        const obsA: any[] = [];
        for (let i = 0; i < streamCandles.length; i++) {
            const res = stepML1Features(streamCandles[i], i, stateA, config);
            obsA.push(res.observation);
            stateA = res.nextState;
        }

        let stateB = createInitialML1FeatureState();
        const obsB: any[] = [];
        for (let i = 0; i < streamCandles.length; i++) {
            const res = stepML1Features(streamCandles[i], i, stateB, config);
            obsB.push(res.observation);
            stateB = res.nextState;
        }

        assert(JSON.stringify(obsA) === JSON.stringify(obsB), 'Replay output mismatch');
        assert(JSON.stringify(stateA) === JSON.stringify(stateB), 'Replay final state mismatch');
    });

    console.log(`\n=======================================`);
    console.log(`📊 ML-R1 PHASE 2C FINAL AUDIT:`);
    console.log(`   ↳ Tests Executed:  ${passed2C + failed2C}`);
    console.log(`   ↳ Tests Passed:    ${passed2C}`);
    console.log(`   ↳ Tests Failed:    ${failed2C}`);
    console.log(`=======================================\n`);

    if (failed2C === 0) {
        console.log('✅ ALL PHASE 2C TESTS PASSED. Volatility & Rolling Range Engine is verified.\n🔒 Phase 2C FROZEN.');
    } else {
        console.error('❌ PHASE 2C TESTS FAILED. DO NOT PROCEED TO PHASE 2D.');
        return false;
    }

    // ====================================================================
    // Phase 2D: Causal EMA Context Acceptance Suite
    // ====================================================================
    console.log('\n🧪 Starting Phase 2D Acceptance Tests...');
    let passed2D = 0;
    let failed2D = 0;

    const run2DTest = (name: string, testFn: () => void) => {
        try {
            testFn();
            passed2D++;
            console.log(`  ✅ Passed: ${name}`);
        } catch (e: any) {
            failed2D++;
            console.error(`  ❌ Failed: ${name} - ${e.message}`);
        }
    };

    // 1. EMA Warmup Boundaries Across Full Configuration (9, 20, 50, 100, 200)
    run2DTest('EMA Warmup Boundaries (9, 20, 50, 100, 200)', () => {
        let testState = createInitialML1FeatureState();
        for (let i = 0; i < 200; i++) {
            const res = stepML1Features(validCandle(100000 + i * 60000), i, testState, config);
            if (i < 8) assert(res.nextState.emaState[9].isSeeded === false, `EMA 9 unseeded at ${i}`);
            if (i === 8) assert(res.nextState.emaState[9].isSeeded === true, 'EMA 9 seeded on bar 8');
            
            if (i < 19) assert(res.nextState.emaState[20].isSeeded === false, `EMA 20 unseeded at ${i}`);
            if (i === 19) assert(res.nextState.emaState[20].isSeeded === true, 'EMA 20 seeded on bar 19');
            
            if (i < 49) assert(res.nextState.emaState[50].isSeeded === false, `EMA 50 unseeded at ${i}`);
            if (i === 49) assert(res.nextState.emaState[50].isSeeded === true, 'EMA 50 seeded on bar 49');
            
            if (i < 99) assert(res.nextState.emaState[100].isSeeded === false, `EMA 100 unseeded at ${i}`);
            if (i === 99) assert(res.nextState.emaState[100].isSeeded === true, 'EMA 100 seeded on bar 99');
            
            if (i < 199) assert(res.nextState.emaState[200].isSeeded === false, `EMA 200 unseeded at ${i}`);
            if (i === 199) assert(res.nextState.emaState[200].isSeeded === true, 'EMA 200 must be seeded on bar 199');
            
            testState = res.nextState;
        }
    });

    // 2. Numerically Stable Recursive Smoothing Formula Parity
    run2DTest('Recursive EMA Smoothing Calculation Parity', () => {
        let testState = createInitialML1FeatureState();
        for (let i = 0; i < 9; i++) {
            testState = stepML1Features(validCandle(100000 + i * 60000), i, testState, config).nextState;
        }
        // Next bar with close=112: alpha = 2 / 10 = 0.2. Next EMA = 102 * 0.8 + 112 * 0.2 = 81.6 + 22.4 = 104
        const res = stepML1Features(candleWithClose(100000 + 9 * 60000, 112), 9, testState, config);
        assert(Math.abs(res.nextState.emaState[9].ema! - 104) < 1e-6, 'Convex recurrence parity failed');
    });

    // 3. Convex Combination Resilience
    run2DTest('Convex Combination Resilience with Valid Extreme OHLC', () => {
        let testState = createInitialML1FeatureState();
        for (let i = 0; i < 9; i++) {
            testState = stepML1Features(validCandle(100000 + i * 60000), i, testState, config).nextState;
        }

        // Test with large finite opposite sign values (would fail naive subtraction close - prevEma)
        const largeOppositeState = {
            ...testState,
            emaState: {
                ...testState.emaState,
                9: { count: 9, seedMean: 1e308, ema: 1e308, isSeeded: true, history: Object.freeze([1e308]), unbrokenRun: 9 }
            }
        };

        // Construct a valid OHLC candle where high >= max(open, close) and low <= min(open, close)
        const extremeValidCandle: ML1Candle = {
            time: 100000 + 9 * 60000,
            open: 0,
            high: 1e308,
            low: -1e308,
            close: -1e308,
            volume: 100
        };

        // Close = -1e308 -> naive close - prevEma overflows to -Infinity, but convex combination 1e308 * 0.8 + (-1e308) * 0.2 = 0.6e308 is finite!
        const resConvex = stepML1Features(extremeValidCandle, 9, largeOppositeState, config);
        assert(resConvex.observation.features['IsValidOHLCV'] === 1, 'Extreme candle must be recognized as valid OHLCV');
        assert(resConvex.observation.validity['EMA_9_Distance'] === false, 'Normalized distance must be invalid (ATR overflow)');
        assert(resConvex.nextState.emaState[9].isSeeded === true, 'Convex combination must keep representable result seeded');
        assert(Number.isFinite(resConvex.nextState.emaState[9].ema!), 'EMA must remain finite');
    });

    // 4. Price-to-EMA Distance & ATR14 Gating
    run2DTest('Price-to-EMA Distance & ATR14 Gating', () => {
        let testState = createInitialML1FeatureState();
        for (let i = 0; i < 10; i++) {
            const res = stepML1Features(validCandle(100000 + i * 60000), i, testState, config);
            assert(res.observation.validity['EMA_9_Distance'] === false, 'EMA_9_Distance must be invalid before ATR14 seeds');
            testState = res.nextState;
        }
        for (let i = 10; i < 14; i++) {
            testState = stepML1Features(validCandle(100000 + i * 60000), i, testState, config).nextState;
        }
        const resMature = stepML1Features(candleWithClose(100000 + 14 * 60000, 122), 14, testState, config);
        assert(resMature.observation.validity['EMA_9_Distance'] === true, 'Distance must be valid when both EMA and ATR are ready');
        assert(Number.isFinite(resMature.observation.features['EMA_9_Distance']), 'Distance must be finite');
    });

    // 5. EMA Slopes & Gap Invalidation with Unbroken Recovery
    run2DTest('EMA Slopes & Gap Invalidation with Unbroken Recovery', () => {
        let testState = createInitialML1FeatureState();
        for (let i = 0; i < 25; i++) {
            testState = stepML1Features(validCandle(100000 + i * 60000), i, testState, config).nextState;
        }
        const resSlopes = stepML1Features(validCandle(100000 + 25 * 60000), 25, testState, config);
        assert(resSlopes.observation.validity['EMA_9_Slope_3'] === true, 'Slope 3 must be valid');
        assert(resSlopes.observation.validity['EMA_9_Slope_10'] === true, 'Slope 10 must be valid');

        // Inject 120s data gap: slopes must immediately invalidate
        const resGap = stepML1Features(validCandle(100000 + 25 * 60000 + 120000), 26, resSlopes.nextState, config);
        assert(resGap.observation.features['HasDataGap'] === 1, 'Gap must be detected');
        assert(resGap.observation.validity['EMA_9_Slope_3'] === false, 'Slope 3 must invalidate across gap');
        assert(resGap.observation.validity['EMA_9_Slope_10'] === false, 'Slope 10 must invalidate across gap');

        // Feed uninterrupted candles and verify slope becomes valid again after lookback + 1 bars
        let recoveryState = resGap.nextState;
        for (let k = 1; k <= 3; k++) {
            recoveryState = stepML1Features(validCandle(resGap.observation.timestamp + k * 60000), 26 + k, recoveryState, config).nextState;
        }
        // At 3 uninterrupted bars post-gap, slope 3 recovers!
        const resRecovered = stepML1Features(validCandle(resGap.observation.timestamp + 4 * 60000), 30, recoveryState, config);
        assert(resRecovered.observation.validity['EMA_9_Slope_3'] === true, 'Slope 3 must recover after 4 uninterrupted bars');
        assert(resRecovered.observation.validity['EMA_9_Slope_10'] === false, 'Slope 10 must still be invalid (needs 11 bars)');
    });

    // 6. Pairwise Relationships, Alignment & Spread Change
    run2DTest('Pairwise Relationships, Alignment & Spread Change', () => {
        let testState = createInitialML1FeatureState();
        for (let i = 0; i < 25; i++) {
            testState = stepML1Features(validCandle(100000 + i * 60000), i, testState, config).nextState;
        }
        // Uptrend step: close rises sharply -> EMA9 > EMA20
        const resUp = stepML1Features(candleWithClose(100000 + 25 * 60000, 130), 25, testState, config);
        assert(resUp.observation.validity['EMA_9_Above_EMA_20'] === true, 'Alignment must be valid');
        assert(resUp.observation.features['EMA_9_Above_EMA_20'] === 1, 'EMA9 must be above EMA20');
        assert(resUp.observation.validity['EMA_9_20_Separation'] === true, 'Separation must be valid');
        assert(resUp.observation.features['EMA_9_20_Separation'] > 0, 'Separation must be positive');
        assert(resUp.observation.validity['EMA_SpreadChange_9_20'] === true, 'SpreadChange must be valid');
    });

    // 7. Discontinuity Reset Policy on EMA
    run2DTest('Discontinuity Reset Policy on EMA Context', () => {
        let testState = createInitialML1FeatureState();
        for (let i = 0; i < 25; i++) {
            testState = stepML1Features(validCandle(100000 + i * 60000), i, testState, config).nextState;
        }
        assert(testState.emaState[9].isSeeded === true, 'EMA9 must be seeded');

        const resDisc = stepML1Features(validCandle(100000 + 24 * 60000 + 600000), 25, testState, config);
        assert(resDisc.observation.features['IsDiscontinuity'] === 1, 'Discontinuity must be flagged');
        assert(resDisc.nextState.emaState[9].isSeeded === false, 'EMA must reset to unseeded on discontinuity');
        assert(resDisc.nextState.emaState[9].count === 1, 'EMA count must reset to 1');
    });

    // 8. Empty EMA Period Array (Ablation Configuration A)
    run2DTest('Empty EMA Periods Array Ablation Compatibility', () => {
        const ablationConfig = validateML1Config({ ...rawConfig, emaPeriods: [] });
        const res = stepML1Features(validCandle(100000), 0, createInitialML1FeatureState(), ablationConfig);
        assert(Object.keys(res.nextState.emaState).length === 0, 'No EMA sub-states should exist');
        assert(res.observation.features['EMA_9_Distance'] === undefined, 'EMA features must be completely absent');
    });

    // 9. Restored-State Integrity (History & Invariant Validation)
    run2DTest('Restored-State Integrity for EMA Invariants', () => {
        const baseState = createInitialML1FeatureState();

        // Non-finite value in history
        try {
            stepML1Features(validCandle(1000), 0, {
                ...baseState,
                emaState: { 9: { count: 9, seedMean: 10, ema: 10, isSeeded: true, history: [10, NaN], unbrokenRun: 2 } }
            }, config);
            assert(false, 'Allowed NaN in history');
        } catch (e: any) { assert(e.message.includes('Non-finite value in emaState history'), e.message); }

        // History mismatch with current EMA value
        try {
            stepML1Features(validCandle(1000), 0, {
                ...baseState,
                emaState: { 9: { count: 9, seedMean: 10, ema: 10, isSeeded: true, history: [12], unbrokenRun: 2 } }
            }, config);
            assert(false, 'Allowed mismatched history last value');
        } catch (e: any) { assert(e.message.includes('history does not match current EMA'), e.message); }

        // Unseeded state with non-empty history
        try {
            stepML1Features(validCandle(1000), 0, {
                ...baseState,
                emaState: { 9: { count: 5, seedMean: 10, ema: null, isSeeded: false, history: [10], unbrokenRun: 2 } }
            }, config);
            assert(false, 'Allowed unseeded state with non-empty history');
        } catch (e: any) { assert(e.message.includes('Unseeded EMA must have empty history'), e.message); }
    });

    // 10. Prefix Invariance for EMA Engine
    run2DTest('Prefix Invariance for EMA Feature Engine', () => {
        const candleStream = Array.from({ length: 60 }, (_, i) => validCandle(100000 + i * 60000));
        
        // Full Run (60 bars)
        let fullState = createInitialML1FeatureState();
        const fullObservations: any[] = [];
        for (let i = 0; i < candleStream.length; i++) {
            const res = stepML1Features(candleStream[i], i, fullState, config);
            fullObservations.push(res.observation);
            fullState = res.nextState;
        }

        // Prefix Run (30 bars): Every single observation in the prefix must be bitwise identical to the full run
        let prefixState = createInitialML1FeatureState();
        for (let i = 0; i < 30; i++) {
            const res = stepML1Features(candleStream[i], i, prefixState, config);
            assert(JSON.stringify(res.observation) === JSON.stringify(fullObservations[i]), `Prefix invariance failed at bar ${i}`);
            prefixState = res.nextState;
        }
    });

    console.log(`\n=======================================`);
    console.log(`📊 ML-R1 PHASE 2D FINAL AUDIT:`);
    console.log(`   ↳ Tests Executed:  ${passed2D + failed2D}`);
    console.log(`   ↳ Tests Passed:    ${passed2D}`);
    console.log(`   ↳ Tests Failed:    ${failed2D}`);
    console.log(`=======================================\n`);

    if (failed2D === 0) {
        console.log('✅ ALL PHASE 2D TESTS PASSED. Causal EMA Context Engine is verified.\n🔒 Phase 2D FROZEN.');
    } else {
        console.error('❌ PHASE 2D TESTS FAILED. DO NOT PROCEED TO PHASE 2E.');
        return false;
    }

    // ====================================================================
    // Phase 2E: Momentum & Directional Efficiency Acceptance Suite
    // ====================================================================
    console.log('\n🧪 Starting Phase 2E Acceptance Tests...');
    let passed2E = 0;
    let failed2E = 0;

    const run2ETest = (name: string, testFn: () => void) => {
        try {
            testFn();
            passed2E++;
            console.log(`  ✅ Passed: ${name}`);
        } catch (e: any) {
            failed2E++;
            console.error(`  ❌ Failed: ${name} - ${e.message}`);
        }
    };

    // 1. Normalized Returns Warmup & Exact Fractional Parity (1, 3, 5, 10)
    run2ETest('Returns Warmup & Exact Fractional Parity', () => {
        let testState = createInitialML1FeatureState();

        for (let i = 0; i < 11; i++) {
            const close = 100 + i;
            const res = stepML1Features(candleWithClose(100000 + i * 60000, close), i, testState, config);

            if (i < 1) assert(!res.observation.validity['Return_1'], 'Return_1 warmup');
            if (i === 1) assert(res.observation.validity['Return_1'], 'Return_1 seeded');

            if (i < 3) assert(!res.observation.validity['Return_3'], 'Return_3 warmup');
            if (i === 3) assert(res.observation.validity['Return_3'], 'Return_3 seeded');

            if (i < 5) assert(!res.observation.validity['Return_5'], 'Return_5 warmup');
            if (i === 5) assert(res.observation.validity['Return_5'], 'Return_5 seeded');

            if (i < 10) assert(!res.observation.validity['Return_10'], 'Return_10 warmup');
            if (i === 10) {
                assert(res.observation.validity['Return_10'], 'Return_10 seeded');
                assert(Math.abs(res.observation.features['Return_10'] - (10 / 100)) < 1e-6, 'Return_10 parity failed');
            }

            if (i === 9) {
                assert(Math.abs(res.observation.features['Return_3'] - (3 / 106)) < 1e-6, 'Return_3 parity failed');
            }

            testState = res.nextState;
        }
    });

    // 2. Returns and Momentum Formula Parity
    run2ETest('Returns and Momentum Numerical Parity', () => {
        let testState = createInitialML1FeatureState();
        for (let i = 0; i < 11; i++) {
            const closeVal = 100 + i * 2; // 100, 102, 104, ..., 120
            testState = stepML1Features(candleWithClose(100000 + i * 60000, closeVal), i, testState, config).nextState;
        }
        const res = stepML1Features(candleWithClose(100000 + 11 * 60000, 122), 11, testState, config);
        // t=11 (close 122), t-1=10 (close 120) -> Return_1 = (122 - 120) / 120
        assert(Math.abs(res.observation.features['Return_1'] - (2 / 120)) < 1e-6, 'Return_1 parity failed');
        // Momentum_3 = close_11 - close_8 = 122 - 116 = 6
        assert(res.observation.features['Momentum_3'] === 6, 'Momentum_3 parity failed');
        assert(res.observation.validity['Momentum_3'] === true, 'Momentum_3 must be valid');
    });

    // 3. Directional Efficiency on Monotonic Trend (DE = 1.0)
    run2ETest('Directional Efficiency on Monotonic Trend (DE = 1.0)', () => {
        let testState = createInitialML1FeatureState();
        for (let i = 0; i < 5; i++) {
            testState = stepML1Features(candleWithClose(100000 + i * 60000, 100 + i * 5), i, testState, config).nextState;
        }
        // Closes: 100, 105, 110, 115, 120, 125. Net displacement: 25. Total path: 25. DE_5 = 1.0
        const resNext = stepML1Features(candleWithClose(100000 + 5 * 60000, 125), 5, testState, config);
        assert(resNext.observation.validity['DirectionalEfficiency_5'] === true, 'DE_5 must be valid');
        assert(Math.abs(resNext.observation.features['DirectionalEfficiency_5'] - 1.0) < 1e-6, 'DE_5 on pure trend must be 1.0');
    });

    // 4. Directional Efficiency on Alternating Chop (DE = 1/21)
    run2ETest('Directional Efficiency on Alternating Chop (Low DE)', () => {
        let testState = createInitialML1FeatureState();
        const chopCloses = [100, 105, 100, 105, 100, 101];
        for (let i = 0; i < chopCloses.length - 1; i++) {
            testState = stepML1Features(candleWithClose(100000 + i * 60000, chopCloses[i]), i, testState, config).nextState;
        }
        const res = stepML1Features(candleWithClose(100000 + 5 * 60000, 101), 5, testState, config);
        // Closes: 100, 105, 100, 105, 100, 101. Net: 101 - 100 = 1. Path: 5 + 5 + 5 + 5 + 1 = 21. DE_5 = 1/21 ≈ 0.0476
        assert(res.observation.validity['DirectionalEfficiency_5'] === true, 'DE_5 must be valid');
        assert(Math.abs(res.observation.features['DirectionalEfficiency_5'] - (1 / 21)) < 1e-6, 'DE_5 on chop must equal exactly 1/21');
    });

    // 5. Flat Price Zero-Division Protection (DE = 0, Validity = False)
    run2ETest('Flat Price Zero-Division Protection', () => {
        let testState = createInitialML1FeatureState();
        for (let i = 0; i < 7; i++) {
            testState = stepML1Features(candleWithClose(100000 + i * 60000, 100), i, testState, config).nextState;
        }
        const res = stepML1Features(candleWithClose(100000 + 7 * 60000, 100), 7, testState, config);
        assert(res.observation.features['DirectionalEfficiency_5'] === 0, 'DE_5 on flat price must be 0');
        assert(res.observation.validity['DirectionalEfficiency_5'] === false, 'DE_5 on flat price must be invalid');
        assert(res.observation.validity['ReturnBalance_5'] === false, 'ReturnBalance on flat price must be invalid');
    });

    // 6. Positive Return Fraction & Return Balance Exact Numerical Assertions
    run2ETest('Positive Return Fraction & Return Balance Numerical Parity', () => {
        let testState = createInitialML1FeatureState();
        // Closes: 100, 102 (+2), 101 (-1), 104 (+3), 103 (-1), 106 (+3) -> 3 positive steps, 2 negative steps
        const closes = [100, 102, 101, 104, 103, 106];
        for (let i = 0; i < closes.length - 1; i++) {
            testState = stepML1Features(candleWithClose(100000 + i * 60000, closes[i]), i, testState, config).nextState;
        }
        const res = stepML1Features(candleWithClose(100000 + 5 * 60000, 106), 5, testState, config);
        assert(res.observation.validity['PositiveReturnFraction_5'] === true, 'Positive fraction must be valid');
        assert(Math.abs(res.observation.features['PositiveReturnFraction_5'] - 0.6) < 1e-6, 'Positive fraction must be exactly 3/5 = 0.6');
        assert(res.observation.validity['ReturnBalance_5'] === true, 'Return balance must be valid');
        // Net: 106 - 100 = 6. Path: 2 + 1 + 3 + 1 + 3 = 10. Balance: 6 / 10 = 0.6
        assert(Math.abs(res.observation.features['ReturnBalance_5'] - 0.6) < 1e-6, 'Return balance must be exactly 6/10 = 0.6');
    });

    // 7. Ordinary Gap Tolerance (Returns & Momentum Continue)
    run2ETest('Ordinary Gap Tolerance (Returns & Momentum Continue)', () => {
        let testState = createInitialML1FeatureState();
        for (let i = 0; i < 6; i++) {
            testState = stepML1Features(candleWithClose(100000 + i * 60000, 100 + i), i, testState, config).nextState;
        }
        // Ordinary gap of 120s (does not exceed 300s threshold)
        const resGap = stepML1Features(candleWithClose(100000 + 5 * 60000 + 120000, 110), 6, testState, config);
        assert(resGap.observation.features['HasDataGap'] === 1, 'Data gap must be detected');
        assert(resGap.observation.features['IsDiscontinuity'] === 0, 'Must not be discontinuity');
        assert(resGap.observation.validity['Return_1'] === true, 'Return_1 must remain valid across ordinary gap');
        assert(resGap.observation.validity['Momentum_3'] === true, 'Momentum_3 must remain valid across ordinary gap');
    });

    // 8. Discontinuity Reset Policy on Momentum History
    run2ETest('Discontinuity Reset Policy on Momentum State', () => {
        let testState = createInitialML1FeatureState();
        for (let i = 0; i < 15; i++) {
            testState = stepML1Features(candleWithClose(100000 + i * 60000, 100 + i), i, testState, config).nextState;
        }
        assert(testState.momentumState.unbrokenRun >= 15, 'Run must be at least 15');

        // Discontinuity gap of 10 minutes (> 300s threshold)
        const resDisc = stepML1Features(candleWithClose(100000 + 14 * 60000 + 600000, 120), 15, testState, config);
        assert(resDisc.observation.features['IsDiscontinuity'] === 1, 'Discontinuity must be flagged');
        assert(resDisc.nextState.momentumState.unbrokenRun === 1, 'unbrokenRun must reset to 1 on discontinuity');
        assert(resDisc.nextState.momentumState.closeHistory.length === 1, 'closeHistory must reset to length 1');
        assert(resDisc.observation.validity['Return_3'] === false, 'Return_3 must be invalid immediately after discontinuity');
        assert(resDisc.observation.validity['Momentum_3'] === false, 'Momentum_3 must be invalid immediately after discontinuity');
    });

    // 9. Restored-State Integrity for Momentum Container
    run2ETest('Restored-State Integrity for Momentum State', () => {
        const baseState = createInitialML1FeatureState();
        // Missing container
        try {
            stepML1Features(validCandle(1000), 0, { ...baseState, momentumState: null as any }, config);
            assert(false, 'Allowed null momentumState');
        } catch (e: any) { assert(e.message.includes('Missing or malformed momentumState'), e.message); }

        // Non-finite value in closeHistory
        try {
            stepML1Features(validCandle(1000), 0, {
                ...baseState,
                momentumState: { closeHistory: [100, NaN, 102], unbrokenRun: 3 }
            }, config);
            assert(false, 'Allowed NaN in closeHistory');
        } catch (e: any) { assert(e.message.includes('Non-finite value in momentumState'), e.message); }

        // Inconsistent unbrokenRun before capacity (run 10 != length 2)
        try {
            stepML1Features(validCandle(1000), 0, {
                ...baseState,
                momentumState: { closeHistory: [100, 101], unbrokenRun: 10 }
            }, config);
            assert(false, 'Allowed inconsistent unbrokenRun before capacity');
        } catch (e: any) { assert(e.message.includes('Inconsistent momentumState history and unbrokenRun before capacity'), e.message); }

        // Saturated history with run shorter than history length (run 20 < length 21)
        try {
            stepML1Features(validCandle(1000), 0, {
                ...baseState,
                momentumState: { closeHistory: new Array(21).fill(100), unbrokenRun: 20 }
            }, config);
            assert(false, 'Allowed saturated history with run shorter than history');
        } catch (e: any) { assert(e.message.includes('unbrokenRun cannot be smaller than closeHistory length'), e.message); }

        // Fully saturated history (21 bars) with unbrokenRun > 21 (e.g. 50 bars) MUST BE PERMITTED!
        const saturatedState = {
            ...baseState,
            lastBarIndex: 49,
            lastTimestamp: 100000 + 49 * 60000,
            lastClose: 100,
            momentumState: { closeHistory: new Array(21).fill(100), unbrokenRun: 50 }
        };
        const resSaturated = stepML1Features(validCandle(100000 + 50 * 60000), 50, saturatedState, config);
        assert(resSaturated.nextState.momentumState.unbrokenRun === 51, 'unbrokenRun failed to increment past 21-bar capacity');
    });

    // 10. Prefix Invariance for Momentum Feature Engine
    run2ETest('Prefix Invariance for Momentum Feature Engine', () => {
        const candleStream = Array.from({ length: 60 }, (_, i) => candleWithClose(100000 + i * 60000, 100 + (i % 7) * 2));
        
        // Full Run (60 bars)
        let fullState = createInitialML1FeatureState();
        const fullObservations: any[] = [];
        for (let i = 0; i < candleStream.length; i++) {
            const res = stepML1Features(candleStream[i], i, fullState, config);
            fullObservations.push(res.observation);
            fullState = res.nextState;
        }

        // Prefix Run (30 bars): Every single observation in prefix must match full run bitwise
        let prefixState = createInitialML1FeatureState();
        for (let i = 0; i < 30; i++) {
            const res = stepML1Features(candleStream[i], i, prefixState, config);
            assert(JSON.stringify(res.observation) === JSON.stringify(fullObservations[i]), `Prefix invariance failed at bar ${i}`);
            prefixState = res.nextState;
        }
    });

    console.log(`\n=======================================`);
    console.log(`📊 ML-R1 PHASE 2E FINAL AUDIT:`);
    console.log(`   ↳ Tests Executed:  ${passed2E + failed2E}`);
    console.log(`   ↳ Tests Passed:    ${passed2E}`);
    console.log(`   ↳ Tests Failed:    ${failed2E}`);
    console.log(`=======================================\n`);

    if (failed2E === 0) {
        console.log('✅ ALL PHASE 2E TESTS PASSED. Momentum & Directional Efficiency Engine is verified.\n🔒 Phase 2E FROZEN.');
    } else {
        console.error('❌ PHASE 2E TESTS FAILED. DO NOT PROCEED TO PHASE 2F.');
        return false;
    }

    // ====================================================================
    // Phase 2F: Volume Features Acceptance Suite
    // ====================================================================
    console.log('\n🧪 Starting Phase 2F Acceptance Tests...');
    let passed2F = 0;
    let failed2F = 0;

    const run2FTest = (name: string, testFn: () => void) => {
        try {
            testFn();
            passed2F++;
            console.log(`  ✅ Passed: ${name}`);
        } catch (e: any) {
            failed2F++;
            console.error(`  ❌ Failed: ${name} - ${e.message}`);
        }
    };

    // 1. Base Volume Transformations & Log1p Parity
    run2FTest('Base Volume Metrics & Log1p Parity', () => {
        const state0 = createInitialML1FeatureState();
        // Zero volume candle: log1p(0) = 0, volume changes invalid
        const resZero = stepML1Features({ ...validCandle(100000), volume: 0 }, 0, state0, config);
        assert(resZero.observation.features['Volume'] === 0, 'Volume must be 0');
        assert(resZero.observation.features['LogVolume'] === 0, 'LogVolume for 0 volume must be 0');
        assert(resZero.observation.validity['LogVolume'] === true, 'LogVolume must be valid for 0 volume');
        assert(resZero.observation.validity['VolumeChange_1'] === false, 'VolumeChange_1 must be invalid on bar 0');

        // Non-zero volume
        const resVol = stepML1Features({ ...validCandle(160000), volume: 1000 }, 1, resZero.nextState, config);
        assert(Math.abs(resVol.observation.features['LogVolume'] - Math.log(1001)) < 1e-6, 'LogVolume parity failed');
        assert(resVol.observation.validity['VolumeChange_1'] === true, 'VolumeChange_1 must be valid on bar 1');
        assert(resVol.observation.features['VolumeChange_1'] === 1000, 'VolumeChange_1 must be 1000 (1000 - 0)');
    });

    // 2. Relative Volume Warmup Boundaries (10, 20, 50) and Historical Baseline Parity
    run2FTest('Relative Volume Warmup Boundaries and Mean Parity', () => {
        let testState = createInitialML1FeatureState();
        // Feed 50 completed prior bars with constant volume 100 (bars 0 to 49)
        for (let i = 0; i < 50; i++) {
            const res = stepML1Features({ ...validCandle(100000 + i * 60000), volume: 100 }, i, testState, config);
            if (i < 10) assert(!res.observation.validity['RelativeVolume_10'], `RelVol_10 warmup at ${i}`);
            if (i === 10) assert(res.observation.validity['RelativeVolume_10'], 'RelVol_10 seeded at 10');
            if (i < 20) assert(!res.observation.validity['RelativeVolume_20'], `RelVol_20 warmup at ${i}`);
            if (i === 20) assert(res.observation.validity['RelativeVolume_20'], 'RelVol_20 seeded at 20');
            if (i < 50) assert(!res.observation.validity['RelativeVolume_50'], `RelVol_50 warmup at ${i}`);
            testState = res.nextState;
        }

        // Bar index 50 (51st candle): evaluates against the 50 prior bars of volume 100.
        // Historical Mean = 100. Current volume = 200. RelativeVolume_50 = 200 / 100 = 2.0 exactly!
        const res50 = stepML1Features({ ...validCandle(100000 + 50 * 60000), volume: 200 }, 50, testState, config);
        assert(res50.observation.validity['RelativeVolume_50'] === true, 'RelVol_50 must be valid on bar index 50');
        assert(Math.abs(res50.observation.features['RelativeVolume_50'] - 2.0) < 1e-6, 'RelVol_50 historical parity failed (expected 2.0)');
    });

    // 3. Zero-Volume and Zero-Variance Baseline Protection
    run2FTest('Zero-Volume and Zero-Variance Protection', () => {
        let testState = createInitialML1FeatureState();
        // 20 bars of constant zero volume
        for (let i = 0; i < 20; i++) {
            testState = stepML1Features({ ...validCandle(100000 + i * 60000), volume: 0 }, i, testState, config).nextState;
        }
        const resFlat = stepML1Features({ ...validCandle(100000 + 20 * 60000), volume: 0 }, 20, testState, config);
        // Mean volume is 0 -> RelativeVolume must not divide by 0
        assert(resFlat.observation.features['RelativeVolume_20'] === 0, 'RelVol_20 on zero volume must fallback to 0');
        assert(resFlat.observation.validity['RelativeVolume_20'] === false, 'RelVol_20 on zero baseline must be invalid');
        // Variance is 0 -> ZScore must not divide by 0
        assert(resFlat.observation.features['VolumeZScore_20'] === 0, 'ZScore on zero variance must fallback to 0');
        assert(resFlat.observation.validity['VolumeZScore_20'] === false, 'ZScore on zero variance must be invalid');
    });

    // 4. Volume Z-Score Distribution Numerical Parity (Historical Baseline)
    run2FTest('Volume Z-Score Numerical Parity', () => {
        let testState = createInitialML1FeatureState();
        // Feed 10 bars of volume 100, then 10 bars of volume 200 (20 completed historical bars total)
        for (let i = 0; i < 10; i++) {
            testState = stepML1Features({ ...validCandle(100000 + i * 60000), volume: 100 }, i, testState, config).nextState;
        }
        for (let i = 10; i < 20; i++) {
            testState = stepML1Features({ ...validCandle(100000 + i * 60000), volume: 200 }, i, testState, config).nextState;
        }
        // Historical baseline (20 bars): Mean = (10*100 + 10*200)/20 = 150.
        // Variance = (10*(-50)^2 + 10*(50)^2)/20 = (25000 + 25000)/20 = 2500. Std = sqrt(2500) = 50.
        // Incoming candle on bar index 20 with volume 300: Z = (300 - 150) / 50 = 3.0 exactly!
        const res = stepML1Features({ ...validCandle(100000 + 20 * 60000), volume: 300 }, 20, testState, config);
        assert(res.observation.validity['VolumeZScore_20'] === true, 'VolumeZScore_20 must be valid on bar index 20');
        assert(Math.abs(res.observation.features['VolumeZScore_20'] - 3.0) < 1e-6, 'ZScore parity failed (expected exactly 3.0)');
    });

    // 5. Signed Volume Directional Interaction
    run2FTest('Signed Volume Directional Interaction', () => {
        let testState = createInitialML1FeatureState();
        for (let i = 0; i < 20; i++) {
            testState = stepML1Features({ ...validCandle(100000 + i * 60000), volume: 100 }, i, testState, config).nextState;
        }
        // Bullish candle (close > open -> Direction = 1)
        const resBull = stepML1Features({ ...candleWithClose(100000 + 20 * 60000, 110), volume: 200 }, 20, testState, config);
        assert(resBull.observation.validity['SignedVolume_20'] === true, 'SignedVolume must be valid');
        assert(resBull.observation.features['SignedVolume_20'] > 0, 'SignedVolume for bullish candle must be positive');

        // Bearish candle (close < open -> Direction = -1)
        const resBear = stepML1Features({ ...candleWithClose(100000 + 20 * 60000, 90), volume: 200 }, 20, testState, config);
        assert(resBear.observation.features['SignedVolume_20'] < 0, 'SignedVolume for bearish candle must be negative');
        assert(Math.abs(resBear.observation.features['SignedVolume_20'] + resBull.observation.features['SignedVolume_20']) < 1e-6, 'Magnitudes must match');
    });

    // 6. Discontinuity Reset Policy on Volume History
    run2FTest('Discontinuity Reset Policy on Volume State', () => {
        let testState = createInitialML1FeatureState();
        for (let i = 0; i < 25; i++) {
            testState = stepML1Features(validCandle(100000 + i * 60000), i, testState, config).nextState;
        }
        assert(testState.volumeState.unbrokenRun >= 25, 'Volume run must be >= 25');

        // Inject 10-minute gap (> 300s threshold)
        const resDisc = stepML1Features(validCandle(100000 + 24 * 60000 + 600000), 25, testState, config);
        assert(resDisc.observation.features['IsDiscontinuity'] === 1, 'Must detect discontinuity');

        // Incoming candle itself remains valid for non-relative metrics
        assert(resDisc.observation.validity['Volume'] === true, 'Volume must be valid');
        assert(resDisc.observation.validity['LogVolume'] === true, 'LogVolume must be valid');

        // All history-spanning features must immediately be invalidated
        assert(resDisc.observation.validity['VolumeChange_1'] === false, 'VolumeChange_1 must be invalid after discontinuity');
        assert(resDisc.observation.validity['VolumeChange_3'] === false, 'VolumeChange_3 must be invalid after discontinuity');
        assert(resDisc.observation.validity['RelativeVolume_10'] === false, 'RelVol_10 must be invalid after discontinuity');
        assert(resDisc.observation.validity['RelativeVolume_20'] === false, 'RelVol_20 must be invalid after discontinuity');
        assert(resDisc.observation.validity['VolumeZScore_20'] === false, 'VolumeZScore_20 must be invalid after discontinuity');
        assert(resDisc.observation.validity['SignedVolume_20'] === false, 'SignedVolume_20 must be invalid after discontinuity');

        // Next state resets to 1 observation in the new segment
        assert(resDisc.nextState.volumeState.unbrokenRun === 1, 'Volume run must reset to 1 on discontinuity');
        assert(resDisc.nextState.volumeState.volumeHistory.length === 1, 'Volume history must reset to length 1');
    });

    // 7. Restored-State Integrity for Volume State
    run2FTest('Restored-State Integrity for Volume State', () => {
        const baseState = createInitialML1FeatureState();
        // Missing container
        try {
            stepML1Features(validCandle(1000), 0, { ...baseState, volumeState: null as any }, config);
            assert(false, 'Allowed null volumeState');
        } catch (e: any) { assert(e.message.includes('Missing or malformed volumeState'), e.message); }

        // Negative volume in history
        try {
            stepML1Features(validCandle(1000), 0, {
                ...baseState,
                volumeState: { volumeHistory: [100, -50, 200], unbrokenRun: 3 }
            }, config);
            assert(false, 'Allowed negative volume in history');
        } catch (e: any) { assert(e.message.includes('Non-finite or negative value'), e.message); }

        // Saturated history lower-boundary check
        try {
            stepML1Features(validCandle(1000), 0, {
                ...baseState,
                volumeState: { volumeHistory: new Array(50).fill(100), unbrokenRun: 49 }
            }, config);
            assert(false, 'Allowed unbrokenRun < volumeHistory.length');
        } catch (e: any) { assert(e.message.includes('unbrokenRun cannot be smaller than volumeHistory length'), e.message); }
    });

    // 8. Prefix Invariance for Volume Feature Engine
    run2FTest('Prefix Invariance for Volume Feature Engine', () => {
        const candleStream = Array.from({ length: 60 }, (_, i) => ({
            ...candleWithClose(100000 + i * 60000, 100 + (i % 5)),
            volume: 100 + (i % 10) * 20
        }));

        // Full Run (60 bars)
        let fullState = createInitialML1FeatureState();
        const fullObservations: any[] = [];
        for (let i = 0; i < candleStream.length; i++) {
            const res = stepML1Features(candleStream[i], i, fullState, config);
            fullObservations.push(res.observation);
            fullState = res.nextState;
        }

        // Prefix Run (35 bars)
        let prefixState = createInitialML1FeatureState();
        for (let i = 0; i < 35; i++) {
            const res = stepML1Features(candleStream[i], i, prefixState, config);
            assert(JSON.stringify(res.observation) === JSON.stringify(fullObservations[i]), `Prefix invariance failed at bar ${i}`);
            prefixState = res.nextState;
        }
    });

    console.log(`\n=======================================`);
    console.log(`📊 ML-R1 PHASE 2F FINAL AUDIT:`);
    console.log(`   ↳ Tests Executed:  ${passed2F + failed2F}`);
    console.log(`   ↳ Tests Passed:    ${passed2F}`);
    console.log(`   ↳ Tests Failed:    ${failed2F}`);
    console.log(`=======================================\n`);

    if (failed2F === 0) {
        console.log('✅ ALL PHASE 2F TESTS PASSED. Volume Feature Engine is verified.\n🔒 Phase 2F FROZEN.');
    } else {
        console.error('❌ PHASE 2F TESTS FAILED. DO NOT PROCEED TO PHASE 2G.');
        return false;
    }

    // ====================================================================
    // Phase 2G: Temporal & Data Quality Acceptance Suite
    // ====================================================================
    console.log('\n🧪 Starting Phase 2G Acceptance Tests...');
    let passed2G = 0;
    let failed2G = 0;

    const run2GTest = (name: string, testFn: () => void) => {
        try {
            testFn();
            passed2G++;
            console.log(`  ✅ Passed: ${name}`);
        } catch (e: any) {
            failed2G++;
            console.error(`  ❌ Failed: ${name} - ${e.message}`);
        }
    };

    const state0 = createInitialML1FeatureState();

    // 1. UTC Temporal Extraction Parity (Known Date: 2024-01-15 14:45:00 UTC, Monday)
    run2GTest('UTC Temporal Features Extraction Parity', () => {
        const utcTime = Date.UTC(2024, 0, 15, 14, 45, 0); // Monday: getUTCDay() = 1
        const res = stepML1Features(validCandle(utcTime), 0, state0, config);
        
        assert(res.observation.features['MinuteOfHour'] === 45, 'MinuteOfHour failed');
        assert(res.observation.features['HourOfDay'] === 14, 'HourOfDay failed');
        assert(res.observation.features['DayOfWeek'] === 1, 'DayOfWeek failed');
        assert(res.observation.validity['MinuteOfHour'] === true, 'Minute validity failed');
        assert(res.observation.validity['HourOfDay'] === true, 'Hour validity failed');
        assert(res.observation.validity['DayOfWeek'] === true, 'Day validity failed');
    });

    // 2. Cyclic Trigonometric Periodic Encodings
    run2GTest('Cyclic Sine/Cosine Trigonometric Encodings (sin^2 + cos^2 = 1)', () => {
        const utcTime = Date.UTC(2024, 5, 20, 9, 30, 0);
        const res = stepML1Features(validCandle(utcTime), 0, state0, config);

        const sinMin = res.observation.features['SinMinuteOfHour'];
        const cosMin = res.observation.features['CosMinuteOfHour'];
        assert(Math.abs(sinMin * sinMin + cosMin * cosMin - 1.0) < 1e-6, 'Minute trig identity failed');

        const sinHour = res.observation.features['SinHourOfDay'];
        const cosHour = res.observation.features['CosHourOfDay'];
        assert(Math.abs(sinHour * sinHour + cosHour * cosHour - 1.0) < 1e-6, 'Hour trig identity failed');

        const sinDay = res.observation.features['SinDayOfWeek'];
        const cosDay = res.observation.features['CosDayOfWeek'];
        assert(Math.abs(sinDay * sinDay + cosDay * cosDay - 1.0) < 1e-6, 'Day trig identity failed');
    });

    // 3. Temporal Invalidity Safeguard (Negative, NaN, and Out-of-Range Timestamps)
    run2GTest('Temporal Invalidity Safeguard (Negative, NaN, & Out-of-Range Timestamps)', () => {
        const resNeg = stepML1Features(validCandle(-100), 0, state0, config);
        assert(resNeg.observation.validity['MinuteOfHour'] === false, 'Negative time must be invalid');
        assert(resNeg.observation.features['MinuteOfHour'] === 0, 'Negative time must fallback to 0');

        const resNan = stepML1Features(validCandle(NaN), 0, state0, config);
        assert(resNan.observation.validity['MinuteOfHour'] === false, 'NaN time must be invalid');
        assert(resNan.observation.features['HourOfDay'] === 0, 'NaN time must fallback to 0');

        // Finite timestamp beyond JavaScript Date limit (1e20)
        const resOutOfRange = stepML1Features(validCandle(1e20), 0, state0, config);
        assert(resOutOfRange.observation.validity['MinuteOfHour'] === false, '1e20 time must be invalid');
        assert(resOutOfRange.observation.features['MinuteOfHour'] === 0, '1e20 time must fallback to 0');
    });

    // 4. Data Quality & Continuity Flags
    run2GTest('Data Quality & Continuity Flags', () => {
        // Bar 0: No previous candle
        const res0 = stepML1Features(validCandle(100000), 0, state0, config);
        assert(res0.observation.features['HasPreviousCandle'] === 0, 'Bar 0 should not have previous candle');
        assert(res0.observation.validity['HasExpectedPreviousTimestamp'] === false, 'Expected timestamp validity false on bar 0');
        assert(res0.observation.validity['TimeDeltaSeconds'] === false, 'TimeDelta validity false on bar 0');

        // Bar 1: Normal 60s continuation
        const res1 = stepML1Features(validCandle(160000), 1, res0.nextState, config);
        assert(res1.observation.features['HasPreviousCandle'] === 1, 'Bar 1 must have previous candle');
        assert(res1.observation.features['HasExpectedPreviousTimestamp'] === 1, 'Bar 1 must have expected timestamp');
        assert(res1.observation.features['TimeDeltaSeconds'] === 60, 'TimeDeltaSeconds must be 60');
        assert(res1.observation.validity['TimeDeltaSeconds'] === true, 'TimeDeltaSeconds must be valid');

        // Bar 2: 120s gap -> HasPreviousCandle=1, but HasExpectedPreviousTimestamp=0
        const res2 = stepML1Features(validCandle(280000), 2, res1.nextState, config);
        assert(res2.observation.features['HasPreviousCandle'] === 1, 'Bar 2 has previous candle');
        assert(res2.observation.features['HasExpectedPreviousTimestamp'] === 0, 'Bar 2 should NOT have expected timestamp across gap');
        assert(res2.observation.features['TimeDeltaSeconds'] === 120, 'TimeDeltaSeconds must be 120');
    });

    // 5. Source Validity Flag (IsSourceValid)
    run2GTest('Source Validity Flag (IsSourceValid)', () => {
        const resValid = stepML1Features(validCandle(100000), 0, state0, config);
        assert(resValid.observation.features['IsSourceValid'] === 1, 'Valid candle must have IsSourceValid = 1');

        // Invalid OHLCV
        const resInvalidOhlc = stepML1Features({ ...validCandle(100000), high: 50, low: 200 }, 0, state0, config);
        assert(resInvalidOhlc.observation.features['IsSourceValid'] === 0, 'Invalid OHLC must have IsSourceValid = 0');

        // Duplicate
        const resDup = stepML1Features(validCandle(100000), 0, resValid.nextState, config);
        assert(resDup.observation.features['IsSourceValid'] === 0, 'Duplicate timestamp must have IsSourceValid = 0');

        // NaN Timestamp
        const resNanTime = stepML1Features(validCandle(NaN), 0, state0, config);
        assert(resNanTime.observation.features['IsSourceValid'] === 0, 'NaN time must have IsSourceValid = 0');

        // Negative Timestamp
        const resNegTime = stepML1Features(validCandle(-500), 0, state0, config);
        assert(resNegTime.observation.features['IsSourceValid'] === 0, 'Negative time must have IsSourceValid = 0');

        // Invalid Bar Index
        const resInvalidIdx = stepML1Features(validCandle(100000), -5, state0, config);
        assert(resInvalidIdx.observation.features['IsSourceValid'] === 0, 'Invalid index must have IsSourceValid = 0');
    });

    // 6. Dynamic State-Aware Warmup Completion
    run2GTest('Dynamic State-Aware Warmup Completion', () => {
        // Fresh state with arbitrary high bar index (200): must remain incomplete because sub-states are empty!
        const resArbitrary = stepML1Features(validCandle(100000), 200, state0, config);
        assert(resArbitrary.observation.features['IsWarmupComplete'] === 0, 'Fresh state with high index must NOT be complete');

        // Sequential run: Feed 200 consecutive valid candles
        let testState = createInitialML1FeatureState();
        for (let i = 0; i < 199; i++) {
            const res = stepML1Features(validCandle(100000 + i * 60000), i, testState, config);
            assert(res.observation.features['IsWarmupComplete'] === 0, `Warmup should remain 0 before bar 199 (bar ${i})`);
            testState = res.nextState;
        }

        // 200th candle (index 199): EMA 200 seeds, fulfilling the last requirement
        const resComplete = stepML1Features(validCandle(100000 + 199 * 60000), 199, testState, config);
        assert(resComplete.observation.features['IsWarmupComplete'] === 1, 'Warmup must complete on bar index 199');
        testState = resComplete.nextState;

        // Discontinuity reset: inject 10-minute gap -> sub-states reset, so warmup drops back to 0!
        const resDisc = stepML1Features(validCandle(100000 + 199 * 60000 + 600000), 200, testState, config);
        assert(resDisc.observation.features['IsWarmupComplete'] === 0, 'Warmup must reset to 0 after discontinuity');
    });

    // 7. Deterministic Replay and Prefix Invariance for Phase 2G
    run2GTest('Prefix Invariance for Phase 2G Temporal Engine', () => {
        const stream = Array.from({ length: 40 }, (_, i) => validCandle(1700000000000 + i * 60000));
        
        let fullState = createInitialML1FeatureState();
        const fullObservations: any[] = [];
        for (let i = 0; i < stream.length; i++) {
            const res = stepML1Features(stream[i], i, fullState, config);
            fullObservations.push(res.observation);
            fullState = res.nextState;
        }

        let prefixState = createInitialML1FeatureState();
        for (let i = 0; i < 20; i++) {
            const res = stepML1Features(stream[i], i, prefixState, config);
            assert(res.observation.features['MinuteOfHour'] === fullObservations[i].features['MinuteOfHour'], 'Minute prefix mismatch');
            assert(res.observation.features['TimeDeltaSeconds'] === fullObservations[i].features['TimeDeltaSeconds'], 'Delta prefix mismatch');
            assert(JSON.stringify(res.observation.validity) === JSON.stringify(fullObservations[i].validity), 'Validity prefix mismatch');
            prefixState = res.nextState;
        }
    });

    console.log(`\n=======================================`);
    console.log(`📊 ML-R1 PHASE 2G FINAL AUDIT:`);
    console.log(`   ↳ Tests Executed:  ${passed2G + failed2G}`);
    console.log(`   ↳ Tests Passed:    ${passed2G}`);
    console.log(`   ↳ Tests Failed:    ${failed2G}`);
    console.log(`=======================================\n`);

    if (failed2G === 0) {
        console.log('✅ ALL PHASE 2G TESTS PASSED. Temporal & Data Quality Engine is verified.\n🔒 Phase 2G FROZEN.');
        return true;
    } else {
        console.error('❌ PHASE 2G TESTS FAILED. DO NOT PROCEED TO PHASE 2H.');
        return false;
    }
}
