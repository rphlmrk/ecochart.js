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

    // 2. Initial State & Restored State Consistency
    runTest('State Version & Consistency Enforcement', () => {
        const state = createInitialML1FeatureState();
        try { stepML1Features(validCandle(1000), 0, { ...state, stateVersion: 99 }, config); assert(false, 'Incompatible version'); } 
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

    // 1. EMA Warmup Boundary & Incremental Mean Seed
    run2DTest('EMA Warmup Boundary & Incremental Mean Seed (Periods 9 and 20)', () => {
        let testState = createInitialML1FeatureState();

        // Feed 8 bars: EMA 9 must be unseeded
        for (let i = 0; i < 8; i++) {
            const res = stepML1Features(validCandle(100000 + i * 60000), i, testState, config);
            assert(res.nextState.emaState[9].isSeeded === false, `EMA 9 should be unseeded at bar ${i}`);
            testState = res.nextState;
        }

        // 9th bar (index 8): EMA 9 seeds
        const res9 = stepML1Features(validCandle(100000 + 8 * 60000), 8, testState, config);
        assert(res9.nextState.emaState[9].isSeeded === true, 'EMA 9 must be seeded on bar 8');
        assert(res9.nextState.emaState[20].isSeeded === false, 'EMA 20 must remain unseeded on bar 8');
        testState = res9.nextState;

        // Feed until bar index 19: EMA 20 seeds
        for (let i = 9; i < 19; i++) {
            testState = stepML1Features(validCandle(100000 + i * 60000), i, testState, config).nextState;
        }
        const res20 = stepML1Features(validCandle(100000 + 19 * 60000), 19, testState, config);
        assert(res20.nextState.emaState[20].isSeeded === true, 'EMA 20 must be seeded on bar 19');
    });

    // 2. Numerically Stable Recursive Smoothing Formula
    run2DTest('Recursive EMA Smoothing Calculation Parity', () => {
        let testState = createInitialML1FeatureState();
        for (let i = 0; i < 9; i++) {
            testState = stepML1Features(validCandle(100000 + i * 60000), i, testState, config).nextState;
        }
        const initialEma9 = testState.emaState[9].ema!;
        assert(initialEma9 === 102, 'Initial SMA seed for close=102 must be 102');

        // Next bar with close=112: alpha = 2 / (9 + 1) = 0.2
        // Next EMA = 102 + 0.2 * (112 - 102) = 104
        const res = stepML1Features({ ...validCandle(100000 + 9 * 60000), high: 115, close: 112 }, 9, testState, config);
        assert(Math.abs(res.nextState.emaState[9].ema! - 104) < 1e-6, 'EMA recursive update failed parity check');
    });

    // 3. Price-to-EMA Distance & ATR Gating
    run2DTest('Price-to-EMA Distance & ATR14 Gating', () => {
        let testState = createInitialML1FeatureState();

        // Feed 10 bars: EMA 9 is seeded, but ATR 14 is NOT yet seeded
        for (let i = 0; i < 10; i++) {
            const res = stepML1Features(validCandle(100000 + i * 60000), i, testState, config);
            assert(res.observation.validity['EMA_9_Distance'] === false, 'EMA_9_Distance must be invalid before ATR14 seeds');
            assert(res.observation.features['EMA_9_Distance'] === 0, 'Distance must fallback to 0');
            testState = res.nextState;
        }

        // Advance past ATR14 warmup (bar 13)
        for (let i = 10; i < 14; i++) {
            testState = stepML1Features(validCandle(100000 + i * 60000), i, testState, config).nextState;
        }
        const resMature = stepML1Features({ ...validCandle(100000 + 14 * 60000), high: 125, close: 122 }, 14, testState, config);
        // Distance: (122 - EMA9) / ATR14. Must be valid and finite.
        assert(resMature.observation.validity['EMA_9_Distance'] === true, 'Distance must be valid when both EMA and ATR are ready');
        assert(Number.isFinite(resMature.observation.features['EMA_9_Distance']), 'Distance must be finite');
    });

    // 4. EMA Slopes (k=3, k=10) & Gap Invalidation
    run2DTest('EMA Slopes (k=3, k=10) & Gap Invalidation Policy', () => {
        let testState = createInitialML1FeatureState();
        for (let i = 0; i < 25; i++) {
            testState = stepML1Features(validCandle(100000 + i * 60000), i, testState, config).nextState;
        }
        const resSlopes = stepML1Features(validCandle(100000 + 25 * 60000), 25, testState, config);
        assert(resSlopes.observation.validity['EMA_9_Slope_3'] === true, 'Slope 3 must be valid after 25 consecutive bars');
        assert(resSlopes.observation.validity['EMA_9_Slope_10'] === true, 'Slope 10 must be valid after 25 consecutive bars');

        // Inject 120s data gap: EMA levels continue, but slope horizon is broken -> slopes invalid!
        const resGap = stepML1Features(validCandle(100000 + 25 * 60000 + 120000), 26, resSlopes.nextState, config);
        assert(resGap.observation.features['HasDataGap'] === 1, 'Gap must be detected');
        assert(resGap.observation.validity['EMA_9_Slope_3'] === false, 'Slope 3 must be invalid across gap');
        assert(resGap.observation.validity['EMA_9_Slope_10'] === false, 'Slope 10 must be invalid across gap');
    });

    // 5. Pairwise Separation, Alignment & Spread Change
    run2DTest('Pairwise Relationships, Alignment & Spread Change', () => {
        let testState = createInitialML1FeatureState();
        for (let i = 0; i < 25; i++) {
            testState = stepML1Features(validCandle(100000 + i * 60000), i, testState, config).nextState;
        }
        // Uptrend step: close rises sharply -> EMA9 > EMA20
        const resUp = stepML1Features({ ...validCandle(100000 + 25 * 60000), high: 135, close: 130 }, 25, testState, config);
        assert(resUp.observation.validity['EMA_9_Above_EMA_20'] === true, 'Alignment must be valid');
        assert(resUp.observation.features['EMA_9_Above_EMA_20'] === 1, 'EMA9 must be above EMA20');
        assert(resUp.observation.validity['EMA_9_20_Separation'] === true, 'Separation must be valid');
        assert(resUp.observation.features['EMA_9_20_Separation'] > 0, 'Separation must be positive');
        assert(resUp.observation.validity['EMA_SpreadChange_9_20'] === true, 'SpreadChange must be valid');
    });

    // 6. Major Discontinuity Reset Policy on EMA
    run2DTest('Discontinuity Reset Policy on EMA Context', () => {
        let testState = createInitialML1FeatureState();
        for (let i = 0; i < 25; i++) {
            testState = stepML1Features(validCandle(100000 + i * 60000), i, testState, config).nextState;
        }
        assert(testState.emaState[9].isSeeded === true, 'EMA9 must be seeded');

        // Inject 10-minute gap (> 300,000ms threshold)
        const resDisc = stepML1Features(validCandle(100000 + 24 * 60000 + 600000), 25, testState, config);
        assert(resDisc.observation.features['IsDiscontinuity'] === 1, 'Discontinuity must be flagged');
        assert(resDisc.nextState.emaState[9].isSeeded === false, 'EMA must reset to unseeded on discontinuity');
        assert(resDisc.nextState.emaState[9].count === 1, 'EMA count must reset to 1');
    });

    // 7. Empty EMA Period Array (Ablation Configuration A)
    run2DTest('Empty EMA Periods Array Ablation Compatibility', () => {
        const ablationConfig = validateML1Config({ ...rawConfig, emaPeriods: [] });
        const res = stepML1Features(validCandle(100000), 0, createInitialML1FeatureState(), ablationConfig);
        assert(Object.keys(res.nextState.emaState).length === 0, 'No EMA sub-states should exist');
        assert(res.observation.features['EMA_9_Distance'] === undefined, 'EMA features must be completely absent');
    });

    // 8. Restored-State Integrity for EMA
    run2DTest('Restored-State Integrity for EMA Container', () => {
        const baseState = createInitialML1FeatureState();
        // Unconfigured period key in emaState
        try {
            stepML1Features(validCandle(1000), 0, {
                ...baseState,
                emaState: { 777: { count: 0, seedMean: 0, ema: null, isSeeded: false, history: [], unbrokenRun: 0 } }
            }, config);
            assert(false, 'Allowed unconfigured period key in emaState');
        } catch (e: any) { assert(e.message.includes('Unexpected period key'), e.message); }

        // Corrupted negative count in emaState
        try {
            stepML1Features(validCandle(1000), 0, {
                ...baseState,
                emaState: { 9: { count: -5, seedMean: 0, ema: null, isSeeded: false, history: [], unbrokenRun: 0 } }
            }, config);
            assert(false, 'Allowed negative count in emaState');
        } catch (e: any) { assert(e.message.includes('Corrupted count in emaState'), e.message); }
    });

    console.log(`\n=======================================`);
    console.log(`📊 ML-R1 PHASE 2D FINAL AUDIT:`);
    console.log(`   ↳ Tests Executed:  ${passed2D + failed2D}`);
    console.log(`   ↳ Tests Passed:    ${passed2D}`);
    console.log(`   ↳ Tests Failed:    ${failed2D}`);
    console.log(`=======================================\n`);

    if (failed2D === 0) {
        console.log('✅ ALL PHASE 2D TESTS PASSED. Causal EMA Context Engine is verified.\n🔒 Phase 2D FROZEN.');
        return true;
    } else {
        console.error('❌ PHASE 2D TESTS FAILED. DO NOT PROCEED TO PHASE 2E.');
        return false;
    }
}
