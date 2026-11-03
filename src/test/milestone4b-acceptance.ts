import {
    createInitialBackboneStats,
    generateObservationId,
    calculateObservationTimestamp,
    extractDataQuality,
    evaluateAcceptance,
    updateBackboneStats
} from '../indicators/mlr1/dataset/ObservationBackbone';
import type { ML1Observation } from '../indicators/mlr1/ML1FeatureTypes';
import type { IntegrityPolicy } from '../indicators/mlr1/dataset/DatasetConfig';

function assert(condition: boolean, msg: string): asserts condition {
    if (!condition) throw new Error(`[Phase4BAssertionFailed] ${msg}`);
}

function createMockObservation(features: Record<string, number>): ML1Observation {
    return {
        timestamp: 1700000000000,
        symbol: 'BTCUSDT',
        timeframe: '1m',
        barIndex: 0,
        sourceOpen: 10,
        sourceHigh: 12,
        sourceLow: 8,
        sourceClose: 11,
        sourceVolume: 100,
        features,
        validity: {}
    };
}

export function runPhase4BTests(): boolean {
    console.log('\n======================================================');
    console.log('🧪 Starting Milestone 4 Phase 4B Acceptance Suite (Source Integrity)');
    console.log('======================================================\n');
    let passed = 0;
    let failed = 0;

    const runTest = (name: string, testFn: () => void) => {
        try {
            testFn();
            passed++;
            console.log(`  ✅ Passed: ${name}`);
        } catch (e: unknown) {
            failed++;
            console.error(`  ❌ Failed: ${name} - ${e instanceof Error ? e.message : String(e)}`);
        }
    };

    const policyStrict: IntegrityPolicy = {
        rejectInvalidSource: true,
        rejectDuplicateTimestamp: true,
        rejectOutOfOrder: true
    };

    runTest('1. Deterministic Observation Identity', () => {
        const id1 = generateObservationId('BTCUSDT', '1m', 1700000000000, 1);
        const id2 = generateObservationId('BTCUSDT', '1m', 1700000000000, 1);
        assert(id1 === 'OBS_BTCUSDT_1m_V1_1700000000000', 'ID format mismatch');
        assert(id1 === id2, 'Identical inputs must yield identical IDs');
    });

    runTest('2. Observation Timestamp Boundary Validation', () => {
        assert(calculateObservationTimestamp(1700000000000, 60000) === 1700000060000, 'Boundary calculation failed');
        let threw = false;
        try {
            calculateObservationTimestamp(-100, 60000);
        } catch {
            threw = true;
        }
        assert(threw, 'Negative source timestamp must throw');
        threw = false;
        try {
            calculateObservationTimestamp(1700000000000, -60000);
        } catch {
            threw = true;
        }
        assert(threw, 'Negative interval must throw');
    });

    runTest('3. Strict Data Quality Telemetry Mapping', () => {
        const validObs = createMockObservation({
            IsSourceValid: 1, HasDataGap: 0, IsDiscontinuity: 0,
            IsDuplicateTimestamp: 0, IsOutOfOrder: 0, IsUnexpectedInterval: 0
        });
        const dq = extractDataQuality(validObs);
        assert(dq.isSourceValid, 'Mapping failed for IsSourceValid');
        assert(Object.isFrozen(dq), 'DataQuality object must be frozen');

        const invalidObs = createMockObservation({ IsSourceValid: 1 });
        let threw = false;
        try {
            extractDataQuality(invalidObs);
        } catch {
            threw = true;
        }
        assert(threw, 'Missing telemetry field must throw');
    });

    runTest('4. Integrity Policy Evaluation (Reject Invalid OHLCV)', () => {
        const dq = extractDataQuality(createMockObservation({
            IsSourceValid: 1, HasDataGap: 0, IsDiscontinuity: 0,
            IsDuplicateTimestamp: 0, IsOutOfOrder: 0, IsUnexpectedInterval: 0
        }));
        assert(evaluateAcceptance(dq, false, policyStrict) === false, 'Must reject invalid OHLCV according to policy');
    });

    runTest('5. Duplicate & Out-Of-Order Handling', () => {
        const dqDup = extractDataQuality(createMockObservation({
            IsSourceValid: 0, HasDataGap: 0, IsDiscontinuity: 0,
            IsDuplicateTimestamp: 1, IsOutOfOrder: 0, IsUnexpectedInterval: 0
        }));
        assert(evaluateAcceptance(dqDup, true, policyStrict) === false, 'Must reject duplicates');

        const dqOOO = extractDataQuality(createMockObservation({
            IsSourceValid: 0, HasDataGap: 0, IsDiscontinuity: 0,
            IsDuplicateTimestamp: 0, IsOutOfOrder: 1, IsUnexpectedInterval: 0
        }));
        assert(evaluateAcceptance(dqOOO, true, policyStrict) === false, 'Must reject out-of-order');
    });

    runTest('6. Exact Missing Interval Accounting', () => {
        const dq = extractDataQuality(createMockObservation({
            IsSourceValid: 1, HasDataGap: 1, IsDiscontinuity: 0,
            IsDuplicateTimestamp: 0, IsOutOfOrder: 0, IsUnexpectedInterval: 0
        }));
        const state = updateBackboneStats(createInitialBackboneStats(), dq, true, true, 300, 60);
        assert(state.missingIntervalCount === 4, '300s delta / 60s - 1 = 4 missing intervals');
        assert(state.unexpectedIntervalCount === 0, 'Clean gap must not flag unexpected interval');
    });

    runTest('7. Unexpected Interval Isolation', () => {
        const dq = extractDataQuality(createMockObservation({
            IsSourceValid: 1, HasDataGap: 1, IsDiscontinuity: 0,
            IsDuplicateTimestamp: 0, IsOutOfOrder: 0, IsUnexpectedInterval: 1
        }));
        const state = updateBackboneStats(createInitialBackboneStats(), dq, true, true, 310, 60);
        assert(state.missingIntervalCount === 0, 'Sloppy delta must not count as clean missing interval');
        assert(state.unexpectedIntervalCount === 1, 'Sloppy delta must increment unexpected interval');
    });

    runTest('8. Total Accounting Invariants', () => {
        const dq = extractDataQuality(createMockObservation({
            IsSourceValid: 1, HasDataGap: 0, IsDiscontinuity: 0,
            IsDuplicateTimestamp: 0, IsOutOfOrder: 0, IsUnexpectedInterval: 0
        }));
        let state = createInitialBackboneStats();
        state = updateBackboneStats(state, dq, true, true, 60, 60);
        state = updateBackboneStats(state, dq, false, false, 60, 60);
        assert(state.sourceRowCount === 2, 'Must have 2 total rows');
        assert(state.acceptedObservationCount === 1, 'Must have 1 accepted');
        assert(state.rejectedObservationCount === 1, 'Must have 1 rejected');
        assert(state.sourceRowCount === state.acceptedObservationCount + state.rejectedObservationCount, 'Invariant failed');
    });

    runTest('9. Gap Recovery Does Not Fabricate', () => {
        const dq = extractDataQuality(createMockObservation({
            IsSourceValid: 1, HasDataGap: 1, IsDiscontinuity: 1,
            IsDuplicateTimestamp: 0, IsOutOfOrder: 0, IsUnexpectedInterval: 0
        }));
        const state = updateBackboneStats(createInitialBackboneStats(), dq, true, true, 600000, 60);
        assert(state.acceptedObservationCount === 1, 'Gap recovery candle counts as exactly 1 observation');
        assert(state.sourceRowCount === 1, 'Gap recovery candle counts as exactly 1 source row');
        assert(state.missingIntervalCount === 9999, '9999 candles missing in 600,000s gap');
    });

    runTest('10. Immutability of Statistics', () => {
        const state0 = createInitialBackboneStats();
        const dq = extractDataQuality(createMockObservation({
            IsSourceValid: 1, HasDataGap: 0, IsDiscontinuity: 0,
            IsDuplicateTimestamp: 0, IsOutOfOrder: 0, IsUnexpectedInterval: 0
        }));
        const state1 = updateBackboneStats(state0, dq, true, true, 60, 60);
        assert(state0.sourceRowCount === 0, 'Original state must not mutate');
        assert(state1.sourceRowCount === 1, 'New state must increment');
    });

    console.log('\n=======================================');
    console.log('📊 ML-R1 PHASE 4B ACCEPTANCE AUDIT:');
    console.log(`   ↳ Tests Executed:  ${passed + failed}`);
    console.log(`   ↳ Tests Passed:    ${passed}`);
    console.log(`   ↳ Tests Failed:    ${failed}`);
    console.log('=======================================\n');

    if (failed === 0 && passed === 10) {
        console.log('✅ ALL 10 PHASE 4B SOURCE INTEGRITY CRITERIA RIGOROUSLY MET.');
        console.log('🔒 Phase 4B Observation Backbone FULLY FROZEN.');
        return true;
    } else {
        console.error('❌ PHASE 4B TESTS FAILED.');
        return false;
    }
}
