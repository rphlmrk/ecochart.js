import JSZip from 'jszip';
import { AIExporter, SourceIntegrityError } from '../data/AIExporter';
import { BackgroundDataMiner } from '../data/BackgroundDataMiner';

function assert(condition: boolean, message: string): asserts condition {
    if (!condition) throw new Error(`[ProductionExporterAssertionFailed] ${message}`);
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
    const originalFetch = globalThis.fetch;
    let requestUrl: URL | null = null;
    Date.now = () => now;
    globalThis.fetch = (async input => {
        requestUrl = new URL(String(input));
        return new Response(JSON.stringify(klines), { status: 200 });
    }) as typeof fetch;
    try {
        const buffer = await BackgroundDataMiner.mineHistoricalCandles(
            'SOLUSDT',
            '1m',
            endTime - startTime,
            () => {},
            startTime,
            endTime
        );
        if (!requestUrl) throw new Error('Mock fetch was not called.');
        return { buffer, requestUrl };
    } finally {
        Date.now = originalNow;
        globalThis.fetch = originalFetch;
    }
}

function mockKline(openTime: number, closeTime: number): unknown[] {
    return [openTime, '10', '12', '9', '11', '100', closeTime];
}

export async function runProductionExporterAcceptanceSuite(): Promise<boolean> {
    console.log('\n======================================================');
    console.log('🧪 Starting Production Exporter Integrity Acceptance Suite');
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

    await runTest('Raw rejected candles are accounted before feature processing', async () => {
        const base = 1_800_000_000_000;
        const raw = new Float64Array([
            base, 10, 8, 9, 11, 100,
            base + 60000, 10, 12, 9, 11, 100
        ]);
        let caught: unknown;
        try {
            await AIExporter.buildExportArtifacts({
                rawCandleBuffer: raw,
                symbol: 'SOLUSDT',
                interval: '1m',
                intervalMs: 60000
            });
        } catch (error: unknown) {
            caught = error;
        }
        assert(caught instanceof SourceIntegrityError, 'Invalid source must fail through M4B accounting');
        assert(caught.sourceReport.stats.sourceRowCount === 2, 'Source report must include every raw row');
        assert(caught.sourceReport.stats.rejectedObservationCount === 1, 'Invalid source must be rejected');
        assert(
            caught.sourceReport.rejectedRows[0].reasons.includes('INVALID_OHLCV'),
            'Rejected row must retain its OHLCV rejection reason'
        );
    });

    await runTest('Non-positive OHLC prices are rejected and reconciled as raw source rows', async () => {
        const base = 1_800_000_000_000;
        const raw = new Float64Array([base, -10, -9, -11, -10, 100]);
        let caught: unknown;
        try {
            await AIExporter.buildExportArtifacts({
                rawCandleBuffer: raw,
                symbol: 'SOLUSDT',
                interval: '1m',
                intervalMs: 60000
            });
        } catch (error: unknown) {
            caught = error;
        }
        assert(caught instanceof SourceIntegrityError, 'Non-positive prices must fail source validation');
        assert(caught.sourceReport.stats.sourceRowCount === 1, 'Raw source count must include rejected prices');
        assert(caught.sourceReport.stats.invalidOhlcvCount === 1, 'Rejected prices must increment invalid OHLCV');
        assert(caught.sourceReport.stats.rejectedObservationCount === 1, 'Rejected prices must be accounted once');
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
        const originalFetch = globalThis.fetch;
        const now = 1_800_000_000_000;
        const intervalMs = 60000;
        const expectedCount = 7 * 24 * 60;
        const expectedLastOpen = Math.floor(now / intervalMs) * intervalMs - intervalMs;
        const expectedFirstOpen = expectedLastOpen - (expectedCount - 1) * intervalMs;
        const requests: URL[] = [];
        Date.now = () => now;
        globalThis.fetch = (async input => {
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
                () => {},
                expectedFirstOpen,
                expectedLastOpen
            );
            assert(buffer.length / 6 === expectedCount, 'Complete inclusive seven-day range must contain 10,080 candles');
            assert(buffer[0] === expectedFirstOpen, 'First open timestamp must match the requested boundary');
            assert(buffer[buffer.length - 6] === expectedLastOpen, 'Last open timestamp must match the requested boundary');
            assert(requests.length === Math.ceil(expectedCount / 1000), 'Fetch must paginate through the complete range');
            assert(requests[0].searchParams.get('startTime') === String(expectedFirstOpen), 'First request start must be inclusive');
            assert(requests.every(url => url.searchParams.get('endTime') === String(expectedLastOpen)),
                'Every page must preserve the inclusive end bound');
        } finally {
            Date.now = originalNow;
            globalThis.fetch = originalFetch;
        }
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

    await runTest('Generated archive has exact physical entries, bytes, and row counts', async () => {
        const continuousFileName = 'continuous.csv';
        const representationFileName = 'representation.csv';
        const eventFileName = 'events.csv';
        const actualFileRowCounts = {
            [continuousFileName]: 1,
            [representationFileName]: 1,
            [eventFileName]: 1
        };
        const artifacts = {
            manifest: {
                symbol: 'SOLUSDT',
                timeframe: '1m',
                buildTimestamp: 1_800_000_000_000,
                exportAccounting: {
                    rawSourceCandleCount: 1,
                    acceptedSourceObservationCount: 1,
                    rejectedSourceObservationCount: 0,
                    tierAContinuousObservationCount: 1,
                    tierAEventRepresentationRowCount: 1,
                    tierBConfirmedTeacherEventCount: 1,
                    tierCOutcomeRowCount: 1,
                    actualFileRowCounts
                }
            },
            continuousCsv: 'source_timestamp\r\n1',
            representationCsv: 'pivot_type\r\nlow',
            eventCsv: 'long_outcome\r\nhard_stop',
            continuousFileName,
            representationFileName,
            eventFileName
        };
        const bytes = await AIExporter.createVerifiedDatasetArchive(artifacts);
        const reopened = await JSZip.loadAsync(bytes);
        const names = Object.keys(reopened.files).filter(name => !reopened.files[name].dir).sort();
        assert(names.length === 4, 'Archive must contain the manifest and all three CSVs');
        assert(names.includes(continuousFileName), 'Continuous observations CSV is missing');
        assert(names.includes(representationFileName), 'Representation CSV is missing');
        assert(names.includes(eventFileName), 'Event outcomes CSV is missing');
        assert(
            await reopened.file(eventFileName)!.async('string') === artifacts.eventCsv,
            'Physical event CSV bytes must equal deterministic artifact bytes'
        );

        let duplicateNameThrew = false;
        try {
            await AIExporter.createVerifiedDatasetArchive({
                ...artifacts,
                eventFileName: continuousFileName
            });
        } catch {
            duplicateNameThrew = true;
        }
        assert(duplicateNameThrew, 'Duplicate archive entry names must be rejected before ZIP generation');
    });

    await runTest('500-candle production export is deterministic with a mature CBC outcome', async () => {
        const candleCount = 500;
        const intervalMs = 60000;
        const start = 1_700_000_000_000;
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
        const fixedBuildTimestamp = 1_700_000_000_000;
        const build = () => AIExporter.buildExportArtifacts({
            rawCandleBuffer,
            symbol: 'SOLUSDT',
            interval: '1m',
            intervalMs,
            buildTimestamp: fixedBuildTimestamp
        });
        const first = await build();
        const second = await build();
        assert(first.events.length > 0, 'Deterministic source must produce confirmed CBC events');
        assert(first.events.some(event =>
            event.entry_bar_index + 60 - 1 < first.backboneResult.acceptedRows.length
        ), 'At least one confirmed event must have a complete 60-bar outcome horizon');
        assert(first.manifest.sourceRowCount === candleCount, 'Manifest raw count must match the source buffer');
        assert(first.manifest.auditResults.passed, 'Both production audits must pass');
        assert(
            JSON.stringify(first.events.map(event => event.event_id)) ===
                JSON.stringify(second.events.map(event => event.event_id)),
            'Event identities must be deterministic'
        );
        assert(first.events.length === second.events.length, 'Event counts must be deterministic');
        assert(first.continuousCsv === second.continuousCsv, 'Continuous CSV bytes must be deterministic');
        assert(first.representationCsv === second.representationCsv, 'Representation CSV bytes must be deterministic');
        assert(first.eventCsv === second.eventCsv, 'Event CSV bytes must be deterministic');
        assert(JSON.stringify(first.manifest) === JSON.stringify(second.manifest), 'Manifest contents must be deterministic');
        assert(JSON.stringify(first.exportAccounting) === JSON.stringify(second.exportAccounting),
            'Export accounting must be deterministic');
        assert(JSON.stringify(first.auditResult) === JSON.stringify(second.auditResult),
            'Audit results must be deterministic');
        const firstArchive = await AIExporter.createVerifiedDatasetArchive(first);
        const secondArchive = await AIExporter.createVerifiedDatasetArchive(second);
        assert(firstArchive.length === secondArchive.length &&
            firstArchive.every((byte, index) => byte === secondArchive[index]),
        'ZIP physical artifact bytes must be deterministic');
    });

    await runTest('Live package UI exposes only the supported ZIP package', () => {
        assert(
            document.querySelector('[data-pack="csv"]') === null,
            'Unsupported single-CSV mode must not be selectable'
        );
        assert(
            document.querySelectorAll('.ai-pack-card[data-pack="zip"]').length === 1,
            'The required ML-R1 ZIP package must be the sole visible package choice'
        );
    });

    console.log(`Production Exporter Integrity: ${passed} passed, ${failed} failed.`);
    return failed === 0;
}
