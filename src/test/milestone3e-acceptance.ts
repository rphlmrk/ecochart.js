import { 
    createInitialIntegratedMTFState, 
    stepIntegratedMTFPipeline, 
    type IntegratedMTFObservation 
} from '../indicators/mlr1/mtf/MTFEngine';
import { MTF_CONFIG_A, validateMTFConfig } from '../indicators/mlr1/mtf/MTFConfig';
import { ML1_CONFIG_A } from '../indicators/mlr1/ML1FeatureConfigs';
import type { ML1Candle } from '../indicators/mlr1/ML1FeatureTypes';

function assert(condition: boolean, msg: string): asserts condition {
    if (!condition) throw new Error(`[AssertionFailed] ${msg}`);
}

function makeCandle(t: number, o = 100, h = 105, l = 95, c = 102, v = 10): ML1Candle {
    return { time: t, open: o, high: h, low: l, close: c, volume: v };
}

export function runPhase3ETests(): boolean {
    console.log('\n======================================================');
    console.log('🧪 Starting Milestone 3 Phase 3E Acceptance Suite (Full Pipeline Integration)');
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
    const pipelineConfig = {
        m1Config: ML1_CONFIG_A,
        mtfConfig: MTF_CONFIG_A
    };

    // 1. Normal Streaming Pipeline Integration (1m -> Aggregation -> Features -> Alignment)
    runTest('1. Normal Streaming Pipeline Integration (1m -> Aggregation -> Features -> Alignment)', () => {
        let state = createInitialIntegratedMTFState();
        const observations: IntegratedMTFObservation[] = [];

        // Feed 65 continuous 1m candles (10:00 to 11:04)
        for (let i = 0; i <= 65; i++) {
            const c = makeCandle(baseTime + i * 60_000, 100 + i, 110 + i, 90 + i, 102 + i, 100);
            const res = stepIntegratedMTFPipeline(c, i, state, pipelineConfig);
            state = res.nextState;
            observations.push(res.observation);
        }

        // 1m clock authoritativeness check
        assert(observations.length === 66, 'Must produce exactly one observation per 1m candle');
        assert(observations[14].observation1m.timestamp === baseTime + 14 * 60_000, 'Observation 14 timestamp matches 10:14');

        // 15m Causal Boundary Check: at 10:14 unavailable; at 10:15 available with age 0
        assert(observations[14].mtfContext.context15m.isAvailable === false, '15m must be unavailable at 10:14');
        assert(observations[15].mtfContext.context15m.isAvailable === true, '15m must become available at 10:15');
        assert(observations[15].mtfContext.context15m.contextAgeMs === 0, '15m context age must be 0ms at 10:15');
        assert(observations[16].mtfContext.context15m.contextAgeMs === 60_000, '15m context age must be 60,000ms at 10:16');

        // 1h Causal Boundary Check: at 10:59 unavailable; at 11:00 available with age 0
        assert(observations[59].mtfContext.context1h.isAvailable === false, '1h must be unavailable at 10:59');
        assert(observations[60].mtfContext.context1h.isAvailable === true, '1h must become available at 11:00');
        assert(observations[60].mtfContext.context1h.contextAgeMs === 0, '1h context age must be 0ms at 11:00');

        // Every aligned context must be causal relative to its 1m observation.
        for (const observation of observations) {
            const timestamp = observation.observation1m.timestamp;
            const context15m = observation.mtfContext.context15m;
            const context1h = observation.mtfContext.context1h;

            if (context15m.lastCompletedCloseTimestamp !== null) {
                assert(
                    context15m.lastCompletedCloseTimestamp <= timestamp,
                    `15m context exposed a future candle close (${context15m.lastCompletedCloseTimestamp} > ${timestamp})`
                );
            }
            if (context1h.lastCompletedCloseTimestamp !== null) {
                assert(
                    context1h.lastCompletedCloseTimestamp <= timestamp,
                    `1h context exposed a future candle close (${context1h.lastCompletedCloseTimestamp} > ${timestamp})`
                );
            }
        }
    });

    // 2. 15m-Only Gap Integration (15m resets & recovers, 1h remains intact)
    runTest('2. 15m-Only Gap Integration (15m resets & recovers, 1h remains intact)', () => {
        let state = createInitialIntegratedMTFState();

        // Feed 1h (60 candles: 10:00 to 10:59) + 11:00 to complete 1h
        for (let i = 0; i <= 60; i++) {
            state = stepIntegratedMTFPipeline(makeCandle(baseTime + i * 60_000), i, state, pipelineConfig).nextState;
        }

        // Jump 15m: 11:00 jumps to 11:30 (missing 11:01–11:29) at absolute aligned slot 90
        const resGap = stepIntegratedMTFPipeline(makeCandle(baseTime + 90 * 60_000), 90, state, pipelineConfig);
        state = resGap.nextState;

        // 15m must be reset and unavailable
        assert(resGap.observation.mtfContext.context15m.isAvailable === false, '15m must be unavailable after gap');
        assert(resGap.observation.mtfContext.context15m.availabilityStatus === 'UNAVAILABLE', '15m status is UNAVAILABLE');
        assert(Object.keys(resGap.observation.mtfContext.context15m.features).length === 0, 'No 15m features exposed');

        // 1h remains available (completed candle 10:00–11:00, age 30m)
        assert(resGap.observation.mtfContext.context1h.isAvailable === true, '1h must remain available despite 15m gap');
        assert(resGap.observation.mtfContext.context1h.contextAgeMs === 30 * 60_000, '1h age must be 30m');

        // Feed 15 clean candles for 11:30 to 11:44
        for (let i = 91; i <= 104; i++) {
            state = stepIntegratedMTFPipeline(makeCandle(baseTime + i * 60_000), i, state, pipelineConfig).nextState;
        }

        // 11:45 boundary completes post-gap 15m window
        const resRecovered = stepIntegratedMTFPipeline(makeCandle(baseTime + 105 * 60_000), 105, state, pipelineConfig);
        assert(resRecovered.observation.mtfContext.context15m.isAvailable === true, '15m must recover cleanly at 11:45');
        assert(resRecovered.observation.mtfContext.context15m.lastCompletedCloseTimestamp === baseTime + 105 * 60_000, '15m close is 11:45');
        assert(resRecovered.observation.mtfContext.context1h.isAvailable === true, '1h remains available');
    });

    // 3. 1h-Only Gap Integration (1h resets, 15m continues operating)
    runTest('3. 1h-Only Gap Integration (1h resets, 15m continues operating)', () => {
        let state = createInitialIntegratedMTFState();
        // Complete 10:00–11:00
        for (let i = 0; i <= 60; i++) {
            state = stepIntegratedMTFPipeline(makeCandle(baseTime + i * 60_000), i, state, pipelineConfig).nextState;
        }

        // Jump 2 hours to 13:00 (skipping 11:00–12:00 and 12:00–13:00) at absolute aligned slot 180
        const resJump = stepIntegratedMTFPipeline(makeCandle(baseTime + 180 * 60_000), 180, state, pipelineConfig);

        // 1h is reset and unavailable
        assert(resJump.observation.mtfContext.context1h.isAvailable === false, '1h must be unavailable after multi-hour gap');
        assert(resJump.observation.mtfContext.context1h.availabilityStatus === 'UNAVAILABLE', '1h status is UNAVAILABLE');

        // Feed 15 clean candles to complete next 15m window (13:00–13:14)
        state = resJump.nextState;
        for (let i = 181; i <= 194; i++) {
            state = stepIntegratedMTFPipeline(makeCandle(baseTime + i * 60_000), i, state, pipelineConfig).nextState;
        }

        const res1315 = stepIntegratedMTFPipeline(makeCandle(baseTime + 195 * 60_000), 195, state, pipelineConfig);
        // 15m completes independently while 1h is still incomplete
        assert(res1315.observation.mtfContext.context15m.isAvailable === true, '15m completes at 13:15');
        assert(res1315.observation.mtfContext.context1h.isAvailable === false, '1h still unavailable');
    });

    // 4. Simultaneous Timeframe Gaps (Both timeframes reset and recover independently)
    runTest('4. Simultaneous Timeframe Gaps (Both timeframes reset and recover independently)', () => {
        let state = createInitialIntegratedMTFState();
        for (let i = 0; i <= 60; i++) {
            state = stepIntegratedMTFPipeline(makeCandle(baseTime + i * 60_000), i, state, pipelineConfig).nextState;
        }

        // Major 4-hour gap to 15:00 at absolute aligned slot 300
        const resGap = stepIntegratedMTFPipeline(makeCandle(baseTime + 300 * 60_000), 300, state, pipelineConfig);
        assert(resGap.observation.mtfContext.context15m.isAvailable === false, '15m reset on major gap');
        assert(resGap.observation.mtfContext.context1h.isAvailable === false, '1h reset on major gap');

        // Feed 60 clean candles (15:00 to 15:59)
        state = resGap.nextState;
        for (let i = 301; i <= 359; i++) {
            state = stepIntegratedMTFPipeline(makeCandle(baseTime + i * 60_000), i, state, pipelineConfig).nextState;
        }

        // At 16:00: both 15m and 1h complete and recover together
        const res1600 = stepIntegratedMTFPipeline(makeCandle(baseTime + 360 * 60_000), 360, state, pipelineConfig);
        assert(res1600.observation.mtfContext.context15m.isAvailable === true, '15m recovered at 16:00');
        assert(res1600.observation.mtfContext.context1h.isAvailable === true, '1h recovered at 16:00');
        assert(res1600.observation.mtfContext.context15m.contextAgeMs === 0, '15m age 0');
        assert(res1600.observation.mtfContext.context1h.contextAgeMs === 0, '1h age 0');
    });

    // 5. Warm-up Recovery Integration (Context is available, but individual features remain invalid)
    runTest('5. Warm-up Recovery Integration (Context is available, but individual features remain invalid)', () => {
        let state = createInitialIntegratedMTFState();
        let obs15: IntegratedMTFObservation | null = null;

        // Feed 16 candles: completes 1st 15m candle at 10:15 (index 15)
        for (let i = 0; i <= 15; i++) {
            const result = stepIntegratedMTFPipeline(makeCandle(baseTime + i * 60_000), i, state, pipelineConfig);
            state = result.nextState;
            if (i === 15) {
                obs15 = result.observation;
            }
        }

        assert(obs15 !== null, '10:15 observation must exist');
        assert(obs15.mtfContext.context15m.isAvailable === true, 'Context is available for consumption');
        assert(obs15.mtfContext.context15m.isWarmupComplete === false, 'isWarmupComplete must be false on 1st candle');
        assert(obs15.mtfContext.context15m.availabilityStatus === 'WARMING_UP', 'Status must be WARMING_UP');
        assert(obs15.mtfContext.context15m.validity['CandleRange'] === true, 'CandleRange is valid');
        assert(obs15.mtfContext.context15m.validity['ATR_14'] === false, 'ATR_14 is invalid during warm-up');
    });

    // 6. Stale Context Integration (Stale context is unavailable for consumption)
    runTest('6. Stale Context Integration (Stale context is unavailable for consumption)', () => {
        const staleConfig = {
            m1Config: ML1_CONFIG_A,
            mtfConfig: validateMTFConfig({
                symbol: 'SOLUSDT',
                baseTimeframe: '1m',
                config15m: { ...MTF_CONFIG_A.config15m, maxStalenessMs: 30_000 }, // 30 seconds
                config1h: { ...MTF_CONFIG_A.config1h, maxStalenessMs: 7_200_000 }
            })
        };

        let state = createInitialIntegratedMTFState();
        for (let i = 0; i <= 15; i++) {
            state = stepIntegratedMTFPipeline(makeCandle(baseTime + i * 60_000), i, state, staleConfig).nextState;
        }

        // 10:16 is contiguous. The prior 15m candle closed at 10:15, so age 60s exceeds 30s.
        const resStale = stepIntegratedMTFPipeline(makeCandle(baseTime + 16 * 60_000), 16, state, staleConfig);
        assert(resStale.observation.mtfContext.context15m.isAvailable === false, 'Stale 15m context cannot be consumed');
        assert(resStale.observation.mtfContext.context15m.availabilityStatus === 'STALE', 'Status must be STALE');
        assert(resStale.observation.mtfContext.context15m.lastCompletedCandle !== null, 'Stale candle preserved for diagnostics');
        assert(resStale.observation.mtfContext.context15m.contextAgeMs === 60_000, 'Context age must be 60,000ms');
    });

    // 7. Chronology Attacks on Integrated Pipeline
    runTest('7. Chronology Attacks on Integrated Pipeline', () => {
        let state = createInitialIntegratedMTFState();
        state = stepIntegratedMTFPipeline(makeCandle(baseTime), 0, state, pipelineConfig).nextState;
        state = stepIntegratedMTFPipeline(makeCandle(baseTime + 60_000), 1, state, pipelineConfig).nextState;

        // Attack A: Out-of-order timestamp (09:59)
        const resOOO = stepIntegratedMTFPipeline(makeCandle(baseTime - 60_000), 2, state, pipelineConfig);
        assert(resOOO.observation.observation1m.features['IsSourceValid'] === 0, 'Out-of-order must be marked invalid');
        assert(resOOO.nextState.mtfState.last1mTimestamp === baseTime + 60_000, 'Clock must not regress on out-of-order');

        // Attack B: Duplicate timestamp (10:01 repeated)
        const resDup = stepIntegratedMTFPipeline(makeCandle(baseTime + 60_000), 3, state, pipelineConfig);
        assert(resDup.observation.observation1m.features['IsDuplicateTimestamp'] === 1, 'Duplicate flagged');
        assert(resDup.nextState.mtfState.last1mTimestamp === baseTime + 60_000, 'Clock must not advance on duplicate');

        // Attack C: Non-finite OHLCV
        const resNaN = stepIntegratedMTFPipeline({ ...makeCandle(baseTime + 120_000), high: NaN }, 2, state, pipelineConfig);
        assert(resNaN.observation.observation1m.features['IsValidOHLCV'] === 0, 'NaN must be invalid');
        assert(resNaN.nextState.mtfState.state15m.aggregation.actualSourceCount === 2, 'Invalid candle not added to 15m');
    });

    // 8. Deterministic Replay (Identical source streams produce identical MTF observations)
    runTest('8. Deterministic Replay (Identical source streams produce identical MTF observations)', () => {
        const stream = Array.from({ length: 65 }, (_, i) => makeCandle(baseTime + i * 60_000, 100 + i, 110 + i, 90 + i, 105 + i, 50));

        let stateA = createInitialIntegratedMTFState();
        let stateB = createInitialIntegratedMTFState();
        const obsA: any[] = [];
        const obsB: any[] = [];

        for (let i = 0; i < stream.length; i++) {
            const resA = stepIntegratedMTFPipeline(stream[i], i, stateA, pipelineConfig);
            stateA = resA.nextState;
            obsA.push(resA.observation);

            const resB = stepIntegratedMTFPipeline(stream[i], i, stateB, pipelineConfig);
            stateB = resB.nextState;
            obsB.push(resB.observation);
        }

        assert(JSON.stringify(obsA) === JSON.stringify(obsB), 'Integrated observation sequence diverged across runs');
        assert(JSON.stringify(stateA) === JSON.stringify(stateB), 'Integrated final state diverged across runs');
    });

    // 9. Coherent Integrated Observation Snapshot Capture
    runTest('9. Coherent Integrated Observation Snapshot Capture', () => {
        let state = createInitialIntegratedMTFState();
        let resultAt1100: ReturnType<typeof stepIntegratedMTFPipeline> | null = null;

        // Feed 61 candles to complete both 15m (4th window) and 1h (1st window) at 11:00 (index 60)
        for (let i = 0; i <= 60; i++) {
            const result = stepIntegratedMTFPipeline(makeCandle(baseTime + i * 60_000), i, state, pipelineConfig);
            state = result.nextState;
            if (i === 60) {
                resultAt1100 = result;
            }
        }

        assert(resultAt1100 !== null, '11:00 observation must exist');
        const snapshot = resultAt1100.observation;

        // Verify structural presence of all required fields
        assert(snapshot.observation1m !== undefined, '1m observation must be present');
        assert(snapshot.observation1m.features['CandleRange'] !== undefined, '1m CandleRange must exist');
        assert(snapshot.observation1m.validity['CandleRange'] === true, '1m CandleRange is valid');

        assert(snapshot.mtfContext !== undefined, 'MTF context must be present');
        assert(snapshot.mtfContext.context15m.isAvailable === true, '15m must be available');
        assert(snapshot.mtfContext.context15m.lastCompletedCloseTimestamp === baseTime + 3_600_000, '15m close is 11:00');
        assert(snapshot.mtfContext.context15m.features['CandleRange'] !== undefined, '15m CandleRange must exist');

        assert(snapshot.mtfContext.context1h.isAvailable === true, '1h must be available');
        assert(snapshot.mtfContext.context1h.lastCompletedCloseTimestamp === baseTime + 3_600_000, '1h close is 11:00');
        assert(snapshot.mtfContext.context1h.features['CandleRange'] !== undefined, '1h CandleRange must exist');

        console.log('\n  📋 Coherent Observation Snapshot at 11:00 UTC:');
        console.log(`     ↳ Timestamp:       ${new Date(snapshot.observation1m.timestamp).toISOString()}`);
        console.log(`     ↳ 1m Close:        $${snapshot.observation1m.sourceClose}`);
        console.log(`     ↳ 15m Available:   ${snapshot.mtfContext.context15m.isAvailable} (${snapshot.mtfContext.context15m.availabilityStatus})`);
        console.log(`     ↳ 15m Age:         ${snapshot.mtfContext.context15m.contextAgeMs}ms`);
        console.log(`     ↳ 15m Range:       ${snapshot.mtfContext.context15m.features['CandleRange']}`);
        console.log(`     ↳ 1h Available:    ${snapshot.mtfContext.context1h.isAvailable} (${snapshot.mtfContext.context1h.availabilityStatus})`);
        console.log(`     ↳ 1h Age:          ${snapshot.mtfContext.context1h.contextAgeMs}ms`);
        console.log(`     ↳ 1h Range:        ${snapshot.mtfContext.context1h.features['CandleRange']}`);
    });

    console.log(`\n=======================================`);
    console.log(`📊 ML-R1 PHASE 3E INTEGRATION AUDIT:`);
    console.log(`   ↳ Tests Executed:  ${passed + failed}`);
    console.log(`   ↳ Tests Passed:    ${passed}`);
    console.log(`   ↳ Tests Failed:    ${failed}`);
    console.log(`=======================================\n`);

    if (failed === 0 && passed === 9) {
        console.log('✅ ALL 9 PHASE 3E FULL PIPELINE INTEGRATION CRITERIA RIGOROUSLY MET.');
        console.log('🔒 Phase 3E Full MTF Integration & Recovery FULLY FROZEN.');
        return true;
    } else {
        console.error('❌ PHASE 3E TESTS FAILED.');
        return false;
    }
}