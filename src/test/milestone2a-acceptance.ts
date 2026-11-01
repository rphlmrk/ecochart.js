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

    // 1. Configuration Validation
    runTest('Configuration Validation (Arrays, Whitespace, Negatives)', () => {
        try { validateML1Config({ ...rawConfig, symbol: '   ' }); assert(false, 'Whitespace symbol'); } catch (e: any) { assert(e.message.includes('non-empty string'), e.message); }
        try { validateML1Config({ ...rawConfig, expectedIntervalMs: -60000 }); assert(false, 'Negative interval'); } catch (e: any) { assert(e.message.includes('positive finite number'), e.message); }
        try { validateML1Config({ ...rawConfig, emaPeriods: [] }); assert(false, 'Empty array'); } catch (e: any) { assert(e.message.includes('non-empty array'), e.message); }
        try { validateML1Config({ ...rawConfig, atrPeriods: [14, 14] }); assert(false, 'Duplicate period'); } catch (e: any) { assert(e.message.includes('duplicate periods'), e.message); }
        validateML1Config(rawConfig);
    });

    const config = validateML1Config(rawConfig);

    // 2. Initial State & State Version
    runTest('State Version Enforcement', () => {
        const state = createInitialML1FeatureState();
        try { stepML1Features(validCandle(1000), 0, { ...state, stateVersion: 99 }, config); assert(false, 'Incompatible version'); } 
        catch (e: any) { assert(e.message.includes('Incompatible state version'), e.message); }
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

    console.log(`\n=======================================`);
    console.log(`📊 ML-R1 PHASE 2A FINAL AUDIT:`);
    console.log(`   ↳ Tests Executed:  ${passed + failed}`);
    console.log(`   ↳ Tests Passed:    ${passed}`);
    console.log(`   ↳ Tests Failed:    ${failed}`);
    console.log(`=======================================\n`);

    if (failed === 0) {
        console.log('✅ ALL PHASE 2A CONTRACT TESTS PASSED. The transition engine is secure and immutable.');
        return true;
    } else {
        console.error('❌ PHASE 2A TESTS FAILED. DO NOT FREEZE.');
        return false;
    }
}
