import {
    buildSourceBackbone,
    calculateObservationTimestamp,
    createInitialBackboneStats,
    evaluateAcceptance,
    evaluateDatasetUptime,
    extractDataQuality,
    generateObservationId,
    processSourceObservation,
    type SourceBackboneInputItem
} from '../indicators/mlr1/dataset/ObservationBackbone';
import type { ML1Candle, ML1Observation } from '../indicators/mlr1/ML1FeatureTypes';
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

function qualityFeatures(overrides: Partial<Record<string, number>> = {}): Record<string, number> {
    return {
        IsSourceValid: 1,
        HasDataGap: 0,
        IsDiscontinuity: 0,
        IsDuplicateTimestamp: 0,
        IsOutOfOrder: 0,
        IsUnexpectedInterval: 0,
        ...overrides
    };
}

function createCandle(time: number): ML1Candle {
    return { time, open: 10, high: 12, low: 9, close: 11, volume: 100 };
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
        rejectInvalidOhlcv: true,
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

    runTest('2. Observation Timestamp Boundary & Input Validation', () => {
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
        const valid = extractDataQuality(createMockObservation(1700000000000, qualityFeatures()));
        assert(valid.isSourceValid, 'Valid binary telemetry mapping failed');
        for (const badValue of [0.5, NaN, Infinity, -1, 2]) {
            let threw = false;
            try {
                extractDataQuality(createMockObservation(
                    1700000000000,
                    qualityFeatures({ IsSourceValid: badValue })
                ));
            } catch {
                threw = true;
            }
            assert(threw, `Telemetry value ${badValue} must throw`);
        }
    });

    runTest('4. Runtime Contract Validation', () => {
        const stats = createInitialBackboneStats();
        const quality = extractDataQuality(createMockObservation(1700000000000, qualityFeatures()));
        let threw = false;
        try {
            processSourceObservation(stats, 1700000000000, quality, 'invalid' as unknown as boolean, strictPolicy, 60000);
        } catch {
            threw = true;
        }
        assert(threw, 'Non-boolean OHLCV validity must throw');
        threw = false;
        try {
            processSourceObservation(stats, 1700000000000, quality, true, null as unknown as IntegrityPolicy, 60000);
        } catch {
            threw = true;
        }
        assert(threw, 'Null policy must throw');

        const corruptedStats = {
            ...stats,
            sourceRowCount: 2,
            acceptedObservationCount: 1,
            rejectedObservationCount: 0,
            firstSourceTimestamp: 1700000000000,
            lastSourceTimestamp: 1700000000000
        };
        threw = false;
        try {
            processSourceObservation(
                corruptedStats, 1700000000000, quality, true, strictPolicy, 60000
            );
        } catch {
            threw = true;
        }
        assert(threw, 'Corrupted source accounting must throw');
    });

    runTest('5. Native-clean duplicate detected and rejected', () => {
        const timestamp = 1700000000000;
        const quality = extractDataQuality(createMockObservation(timestamp, qualityFeatures()));
        const first = processSourceObservation(
            createInitialBackboneStats(), timestamp, quality, true, strictPolicy, 60000
        );
        const duplicate = processSourceObservation(
            first.nextStats, timestamp, quality, true, strictPolicy, 60000
        );
        assert(first.acceptance.isAccepted, 'First candle must be accepted');
        assert(!duplicate.acceptance.isAccepted, 'Duplicate must be rejected');
        assert(duplicate.acceptance.rejectionReasons.includes('DUPLICATE_TIMESTAMP'), 'Duplicate reason missing');
        assert(duplicate.nextStats.duplicateTimestampCount === 1, 'Duplicate count must increment');
    });

    runTest('6. Native-clean out-of-order candle detected and rejected', () => {
        const timestamp = 1700000000000;
        const quality = extractDataQuality(createMockObservation(timestamp, qualityFeatures()));
        const first = processSourceObservation(
            createInitialBackboneStats(), timestamp, quality, true, strictPolicy, 60000
        );
        const outOfOrder = processSourceObservation(
            first.nextStats, timestamp - 60000, quality, true, strictPolicy, 60000
        );
        assert(!outOfOrder.acceptance.isAccepted, 'Out-of-order candle must be rejected');
        assert(outOfOrder.acceptance.rejectionReasons.includes('OUT_OF_ORDER'), 'Out-of-order reason missing');
        assert(outOfOrder.nextStats.outOfOrderCount === 1, 'Out-of-order count must increment');
        assert(outOfOrder.nextStats.lastSourceTimestamp === timestamp, 'Watermark must not regress');
    });

    runTest('7. Permissive policy accepts duplicate but audits it', () => {
        const timestamp = 1700000000000;
        const quality = extractDataQuality(createMockObservation(timestamp, qualityFeatures()));
        const permissivePolicy: IntegrityPolicy = {
            rejectInvalidSource: false,
            rejectInvalidOhlcv: false,
            rejectDuplicateTimestamp: false,
            rejectOutOfOrder: false
        };
        const first = processSourceObservation(
            createInitialBackboneStats(), timestamp, quality, true, permissivePolicy, 60000
        );
        const duplicate = processSourceObservation(
            first.nextStats, timestamp, quality, true, permissivePolicy, 60000
        );
        assert(duplicate.acceptance.isAccepted, 'Permissive policy must accept duplicate');
        assert(duplicate.nextStats.duplicateTimestampCount === 1, 'Duplicate counter must still increment');
        assert(duplicate.nextStats.acceptedObservationCount === 2, 'Both rows must be accepted');
    });

    runTest('8. Invalid source and invalid OHLCV use separate counters and rejection reasons', () => {
        const timestamp = 1700000000000;
        const invalidSource = processSourceObservation(
            createInitialBackboneStats(),
            timestamp,
            extractDataQuality(createMockObservation(timestamp, qualityFeatures({ IsSourceValid: 0 }))),
            true,
            strictPolicy,
            60000
        );
        assert(invalidSource.acceptance.rejectionReasons.includes('INVALID_SOURCE'), 'Invalid source reason missing');
        assert(!invalidSource.acceptance.rejectionReasons.includes('INVALID_OHLCV'), 'Valid OHLCV must not be flagged');
        assert(invalidSource.nextStats.invalidSourceCount === 1, 'Invalid source count must increment');
        assert(invalidSource.nextStats.invalidOhlcvCount === 0, 'Invalid OHLCV count must remain zero');

        const invalidOhlcv = processSourceObservation(
            invalidSource.nextStats,
            timestamp + 60000,
            extractDataQuality(createMockObservation(timestamp + 60000, qualityFeatures())),
            false,
            strictPolicy,
            60000
        );
        assert(invalidOhlcv.acceptance.rejectionReasons.includes('INVALID_OHLCV'), 'Invalid OHLCV reason missing');
        assert(invalidOhlcv.nextStats.invalidOhlcvCount === 1, 'Invalid OHLCV count must increment');

        const permissiveOhlcvPolicy: IntegrityPolicy = {
            ...strictPolicy,
            rejectInvalidOhlcv: false
        };
        const invalidOhlcvQuality = extractDataQuality(
            createMockObservation(timestamp + 120000, qualityFeatures())
        );
        const permissiveOhlcv = evaluateAcceptance(
            invalidOhlcvQuality,
            permissiveOhlcvPolicy,
            false
        );
        assert(permissiveOhlcv.isAccepted, 'rejectInvalidOhlcv=false must permit invalid OHLCV independently');
    });

    runTest('9. Native unexpected interval is recorded once alongside gap accounting', () => {
        const timestamp = 1700000000000;
        const first = processSourceObservation(
            createInitialBackboneStats(),
            timestamp,
            extractDataQuality(createMockObservation(timestamp, qualityFeatures())),
            true,
            strictPolicy,
            60000
        );
        const second = processSourceObservation(
            first.nextStats,
            timestamp + 300000,
            extractDataQuality(createMockObservation(
                timestamp + 300000,
                qualityFeatures({ HasDataGap: 1, IsUnexpectedInterval: 1 })
            )),
            true,
            strictPolicy,
            60000
        );
        assert(second.nextStats.missingIntervalCount === 4, 'Four missing intervals must be counted');
        assert(second.nextStats.unexpectedIntervalCount === 1, 'Unexpected interval must only count once');
    });

    runTest('10. Chronology regression: rejected later candle does not move watermark backward', () => {
        let stats = createInitialBackboneStats();
        const t0 = 100000;
        const t1 = 220000;
        const t2 = 160000;
        const t3 = 280000;
        const cleanQuality = extractDataQuality(createMockObservation(t0, qualityFeatures()));
        const invalidQuality = extractDataQuality(createMockObservation(
            t1,
            qualityFeatures({ IsSourceValid: 0 })
        ));

        const first = processSourceObservation(stats, t0, cleanQuality, true, strictPolicy, 60000);
        assert(first.acceptance.isAccepted, 'First timestamp should be accepted');
        const second = processSourceObservation(first.nextStats, t1, invalidQuality, true, strictPolicy, 60000);
        assert(!second.acceptance.isAccepted, 'Invalid newer timestamp should be rejected');
        assert(second.nextStats.lastSourceTimestamp === t1, 'Watermark should advance to newer rejected row');
        assert(second.nextStats.missingIntervalCount === 1, 'Missing interval should be counted');

        const third = processSourceObservation(second.nextStats, t2, cleanQuality, true, strictPolicy, 60000);
        assert(!third.acceptance.isAccepted, 'Regressing timestamp should be rejected');
        assert(third.nextStats.lastSourceTimestamp === t1, 'Watermark must remain at t1');
        assert(third.nextStats.outOfOrderCount === 1, 'Out-of-order counter should increment');

        const fourth = processSourceObservation(third.nextStats, t3, cleanQuality, true, strictPolicy, 60000);
        assert(fourth.acceptance.isAccepted, 'Next chronological timestamp should be accepted');
        assert(fourth.nextStats.lastSourceTimestamp === t3, 'Watermark should advance to t3');
        assert(fourth.nextStats.missingIntervalCount === 1, 'Missing count should remain unchanged');
    });

    runTest('11. Uptime denominator and threshold range validation', () => {
        const stats = Object.freeze({
            ...createInitialBackboneStats(),
            sourceRowCount: 8,
            acceptedObservationCount: 4,
            rejectedObservationCount: 4,
            missingIntervalCount: 2,
            firstSourceTimestamp: 100000,
            lastSourceTimestamp: 400000
        });
        const passing = evaluateDatasetUptime(
            stats,
            { ...strictPolicy, requireMinimumUptimeFraction: 0.6 },
            60000
        );
        assert(passing.isUptimeValid, 'Four of six usable timeline slots should pass 60%');
        assert(passing.totalExpectedObservations === 6, 'Uptime denominator must use the first-to-last unique slot span');
        assert(Math.abs(passing.sourceAvailabilityFraction - 4 / 6) < 1e-4, 'Duplicates and out-of-order rows must not inflate availability');
        assert(Math.abs(passing.usableObservationFraction - 4 / 6) < 1e-4, 'Rejected arrivals must not inflate usable uptime');
        const failing = evaluateDatasetUptime(
            stats,
            { ...strictPolicy, requireMinimumUptimeFraction: 0.7 },
            60000
        );
        assert(!failing.isUptimeValid, 'Four of six usable timeline slots should fail 70%');

        for (const threshold of [-0.1, 1.1, NaN, Infinity]) {
            let threw = false;
            try {
                evaluateDatasetUptime(
                    stats,
                    { ...strictPolicy, requireMinimumUptimeFraction: threshold },
                    60000
                );
            } catch {
                threw = true;
            }
            assert(threw, `Invalid threshold ${threshold} must throw`);
        }
    });

    runTest('12. Source accounting invariant across mixed input', () => {
        const timestamp = 1700000000000;
        let stats = createInitialBackboneStats();
        stats = processSourceObservation(
            stats, timestamp,
            extractDataQuality(createMockObservation(timestamp, qualityFeatures())),
            true, strictPolicy, 60000
        ).nextStats;
        stats = processSourceObservation(
            stats, timestamp + 60000,
            extractDataQuality(createMockObservation(timestamp + 60000, qualityFeatures({ IsSourceValid: 0 }))),
            false, strictPolicy, 60000
        ).nextStats;
        stats = processSourceObservation(
            stats, timestamp + 60000,
            extractDataQuality(createMockObservation(timestamp + 60000, qualityFeatures())),
            true, strictPolicy, 60000
        ).nextStats;

        assert(stats.sourceRowCount === 3, 'Source row count must be 3');
        assert(stats.acceptedObservationCount === 1, 'Accepted rows must equal 1');
        assert(stats.rejectedObservationCount === 2, 'Rejected rows must equal 2');
        assert(stats.sourceRowCount === stats.acceptedObservationCount + stats.rejectedObservationCount, 'Accounting invariant failed');
    });

    runTest('13. Rejected chronologically newer candle advances watermark', () => {
        const timestamp = 1700000000000;
        const result = processSourceObservation(
            createInitialBackboneStats(),
            timestamp + 60000,
            extractDataQuality(createMockObservation(timestamp + 60000, qualityFeatures({ IsSourceValid: 0 }))),
            true,
            strictPolicy,
            60000
        );
        assert(!result.acceptance.isAccepted, 'Invalid source should be rejected');
        assert(result.nextStats.lastSourceTimestamp === timestamp + 60000, 'Watermark must advance on rejected newer row');
    });

    runTest('14. Concrete builder preserves order, excludes rejected rows, and fabricates no candles', () => {
        const inputItems: SourceBackboneInputItem[] = [
            { candle: createCandle(100000), observation: createMockObservation(100000, qualityFeatures()), isValidOhlcv: true },
            { candle: createCandle(160000), observation: createMockObservation(160000, qualityFeatures()), isValidOhlcv: true },
            { candle: createCandle(160000), observation: createMockObservation(160000, qualityFeatures()), isValidOhlcv: true },
            { candle: createCandle(140000), observation: createMockObservation(140000, qualityFeatures()), isValidOhlcv: true },
            { candle: createCandle(340000), observation: createMockObservation(340000, qualityFeatures()), isValidOhlcv: true },
            { candle: createCandle(400000), observation: createMockObservation(400000, qualityFeatures({ IsSourceValid: 0 })), isValidOhlcv: true }
        ];
        const result = buildSourceBackbone(inputItems, 'SOLUSDT', '1m', 1, strictPolicy, 60000);

        assert(result.stats.sourceRowCount === 6, 'Source row count must be 6');
        assert(result.acceptedRows.length === 3, 'Exactly 3 observations should be accepted');
        assert(result.rejectedRows.length === 3, 'Exactly 3 observations should be rejected');
        assert(result.stats.missingIntervalCount === 2, 'Exactly 2 missing intervals should be counted');
        assert(result.acceptedRows[0].sourceTimestamp === 100000, 'First row timestamp mismatch');
        assert(result.acceptedRows[1].sourceTimestamp === 160000, 'Second row timestamp mismatch');
        assert(result.acceptedRows[2].sourceTimestamp === 340000, 'Third row timestamp mismatch');
        assert(result.acceptedRows[0].observationTimestamp === 160000, 'Observation boundary mismatch');
        assert(result.acceptedRows[0].observationId === 'OBS_SOLUSDT_1m_V1_100000', 'Observation ID mismatch');
        assert(result.uptime.totalExpectedObservations === 6, 'Duplicate/out-of-order rows must not expand the timeline');
        assert(Math.abs(result.uptime.sourceAvailabilityFraction - 4 / 6) < 1e-4, 'Source availability must use unique slots');
        assert(!result.uptime.isUptimeValid, '3 accepted of 6 total slots should fail the 95% uptime policy');
        assert(Object.isFrozen(result.acceptedRows), 'Accepted row collection must be immutable');
        assert(Object.isFrozen(result.rejectedRows), 'Rejected row collection must be immutable');
    });

    runTest('15. Concrete builder rejects candle/observation timestamp mismatch', () => {
        const inputItems: SourceBackboneInputItem[] = [
            {
                candle: createCandle(100000),
                observation: createMockObservation(160000, qualityFeatures()),
                isValidOhlcv: true
            }
        ];
        let threw = false;
        try {
            buildSourceBackbone(inputItems, 'SOLUSDT', '1m', 1, strictPolicy, 60000);
        } catch (error: unknown) {
            threw = error instanceof Error && error.message.includes('Timestamp mismatch');
        }
        assert(threw, 'Mismatched candle and observation timestamps must throw');
    });

    console.log('\n=======================================');
    console.log('📊 ML-R1 PHASE 4B FULL ACCEPTANCE AUDIT:');
    console.log(`   ↳ Tests Executed:  ${passed + failed}`);
    console.log(`   ↳ Tests Passed:    ${passed}`);
    console.log(`   ↳ Tests Failed:    ${failed}`);
    console.log('=======================================\n');

    return failed === 0 && passed === 15;
}
