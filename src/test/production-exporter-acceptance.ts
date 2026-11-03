import JSZip from 'jszip';
import {
    AIExporter,
    DatasetAuditor,
    HybridTokenBuilder,
    SourceIntegrityError,
    auditConfirmedPivotSequence,
    auditNativeConfirmedPivots,
    buildRepresentationInput,
    MLR1_MODEL_INPUT_SCHEMA,
    MLR1_REPRESENTATION_COLUMNS,
    MLR1_DATASET_VERSION,
    validateMLR1ModelInput
} from '../data/AIExporter';
import {
    MLR1_MODEL_INPUT_SCHEMA_VERSION,
    MLR1_REPRESENTATION_SCHEMA_VERSION
} from '../indicators/mlr1/dataset/DatasetSchema';
import { BackgroundDataMiner } from '../data/BackgroundDataMiner';
import { DataStore } from '../data/DataStore';
import { StrictCBCZigZagIndicator } from '../indicators/plugins/StrictCBCZigZagIndicator';

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
            globalThis.fetch = originalFetch;
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
            const originalFetch = globalThis.fetch;
            Date.now = () => now;
            globalThis.fetch = (async input => {
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
                globalThis.fetch = originalFetch;
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
            representationCsv: 'tierB_pivot_type\r\nlow',
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
        const start = 1_700_000_040_000;
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
        assert(first.manifest.datasetVersion === MLR1_DATASET_VERSION && MLR1_DATASET_VERSION === 2,
            'Representation contract correction must emit dataset version 2');
        assert(first.manifest.representationSchemaVersion === MLR1_REPRESENTATION_SCHEMA_VERSION,
            'Manifest must record the representation schema version');
        assert(first.manifest.modelInputSchemaVersion === MLR1_MODEL_INPUT_SCHEMA_VERSION,
            'Manifest must record the model-input schema version');
        const representationHeaders = first.representationCsv.split('\r\n')[0].split(',');
        assert(
            representationHeaders.join(',') === MLR1_REPRESENTATION_COLUMNS.join(','),
            'Representation columns and feature order must be explicit and deterministic'
        );
        assert(
            representationHeaders.slice(1, 1 + MLR1_MODEL_INPUT_SCHEMA.tierA.length)
                .every(header => header.startsWith('tierA_')) &&
                representationHeaders.slice(1 + MLR1_MODEL_INPUT_SCHEMA.tierA.length)
                    .every(header => header.startsWith('tierB_')),
            'Model-input CSV must preserve distinct ordered Tier A and Tier B channels'
        );
        const selectedInput = buildRepresentationInput(
            first.events[0],
            first.backboneResult.acceptedRows[first.events[0].confirmed_bar_index].observationId
        );
        assert(selectedInput.schemaVersion === MLR1_MODEL_INPUT_SCHEMA.version,
            'Model-input builder must declare its schema version');
        assert(Object.keys(selectedInput.tierA).join(',') === MLR1_MODEL_INPUT_SCHEMA.tierA.join(','),
            'Tier A model-input selection must be separately explicit and ordered');
        assert(Object.keys(selectedInput.tierB).join(',') === MLR1_MODEL_INPUT_SCHEMA.tierB.join(','),
            'Tier B model-input selection must be separately explicit and ordered');
        assert(validateMLR1ModelInput(selectedInput), 'Valid versioned Tier A/Tier B input must pass validation');
        assert(
            selectedInput.tierAObservationId ===
                first.backboneResult.acceptedRows[first.events[0].confirmed_bar_index].observationId,
            'Tier A model input must link to its exact causal observation row'
        );
        assert(
            !validateMLR1ModelInput({
                ...selectedInput,
                tierB: { ...selectedInput.tierB, outcome_class: 'future-result' }
            }),
            'Unknown and Tier C fields must fail closed at the model-input boundary'
        );
        assert(
            Object.keys(selectedInput.tierB).length === 6,
            'All six approved teacher descriptors must remain in the Tier B channel'
        );
        const acceptedRows = first.backboneResult.acceptedRows;
        const dataStore = new DataStore(acceptedRows.length);
        dataStore.data = new Float64Array(acceptedRows.length * 6);
        dataStore.length = acceptedRows.length;
        acceptedRows.forEach((row, index) => {
            dataStore.data.set([
                row.candle.time,
                row.candle.open,
                row.candle.high,
                row.candle.low,
                row.candle.close,
                row.candle.volume
            ], index * 6);
        });
        const teacher = new StrictCBCZigZagIndicator();
        teacher.calculate(dataStore);
        const nativePivots = teacher.cachedPivots;
        const nativeSequenceAudit = auditConfirmedPivotSequence(nativePivots, acceptedRows);
        assert(nativeSequenceAudit.firstViolation === null,
            'The native teacher confirmed sequence must satisfy occurrence and confirmation ordering');
        assert(nativeSequenceAudit.pivotCount > 2, 'The fixture must exercise multiple confirmed teacher pivots');
        assert(
            DatasetAuditor.runCausalityAudit(
                first.events,
                dataStore,
                acceptedRows,
                intervalMs,
                nativePivots,
                first.representationCsv
            ).passed,
            'The auditor must accept the same native confirmed sequence used by event generation'
        );
        assert(first.mtfContexts !== undefined && first.mtfContexts.length === candleCount,
            'Production 1m artifacts must retain one causal MTF context per accepted row');
        const contextIndex = first.mtfContexts.findIndex(context =>
            context.context15m.lastCompletedCandle !== null
        );
        assert(contextIndex >= 0, 'Fixture must contain a completed 15m context');
        const forgedMtfContexts = first.mtfContexts.map((context, index) => index === contextIndex
            ? {
                ...context,
                context15m: {
                    ...context.context15m,
                    lastCompletedCloseTimestamp: context.observationTimestamp + intervalMs
                }
            }
            : context
        );
        assert(
            !DatasetAuditor.runCausalityAudit(
                first.events,
                dataStore,
                acceptedRows,
                intervalMs,
                nativePivots,
                first.representationCsv,
                forgedMtfContexts
            ).passed,
            'Auditor must reject MTF context that claims a completion after its observation timestamp'
        );
        assert(
            first.events.every(event =>
                event.entry_time === acceptedRows[event.confirmed_bar_index].observationTimestamp &&
                event.confirmed_bar_index >= event.pivot_bar_index
            ),
            'Tier B descriptors must be aligned no earlier than the native teacher confirmation boundary'
        );
        const firstRepresentationLines = first.representationCsv.split('\r\n');
        const futureLabelEvent = first.events.slice(1).find(event =>
            event.pivot_label !== first.events[0].pivot_label
        );
        assert(futureLabelEvent !== undefined, 'Fixture must contain a distinct future teacher label');
        const pivotLabelColumn = representationHeaders.indexOf('tierB_pivot_label');
        const forgedFutureRow = firstRepresentationLines[1].split(',');
        forgedFutureRow[pivotLabelColumn] = futureLabelEvent.pivot_label;
        const futurePivotLeakCsv = [
            firstRepresentationLines[0],
            forgedFutureRow.join(','),
            ...firstRepresentationLines.slice(2)
        ].join('\r\n');
        assert(
            !DatasetAuditor.runCausalityAudit(
                first.events,
                dataStore,
                acceptedRows,
                intervalMs,
                nativePivots,
                futurePivotLeakCsv
            ).passed,
            'Auditor must reject a future confirmed-pivot descriptor in an earlier representation row'
        );
        const delayedTeacherEvent = first.events.find(event =>
            event.confirmed_bar_index > event.pivot_bar_index
        );
        assert(delayedTeacherEvent !== undefined,
            'Fixture must contain a teacher event confirmed after its source pivot bar');
        const beforeConfirmationEvent = {
            ...delayedTeacherEvent,
            confirmed_bar_index: delayedTeacherEvent.pivot_bar_index,
            confirmation_time_ms: acceptedRows[delayedTeacherEvent.pivot_bar_index].sourceTimestamp,
            entry_bar_index: delayedTeacherEvent.pivot_bar_index + 1,
            entry_time: acceptedRows[delayedTeacherEvent.pivot_bar_index].observationTimestamp
        };
        const beforeConfirmationCsv = AIExporter.exportMLR1RepresentationCSV(
            [beforeConfirmationEvent],
            'SOLUSDT',
            '1m',
            acceptedRows
        );
        assert(
            beforeConfirmationCsv !== null &&
                !DatasetAuditor.runCausalityAudit(
                    [beforeConfirmationEvent],
                    dataStore,
                    acceptedRows,
                    intervalMs,
                    nativePivots,
                    beforeConfirmationCsv
                ).passed,
            'Auditor must reject teacher descriptors made available before native confirmation'
        );
        const misclassifiedHeaders = [...representationHeaders];
        misclassifiedHeaders[1] = 'tierB_context_net_return_atr';
        const misclassifiedCsv = [
            misclassifiedHeaders.join(','),
            ...firstRepresentationLines.slice(1)
        ].join('\r\n');
        assert(
            !DatasetAuditor.runCausalityAudit(
                first.events,
                dataStore,
                acceptedRows,
                intervalMs,
                nativePivots,
                misclassifiedCsv
            ).inputOutcomeSeparationValid,
            'Auditor classification contract must reject Tier A/Tier B channel swaps independently'
        );

        const sameTypeSequence = nativePivots.map(pivot => ({ ...pivot }));
        const sameTypeIndex = 1;
        const sameTypePivot = sameTypeSequence[sameTypeIndex];
        const precedingPivot = sameTypeSequence[sameTypeIndex - 1];
        const sameTypeRow = acceptedRows[sameTypePivot.barIndex];
        sameTypePivot.type = precedingPivot.type;
        sameTypePivot.price = precedingPivot.type === 'high'
            ? sameTypeRow.candle.high
            : sameTypeRow.candle.low;
        const priorSameType = sameTypeSequence.slice(0, sameTypeIndex)
            .reverse().find(pivot => pivot.type === sameTypePivot.type);
        sameTypePivot.label = sameTypePivot.type === 'high'
            ? (priorSameType === undefined || sameTypePivot.price >= priorSameType.price ? 'HH' : 'LH')
            : (priorSameType === undefined || sameTypePivot.price <= priorSameType.price ? 'LL' : 'HL');
        const sameTypeAudit = auditConfirmedPivotSequence(sameTypeSequence, acceptedRows);
        assert(sameTypeAudit.sameTypeAdjacentPairCount > 0,
            'Same-type pairs are invalid under the native StrictCBC state-transition contract');
        let builderRejectedSameType = false;
        try {
            AIExporter.buildMLR1Dataset(dataStore, acceptedRows, sameTypeSequence, 'SOLUSDT', '1m', intervalMs);
        } catch (error: unknown) {
            builderRejectedSameType = error instanceof Error &&
                (error.message.includes('same-type adjacent confirmed pivots') ||
                    error.message.includes('Cached pivots differ from the native confirmed-pivot sequence'));
        }
        assert(builderRejectedSameType, 'Event builder must reject a same-type confirmed sequence');
        assert(
            !DatasetAuditor.runCausalityAudit(
                first.events,
                dataStore,
                acceptedRows,
                intervalMs,
                sameTypeSequence,
                first.representationCsv
            ).passed,
            'Auditor must reject the same invalid sequence contract as the event builder'
        );

        const sourceOrderSequence = nativePivots.map(pivot => ({ ...pivot }));
        sourceOrderSequence[1].barIndex = sourceOrderSequence[0].barIndex - 1;
        assert(
            auditConfirmedPivotSequence(sourceOrderSequence, acceptedRows).sourceOrderViolationCount > 0,
            'A decreasing source pivot bar must be classified as a source-order violation'
        );
        const confirmationOrderSequence = nativePivots.map(pivot => ({ ...pivot }));
        confirmationOrderSequence[1].confirmedBarIndex = confirmationOrderSequence[0].confirmedBarIndex;
        assert(
            auditConfirmedPivotSequence(confirmationOrderSequence, acceptedRows)
                .confirmationOrderViolationCount > 0,
            'A non-increasing confirmation bar must be classified as a confirmation-order violation'
        );
        assert(
            auditNativeConfirmedPivots(dataStore, nativePivots).matches,
            'Cached pivots must independently match exact native teacher output fields'
        );
        const forgedCachedPivots = nativePivots.map(pivot => ({ ...pivot }));
        forgedCachedPivots[0].price += 0.01;
        assert(
            !auditNativeConfirmedPivots(dataStore, forgedCachedPivots).matches,
            'A forged cached pivot price must differ from independently recomputed native output'
        );

        const liveFailurePair = [
            {
                id: 1,
                barIndex: 926,
                time: 1_793_183_700_000,
                price: 103.14,
                type: 'low' as const,
                label: 'LL' as const,
                confirmedBarIndex: 926
            },
            {
                id: 2,
                barIndex: 926,
                time: 1_793_183_700_000,
                price: 103.23,
                type: 'high' as const,
                label: 'HH' as const,
                confirmedBarIndex: 927
            }
        ];
        const liveFailureAudit = auditConfirmedPivotSequence(liveFailurePair, []);
        assert(liveFailureAudit.firstViolation === null,
            'The exact live low/high same-source-bar pair is valid in native confirmation order');
        assert(liveFailureAudit.sourceOrderViolationCount === 0,
            'A same-source-bar opposite-extreme pair is not a source-order violation');
        const paddedLiveRows = Array.from({ length: 928 }, (_, index) => {
            const source = acceptedRows[Math.min(index, acceptedRows.length - 1)];
            const offset = Math.max(0, index - (acceptedRows.length - 1)) * intervalMs;
            const time = source.sourceTimestamp + offset;
            const candle = { ...source.candle, time };
            const observation = {
                ...source.observation,
                timestamp: time,
                barIndex: index,
                sourceOpen: candle.open,
                sourceHigh: candle.high,
                sourceLow: candle.low,
                sourceClose: candle.close,
                sourceVolume: candle.volume
            };
            return {
                ...source,
                candle,
                sourceTimestamp: time,
                observationTimestamp: time + intervalMs,
                observation
            };
        });
        const liveFailureToken = HybridTokenBuilder.build(
            liveFailurePair[1],
            liveFailurePair[0],
            paddedLiveRows,
            1
        );
        assert(liveFailureToken.bars_since_last_pivot === 1,
            'The live same-source-bar pair must retain its one-bar confirmation delay');
        assert(liveFailureToken.zigzag_next_leg_orientation === 'down',
            'The live confirmed HIGH must retain native down-leg orientation');

        assert(
            JSON.stringify(first.events.map(event => event.event_id)) ===
                JSON.stringify(second.events.map(event => event.event_id)),
            'Event identities must be deterministic'
        );
        assert(first.events.length === second.events.length, 'Event counts must be deterministic');
        assert(first.continuousCsv === second.continuousCsv, 'Continuous CSV bytes must be deterministic');
        const continuousHeader = first.continuousCsv.split('\r\n', 1)[0].split(',');
        assert(continuousHeader.includes('context15m') && continuousHeader.includes('context1h'),
            'M1 continuous observations must include existing M3 15m and 1h context columns');
        assert(first.continuousCsv.includes('lastCompletedCloseTimestamp'),
            'Serialized MTF context must include completed-candle availability timestamps');
        assert(first.continuousCsv.includes('WARMING_UP') || first.continuousCsv.includes('AVAILABLE_VALID'),
            'Serialized MTF context must preserve warmup or validity status');
        assert(first.manifest.featureVersion.includes('M3A_3E_MTFv1'),
            'Manifest must version the added MTF context fields');
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

    if (typeof document !== 'undefined') {
        await runTest('Live package UI exposes only the supported ZIP package', () => {
            assert(
                document.querySelector('[data-pack="csv"]') === null,
                'Unsupported single-CSV mode must not be selectable'
            );
            assert(
                document.querySelectorAll('.ai-pack-card[data-pack="zip"]').length === 1,
                'The required ML-R1 ZIP package must be the sole visible package choice'
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

    console.log(`Production Exporter Integrity: ${passed} passed, ${failed} failed.`);
    return failed === 0;
}
