import { alignMTFContext, alignTimeframeContext } from '../indicators/mlr1/mtf/MTFAligner';
import { MTF_CONFIG_A, validateMTFConfig } from '../indicators/mlr1/mtf/MTFConfig';
import { createInitialMTFState } from '../indicators/mlr1/mtf/MTFState';
import { stepMTFCombined } from '../indicators/mlr1/mtf/MTFFeatureEngine';
import type { MTFContext, MTFCandle } from '../indicators/mlr1/mtf/MTFTypes';
import type { ML1Candle } from '../indicators/mlr1/ML1FeatureTypes';

function assert(condition: boolean, message: string): asserts condition {
    if (!condition) throw new Error(`[AssertionFailed] ${message}`);
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function makeCandle(time: number, open = 100, high = 105, low = 95, close = 102, volume = 10): ML1Candle {
    return { time, open, high, low, close, volume };
}

export function runPhase3DTests(): boolean {
    console.log('\n======================================================');
    console.log('Starting Milestone 3 Phase 3D Acceptance Suite (Causal Alignment)');
    console.log('======================================================\n');
    let passed = 0;
    let failed = 0;

    const runTest = (name: string, testFn: () => void) => {
        try {
            testFn();
            passed++;
            console.log(`  Passed: ${name}`);
        } catch (error) {
            failed++;
            console.error(`  Failed: ${name} - ${errorMessage(error)}`);
        }
    };

    const baseTime = Date.UTC(2026, 9, 15, 10, 0, 0);

    runTest('1. Exclusive-close availability', () => {
        let state = createInitialMTFState();
        for (let i = 0; i < 15; i++) {
            state = stepMTFCombined(makeCandle(baseTime + i * 60_000), true, state, MTF_CONFIG_A).nextState;
        }

        const aligned = alignMTFContext(baseTime + 14 * 60_000, 'SOLUSDT', state, MTF_CONFIG_A);
        assert(!aligned.context15m.isAvailable, '10:14 must not consume the 10:00-10:15 candle');
        assert(aligned.context15m.availabilityStatus === 'UNAVAILABLE', 'Status must be UNAVAILABLE at 10:14');
        assert(aligned.context15m.lastCompletedCandle === null, 'No candle may be exposed before its close boundary');
    });

    runTest('2. Exact-boundary availability and context age', () => {
        let state = createInitialMTFState();
        for (let i = 0; i < 16; i++) {
            state = stepMTFCombined(makeCandle(baseTime + i * 60_000), true, state, MTF_CONFIG_A).nextState;
        }

        const aligned1015 = alignMTFContext(baseTime + 15 * 60_000, 'SOLUSDT', state, MTF_CONFIG_A);
        assert(aligned1015.context15m.isAvailable, '10:15 must consume the completed 10:00-10:15 candle');
        assert(aligned1015.context15m.lastCompletedCloseTimestamp === baseTime + 900_000, 'Close timestamp must be 10:15');
        assert(aligned1015.context15m.contextAgeMs === 0, 'Context age must be 0ms at the close boundary');

        const aligned1016 = alignMTFContext(baseTime + 16 * 60_000, 'SOLUSDT', state, MTF_CONFIG_A);
        assert(aligned1016.context15m.contextAgeMs === 60_000, 'Context age must be 60,000ms at 10:16');
    });

    runTest('3. 1h exclusive-close and exact-boundary availability', () => {
        let state = createInitialMTFState();
        for (let i = 0; i < 60; i++) {
            state = stepMTFCombined(makeCandle(baseTime + i * 60_000), true, state, MTF_CONFIG_A).nextState;
        }

        const aligned1059 = alignMTFContext(baseTime + 59 * 60_000, 'SOLUSDT', state, MTF_CONFIG_A);
        assert(!aligned1059.context1h.isAvailable, 'The 10:00-11:00 1h candle must not be available at 10:59');

        state = stepMTFCombined(makeCandle(baseTime + 3_600_000), true, state, MTF_CONFIG_A).nextState;
        const aligned1100 = alignMTFContext(baseTime + 3_600_000, 'SOLUSDT', state, MTF_CONFIG_A);
        assert(aligned1100.context1h.isAvailable, 'The 1h candle must be available at 11:00');
        assert(aligned1100.context1h.contextAgeMs === 0, '1h context age must be 0ms at 11:00');
    });

    runTest('4. Independent timeframe availability', () => {
        let state = createInitialMTFState();
        for (let i = 0; i <= 15; i++) {
            state = stepMTFCombined(makeCandle(baseTime + i * 60_000), true, state, MTF_CONFIG_A).nextState;
        }

        const aligned = alignMTFContext(baseTime + 15 * 60_000, 'SOLUSDT', state, MTF_CONFIG_A);
        assert(aligned.context15m.isAvailable, '15m context must be available');
        assert(!aligned.context1h.isAvailable, '1h context must remain unavailable');
        assert(aligned.context1h.availabilityStatus === 'UNAVAILABLE', '1h status must be UNAVAILABLE');
    });

    runTest('5. Staleness gating', () => {
        const staleConfig = validateMTFConfig({
            symbol: 'SOLUSDT',
            baseTimeframe: '1m',
            config15m: { ...MTF_CONFIG_A.config15m, maxStalenessMs: 300_000 },
            config1h: { ...MTF_CONFIG_A.config1h, maxStalenessMs: 7_200_000 }
        });

        let state = createInitialMTFState();
        for (let i = 0; i <= 15; i++) {
            state = stepMTFCombined(makeCandle(baseTime + i * 60_000), true, state, staleConfig).nextState;
        }

        const freshAligned = alignMTFContext(baseTime + 15 * 60_000, 'SOLUSDT', state, staleConfig);
        assert(freshAligned.context15m.isAvailable, 'Context must be available at 10:15');

        const staleAligned = alignMTFContext(baseTime + 21 * 60_000, 'SOLUSDT', state, staleConfig);
        assert(!staleAligned.context15m.isAvailable, 'Stale context must not be available');
        assert(staleAligned.context15m.availabilityStatus === 'STALE', 'Status must be STALE');
        assert(staleAligned.context15m.contextAgeMs === 360_000, 'Stale age must remain 360,000ms');
        assert(staleAligned.context15m.lastCompletedCandle !== null, 'Completed candle must remain for diagnostics');
    });

    runTest('6. Feature validity is independent of context availability', () => {
        let state = createInitialMTFState();
        for (let i = 0; i <= 75; i++) {
            state = stepMTFCombined(makeCandle(baseTime + i * 60_000), true, state, MTF_CONFIG_A).nextState;
        }

        const aligned = alignMTFContext(baseTime + 75 * 60_000, 'SOLUSDT', state, MTF_CONFIG_A);
        assert(aligned.context15m.isAvailable, '15m context must be available');
        assert(aligned.context15m.validity['CandleRange'] === true, 'CandleRange must be valid');
        assert(aligned.context15m.validity['ATR_14'] === false, 'ATR_14 must remain invalid during warm-up');
    });

    runTest('7. Gap invalidation clears exposed features', () => {
        let state = createInitialMTFState();
        for (let i = 0; i <= 15; i++) {
            state = stepMTFCombined(makeCandle(baseTime + i * 60_000), true, state, MTF_CONFIG_A).nextState;
        }

        state = stepMTFCombined(makeCandle(baseTime + 45 * 60_000), true, state, MTF_CONFIG_A).nextState;
        const aligned = alignMTFContext(baseTime + 45 * 60_000, 'SOLUSDT', state, MTF_CONFIG_A);
        assert(!aligned.context15m.isAvailable, 'Reset 15m context must be unavailable');
        assert(aligned.context15m.availabilityStatus === 'UNAVAILABLE', 'Reset status must be UNAVAILABLE');
        assert(Object.keys(aligned.context15m.features).length === 0, 'No features may be exposed after reset');
    });

    runTest('8. Strict future-leakage guard', () => {
        const initialState = createInitialMTFState();
        const mockCandle: MTFCandle = Object.freeze({
            timeframe: '15m',
            openTimestamp: baseTime,
            closeTimestamp: baseTime + 900_000,
            open: 100,
            high: 105,
            low: 95,
            close: 102,
            volume: 1000,
            sourceObservationCount: 15,
            completeness: 'COMPLETE'
        });
        const mockState = Object.freeze({
            ...initialState.state15m,
            aggregation: Object.freeze({
                ...initialState.state15m.aggregation,
                lastCompletedCandle: mockCandle
            }),
            latestFeatures: Object.freeze({ CandleRange: 10 }),
            latestValidity: Object.freeze({ CandleRange: true })
        });

        for (const timestamp of [baseTime, baseTime + 60_000, baseTime + 899_999]) {
            const context = alignTimeframeContext(timestamp, mockState, MTF_CONFIG_A.config15m);
            assert(!context.isAvailable, `Observation at ${timestamp} must not consume a future candle`);
            assert(context.lastCompletedCandle === null, `No candle may be exposed at ${timestamp}`);
        }
    });

    runTest('9. Deterministic streaming alignment parity', () => {
        let stateA = createInitialMTFState();
        let stateB = createInitialMTFState();
        const observationsA: MTFContext[] = [];
        const observationsB: MTFContext[] = [];

        for (let i = 0; i <= 30; i++) {
            const candle = makeCandle(baseTime + i * 60_000);
            stateA = stepMTFCombined(candle, true, stateA, MTF_CONFIG_A).nextState;
            observationsA.push(alignMTFContext(candle.time, 'SOLUSDT', stateA, MTF_CONFIG_A));

            stateB = stepMTFCombined(candle, true, stateB, MTF_CONFIG_A).nextState;
            observationsB.push(alignMTFContext(candle.time, 'SOLUSDT', stateB, MTF_CONFIG_A));
        }

        assert(JSON.stringify(observationsA) === JSON.stringify(observationsB), 'Streaming alignment output diverged');
    });

    runTest('10. Observation timestamp validation', () => {
        const state = createInitialMTFState();
        for (const timestamp of [Number.NaN, -100]) {
            try {
                alignMTFContext(timestamp, 'SOLUSDT', state, MTF_CONFIG_A);
                assert(false, `Accepted invalid timestamp ${timestamp}`);
            } catch (error) {
                assert(errorMessage(error).includes('Invalid observation timestamp'), errorMessage(error));
            }
        }
    });

    console.log('\n=======================================');
    console.log('ML-R1 PHASE 3D ACCEPTANCE AUDIT:');
    console.log(`   Tests Executed:  ${passed + failed}`);
    console.log(`   Tests Passed:    ${passed}`);
    console.log(`   Tests Failed:    ${failed}`);
    console.log('=======================================\n');

    if (failed === 0 && passed === 10) {
        console.log('All 10 Phase 3D causal alignment criteria passed.');
        return true;
    }

    console.error('Phase 3D acceptance tests failed.');
    return false;
}
