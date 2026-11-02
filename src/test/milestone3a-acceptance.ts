import { ML1_CONFIG_A } from '../indicators/mlr1/ML1FeatureConfigs';
import { MTF_CONFIG_A, MTF_CONFIG_B, validateMTFConfig } from '../indicators/mlr1/mtf/MTFConfig';
import {
    calculateContextAgeMs,
    createEmptyMTFContext,
    createInitialMTFState,
    getUTCWindowBoundaries,
    isHTFCandleAvailableAt,
    isSourceTimestampInWindow
} from '../indicators/mlr1/mtf/MTFState';

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

    runTest('Configuration validation and fail-closed constraints', () => {
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
        assertThrows(
            () => validateMTFConfig({
                ...MTF_CONFIG_A,
                config15m: { ...MTF_CONFIG_A.config15m, maxStalenessMs: 0 }
            }),
            'maxStalenessMs must be a positive number'
        );
    });

    runTest('Configuration profiles are deeply immutable', () => {
        for (const profile of [MTF_CONFIG_A, MTF_CONFIG_B]) {
            assert(Object.isFrozen(profile), 'Profile is not frozen');
            assert(Object.isFrozen(profile.config15m), '15m config is not frozen');
            assert(Object.isFrozen(profile.config1h), '1h config is not frozen');
            assert(Object.isFrozen(profile.config15m.featureConfig), '15m feature config is not frozen');
            assert(Object.isFrozen(profile.config1h.featureConfig), '1h feature config is not frozen');
            assert(Object.isFrozen(profile.config15m.featureConfig.atrPeriods), 'Feature period arrays are not frozen');
            assert(profile.config15m.alignment === 'UTC_HALF_OPEN', '15m alignment mismatch');
            assert(profile.config1h.alignment === 'UTC_HALF_OPEN', '1h alignment mismatch');
        }
        assert(MTF_CONFIG_A.config15m.featureConfig.emaPeriods.length === 0, 'Profile A must ablate EMA');
        assert(MTF_CONFIG_B.config15m.featureConfig.emaPeriods.length > 0, 'Profile B must include EMA');
    });

    runTest('UTC boundaries and half-open window semantics', () => {
        const t1007 = Date.UTC(2026, 9, 15, 10, 7, 0);
        const t1000 = Date.UTC(2026, 9, 15, 10, 0, 0);
        const t1015 = Date.UTC(2026, 9, 15, 10, 15, 0);
        const t1100 = Date.UTC(2026, 9, 15, 11, 0, 0);

        const boundaries15m = getUTCWindowBoundaries(t1007, 900_000);
        assert(boundaries15m.openTimestamp === t1000, '15m open boundary mismatch');
        assert(boundaries15m.closeTimestamp === t1015, '15m close boundary mismatch');

        const boundaries1h = getUTCWindowBoundaries(t1007, 3_600_000);
        assert(boundaries1h.openTimestamp === t1000, '1h open boundary mismatch');
        assert(boundaries1h.closeTimestamp === t1100, '1h close boundary mismatch');

        assert(isSourceTimestampInWindow(t1000, t1000, t1015), 'Window open must be inclusive');
        assert(isSourceTimestampInWindow(t1015 - 60_000, t1000, t1015), 'Last 1m candle must be in window');
        assert(!isSourceTimestampInWindow(t1015, t1000, t1015), 'Window close must be exclusive');
    });

    runTest('Point-in-time availability and context age', () => {
        const t1014 = Date.UTC(2026, 9, 15, 10, 14, 0);
        const t1015 = Date.UTC(2026, 9, 15, 10, 15, 0);
        const t1016 = Date.UTC(2026, 9, 15, 10, 16, 0);
        const t1059 = Date.UTC(2026, 9, 15, 10, 59, 0);
        const t1100 = Date.UTC(2026, 9, 15, 11, 0, 0);

        assert(!isHTFCandleAvailableAt(t1014, t1015), '15m candle must be unavailable before close');
        assert(calculateContextAgeMs(t1014, t1015) === null, 'Age must be null before availability');
        assert(isHTFCandleAvailableAt(t1015, t1015), '15m candle must be available at close');
        assert(calculateContextAgeMs(t1015, t1015) === 0, 'Age at close must be zero');
        assert(calculateContextAgeMs(t1016, t1015) === 60_000, '15m context age mismatch');
        assert(!isHTFCandleAvailableAt(t1059, t1100), '1h candle must be unavailable before close');
        assert(isHTFCandleAvailableAt(t1100, t1100), '1h candle must be available at close');
        assert(calculateContextAgeMs(t1100, t1100) === 0, '1h age at close must be zero');
    });

    runTest('Initial state structure, isolation, and immutability', () => {
        const state = createInitialMTFState();
        assert(state.stateVersion === 1, 'State version mismatch');
        assert(state.last1mBarIndex === null, 'Initial 1m bar index must be null');
        assert(state.last1mTimestamp === null, 'Initial 1m timestamp must be null');
        assert(state.state15m.timeframe === '15m', '15m state timeframe mismatch');
        assert(state.state1h.timeframe === '1h', '1h state timeframe mismatch');
        assert(state.state15m.aggregation.actualSourceCount === 0, '15m source count must be zero');
        assert(state.state1h.aggregation.actualSourceCount === 0, '1h source count must be zero');
        assert(state.state15m.featureEngineState !== state.state1h.featureEngineState, 'Feature states must be independent');
        assert(Object.isFrozen(state), 'Root state is not frozen');
        assert(Object.isFrozen(state.state15m), '15m state is not frozen');
        assert(Object.isFrozen(state.state1h), '1h state is not frozen');
        assert(Object.isFrozen(state.state15m.aggregation), '15m aggregation is not frozen');
    });

    runTest('Initial fallback context semantics', () => {
        const context = createEmptyMTFContext(1000, 'SOLUSDT');
        assert(context.observationTimestamp === 1000, 'Timestamp mismatch');
        assert(context.symbol === 'SOLUSDT', 'Symbol mismatch');
        for (const timeframeContext of [context.context15m, context.context1h]) {
            assert(!timeframeContext.isAvailable, `${timeframeContext.timeframe} context must be unavailable`);
            assert(timeframeContext.availabilityStatus === 'UNAVAILABLE', 'Initial status mismatch');
            assert(timeframeContext.lastCompletedCandle === null, 'Initial candle must be null');
            assert(!timeframeContext.isWarmupComplete, 'Initial warm-up must be incomplete');
            assert(Object.keys(timeframeContext.features).length === 0, 'Initial features must be empty');
            assert(Object.keys(timeframeContext.validity).length === 0, 'Initial validity must be empty');
        }
    });

    assert(ML1_CONFIG_A.timeframe === '1m', 'Standard MTF profiles must use the approved ML1 feature configuration');

    console.log('\n=======================================');
    console.log('📊 ML-R1 PHASE 3A ACCEPTANCE AUDIT:');
    console.log(`   ↳ Tests Executed:  ${passed + failed}`);
    console.log(`   ↳ Tests Passed:    ${passed}`);
    console.log(`   ↳ Tests Failed:    ${failed}`);
    console.log('=======================================\n');

    if (failed === 0) {
        console.log('✅ ALL PHASE 3A CONTRACT TESTS PASSED.\n🔒 Phase 3A Contracts FROZEN.');
        return true;
    }

    console.error('❌ PHASE 3A TESTS FAILED. DO NOT PROCEED TO PHASE 3B.');
    return false;
}
