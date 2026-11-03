import {
    createInitialBackboneStats,
    generateObservationId,
    calculateObservationTimestamp,
    extractDataQuality,
    evaluateDatasetUptime,
    processSourceObservation
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
        } catch (error: unknown) {
            failed++;
            console.error(`  ❌ Failed: ${name} - ${error instanceof Error ? error.message : String(error)}`);
        }
    };

    const strictPolicy: IntegrityPolicy = {
        rejectInvalidSource: true,
        rejectDuplicateTimestamp: true,
        rejectOutOfOrder: true,
        requireMinimumUptimeFraction: 0.95
    };

    const createQuality = (timestamp: number, overrides: Partial<Record<string, number>> = {}) =>
        extractDataQuality(createMockObservation(timestamp, {
            IsSourceValid: 1,
            HasDataGap: 0,
            IsDiscontinuity: 0,
            IsDuplicateTimestamp: 0,
            IsOutOfOrder: 0,
            IsUnexpectedInterval: 0,
            ...overrides
        }));

    runTest('1. Deterministic Observation Identity', () => {
        const id1 = generateObservationId('SOLUSDT', '1m', 1700000000000, 1);
        const id2 = generateObservationId('SOLUSDT', '1m', 1700000000000, 1);
        assert(id1 === 'OBS_SOLUSDT_1m_V1_1700000000000', 'ID format mismatch');
        assert(id1 === id2, 'Identical inputs must yield identical IDs');
    });

    runTest('2. Observation Timestamp Boundary & Validation', () => {
        assert(
            calculateObservationTimestamp(1700000000000, 60000) === 1700000060000,
            'Boundary calculation failed'
        );
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
        const quality = createQuality(1700000000000);
        assert(quality.isSourceValid, 'Mapping failed for IsSourceValid');

        for (const badValue of [0.5, NaN, Infinity, -1, 2]) {
            let threw = false;
            try {
                extractDataQuality(createMockObservation(1700000000000, {
                    IsSourceValid: badValue,
                    HasDataGap: 0,
                    IsDiscontinuity: 0,
                    IsDuplicateTimestamp: 0,
                    IsOutOfOrder: 0,
                    IsUnexpectedInterval: 0
                }));
            } catch {
                threw = true;
            }
            assert(threw, `Telemetry with value ${badValue} must throw`);
        }
    });

    runTest('4. Native-clean duplicate is detected and rejected by policy', () => {
        const timestamp = 1700000000000;
        const quality = createQuality(timestamp);
        const first = processSourceObservation(
            createInitialBackboneStats(), timestamp, quality, true, strictPolicy, 60000
        );
        const duplicate = processSourceObservation(
            first.nextStats, timestamp, quality, true, strictPolicy, 60000
        );

        assert(first.acceptance.isAccepted, 'First observation must be accepted');
        assert(!duplicate.acceptance.isAccepted, 'Internal duplicate must be rejected');
        assert(
            duplicate.acceptance.rejectionReasons.includes('DUPLICATE_TIMESTAMP'),
            'Must cite DUPLICATE_TIMESTAMP'
        );
        assert(duplicate.nextStats.duplicateTimestampCount === 1, 'Duplicate count must increment');
    });

    runTest('5. Native-clean out-of-order timestamp is detected and rejected', () => {
        const timestamp = 1700000000000;
        const quality = createQuality(timestamp);
        const first = processSourceObservation(
            createInitialBackboneStats(), timestamp, quality, true, strictPolicy, 60000
        );
        const outOfOrder = processSourceObservation(
            first.nextStats, timestamp - 60000, quality, true, strictPolicy, 60000
        );

        assert(!outOfOrder.acceptance.isAccepted, 'Out-of-order timestamp must be rejected');
        assert(outOfOrder.acceptance.rejectionReasons.includes('OUT_OF_ORDER'), 'Must cite OUT_OF_ORDER');
        assert(outOfOrder.nextStats.outOfOrderCount === 1, 'Out-of-order count must increment');
        assert(outOfOrder.nextStats.lastSourceTimestamp === timestamp, 'Watermark must not regress');
    });

    runTest('6. Permissive policy accepts duplicate and out-of-order rows but audits them', () => {
        const timestamp = 1700000000000;
        const quality = createQuality(timestamp);
        const permissivePolicy: IntegrityPolicy = {
            rejectInvalidSource: false,
            rejectDuplicateTimestamp: false,
            rejectOutOfOrder: false
        };
        const first = processSourceObservation(
            createInitialBackboneStats(), timestamp, quality, true, permissivePolicy, 60000
        );
        const duplicate = processSourceObservation(
            first.nextStats, timestamp, quality, true, permissivePolicy, 60000
        );
        const outOfOrder = processSourceObservation(
            duplicate.nextStats, timestamp - 60000, quality, true, permissivePolicy, 60000
        );

        assert(duplicate.acceptance.isAccepted, 'Permissive policy must accept duplicate');
        assert(outOfOrder.acceptance.isAccepted, 'Permissive policy must accept out-of-order timestamp');
        assert(outOfOrder.nextStats.duplicateTimestampCount === 1, 'Duplicate must remain audited');
        assert(outOfOrder.nextStats.outOfOrderCount === 1, 'Out-of-order row must remain audited');
        assert(outOfOrder.nextStats.acceptedObservationCount === 3, 'All three rows must be accepted');
    });

    runTest('7. Invalid source and invalid OHLCV are accounted separately', () => {
        const timestamp = 1700000000000;
        const invalidSourceQuality = createQuality(timestamp, { IsSourceValid: 0 });
        const invalidSource = processSourceObservation(
            createInitialBackboneStats(), timestamp, invalidSourceQuality, true, strictPolicy, 60000
        );
        assert(!invalidSource.acceptance.isAccepted, 'Invalid source must be rejected');
        assert(invalidSource.acceptance.rejectionReasons.includes('INVALID_SOURCE'), 'Must cite INVALID_SOURCE');
        assert(!invalidSource.acceptance.rejectionReasons.includes('INVALID_OHLCV'), 'Valid OHLCV must not be cited invalid');
        assert(invalidSource.nextStats.invalidOhlcvCount === 0, 'Valid OHLCV must not increment invalid count');

        const validSourceQuality = createQuality(timestamp + 60000);
        const invalidOhlcv = processSourceObservation(
            invalidSource.nextStats, timestamp + 60000, validSourceQuality, false, strictPolicy, 60000
        );
        assert(!invalidOhlcv.acceptance.isAccepted, 'Invalid OHLCV must be rejected');
        assert(invalidOhlcv.acceptance.rejectionReasons.includes('INVALID_OHLCV'), 'Must cite INVALID_OHLCV');
        assert(invalidOhlcv.nextStats.invalidOhlcvCount === 1, 'Invalid OHLCV must increment invalid count');
    });

    runTest('8. Native unexpected interval is recorded once alongside gap accounting', () => {
        const timestamp = 1700000000000;
        const first = processSourceObservation(
            createInitialBackboneStats(), timestamp, createQuality(timestamp), true, strictPolicy, 60000
        );
        const nativeUnexpectedQuality = createQuality(timestamp + 300000, { HasDataGap: 1, IsUnexpectedInterval: 1 });
        const result = processSourceObservation(
            first.nextStats, timestamp + 300000, nativeUnexpectedQuality, true, strictPolicy, 60000
        );

        assert(result.nextStats.missingIntervalCount === 4, 'Four clean missing intervals must be counted');
        assert(result.nextStats.unexpectedIntervalCount === 1, 'Native unexpected flag must be counted once');
    });

    runTest('9. Uptime includes rejected rows and validates threshold bounds', () => {
        const stats = Object.freeze({
            ...createInitialBackboneStats(),
            sourceRowCount: 100,
            acceptedObservationCount: 96,
            rejectedObservationCount: 4
        });
        const passing = evaluateDatasetUptime(stats, { ...strictPolicy, requireMinimumUptimeFraction: 0.95 });
        assert(passing.isUptimeValid, '96% usable fraction must pass 95% threshold');
        assert(Math.abs(passing.usableObservationFraction - 0.96) < 1e-4, 'Usable fraction denominator mismatch');
        assert(passing.sourceAvailabilityFraction === 1, 'Source availability must include rejected source rows');

        const failing = evaluateDatasetUptime(stats, { ...strictPolicy, requireMinimumUptimeFraction: 0.98 });
        assert(!failing.isUptimeValid, '96% usable fraction must fail 98% threshold');

        for (const threshold of [-0.1, 1.1, NaN, Infinity]) {
            let threw = false;
            try {
                evaluateDatasetUptime(stats, { ...strictPolicy, requireMinimumUptimeFraction: threshold });
            } catch {
                threw = true;
            }
            assert(threw, `Threshold ${threshold} must throw`);
        }
    });

    runTest('10. Source row accounting invariant across mixed feed', () => {
        const timestamp = 1700000000000;
        const validQuality = createQuality(timestamp);
        const invalidQuality = createQuality(timestamp + 60000, { IsSourceValid: 0 });
        let stats = createInitialBackboneStats();

        stats = processSourceObservation(stats, timestamp, validQuality, true, strictPolicy, 60000).nextStats;
        stats = processSourceObservation(stats, timestamp + 60000, invalidQuality, false, strictPolicy, 60000).nextStats;
        stats = processSourceObservation(stats, timestamp + 60000, validQuality, true, strictPolicy, 60000).nextStats;

        assert(stats.sourceRowCount === 3, 'Must have 3 source rows');
        assert(stats.acceptedObservationCount === 1, 'Must have 1 accepted row');
        assert(stats.rejectedObservationCount === 2, 'Must have 2 rejected rows');
        assert(
            stats.sourceRowCount === stats.acceptedObservationCount + stats.rejectedObservationCount,
            'Source row accounting invariant must hold'
        );
    });

    runTest('11. Rejected newer candle advances chronology watermark', () => {
        const timestamp = 1700000000000;
        const invalidQuality = createQuality(timestamp + 60000, { IsSourceValid: 0 });
        const result = processSourceObservation(
            createInitialBackboneStats(), timestamp + 60000, invalidQuality, true, strictPolicy, 60000
        );

        assert(!result.acceptance.isAccepted, 'Invalid source must be rejected');
        assert(result.nextStats.lastSourceTimestamp === timestamp + 60000, 'Watermark must advance despite rejection');
    });

    runTest('12. Dataset feed preserves order, excludes rejected rows, and fabricates no candles', () => {
        const stream = [
            { time: 100000, valid: true },
            { time: 160000, valid: true },
            { time: 160000, valid: true },
            { time: 150000, valid: true },
            { time: 400000, valid: true },
            { time: 460000, valid: false }
        ];
        let stats = createInitialBackboneStats();
        const acceptedRows: number[] = [];

        for (const item of stream) {
            const quality = createQuality(item.time, { IsSourceValid: item.valid ? 1 : 0 });
            const result = processSourceObservation(stats, item.time, quality, true, strictPolicy, 60000);
            stats = result.nextStats;
            if (result.acceptance.isAccepted) acceptedRows.push(item.time);
        }

        assert(stats.sourceRowCount === 6, 'Source row count must be 6');
        assert(stats.acceptedObservationCount === 3, 'Exactly 3 rows must be accepted');
        assert(stats.rejectedObservationCount === 3, 'Exactly 3 rows must be rejected');
        assert(stats.missingIntervalCount === 3, 'Exactly 3 missing intervals must be counted');
        assert(acceptedRows.length === 3, 'Output must contain accepted observations only');
        assert(
            acceptedRows[0] === 100000 && acceptedRows[1] === 160000 && acceptedRows[2] === 400000,
            'Original source order must be preserved without fabricated rows'
        );
    });

    console.log('\n=======================================');
    console.log('📊 ML-R1 PHASE 4B FULL ACCEPTANCE AUDIT:');
    console.log(`   ↳ Tests Executed:  ${passed + failed}`);
    console.log(`   ↳ Tests Passed:    ${passed}`);
    console.log(`   ↳ Tests Failed:    ${failed}`);
    console.log('=======================================\n');

    return failed === 0 && passed === 12;
}
