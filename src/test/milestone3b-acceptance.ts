import { 
    stepMTFAggregation, 
    processMTFAggregationBatch 
} from '../indicators/mlr1/mtf/MTFAggregator';
import { MTF_CONFIG_A } from '../indicators/mlr1/mtf/MTFConfig';
import { createInitialMTFState } from '../indicators/mlr1/mtf/MTFState';
import type { ML1Candle } from '../indicators/mlr1/ML1FeatureTypes';

function assert(condition: boolean, msg: string): asserts condition {
    if (!condition) throw new Error(`[AssertionFailed] ${msg}`);
}

function makeCandle(t: number, o = 100, h = 105, l = 95, c = 102, v = 10): ML1Candle {
    return { time: t, open: o, high: h, low: l, close: c, volume: v };
}

export function runPhase3BTests(): boolean {
    console.log('\n======================================================');
    console.log('🧪 Starting Milestone 3 Phase 3B Acceptance Suite (Aggregation)');
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

    // 1. Exact 15m OHLCV Aggregation & Source Count (15 bars)
    runTest('1. Exact 15m OHLCV Aggregation & Source Count (15 bars)', () => {
        let state = createInitialMTFState();
        const baseTime = Date.UTC(2026, 9, 15, 10, 0, 0);

        // Feed 15 candles for 10:00 to 10:14
        for (let i = 0; i < 15; i++) {
            const c = makeCandle(baseTime + i * 60_000, 100 + i, 110 + i, 90 + i, 102 + i, 100);
            state = stepMTFAggregation(c, true, state, MTF_CONFIG_A).nextState;
        }

        // At 10:15, boundary crosses and completes 10:00–10:15 window
        const triggerCandle = makeCandle(baseTime + 15 * 60_000);
        const res = stepMTFAggregation(triggerCandle, true, state, MTF_CONFIG_A);

        const candle15m = res.completed15m;
        assert(candle15m !== null, 'Expected completed 15m candle at 10:15');
        assert(candle15m.timeframe === '15m', 'Timeframe must be 15m');
        assert(candle15m.openTimestamp === baseTime, 'Open timestamp must be 10:00');
        assert(candle15m.closeTimestamp === baseTime + 900_000, 'Close timestamp must be 10:15');
        assert(candle15m.open === 100, 'Open must match first candle open (100)');
        assert(candle15m.high === 124, 'High must match highest high (110 + 14 = 124)');
        assert(candle15m.low === 90, 'Low must match lowest low (90 + 0 = 90)');
        assert(candle15m.close === 116, 'Close must match last candle close (102 + 14 = 116)');
        assert(candle15m.volume === 1500, 'Volume must sum to 15 * 100 = 1500');
        assert(candle15m.sourceObservationCount === 15, 'Source observation count must be exactly 15');
        assert(candle15m.completeness === 'COMPLETE', 'Completeness must be COMPLETE');
    });

    // 2. Exact 1h OHLCV Aggregation & Source Count (60 bars)
    runTest('2. Exact 1h OHLCV Aggregation & Source Count (60 bars)', () => {
        let state = createInitialMTFState();
        const baseTime = Date.UTC(2026, 9, 15, 10, 0, 0);

        // Feed 60 candles for 10:00 to 10:59
        for (let i = 0; i < 60; i++) {
            const c = makeCandle(baseTime + i * 60_000, 200 + i, 250 + i, 180 + i, 210 + i, 50);
            state = stepMTFAggregation(c, true, state, MTF_CONFIG_A).nextState;
        }

        // At 11:00, 1h window completes
        const triggerCandle = makeCandle(baseTime + 3_600_000);
        const res = stepMTFAggregation(triggerCandle, true, state, MTF_CONFIG_A);

        const candle1h = res.completed1h;
        assert(candle1h !== null, 'Expected completed 1h candle at 11:00');
        assert(candle1h.open === 200, 'Open must match first candle open (200)');
        assert(candle1h.high === 309, 'High must match highest high (250 + 59 = 309)');
        assert(candle1h.low === 180, 'Low must match lowest low (180 + 0 = 180)');
        assert(candle1h.close === 269, 'Close must match last candle close (210 + 59 = 269)');
        assert(candle1h.volume === 3000, 'Volume must sum to 60 * 50 = 3000');
        assert(candle1h.sourceObservationCount === 60, 'Source count must be exactly 60');
        assert(candle1h.completeness === 'COMPLETE', 'Completeness must be COMPLETE');
    });

    // 3. No Premature Completion & Strict Half-Open Boundaries
    runTest('3. No Premature Completion & Strict Half-Open Boundaries', () => {
        let state = createInitialMTFState();
        const baseTime = Date.UTC(2026, 9, 15, 10, 0, 0);

        for (let i = 0; i < 14; i++) {
            const res = stepMTFAggregation(makeCandle(baseTime + i * 60_000), true, state, MTF_CONFIG_A);
            assert(res.completed15m === null, `Candle must not complete at index ${i}`);
            state = res.nextState;
        }

        // At 10:14 (final minute of window), window is still accumulating
        const res14 = stepMTFAggregation(makeCandle(baseTime + 14 * 60_000), true, state, MTF_CONFIG_A);
        assert(res14.completed15m === null, '15m candle must not complete at 10:14');
        state = res14.nextState;

        // At 10:15 (exclusive close boundary), window completes
        const res15 = stepMTFAggregation(makeCandle(baseTime + 15 * 60_000), true, state, MTF_CONFIG_A);
        assert(res15.completed15m !== null, '15m candle must complete at 10:15');
    });

    // 4. Incomplete Window Rejection on Missing Interval (14/15 bars)
    runTest('4. Incomplete Window Rejection on Missing Interval (14/15 bars)', () => {
        let state = createInitialMTFState();
        const baseTime = Date.UTC(2026, 9, 15, 10, 0, 0);

        // Feed 14 candles, skipping index 8 (10:08)
        for (let i = 0; i < 15; i++) {
            if (i === 8) continue;
            state = stepMTFAggregation(makeCandle(baseTime + i * 60_000), true, state, MTF_CONFIG_A).nextState;
        }

        const res = stepMTFAggregation(makeCandle(baseTime + 15 * 60_000), true, state, MTF_CONFIG_A);

        assert(res.completed15m === null, 'Incomplete 14-bar window must NOT emit MTFCandle');
        assert(res.diagnostic15m !== null, 'Must emit HTFIncompleteDiagnostic');
        assert(res.diagnostic15m!.completeness === 'INCOMPLETE_MISSING', 'Completeness must be INCOMPLETE_MISSING');
        assert(res.diagnostic15m!.actualSourceCount === 14, 'Actual source count must be 14');
        assert(res.diagnostic15m!.missingTimestamps.includes(baseTime + 8 * 60_000), 'Missing list must contain 10:08');
        assert(res.nextState.state15m.aggregation.lastCompletedCandle === null, 'REJECT_AND_RESET: lastCompletedCandle must be null');
    });

    // 5. Incomplete Window Rejection on Missing Interval (59/60 bars)
    runTest('5. Incomplete Window Rejection on Missing Interval (59/60 bars)', () => {
        let state = createInitialMTFState();
        const baseTime = Date.UTC(2026, 9, 15, 10, 0, 0);

        // Feed 59 candles, skipping index 30 (10:30)
        for (let i = 0; i < 60; i++) {
            if (i === 30) continue;
            state = stepMTFAggregation(makeCandle(baseTime + i * 60_000), true, state, MTF_CONFIG_A).nextState;
        }

        const res = stepMTFAggregation(makeCandle(baseTime + 3_600_000), true, state, MTF_CONFIG_A);

        assert(res.completed1h === null, 'Incomplete 59-bar window must NOT emit MTFCandle');
        assert(res.diagnostic1h !== null, 'Must emit 1h diagnostic');
        assert(res.diagnostic1h!.completeness === 'INCOMPLETE_MISSING', 'Must be INCOMPLETE_MISSING');
        assert(res.diagnostic1h!.missingTimestamps.includes(baseTime + 30 * 60_000), 'Missing list must contain 10:30');
    });

    // 6. Duplicate Timestamp Rejection & Volume Preservation
    runTest('6. Duplicate Timestamp Rejection & Volume Preservation', () => {
        let state = createInitialMTFState();
        const baseTime = Date.UTC(2026, 9, 15, 10, 0, 0);

        // Feed candles with a duplicate at index 5
        for (let i = 0; i < 15; i++) {
            state = stepMTFAggregation(makeCandle(baseTime + i * 60_000, 100, 105, 95, 102, 10), true, state, MTF_CONFIG_A).nextState;
            if (i === 5) {
                // Send duplicate timestamp
                state = stepMTFAggregation(makeCandle(baseTime + i * 60_000, 100, 105, 95, 102, 10), true, state, MTF_CONFIG_A).nextState;
            }
        }

        assert(state.state15m.aggregation.duplicateCount === 1, 'Duplicate count must be 1');
        assert(state.state15m.aggregation.runningVolume === 150, 'Duplicate candle volume must NOT be accumulated');

        const res = stepMTFAggregation(makeCandle(baseTime + 15 * 60_000), true, state, MTF_CONFIG_A);
        assert(res.completed15m === null, 'Window with duplicate must be rejected');
        assert(res.diagnostic15m!.completeness === 'INCOMPLETE_DUPLICATE', 'Completeness must be INCOMPLETE_DUPLICATE');
    });

    // 7. Invalid Source Candle Rejection (isSourceValid === false)
    runTest('7. Invalid Source Candle Rejection (isSourceValid === false)', () => {
        let state = createInitialMTFState();
        const baseTime = Date.UTC(2026, 9, 15, 10, 0, 0);

        for (let i = 0; i < 15; i++) {
            if (i === 7) {
                // Candle failed Milestone 2 validation
                state = stepMTFAggregation(makeCandle(baseTime + i * 60_000, 100, NaN, 95, 102, 10), false, state, MTF_CONFIG_A).nextState;
            } else {
                state = stepMTFAggregation(makeCandle(baseTime + i * 60_000, 100, 105, 95, 102, 10), true, state, MTF_CONFIG_A).nextState;
            }
        }

        assert(state.state15m.aggregation.invalidSourceCount === 1, 'Invalid source count must be 1');
        assert(Number.isFinite(state.state15m.aggregation.runningHigh!), 'Running high must NOT be corrupted by NaN');

        const res = stepMTFAggregation(makeCandle(baseTime + 15 * 60_000), true, state, MTF_CONFIG_A);
        assert(res.completed15m === null, 'Window with invalid source candle must be rejected');
        assert(res.diagnostic15m!.completeness === 'INCOMPLETE_INVALID', 'Completeness must be INCOMPLETE_INVALID');
    });

    // 8. REJECT_AND_RESET Recovery at Next UTC Boundary
    runTest('8. REJECT_AND_RESET Recovery at Next UTC Boundary', () => {
        let state = createInitialMTFState();
        const baseTime = Date.UTC(2026, 9, 15, 10, 0, 0);

        // Window 1 (10:00–10:15): missing candle index 3
        for (let i = 0; i < 15; i++) {
            if (i === 3) continue;
            state = stepMTFAggregation(makeCandle(baseTime + i * 60_000), true, state, MTF_CONFIG_A).nextState;
        }

        // 10:15 boundary closes Window 1 with rejection
        const res15 = stepMTFAggregation(makeCandle(baseTime + 15 * 60_000), true, state, MTF_CONFIG_A);
        assert(res15.completed15m === null, 'Window 1 must fail');
        assert(res15.diagnostic15m !== null, 'Window 1 diagnostic must be emitted');
        state = res15.nextState;

        // Window 2 (10:15–10:30): feed all 15 continuous valid candles (10:15 to 10:29)
        for (let i = 16; i < 30; i++) {
            state = stepMTFAggregation(makeCandle(baseTime + i * 60_000), true, state, MTF_CONFIG_A).nextState;
        }

        // 10:30 boundary closes Window 2 cleanly
        const res30 = stepMTFAggregation(makeCandle(baseTime + 30 * 60_000), true, state, MTF_CONFIG_A);
        assert(res30.completed15m !== null, 'Window 2 must complete successfully after recovery');
        assert(res30.completed15m!.openTimestamp === baseTime + 15 * 60_000, 'Window 2 open must be 10:15');
        assert(res30.completed15m!.closeTimestamp === baseTime + 30 * 60_000, 'Window 2 close must be 10:30');
        assert(res30.completed15m!.completeness === 'COMPLETE', 'Window 2 must be COMPLETE');
    });

    // 9. Independent Timeframe Recovery (15m Failure Isolated from 1h)
    runTest('9. Independent Timeframe Recovery (15m Failure Isolated from 1h)', () => {
        let state = createInitialMTFState();
        const baseTime = Date.UTC(2026, 9, 15, 10, 0, 0);

        // In Window 1 (10:00–10:15), drop candle at 10:05
        for (let i = 0; i < 15; i++) {
            if (i === 5) continue;
            state = stepMTFAggregation(makeCandle(baseTime + i * 60_000), true, state, MTF_CONFIG_A).nextState;
        }

        // At 10:15, 15m fails and resets its aggregation state
        const res15 = stepMTFAggregation(makeCandle(baseTime + 15 * 60_000), true, state, MTF_CONFIG_A);
        assert(res15.completed15m === null, '15m must fail');
        assert(res15.diagnostic15m !== null, '15m diagnostic emitted');

        // Verify 1h aggregation state was NOT reset by 15m failure
        assert(res15.nextState.state1h.aggregation.actualSourceCount === 15, '1h source count must be 15');
        assert(res15.nextState.state1h.aggregation.currentWindowOpen === baseTime, '1h window open remains 10:00');
        assert(res15.nextState.state1h.aggregation.lastDiagnostic === null, '1h must not receive 15m diagnostic');
    });

    // 10. Batch Wrapper vs Direct Streaming Equivalence
    runTest('10. Batch Wrapper vs Direct Streaming Equivalence', () => {
        const baseTime = Date.UTC(2026, 9, 15, 10, 0, 0);
        const candleBatch: { candle: ML1Candle; isSourceValid: boolean }[] = [];

        // 120 candles (8 x 15m windows, 2 x 1h windows), with a planned gap at 10:35
        for (let i = 0; i < 125; i++) {
            if (i === 35) continue; // Gap
            candleBatch.push({
                candle: makeCandle(baseTime + i * 60_000, 100 + (i % 5), 110 + (i % 5), 90, 105, 20),
                isSourceValid: true
            });
        }

        // A. Batch Execution
        const batchRes = processMTFAggregationBatch(candleBatch, MTF_CONFIG_A);

        // B. Streaming Execution (One-by-one)
        let streamingState = createInitialMTFState();
        const streaming15m: any[] = [];
        const streaming1h: any[] = [];
        const streamingDiag15m: any[] = [];
        const streamingDiag1h: any[] = [];

        for (const item of candleBatch) {
            const res = stepMTFAggregation(item.candle, item.isSourceValid, streamingState, MTF_CONFIG_A);
            streamingState = res.nextState;
            if (res.completed15m) streaming15m.push(res.completed15m);
            if (res.completed1h) streaming1h.push(res.completed1h);
            streamingDiag15m.push(...res.diagnostics15m);
            streamingDiag1h.push(...res.diagnostics1h);
        }

        assert(
            JSON.stringify(batchRes.completed15mCandles) === JSON.stringify(streaming15m),
            '15m completed candles diverged between batch and streaming'
        );
        assert(
            JSON.stringify(batchRes.completed1hCandles) === JSON.stringify(streaming1h),
            '1h completed candles diverged between batch and streaming'
        );
        assert(
            JSON.stringify(batchRes.diagnostics15m) === JSON.stringify(streamingDiag15m),
            '15m diagnostics diverged between batch and streaming'
        );
        assert(
            JSON.stringify(batchRes.diagnostics1h) === JSON.stringify(streamingDiag1h),
            '1h diagnostics diverged between batch and streaming'
        );
        assert(
            JSON.stringify(batchRes.finalState) === JSON.stringify(streamingState),
            'Final state diverged between batch and streaming'
        );
    });

    // 11. State and Source Snapshot Immutability
    runTest('11. State and Source Snapshot Immutability', () => {
        const state = createInitialMTFState();
        const c = makeCandle(Date.UTC(2026, 9, 15, 10, 0, 0));

        const snapshot = JSON.stringify(state);
        const res = stepMTFAggregation(c, true, state, MTF_CONFIG_A);

        c.open = 9999;
        c.high = 8888;
        c.low = 7777;
        c.close = 6666;
        c.volume = 5555;

        assert(JSON.stringify(state) === snapshot, 'Original state mutated in-place');
        assert(Object.isFrozen(res.nextState), 'Next state must be frozen');
        assert(Object.isFrozen(res.nextState.state15m.aggregation), 'Next 15m aggregation must be frozen');
        assert(Object.isFrozen(res.nextState.state1h.aggregation), 'Next 1h aggregation must be frozen');
        const storedCandle = res.nextState.state15m.aggregation.sourceCandles[0];
        assert(storedCandle.open === 100, 'Stored source open mutated');
        assert(storedCandle.high === 105, 'Stored source high mutated');
        assert(storedCandle.low === 95, 'Stored source low mutated');
        assert(storedCandle.close === 102, 'Stored source close mutated');
        assert(storedCandle.volume === 10, 'Stored source volume mutated');
        assert(Object.isFrozen(storedCandle), 'Stored source candle must be frozen');
    });

    // 12. Cross-Window Chronology Rejection and Unified 1m Monotonicity
    runTest('12. Cross-Window Chronology Rejection and Unified 1m Monotonicity', () => {
        let state = createInitialMTFState();
        const baseTime = Date.UTC(2026, 9, 15, 10, 0, 0);

        for (let i = 0; i < 5; i++) {
            state = stepMTFAggregation(makeCandle(baseTime + i * 60_000), true, state, MTF_CONFIG_A, i).nextState;
        }

        assert(state.last1mTimestamp === baseTime + 4 * 60_000, 'Unified timestamp must be at 10:04');
        assert(state.last1mBarIndex === 4, 'Unified bar index must be 4');

        const oldCandle = makeCandle(baseTime - 60_000, 50, 55, 45, 52, 10);
        const result = stepMTFAggregation(oldCandle, true, state, MTF_CONFIG_A, 999);
        const aggregation = result.nextState.state15m.aggregation;
        assert(aggregation.currentWindowOpen === baseTime, 'Active window must not be replaced by an older window');
        assert(aggregation.invalidSourceCount === 1, 'Out-of-order candle must be counted as invalid');
        assert(aggregation.runningOpen === 100, 'Out-of-order candle must not alter accumulated OHLC');
        assert(result.nextState.last1mTimestamp === state.last1mTimestamp, 'Out-of-order timestamp must not move unified clock backwards');
        assert(result.nextState.last1mBarIndex === state.last1mBarIndex, 'Out-of-order timestamp must not advance unified bar index');

        const duplicate = stepMTFAggregation(makeCandle(baseTime + 4 * 60_000), true, state, MTF_CONFIG_A, 888);
        assert(duplicate.nextState.last1mTimestamp === state.last1mTimestamp, 'Duplicate timestamp must not advance unified clock');
        assert(duplicate.nextState.last1mBarIndex === state.last1mBarIndex, 'Duplicate timestamp must not advance unified bar index');
    });

    // 13. Fully Skipped HTF Window Detection and Diagnostics
    runTest('13. Fully Skipped HTF Window Detection and Diagnostics', () => {
        let state = createInitialMTFState();
        const baseTime = Date.UTC(2026, 9, 15, 10, 0, 0);

        for (let i = 0; i < 15; i++) {
            state = stepMTFAggregation(makeCandle(baseTime + i * 60_000), true, state, MTF_CONFIG_A).nextState;
        }

        const result = stepMTFAggregation(
            makeCandle(baseTime + 30 * 60_000),
            true,
            state,
            MTF_CONFIG_A
        );
        assert(result.completed15m !== null, 'Completed 10:00 window must still be emitted');
        assert(result.completed15m.openTimestamp === baseTime, 'Completed window start mismatch');
        assert(result.diagnostic15m !== null, 'Skipped window must emit a diagnostic');
        assert(result.diagnostic15m.openTimestamp === baseTime + 15 * 60_000, 'Skipped window start mismatch');
        assert(result.diagnostic15m.closeTimestamp === baseTime + 30 * 60_000, 'Skipped window close mismatch');
        assert(result.diagnostic15m.actualSourceCount === 0, 'Skipped window must have no observations');
        assert(
            result.diagnostic15m.completeness === 'INCOMPLETE_MISSING',
            'Skipped window must be classified as missing'
        );
        assert(
            result.nextState.state15m.aggregation.lastCompletedCandle === null,
            'Skipped window must reset HTF context eligibility'
        );
    });

    // 14. Unified State Bar-Index Preservation
    runTest('14. Unified State Bar-Index Preservation', () => {
        const initialState = Object.freeze({
            ...createInitialMTFState(),
            last1mBarIndex: 42
        });
        const result = stepMTFAggregation(
            makeCandle(Date.UTC(2026, 9, 15, 10, 0, 0)),
            true,
            initialState,
            MTF_CONFIG_A
        );
        assert(result.nextState.last1mBarIndex === 42, 'Existing bar index must be preserved when omitted');
    });

    // 15. Invalid-First-Candle Chronology Protection
    runTest('15. Invalid-First-Candle Chronology Protection', () => {
        let state = createInitialMTFState();
        const invalid1015 = makeCandle(baseTime + 15 * 60_000, 100, NaN, 95, 100, 10);
        state = stepMTFAggregation(invalid1015, false, state, MTF_CONFIG_A).nextState;

        assert(state.state15m.aggregation.currentWindowOpen === baseTime + 15 * 60_000, 'Window open must be 10:15');
        assert(state.state15m.aggregation.invalidSourceCount === 1, 'Invalid count must be 1');
        assert(
            state.state15m.aggregation.lastObservedSourceTimestamp === baseTime + 15 * 60_000,
            'Observed timestamp must advance to 10:15'
        );

        const olderCandle = makeCandle(baseTime + 14 * 60_000);
        const result = stepMTFAggregation(olderCandle, true, state, MTF_CONFIG_A);
        assert(
            result.nextState.state15m.aggregation.currentWindowOpen === baseTime + 15 * 60_000,
            'Active 10:15 window must not be replaced'
        );
        assert(result.nextState.state15m.aggregation.invalidSourceCount === 2, 'Older candle must be rejected');
    });

    // 16. Invalid-Middle-Candle Chronology Protection
    runTest('16. Invalid-Middle-Candle Chronology Protection', () => {
        let state = createInitialMTFState();
        state = stepMTFAggregation(makeCandle(baseTime), true, state, MTF_CONFIG_A).nextState;
        state = stepMTFAggregation(makeCandle(baseTime + 5 * 60_000), false, state, MTF_CONFIG_A).nextState;
        assert(
            state.state15m.aggregation.lastObservedSourceTimestamp === baseTime + 5 * 60_000,
            'Observed timestamp must advance to 10:05'
        );

        const result = stepMTFAggregation(makeCandle(baseTime + 3 * 60_000), true, state, MTF_CONFIG_A);
        assert(result.nextState.state15m.aggregation.invalidSourceCount === 2, 'Older 10:03 must be rejected');
        assert(result.nextState.state15m.aggregation.actualSourceCount === 1, '10:03 must not be accepted');
    });

    // 17. Duplicate After Intervening Observation Classification
    runTest('17. Duplicate After Intervening Observation Classification', () => {
        let state = createInitialMTFState();
        state = stepMTFAggregation(makeCandle(baseTime), true, state, MTF_CONFIG_A).nextState;
        state = stepMTFAggregation(makeCandle(baseTime + 5 * 60_000), false, state, MTF_CONFIG_A).nextState;
        state = stepMTFAggregation(makeCandle(baseTime + 6 * 60_000), true, state, MTF_CONFIG_A).nextState;

        const result = stepMTFAggregation(makeCandle(baseTime + 5 * 60_000), true, state, MTF_CONFIG_A);
        assert(
            result.nextState.state15m.aggregation.duplicateCount === 1,
            'Repeat of invalid 10:05 must be a duplicate despite intervening 10:06'
        );
        assert(
            result.nextState.state15m.aggregation.invalidSourceCount === 1,
            'Invalid count must remain 1 from the original 10:05'
        );
    });

    // 18. Multiple Skipped 15m Windows
    runTest('18. Multiple Skipped 15m Windows', () => {
        let state = createInitialMTFState();
        for (let i = 0; i < 15; i++) {
            state = stepMTFAggregation(makeCandle(baseTime + i * 60_000), true, state, MTF_CONFIG_A).nextState;
        }

        const result = stepMTFAggregation(
            makeCandle(baseTime + 45 * 60_000),
            true,
            state,
            MTF_CONFIG_A
        );
        assert(result.diagnostics15m.length === 2, 'Expected two skipped 15m window diagnostics');
        assert(
            result.diagnostics15m[0].openTimestamp === baseTime + 15 * 60_000 &&
                result.diagnostics15m[0].closeTimestamp === baseTime + 30 * 60_000,
            'First skipped window must be 10:15–10:30'
        );
        assert(
            result.diagnostics15m[1].openTimestamp === baseTime + 30 * 60_000 &&
                result.diagnostics15m[1].closeTimestamp === baseTime + 45 * 60_000,
            'Second skipped window must be 10:30–10:45'
        );
        assert(
            result.nextState.state15m.aggregation.lastCompletedCandle === null,
            'Context must reset after multiple skipped windows'
        );
    });

    // 19. Multiple Skipped 1h Windows and Context Invalidation
    runTest('19. Multiple Skipped 1h Windows and Context Invalidation', () => {
        let state = createInitialMTFState();
        for (let i = 0; i < 60; i++) {
            state = stepMTFAggregation(makeCandle(baseTime + i * 60_000), true, state, MTF_CONFIG_A).nextState;
        }

        const result = stepMTFAggregation(
            makeCandle(baseTime + 3 * 3_600_000),
            true,
            state,
            MTF_CONFIG_A
        );
        assert(result.completed1h !== null, '10:00–11:00 window must complete');
        assert(result.diagnostics1h.length === 2, 'Expected two skipped 1h window diagnostics');
        assert(result.diagnostics1h[0].openTimestamp === baseTime + 3_600_000, 'First skipped window is 11:00–12:00');
        assert(result.diagnostics1h[1].openTimestamp === baseTime + 2 * 3_600_000, 'Second skipped window is 12:00–13:00');
        assert(
            result.nextState.state1h.aggregation.lastCompletedCandle === null,
            '1h context must be reset after skipped intervals'
        );
    });

    // 20. Incomplete Active Window Plus Skipped Windows
    runTest('20. Incomplete Active Window Plus Skipped Windows', () => {
        let state = createInitialMTFState();
        for (let i = 0; i < 15; i++) {
            if (i === 8) continue;
            state = stepMTFAggregation(makeCandle(baseTime + i * 60_000), true, state, MTF_CONFIG_A).nextState;
        }

        const result = stepMTFAggregation(
            makeCandle(baseTime + 45 * 60_000),
            true,
            state,
            MTF_CONFIG_A
        );
        assert(result.diagnostics15m.length === 3, 'Expected active incomplete plus two skipped diagnostics');
        assert(result.diagnostics15m[0].openTimestamp === baseTime, 'First diagnostic must be active window');
        assert(result.diagnostics15m[0].actualSourceCount === 14, 'Active window must have 14 observations');
        assert(result.diagnostics15m[1].openTimestamp === baseTime + 15 * 60_000, 'Second diagnostic must be 10:15');
        assert(result.diagnostics15m[2].openTimestamp === baseTime + 30 * 60_000, 'Third diagnostic must be 10:30');
    });

    // 21. Recovery After Multi-Window Gap
    runTest('21. Recovery After Multi-Window Gap', () => {
        let state = createInitialMTFState();
        for (let i = 0; i < 15; i++) {
            state = stepMTFAggregation(makeCandle(baseTime + i * 60_000), true, state, MTF_CONFIG_A).nextState;
        }

        state = stepMTFAggregation(
            makeCandle(baseTime + 45 * 60_000),
            true,
            state,
            MTF_CONFIG_A
        ).nextState;
        assert(state.state15m.aggregation.lastCompletedCandle === null, 'Context must reset after gap');

        for (let i = 46; i < 60; i++) {
            state = stepMTFAggregation(makeCandle(baseTime + i * 60_000), true, state, MTF_CONFIG_A).nextState;
        }

        const recovered = stepMTFAggregation(
            makeCandle(baseTime + 60 * 60_000),
            true,
            state,
            MTF_CONFIG_A
        );
        assert(recovered.completed15m !== null, '10:45–11:00 must complete after recovery');
        assert(recovered.completed15m.openTimestamp === baseTime + 45 * 60_000, 'Recovered window must open at 10:45');
        assert(recovered.completed15m.closeTimestamp === baseTime + 60 * 60_000, 'Recovered window must close at 11:00');
        assert(recovered.completed15m.completeness === 'COMPLETE', 'Recovered window must be complete');
    });

    // 22. Forward Timestamp with Regressing Bar Index
    runTest('22. Forward Timestamp with Regressing Bar Index', () => {
        let state = createInitialMTFState();
        state = stepMTFAggregation(makeCandle(baseTime), true, state, MTF_CONFIG_A, 100).nextState;
        assert(state.last1mBarIndex === 100, 'Bar index must be 100');
        assert(state.last1mTimestamp === baseTime, 'Timestamp must be 10:00');

        state = stepMTFAggregation(
            makeCandle(baseTime + 60_000),
            true,
            state,
            MTF_CONFIG_A,
            101
        ).nextState;
        assert(state.last1mBarIndex === 101, 'Bar index must be 101');
        assert(state.last1mTimestamp === baseTime + 60_000, 'Timestamp must be 10:01');

        const result = stepMTFAggregation(
            makeCandle(baseTime + 120_000),
            true,
            state,
            MTF_CONFIG_A,
            99
        );
        assert(result.nextState.last1mTimestamp === baseTime + 120_000, 'Unified timestamp should record 10:02');
        assert(result.nextState.last1mBarIndex === 101, 'Unified bar index must remain 101 on regression');
        assert(result.nextState.state15m.aggregation.invalidSourceCount === 1, '15m must reject regressed-index candle');
        assert(result.nextState.state1h.aggregation.invalidSourceCount === 1, '1h must reject regressed-index candle');
        assert(result.nextState.state15m.aggregation.actualSourceCount === 2, '15m count must remain 2');
        assert(result.nextState.state1h.aggregation.actualSourceCount === 2, '1h count must remain 2');
    });

    // 23. Forward Timestamp with Valid Increasing Bar Index
    runTest('23. Forward Timestamp with Valid Increasing Bar Index', () => {
        let state = createInitialMTFState();
        state = stepMTFAggregation(makeCandle(baseTime), true, state, MTF_CONFIG_A, 100).nextState;
        state = stepMTFAggregation(
            makeCandle(baseTime + 60_000),
            true,
            state,
            MTF_CONFIG_A,
            101
        ).nextState;

        const result = stepMTFAggregation(
            makeCandle(baseTime + 120_000),
            true,
            state,
            MTF_CONFIG_A,
            102
        );
        assert(result.nextState.last1mTimestamp === baseTime + 120_000, 'Timestamp must advance to 10:02');
        assert(result.nextState.last1mBarIndex === 102, 'Bar index must advance to 102');
        assert(result.nextState.state15m.aggregation.invalidSourceCount === 0, '15m has no invalid sources');
        assert(result.nextState.state1h.aggregation.invalidSourceCount === 0, '1h has no invalid sources');
        assert(result.nextState.state15m.aggregation.actualSourceCount === 3, '15m source count must be 3');
        assert(result.nextState.state1h.aggregation.actualSourceCount === 3, '1h source count must be 3');
    });

    // 24. Forward Timestamp with Equal Bar Index
    runTest('24. Forward Timestamp with Equal Bar Index', () => {
        let state = createInitialMTFState();
        state = stepMTFAggregation(makeCandle(baseTime), true, state, MTF_CONFIG_A, 100).nextState;
        state = stepMTFAggregation(
            makeCandle(baseTime + 60_000),
            true,
            state,
            MTF_CONFIG_A,
            101
        ).nextState;
        assert(state.last1mBarIndex === 101, 'Bar index must be 101');
        assert(state.last1mTimestamp === baseTime + 60_000, 'Timestamp must be 10:01');

        const result = stepMTFAggregation(
            makeCandle(baseTime + 120_000),
            true,
            state,
            MTF_CONFIG_A,
            101
        );
        assert(result.nextState.last1mTimestamp === baseTime + 120_000, 'Timestamp should advance to 10:02');
        assert(result.nextState.last1mBarIndex === 101, 'Bar index must remain 101 on equal index');
        assert(result.nextState.state15m.aggregation.invalidSourceCount === 1, '15m must reject equal index');
        assert(result.nextState.state1h.aggregation.invalidSourceCount === 1, '1h must reject equal index');
        assert(result.nextState.state15m.aggregation.actualSourceCount === 2, '15m source count must remain 2');
        assert(result.nextState.state1h.aggregation.actualSourceCount === 2, '1h source count must remain 2');
    });

    console.log(`\n=======================================`);
    console.log(`📊 ML-R1 PHASE 3B COMPLETE ACCEPTANCE AUDIT:`);
    console.log(`   ↳ Tests Executed:  ${passed + failed}`);
    console.log(`   ↳ Tests Passed:    ${passed}`);
    console.log(`   ↳ Tests Failed:    ${failed}`);
    console.log(`=======================================\n`);

    if (failed === 0 && passed === 24) {
        console.log('✅ ALL 24 PHASE 3B AGGREGATION CRITERIA RIGOROUSLY MET.');
        console.log('🔒 Phase 3B Aggregation Engine FULLY FROZEN.');
        return true;
    } else {
        console.error('❌ PHASE 3B TESTS FAILED. DO NOT PROCEED TO PHASE 3C.');
        return false;
    }
}