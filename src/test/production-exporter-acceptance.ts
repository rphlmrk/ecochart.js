import JSZip from 'jszip';
import {
    AIExporter,
    DatasetAuditor
} from '../data/AIExporter';
import {
    createML1ZipExportRequest,
    validateML1ExportRequestAgainstManifest
} from '../indicators/mlr1/integration/ML1IntegrationTypes';
import {
    MLR1_V3_MODEL_INPUT_SCHEMA_VERSION,
    MLR1_V3_REPRESENTATION_SCHEMA_VERSION,
    TIER_C_V3_QUARANTINE_LIST
} from '../indicators/mlr1/dataset/DatasetSchema';
import {
    accountRawSourceRows,
    type RawSourceAccountingReport
} from '../indicators/mlr1/dataset/ObservationBackbone';
import type { IntegrityPolicy } from '../indicators/mlr1/dataset/DatasetConfig';
import type { ML1Candle } from '../indicators/mlr1/ML1FeatureTypes';
import {
    V3_DATASET_VERSION,
    V3_REPRESENTATION_COLUMNS
} from '../indicators/mlr1/pipeline/MultiHorizonOutcomeEngine';
import { V3_15M_ONLY_MTF_VERSION } from '../indicators/mlr1/pipeline/V3PipelineEngine';
import { parseCsvDocumentCRLF } from '../indicators/mlr1/pipeline/V3ArtifactAuditor';
import { BackgroundDataMiner } from '../data/BackgroundDataMiner';

function assert(condition: boolean, message: string): asserts condition {
    if (!condition) throw new Error(`[ProductionExporterAssertionFailed] ${message}`);
}

const STRICT_SOURCE_POLICY: IntegrityPolicy = {
    rejectInvalidSource: true,
    rejectInvalidOhlcv: true,
    rejectDuplicateTimestamp: true,
    rejectOutOfOrder: true,
    requireMinimumUptimeFraction: 1
};

function bufferToRawCandles(buffer: Float64Array): ML1Candle[] {
    const count = Math.floor(buffer.length / 6);
    const out: ML1Candle[] = [];
    for (let i = 0; i < count; i++) {
        const off = i * 6;
        out.push({
            time: buffer[off],
            open: buffer[off + 1],
            high: buffer[off + 2],
            low: buffer[off + 3],
            close: buffer[off + 4],
            volume: buffer[off + 5],
            isSynthetic: false
        });
    }
    return out;
}

function accountBufferRawRows(buffer: Float64Array, intervalMs: number): RawSourceAccountingReport {
    return accountRawSourceRows(
        bufferToRawCandles(buffer),
        'SOLUSDT',
        '1m',
        STRICT_SOURCE_POLICY,
        intervalMs
    );
}

interface MockedMiningResult {
    readonly buffer: Float64Array;
    readonly requestUrl: URL;
}

async function mineWithMockedResponse(
    klines: unknown[],
    now: number,
    startTime: number,
    endTime: number
): Promise<MockedMiningResult> {
    const originalNow = Date.now;
    const originalFetch = BackgroundDataMiner.fetchImpl;
    let requestUrl: URL | null = null;
    Date.now = () => now;
    BackgroundDataMiner.fetchImpl = (async input => {
        requestUrl = new URL(String(input));
        return new Response(JSON.stringify(klines), { status: 200 });
    }) as typeof fetch;
    try {
        const buffer = await BackgroundDataMiner.mineHistoricalCandles(
            'SOLUSDT',
            '1m',
            (endTime - startTime) + 60000,
            () => {},
            startTime,
            endTime
        );
        if (!requestUrl) throw new Error('Mock fetch was not called.');
        return { buffer, requestUrl };
    } finally {
        Date.now = originalNow;
        BackgroundDataMiner.fetchImpl = originalFetch;
    }
}

function mockKline(openTime: number, closeTime: number): unknown[] {
    return [openTime, '10', '12', '9', '11', '100', closeTime];
}

function buildDeterministicCandleBuffer(candleCount: number, start = 1_700_000_040_000, intervalMs = 60_000): Float64Array {
    const rawCandleBuffer = new Float64Array(candleCount * 6);
    for (let index = 0; index < candleCount; index++) {
        const close = index % 8 < 4
            ? 100 + (index % 4)
            : 104 - (index % 4);
        const open = index % 2 === 1 ? close - 0.5 : close + 0.5;
        const high = Math.max(open, close) + 1;
        const low = Math.min(open, close) - 1;
        rawCandleBuffer.set(
            [start + index * intervalMs, open, high, low, close, 100 + index % 7],
            index * 6
        );
    }
    return rawCandleBuffer;
}

export async function runProductionExporterAcceptanceSuite(): Promise<boolean> {
    console.log('\n======================================================');
    console.log('🧪 Starting Production V3 Exporter Integrity Acceptance Suite');
    console.log('======================================================\n');
    let passed = 0;
    let failed = 0;

    const runTest = async (name: string, testFn: () => void | Promise<void>) => {
        try {
            await testFn();
            passed++;
            console.log(`  ✅ Passed: ${name}`);
        } catch (error: unknown) {
            failed++;
            console.error(
                `  ❌ Failed: ${name} - ${error instanceof Error ? error.message : String(error)}`
            );
        }
    };

    await runTest('Raw rejected candles are accounted before V3 feature processing', async () => {
        const base = 1_800_000_000_000;
        const raw = new Float64Array([
            base, 10, 8, 9, 11, 100,
            base + 60000, 10, 12, 9, 11, 100
        ]);
        const report = accountBufferRawRows(raw, 60000);
        assert(report.stats.sourceRowCount === 2, 'Source report must include every raw row');
        assert(report.stats.rejectedObservationCount === 1, 'Invalid source must be rejected');
        assert(
            report.rejectedRows[0].reasons.includes('INVALID_OHLCV'),
            'Rejected row must retain its OHLCV rejection reason'
        );

        let rejectedBuild = false;
        try {
            await AIExporter.buildV3ExportArtifacts({
                rawCandleBuffer: raw,
                symbol: 'SOLUSDT',
                interval: '1m',
                intervalMs: 60000
            });
        } catch (error: unknown) {
            rejectedBuild = error instanceof Error && error.message.includes('V3 Source Integrity Error');
        }
        assert(rejectedBuild, 'V3 exporter must fail closed on invalid OHLCV source buffers');
    });

    await runTest('Non-positive OHLC prices are rejected and reconciled as raw source rows', async () => {
        const base = 1_800_000_000_000;
        const raw = new Float64Array([base, -10, -9, -11, -10, 100]);
        const report = accountBufferRawRows(raw, 60000);
        assert(report.stats.sourceRowCount === 1, 'Raw source count must include rejected prices');
        assert(report.stats.invalidOhlcvCount === 1, 'Rejected prices must increment invalid OHLCV');
        assert(report.stats.rejectedObservationCount === 1, 'Rejected prices must be accounted once');

        let rejectedBuild = false;
        try {
            await AIExporter.buildV3ExportArtifacts({
                rawCandleBuffer: raw,
                symbol: 'SOLUSDT',
                interval: '1m',
                intervalMs: 60000
            });
        } catch (error: unknown) {
            rejectedBuild = error instanceof Error && error.message.includes('V3 Source Integrity Error');
        }
        assert(rejectedBuild, 'V3 exporter must fail closed on non-positive OHLC prices');
    });

    await runTest('Historical fetch applies inclusive bounds and excludes incomplete klines', async () => {
        const now = 1_800_000_000_000;
        const currentOpen = Math.floor(now / 60000) * 60000;
        const end = currentOpen - 60000;
        const start = end - 60000;
        const result = await mineWithMockedResponse([
            mockKline(start, start + 59999),
            mockKline(end, now)
        ], now, start, end);

        assert(result.requestUrl.searchParams.get('startTime') === String(start), 'startTime must be inclusive and exact');
        assert(result.requestUrl.searchParams.get('endTime') === String(end), 'endTime must be inclusive and exact');
        assert(result.buffer.length === 6, 'The incomplete kline must not enter the returned buffer');
        assert(result.buffer[0] === start, 'The included candle must retain the requested start boundary');
    });

    await runTest('Seven-day fetch uses inclusive open-time bounds and returns exactly 10,080 rows when complete', async () => {
        const originalNow = Date.now;
        const originalFetch = BackgroundDataMiner.fetchImpl;
        const now = 1_800_000_000_000;
        const intervalMs = 60000;
        const expectedCount = 7 * 24 * 60;
        const expectedLastOpen = Math.floor(now / intervalMs) * intervalMs - intervalMs;
        const expectedFirstOpen = expectedLastOpen - (expectedCount - 1) * intervalMs;
        const requests: URL[] = [];
        Date.now = () => now;
        BackgroundDataMiner.fetchImpl = (async input => {
            const url = new URL(String(input));
            requests.push(url);
            const requestedStart = Number(url.searchParams.get('startTime'));
            const requestedEnd = Number(url.searchParams.get('endTime'));
            let openTime = Math.ceil(requestedStart / intervalMs) * intervalMs;
            const klines: unknown[][] = [];
            while (openTime <= requestedEnd && klines.length < 1000) {
                klines.push(mockKline(openTime, openTime + intervalMs - 1));
                openTime += intervalMs;
            }
            return new Response(JSON.stringify(klines), { status: 200 });
        }) as typeof fetch;
        try {
            const buffer = await BackgroundDataMiner.mineHistoricalCandles(
                'SOLUSDT',
                '1m',
                expectedCount * intervalMs,
                () => {}
            );
            AIExporter.assertCandleBufferMatchesExactRange(
                buffer,
                intervalMs,
                expectedFirstOpen,
                expectedLastOpen,
                expectedCount
            );
            assert(buffer.length / 6 === expectedCount, 'Complete inclusive seven-day range must contain 10,080 candles');
            assert(buffer[0] === expectedFirstOpen, 'First open timestamp must match the requested boundary');
            assert(buffer[buffer.length - 6] === expectedLastOpen, 'Last open timestamp must match the requested boundary');
            assert(requests.length === Math.ceil(expectedCount / 1000), 'Fetch must paginate through the complete range');
            assert(requests[0].searchParams.get('startTime') === String(expectedFirstOpen), 'First request start must be inclusive');
            assert(requests.every(url => url.searchParams.get('endTime') === String(expectedLastOpen)),
                'Every page must preserve the inclusive end bound');
            for (let index = 1; index < requests.length; index++) {
                const previousPageLast = Math.min(
                    expectedFirstOpen + index * 1000 * intervalMs - intervalMs,
                    expectedLastOpen
                );
                assert(
                    Number(requests[index].searchParams.get('startTime')) === previousPageLast + 1,
                    `Page ${index + 1} must resume one millisecond after the prior returned open`
                );
            }
        } finally {
            Date.now = originalNow;
            BackgroundDataMiner.fetchImpl = originalFetch;
        }
    });

    await runTest('Missing first or last seven-day candle fails exact boundary reconciliation', async () => {
        const now = 1_800_000_000_000;
        const intervalMs = 60000;
        const expectedCount = 7 * 24 * 60;
        const expectedLastOpen = Math.floor(now / intervalMs) * intervalMs - intervalMs;
        const expectedFirstOpen = expectedLastOpen - (expectedCount - 1) * intervalMs;
        const verifyMissingBoundary = async (missingTimestamp: number) => {
            const opens = Array.from({ length: expectedCount }, (_, index) =>
                expectedFirstOpen + index * intervalMs
            ).filter(timestamp => timestamp !== missingTimestamp);
            const rows = opens.map(timestamp => mockKline(timestamp, timestamp + intervalMs - 1));
            const originalNow = Date.now;
            const originalFetch = BackgroundDataMiner.fetchImpl;
            Date.now = () => now;
            BackgroundDataMiner.fetchImpl = (async input => {
                const url = new URL(String(input));
                const startTime = Number(url.searchParams.get('startTime'));
                const endTime = Number(url.searchParams.get('endTime'));
                const filtered = rows.filter(row => Number(row[0]) >= startTime && Number(row[0]) <= endTime);
                return new Response(JSON.stringify(filtered.slice(0, 1000)), { status: 200 });
            }) as typeof fetch;
            try {
                const buffer = await BackgroundDataMiner.mineHistoricalCandles(
                    'SOLUSDT',
                    '1m',
                    expectedCount * intervalMs,
                    () => {},
                    expectedFirstOpen,
                    expectedLastOpen
                );
                let rejected = false;
                try {
                    AIExporter.assertCandleBufferMatchesExactRange(
                        buffer,
                        intervalMs,
                        expectedFirstOpen,
                        expectedLastOpen,
                        expectedCount
                    );
                } catch {
                    rejected = true;
                }
                assert(rejected, `Missing boundary candle ${missingTimestamp} must fail reconciliation`);
            } finally {
                Date.now = originalNow;
                BackgroundDataMiner.fetchImpl = originalFetch;
            }
        };
        await verifyMissingBoundary(expectedFirstOpen);
        await verifyMissingBoundary(expectedLastOpen);
    });

    await runTest('Historical fetch preserves duplicates for source-quality accounting', async () => {
        const now = 1_800_000_000_000;
        const end = Math.floor(now / 60000) * 60000 - 60000;
        const result = await mineWithMockedResponse([
            mockKline(end, end + 59999),
            mockKline(end, end + 59999)
        ], now, end, end);
        assert(result.buffer.length === 12, 'Duplicate API rows must remain visible for M4B rejection accounting');
        assert(result.buffer[0] === result.buffer[6], 'Duplicate source timestamps must not be silently deduplicated');
    });

    await runTest('Historical fetch rejects response candles outside requested boundaries', async () => {
        const now = 1_800_000_000_000;
        const end = Math.floor(now / 60000) * 60000 - 60000;
        let threw = false;
        try {
            await mineWithMockedResponse([
                mockKline(end - 60000, end - 1)
            ], now, end, end);
        } catch (error: unknown) {
            threw = error instanceof Error && error.message.includes('outside requested open-time bounds');
        }
        assert(threw, 'Out-of-range API rows must be rejected at the fetch boundary');
    });

    await runTest('Custom date post-validation rejects out-of-range data', () => {
        const start = 1_800_000_000_000;
        const end = start + 60000;
        AIExporter.assertCandleBufferWithinBounds(
            new Float64Array([start, 10, 12, 9, 11, 100, end, 10, 12, 9, 11, 100]),
            { startTimestamp: start, endTimestamp: end }
        );
        let threw = false;
        try {
            AIExporter.assertCandleBufferWithinBounds(
                new Float64Array([start - 60000, 10, 12, 9, 11, 100]),
                { startTimestamp: start, endTimestamp: end }
            );
        } catch {
            threw = true;
        }
        assert(threw, 'Any candle outside the selected custom range must fail validation');
    });

    await runTest('Generated V3 archive has exact physical entries, bytes, and row counts', async () => {
        const rawCandleBuffer = buildDeterministicCandleBuffer(650);
        const artifacts = await AIExporter.buildV3ExportArtifacts({
            rawCandleBuffer,
            symbol: 'SOLUSDT',
            interval: '1m',
            intervalMs: 60_000,
            buildTimestamp: 1_700_000_000_000
        });
        const bytes = await AIExporter.createVerifiedV3DatasetArchive(artifacts, rawCandleBuffer);
        const reopened = await JSZip.loadAsync(bytes);
        const names = Object.keys(reopened.files).filter(name => !reopened.files[name].dir).sort();
        assert(names.length === 4, 'Archive must contain the manifest and all three V3 CSVs');
        assert(names.includes(artifacts.continuousFileName), 'Continuous observations CSV is missing');
        assert(names.includes(artifacts.representationFileName), 'Representation CSV is missing');
        assert(names.includes(artifacts.strategyEventsFileName), 'StrategyEvents CSV is missing');
        assert(names.includes(artifacts.manifestFileName), 'Manifest JSON is missing');
        assert(
            await reopened.file(artifacts.strategyEventsFileName)!.async('string') === artifacts.strategyEventsCsv,
            'Physical StrategyEvents CSV bytes must equal deterministic artifact bytes'
        );

        let duplicateNameThrew = false;
        try {
            await AIExporter.createVerifiedV3DatasetArchive({
                ...artifacts,
                strategyEventsFileName: artifacts.continuousFileName
            }, rawCandleBuffer);
        } catch {
            duplicateNameThrew = true;
        }
        assert(duplicateNameThrew, 'Mismatched or duplicate archive entry names must be rejected before ZIP generation');
    });

    await runTest('650-candle V3 production export is deterministic with mature 180-bar outcomes and causality audits', async () => {
        const candleCount = 650;
        const intervalMs = 60_000;
        const rawCandleBuffer = buildDeterministicCandleBuffer(candleCount, 1_700_000_040_000, intervalMs);
        const fixedBuildTimestamp = 1_700_000_000_000;
        const build = () => AIExporter.buildV3ExportArtifacts({
            rawCandleBuffer,
            symbol: 'SOLUSDT',
            interval: '1m',
            intervalMs,
            buildTimestamp: fixedBuildTimestamp
        });
        const first = await build();
        const second = await build();

        assert(first.strategyEventRows.length > 0, 'Deterministic source must produce confirmed multi-teacher events');
        assert(first.strategyEventRows.some(row =>
            row.entry_bar_index + 180 - 1 < first.manifest.acceptedObservationCount
        ), 'At least one confirmed event must have a complete 180-bar outcome horizon');
        assert(first.manifest.sourceRowCount === candleCount, 'Manifest raw count must match the source buffer');
        assert(first.manifest.auditResults.passed, 'V3 production audits must pass');
        assert(first.manifest.datasetVersion === V3_DATASET_VERSION && V3_DATASET_VERSION === 3,
            'V3 production exporter must emit dataset version 3');
        assert(first.manifest.representationSchemaVersion === MLR1_V3_REPRESENTATION_SCHEMA_VERSION,
            'Manifest must record the V3 representation schema version');
        assert(first.manifest.modelInputSchemaVersion === MLR1_V3_MODEL_INPUT_SCHEMA_VERSION,
            'Manifest must record the V3 model-input schema version');
        assert(first.manifest.featureVersion.includes(V3_15M_ONLY_MTF_VERSION) &&
            first.manifest.featureVersion.includes('ML1_CONFIG_C_v1'),
        'Manifest featureVersion must reflect 15m-only V3 MTF and Config C');

        const representationHeaders = first.representationCsv.split('\r\n')[0].split(',');
        assert(
            representationHeaders.join(',') === V3_REPRESENTATION_COLUMNS.join(','),
            'V3 representation columns and feature order must be explicit and deterministic'
        );
        for (const quarantined of TIER_C_V3_QUARANTINE_LIST) {
            assert(!representationHeaders.includes(quarantined),
                `V3 representation CSV must exclude Tier C column '${quarantined}'`);
        }

        const continuousHeaders = first.continuousCsv.split('\r\n', 1)[0].split(',');
        assert(continuousHeaders.includes('context15m') && continuousHeaders.includes('htf15mDiagnostic'),
            'V3 continuous observations must include 15m MTF context columns');
        assert(!continuousHeaders.includes('context1h') && !continuousHeaders.includes('htf1hDiagnostic'),
            'V3 continuous observations must remain strictly 15m-only and exclude 1h MTF columns');
        assert(first.continuousCsv.includes('lastCompletedCloseTimestamp'),
            'Serialized MTF context must include completed-candle availability timestamps');
        assert(first.continuousCsv.includes('WARMING_UP') || first.continuousCsv.includes('AVAILABLE_VALID'),
            'Serialized MTF context must preserve warmup or validity status');

        const validAudit = DatasetAuditor.runV3CausalityAudit({
            rawCandleBuffer,
            intervalMs,
            expectedContinuousRows: candleCount,
            expectedEventRows: first.strategyEventRows.length,
            continuousCsv: first.continuousCsv,
            representationCsv: first.representationCsv,
            strategyEventsCsv: first.strategyEventsCsv,
            include15mMtf: true,
            is1mBase: true
        });
        assert(validAudit.passed, 'V3 causality auditor must accept canonical V3 artifacts');

        const repRecords = parseCsvDocumentCRLF(first.representationCsv);
        const tierCInjectedCsv = [
            `${repRecords[0].join(',')},long_net_r_180`,
            ...repRecords.slice(1).map(row => `${row.join(',')},0`)
        ].join('\r\n');
        const tierCAudit = DatasetAuditor.runV3CausalityAudit({
            rawCandleBuffer,
            intervalMs,
            expectedContinuousRows: candleCount,
            expectedEventRows: first.strategyEventRows.length,
            continuousCsv: first.continuousCsv,
            representationCsv: tierCInjectedCsv,
            strategyEventsCsv: first.strategyEventsCsv,
            include15mMtf: true,
            is1mBase: true
        });
        assert(!tierCAudit.passed && !tierCAudit.inputOutcomeSeparationValid,
            'V3 causality auditor must reject Tier C outcome columns injected into representation CSV');

        const swappedRepHeaders = [...repRecords[0]];
        swappedRepHeaders[1] = 'tierA_atr_14';
        swappedRepHeaders[2] = repRecords[0][1];
        const swappedRepCsv = [
            swappedRepHeaders.join(','),
            ...repRecords.slice(1).map(row => row.join(','))
        ].join('\r\n');
        assert(!DatasetAuditor.runV3CausalityAudit({
            rawCandleBuffer,
            intervalMs,
            expectedContinuousRows: candleCount,
            expectedEventRows: first.strategyEventRows.length,
            continuousCsv: first.continuousCsv,
            representationCsv: swappedRepCsv,
            strategyEventsCsv: first.strategyEventsCsv,
            include15mMtf: true,
            is1mBase: true
        }).passed, 'V3 causality auditor must reject reordered representation headers');

        const evRecords = parseCsvDocumentCRLF(first.strategyEventsCsv);
        const evHeader = evRecords[0];
        const confCol = evHeader.indexOf('confirmation_bar_index');
        const entryCol = evHeader.indexOf('entry_bar_index');
        const forgedEvRow = [...evRecords[1]];
        forgedEvRow[entryCol] = forgedEvRow[confCol];
        const forgedEvCsv = [
            evHeader.join(','),
            forgedEvRow.join(','),
            ...evRecords.slice(2).map(r => r.join(','))
        ].join('\r\n');
        assert(!DatasetAuditor.runV3CausalityAudit({
            rawCandleBuffer,
            intervalMs,
            expectedContinuousRows: candleCount,
            expectedEventRows: first.strategyEventRows.length,
            continuousCsv: first.continuousCsv,
            representationCsv: first.representationCsv,
            strategyEventsCsv: forgedEvCsv,
            include15mMtf: true,
            is1mBase: true
        }).passed, 'V3 causality auditor must reject entry bar chronology violations');

        const validRequest = createML1ZipExportRequest(first.manifest);
        validateML1ExportRequestAgainstManifest(validRequest, first.manifest);
        let v2Rejected = false;
        try {
            validateML1ExportRequestAgainstManifest({
                ...validRequest,
                datasetRef: { ...validRequest.datasetRef, datasetVersion: 2 }
            }, first.manifest);
        } catch {
            v2Rejected = true;
        }
        assert(v2Rejected, 'Manifest-bound request validator must reject retired V2 dataset version');

        assert(
            JSON.stringify(first.strategyEventRows.map(event => event.event_id)) ===
                JSON.stringify(second.strategyEventRows.map(event => event.event_id)),
            'V3 event identities must be deterministic'
        );
        assert(first.strategyEventRows.length === second.strategyEventRows.length, 'Event counts must be deterministic');
        assert(first.continuousCsv === second.continuousCsv, 'Continuous CSV bytes must be deterministic');
        assert(first.representationCsv === second.representationCsv, 'Representation CSV bytes must be deterministic');
        assert(first.strategyEventsCsv === second.strategyEventsCsv, 'StrategyEvents CSV bytes must be deterministic');
        assert(JSON.stringify(first.manifest) === JSON.stringify(second.manifest), 'Manifest contents must be deterministic');
        assert(JSON.stringify(first.outcomeAccounting) === JSON.stringify(second.outcomeAccounting),
            'Outcome accounting must be deterministic');
        assert(JSON.stringify(first.auditResult) === JSON.stringify(second.auditResult),
            'Audit results must be deterministic');

        const firstArchive = await AIExporter.createVerifiedV3DatasetArchive(first, rawCandleBuffer);
        const secondArchive = await AIExporter.createVerifiedV3DatasetArchive(second, rawCandleBuffer);
        assert(firstArchive.length === secondArchive.length &&
            firstArchive.every((byte, index) => byte === secondArchive[index]),
        'V3 ZIP physical artifact bytes must be deterministic');
    });

    if (typeof document !== 'undefined') {
        await runTest('Live package UI exposes only the V3 streaming folder export', () => {
            assert(
                document.querySelector('[data-pack="csv"]') === null &&
                    document.querySelector('[data-pack="zip"]') === null,
                'Unsupported single-CSV and legacy ZIP modes must not be selectable'
            );
            assert(
                document.querySelectorAll('.ai-pack-card[data-pack="stream_folder"]').length === 1,
                'The streaming V3 4-file folder export must be the sole visible package choice'
            );
            assert(
                document.querySelector('#ai-export-schema-version') === null &&
                    document.querySelector('#check-ai-v3-15m-mtf') !== null,
                'V2 schema selector must be retired and V3 15m MTF checkbox must be present'
            );
            assert(
                document.querySelector('#ai-export-rr') === null &&
                    document.querySelector('#ai-export-horizon') === null,
                'Fixed outcome-contract settings must not be shown as configurable controls'
            );
        });
    } else {
        console.log('  ⏭️ Skipped: Live package UI check requires a browser DOM.');
    }

    console.log(`Production V3 Exporter Integrity: ${passed} passed, ${failed} failed.`);
    return failed === 0;
}
