import JSZip from 'jszip';
import { AIExporter, DatasetAuditor, MLR1_DATASET_VERSION, MLR1_REPRESENTATION_COLUMNS } from '../data/AIExporter';
import {
    BufferedTextSink,
    runStreamingExportParityTest,
    runV3StreamingExportParityTest,
    StreamingDatasetExporter
} from '../data/StreamingDatasetExporter';
import { parseCsvDocumentCRLF, serializeCsvRecord } from '../indicators/mlr1/pipeline/V3ArtifactAuditor';
import { V3_MAX_HORIZON_BARS } from '../indicators/mlr1/pipeline/MultiHorizonOutcomeEngine';
import { accountRawSourceRows } from '../indicators/mlr1/dataset/ObservationBackbone';
import type { ML1Candle } from '../indicators/mlr1/ML1FeatureTypes';

function assert(condition: boolean, msg: string): asserts condition {
    if (!condition) throw new Error(`[Phase5DPhase4Failed] ${msg}`);
}

function makeTestBuffer(count: number, gapAtIndex?: number): Float64Array {
    const intervalMs = 60_000;
    let ts = 1_700_000_040_000;
    const buf = new Float64Array(count * 6);
    for (let i = 0; i < count; i++) {
        if (gapAtIndex !== undefined && i === gapAtIndex) ts += 10 * intervalMs;
        const close = i % 8 < 4 ? 100 + (i % 4) : 104 - (i % 4);
        const open = i % 2 === 1 ? close - 0.5 : close + 0.5;
        buf.set(
            [ts, open, Math.max(open, close) + 1, Math.min(open, close) - 1, close, 100 + (i % 7) * 15],
            i * 6
        );
        ts += intervalMs;
    }
    return buf;
}

class MockFileHandle {
    public bytes: Uint8Array = new Uint8Array(0);
    public async createWritable() {
        const chunks: Uint8Array[] = [];
        let aborted = false;
        return {
            write: async (data: Uint8Array | ArrayBuffer) => {
                if (aborted) throw new Error('Writable aborted');
                chunks.push(data instanceof Uint8Array ? data.slice() : new Uint8Array(data));
            },
            close: async () => {
                if (aborted) throw new Error('Writable aborted');
                const total = chunks.reduce((s, c) => s + c.length, 0);
                const out = new Uint8Array(total);
                let off = 0;
                for (const c of chunks) { out.set(c, off); off += c.length; }
                this.bytes = out;
            },
            abort: async () => {
                aborted = true;
                chunks.length = 0;
            }
        };
    }
    public async getFile(): Promise<File> {
        const copy = new Uint8Array(this.bytes.length);
        copy.set(this.bytes);
        return new File([copy], 'mock');
    }
}

class MockDirectoryHandle {
    public readonly files = new Map<string, MockFileHandle>();
    public readonly dirs = new Map<string, MockDirectoryHandle>();

    public async getDirectoryHandle(name: string, opts?: { create?: boolean }): Promise<MockDirectoryHandle> {
        if (!this.dirs.has(name)) {
            if (!opts?.create) throw new Error(`Missing dir ${name}`);
            this.dirs.set(name, new MockDirectoryHandle());
        }
        return this.dirs.get(name)!;
    }

    public async getFileHandle(name: string, opts?: { create?: boolean }): Promise<MockFileHandle> {
        if (!this.files.has(name)) {
            if (!opts?.create) throw new Error(`Missing file ${name}`);
            this.files.set(name, new MockFileHandle());
        }
        return this.files.get(name)!;
    }

    public async removeEntry(name: string): Promise<void> {
        this.files.delete(name);
        this.dirs.delete(name);
    }
}

class SpySinkStream {
    public aborted = false;
    public closed = false;
    public writes = 0;
    public write = async (_data: Uint8Array) => { this.writes++; };
    public close = async () => { this.closed = true; };
    public abort = async () => { this.aborted = true; };
}

export async function runPhase5DPhase4Tests(): Promise<boolean> {
    console.log('\n======================================================');
    console.log('🧪 Starting Phase 5D Phase 4 Acceptance Suite (V3 Exporters & Audits)');
    console.log('======================================================\n');
    let passed = 0;
    let failed = 0;

    const runTest = async (name: string, fn: () => void | Promise<void>) => {
        try {
            await fn();
            passed++;
            console.log(`  ✅ Passed: ${name}`);
        } catch (e: any) {
            failed++;
            console.error(`  ❌ Failed: ${name} - ${e?.message || String(e)}`);
        }
    };

    const buffer = makeTestBuffer(650);
    const fixedTs = 1_700_000_000_000;

    await runTest('1. V3 Batch Export, Real Uptime, Boundary Replay & Synchronized-Forgery Archive Protection', async () => {
        const artifacts = await AIExporter.buildV3ExportArtifacts({
            rawCandleBuffer: buffer,
            symbol: 'SOLUSDT',
            interval: '1m',
            intervalMs: 60_000,
            buildTimestamp: fixedTs
        });

        assert(artifacts.manifest.datasetVersion === 3, 'Expected datasetVersion === 3');
        assert(artifacts.manifest.usableObservationFraction === 1 && artifacts.manifest.totalExpectedObservations === 650,
            'Contiguous 650-candle coverage must be 650/650');
        assert(artifacts.manifest.auditResults.passed, 'V3 audit must pass');

        // Verify replay boundary: first eligible event and latest eligible event up to bar 649 (horizonEnd180 <= 649)
        const firstEv = artifacts.strategyEventRows[0];
        const lastEv = artifacts.strategyEventRows[artifacts.strategyEventRows.length - 1];
        assert(firstEv.entry_bar_index + V3_MAX_HORIZON_BARS - 1 < 650, 'First event horizon valid');
        assert(lastEv.entry_bar_index + V3_MAX_HORIZON_BARS - 1 <= 649, 'Last event horizon within 650 bars');

        const archiveBytes = await AIExporter.createVerifiedV3DatasetArchive(artifacts, buffer);
        const reopened = await JSZip.loadAsync(archiveBytes);
        assert(Object.keys(reopened.files).filter(n => !reopened.files[n].dir).length === 4, 'V3 ZIP must have 4 entries');

        // Synchronized forgery check: mutate CSV cell + update verifiedFileChecksums + update manifest SHA-256 remark
        const evRecords = parseCsvDocumentCRLF(artifacts.strategyEventsCsv);
        const netRCol = evRecords[0].indexOf('long_net_r_180');
        evRecords[1][netRCol] = '999.0';
        const forgedEvCsv = evRecords.map(serializeCsvRecord).join('\r\n');
        const forgedDigest = Array.from(
            new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(forgedEvCsv)))
        ).map(b => b.toString(16).padStart(2, '0')).join('');

        let forgeryRejected = false;
        try {
            await AIExporter.createVerifiedV3DatasetArchive({
                ...artifacts,
                strategyEventsCsv: forgedEvCsv,
                verifiedFileChecksums: {
                    ...artifacts.verifiedFileChecksums,
                    strategyEventsSha256: forgedDigest
                },
                manifest: {
                    ...artifacts.manifest,
                    auditResults: {
                        ...artifacts.manifest.auditResults,
                        remarks: artifacts.manifest.auditResults.remarks.map(r =>
                            r.includes(artifacts.strategyEventsFileName)
                                ? `SHA-256 ${artifacts.strategyEventsFileName}: ${forgedDigest}`
                                : r
                        )
                    }
                }
            }, buffer);
        } catch (e: any) {
            forgeryRejected = String(e.message).includes('pre-ZIP audit');
        }
        assert(forgeryRejected, 'createVerifiedV3DatasetArchive must reject synchronized CSV+checksum+manifest forgery');
    });

    await runTest('2. Schema-Aware CSV Tampering, RFC-4180 Malformed Quotes, Cross-Bar Duplicate IDs & Reordered Headers', async () => {
        const artifacts = await AIExporter.buildV3ExportArtifacts({
            rawCandleBuffer: buffer,
            symbol: 'SOLUSDT',
            interval: '1m',
            intervalMs: 60_000,
            buildTimestamp: fixedTs
        });

        const baseAuditParams = {
            rawCandleBuffer: buffer,
            intervalMs: 60_000,
            expectedContinuousRows: 650,
            expectedEventRows: artifacts.strategyEventRows.length,
            continuousCsv: artifacts.continuousCsv,
            representationCsv: artifacts.representationCsv,
            strategyEventsCsv: artifacts.strategyEventsCsv,
            include15mMtf: true,
            is1mBase: true
        };

        // 2a. Parse & mutate tierA_atr_14 cell inside Representation_Features.csv
        const repRecords = parseCsvDocumentCRLF(artifacts.representationCsv);
        const repAtrCol = repRecords[0].indexOf('tierA_atr_14');
        repRecords[1][repAtrCol] = '9999.99';
        assert(!DatasetAuditor.runV3CausalityAudit({
            ...baseAuditParams,
            representationCsv: repRecords.map(serializeCsvRecord).join('\r\n')
        }).inputOutcomeSeparationValid, 'Auditor must reject mutated Representation data cell');

        // 2b. Parse & mutate long_net_r_180 cell by exact header lookup in StrategyEvents.csv
        const evRecords = parseCsvDocumentCRLF(artifacts.strategyEventsCsv);
        const evNetRCol = evRecords[0].indexOf('long_net_r_180');
        evRecords[1][evNetRCol] = '999.0';
        assert(!DatasetAuditor.runV3CausalityAudit({
            ...baseAuditParams,
            strategyEventsCsv: evRecords.map(serializeCsvRecord).join('\r\n')
        }).passed, 'Auditor must reject mutated StrategyEvents long_net_r_180 cell');

        // 2c. Parse & inject NaN into numeric entry_price column in StrategyEvents.csv
        const nanRecords = parseCsvDocumentCRLF(artifacts.strategyEventsCsv);
        const entryPriceCol = nanRecords[0].indexOf('entry_price');
        nanRecords[1][entryPriceCol] = 'NaN';
        assert(!DatasetAuditor.runV3CausalityAudit({
            ...baseAuditParams,
            strategyEventsCsv: nanRecords.map(serializeCsvRecord).join('\r\n')
        }).passed, 'Auditor must reject NaN inside StrategyEvents entry_price');

        // 2d. Append valid unapproved feature + validity pair in Continuous_Observations.csv (valid CSV structure)
        const contRecords = parseCsvDocumentCRLF(artifacts.continuousCsv);
        const contWithExtra = contRecords.map((r, idx) =>
            idx === 0 ? [...r, 'future_leak', 'valid_future_leak'] : [...r, '1.0', 'true']
        );
        assert(!DatasetAuditor.runV3CausalityAudit({
            ...baseAuditParams,
            continuousCsv: contWithExtra.map(serializeCsvRecord).join('\r\n')
        }).inputOutcomeSeparationValid, 'Auditor must reject unapproved Continuous feature+validity columns');

        // 2e. Parse context15m JSON cell properly, inject Tier C key inside context15m.features & re-serialize
        const contLeaked = parseCsvDocumentCRLF(artifacts.continuousCsv);
        const ctxCol = contLeaked[0].indexOf('context15m');
        const ctxParsed = JSON.parse(contLeaked[20][ctxCol]);
        ctxParsed.features['long_net_r_60'] = 1.0;
        contLeaked[20][ctxCol] = JSON.stringify(ctxParsed);
        assert(!DatasetAuditor.runV3CausalityAudit({
            ...baseAuditParams,
            continuousCsv: contLeaked.map(serializeCsvRecord).join('\r\n')
        }).inputOutcomeSeparationValid, 'Auditor must reject Tier C key nested inside context15m.features JSON');

        // 2f. Reordered Representation headers (same row counts & values) must fail
        const reorderedRep = parseCsvDocumentCRLF(artifacts.representationCsv).map(r => {
            const copy = [...r];
            [copy[1], copy[2]] = [copy[2], copy[1]];
            return copy;
        });
        assert(!DatasetAuditor.runV3CausalityAudit({
            ...baseAuditParams,
            representationCsv: reorderedRep.map(serializeCsvRecord).join('\r\n')
        }).inputOutcomeSeparationValid, 'Auditor must reject reordered Representation headers');

        // 2g. Duplicate event_id across DIFFERENT confirmation bars must fail identityUnique
        const dupEv = parseCsvDocumentCRLF(artifacts.strategyEventsCsv);
        const dupRep = parseCsvDocumentCRLF(artifacts.representationCsv);
        assert(dupEv.length > 3, 'Fixture must have >= 2 events');
        const evIdCol = dupEv[0].indexOf('event_id');
        const repIdCol = dupRep[0].indexOf('tierB_event_id');
        dupEv[2][evIdCol] = dupEv[1][evIdCol]; // Copy bar-1 event_id onto later bar-2 event
        dupRep[2][repIdCol] = dupRep[1][repIdCol];
        assert(!DatasetAuditor.runV3CausalityAudit({
            ...baseAuditParams,
            representationCsv: dupRep.map(serializeCsvRecord).join('\r\n'),
            strategyEventsCsv: dupEv.map(serializeCsvRecord).join('\r\n')
        }).identityUnique, 'Auditor must reject duplicate event_id across different confirmation bars');

        // 2h. Malformed quote inside unquoted CSV field must throw RFC-4180 parse error
        let badQuoteThrew = false;
        try {
            parseCsvDocumentCRLF('a,b\r\nfoo"bar,baz');
        } catch (e: any) {
            badQuoteThrew = String(e.message).includes('quote inside unquoted field');
        }
        assert(badQuoteThrew, 'RFC-4180 parser must reject quotes inside unquoted fields');
    });

    await runTest('3. Gap-Tolerant Chronology + Rejected Raw Candle Filtering Between Confirmation and Entry', async () => {
        // Construct raw stream with BOTH a 10m timestamp gap at index 300 AND an invalid OHLCV raw candle at index 250
        const intervalMs = 60_000;
        const rawCandles: ML1Candle[] = [];
        let ts = 1_700_000_040_000;
        for (let i = 0; i < 660; i++) {
            if (i === 300) ts += 10 * intervalMs;
            const close = i % 8 < 4 ? 100 + (i % 4) : 104 - (i % 4);
            const open = i % 2 === 1 ? close - 0.5 : close + 0.5;
            rawCandles.push({
                time: ts,
                open,
                high: i === 250 ? open - 5 : Math.max(open, close) + 1, // Bar 250 has high < open (invalid OHLCV)
                low: Math.min(open, close) - 1,
                close,
                volume: 100 + (i % 7) * 15
            });
            ts += intervalMs;
        }
        const report = accountRawSourceRows(
            rawCandles,
            'SOLUSDT',
            '1m',
            { rejectInvalidSource: true, rejectInvalidOhlcv: true, rejectDuplicateTimestamp: true, rejectOutOfOrder: true },
            intervalMs
        );
        assert(report.rejectedRows.length === 1 && report.stats.invalidOhlcvCount === 1, 'Expected bar 250 rejected');

        const acceptedBuf = new Float64Array(report.acceptedSourceIndices.length * 6);
        report.acceptedSourceIndices.forEach((rawIdx, pos) => {
            const c = rawCandles[rawIdx];
            acceptedBuf.set([c.time, c.open, c.high, c.low, c.close, c.volume], pos * 6);
        });

        const gappedArtifacts = await AIExporter.buildV3ExportArtifacts({
            rawCandleBuffer: acceptedBuf,
            symbol: 'SOLUSDT',
            interval: '1m',
            intervalMs,
            requireContiguous: false,
            buildTimestamp: fixedTs
        });
        assert(gappedArtifacts.auditResult.passed, 'Accepted-candle chronology across gap & rejected raw candle must pass');
        assert(gappedArtifacts.manifest.usableObservationFraction < 1.0, 'Uptime must reflect missing/gap slots');
    });

    await runTest('4. Streaming Cancellation Mid-Stream & Pre-Existing Directory-Picker Rollback Safety', async () => {
        // 4a. Mid-stream cancellation aborts sinks cleanly (closed === false, aborted === true)
        const controller = new AbortController();
        const spyCont = new SpySinkStream();
        const spyRep = new SpySinkStream();
        const spyEv = new SpySinkStream();

        let midCancelled = false;
        try {
            await StreamingDatasetExporter.runV3StreamingCore({
                rawCandleBuffer: buffer,
                symbol: 'SOLUSDT',
                interval: '1m',
                intervalMs: 60_000,
                signal: controller.signal,
                continuousSink: new BufferedTextSink(spyCont, 128),
                representationSink: new BufferedTextSink(spyRep, 128),
                strategyEventSink: new BufferedTextSink(spyEv, 128),
                onProgress: (pct) => {
                    if (pct >= 40) controller.abort();
                }
            });
        } catch (e: any) {
            midCancelled = String(e.message).includes('cancelled');
        }
        assert(midCancelled && spyCont.aborted && !spyCont.closed && !spyRep.closed && !spyEv.closed,
            'Mid-stream abort must abort all sinks and never finalize');

        // 4b. Directory-picker staging isolation: pre-existing files in MLR1_SOLUSDT_1m_V3_Dataset survive failed export!
        const rootDir = new MockDirectoryHandle();
        const existingTargetDir = await rootDir.getDirectoryHandle('MLR1_SOLUSDT_1m_V3_Dataset', { create: true });
        const sentinelHandle = await existingTargetDir.getFileHandle('MLR1_SOLUSDT_1m_Manifest.json', { create: true });
        const sw = await sentinelHandle.createWritable();
        await sw.write(new TextEncoder().encode('{"prior":"preserved"}'));
        await sw.close();

        const ctrl2 = new AbortController();
        let dirAborted = false;
        try {
            await StreamingDatasetExporter.exportV3ToFolderOrOpfs({
                rawCandleBuffer: buffer,
                symbol: 'SOLUSDT',
                interval: '1m',
                intervalMs: 60_000,
                rootDirHandle: rootDir,
                signal: ctrl2.signal,
                onProgress: (pct) => {
                    if (pct >= 50) ctrl2.abort();
                }
            });
        } catch (e: any) {
            dirAborted = String(e.message).includes('cancelled');
        }
        assert(dirAborted, 'Aborted directory export must throw');
        assert(new TextDecoder().decode(sentinelHandle.bytes) === '{"prior":"preserved"}',
            'Pre-existing dataset files must NOT be overwritten or deleted on failed/aborted export');
        assert(Array.from(rootDir.dirs.keys()).every(d => !d.startsWith('.tmp_')),
            'Temporary staging folder must be cleaned up on abort');
    });

    await runTest('5. Full V3 Batch-vs-Streaming Byte-for-Byte CSV, SHA-256 & Complete Manifest Parity', async () => {
        assert(await runV3StreamingExportParityTest(650), 'V3 streaming parity failed');
    });

    await runTest('6. Frozen V2 Contract & Streaming Parity Non-Regression', async () => {
        assert(MLR1_DATASET_VERSION === 2 && MLR1_REPRESENTATION_COLUMNS.length === 13, 'V2 frozen constants modified');
        assert(await runStreamingExportParityTest(500), 'V2 streaming parity failed');
    });

    console.log(`\nPhase 5D Phase 4 Acceptance: ${passed} passed, ${failed} failed.`);
    return failed === 0;
}
