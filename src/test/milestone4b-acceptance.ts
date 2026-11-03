import {
    accountRawSourceRows,
    buildSourceBackbone,
    calculateObservationTimestamp,
    createInitialBackboneStats,
    evaluateAcceptance,
    evaluateDatasetUptime,
    extractDataQuality,
    generateObservationId,
    processSourceObservation,
    createDatasetManifest,
    validateCandleOhlcv,
    type SlotIntegrityContext,
    type SourceBackboneInputItem
} from '../indicators/mlr1/dataset/ObservationBackbone';
import {
    AIExporter,
    CandleContextAggregator,
    DatasetAuditor,
    HybridTokenBuilder,
    MLR1_OUTCOME_LABEL_ALLOWLIST,
    MLR1_REPRESENTATION_FEATURE_ALLOWLIST
} from '../data/AIExporter';
import { TIER_C_QUARANTINE_LIST } from '../indicators/mlr1/dataset/DatasetSchema';
import type { ML1Candle, ML1Observation } from '../indicators/mlr1/ML1FeatureTypes';
import type { DatasetConfig, IntegrityPolicy } from '../indicators/mlr1/dataset/DatasetConfig';

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
        validity: Object.fromEntries(Object.keys(features).map(key => [key, true]))
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
        assert(validateCandleOhlcv(createCandle(1700000000000)), 'Valid candle should pass OHLCV validation');
        assert(!validateCandleOhlcv({
            ...createCandle(1700000000000),
            open: -10,
            high: -9,
            low: -11,
            close: -10
        }), 'Candle with non-positive prices must fail OHLCV validation');
        assert(!validateCandleOhlcv({
            ...createCandle(1700000000000),
            high: 8
        }), 'Candle with high below the open/close should fail OHLCV validation');
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

        for (const invalidContext of [
            { isOnGrid: 'yes' },
            { isWithinRange: 1 },
            { gridAnchor: 100000, isOnGrid: false }
        ]) {
            threw = false;
            try {
                processSourceObservation(
                    stats,
                    100000,
                    quality,
                    true,
                    strictPolicy,
                    60000,
                    undefined,
                    invalidContext as unknown as SlotIntegrityContext
                );
            } catch {
                threw = true;
            }
            assert(threw, `Invalid or contradictory slot context must throw: ${JSON.stringify(invalidContext)}`);
        }

        for (const badContext of [null, 'invalid', []]) {
            let errorMessage = '';
            try {
                processSourceObservation(
                    stats,
                    1700000000000,
                    quality,
                    true,
                    strictPolicy,
                    60000,
                    undefined,
                    badContext as unknown as SlotIntegrityContext
                );
            } catch (error: unknown) {
                errorMessage = error instanceof Error ? error.message : String(error);
            }
            assert(
                errorMessage.includes('slotContext must be a valid SlotIntegrityContext object'),
                `Malformed slotContext (${JSON.stringify(badContext)}) must throw the expected runtime contract error`
            );
        }
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

    runTest('7. Policy decouples invalid source from invalid OHLCV', () => {
        const validQuality = extractDataQuality(createMockObservation(100000, qualityFeatures()));
        const invalidSourceQuality = extractDataQuality(
            createMockObservation(100000, qualityFeatures({ IsSourceValid: 0 }))
        );
        const policy: IntegrityPolicy = {
            rejectInvalidSource: true,
            rejectInvalidOhlcv: false,
            rejectDuplicateTimestamp: true,
            rejectOutOfOrder: true
        };
        assert(evaluateAcceptance(validQuality, policy, false).isAccepted, 'Policy should allow invalid OHLCV');

        const sourcePermissivePolicy: IntegrityPolicy = {
            ...policy,
            rejectInvalidSource: false,
            rejectInvalidOhlcv: true
        };
        assert(
            evaluateAcceptance(invalidSourceQuality, sourcePermissivePolicy, true).isAccepted,
            'Policy should allow invalid source when configured'
        );
        const invalidOhlcv = evaluateAcceptance(validQuality, sourcePermissivePolicy, false);
        assert(!invalidOhlcv.isAccepted, 'Policy should independently reject invalid OHLCV');
        assert(invalidOhlcv.rejectionReasons.includes('INVALID_OHLCV'), 'Invalid OHLCV reason missing');
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

    runTest('10. Late arrival does not regress watermark or inflate uptime', () => {
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

        const first = processSourceObservation(
            stats, t0, cleanQuality, true, strictPolicy, 60000,
            { isUniqueSource: true, isCandidateUniqueAccepted: true }
        );
        assert(first.acceptance.isAccepted, 'First timestamp should be accepted');
        const second = processSourceObservation(
            first.nextStats, t1, invalidQuality, true, strictPolicy, 60000,
            { isUniqueSource: true, isCandidateUniqueAccepted: true }
        );
        assert(!second.acceptance.isAccepted, 'Invalid newer timestamp should be rejected');
        assert(second.nextStats.lastSourceTimestamp === t1, 'Watermark should advance to newer rejected row');
        assert(second.nextStats.missingIntervalCount === 1, 'Missing interval should be counted');

        const third = processSourceObservation(
            second.nextStats, t2, cleanQuality, true, strictPolicy, 60000,
            { isUniqueSource: true, isCandidateUniqueAccepted: true }
        );
        assert(!third.acceptance.isAccepted, 'Regressing timestamp should be rejected');
        assert(third.nextStats.lastSourceTimestamp === t1, 'Watermark must remain at t1');
        assert(third.nextStats.outOfOrderCount === 1, 'Out-of-order counter should increment');
        assert(third.nextStats.uniqueAcceptedTimestampsCount === 1, 'Rejected late arrival must not increment unique accepted count');

        const fourth = processSourceObservation(
            third.nextStats, t3, cleanQuality, true, strictPolicy, 60000,
            { isUniqueSource: true, isCandidateUniqueAccepted: true }
        );
        assert(fourth.acceptance.isAccepted, 'Next chronological timestamp should be accepted');
        assert(fourth.nextStats.lastSourceTimestamp === t3, 'Watermark should advance to t3');
        assert(fourth.nextStats.missingIntervalCount === 1, 'Missing count should remain unchanged');
        assert(fourth.nextStats.uniqueSourceTimestampsCount === 4, 'All four distinct timestamps should be counted once');
        assert(fourth.nextStats.uniqueAcceptedTimestampsCount === 2, 'Only accepted unique timestamps should count as usable');
        const uptime = evaluateDatasetUptime(fourth.nextStats, strictPolicy, 60000);
        assert(uptime.totalExpectedObservations === 4, 'Timeline should have four slots');
        assert(uptime.sourceAvailabilityFraction === 1, 'Late arrival should count as a unique source timestamp');
        assert(uptime.usableObservationFraction === 0.5, 'Only the two accepted slots count as usable');
    });

    runTest('11. Unique timestamp uptime and configured date-range boundaries', () => {
        const permissivePolicy: IntegrityPolicy = {
            rejectInvalidSource: false,
            rejectDuplicateTimestamp: false,
            rejectOutOfOrder: false
        };
        const quality = extractDataQuality(createMockObservation(100000, qualityFeatures()));
        const first = processSourceObservation(
            createInitialBackboneStats(), 100000, quality, true, permissivePolicy, 60000,
            { isUniqueSource: true, isCandidateUniqueAccepted: true }
        );
        const second = processSourceObservation(
            first.nextStats, 160000, quality, true, permissivePolicy, 60000,
            { isUniqueSource: true, isCandidateUniqueAccepted: true }
        );
        const duplicate = processSourceObservation(
            second.nextStats, 160000, quality, true, permissivePolicy, 60000,
            { isUniqueSource: false, isCandidateUniqueAccepted: false }
        );
        assert(duplicate.nextStats.sourceRowCount === 3, 'Raw source row count should include duplicate arrival');
        assert(duplicate.nextStats.acceptedObservationCount === 3, 'Permissive policy accepts duplicate row');
        assert(duplicate.nextStats.uniqueSourceTimestampsCount === 2, 'Duplicate must not increase unique source count');
        assert(duplicate.nextStats.uniqueAcceptedTimestampsCount === 2, 'Duplicate must not increase usable coverage');
        const uniqueUptime = evaluateDatasetUptime(duplicate.nextStats, permissivePolicy, 60000);
        assert(uniqueUptime.totalExpectedObservations === 2, 'Span should contain two timeline slots');
        assert(uniqueUptime.usableObservationFraction === 1, 'Duplicate must not inflate usable coverage above 100%');

        const rangedStats = {
            ...createInitialBackboneStats(),
            sourceRowCount: 6,
            acceptedObservationCount: 6,
            uniqueSourceTimestampsCount: 6,
            uniqueAcceptedTimestampsCount: 6,
            firstSourceTimestamp: 120000,
            lastSourceTimestamp: 420000
        };
        const rangedUptime = evaluateDatasetUptime(
            rangedStats, strictPolicy, 60000, { startTimestamp: 0, endTimestamp: 540000 }
        );
        assert(rangedUptime.totalExpectedObservations === 10, 'Configured range should include ten expected slots');
        assert(rangedUptime.sourceAvailabilityFraction === 0.6, 'Boundary gaps should reduce source availability to 60%');
        assert(rangedUptime.usableObservationFraction === 0.6, 'Boundary gaps should reduce usable coverage to 60%');

        let misalignedRangeThrew = false;
        try {
            evaluateDatasetUptime(
                rangedStats, strictPolicy, 60000, { startTimestamp: 0, endTimestamp: 90000 }
            );
        } catch {
            misalignedRangeThrew = true;
        }
        assert(misalignedRangeThrew, 'Configured range span must align to the expected interval');

        for (const threshold of [-0.1, 1.1, NaN, Infinity]) {
            let threw = false;
            try {
                evaluateDatasetUptime(
                    rangedStats,
                    { ...strictPolicy, requireMinimumUptimeFraction: threshold },
                    60000
                );
            } catch {
                threw = true;
            }
            assert(threw, `Invalid threshold ${threshold} must throw`);
        }

        const invalidCounterStats = { ...rangedStats, missingIntervalCount: -1 };
        let invalidCounterThrew = false;
        try {
            evaluateDatasetUptime(invalidCounterStats, strictPolicy, 60000);
        } catch {
            invalidCounterThrew = true;
        }
        assert(invalidCounterThrew, 'Negative statistics counters must throw');

        const invalidBoundaryStats = { ...rangedStats, firstSourceTimestamp: 500000 };
        let invalidBoundaryThrew = false;
        try {
            evaluateDatasetUptime(invalidBoundaryStats, strictPolicy, 60000);
        } catch {
            invalidBoundaryThrew = true;
        }
        assert(invalidBoundaryThrew, 'Inverted timestamp boundaries must throw');
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

    runTest('13. Builder rejects candle/observation timestamp mismatch', () => {
        const mismatched: SourceBackboneInputItem[] = [{
            candle: createCandle(100000),
            observation: createMockObservation(160000, qualityFeatures()),
            isValidOhlcv: true
        }];
        let threw = false;
        try {
            buildSourceBackbone(mismatched, 'SOLUSDT', '1m', 1, strictPolicy, 60000);
        } catch (error: unknown) {
            threw = error instanceof Error && error.message.includes('Timestamp mismatch');
        }
        assert(threw, 'Mismatched timestamps must throw');
    });

    runTest('14. Off-grid and out-of-range timestamps are rejected and counted', () => {
        const dateRange = { startTimestamp: 100000, endTimestamp: 280000 };
        const stream: SourceBackboneInputItem[] = [
            { candle: createCandle(100000), observation: createMockObservation(100000, qualityFeatures()) },
            { candle: createCandle(100030), observation: createMockObservation(100030, qualityFeatures()) },
            { candle: createCandle(400000), observation: createMockObservation(400000, qualityFeatures()) }
        ];
        const result = buildSourceBackbone(
            stream, 'SOLUSDT', '1m', 1, strictPolicy, 60000, dateRange
        );

        assert(result.acceptedRows.length === 1, 'Only the on-grid in-range row should be accepted');
        assert(result.rejectedRows.length === 2, 'Off-grid and out-of-range rows should be rejected');
        assert(result.rejectedRows[0].reasons.includes('OFF_GRID_TIMESTAMP'), 'Off-grid reason missing');
        assert(result.rejectedRows[1].reasons.includes('OUT_OF_RANGE_TIMESTAMP'), 'Out-of-range reason missing');
        assert(result.stats.offGridTimestampCount === 1, 'Off-grid timestamp count mismatch');
        assert(result.stats.outOfRangeTimestampCount === 1, 'Out-of-range timestamp count mismatch');
        assert(
            result.stats.uniqueSourceTimestampsCount === 1,
            `Only valid expected slots count as unique source timestamps, got ${result.stats.uniqueSourceTimestampsCount}`
        );
        assert(result.stats.uniqueAcceptedTimestampsCount === 1, 'Only the valid expected slot counts as uniquely accepted');
    });

    runTest('15. Concrete builder on-grid chronology and manifest reconciliation', () => {
        const inputItems: SourceBackboneInputItem[] = [
            { candle: createCandle(100000), observation: createMockObservation(100000, qualityFeatures()) },
            { candle: { ...createCandle(220000), open: 11, high: 13, low: 10, close: 12 }, observation: createMockObservation(220000, qualityFeatures({ HasDataGap: 1 })) },
            { candle: { ...createCandle(220000), open: 11, high: 13, low: 10, close: 12 }, observation: createMockObservation(220000, qualityFeatures()) },
            { candle: { ...createCandle(160000), open: 10, high: 11, low: 9, close: 10 }, observation: createMockObservation(160000, qualityFeatures()) },
            { candle: { ...createCandle(340000), open: 12, high: 14, low: 11, close: 13 }, observation: createMockObservation(340000, qualityFeatures()) },
            { candle: { ...createCandle(400000), open: 13, high: 15, low: 12, close: 14 }, observation: createMockObservation(400000, qualityFeatures({ IsSourceValid: 0 })) }
        ];
        const dateRange = { startTimestamp: 100000, endTimestamp: 460000 };
        const result = buildSourceBackbone(inputItems, 'SOLUSDT', '1m', 1, strictPolicy, 60000, dateRange);

        assert(result.stats.sourceRowCount === 6, 'Source row count must be 6');
        assert(result.acceptedRows.length === 3, 'Exactly 3 observations should be accepted');
        assert(result.rejectedRows.length === 3, 'Exactly 3 observations should be rejected');
        assert(result.stats.uniqueSourceTimestampsCount === 5, 'Unique source timestamps should exclude only the duplicate');
        assert(result.stats.uniqueAcceptedTimestampsCount === 3, 'Late rejected timestamp must not count as uniquely accepted');
        assert(result.acceptedRows[0].sourceTimestamp === 100000, 'First row timestamp mismatch');
        assert(result.acceptedRows[1].sourceTimestamp === 220000, 'Second row timestamp mismatch');
        assert(result.acceptedRows[2].sourceTimestamp === 340000, 'Third row timestamp mismatch');
        assert(result.acceptedRows[0].observationTimestamp === 160000, 'Observation boundary mismatch');
        assert(result.acceptedRows[0].observationId === 'OBS_SOLUSDT_1m_V1_100000', 'Observation ID mismatch');
        assert(result.acceptedRows[0].observation.timestamp === 100000, 'Accepted row must retain its authoritative ML1 observation');
        assert(Object.isFrozen(result.acceptedRows[0].observation), 'Accepted ML1 observation must be immutable');
        assert(Object.isFrozen(result.acceptedRows[0].observation.features), 'Accepted ML1 features must be immutable');
        assert(result.uptime.totalExpectedObservations === 7, 'Configured range should include seven expected timeline slots');
        assert(Math.abs(result.uptime.sourceAvailabilityFraction - 5 / 7) < 1e-4, 'Source availability must use unique on-grid timestamps');
        assert(Math.abs(result.uptime.usableObservationFraction - 3 / 7) < 1e-4, 'Usable uptime must use unique accepted timestamps');
        assert(!result.uptime.isUptimeValid, '3 accepted of 7 total slots should fail the 95% uptime policy');
        assert(Object.isFrozen(result.acceptedRows), 'Accepted row collection must be immutable');
        assert(Object.isFrozen(result.rejectedRows), 'Rejected row collection must be immutable');

        const mockConfig: DatasetConfig = {
            symbol: 'SOLUSDT',
            baseTimeframe: '1m',
            datasetVersion: 1,
            sourceIntervalMs: 60000,
            featureConfigVersion: 'v1',
            teacherVersion: 'v1',
            outcomeConfigVersion: 'v1',
            dateRange,
            integrityPolicy: strictPolicy,
            exportConfig: { exportTierA: true, exportTierB: true, exportTierC: true, separateFiles: true }
        };
        const manifest = createDatasetManifest(
            'DS_SOLUSDT_1M_V1',
            'BINANCE_SPOT',
            mockConfig,
            result.stats,
            result.uptime,
            { passed: true, chronologyValid: true, identityUnique: true, inputOutcomeSeparationValid: true, remarks: [] },
            {
                rawSourceCandleCount: 6,
                acceptedSourceObservationCount: 3,
                rejectedSourceObservationCount: 3,
                tierAContinuousObservationCount: 3,
                tierAEventRepresentationRowCount: 0,
                tierBConfirmedTeacherEventCount: 0,
                tierCOutcomeRowCount: 0,
                actualFileRowCounts: {
                    'continuous.csv': 3,
                    'representation.csv': 0,
                    'events.csv': 0
                }
            }
        );
        assert(manifest.sourceRowCount === 6, 'Manifest source row count mismatch');
        assert(manifest.acceptedObservationCount === 3, 'Manifest accepted count mismatch');
        assert(manifest.startTimestamp === 100000, 'Manifest start must preserve configured date range');
        assert(manifest.endTimestamp === 460000, 'Manifest end must preserve configured date range');
        assert(manifest.totalExpectedObservations === 7, 'Manifest expected count must reflect configured date range');
        assert(Math.abs(manifest.usableObservationFraction - 3 / 7) < 1e-4, 'Manifest usable fraction mismatch');
        assert(manifest.missingDataStats.invalidSourceCount === 1, 'Manifest invalid source count mismatch');
        assert(manifest.missingDataStats.outOfOrderCount === 1, 'Manifest out-of-order count mismatch');
        assert(manifest.exportAccounting.rawSourceCandleCount === 6, 'Manifest raw source count mismatch');
        assert(manifest.exportAccounting.acceptedSourceObservationCount === 3, 'Manifest accepted source count mismatch');
        assert(manifest.exportAccounting.rejectedSourceObservationCount === 3, 'Manifest rejected source count mismatch');
        assert(manifest.exportAccounting.tierAContinuousObservationCount === 3, 'Manifest continuous observation count mismatch');
        assert(manifest.exportAccounting.tierAEventRepresentationRowCount === 0, 'Manifest representation row count mismatch');
        assert(manifest.exportAccounting.tierBConfirmedTeacherEventCount === 0, 'Manifest teacher event count mismatch');
        assert(manifest.exportAccounting.tierCOutcomeRowCount === 0, 'Manifest outcome row count mismatch');
        assert(Object.isFrozen(manifest.exportAccounting), 'Manifest export accounting must be immutable');
        assert(Object.isFrozen(manifest.exportAccounting.actualFileRowCounts), 'Manifest file row counts must be immutable');
        assert(manifest.exportAccounting.actualFileRowCounts['continuous.csv'] === 3, 'Manifest continuous file row count mismatch');

        let accountingMismatchRejected = false;
        try {
            createDatasetManifest(
                'DS_SOLUSDT_1M_INVALID',
                'BINANCE_SPOT',
                mockConfig,
                result.stats,
                result.uptime,
                { passed: true, chronologyValid: true, identityUnique: true, inputOutcomeSeparationValid: true, remarks: [] },
                {
                    ...manifest.exportAccounting,
                    rawSourceCandleCount: 7
                }
            );
        } catch {
            accountingMismatchRejected = true;
        }
        assert(accountingMismatchRejected, 'Manifest must reject inconsistent raw/accepted/rejected accounting');

        let invalidFileRowCountRejected = false;
        try {
            createDatasetManifest(
                'DS_SOLUSDT_1M_INVALID_ROWS',
                'BINANCE_SPOT',
                mockConfig,
                result.stats,
                result.uptime,
                { passed: true, chronologyValid: true, identityUnique: true, inputOutcomeSeparationValid: true, remarks: [] },
                {
                    ...manifest.exportAccounting,
                    actualFileRowCounts: { 'continuous.csv': -1 }
                }
            );
        } catch {
            invalidFileRowCountRejected = true;
        }
        assert(invalidFileRowCountRejected, 'Manifest must reject negative actual file row counts');
    });

    runTest('15a. Candle context and continuous CSV use accepted candle OHLC', () => {
        const result = buildSourceBackbone(
            [{
                candle: createCandle(100000),
                observation: createMockObservation(100000, qualityFeatures({ RelativeVolume_20: 0 }))
            }],
            'SOLUSDT',
            '1m',
            1,
            strictPolicy,
            60000
        );
        const context = CandleContextAggregator.summarize(result.acceptedRows, 0, 0, 1);
        assert(context.maxAdverseAtr === 1, 'Context must use the accepted candle low');
        const continuousCsv = AIExporter.exportMLR1ContinuousObservationsCSV(result.acceptedRows);
        assert(continuousCsv !== null, 'Continuous observation CSV should be generated');
        const lines = continuousCsv.split('\r\n');
        assert(lines.length === 2, 'Continuous observation CSV must contain one header and one data row');
        assert(lines[1].split(',').slice(3, 8).join(',') === '10,12,9,11,100',
            'Continuous CSV OHLCV must come from the accepted candle');
        assert(lines[0].includes('valid_IsSourceValid'), 'Continuous CSV must include feature validity columns');
        assert(lines[1].endsWith('true,true,true,true,true,true'),
            'Continuous CSV validity masks must be serialized as booleans');
    });

    runTest('15b. Continuous export validates masks, IDs, timestamps, and CSV row counts', () => {
        const source = buildSourceBackbone(
            [
                { candle: createCandle(100000), observation: createMockObservation(100000, qualityFeatures()) },
                { candle: createCandle(160000), observation: createMockObservation(160000, qualityFeatures()) }
            ],
            'SOLUSDT',
            '1m',
            1,
            strictPolicy,
            60000
        );
        const rows = source.acceptedRows;
        const csv = AIExporter.exportMLR1ContinuousObservationsCSV(rows);
        assert(csv !== null, 'Continuous CSV should be generated');
        assert(AIExporter.countCsvDataRows(csv) === rows.length, 'CSV row count must exclude its header');
        assert(
            AIExporter.countCsvDataRows('a,b\r\n"line one\r\nline two",c\r\nx,y') === 2,
            'CSV row counting must ignore quoted CRLF characters'
        );

        const malformedMasks = [{
            ...rows[0],
            observation: { ...rows[0].observation, validity: {} }
        }];
        let threw = false;
        try {
            AIExporter.exportMLR1ContinuousObservationsCSV(malformedMasks);
        } catch {
            threw = true;
        }
        assert(threw, 'Mismatched feature and validity keys must be rejected');

        const duplicateIds = [rows[0], { ...rows[1], observationId: rows[0].observationId }];
        threw = false;
        try {
            AIExporter.exportMLR1ContinuousObservationsCSV(duplicateIds);
        } catch {
            threw = true;
        }
        assert(threw, 'Duplicate observation IDs must be rejected');

        const outOfOrder = [rows[1], rows[0]];
        threw = false;
        try {
            AIExporter.exportMLR1ContinuousObservationsCSV(outOfOrder);
        } catch {
            threw = true;
        }
        assert(threw, 'Non-increasing source and availability timestamps must be rejected');
    });

    runTest('15c. Hybrid token builder rejects malformed pivot sequences', () => {
        const rows = buildSourceBackbone(
            [
                {
                    candle: createCandle(100000),
                    observation: createMockObservation(100000, qualityFeatures({ RelativeVolume_20: 0 }))
                },
                {
                    candle: createCandle(160000),
                    observation: createMockObservation(160000, qualityFeatures({ RelativeVolume_20: 0 }))
                }
            ],
            'SOLUSDT',
            '1m',
            1,
            strictPolicy,
            60000
        ).acceptedRows;
        const previousPivot = {
            id: 1, barIndex: 0, time: 100000, price: 9, type: 'low' as const,
            label: 'LL' as const, confirmedBarIndex: 0
        };
        const currentPivot = {
            id: 2, barIndex: 1, time: 160000, price: 12, type: 'high' as const,
            label: 'HH' as const, confirmedBarIndex: 1
        };
        const token = HybridTokenBuilder.build(currentPivot, previousPivot, rows, 1);
        assert(token.completed_leg_direction === 'up', 'Valid alternating pivots should build a token');

        let threw = false;
        try {
            HybridTokenBuilder.build({ ...currentPivot, price: 0 }, previousPivot, rows, 1);
        } catch {
            threw = true;
        }
        assert(threw, 'Non-positive pivot prices must be rejected');

        threw = false;
        try {
            HybridTokenBuilder.build(
                { ...currentPivot, type: 'low' },
                previousPivot,
                rows,
                1
            );
        } catch {
            threw = true;
        }
        assert(threw, 'Non-alternating event types must be rejected');

        threw = false;
        try {
            HybridTokenBuilder.build(currentPivot, previousPivot, [], 1);
        } catch {
            threw = true;
        }
        assert(threw, 'An empty accepted-row array must be rejected');

        threw = false;
        try {
            HybridTokenBuilder.build(
                currentPivot,
                previousPivot,
                [rows[0], null as unknown as typeof rows[number]],
                1
            );
        } catch {
            threw = true;
        }
        assert(threw, 'Invalid accepted source rows must be rejected');
    });

    runTest('15d. Exporter validates pivot provenance before event eligibility', () => {
        const candleCount = 70;
        const startTime = 1700000000000;
        const source = buildSourceBackbone(
            Array.from({ length: candleCount }, (_, index) => {
                const time = startTime + index * 60000;
                return {
                    candle: createCandle(time),
                    observation: createMockObservation(
                        time,
                        qualityFeatures({ ATR_14: 1, RelativeVolume_20: 1 })
                    )
                };
            }),
            'SOLUSDT',
            '1m',
            1,
            strictPolicy,
            60000
        );
        const rows = source.acceptedRows.map((row, index) => ({
            ...row,
            observation: {
                ...row.observation,
                barIndex: index,
                sourceOpen: row.candle.open,
                sourceHigh: row.candle.high,
                sourceLow: row.candle.low,
                sourceClose: row.candle.close,
                sourceVolume: row.candle.volume
            }
        }));
        const data = new Float64Array(rows.length * 6);
        rows.forEach((row, index) => {
            const base = index * 6;
            data.set([
                row.candle.time,
                row.candle.open,
                row.candle.high,
                row.candle.low,
                row.candle.close,
                row.candle.volume
            ], base);
        });
        const dataStore = { data, length: rows.length };
        const pivots = [
            {
                id: 1, barIndex: 1, time: rows[1].sourceTimestamp, price: rows[1].candle.low,
                type: 'low' as const, label: 'LL' as const, confirmedBarIndex: 2
            },
            {
                id: 2, barIndex: 4, time: rows[4].sourceTimestamp, price: rows[4].candle.high,
                type: 'high' as const, label: 'HH' as const, confirmedBarIndex: 5
            }
        ];
        const events = AIExporter.buildMLR1Dataset(dataStore, rows, pivots, 'SOLUSDT', '1m', 60000);
        assert(events.length === 1, 'A complete, eligible alternating pivot pair should produce one event');
        assert(events[0].previous_pivot_bar_index === 1, 'Event should retain the preceding pivot bar index');
        assert(events[0].previous_pivot_confirmed_bar_index === 2,
            'Event should retain the preceding pivot confirmation index');
        assert(events[0].previous_pivot_confirmation_time_ms === rows[2].sourceTimestamp,
            'Event should retain the preceding pivot confirmation timestamp');
        assert(events[0].previous_pivot_type === 'low', 'Event should retain the preceding pivot type');
        const representationCsv = AIExporter.exportMLR1RepresentationCSV(events, 'SOLUSDT', '1m');
        assert(
            representationCsv !== null &&
                DatasetAuditor.runCausalityAudit(events, dataStore, rows, 60000, pivots, representationCsv).passed,
            'Auditor should accept event pivot provenance matching the accepted candles'
        );

        assert(
            !DatasetAuditor.runCausalityAudit(
                events,
                dataStore,
                rows,
                60000,
                undefined as unknown as typeof pivots,
                representationCsv ?? ''
            ).passed,
            'Auditor must fail closed when cached pivots are omitted at runtime'
        );
        assert(
            !DatasetAuditor.runCausalityAudit(
                [{ ...events[0], event_id: 'forged-event-id' }],
                dataStore,
                rows,
                60000,
                pivots,
                representationCsv ?? ''
            ).passed,
            'Auditor must independently recompute and verify event identities'
        );

        const eventCsv = AIExporter.exportMLR1CSV(events, 'SOLUSDT', '1m');
        assert(representationCsv !== null && eventCsv !== null, 'Both separated event artifacts should serialize');
        const representationHeaders = representationCsv.split('\r\n')[0].split(',');
        const eventHeaders = eventCsv.split('\r\n')[0].split(',');
        for (const forbiddenField of [
            ...TIER_C_QUARANTINE_LIST,
            ...MLR1_OUTCOME_LABEL_ALLOWLIST
        ]) {
            assert(
                !representationHeaders.includes(forbiddenField),
                `Representation artifact must exclude quarantined field '${forbiddenField}'`
            );
        }
        assert(
            MLR1_REPRESENTATION_FEATURE_ALLOWLIST.every(header => representationHeaders.includes(header)),
            'Representation artifact must retain every approved model-input field'
        );
        assert(
            MLR1_OUTCOME_LABEL_ALLOWLIST.every(header => eventHeaders.includes(header)),
            'Separate event artifact must retain outcome labels and execution metadata'
        );
        const representationWithOutcomeColumn =
            `${representationCsv.split('\r\n')[0]},long_net_r\r\n${representationCsv.split('\r\n')[1]},0`;
        assert(
            !DatasetAuditor.runCausalityAudit(
                events,
                dataStore,
                rows,
                60000,
                pivots,
                representationWithOutcomeColumn
            ).inputOutcomeSeparationValid,
            'Auditor must reject Tier C fields in the actual representation CSV'
        );
        assert(
            !DatasetAuditor.runCausalityAudit(
                [{ ...events[0], zigzag_next_leg_orientation: 'up' }],
                dataStore,
                rows,
                60000,
                pivots,
                AIExporter.exportMLR1RepresentationCSV(
                    [{ ...events[0], zigzag_next_leg_orientation: 'up' }],
                    'SOLUSDT',
                    '1m'
                ) ?? ''
            ).passed,
            'Auditor must reject HIGH pivots with an up next-leg orientation'
        );
        assert(
            !DatasetAuditor.runCausalityAudit(
                [{ ...events[0], pivot_label: 'LH' }],
                dataStore,
                rows,
                60000,
                pivots,
                AIExporter.exportMLR1RepresentationCSV(
                    [{ ...events[0], pivot_label: 'LH' }],
                    'SOLUSDT',
                    '1m'
                ) ?? ''
            ).passed,
            'Auditor must match the event current pivot to its cached teacher record'
        );

        const incorrectPreviousConfirmation = [{
            ...events[0],
            previous_pivot_confirmed_bar_index: 1
        }];
        assert(
            !DatasetAuditor.runCausalityAudit(
                incorrectPreviousConfirmation,
                dataStore,
                rows,
                60000,
                pivots,
                representationCsv
            ).passed,
            'Auditor must reject incorrect preceding-pivot confirmation provenance'
        );

        const discontinuousRows = rows.map((row, index) => index === 3
            ? { ...row, sourceTimestamp: row.sourceTimestamp + 60000 }
            : row);
        assert(
            !DatasetAuditor.runCausalityAudit(
                events,
                dataStore,
                discontinuousRows,
                60000,
                pivots,
                representationCsv
            ).passed,
            'Auditor must reject a non-contiguous accepted timeline'
        );

        const malformedPivots = [pivots[0], { ...pivots[1], time: pivots[1].time + 1 }];
        let threw = false;
        try {
            AIExporter.buildMLR1Dataset(dataStore, rows, malformedPivots, 'SOLUSDT', '1m', 60000);
        } catch {
            threw = true;
        }
        assert(threw, 'Malformed pivot timestamps must fail before eligibility exclusions');
    });

    runTest('16. Off-grid record preserves the build grid anchor', () => {
        const stream: SourceBackboneInputItem[] = [
            { candle: createCandle(100000), observation: createMockObservation(100000, qualityFeatures()) },
            {
                candle: createCandle(100030),
                observation: createMockObservation(100030, qualityFeatures({ IsUnexpectedInterval: 1 }))
            },
            { candle: createCandle(160000), observation: createMockObservation(160000, qualityFeatures()) }
        ];
        const result = buildSourceBackbone(stream, 'SOLUSDT', '1m', 1, strictPolicy, 60000);

        assert(result.acceptedRows.length === 2, 'Both on-grid candles must be accepted');
        assert(result.rejectedRows.length === 1, 'Off-grid candle must be rejected');
        assert(result.rejectedRows[0].reasons.includes('OFF_GRID_TIMESTAMP'), 'Off-grid rejection reason missing');
        assert(result.acceptedRows[0].sourceTimestamp === 100000, 'First accepted timestamp mismatch');
        assert(result.acceptedRows[1].sourceTimestamp === 160000, 'Later on-grid timestamp must retain original anchor');
        assert(result.stats.offGridTimestampCount === 1, 'Exactly one off-grid timestamp should be counted');
        assert(result.stats.unexpectedIntervalCount === 0, 'Off-grid telemetry and later on-grid delta must not count as unexpected');
    });

    runTest('17. Out-of-range on-grid record cannot shift timestamp boundaries', () => {
        const dateRange = { startTimestamp: 100000, endTimestamp: 280000 };
        const stream: SourceBackboneInputItem[] = [
            { candle: createCandle(100000), observation: createMockObservation(100000, qualityFeatures()) },
            { candle: createCandle(40000), observation: createMockObservation(40000, qualityFeatures()) },
            { candle: createCandle(160000), observation: createMockObservation(160000, qualityFeatures()) }
        ];
        const result = buildSourceBackbone(
            stream, 'SOLUSDT', '1m', 1, strictPolicy, 60000, dateRange
        );

        assert(result.acceptedRows.length === 2, 'Both in-range rows should be accepted');
        assert(result.rejectedRows.length === 1, 'Out-of-range row should be rejected');
        assert(
            result.rejectedRows[0].reasons.includes('OUT_OF_RANGE_TIMESTAMP'),
            'Out-of-range row must include the out-of-range rejection reason'
        );
        assert(result.rejectedRows[0].reasons.includes('OUT_OF_ORDER'), 'Out-of-range row must also be rejected as out of order');
        assert(result.stats.firstSourceTimestamp === 100000, 'firstSourceTimestamp must NOT move backwards to out-of-range 40000');
        assert(result.stats.lastSourceTimestamp === 160000, 'Last valid row should advance the watermark');
        assert(result.stats.outOfRangeTimestampCount === 1, 'Exactly one out-of-range timestamp should be counted');
        assert(result.stats.uniqueSourceTimestampsCount === 2, 'Out-of-range record must not increment unique source count');
        assert(result.stats.uniqueAcceptedTimestampsCount === 2, 'Exactly two unique timestamps should be accepted');
    });

    runTest('18. Raw source rejection accounting precedes feature processing', () => {
        const base = 1700000000000;
        const rawRows: ML1Candle[] = [
            createCandle(base),
            { ...createCandle(base + 60000), high: 8 },
            createCandle(base + 120000),
            createCandle(base + 120000),
            createCandle(base + 150000),
            createCandle(base + 60000),
            createCandle(base + 360000)
        ];
        const report = accountRawSourceRows(
            rawRows,
            'SOLUSDT',
            '1m',
            strictPolicy,
            60000,
            { startTimestamp: base, endTimestamp: base + 300000 }
        );

        assert(report.stats.sourceRowCount === rawRows.length, 'Raw source count must include every input row');
        assert(
            report.stats.sourceRowCount ===
                report.stats.acceptedObservationCount + report.stats.rejectedObservationCount,
            'Raw source accounting must reconcile accepted and rejected rows'
        );
        assert(report.stats.invalidOhlcvCount === 1, 'Malformed OHLCV must be counted');
        assert(report.stats.duplicateTimestampCount >= 1, 'Duplicate timestamp must be counted');
        assert(report.stats.outOfOrderCount === 1, 'Out-of-order timestamp must be counted');
        assert(report.stats.offGridTimestampCount === 1, 'Off-grid timestamp must be counted');
        assert(report.stats.outOfRangeTimestampCount === 1, 'Out-of-range timestamp must be counted');
        assert(
            report.acceptedSourceIndices.join(',') === '0,2',
            'Only valid, unique, in-range source indices may proceed to feature computation'
        );
        assert(
            report.rejectedRows.length === 5 &&
                report.rejectedRows.some(row => row.reasons.includes('INVALID_OHLCV')) &&
                report.rejectedRows.some(row => row.reasons.includes('DUPLICATE_TIMESTAMP')) &&
                report.rejectedRows.some(row => row.reasons.includes('OUT_OF_ORDER')) &&
                report.rejectedRows.some(row => row.reasons.includes('OFF_GRID_TIMESTAMP')) &&
                report.rejectedRows.some(row => row.reasons.includes('OUT_OF_RANGE_TIMESTAMP')),
            'Every rejected raw row must retain its M4B quality reason'
        );
    });

    console.log('\n=======================================');
    console.log('📊 ML-R1 PHASE 4B FULL ACCEPTANCE AUDIT:');
    console.log(`   ↳ Tests Executed:  ${passed + failed}`);
    console.log(`   ↳ Tests Passed:    ${passed}`);
    console.log(`   ↳ Tests Failed:    ${failed}`);
    console.log('=======================================\n');

    return failed === 0 && passed === 22;
}
