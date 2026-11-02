import { 
    stepTimeframeFeatureEngine, 
    stepMTFFeatureEngine
} from '../indicators/mlr1/mtf/MTFFeatureEngine';
import { MTF_CONFIG_A, MTF_CONFIG_B } from '../indicators/mlr1/mtf/MTFConfig';
import { createInitialMTFState } from '../indicators/mlr1/mtf/MTFState';
import { stepML1Features, createInitialML1FeatureState } from '../indicators/mlr1/ML1FeatureEngine';
import type { MTFCandle, HTFIncompleteDiagnostic } from '../indicators/mlr1/mtf/MTFTypes';
import type { ML1Candle } from '../indicators/mlr1/ML1FeatureTypes';

function assert(condition: boolean, msg: string): asserts condition {
    if (!condition) throw new Error(`[AssertionFailed] ${msg}`);
}

function makeCompletedCandle(tf: '15m' | '1h', openTime: number, durationMs: number, o = 100, h = 105, l = 95, c = 102, v = 1000): MTFCandle {
    return Object.freeze({
        timeframe: tf,
        openTimestamp: openTime,
        closeTimestamp: openTime + durationMs,
        open: o,
        high: h,
        low: l,
        close: c,
        volume: v,
        sourceObservationCount: Math.round(durationMs / 60_000),
        completeness: 'COMPLETE' as const
    });
}

export function runPhase3CTests(): boolean {
    console.log('\n======================================================');
    console.log('🧪 Starting Milestone 3 Phase 3C Acceptance Suite (HTF Features)');
    console.log('======================================================\n');
    let passed = 0;
    let failed = 0;

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

    const baseTime = Date.UTC(2026, 9, 15, 10, 0, 0);

    // 1. 15m Feature Parity Against Milestone 2
    runTest('1. 15m Feature Parity Against Milestone 2', () => {
        const initialState = createInitialMTFState().state15m;
        const c1 = makeCompletedCandle('15m', baseTime, 900_000, 100, 110, 90, 105, 1500);

        const htfRes = stepTimeframeFeatureEngine(initialState, c1, null, MTF_CONFIG_B.config15m);
        assert(htfRes.observation !== null, 'Expected observation from completed 15m candle');

        // Direct Milestone 2 calculation
        const ml1Candle: ML1Candle = { time: c1.openTimestamp, open: c1.open, high: c1.high, low: c1.low, close: c1.close, volume: c1.volume, isSynthetic: false };
        const m2Res = stepML1Features(ml1Candle, 0, createInitialML1FeatureState(), MTF_CONFIG_B.config15m.featureConfig);

        assert(
            JSON.stringify(htfRes.observation.features) === JSON.stringify(m2Res.observation.features),
            '15m feature values diverged from Milestone 2 formulas'
        );
        assert(
            JSON.stringify(htfRes.observation.validity) === JSON.stringify(m2Res.observation.validity),
            '15m feature validity diverged from Milestone 2 formulas'
        );
    });

    // 2. 1h Feature Parity Against Milestone 2
    runTest('2. 1h Feature Parity Against Milestone 2', () => {
        const initialState = createInitialMTFState().state1h;
        const c1 = makeCompletedCandle('1h', baseTime, 3_600_000, 200, 220, 180, 210, 5000);

        const htfRes = stepTimeframeFeatureEngine(initialState, c1, null, MTF_CONFIG_B.config1h);
        assert(htfRes.observation !== null, 'Expected observation from completed 1h candle');

        const ml1Candle: ML1Candle = { time: c1.openTimestamp, open: c1.open, high: c1.high, low: c1.low, close: c1.close, volume: c1.volume, isSynthetic: false };
        const m2Res = stepML1Features(ml1Candle, 0, createInitialML1FeatureState(), MTF_CONFIG_B.config1h.featureConfig);

        assert(
            JSON.stringify(htfRes.observation.features) === JSON.stringify(m2Res.observation.features),
            '1h feature values diverged from Milestone 2 formulas'
        );
    });

    // 3. Independent 15m Warm-up Timeline (Config A: bar 50; Config B: bar 199)
    runTest('3. Independent 15m Warm-up Timeline', () => {
        // Config A
        let stateA = createInitialMTFState().state15m;
        for (let i = 0; i < 51; i++) {
            const c = makeCompletedCandle('15m', baseTime + i * 900_000, 900_000);
            const res = stepTimeframeFeatureEngine(stateA, c, null, MTF_CONFIG_A.config15m);
            stateA = res.nextTimeframeState;
            if (i < 50) assert(res.observation!.features['IsWarmupComplete'] === 0, `Warmup should be 0 before bar 50 (bar ${i})`);
            if (i === 50) assert(res.observation!.features['IsWarmupComplete'] === 1, 'Config A warm-up must activate at bar index 50');
        }

        // Config B (needs 200 bars for EMA 200)
        let stateB = createInitialMTFState().state15m;
        for (let i = 0; i < 200; i++) {
            const c = makeCompletedCandle('15m', baseTime + i * 900_000, 900_000);
            const res = stepTimeframeFeatureEngine(stateB, c, null, MTF_CONFIG_B.config15m);
            stateB = res.nextTimeframeState;
            if (i < 199) assert(res.observation!.features['IsWarmupComplete'] === 0, `Warmup should be 0 before bar 199 (bar ${i})`);
            if (i === 199) assert(res.observation!.features['IsWarmupComplete'] === 1, 'Config B warm-up must activate at bar index 199');
        }
    });

    // 4. Independent 1h Warm-up Timeline
    runTest('4. Independent 1h Warm-up Timeline', () => {
        let state1h = createInitialMTFState().state1h;
        for (let i = 0; i < 51; i++) {
            const c = makeCompletedCandle('1h', baseTime + i * 3_600_000, 3_600_000);
            const res = stepTimeframeFeatureEngine(state1h, c, null, MTF_CONFIG_A.config1h);
            state1h = res.nextTimeframeState;
            if (i < 50) assert(res.observation!.features['IsWarmupComplete'] === 0, `1h warmup should be 0 before bar 50`);
            if (i === 50) assert(res.observation!.features['IsWarmupComplete'] === 1, '1h warm-up must activate at bar index 50');
        }
    });

    // 5. Incomplete Candles Never Enter Feature Calculations
    runTest('5. Incomplete Candles Never Enter Feature Calculations', () => {
        const state = createInitialMTFState().state15m;
        // Window in progress: completedCandle is null
        const res = stepTimeframeFeatureEngine(state, null, null, MTF_CONFIG_A.config15m);
        assert(res.observation === null, 'Must not calculate features when completedCandle is null');
        assert(res.nextTimeframeState === state, 'State must remain identical when no candle completed');
    });

    // 6. Non-COMPLETE Candles Strictly Rejected
    runTest('6. Non-COMPLETE Candles Strictly Rejected', () => {
        const state = createInitialMTFState().state15m;
        const badCandle = {
            ...makeCompletedCandle('15m', baseTime, 900_000),
            completeness: 'INCOMPLETE_MISSING' as any
        };

        try {
            stepTimeframeFeatureEngine(state, badCandle, null, MTF_CONFIG_A.config15m);
            assert(false, 'Allowed candle with non-COMPLETE completeness');
        } catch (e: any) {
            assert(e.message.includes('non-COMPLETE status'), e.message);
        }
    });

    // 7. 15m Invalidation / Gap Does Not Reset 1h Features
    runTest('7. 15m Invalidation / Gap Does Not Reset 1h Features', () => {
        let mtfState = createInitialMTFState();

        // Warm up 1h with 5 completed candles
        for (let i = 0; i < 5; i++) {
            const c1h = makeCompletedCandle('1h', baseTime + i * 3_600_000, 3_600_000);
            mtfState = stepMTFFeatureEngine(mtfState, null, null, c1h, null, MTF_CONFIG_A).nextState;
        }

        const pre1hCount = mtfState.state1h.lastCompletedBarIndex;
        assert(pre1hCount === 4, '1h bar index should be 4');

        // Simulate 15m failure (diagnostic emitted for 15m, 1h has null diagnostic)
        const diag15m: HTFIncompleteDiagnostic = Object.freeze({
            timeframe: '15m',
            openTimestamp: baseTime,
            closeTimestamp: baseTime + 900_000,
            expectedSourceCount: 15,
            actualSourceCount: 12,
            missingTimestamps: Object.freeze([baseTime + 60_000]),
            duplicateCount: 0,
            invalidSourceCount: 0,
            completeness: 'INCOMPLETE_MISSING'
        });

        const res = stepMTFFeatureEngine(mtfState, null, diag15m, null, null, MTF_CONFIG_A);

        // 15m feature engine state is reset
        assert(res.nextState.state15m.lastCompletedBarIndex === null, '15m bar index must be reset');
        assert(Object.keys(res.nextState.state15m.latestFeatures).length === 0, '15m features must be reset');

        // 1h feature engine state remains 100% UNMUTATED and intact
        assert(res.nextState.state1h.lastCompletedBarIndex === pre1hCount, '1h bar index must NOT be reset by 15m failure');
        assert(res.nextState.state1h.featureEngineState === mtfState.state1h.featureEngineState, '1h feature state reference must be unchanged');
    });

    // 8. 1h Invalidation / Gap Does Not Reset 15m Features
    runTest('8. 1h Invalidation / Gap Does Not Reset 15m Features', () => {
        let mtfState = createInitialMTFState();

        // Warm up 15m with 10 completed candles
        for (let i = 0; i < 10; i++) {
            const c15m = makeCompletedCandle('15m', baseTime + i * 900_000, 900_000);
            mtfState = stepMTFFeatureEngine(mtfState, c15m, null, null, null, MTF_CONFIG_A).nextState;
        }

        const pre15mCount = mtfState.state15m.lastCompletedBarIndex;
        assert(pre15mCount === 9, '15m bar index should be 9');

        // Simulate 1h failure
        const diag1h: HTFIncompleteDiagnostic = Object.freeze({
            timeframe: '1h',
            openTimestamp: baseTime,
            closeTimestamp: baseTime + 3_600_000,
            expectedSourceCount: 60,
            actualSourceCount: 50,
            missingTimestamps: Object.freeze([baseTime + 60_000]),
            duplicateCount: 0,
            invalidSourceCount: 0,
            completeness: 'INCOMPLETE_MISSING'
        });

        const res = stepMTFFeatureEngine(mtfState, null, null, null, diag1h, MTF_CONFIG_A);

        // 1h reset
        assert(res.nextState.state1h.lastCompletedBarIndex === null, '1h bar index must be reset');
        // 15m unaffected
        assert(res.nextState.state15m.lastCompletedBarIndex === pre15mCount, '15m bar index must NOT be reset by 1h failure');
        assert(res.nextState.state15m.featureEngineState === mtfState.state15m.featureEngineState, '15m feature state reference must be unchanged');
    });

    // 9. Feature Validity Remains Distinct from HTF Availability
    runTest('9. Feature Validity Remains Distinct from HTF Availability', () => {
        const state = createInitialMTFState().state15m;
        // On bar 5: candle is complete, but ATR_14 and EMA_20 are still warming up
        let currState = state;
        let obs: any = null;
        for (let i = 0; i < 5; i++) {
            const c = makeCompletedCandle('15m', baseTime + i * 900_000, 900_000);
            const res = stepTimeframeFeatureEngine(currState, c, null, MTF_CONFIG_B.config15m);
            currState = res.nextTimeframeState;
            obs = res.observation;
        }

        assert(obs !== null, 'Observation produced');
        // Candle anatomy is valid immediately on bar 5
        assert(obs.validity['CandleRange'] === true, 'CandleRange must be valid');
        assert(obs.validity['BodySize'] === true, 'BodySize must be valid');
        // Indicators needing more lookback remain invalid independently
        assert(obs.validity['ATR_14'] === false, 'ATR_14 must still be invalid on bar 5');
        assert(obs.validity['EMA_20_Distance'] === false, 'EMA_20_Distance must still be invalid on bar 5');
    });

    // 10. Feature State Remains Deeply Immutable Across Streaming Updates
    runTest('10. Feature State Remains Deeply Immutable Across Streaming Updates', () => {
        let state = createInitialMTFState().state15m;
        const c1 = makeCompletedCandle('15m', baseTime, 900_000);
        state = stepTimeframeFeatureEngine(state, c1, null, MTF_CONFIG_A.config15m).nextTimeframeState;

        const snapshot = JSON.stringify(state.featureEngineState);
        const c2 = makeCompletedCandle('15m', baseTime + 900_000, 900_000);
        const res2 = stepTimeframeFeatureEngine(state, c2, null, MTF_CONFIG_A.config15m);

        assert(JSON.stringify(state.featureEngineState) === snapshot, 'Original featureEngineState was mutated in place');
        assert(Object.isFrozen(res2.nextTimeframeState), 'nextTimeframeState must be frozen');
        assert(Object.isFrozen(res2.nextTimeframeState.featureEngineState), 'Next featureEngineState must be frozen');
    });

    // 11. Repeated Completed-Candle Processing Rejected by Chronology
    runTest('11. Repeated Completed-Candle Processing Rejected by Chronology', () => {
        let state = createInitialMTFState().state15m;
        const c1 = makeCompletedCandle('15m', baseTime, 900_000);
        const res1 = stepTimeframeFeatureEngine(state, c1, null, MTF_CONFIG_A.config15m);
        state = res1.nextTimeframeState;

        // Try to feed the exact same completed candle again with same bar index
        const badRepeatCandle: ML1Candle = {
            time: c1.openTimestamp,
            open: c1.open,
            high: c1.high,
            low: c1.low,
            close: c1.close,
            volume: c1.volume
        };

        const m2RepeatRes = stepML1Features(badRepeatCandle, 0, state.featureEngineState, MTF_CONFIG_A.config15m.featureConfig);
        assert(m2RepeatRes.observation.features['IsDuplicateTimestamp'] === 1, 'Milestone 2 must reject duplicate completed candle');
        assert(m2RepeatRes.nextState === state.featureEngineState, 'State must not advance on duplicate completed candle');
    });

    // 12. Recovery After HTF Aggregation Gap Restarts Warm-up
    runTest('12. Recovery After HTF Aggregation Gap Restarts Warm-up', () => {
        let state = createInitialMTFState().state15m;
        // Warm up for 55 completed bars (Config A: warm-up complete)
        for (let i = 0; i < 55; i++) {
            const c = makeCompletedCandle('15m', baseTime + i * 900_000, 900_000);
            state = stepTimeframeFeatureEngine(state, c, null, MTF_CONFIG_A.config15m).nextTimeframeState;
        }

        assert(state.latestFeatures['IsWarmupComplete'] === 1, 'Warmup should be complete at bar 55');

        // Gap occurs: diagnostic emitted
        const gapDiag: HTFIncompleteDiagnostic = Object.freeze({
            timeframe: '15m',
            openTimestamp: baseTime + 55 * 900_000,
            closeTimestamp: baseTime + 56 * 900_000,
            expectedSourceCount: 15,
            actualSourceCount: 0,
            missingTimestamps: Object.freeze([]),
            duplicateCount: 0,
            invalidSourceCount: 0,
            completeness: 'INCOMPLETE_MISSING'
        });

        const resetRes = stepTimeframeFeatureEngine(state, null, gapDiag, MTF_CONFIG_A.config15m);
        state = resetRes.nextTimeframeState;

        // Next post-gap completed candle arrives
        const postGapCandle = makeCompletedCandle('15m', baseTime + 57 * 900_000, 900_000);
        const postGapRes = stepTimeframeFeatureEngine(state, postGapCandle, null, MTF_CONFIG_A.config15m);

        assert(postGapRes.observation !== null, 'Post-gap candle processed');
        assert(postGapRes.observation!.features['IsWarmupComplete'] === 0, 'Warmup must restart from 0 after gap reset');
        assert(postGapRes.nextTimeframeState.lastCompletedBarIndex === 0, 'Bar index must restart from 0');
    });

    console.log(`\n=======================================`);
    console.log(`📊 ML-R1 PHASE 3C ACCEPTANCE AUDIT:`);
    console.log(`   ↳ Tests Executed:  ${passed + failed}`);
    console.log(`   ↳ Tests Passed:    ${passed}`);
    console.log(`   ↳ Tests Failed:    ${failed}`);
    console.log(`=======================================\n`);

    if (failed === 0 && passed === 12) {
        console.log('✅ ALL 12 PHASE 3C FEATURE ENGINE CRITERIA RIGOROUSLY MET.');
        console.log('🔒 Phase 3C Independent HTF Feature Engines FULLY FROZEN.');
        return true;
    } else {
        console.error('❌ PHASE 3C TESTS FAILED. DO NOT PROCEED TO PHASE 3D.');
        return false;
    }
}