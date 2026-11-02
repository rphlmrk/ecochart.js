import { ML1_CONFIG_A } from '../indicators/mlr1/ML1FeatureConfigs';
import { MTF_CONFIG_A, MTF_CONFIG_B, validateMTFConfig } from '../indicators/mlr1/mtf/MTFConfig';
import {
    calculateContextAgeMs,
    createInitialMTFState,
    getUTCWindowBoundaries,
    isHTFCandleAvailableAt,
    isSourceTimestampInWindow,
    resolveHTFAvailability,
    createMTFTimeframeContext
} from '../indicators/mlr1/mtf/MTFState';
import type { MTFCandle } from '../indicators/mlr1/mtf/MTFTypes';
import type { ML1FeatureValidity, ML1FeatureValues } from '../indicators/mlr1/ML1FeatureTypes';

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

    runTest('8. Context availability, input hardening, and stale-context semantics', () => {
        const unavailable = resolveHTFAvailability(null, null, false);
        assert(unavailable.availabilityStatus === 'UNAVAILABLE', 'Expected UNAVAILABLE');
        assert(!unavailable.isAvailable, 'Unavailable context must not be consumed');

        for (const badStaleness of [0, -500, 15.5, Number.NaN, Number.POSITIVE_INFINITY]) {
            assertThrows(
                () => resolveHTFAvailability(null, null, false, badStaleness),
                'positive safe integer'
            );
        }

        for (const invalidAge of [-100, 50.5, Number.NaN, Number.POSITIVE_INFINITY]) {
            assert(
                resolveHTFAvailability(completeCandle, invalidAge, true).availabilityStatus === 'UNAVAILABLE',
                `Invalid context age ${invalidAge} must resolve to UNAVAILABLE`
            );
        }
        assertThrows(
            () => resolveHTFAvailability(completeCandle, 1_000, true, -500),
            'positive safe integer'
        );
        assertThrows(
            () => resolveHTFAvailability(completeCandle, 1_000, true, Number.NaN),
            'positive safe integer'
        );

        const warming = resolveHTFAvailability(completeCandle, 60_000, false);
        assert(warming.availabilityStatus === 'WARMING_UP', 'Expected WARMING_UP');
        assert(warming.isAvailable, 'Warm-up context remains available');

        const valid = resolveHTFAvailability(completeCandle, 60_000, true);
        assert(valid.availabilityStatus === 'AVAILABLE_VALID', 'Expected AVAILABLE_VALID');
        assert(valid.isAvailable, 'Valid context must be available');

        const staleThreshold = 300_000;
        const exactlyAtThreshold = resolveHTFAvailability(completeCandle, staleThreshold, true, staleThreshold);
        assert(exactlyAtThreshold.availabilityStatus === 'AVAILABLE_VALID', 'Context at the threshold is not stale');
        assert(exactlyAtThreshold.isAvailable, 'Context at threshold must remain available');

        const beyondThreshold = resolveHTFAvailability(completeCandle, staleThreshold + 1, true, staleThreshold);
        assert(beyondThreshold.availabilityStatus === 'STALE', '1ms beyond threshold must be stale');
        assert(!beyondThreshold.isAvailable, 'Stale context must not be consumed');

        const mismatchedCandle: MTFCandle = { ...completeCandle, timeframe: '15m' };
        assertThrows(
            () => createMTFTimeframeContext('1h', mismatchedCandle, 1_000_000, false),
            'does not match requested context timeframe'
        );

        const observationTimestamp = Date.UTC(2026, 9, 15, 10, 21, 0);
        const candle15mCloseTimestamp = Date.UTC(2026, 9, 15, 10, 15, 0);
        const mutableCandle = {
            ...completeCandle,
            openTimestamp: Date.UTC(2026, 9, 15, 10, 0, 0),
            closeTimestamp: candle15mCloseTimestamp
        };
        const stale15mContext = createMTFTimeframeContext(
            '15m',
            mutableCandle,
            observationTimestamp,
            true,
            Object.freeze({ ATR_14: 2.5 }),
            Object.freeze({ ATR_14: true }),
            staleThreshold
        );
        mutableCandle.close = 999_999;
        assert(stale15mContext.lastCompletedCandle !== mutableCandle, 'Context must take a defensive candle snapshot');
        assert(stale15mContext.lastCompletedCandle?.close === completeCandle.close, 'Snapshot must preserve source close value');
        assert(Object.isFrozen(stale15mContext.lastCompletedCandle), 'Candle snapshot must be frozen');
        assert(
            stale15mContext.lastCompletedCloseTimestamp === candle15mCloseTimestamp,
            'Stale context must preserve the close timestamp'
        );
        assert(stale15mContext.contextAgeMs === staleThreshold + 60_000, 'Stale context age must be preserved');
        assert(!stale15mContext.isAvailable, 'Stale context must be excluded from consumption');
        assert(stale15mContext.availabilityStatus === 'STALE', 'Stale context status mismatch');

        const candle1h: MTFCandle = {
            ...completeCandle,
            timeframe: '1h',
            openTimestamp: Date.UTC(2026, 9, 15, 9, 0, 0),
            closeTimestamp: Date.UTC(2026, 9, 15, 10, 0, 0),
            sourceObservationCount: 60
        };
        const fresh1hContext = createMTFTimeframeContext(
            '1h',
            candle1h,
            observationTimestamp,
            true,
            Object.freeze({ ATR_14: 5 }),
            Object.freeze({ ATR_14: true }),
            7_200_000
        );
        assert(!stale15mContext.isAvailable, 'Stale 15m context must remain unavailable');
        assert(fresh1hContext.isAvailable, 'Fresh 1h context must remain available independently');
    });

    runTest('9. Timeframe state isolation and feature-validity independence', () => {
        const initialState = createInitialMTFState();
        assert(initialState.state15m !== initialState.state1h, 'Timeframe state objects must be distinct');
        assert(initialState.state15m.aggregation !== initialState.state1h.aggregation, 'Aggregation states must be distinct');
        assert(
            initialState.state15m.featureEngineState !== initialState.state1h.featureEngineState,
            'Feature engine states must be distinct'
        );

        const features15m: ML1FeatureValues = Object.freeze({ ATR_14: 2.5, EMA_200_Slope_10: 0 });
        const validity15m: ML1FeatureValidity = Object.freeze({ ATR_14: true, EMA_200_Slope_10: false });
        const context15m = createMTFTimeframeContext('15m', null, 1_000, false, features15m, validity15m);
        assert(context15m.validity.ATR_14 === true, 'Valid feature must remain valid');
        assert(context15m.validity.EMA_200_Slope_10 === false, 'Invalid feature must remain independently invalid');

        const features1h: ML1FeatureValues = Object.freeze({ ATR_14: 5, EMA_200_Slope_10: 0.12 });
        const validity1h: ML1FeatureValidity = Object.freeze({ ATR_14: true, EMA_200_Slope_10: true });
        const context1h = createMTFTimeframeContext('1h', null, 1_000, false, features1h, validity1h);
        assert(context1h.validity.EMA_200_Slope_10 === true, '1h validity must not inherit 15m invalidity');
        assert(context15m.validity !== context1h.validity, 'Feature validity maps must not be shared');
        assert(context15m.features !== context1h.features, 'Feature values must not be shared');

        const mutableFeatures: ML1FeatureValues = { ATR_14: 2 };
        const mutableValidity: ML1FeatureValidity = { ATR_14: true };
        const frozenContext = createMTFTimeframeContext('15m', null, 1_000, false, mutableFeatures, mutableValidity);
        mutableFeatures.ATR_14 = 99;
        mutableValidity.ATR_14 = false;
        assert(frozenContext.features.ATR_14 === 2, 'Context must defensively copy feature values');
        assert(frozenContext.validity.ATR_14 === true, 'Context must defensively copy feature validity');
        assert(Object.isFrozen(frozenContext.features), 'Feature values must be frozen');
        assert(Object.isFrozen(frozenContext.validity), 'Feature validity must be frozen');
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
