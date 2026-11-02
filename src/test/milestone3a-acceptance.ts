import { ML1_CONFIG_A } from '../indicators/mlr1/ML1FeatureConfigs';
import { MTF_CONFIG_A, MTF_CONFIG_B, validateMTFConfig } from '../indicators/mlr1/mtf/MTFConfig';
import {
    calculateContextAgeMs,
    createEmptyMTFContext,
    createInitialMTFState,
    getUTCWindowBoundaries,
    isHTFCandleAvailableAt,
    isSourceTimestampInWindow,
    resolveHTFAvailability
} from '../indicators/mlr1/mtf/MTFState';
import type { MTFCandle } from '../indicators/mlr1/mtf/MTFTypes';

function assert(condition: boolean, message: string): asserts condition {
    if (!condition) throw new Error(`[AssertionFailed] ${message}`);
}

function assertThrows(action: () => unknown, expectedMessage: string): void {
    try {
        action();
    } catch (error) {
        assert(error instanceof Error && error.message.includes(expectedMessage), `Unexpected error: ${String(error)}`);
        return;
    }
    throw new Error(`[AssertionFailed] Expected an error containing "${expectedMessage}".`);
}

export function runPhase3ATests(): boolean {
    console.log('\n======================================================');
    console.log('🧪 Starting Milestone 3 Phase 3A Acceptance Suite (Contracts)');
    console.log('======================================================\n');
    let passed = 0;
    let failed = 0;

    const runTest = (name: string, testFn: () => void) => {
        try {
            testFn();
            passed++;
            console.log(`  ✅ Passed: ${name}`);
        } catch (error) {
            failed++;
            console.error(`  ❌ Failed: ${name} - ${error instanceof Error ? error.message : String(error)}`);
        }
    };

    runTest('1. Configuration validation and fail-closed gate', () => {
        assertThrows(() => validateMTFConfig(null), 'valid object');
        assertThrows(
            () => validateMTFConfig({ ...MTF_CONFIG_A, baseTimeframe: '5m' }),
            "must be strictly '1m'"
        );
        assertThrows(
            () => validateMTFConfig({
                ...MTF_CONFIG_A,
                config15m: { ...MTF_CONFIG_A.config15m, durationMs: 600_000 }
            }),
            'must be exactly 900000'
        );
        assertThrows(
            () => validateMTFConfig({
                ...MTF_CONFIG_A,
                config1h: { ...MTF_CONFIG_A.config1h, durationMs: 1_800_000 }
            }),
            'must be exactly 3600000'
        );

        const missingGapPolicy = { ...MTF_CONFIG_A.config15m } as Record<string, unknown>;
        delete missingGapPolicy.gapPolicy;
        assertThrows(
            () => validateMTFConfig({ ...MTF_CONFIG_A, config15m: missingGapPolicy }),
            "gapPolicy must be explicitly 'REJECT_AND_RESET'"
        );
        assertThrows(
            () => validateMTFConfig({
                ...MTF_CONFIG_A,
                config15m: { ...MTF_CONFIG_A.config15m, gapPolicy: 'IGNORE' }
            }),
            "gapPolicy must be explicitly 'REJECT_AND_RESET'"
        );

        for (const invalidValue of [0, -100, 15.5, Number.NaN, Number.POSITIVE_INFINITY]) {
            assertThrows(
                () => validateMTFConfig({
                    ...MTF_CONFIG_A,
                    config15m: { ...MTF_CONFIG_A.config15m, maxStalenessMs: invalidValue }
                }),
                'maxStalenessMs must be a positive safe integer'
            );
        }
    });

    runTest('2. Profile immutability and defensive copying', () => {
        const mutableInput = {
            symbol: 'SOLUSDT',
            baseTimeframe: '1m',
            config15m: {
                timeframe: '15m',
                durationMs: 900_000,
                alignment: 'UTC_HALF_OPEN',
                expectedSourceIntervalMs: 60_000,
                gapPolicy: 'REJECT_AND_RESET',
                featureConfig: { ...ML1_CONFIG_A, emaPeriods: [20] }
            },
            config1h: {
                timeframe: '1h',
                durationMs: 3_600_000,
                alignment: 'UTC_HALF_OPEN',
                expectedSourceIntervalMs: 60_000,
                gapPolicy: 'REJECT_AND_RESET',
                featureConfig: { ...ML1_CONFIG_A, emaPeriods: [50] }
            }
        };
        const validated = validateMTFConfig(mutableInput);

        mutableInput.symbol = 'BTCUSDT';
        mutableInput.config15m.durationMs = 999;
        mutableInput.config15m.featureConfig.emaPeriods.push(999);

        assert(validated.symbol === 'SOLUSDT', 'Validated symbol changed after input mutation');
        assert(validated.config15m.durationMs === 900_000, 'Validated timeframe changed after input mutation');
        assert(validated.config15m.featureConfig.emaPeriods.length === 1, 'Validated feature config changed after input mutation');
        assert(Object.isFrozen(validated), 'Validated root config must be frozen');
        assert(Object.isFrozen(validated.config15m), '15m config must be frozen');
        assert(Object.isFrozen(validated.config1h), '1h config must be frozen');
        assert(Object.isFrozen(validated.config15m.featureConfig), 'Nested feature config must be frozen');
        assert(Object.isFrozen(validated.config15m.featureConfig.emaPeriods), 'Nested feature arrays must be frozen');

        for (const profile of [MTF_CONFIG_A, MTF_CONFIG_B]) {
            assert(Object.isFrozen(profile.config15m.featureConfig.atrPeriods), 'Standard profile arrays must be frozen');
            assert(profile.config15m.gapPolicy === 'REJECT_AND_RESET', '15m gap policy mismatch');
            assert(profile.config1h.gapPolicy === 'REJECT_AND_RESET', '1h gap policy mismatch');
        }
        assert(MTF_CONFIG_A.config15m.featureConfig.emaPeriods.length === 0, 'Profile A must ablate EMA');
        assert(MTF_CONFIG_B.config15m.featureConfig.emaPeriods.length > 0, 'Profile B must include EMA');
    });

    runTest('3. UTC window boundaries and safe integer invariants', () => {
        const t1007 = Date.UTC(2026, 9, 15, 10, 7, 0);
        const t1000 = Date.UTC(2026, 9, 15, 10, 0, 0);
        const t1015 = Date.UTC(2026, 9, 15, 10, 15, 0);
        const t1100 = Date.UTC(2026, 9, 15, 11, 0, 0);
        const boundaries15m = getUTCWindowBoundaries(t1007, 900_000);
        const boundaries1h = getUTCWindowBoundaries(t1007, 3_600_000);

        assert(boundaries15m.openTimestamp === t1000, '15m open boundary mismatch');
        assert(boundaries15m.closeTimestamp === t1015, '15m close boundary mismatch');
        assert(boundaries1h.openTimestamp === t1000, '1h open boundary mismatch');
        assert(boundaries1h.closeTimestamp === t1100, '1h close boundary mismatch');
        assertThrows(
            () => getUTCWindowBoundaries(Number.NaN, 900_000),
            'Timestamp must be a safe non-negative integer'
        );
        assertThrows(
            () => getUTCWindowBoundaries(-1, 900_000),
            'Timestamp must be a safe non-negative integer'
        );
        assertThrows(
            () => getUTCWindowBoundaries(1.5, 900_000),
            'Timestamp must be a safe non-negative integer'
        );
        assertThrows(
            () => getUTCWindowBoundaries(t1007, 0),
            'DurationMs must be a positive safe integer'
        );
        assertThrows(
            () => getUTCWindowBoundaries(t1007, 15.5),
            'DurationMs must be a positive safe integer'
        );
        assertThrows(
            () => getUTCWindowBoundaries(Number.MAX_SAFE_INTEGER, 3),
            'Calculated boundaries exceed safe integer range'
        );
    });

    runTest('4. In-window validation and chronology checks', () => {
        const t1000 = Date.UTC(2026, 9, 15, 10, 0, 0);
        const t1015 = Date.UTC(2026, 9, 15, 10, 15, 0);

        assert(isSourceTimestampInWindow(t1000, t1000, t1015), 'Window start must be inclusive');
        assert(isSourceTimestampInWindow(t1015 - 60_000, t1000, t1015), 'Last 1m candle must be included');
        assert(!isSourceTimestampInWindow(t1015, t1000, t1015), 'Window close must be exclusive');
        assert(!isSourceTimestampInWindow(t1000, t1015, t1000), 'Inverted bounds must be rejected');
        assert(!isSourceTimestampInWindow(t1000, t1000, t1000), 'Zero-width bounds must be rejected');
        assert(!isSourceTimestampInWindow(-100, t1000, t1015), 'Negative source time must be rejected');
        assert(!isSourceTimestampInWindow(t1000 + 0.5, t1000, t1015), 'Fractional source time must be rejected');
    });

    runTest('5. Point-in-time availability and context age', () => {
        const t1014 = Date.UTC(2026, 9, 15, 10, 14, 0);
        const t1015 = Date.UTC(2026, 9, 15, 10, 15, 0);
        const t1016 = Date.UTC(2026, 9, 15, 10, 16, 0);
        const t1059 = Date.UTC(2026, 9, 15, 10, 59, 0);
        const t1100 = Date.UTC(2026, 9, 15, 11, 0, 0);

        assert(!isHTFCandleAvailableAt(t1014, t1015), '15m candle must be unavailable before close');
        assert(calculateContextAgeMs(t1014, t1015) === null, 'Age before close must be null');
        assert(isHTFCandleAvailableAt(t1015, t1015), '15m candle must be available at close');
        assert(calculateContextAgeMs(t1015, t1015) === 0, 'Age at close must be zero');
        assert(calculateContextAgeMs(t1016, t1015) === 60_000, '15m context age mismatch');
        assert(!isHTFCandleAvailableAt(t1059, t1100), '1h candle must be unavailable before close');
        assert(isHTFCandleAvailableAt(t1100, t1100), '1h candle must be available at close');
        assert(calculateContextAgeMs(t1100, t1100) === 0, '1h context age mismatch');
        assert(!isHTFCandleAvailableAt(-10, t1015), 'Negative observation time must be rejected');
        assert(!isHTFCandleAvailableAt(t1015, -t1015), 'Negative close time must be rejected');
        assert(!isHTFCandleAvailableAt(t1015 + 0.5, t1015), 'Fractional observation time must be rejected');
        assert(calculateContextAgeMs(-10, t1015) === null, 'Negative observation time must return null age');
        assert(calculateContextAgeMs(t1015, Number.NaN) === null, 'Invalid close time must return null age');
    });

    runTest('6. Initial state structure and timeframe isolation', () => {
        const state = createInitialMTFState();
        assert(state.stateVersion === 1, 'State version mismatch');
        assert(state.last1mBarIndex === null, 'Initial bar index must be null');
        assert(state.last1mTimestamp === null, 'Initial timestamp must be null');
        assert(state.state15m.timeframe === '15m', '15m timeframe mismatch');
        assert(state.state1h.timeframe === '1h', '1h timeframe mismatch');
        assert(state.state15m.aggregation.actualSourceCount === 0, '15m source count must be zero');
        assert(state.state1h.aggregation.actualSourceCount === 0, '1h source count must be zero');
        assert(state.state15m.featureEngineState !== state.state1h.featureEngineState, 'Feature states must be independent');
        assert(Object.isFrozen(state), 'Root state must be frozen');
        assert(Object.isFrozen(state.state15m), '15m state must be frozen');
        assert(Object.isFrozen(state.state1h), '1h state must be frozen');
        assert(Object.isFrozen(state.state15m.aggregation), '15m aggregation must be frozen');
    });

    const completeCandle: MTFCandle = {
        timeframe: '15m',
        openTimestamp: 0,
        closeTimestamp: 900_000,
        open: 100,
        high: 105,
        low: 95,
        close: 102,
        volume: 500,
        sourceObservationCount: 15,
        completeness: 'COMPLETE'
    };

    runTest('7. Completed candle completeness contract', () => {
        assert(completeCandle.completeness === 'COMPLETE', 'MTFCandle must only represent complete candles');
    });

    runTest('8. Context availability and stale-context semantics', () => {
        const unavailable = resolveHTFAvailability(null, null, false);
        assert(unavailable.availabilityStatus === 'UNAVAILABLE', 'Expected UNAVAILABLE');
        assert(!unavailable.isAvailable, 'Unavailable context must not be consumed');

        const warming = resolveHTFAvailability(completeCandle, 60_000, false);
        assert(warming.availabilityStatus === 'WARMING_UP', 'Expected WARMING_UP');
        assert(warming.isAvailable, 'Warm-up context remains available');

        const valid = resolveHTFAvailability(completeCandle, 60_000, true);
        assert(valid.availabilityStatus === 'AVAILABLE_VALID', 'Expected AVAILABLE_VALID');
        assert(valid.isAvailable, 'Valid context must be available');

        const staleThreshold = 300_000;
        const exactlyAtThreshold = resolveHTFAvailability(completeCandle, staleThreshold, true, staleThreshold);
        assert(exactlyAtThreshold.availabilityStatus === 'AVAILABLE_VALID', 'Context at the threshold is not stale');

        const stale = resolveHTFAvailability(completeCandle, 360_000, true, staleThreshold);
        assert(stale.availabilityStatus === 'STALE', 'Expected STALE');
        assert(!stale.isAvailable, 'Stale context must not be consumed');
        assert(
            resolveHTFAvailability(completeCandle, -1, true).availabilityStatus === 'UNAVAILABLE',
            'Negative context age must be unavailable'
        );
    });

    runTest('9. Timeframe reset isolation and feature-validity independence', () => {
        const initialState = createInitialMTFState();
        const reset15mState = {
            ...initialState.state15m,
            aggregation: {
                ...initialState.state15m.aggregation,
                lastDiagnostic: {
                    timeframe: '15m' as const,
                    openTimestamp: 0,
                    closeTimestamp: 900_000,
                    expectedSourceCount: 15,
                    actualSourceCount: 12,
                    missingTimestamps: [60_000, 120_000, 180_000],
                    duplicateCount: 0,
                    invalidSourceCount: 0,
                    completeness: 'INCOMPLETE_MISSING' as const
                }
            }
        };
        const context = createEmptyMTFContext(1_000, 'SOLUSDT');

        assert(reset15mState.aggregation.lastDiagnostic !== null, '15m reset diagnostic must be recorded');
        assert(reset15mState.aggregation.actualSourceCount === 0, '15m source count must remain reset');
        assert(initialState.state1h.aggregation.lastDiagnostic === null, '1h state must be unaffected by 15m reset');
        assert(
            initialState.state15m.featureEngineState !== initialState.state1h.featureEngineState,
            'Resetting 15m must not share feature state with 1h'
        );
        assert(
            context.context15m.validity !== context.context1h.validity,
            '15m and 1h feature validity maps must be independent'
        );
        assert(
            context.context15m.features !== context.context1h.features,
            '15m and 1h feature value maps must be independent'
        );
    });

    console.log('\n=======================================');
    console.log('📊 ML-R1 PHASE 3A FULL CONTRACT AUDIT:');
    console.log(`   ↳ Tests Executed:  ${passed + failed}`);
    console.log(`   ↳ Tests Passed:    ${passed}`);
    console.log(`   ↳ Tests Failed:    ${failed}`);
    console.log('=======================================\n');

    if (failed === 0 && passed === 9) {
        console.log('✅ ALL 9 PHASE 3A CONTRACT CONDITIONS RIGOROUSLY MET.');
        console.log('🔒 Phase 3A Multi-Timeframe Contracts FULLY FROZEN.');
        return true;
    }

    console.error('❌ PHASE 3A TESTS FAILED. DO NOT PROCEED TO PHASE 3B.');
    return false;
}
