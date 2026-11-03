import {
    createInitialBackboneStats,
    generateObservationId,
    calculateObservationTimestamp,
    extractDataQuality,
    evaluateAcceptance,
    evaluateDatasetUptime,
    updateBackboneStats
} from '../indicators/mlr1/dataset/ObservationBackbone';
import type { ML1Observation } from '../indicators/mlr1/ML1FeatureTypes';
import type { IntegrityPolicy } from '../indicators/mlr1/dataset/DatasetConfig';

function assert(condition: boolean, msg: string): asserts condition {
    if (!condition) throw new Error(`[Phase4BAssertionFailed] ${msg}`);
}

function createMockObservation(timestamp: number, features: Record<string, number>): ML1Observation {
    return {
        timestamp,
        symbol: 'SOLUSDT',
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
        rejectOutOfOrder: true,
        requireMinimumUptimeFraction: 0.95
    };

    runTest('1. Deterministic Observation Identity', () => {
        const id1 = generateObservationId('SOLUSDT', '1m', 1700000000000, 1);
        const id2 = generateObservationId('SOLUSDT', '1m', 1700000000000, 1);
        assert(id1 === 'OBS_SOLUSDT_1m_V1_1700000000000', 'ID format mismatch');
        assert(id1 === id2, 'Identical inputs must yield identical IDs');
    });

    runTest('2. Observation Timestamp Boundary & Validation', () => {
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

    runTest('3. Strict Binary Telemetry Validation', () => {
        const validObs = createMockObservation(1700000000000, {
            IsSourceValid: 1, HasDataGap: 0, IsDiscontinuity: 0,
            IsDuplicateTimestamp: 0, IsOutOfOrder: 0, IsUnexpectedInterval: 0
        });
        const dq = extractDataQuality(validObs);
        assert(dq.isSourceValid, 'Mapping failed for IsSourceValid');

        for (const badVal of [0.5, NaN, Infinity, -1, 2]) {
            let threw = false;
            try {
                extractDataQuality(createMockObservation(1700000000000, {
                    IsSourceValid: badVal, HasDataGap: 0, IsDiscontinuity: 0,
                    IsDuplicateTimestamp: 0, IsOutOfOrder: 0, IsUnexpectedInterval: 0
                }));
            } catch {
                threw = true;
            }
            assert(threw, `Telemetry with value ${badVal} must throw error`);
        }
    });

    runTest('4. Integrity Policy: Independent rejectInvalidSource switch', () => {
        const invalidDq = extractDataQuality(createMockObservation(1700000000000, {
            IsSourceValid: 0, HasDataGap: 0, IsDiscontinuity: 0,
            IsDuplicateTimestamp: 0, IsOutOfOrder: 0, IsUnexpectedInterval: 0
        }));

        const resStrict = evaluateAcceptance(invalidDq, policyStrict, true);
        assert(!resStrict.isAccepted, 'Strict policy must reject invalid source');
        assert(resStrict.rejectionReasons.includes('INVALID_SOURCE'), 'Must include INVALID_SOURCE reason');

        const resPermissive = evaluateAcceptance(invalidDq, { ...policyStrict, rejectInvalidSource: false }, true);
        assert(resPermissive.isAccepted, 'Permissive policy must permit when switch is false');
    });

    runTest('5. Integrity Policy: Independent rejectDuplicateTimestamp switch', () => {
        const dupDq = extractDataQuality(createMockObservation(1700000000000, {
            IsSourceValid: 0, HasDataGap: 0, IsDiscontinuity: 0,
            IsDuplicateTimestamp: 1, IsOutOfOrder: 0, IsUnexpectedInterval: 0
        }));

        const resStrict = evaluateAcceptance(dupDq, policyStrict, true);
        assert(!resStrict.isAccepted, 'Strict policy must reject duplicate');

        const resPermissive = evaluateAcceptance(
            dupDq,
            { ...policyStrict, rejectDuplicateTimestamp: false, rejectInvalidSource: false },
            true
        );
        assert(resPermissive.isAccepted, 'Permissive policy must permit duplicate when switch is false');
    });

    runTest('6. Integrity Policy: Independent rejectOutOfOrder switch', () => {
        const oooDq = extractDataQuality(createMockObservation(1700000000000, {
            IsSourceValid: 0, HasDataGap: 0, IsDiscontinuity: 0,
            IsDuplicateTimestamp: 0, IsOutOfOrder: 1, IsUnexpectedInterval: 0
        }));

        const resStrict = evaluateAcceptance(oooDq, policyStrict, true);
        assert(!resStrict.isAccepted, 'Strict policy must reject out of order');

        const resPermissive = evaluateAcceptance(
            oooDq,
            { ...policyStrict, rejectOutOfOrder: false, rejectInvalidSource: false },
            true
        );
        assert(resPermissive.isAccepted, 'Permissive policy must permit out of order when switch is false');
    });

    runTest('7. Minimum Uptime Evaluation', () => {
        let stats = createInitialBackboneStats();
        stats = { ...stats, acceptedObservationCount: 96, missingIntervalCount: 4 };

        const passResult = evaluateDatasetUptime(stats, { ...policyStrict, requireMinimumUptimeFraction: 0.95 });
        assert(passResult.isUptimeValid, '96% uptime must pass 95% requirement');
        assert(Math.abs(passResult.actualUptimeFraction - 0.96) < 1e-4, 'Uptime fraction calculation mismatch');

        const failResult = evaluateDatasetUptime(stats, { ...policyStrict, requireMinimumUptimeFraction: 0.98 });
        assert(!failResult.isUptimeValid, '96% uptime must fail 98% requirement');
    });

    runTest('8. Stateful Chronology Watermark Tracking (No sorting)', () => {
        let stats = createInitialBackboneStats();
        const base = 1700000000000;
        const validDq = extractDataQuality(createMockObservation(base, {
            IsSourceValid: 1, HasDataGap: 0, IsDiscontinuity: 0,
            IsDuplicateTimestamp: 0, IsOutOfOrder: 0, IsUnexpectedInterval: 0
        }));
        const accept = evaluateAcceptance(validDq, policyStrict);

        stats = updateBackboneStats(stats, base, accept, 60000);
        assert(stats.lastSourceTimestamp === base, 'Watermark should be t=0');

        const oooAccept = evaluateAcceptance(validDq, { ...policyStrict, rejectOutOfOrder: false });
        stats = updateBackboneStats(stats, base - 60000, oooAccept, 60000);
        assert(stats.outOfOrderCount === 1, 'Out of order must be detected statefully');
        assert(stats.lastSourceTimestamp === base, 'Watermark must NOT regress backwards');
    });

    runTest('9. Exact Missing vs Unexpected Interval Accounting', () => {
        let stats = createInitialBackboneStats();
        const base = 1700000000000;
        const validDq = extractDataQuality(createMockObservation(base, {
            IsSourceValid: 1, HasDataGap: 0, IsDiscontinuity: 0,
            IsDuplicateTimestamp: 0, IsOutOfOrder: 0, IsUnexpectedInterval: 0
        }));
        const accept = evaluateAcceptance(validDq, policyStrict);

        stats = updateBackboneStats(stats, base, accept, 60000);
        stats = updateBackboneStats(stats, base + 300000, accept, 60000);
        assert(stats.missingIntervalCount === 4, 'Expected exactly 4 missing intervals');
        assert(stats.unexpectedIntervalCount === 0, 'Clean gap must not be counted as unexpected');

        stats = updateBackboneStats(stats, base + 610000, accept, 60000);
        assert(stats.unexpectedIntervalCount === 1, 'Non-multiple delta must increment unexpectedIntervalCount');
    });

    runTest('10. Preserves Native isUnexpectedInterval Telemetry', () => {
        let stats = createInitialBackboneStats();
        const base = 1700000000000;
        const unexpectedDq = extractDataQuality(createMockObservation(base, {
            IsSourceValid: 0, HasDataGap: 0, IsDiscontinuity: 0,
            IsDuplicateTimestamp: 0, IsOutOfOrder: 0, IsUnexpectedInterval: 1
        }));
        const accept = evaluateAcceptance(unexpectedDq, { ...policyStrict, rejectInvalidSource: false });

        stats = updateBackboneStats(stats, base, accept, 60000);
        stats = updateBackboneStats(stats, base + 60000, accept, 60000);
        assert(stats.unexpectedIntervalCount === 1, 'Native unexpected interval flag must be recorded');
    });

    runTest('11. Total Accounting Invariants (sourceRows = accepted + rejected)', () => {
        let stats = createInitialBackboneStats();
        const base = 1700000000000;
        const validDq = extractDataQuality(createMockObservation(base, {
            IsSourceValid: 1, HasDataGap: 0, IsDiscontinuity: 0,
            IsDuplicateTimestamp: 0, IsOutOfOrder: 0, IsUnexpectedInterval: 0
        }));
        const invalidDq = extractDataQuality(createMockObservation(base + 60000, {
            IsSourceValid: 0, HasDataGap: 0, IsDiscontinuity: 0,
            IsDuplicateTimestamp: 0, IsOutOfOrder: 0, IsUnexpectedInterval: 0
        }));

        const acceptTrue = evaluateAcceptance(validDq, policyStrict, true);
        const acceptFalse = evaluateAcceptance(invalidDq, policyStrict, false);

        stats = updateBackboneStats(stats, base, acceptTrue, 60000, true);
        stats = updateBackboneStats(stats, base + 60000, acceptFalse, 60000, false);

        assert(stats.sourceRowCount === 2, 'Total rows must be 2');
        assert(stats.acceptedObservationCount === 1, 'Accepted must be 1');
        assert(stats.rejectedObservationCount === 1, 'Rejected must be 1');
        assert(
            stats.sourceRowCount === stats.acceptedObservationCount + stats.rejectedObservationCount,
            'Invariant holds'
        );
    });

    runTest('12. Immutability & No Fabricated Candles on Gap Recovery', () => {
        const stats0 = createInitialBackboneStats();
        const base = 1700000000000;
        const validDq = extractDataQuality(createMockObservation(base, {
            IsSourceValid: 1, HasDataGap: 1, IsDiscontinuity: 1,
            IsDuplicateTimestamp: 0, IsOutOfOrder: 0, IsUnexpectedInterval: 0
        }));
        const accept = evaluateAcceptance(validDq, policyStrict);

        const stats1 = updateBackboneStats(stats0, base + 1000000, accept, 60000);

        assert(stats0.sourceRowCount === 0, 'Initial stats object must remain unmutated');
        assert(stats1.sourceRowCount === 1, 'Only the actual incoming candle counts as a source row');
        assert(stats1.acceptedObservationCount === 1, 'Only 1 accepted observation recorded; no candles fabricated');
        assert(Object.isFrozen(stats1), 'Returned stats must be frozen');
    });

    console.log('\n=======================================');
    console.log('📊 ML-R1 PHASE 4B ACCEPTANCE AUDIT:');
    console.log(`   ↳ Tests Executed:  ${passed + failed}`);
    console.log(`   ↳ Tests Passed:    ${passed}`);
    console.log(`   ↳ Tests Failed:    ${failed}`);
    console.log('=======================================\n');

    return failed === 0 && passed === 12;
}
