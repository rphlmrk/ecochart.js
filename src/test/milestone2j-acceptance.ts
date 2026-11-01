import { ML1_CONFIG_A, ML1_CONFIG_B } from '../indicators/mlr1/ML1FeatureConfigs';
import { createInitialML1FeatureState, stepML1Features } from '../indicators/mlr1/ML1FeatureEngine';

function assert(condition: boolean, msg: string): asserts condition {
    if (!condition) throw new Error(`[AssertionFailed] ${msg}`);
}

export function runPhase2JTests(): boolean {
    console.log('\n🧪 Starting Phase 2J Acceptance Tests (Configuration & Schema Audit)...');
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

    runTest('Configuration Profile Immutability & Safety', () => {
        assert(Object.isFrozen(ML1_CONFIG_A), 'Config A is not frozen');
        assert(Object.isFrozen(ML1_CONFIG_B), 'Config B is not frozen');
        assert(Object.isFrozen(ML1_CONFIG_A.emaPeriods), 'Config A emaPeriods array not frozen');
        assert(Object.isFrozen(ML1_CONFIG_B.emaPeriods), 'Config B emaPeriods array not frozen');
        assert(Object.isFrozen(ML1_CONFIG_A.atrPeriods), 'Config A atrPeriods array not frozen');
    });

    runTest('Configuration A/B Non-EMA Parity', () => {
        assert(ML1_CONFIG_A.symbol === ML1_CONFIG_B.symbol, 'Symbol mismatch');
        assert(ML1_CONFIG_A.timeframe === ML1_CONFIG_B.timeframe, 'Timeframe mismatch');
        assert(ML1_CONFIG_A.expectedIntervalMs === ML1_CONFIG_B.expectedIntervalMs, 'Interval mismatch');
        assert(ML1_CONFIG_A.gapDiscontinuityThresholdMs === ML1_CONFIG_B.gapDiscontinuityThresholdMs, 'Discontinuity mismatch');
        assert(JSON.stringify(ML1_CONFIG_A.atrPeriods) === JSON.stringify(ML1_CONFIG_B.atrPeriods), 'ATR mismatch');
        assert(JSON.stringify(ML1_CONFIG_A.rollingRangePeriods) === JSON.stringify(ML1_CONFIG_B.rollingRangePeriods), 'Rolling Range mismatch');
        assert(JSON.stringify(ML1_CONFIG_A.momentumPeriods) === JSON.stringify(ML1_CONFIG_B.momentumPeriods), 'Momentum mismatch');
        assert(JSON.stringify(ML1_CONFIG_A.volumeSmaPeriods) === JSON.stringify(ML1_CONFIG_B.volumeSmaPeriods), 'Volume SMA mismatch');
    });

    runTest('Feature Schema Validation & EMA Ablation', () => {
        let stateA = createInitialML1FeatureState();
        let stateB = createInitialML1FeatureState();

        const testCandle = { time: 100000, open: 10, high: 15, low: 8, close: 12, volume: 100 };
        
        const resA = stepML1Features(testCandle, 0, stateA, ML1_CONFIG_A);
        const resB = stepML1Features(testCandle, 0, stateB, ML1_CONFIG_B);

        const keysA = Object.keys(resA.observation.features).sort();
        const keysB = Object.keys(resB.observation.features).sort();

        // 1. Verify EMA Features exist ONLY in Config B
        const emaFeaturesB = keysB.filter(k => k.startsWith('EMA_'));
        const emaFeaturesA = keysA.filter(k => k.startsWith('EMA_'));
        
        assert(emaFeaturesA.length === 0, 'Config A emitted EMA features despite ablation');
        assert(emaFeaturesB.length === 27, `Config B emitted ${emaFeaturesB.length} EMA features, expected exactly 27`);

        // 2. Verify Exact Schema Match for Non-EMA features
        const nonEmaKeysB = keysB.filter(k => !k.startsWith('EMA_')).sort();
        assert(JSON.stringify(keysA) === JSON.stringify(nonEmaKeysB), 'Non-EMA feature schema diverges between Config A and Config B');
        
        // 3. Verify Exact Values for Non-EMA features
        for (const key of keysA) {
            assert(resA.observation.features[key] === resB.observation.features[key], `Value mismatch on shared feature: ${key}`);
            assert(resA.observation.validity[key] === resB.observation.validity[key], `Validity mismatch on shared feature: ${key}`);
        }
    });

    console.log(`\n=======================================`);
    console.log(`📊 ML-R1 PHASE 2J FINAL AUDIT:`);
    console.log(`   ↳ Tests Executed:  ${passed + failed}`);
    console.log(`   ↳ Tests Passed:    ${passed}`);
    console.log(`   ↳ Tests Failed:    ${failed}`);
    console.log(`=======================================\n`);

    return failed === 0;
}
