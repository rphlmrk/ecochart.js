import JSZip from 'jszip';
import { AIExporter, DatasetAuditor } from '../data/AIExporter';
import {
    BufferedTextSink,
    runV3StreamingExportParityTest,
    StreamingDatasetExporter
} from '../data/StreamingDatasetExporter';
import {
    assertStrategyEventSchemaCoverage,
    parseCsvDocumentCRLF,
    serializeCsvRecord
} from '../indicators/mlr1/pipeline/V3ArtifactAuditor';
import {
    MultiHorizonOutcomeTracker,
    V3_MAX_HORIZON_BARS,
    V3_STRATEGY_EVENT_COLUMNS,
    type V3TierAAtConfirmation
} from '../indicators/mlr1/pipeline/MultiHorizonOutcomeEngine';
import { accountRawSourceRows } from '../indicators/mlr1/dataset/ObservationBackbone';
import { V3PipelineRunner } from '../indicators/mlr1/pipeline/V3PipelineEngine';
import { createStrategyEvent, type StrategyEvent } from '../indicators/mlr1/teachers/StrategyEventTypes';
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

function makeNotFoundError(msg: string): Error {
    const err = new Error(msg);
    err.name = 'NotFoundError';
    return err;
}

class MockFileHandle {
    public bytes: Uint8Array = new Uint8Array(0);
    public failOnWrite = false;
    public failOnClose = false;
    public async createWritable() {
        const chunks: Uint8Array[] = [];
        let aborted = false;
        return {
            write: async (data: Uint8Array | ArrayBuffer) => {
                if (aborted) throw new Error('Writable aborted');
                if (this.failOnWrite) throw new Error('Simulated file write failure');
                chunks.push(data instanceof Uint8Array ? data.slice() : new Uint8Array(data));
            },
            close: async () => {
                if (aborted) throw new Error('Writable aborted');
                if (this.failOnClose) throw new Error('Simulated file close failure');
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
    public failOnFileName: string | null = null;
    public failWriteOnFileName: string | null = null;
    public failCloseOnFileName: string | null = null;

    public async getDirectoryHandle(name: string, opts?: { create?: boolean }): Promise<MockDirectoryHandle> {
        if (!this.dirs.has(name)) {
            if (!opts?.create) throw makeNotFoundError(`Missing dir ${name}`);
            this.dirs.set(name, new MockDirectoryHandle());
        }
        return this.dirs.get(name)!;
    }

    public async getFileHandle(name: string, opts?: { create?: boolean }): Promise<MockFileHandle> {
        if (!this.files.has(name)) {
            if (!opts?.create) throw makeNotFoundError(`Missing file ${name}`);
            if (this.failOnFileName === name) {
                throw new Error(`Simulated write failure on ${name}`);
            }
            const fh = new MockFileHandle();
            if (this.failWriteOnFileName === name) fh.failOnWrite = true;
            if (this.failCloseOnFileName === name) fh.failOnClose = true;
            this.files.set(name, fh);
        } else if (opts?.create && this.failOnFileName === name) {
            throw new Error(`Simulated write failure on ${name}`);
        }
        const h = this.files.get(name)!;
        if (opts?.create) {
            if (this.failWriteOnFileName === name) h.failOnWrite = true;
            if (this.failCloseOnFileName === name) h.failOnClose = true;
        }
        return h;
    }

    public async removeEntry(name: string): Promise<void> {
        this.files.delete(name);
        this.dirs.delete(name);
    }
}

class SpySinkStream {
    public aborted = false;
    public abortCalls = 0;
    public throwOnAbort = false;
    public closed = false;
    public writes = 0;
    public write = async (_data: Uint8Array) => { this.writes++; };
    public close = async () => { this.closed = true; };
    public abort = async () => {
        this.abortCalls++;
        if (this.throwOnAbort) throw new Error('Ignore secondary abort error');
        this.aborted = true;
    };
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
        assertStrategyEventSchemaCoverage();
        const expectSchemaErr = (fn: () => void, label: string) => {
            let threw = false;
            try { fn(); } catch { threw = true; }
            assert(threw, `${label}: expected schema coverage rejection`);
        };
        expectSchemaErr(() => assertStrategyEventSchemaCoverage([...V3_STRATEGY_EVENT_COLUMNS, 'extra_col']), 'missing schema entry');
        expectSchemaErr(() => assertStrategyEventSchemaCoverage(V3_STRATEGY_EVENT_COLUMNS.slice(0, -1)), 'extra schema entry');
        expectSchemaErr(() => assertStrategyEventSchemaCoverage([...V3_STRATEGY_EVENT_COLUMNS.slice(0, -1), 'event_id']), 'duplicate col');
        expectSchemaErr(() => assertStrategyEventSchemaCoverage(['event_id'], { event_id: 'bad_type' as any }), 'unsupported col type');
        expectSchemaErr(() => assertStrategyEventSchemaCoverage(['event_id'], { event_id: undefined as any }), 'undefined col type');
        const inheritedSchema = Object.assign(
            Object.create({ event_id: 'nonempty_string' }),
            { unrelated_own: 'nonempty_string' }
        ) as Record<string, any>;
        expectSchemaErr(() => assertStrategyEventSchemaCoverage(['event_id'], inheritedSchema), 'inherited schema property');

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
        assert(artifacts.manifest.exportAccounting.tierBConfirmedTeacherEventCount > 5,
            'Expected > 5 confirmed V3 teacher events across 650 candles');

        // Explicitly guard non-empty event list before min/max confirmation index selection
        assert(artifacts.strategyEventRows.length > 0, 'Expected non-empty strategyEventRows before min/max check');
        const minConfirmation = Math.min(...artifacts.strategyEventRows.map(e => e.confirmation_bar_index));
        const maxConfirmation = Math.max(...artifacts.strategyEventRows.map(e => e.confirmation_bar_index));
        const earliestEv = artifacts.strategyEventRows.find(e => e.confirmation_bar_index === minConfirmation)!;
        const latestEv = artifacts.strategyEventRows.find(e => e.confirmation_bar_index === maxConfirmation)!;
        assert(
            earliestEv.confirmation_bar_index < 60 &&
            latestEv.confirmation_bar_index > 400 &&
            earliestEv.entry_bar_index + V3_MAX_HORIZON_BARS - 1 < 650 &&
            latestEv.entry_bar_index + V3_MAX_HORIZON_BARS - 1 <= 649 &&
            Number.isFinite(earliestEv.long_net_r_180) &&
            Number.isFinite(latestEv.long_net_r_180),
            `Expected early (<60) and late (>400) batch replays, got [${minConfirmation}, ${maxConfirmation}]`
        );

        // Resolve all 6 raw candle columns from Continuous header and verify exact row count + first (0), middle (324), and last (649) rows
        const contRows = parseCsvDocumentCRLF(artifacts.continuousCsv);
        assert(contRows.length === 651, `Expected 651 Continuous CSV records (header + 650 rows), got ${contRows.length}`);
        const contTsCol = contRows[0].indexOf('source_timestamp');
        const contOpenCol = contRows[0].indexOf('open');
        const contHighCol = contRows[0].indexOf('high');
        const contLowCol = contRows[0].indexOf('low');
        const contCloseCol = contRows[0].indexOf('close');
        const contVolCol = contRows[0].indexOf('volume');
        assert(
            contTsCol >= 0 && contOpenCol >= 0 && contHighCol >= 0 && contLowCol >= 0 && contCloseCol >= 0 && contVolCol >= 0,
            'Continuous header missing required raw candle column(s)'
        );
        for (const [rowIdx, bufIdx] of [
            [1, 0],
            [325, 324],
            [650, 649]
        ] as const) {
            const off = bufIdx * 6;
            assert(
                Number(contRows[rowIdx][contTsCol]) === buffer[off] &&
                Number(contRows[rowIdx][contOpenCol]) === buffer[off + 1] &&
                Number(contRows[rowIdx][contHighCol]) === buffer[off + 2] &&
                Number(contRows[rowIdx][contLowCol]) === buffer[off + 3] &&
                Number(contRows[rowIdx][contCloseCol]) === buffer[off + 4] &&
                Number(contRows[rowIdx][contVolCol]) === buffer[off + 5],
                `Continuous row ${rowIdx} must match raw buffer candle ${bufIdx} across all 6 OHLCVT fields`
            );
        }

        const archiveBytes = await AIExporter.createVerifiedV3DatasetArchive(artifacts, buffer);
        const reopened = await JSZip.loadAsync(archiveBytes);
        assert(Object.keys(reopened.files).filter(n => !reopened.files[n].dir).length === 4, 'V3 ZIP must have 4 entries');

        // Explicit include15mMtf=false archive re-audit verification
        const noMtfArtifacts = await AIExporter.buildV3ExportArtifacts({
            rawCandleBuffer: buffer,
            symbol: 'SOLUSDT',
            interval: '1m',
            intervalMs: 60_000,
            include15mMtf: false,
            buildTimestamp: fixedTs
        });
        assert(!noMtfArtifacts.manifest.featureVersion.includes('M3_15M_ONLY_v1'), 'include15mMtf=false must omit MTF version tag');
        const noMtfZip = await AIExporter.createVerifiedV3DatasetArchive(noMtfArtifacts, buffer);
        assert(noMtfZip.length > 0, 'include15mMtf=false archive re-audit must pass');

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

        // 2i. RFC-4180 trailing CRLF & embedded-quote newline tests
        const withCrLf = parseCsvDocumentCRLF('a,b\r\n"x\r\ny",2\r\n');
        const noCrLf = parseCsvDocumentCRLF('a,b\r\n"x\r\ny",2');
        assert(withCrLf.length === 2 && noCrLf.length === 2 && withCrLf[1][0] === 'x\r\ny', 'CRLF trailing/quoted handling');
        for (const badNewline of ['a,b\r\n"x\ry",2', 'a,b\r\n"x\ny",2']) {
            let threw = false;
            try { parseCsvDocumentCRLF(badNewline); } catch { threw = true; }
            assert(threw, 'Bare CR/LF inside quoted field must be rejected');
        }

        // 2j. Blank event_id, invalid 0/1 flag ('2'), empty numeric & Infinity checks
        const blankIdEv = parseCsvDocumentCRLF(artifacts.strategyEventsCsv);
        blankIdEv[1][evIdCol] = '';
        assert(!DatasetAuditor.runV3CausalityAudit({ ...baseAuditParams, strategyEventsCsv: blankIdEv.map(serializeCsvRecord).join('\r\n') }).passed, 'Blank event_id rejected');

        const badFlagEv = parseCsvDocumentCRLF(artifacts.strategyEventsCsv);
        badFlagEv[1][badFlagEv[0].indexOf('tierA_exhaustion_20_valid')] = '2';
        assert(!DatasetAuditor.runV3CausalityAudit({ ...baseAuditParams, strategyEventsCsv: badFlagEv.map(serializeCsvRecord).join('\r\n') }).passed, 'Invalid flag_01=2 rejected');

        const emptyNumEv = parseCsvDocumentCRLF(artifacts.strategyEventsCsv);
        emptyNumEv[1][entryPriceCol] = '';
        assert(!DatasetAuditor.runV3CausalityAudit({ ...baseAuditParams, strategyEventsCsv: emptyNumEv.map(serializeCsvRecord).join('\r\n') }).passed, 'Empty numeric rejected');

        const infNumEv = parseCsvDocumentCRLF(artifacts.strategyEventsCsv);
        infNumEv[1][evNetRCol] = 'Infinity';
        assert(!DatasetAuditor.runV3CausalityAudit({ ...baseAuditParams, strategyEventsCsv: infNumEv.map(serializeCsvRecord).join('\r\n') }).passed, 'Infinity net_r rejected');

        // 2k. Reordered Continuous and StrategyEvents headers
        const reorderedCont = parseCsvDocumentCRLF(artifacts.continuousCsv).map(r => {
            const copy = [...r];
            [copy[11], copy[12]] = [copy[12], copy[11]];
            return copy;
        });
        assert(!DatasetAuditor.runV3CausalityAudit({ ...baseAuditParams, continuousCsv: reorderedCont.map(serializeCsvRecord).join('\r\n') }).inputOutcomeSeparationValid, 'Reordered Continuous header rejected');

        const reorderedEv = parseCsvDocumentCRLF(artifacts.strategyEventsCsv).map(r => {
            const copy = [...r];
            [copy[1], copy[2]] = [copy[2], copy[1]];
            return copy;
        });
        assert(!DatasetAuditor.runV3CausalityAudit({ ...baseAuditParams, strategyEventsCsv: reorderedEv.map(serializeCsvRecord).join('\r\n') }).chronologyValid, 'Reordered StrategyEvents header rejected');

        // 2l. Contradictory htf15mDiagnostic (misaligned openTimestamp) rejected
        const badDiagCont = parseCsvDocumentCRLF(artifacts.continuousCsv);
        const diagCol = badDiagCont[0].indexOf('htf15mDiagnostic');
        badDiagCont[20][diagCol] = JSON.stringify({
            timeframe: '15m',
            openTimestamp: 12345, // not aligned to 900_000
            closeTimestamp: 12345 + 900_000,
            expectedSourceCount: 15,
            actualSourceCount: 14,
            missingTimestamps: [12345],
            duplicateCount: 0,
            invalidSourceCount: 0,
            completeness: 'INCOMPLETE_MISSING'
        });
        assert(!DatasetAuditor.runV3CausalityAudit({ ...baseAuditParams, continuousCsv: badDiagCont.map(serializeCsvRecord).join('\r\n') }).inputOutcomeSeparationValid, 'Misaligned htf15mDiagnostic rejected');

        // 2m. Continuous-to-raw candle divergence & duplicate observation_id
        const contMut = parseCsvDocumentCRLF(artifacts.continuousCsv);
        const contCloseCol = contMut[0].indexOf('close');
        contMut[10][contCloseCol] = String(Number(contMut[10][contCloseCol]) + 0.5);
        assert(!DatasetAuditor.runV3CausalityAudit({ ...baseAuditParams, continuousCsv: contMut.map(serializeCsvRecord).join('\r\n') }).passed,
            'Auditor must reject Continuous OHLC diverging from raw candle');

        const contDupObs = parseCsvDocumentCRLF(artifacts.continuousCsv);
        contDupObs[2][0] = contDupObs[1][0];
        assert(!DatasetAuditor.runV3CausalityAudit({ ...baseAuditParams, continuousCsv: contDupObs.map(serializeCsvRecord).join('\r\n') }).passed,
            'Auditor must reject duplicate Continuous observation_id');

        // 2n. Event-to-Continuous tierA_observation_id linkage mismatch (even if Rep & Ev match each other)
        const linkEv = parseCsvDocumentCRLF(artifacts.strategyEventsCsv);
        const linkRep = parseCsvDocumentCRLF(artifacts.representationCsv);
        linkEv[1][linkEv[0].indexOf('tierA_observation_id')] = 'OBS_FORGED_ID';
        linkRep[1][linkRep[0].indexOf('tierA_observation_id')] = 'OBS_FORGED_ID';
        const linkAudit = DatasetAuditor.runV3CausalityAudit({
            ...baseAuditParams,
            representationCsv: linkRep.map(serializeCsvRecord).join('\r\n'),
            strategyEventsCsv: linkEv.map(serializeCsvRecord).join('\r\n')
        });
        assert(!linkAudit.passed && !linkAudit.identityUnique, 'Forged tierA_observation_id must fail passed and identityUnique');

        // 2o. Contradictory htf15mDiagnostic cases (COMPLETE w/ missing, INCOMPLETE_DUPLICATE w/ invalid, INCOMPLETE_MISSING w/ empty missingTimestamps)
        const alignedOpen = Math.floor((buffer[20 * 6] - 900_000) / 900_000) * 900_000;
        const contraCases = [
            {
                timeframe: '15m', openTimestamp: alignedOpen, closeTimestamp: alignedOpen + 900_000,
                expectedSourceCount: 15, actualSourceCount: 14, missingTimestamps: [alignedOpen],
                duplicateCount: 0, invalidSourceCount: 0, completeness: 'COMPLETE'
            },
            {
                timeframe: '15m', openTimestamp: alignedOpen, closeTimestamp: alignedOpen + 900_000,
                expectedSourceCount: 15, actualSourceCount: 14, missingTimestamps: [alignedOpen],
                duplicateCount: 1, invalidSourceCount: 1, completeness: 'INCOMPLETE_DUPLICATE'
            },
            {
                timeframe: '15m', openTimestamp: alignedOpen, closeTimestamp: alignedOpen + 900_000,
                expectedSourceCount: 15, actualSourceCount: 15, missingTimestamps: [],
                duplicateCount: 0, invalidSourceCount: 0, completeness: 'INCOMPLETE_MISSING'
            },
            {
                timeframe: '15m', openTimestamp: alignedOpen, closeTimestamp: alignedOpen + 900_000,
                expectedSourceCount: 15, actualSourceCount: 1, missingTimestamps: [alignedOpen],
                duplicateCount: 0, invalidSourceCount: 0, completeness: 'INCOMPLETE_MISSING'
            },
            {
                timeframe: '15m', openTimestamp: alignedOpen, closeTimestamp: alignedOpen + 900_000,
                expectedSourceCount: 15, actualSourceCount: 14, missingTimestamps: [alignedOpen],
                duplicateCount: 0, invalidSourceCount: 0, completeness: 'INCOMPLETE_UNFINISHED'
            },
            {
                timeframe: '15m', openTimestamp: alignedOpen, closeTimestamp: alignedOpen + 900_000,
                expectedSourceCount: 15, actualSourceCount: 14, missingTimestamps: [alignedOpen],
                duplicateCount: 0, invalidSourceCount: 1, completeness: 'INCOMPLETE_MISSING'
            },
            {
                timeframe: '15m', openTimestamp: alignedOpen, closeTimestamp: alignedOpen + 900_000,
                expectedSourceCount: 15, actualSourceCount: 14, missingTimestamps: [alignedOpen],
                duplicateCount: 1, invalidSourceCount: 0, completeness: 'INCOMPLETE_MISSING'
            },
            {
                timeframe: '15m', openTimestamp: alignedOpen, closeTimestamp: alignedOpen + 900_000,
                expectedSourceCount: 15, actualSourceCount: 14, missingTimestamps: [alignedOpen],
                duplicateCount: 0, invalidSourceCount: 0, completeness: 'UNKNOWN_STATUS'
            }
        ];
        for (const badDiag of contraCases) {
            const contraDiag = parseCsvDocumentCRLF(artifacts.continuousCsv);
            contraDiag[20][diagCol] = JSON.stringify(badDiag);
            assert(!DatasetAuditor.runV3CausalityAudit({ ...baseAuditParams, continuousCsv: contraDiag.map(serializeCsvRecord).join('\r\n') }).inputOutcomeSeparationValid,
                `Auditor must reject contradictory diagnostic (${badDiag.completeness})`);
        }

        // 2p. RFC-4180 escaped quotes + embedded CRLF, trailing empty field, empty record & empty trailing CSV record rejection
        const complexCsv = 'id,context\r\n1,"{""message"":""line one\r\nline two""}"\r\n2,\r\n\r\n';
        const parsedComplex = parseCsvDocumentCRLF(complexCsv);
        assert(
            parsedComplex.length === 4 &&
            parsedComplex[1][1] === '{"message":"line one\r\nline two"}' &&
            parsedComplex[2][0] === '2' && parsedComplex[2][1] === '' &&
            parsedComplex[3].length === 1 && parsedComplex[3][0] === '',
            'RFC-4180 escaped quotes + embedded CRLF + empty fields/records failed'
        );
        assert(serializeCsvRecord(parsedComplex[1]) === '1,"{""message"":""line one\r\nline two""}"',
            'RFC-4180 round-trip serialization mismatch');
        assert(!DatasetAuditor.runV3CausalityAudit({
            ...baseAuditParams,
            continuousCsv: artifacts.continuousCsv + '\r\n\r\n'
        }).passed, 'Auditor must reject empty trailing record in Continuous CSV');
    });

    await runTest('3. Gap-Tolerant Chronology + Rejected Raw Candle Filtering Between Confirmation and Entry', async () => {
        // Construct raw stream with a 10m timestamp gap at index 300 AND an invalid OHLCV raw candle BEFORE confirmation (rawIndex = 5)
        const intervalMs = 60_000;
        const rawCandles: ML1Candle[] = [];
        let ts = 1_700_000_040_000;
        for (let i = 0; i < 680; i++) {
            if (i === 300) ts += 10 * intervalMs;
            const close = i % 8 < 4 ? 100 + (i % 4) : 104 - (i % 4);
            const open = i % 2 === 1 ? close - 0.5 : close + 0.5;
            rawCandles.push({
                time: ts,
                open,
                high: i === 5 ? open - 5 : Math.max(open, close) + 1, // Bar 5 has high < open (invalid OHLCV before confirmation)
                low: Math.min(open, close) - 1,
                close,
                volume: 100 + (i % 7) * 15
            });
            ts += intervalMs;
        }
        // Verify un-filtered raw buffer containing invalid bar 5 is rejected by both batch & streaming exporters
        const rawDirtyBuf = new Float64Array(rawCandles.length * 6);
        rawCandles.forEach((c, idx) => rawDirtyBuf.set([c.time, c.open, c.high, c.low, c.close, c.volume], idx * 6));
        let batchRejectedDirty = false;
        try {
            await AIExporter.buildV3ExportArtifacts({
                rawCandleBuffer: rawDirtyBuf, symbol: 'SOLUSDT', interval: '1m', intervalMs, requireContiguous: false
            });
        } catch {
            batchRejectedDirty = true;
        }
        let streamRejectedDirty = false;
        try {
            await StreamingDatasetExporter.runV3StreamingCore({
                rawCandleBuffer: rawDirtyBuf, symbol: 'SOLUSDT', interval: '1m', intervalMs, requireContiguous: false,
                continuousSink: new BufferedTextSink(new SpySinkStream(), 128),
                representationSink: new BufferedTextSink(new SpySinkStream(), 128),
                strategyEventSink: new BufferedTextSink(new SpySinkStream(), 128)
            });
        } catch {
            streamRejectedDirty = true;
        }
        assert(batchRejectedDirty && streamRejectedDirty,
            'Both batch and streaming exporters must reject un-filtered invalid raw candles');

        const prePolicy = { rejectInvalidSource: true, rejectInvalidOhlcv: true, rejectDuplicateTimestamp: true, rejectOutOfOrder: true };
        const preReport = accountRawSourceRows(rawCandles, 'SOLUSDT', '1m', prePolicy, intervalMs);
        assert(preReport.rejectedRows.length === 1 && preReport.stats.invalidOhlcvCount === 1, 'Expected bar 5 rejected');

        const preBuf = new Float64Array(preReport.acceptedSourceIndices.length * 6);
        preReport.acceptedSourceIndices.forEach((rawIdx, pos) => {
            const c = rawCandles[rawIdx];
            preBuf.set([c.time, c.open, c.high, c.low, c.close, c.volume], pos * 6);
        });
        const preArtifacts = await AIExporter.buildV3ExportArtifacts({
            rawCandleBuffer: preBuf,
            symbol: 'SOLUSDT',
            interval: '1m',
            intervalMs,
            requireContiguous: false,
            buildTimestamp: fixedTs
        });
        const probeEv = preArtifacts.strategyEventRows.find(e => e.confirmation_bar_index >= 40 && e.confirmation_bar_index <= 200);
        assert(probeEv !== undefined, 'Expected confirmed event between accepted bars 40 and 200');
        const confRawIdx = rawCandles.findIndex(c => c.time === probeEv!.confirmation_timestamp);
        assert(confRawIdx > 10 && confRawIdx + 2 < 300, 'Expected confRawIdx in contiguous segment after bar 5');

        // Also inject an invalid OHLCV raw candle strictly BETWEEN confirmation (confRawIdx) and next bar (confRawIdx + 1)
        rawCandles[confRawIdx + 1] = {
            ...rawCandles[confRawIdx + 1],
            high: rawCandles[confRawIdx + 1].open - 5
        };

        const report = accountRawSourceRows(rawCandles, 'SOLUSDT', '1m', prePolicy, intervalMs);
        assert(report.rejectedRows.length === 2 && report.stats.invalidOhlcvCount === 2,
            'Expected both pre-confirmation (raw 5) and post-confirmation (confRawIdx+1) raw candles rejected');

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
        assert(gappedArtifacts.auditResult.passed, 'Accepted-candle chronology across gap & rejected raw candles must pass');
        assert(gappedArtifacts.manifest.usableObservationFraction < 1.0, 'Uptime must reflect missing/gap slots');

        const shiftedEv = gappedArtifacts.strategyEventRows.find(e => e.event_id === probeEv!.event_id);
        assert(shiftedEv !== undefined, 'Confirmed event must still be present after rejecting raw confRawIdx + 1');
        assert(
            shiftedEv!.entry_bar_index === shiftedEv!.confirmation_bar_index + 1 &&
            shiftedEv!.entry_time === rawCandles[confRawIdx + 2].time &&
            Math.abs(shiftedEv!.entry_price - rawCandles[confRawIdx + 2].open) < 1e-9,
            'Entry must advance to next accepted candle (confRawIdx + 2) when raw candle confRawIdx + 1 is rejected'
        );
    });

    await runTest('4. Streaming Cancellation Mid-Stream, Pre-Existing Overwrite Refusal, Publication Rollback & Sink Failure Safety', async () => {
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

        // 4b. Pre-existing destination directory refuses overwrite without touching existing files
        const rootDir = new MockDirectoryHandle();
        const existingTargetDir = await rootDir.getDirectoryHandle('MLR1_SOLUSDT_1m_V3_Dataset', { create: true });
        const sentinelHandle = await existingTargetDir.getFileHandle('MLR1_SOLUSDT_1m_Manifest.json', { create: true });
        const sw = await sentinelHandle.createWritable();
        await sw.write(new TextEncoder().encode('{"prior":"preserved"}'));
        await sw.close();

        const fixedDestName = 'MLR1_SOLUSDT_1m_V3_Dataset';
        let refusedOverwrite = false;
        try {
            await StreamingDatasetExporter.exportV3ToFolderOrOpfs({
                rawCandleBuffer: buffer,
                symbol: 'SOLUSDT',
                interval: '1m',
                intervalMs: 60_000,
                rootDirHandle: rootDir,
                destinationFolderName: fixedDestName
            });
        } catch (e: any) {
            refusedOverwrite = String(e.message).includes('already exists');
        }
        assert(refusedOverwrite && new TextDecoder().decode(sentinelHandle.bytes) === '{"prior":"preserved"}',
            'Must refuse to overwrite pre-existing dataset directory');

        // 4c. Failure mid-publication cleans up partial published files & temporary staging folder (never returns a result)
        const rootDir2 = new MockDirectoryHandle();
        const origGetDir = rootDir2.getDirectoryHandle.bind(rootDir2);
        rootDir2.getDirectoryHandle = async (name: string, opts?: { create?: boolean }) => {
            const d = await origGetDir(name, opts);
            if (name === fixedDestName) {
                d.failOnFileName = 'MLR1_SOLUSDT_1m_StrategyEvents.csv'; // Fail mid-publication!
            }
            return d;
        };
        let pubResultOnFailure: unknown = null;
        let pubFailed = false;
        try {
            pubResultOnFailure = await StreamingDatasetExporter.exportV3ToFolderOrOpfs({
                rawCandleBuffer: buffer,
                symbol: 'SOLUSDT',
                interval: '1m',
                intervalMs: 60_000,
                rootDirHandle: rootDir2,
                destinationFolderName: fixedDestName,
                buildTimestamp: fixedTs
            });
        } catch (e: any) {
            pubFailed = String(e.message).includes('Simulated write failure');
        }
        assert(
            pubFailed &&
            pubResultOnFailure === null &&
            (rootDir2.dirs.get(fixedDestName)?.files.size ?? 0) === 0 &&
            Array.from(rootDir2.dirs.keys()).every(d => !d.startsWith('.tmp_')),
            'Mid-publication failure must throw (never return result), clean up partial destination files, and clean up staging folder'
        );

        // 4c-2. Write failure inside writable.write() on 2nd destination file cleans up partial published files + staging dir
        const rootDir3 = new MockDirectoryHandle();
        const origGetDir3 = rootDir3.getDirectoryHandle.bind(rootDir3);
        rootDir3.getDirectoryHandle = async (name: string, opts?: { create?: boolean }) => {
            const d = await origGetDir3(name, opts);
            if (name === fixedDestName) {
                d.failWriteOnFileName = 'MLR1_SOLUSDT_1m_Representation_Features.csv';
            }
            return d;
        };
        let pubWriteFailed = false;
        try {
            await StreamingDatasetExporter.exportV3ToFolderOrOpfs({
                rawCandleBuffer: buffer,
                symbol: 'SOLUSDT',
                interval: '1m',
                intervalMs: 60_000,
                rootDirHandle: rootDir3,
                destinationFolderName: fixedDestName,
                buildTimestamp: fixedTs
            });
        } catch (e: any) {
            pubWriteFailed = String(e.message).includes('Simulated file write failure');
        }
        assert(
            pubWriteFailed &&
            (rootDir3.dirs.get(fixedDestName)?.files.size ?? 0) === 0 &&
            Array.from(rootDir3.dirs.keys()).every(d => !d.startsWith('.tmp_')),
            'Mid-publication stream write failure must clean up partial destination files AND temporary staging folder'
        );

        // 4c-3. Close failure inside writable.close() on 3rd destination file cleans up partial published files + staging dir
        const rootDir4 = new MockDirectoryHandle();
        const origGetDir4 = rootDir4.getDirectoryHandle.bind(rootDir4);
        rootDir4.getDirectoryHandle = async (name: string, opts?: { create?: boolean }) => {
            const d = await origGetDir4(name, opts);
            if (name === fixedDestName) {
                d.failCloseOnFileName = 'MLR1_SOLUSDT_1m_StrategyEvents.csv';
            }
            return d;
        };
        let pubCloseFailed = false;
        try {
            await StreamingDatasetExporter.exportV3ToFolderOrOpfs({
                rawCandleBuffer: buffer,
                symbol: 'SOLUSDT',
                interval: '1m',
                intervalMs: 60_000,
                rootDirHandle: rootDir4,
                destinationFolderName: fixedDestName,
                buildTimestamp: fixedTs
            });
        } catch (e: any) {
            pubCloseFailed = String(e.message).includes('Simulated file close failure');
        }
        assert(
            pubCloseFailed &&
            (rootDir4.dirs.get(fixedDestName)?.files.size ?? 0) === 0 &&
            Array.from(rootDir4.dirs.keys()).every(d => !d.startsWith('.tmp_')),
            'Mid-publication stream close failure must clean up partial destination files AND temporary staging folder'
        );

        // 4d. Sink finalization failure & cancellation during 2nd sink close() abort all 3 sinks independently
        const s1 = new SpySinkStream();
        const s2 = new SpySinkStream();
        s2.close = async () => { throw new Error('Simulated sink2 close failure'); };
        const s3 = new SpySinkStream();
        s3.throwOnAbort = true;

        let finErrMsg = '';
        try {
            await StreamingDatasetExporter.runV3StreamingCore({
                rawCandleBuffer: buffer,
                symbol: 'SOLUSDT',
                interval: '1m',
                intervalMs: 60_000,
                continuousSink: new BufferedTextSink(s1, 128),
                representationSink: new BufferedTextSink(s2, 128),
                strategyEventSink: new BufferedTextSink(s3, 128)
            });
        } catch (e: any) {
            finErrMsg = e?.message || '';
        }
        assert(
            finErrMsg === 'Simulated sink2 close failure' &&
            !finErrMsg.includes('Ignore secondary abort error') &&
            s1.aborted && s2.aborted && !s3.aborted &&
            s1.abortCalls === 1 && s2.abortCalls === 1 && s3.abortCalls === 1,
            'Sink finalization failure must preserve original error and attempt abort on all 3 sinks even when s3.abort throws'
        );

        const cancelFinCtrl = new AbortController();
        const cf1 = new SpySinkStream();
        const cf2 = new SpySinkStream();
        cf2.close = async () => { cf2.closed = true; cancelFinCtrl.abort(); };
        const cf3 = new SpySinkStream();
        let cancelFinErr = false;
        try {
            await StreamingDatasetExporter.runV3StreamingCore({
                rawCandleBuffer: buffer,
                symbol: 'SOLUSDT',
                interval: '1m',
                intervalMs: 60_000,
                signal: cancelFinCtrl.signal,
                continuousSink: new BufferedTextSink(cf1, 128),
                representationSink: new BufferedTextSink(cf2, 128),
                strategyEventSink: new BufferedTextSink(cf3, 128)
            });
        } catch (e: any) {
            cancelFinErr = String(e.message).includes('cancelled');
        }
        assert(
            cancelFinErr && cf1.closed && !cf3.closed &&
            cf1.abortCalls === 1 && cf2.abortCalls === 1 && cf3.abortCalls === 1,
            'Cancellation during 2nd sink close() must abort all 3 sinks independently'
        );

        // 4e. Concurrent in-process exports targeting same fixed folder reject second call safely without destroying first
        const concRoot = new MockDirectoryHandle();
        const p1 = StreamingDatasetExporter.exportV3ToFolderOrOpfs({
            rawCandleBuffer: buffer, symbol: 'SOLUSDT', interval: '1m', intervalMs: 60_000,
            rootDirHandle: concRoot, destinationFolderName: fixedDestName, buildTimestamp: fixedTs
        });
        let concRejected = false;
        try {
            await StreamingDatasetExporter.exportV3ToFolderOrOpfs({
                rawCandleBuffer: buffer, symbol: 'SOLUSDT', interval: '1m', intervalMs: 60_000,
                rootDirHandle: concRoot, destinationFolderName: fixedDestName, buildTimestamp: fixedTs
            });
        } catch (e: any) {
            concRejected = String(e.message).includes('concurrent export already active');
        }
        const res1 = await p1;
        assert(concRejected && res1.manifest.auditResults.passed, 'Concurrent in-process export rejected while first succeeds');

        // 4f. External concurrent creation during streaming refuses overwrite and does NOT delete external directory!
        const extRoot = new MockDirectoryHandle();
        let extCreated = false;
        let extErr = false;
        try {
            await StreamingDatasetExporter.exportV3ToFolderOrOpfs({
                rawCandleBuffer: buffer, symbol: 'SOLUSDT', interval: '1m', intervalMs: 60_000,
                rootDirHandle: extRoot, destinationFolderName: fixedDestName,
                onProgress: async (pct) => {
                    if (!extCreated && pct >= 50) {
                        extCreated = true;
                        const d = await extRoot.getDirectoryHandle(fixedDestName, { create: true });
                        const f = await d.getFileHandle('external.txt', { create: true });
                        const w = await f.createWritable();
                        await w.write(new TextEncoder().encode('owned-by-other'));
                        await w.close();
                    }
                }
            });
        } catch (e: any) {
            extErr = String(e.message).includes('already exists');
        }
        const extDir = extRoot.dirs.get(fixedDestName);
        assert(extErr && extDir !== undefined && extDir.files.has('external.txt'),
            'External concurrent directory must never be deleted by rollback');

        // 4g. Default unique execution-owned publication + empty-directory check/create-gap behavior (documented API limitation)
        const uniqueRoot = new MockDirectoryHandle();
        const uResA = await StreamingDatasetExporter.exportV3ToFolderOrOpfs({
            rawCandleBuffer: buffer, symbol: 'SOLUSDT', interval: '1m', intervalMs: 60_000,
            rootDirHandle: uniqueRoot, buildTimestamp: fixedTs
        });
        const uResB = await StreamingDatasetExporter.exportV3ToFolderOrOpfs({
            rawCandleBuffer: buffer, symbol: 'SOLUSDT', interval: '1m', intervalMs: 60_000,
            rootDirHandle: uniqueRoot, buildTimestamp: fixedTs
        });
        assert(
            typeof uResA.folderName === 'string' && uResA.folderName.length > 0 &&
            typeof uResB.folderName === 'string' && uResB.folderName.length > 0 &&
            uResA.folderName !== uResB.folderName &&
            uResA.folderName.startsWith('MLR1_SOLUSDT_1m_V3_Dataset_') &&
            uResB.folderName.startsWith('MLR1_SOLUSDT_1m_V3_Dataset_') &&
            uniqueRoot.dirs.has(uResA.folderName) &&
            uniqueRoot.dirs.has(uResB.folderName) &&
            uniqueRoot.dirs.get(uResA.folderName)!.files.has('MLR1_SOLUSDT_1m_Manifest.json') &&
            uniqueRoot.dirs.get(uResB.folderName)!.files.has('MLR1_SOLUSDT_1m_Manifest.json'),
            'Default exports must publish into separate unique folders and populate folderName on success'
        );

        // Simulate an external actor creating an empty directory right in the check/create gap (after create:false throws NotFoundError,
        // before create:true runs), combined with a mid-publication error: exclusive ownership is never claimed without O_EXCL,
        // and rollback MUST NOT delete `finalDirHandle`.
        const emptyGapRoot = new MockDirectoryHandle();
        const origEmptyGapGetDir = emptyGapRoot.getDirectoryHandle.bind(emptyGapRoot);
        let sawCheckAbsent = false;
        let injectedEmptyExternalDir: MockDirectoryHandle | null = null;
        emptyGapRoot.getDirectoryHandle = async (name: string, opts?: { create?: boolean }) => {
            if (name === fixedDestName && opts?.create === true && sawCheckAbsent && injectedEmptyExternalDir === null) {
                injectedEmptyExternalDir = await origEmptyGapGetDir(name, { create: true });
                injectedEmptyExternalDir.failOnFileName = 'MLR1_SOLUSDT_1m_StrategyEvents.csv';
                return injectedEmptyExternalDir;
            }
            try {
                return await origEmptyGapGetDir(name, opts);
            } catch (err) {
                if (name === fixedDestName && opts?.create === false) {
                    sawCheckAbsent = true;
                }
                throw err;
            }
        };
        let emptyGapErr = false;
        try {
            await StreamingDatasetExporter.exportV3ToFolderOrOpfs({
                rawCandleBuffer: buffer, symbol: 'SOLUSDT', interval: '1m', intervalMs: 60_000,
                rootDirHandle: emptyGapRoot, destinationFolderName: fixedDestName, buildTimestamp: fixedTs
            });
        } catch (e: any) {
            emptyGapErr = String(e.message).includes('Simulated write failure');
        }
        assert(
            emptyGapErr &&
            emptyGapRoot.dirs.has(fixedDestName) &&
            (emptyGapRoot.dirs.get(fixedDestName)?.files.size ?? 0) === 0,
            'Empty directory created in check/create gap must never be deleted on rollback'
        );

        // 4h. Streaming runner OHLCV substitution checks (finite +0.25, sub-1e-12 +1e-13, and NaN close tamper)
        const origStepCandle = V3PipelineRunner.prototype.stepCandle;
        for (const [label, mutatedClose] of [
            ['finite close substitution (+0.25)', (c: number) => c + 0.25],
            ['sub-1e-12 close substitution (+1e-13)', (c: number) => c + 1e-13],
            ['NaN close substitution', () => Number.NaN]
        ] as const) {
            let substitutionRejected = false;
            V3PipelineRunner.prototype.stepCandle = function (rawCandle) {
                const out = origStepCandle.call(this, rawCandle);
                if (out.acceptedBarIndex === 10) {
                    return {
                        ...out,
                        candle: Object.freeze({ ...out.candle, close: mutatedClose(out.candle.close) })
                    };
                }
                return out;
            };
            try {
                await StreamingDatasetExporter.runV3StreamingCore({
                    rawCandleBuffer: buffer,
                    symbol: 'SOLUSDT',
                    interval: '1m',
                    intervalMs: 60_000,
                    continuousSink: new BufferedTextSink(new SpySinkStream(), 128),
                    representationSink: new BufferedTextSink(new SpySinkStream(), 128),
                    strategyEventSink: new BufferedTextSink(new SpySinkStream(), 128)
                });
            } catch (e: any) {
                substitutionRejected = String(e.message).includes('modified accepted candle');
            } finally {
                V3PipelineRunner.prototype.stepCandle = origStepCandle;
            }
            assert(substitutionRejected, `Streaming exporter must reject ${label} on accepted candle`);
        }

        // 4i. Universal observationBarIndex === confirmationBarIndex rejection across all 4 teachers
        const dummyTierA: V3TierAAtConfirmation = {
            tierAObservationId: 'OBS_SOLUSDT_1m_V3_1700000040000',
            atr14: 2.0,
            exhaustion20: 0,
            exhaustion20Valid: true,
            vcsRatio360: 1.0,
            vcsZScore360: 0,
            vcsRegime360: 0,
            vcsValid: true,
            vamCenterDistAtr: 0,
            vamSlope3Atr: 0,
            vamEfficiency: 0.5,
            vamAdx14: 25,
            vamDiSpread14: 5,
            vamRsi14: 55,
            vamTrend: 1,
            vamValid: true,
            context15mAvailable: true,
            context15mStatus: 'AVAILABLE_VALID'
        };
        const teacherCases = [
            { strategyId: 'STRICT_CBC' as const, strategyVersion: 'StrictCBCZigZag_v1', eventType: 'CBC_HIGH_HH' as const, direction: 'bear' as const, disc: '1', srcBar: 1 },
            { strategyId: 'PHL_BOS_MSS' as const, strategyVersion: 'PHL_BOS_MSS_v1', eventType: 'PHL_MSS_BULL' as const, direction: 'bull' as const, disc: 'PH', srcBar: 1 },
            { strategyId: 'DTFX_ZONES' as const, strategyVersion: 'DTFX_ZONES_v1', eventType: 'DTFX_DEMAND_CREATED' as const, direction: 'bull' as const, disc: '1', srcBar: 1 },
            { strategyId: 'VAM_REVERSAL' as const, strategyVersion: 'VAM_v1', eventType: 'VAM_BUY' as const, direction: 'bull' as const, disc: 'BUY', srcBar: 3 }
        ];
        const tBase = 1_700_000_040_000;
        for (const tc of teacherCases) {
            const validEv = createStrategyEvent({
                strategyId: tc.strategyId,
                strategyVersion: tc.strategyVersion,
                symbol: 'SOLUSDT',
                timeframe: '1m',
                intervalMs: 60_000,
                eventType: tc.eventType,
                eventDirection: tc.direction,
                eventDiscriminator: tc.disc,
                sourceBarIndex: tc.srcBar,
                sourceTimestamp: tBase + tc.srcBar * 60_000,
                confirmationBarIndex: 3,
                confirmationTimestamp: tBase + 3 * 60_000,
                entryTimestamp: null,
                structuralContext: {}
            });
            assert(
                validEv.sourceBarIndex === tc.srcBar &&
                validEv.observationBarIndex === validEv.confirmationBarIndex &&
                validEv.confirmationBarIndex === 3 &&
                validEv.entryBarIndex === 4,
                `Factory must produce valid matching observation/confirmation indices for ${tc.strategyId}`
            );

            // Preceding valid event in the same batch must NOT be partially enqueued if a later event fails preflight
            const validPrecedingEv = createStrategyEvent({
                strategyId: tc.strategyId,
                strategyVersion: tc.strategyVersion,
                symbol: 'SOLUSDT',
                timeframe: '1m',
                intervalMs: 60_000,
                eventType: tc.eventType,
                eventDirection: tc.direction,
                eventDiscriminator: `${tc.disc}_PRECEDING`,
                sourceBarIndex: tc.srcBar,
                sourceTimestamp: tBase + tc.srcBar * 60_000,
                confirmationBarIndex: 3,
                confirmationTimestamp: tBase + 3 * 60_000,
                entryTimestamp: null,
                structuralContext: {}
            });

            // Isolate ONLY observationBarIndex mismatch while preserving valid eventId & all other chronology fields
            const mismatchedEv: StrategyEvent = Object.freeze({
                ...validEv,
                observationBarIndex: 2
            });

            const trackerZero = new MultiHorizonOutcomeTracker();
            let rejectedBatchMismatch = false;
            try {
                trackerZero.enqueueEvents([validPrecedingEv, mismatchedEv], 'SOLUSDT', '1m', dummyTierA, true);
            } catch (e: any) {
                rejectedBatchMismatch = String(e.message).includes('observationBarIndex === confirmationBarIndex');
            }
            assert(
                rejectedBatchMismatch && trackerZero.getPendingCount() === 0,
                `Atomic preflight must reject batch with mismatched observationBarIndex for ${tc.strategyId} without queuing validPrecedingEv`
            );
            const zeroAcc = trackerZero.finalizeEndOfStream(0);
            assert(
                zeroAcc.totalCandidateEvents === 0 &&
                zeroAcc.eligibleEvents === 0 &&
                zeroAcc.excludedMissingNextOpen === 0 &&
                zeroAcc.excludedUnwarmedAtr === 0 &&
                zeroAcc.excludedIncompleteHorizon === 0,
                `TrackerZero accounting must remain zeroed after atomic preflight rejection for ${tc.strategyId}`
            );

            const trackerTen = new MultiHorizonOutcomeTracker();
            let rejectedSingleMismatch = false;
            try {
                trackerTen.enqueueEvents([mismatchedEv], 'SOLUSDT', '1m', dummyTierA, true);
            } catch (e: any) {
                rejectedSingleMismatch = String(e.message).includes('observationBarIndex === confirmationBarIndex');
            }
            assert(
                rejectedSingleMismatch && trackerTen.getPendingCount() === 0,
                `Teacher ${tc.strategyId} event with mismatched observationBarIndex must be rejected before entering trackerTen`
            );
            const tenAcc = trackerTen.finalizeEndOfStream(10);
            assert(
                tenAcc.totalCandidateEvents === 0 &&
                tenAcc.eligibleEvents === 0 &&
                tenAcc.excludedMissingNextOpen === 0 &&
                tenAcc.excludedUnwarmedAtr === 0 &&
                tenAcc.excludedIncompleteHorizon === 0,
                `TrackerTen accounting must remain zeroed after rejected ${tc.strategyId} event`
            );
        }
    });

    await runTest('5. Full V3 Batch-vs-Streaming Byte-for-Byte CSV, SHA-256 & Complete Manifest Parity', async () => {
        assert(await runV3StreamingExportParityTest(650), 'V3 streaming parity failed');
    });

    console.log(`\nPhase 5D Phase 4 Acceptance: ${passed} passed, ${failed} failed.`);
    return failed === 0;
}
