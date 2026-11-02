import { alignMTFContext, alignTimeframeContext } from '../indicators/mlr1/mtf/MTFAligner';
import { MTF_CONFIG_A, validateMTFConfig } from '../indicators/mlr1/mtf/MTFConfig';
import { createInitialMTFState } from '../indicators/mlr1/mtf/MTFState';
import { stepMTFCombined } from '../indicators/mlr1/mtf/MTFFeatureEngine';
import type { MTFContext, MTFCandle, MTFState, MTFTimeframeState } from '../indicators/mlr1/mtf/MTFTypes';
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

    runTest('6. Feature validity is independent before warm-up completion', () => {
        let state = createInitialMTFState();
        for (let i = 0; i <= 15; i++) {
            state = stepMTFCombined(makeCandle(baseTime + i * 60_000), true, state, MTF_CONFIG_A).nextState;
        }

        const aligned = alignMTFContext(baseTime + 15 * 60_000, 'SOLUSDT', state, MTF_CONFIG_A);
        assert(aligned.context15m.isAvailable, '15m context must be available while warming up');
        assert(!aligned.context15m.isWarmupComplete, 'Warm-up must be incomplete after the first HTF candle');
        assert(aligned.context15m.availabilityStatus === 'WARMING_UP', 'Status must be WARMING_UP');
        assert(aligned.context15m.validity['CandleRange'] === true, 'CandleRange must be valid immediately');
        assert(aligned.context15m.validity['ATR_14'] === false, 'ATR_14 must remain invalid during warm-up');
    });

    runTest('7. Gap invalidation preserves the independent 1h context', () => {
        let state = createInitialMTFState();
        for (let i = 0; i <= 60; i++) {
            state = stepMTFCombined(makeCandle(baseTime + i * 60_000), true, state, MTF_CONFIG_A).nextState;
        }

        state = stepMTFCombined(makeCandle(baseTime + 90 * 60_000), true, state, MTF_CONFIG_A).nextState;
        const aligned = alignMTFContext(baseTime + 90 * 60_000, 'SOLUSDT', state, MTF_CONFIG_A);
        assert(!aligned.context15m.isAvailable, 'Reset 15m context must be unavailable');
        assert(aligned.context15m.availabilityStatus === 'UNAVAILABLE', 'Reset status must be UNAVAILABLE');
        assert(Object.keys(aligned.context15m.features).length === 0, 'No features may be exposed after reset');
        assert(aligned.context1h.isAvailable, '1h context must remain available despite the 15m reset');
        assert(
            aligned.context1h.lastCompletedCloseTimestamp === baseTime + 3_600_000,
            'The completed 1h candle must be preserved'
        );
    });

    runTest('8. Strict future-leakage guard with exact-boundary control', () => {
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

        const exactBoundary = alignTimeframeContext(baseTime + 900_000, mockState, MTF_CONFIG_A.config15m);
        assert(exactBoundary.isAvailable, 'Candle must be available at its exact close boundary');
        assert(exactBoundary.lastCompletedCandle !== null, 'Candle must be exposed at its exact close boundary');
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
        for (const timestamp of [Number.NaN, -100, Infinity, -Infinity, 1000.5, Number.MAX_SAFE_INTEGER + 1]) {
            try {
                alignMTFContext(timestamp, 'SOLUSDT', state, MTF_CONFIG_A);
                assert(false, `Accepted invalid timestamp ${timestamp}`);
            } catch (error) {
                assert(errorMessage(error).includes('Invalid observation timestamp'), errorMessage(error));
            }
        }
    });

    runTest('11. Warm-up and availability separation', () => {
        const candle: MTFCandle = Object.freeze({
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
        const initialState = createInitialMTFState();
        const mockState: MTFTimeframeState = Object.freeze({
            ...initialState.state15m,
            aggregation: Object.freeze({
                ...initialState.state15m.aggregation,
                lastCompletedCandle: candle
            }),
            lastCompletedCandleOpenTimestamp: baseTime,
            latestFeatures: Object.freeze({ CandleRange: 10, IsWarmupComplete: 0 }),
            latestValidity: Object.freeze({ CandleRange: true, ATR_14: false })
        });

        const context = alignTimeframeContext(baseTime + 900_000, mockState, MTF_CONFIG_A.config15m);
        assert(context.isAvailable, 'Context must be available when feature warm-up is incomplete');
        assert(!context.isWarmupComplete, 'Warm-up must remain incomplete');
        assert(context.availabilityStatus === 'WARMING_UP', 'Status must be WARMING_UP');
        assert(context.validity['CandleRange'] === true, 'CandleRange must remain valid');
        assert(context.validity['ATR_14'] === false, 'ATR_14 must remain invalid');
    });

    runTest('12. Staleness gating is independent across timeframes', () => {
        const candle15m: MTFCandle = Object.freeze({
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
        const candle1h: MTFCandle = Object.freeze({
            timeframe: '1h',
            openTimestamp: baseTime - 3_600_000,
            closeTimestamp: baseTime,
            open: 90,
            high: 105,
            low: 88,
            close: 100,
            volume: 4000,
            sourceObservationCount: 60,
            completeness: 'COMPLETE'
        });
        const initialState = createInitialMTFState();
        const state: MTFState = Object.freeze({
            ...initialState,
            state15m: Object.freeze({
                ...initialState.state15m,
                aggregation: Object.freeze({
                    ...initialState.state15m.aggregation,
                    lastCompletedCandle: candle15m
                }),
                lastCompletedCandleOpenTimestamp: baseTime,
                latestFeatures: Object.freeze({ IsWarmupComplete: 1 }),
                latestValidity: Object.freeze({})
            }),
            state1h: Object.freeze({
                ...initialState.state1h,
                aggregation: Object.freeze({
                    ...initialState.state1h.aggregation,
                    lastCompletedCandle: candle1h
                }),
                lastCompletedCandleOpenTimestamp: baseTime - 3_600_000,
                latestFeatures: Object.freeze({ IsWarmupComplete: 1 }),
                latestValidity: Object.freeze({})
            })
        });
        const config = validateMTFConfig({
            symbol: 'SOLUSDT',
            baseTimeframe: '1m',
            config15m: { ...MTF_CONFIG_A.config15m, maxStalenessMs: 300_000 },
            config1h: { ...MTF_CONFIG_A.config1h, maxStalenessMs: 7_200_000 }
        });

        const context = alignMTFContext(baseTime + 25 * 60_000, 'SOLUSDT', state, config);
        assert(!context.context15m.isAvailable, '15m must be stale and unavailable');
        assert(context.context15m.availabilityStatus === 'STALE', '15m status must be STALE');
        assert(context.context1h.isAvailable, '1h must remain independently available');
        assert(context.context1h.availabilityStatus === 'AVAILABLE_VALID', '1h status must be AVAILABLE_VALID');
    });

    runTest('13. Invalid completed candles and inconsistent state are rejected', () => {
        const initialState = createInitialMTFState();
        const invalidCandleState = {
            ...initialState.state15m,
            aggregation: {
                ...initialState.state15m.aggregation,
                lastCompletedCandle: {
                    timeframe: '15m',
                    openTimestamp: baseTime,
                    closeTimestamp: baseTime + 900_000,
                    completeness: 'INCOMPLETE_MISSING'
                } as unknown as MTFCandle
            },
            lastCompletedCandleOpenTimestamp: baseTime
        } as MTFTimeframeState;

        try {
            alignTimeframeContext(baseTime + 900_000, invalidCandleState, MTF_CONFIG_A.config15m);
            assert(false, 'Accepted a non-COMPLETE candle');
        } catch (error) {
            assert(errorMessage(error).includes('Invalid completed HTF candle'), errorMessage(error));
        }

        const mismatchedWatermarkState: MTFTimeframeState = {
            ...initialState.state15m,
            aggregation: {
                ...initialState.state15m.aggregation,
                lastCompletedCandle: {
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
                }
            },
            lastCompletedCandleOpenTimestamp: baseTime + 60_000
        };

        try {
            alignTimeframeContext(baseTime + 900_000, mismatchedWatermarkState, MTF_CONFIG_A.config15m);
            assert(false, 'Accepted a state watermark mismatch');
        } catch (error) {
            assert(errorMessage(error).includes('State inconsistency'), errorMessage(error));
        }
    });

    runTest('14. Direct timeframe alignment timestamp validation', () => {
        const state = createInitialMTFState();
        for (const timestamp of [Number.NaN, -50, Infinity, -Infinity, 1234.5]) {
            try {
                alignTimeframeContext(timestamp, state.state15m, MTF_CONFIG_A.config15m);
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

    if (failed === 0 && passed === 14) {
        console.log('All 14 Phase 3D causal alignment criteria passed.');
        return true;
    }

    console.error('Phase 3D acceptance tests failed.');
    return false;
}
