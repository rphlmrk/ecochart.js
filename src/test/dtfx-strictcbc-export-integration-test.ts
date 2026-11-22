import JSZip from 'jszip';
import { AIExporter, DatasetAuditor } from '../data/AIExporter';
import { BufferedTextSink, StreamingDatasetExporter } from '../data/StreamingDatasetExporter';
import {
    MultiHorizonOutcomeTracker,
    serializeAndValidateStructuralContext,
    V3_EXP_DTFX_TEACHER_VERSION,
    V3_FROZEN_TEACHERS,
    V3_TEACHER_VERSION,
    type V3PipelineStrategyEvent,
    type V3TierAAtConfirmation
} from '../indicators/mlr1/pipeline/MultiHorizonOutcomeEngine';
import { parseCsvDocumentCRLF, serializeCsvRecord } from '../indicators/mlr1/pipeline/V3ArtifactAuditor';
import { createV3PipelineConfig } from '../indicators/mlr1/pipeline/V3PipelineEngine';
import type { DTFXStrictCBCTimeframe } from '../indicators/mlr1/teachers/DTFXStrictCBCTeacher';

function assert(condition: boolean, msg: string): asserts condition {
    if (!condition) throw new Error(`[DTFXStrictCBCExportIntegrationFailed] ${msg}`);
}

class MemoryCaptureStream {
    private readonly chunks: Uint8Array[] = [];
    public write = async (data: Uint8Array) => {
        this.chunks.push(data.slice());
    };
    public close = async () => {};
    public abort = async () => {
        this.chunks.length = 0;
    };
    public toStringUtf8(): string {
        const total = this.chunks.reduce((s, c) => s + c.length, 0);
        const merged = new Uint8Array(total);
        let off = 0;
        for (const c of this.chunks) {
            merged.set(c, off);
            off += c.length;
        }
        return new TextDecoder().decode(merged);
    }
}

/**
 * Generates multi-scale trending/reversing 1m candles whose structure creates valid
 * StrictCBC + BOS/CHoCH zones and retests across 1m, 3m, 5m, and 15m timeframes.
 */
function makeMultiScaleCandleBuffer(count: number, startTime = 1_700_000_040_000): Float64Array {
    const intervalMs = 60_000;
    const buf = new Float64Array(count * 6);
    let price = 100;
    for (let i = 0; i < count; i++) {
        // Primary 180-bar cycle + secondary 30-bar swing + 6-bar micro pullback
        const majorPhase = i % 240;
        const majorDir = majorPhase < 120 ? 1 : -1;
        const minorMod = i % 36;
        const minorDelta = minorMod < 22 ? 0.55 * majorDir : -0.42 * majorDir;
        const microMod = i % 6;
        const microDelta = microMod < 4 ? 0.28 * majorDir : -0.22 * majorDir;
        const delta = minorDelta + microDelta;

        const open = price;
        const close = Math.max(20, open + delta);
        const wick = 0.35 + (i % 5) * 0.08;
        const high = Math.max(open, close) + wick;
        const low = Math.max(10, Math.min(open, close) - wick);
        const volume = 120 + (i % 11) * 20;

        const off = i * 6;
        buf[off] = startTime + i * intervalMs;
        buf[off + 1] = open;
        buf[off + 2] = high;
        buf[off + 3] = low;
        buf[off + 4] = close;
        buf[off + 5] = volume;
        price = close;
    }
    return buf;
}

/**
 * Generates tight micro-oscillation candles that trigger fast 1m teachers (CBC/VAM/PHL)
 * without completing a 15m StrictCBC BOS/CHoCH zone lifecycle.
 */
function makeShortTightOscillationBuffer(count: number, startTime = 1_700_000_040_000): Float64Array {
    const intervalMs = 60_000;
    const buf = new Float64Array(count * 6);
    for (let i = 0; i < count; i++) {
        const close = i % 8 < 4 ? 100 + (i % 4) : 104 - (i % 4);
        const open = i % 2 === 1 ? close - 0.5 : close + 0.5;
        buf.set(
            [startTime + i * intervalMs, open, Math.max(open, close) + 1, Math.min(open, close) - 1, close, 100 + (i % 7)],
            i * 6
        );
    }
    return buf;
}

export async function runDTFXStrictCBCExportIntegrationTests(): Promise<boolean> {
    console.log('\n======================================================');
    console.log('🧪 Starting Step 3: DTFXStrictCBC Export Integration Suite');
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

    const fixedTs = 1_700_000_000_000;
    const richBuf = makeMultiScaleCandleBuffer(2800);
    const shortBuf = makeShortTightOscillationBuffer(650);

    await runTest('1. Default-mode parity (omitted vs [] vs frozen 4-teacher contract & exact col counts)', async () => {
        const omitted = await AIExporter.buildV3ExportArtifacts({
            rawCandleBuffer: shortBuf,
            symbol: 'SOLUSDT',
            interval: '1m',
            intervalMs: 60_000,
            include15mMtf: true,
            buildTimestamp: fixedTs
        });
        const emptyArr = await AIExporter.buildV3ExportArtifacts({
            rawCandleBuffer: shortBuf,
            symbol: 'SOLUSDT',
            interval: '1m',
            intervalMs: 60_000,
            include15mMtf: true,
            experimentalDtfxCbcTimeframes: [],
            buildTimestamp: fixedTs
        });

        assert(omitted.manifest.teacherVersion === V3_TEACHER_VERSION, 'Omitted mode must emit frozen V3_TEACHER_VERSION');
        assert(emptyArr.manifest.teacherVersion === V3_TEACHER_VERSION, 'Empty [] mode must emit frozen V3_TEACHER_VERSION');
        assert(omitted.manifest.experimentalTeachers === undefined, 'Omitted mode must omit experimentalTeachers');
        assert(emptyArr.manifest.experimentalTeachers === undefined, 'Empty [] mode must omit experimentalTeachers');
        assert(omitted.continuousCsv === emptyArr.continuousCsv, 'Continuous CSV must match byte-for-byte');
        assert(omitted.representationCsv === emptyArr.representationCsv, 'Representation CSV must match byte-for-byte');
        assert(omitted.strategyEventsCsv === emptyArr.strategyEventsCsv, 'StrategyEvents CSV must match byte-for-byte');
        assert(JSON.stringify(omitted.manifest) === JSON.stringify(emptyArr.manifest), 'Manifest must match byte-for-byte');

        const contCols = parseCsvDocumentCRLF(omitted.continuousCsv)[0].length;
        const repCols = parseCsvDocumentCRLF(omitted.representationCsv)[0].length;
        const evCols = parseCsvDocumentCRLF(omitted.strategyEventsCsv)[0].length;
        assert(contCols === 281, `Expected 281 Continuous cols, got ${contCols}`);
        assert(repCols === 28, `Expected 28 Representation cols, got ${repCols}`);
        assert(evCols === 60, `Expected 60 StrategyEvents cols, got ${evCols}`);

        const strategies = new Set(omitted.strategyEventRows.map(r => r.strategy_id));
        for (const s of strategies) {
            assert((V3_FROZEN_TEACHERS as readonly string[]).includes(s), `Unexpected strategy '${s}' in frozen mode`);
        }
        assert(!strategies.has('DTFX_STRICTCBC'), 'Frozen mode must never emit DTFX_STRICTCBC');
    });

    await runTest('2. Experimental activation (1m, 3m, 5m, 15m separately & combined) + CREATED/RETESTED + 60/120/180 outcomes', async () => {
        for (const tf of ['1m', '3m', '5m', '15m'] as const) {
            const single = await AIExporter.buildV3ExportArtifacts({
                rawCandleBuffer: richBuf,
                symbol: 'SOLUSDT',
                interval: '1m',
                intervalMs: 60_000,
                include15mMtf: true,
                experimentalDtfxCbcTimeframes: [tf],
                buildTimestamp: fixedTs
            });
            assert(
                single.manifest.teacherVersion === V3_EXP_DTFX_TEACHER_VERSION,
                `${tf}: expected V3_EXP_DTFX_TEACHER_VERSION`
            );
            assert(
                JSON.stringify(single.manifest.experimentalTeachers?.dtfxStrictCbc?.zoneTimeframes) === JSON.stringify([tf]),
                `${tf}: manifest zoneTimeframes mismatch`
            );
            const expRows = single.strategyEventRows.filter(r => r.strategy_id === 'DTFX_STRICTCBC');
            assert(expRows.length > 0, `${tf}: expected > 0 DTFX_STRICTCBC events`);
            const hasCreated = expRows.some(r => r.event_type === 'DTFX_CBC_DEMAND_CREATED' || r.event_type === 'DTFX_CBC_SUPPLY_CREATED');
            const hasRetested = expRows.some(r => r.event_type === 'DTFX_CBC_DEMAND_RETEST' || r.event_type === 'DTFX_CBC_SUPPLY_RETEST');
            assert(hasCreated && hasRetested, `${tf}: expected both CREATED and RETESTED DTFX_STRICTCBC events`);
            for (const row of expRows) {
                const ctx = JSON.parse(row.structural_context_json);
                assert(ctx.zoneTimeframe === tf, `${tf}: expected zoneTimeframe='${tf}', got '${ctx.zoneTimeframe}'`);
                assert(Number.isFinite(row.long_net_r_60) && Number.isFinite(row.long_net_r_120) && Number.isFinite(row.long_net_r_180), 'Expected finite 60/120/180 outcomes');
            }
        }

        const combined = await AIExporter.buildV3ExportArtifacts({
            rawCandleBuffer: richBuf,
            symbol: 'SOLUSDT',
            interval: '1m',
            intervalMs: 60_000,
            include15mMtf: true,
            experimentalDtfxCbcTimeframes: ['1m', '3m', '5m', '15m'],
            buildTimestamp: fixedTs
        });
        assert(combined.manifest.teacherVersion === V3_EXP_DTFX_TEACHER_VERSION, 'Combined: expected V3_EXP_DTFX_TEACHER_VERSION');
        assert(
            JSON.stringify(combined.manifest.experimentalTeachers?.dtfxStrictCbc?.zoneTimeframes) ===
                JSON.stringify(['1m', '3m', '5m', '15m']),
            'Combined: manifest zoneTimeframes mismatch'
        );
        assert(parseCsvDocumentCRLF(combined.continuousCsv)[0].length === 281, 'Combined Continuous col count must remain 281');
        assert(parseCsvDocumentCRLF(combined.representationCsv)[0].length === 28, 'Combined Representation col count must remain 28');
        assert(parseCsvDocumentCRLF(combined.strategyEventsCsv)[0].length === 60, 'Combined StrategyEvents col count must remain 60');

        const repRecords = parseCsvDocumentCRLF(combined.representationCsv);
        const repStratCol = repRecords[0].indexOf('tierB_strategy_id');
        const repCtxCol = repRecords[0].indexOf('tierB_structural_context_json');
        const repTfs = new Set(
            repRecords
                .slice(1)
                .filter(r => r[repStratCol] === 'DTFX_STRICTCBC')
                .map(r => JSON.parse(r[repCtxCol]).zoneTimeframe)
        );
        for (const tf of ['1m', '3m', '5m', '15m'] as const) {
            assert(repTfs.has(tf), `Combined Representation_Features.csv missing zoneTimeframe '${tf}'`);
        }

        const zipBytes = await AIExporter.createVerifiedV3DatasetArchive(combined, richBuf);
        const reopened = await JSZip.loadAsync(zipBytes);
        assert(Object.keys(reopened.files).filter(n => !reopened.files[n].dir).length === 4, 'Combined ZIP must contain 4 files');
    });

    await runTest('3. Invalid base timeframe rejected at config & exporter boundaries', async () => {
        const expectThrow = (fn: () => unknown, label: string) => {
            let threw = false;
            try {
                fn();
            } catch {
                threw = true;
            }
            assert(threw, `${label}: expected rejection`);
        };

        expectThrow(
            () =>
                createV3PipelineConfig({
                    symbol: 'SOLUSDT',
                    interval: '5m',
                    intervalMs: 300_000,
                    include15mMtf: false,
                    experimentalDtfxCbcTimeframes: ['5m']
                }),
            '5m base interval in createV3PipelineConfig'
        );
        expectThrow(
            () =>
                createV3PipelineConfig({
                    symbol: 'SOLUSDT',
                    interval: '1m',
                    intervalMs: 300_000,
                    include15mMtf: false,
                    experimentalDtfxCbcTimeframes: ['1m']
                }),
            '1m interval with non-60000 intervalMs'
        );

        let batchThrew = false;
        try {
            await AIExporter.buildV3ExportArtifacts({
                rawCandleBuffer: makeMultiScaleCandleBuffer(650),
                symbol: 'SOLUSDT',
                interval: '5m',
                intervalMs: 300_000,
                include15mMtf: false,
                experimentalDtfxCbcTimeframes: ['5m'],
                buildTimestamp: fixedTs
            });
        } catch {
            batchThrew = true;
        }
        assert(batchThrew, 'AIExporter.buildV3ExportArtifacts must reject 5m base interval');
    });

    await runTest('4. Invalid / duplicate / empty experimental timeframes enforcement', () => {
        const expectThrow = (fn: () => unknown, label: string) => {
            let threw = false;
            try {
                fn();
            } catch {
                threw = true;
            }
            assert(threw, `${label}: expected rejection`);
        };

        expectThrow(
            () =>
                createV3PipelineConfig({
                    symbol: 'SOLUSDT',
                    interval: '1m',
                    intervalMs: 60_000,
                    experimentalDtfxCbcTimeframes: ['2m' as unknown as DTFXStrictCBCTimeframe]
                }),
            'unsupported 2m timeframe'
        );
        expectThrow(
            () =>
                createV3PipelineConfig({
                    symbol: 'SOLUSDT',
                    interval: '1m',
                    intervalMs: 60_000,
                    experimentalDtfxCbcTimeframes: ['15m', '15m']
                }),
            'duplicate 15m timeframe'
        );

        const emptyCfg = createV3PipelineConfig({
            symbol: 'SOLUSDT',
            interval: '1m',
            intervalMs: 60_000,
            experimentalDtfxCbcTimeframes: []
        });
        assert(emptyCfg.experimentalDtfxCbcTimeframes.length === 0, 'Empty [] config must preserve 4-teacher mode');
        assert(emptyCfg.dtfxStrictCbcConfigs.length === 0, 'Empty [] config must create 0 experimental teacher configs');
    });

    await runTest('5. Cross-contract rejection (DTFX_STRICTCBC row in frozen 4-teacher audit)', async () => {
        const expArtifacts = await AIExporter.buildV3ExportArtifacts({
            rawCandleBuffer: richBuf,
            symbol: 'SOLUSDT',
            interval: '1m',
            intervalMs: 60_000,
            experimentalDtfxCbcTimeframes: ['1m'],
            buildTimestamp: fixedTs
        });
        const strictAudit = DatasetAuditor.runV3CausalityAudit({
            rawCandleBuffer: richBuf,
            intervalMs: 60_000,
            expectedContinuousRows: expArtifacts.manifest.acceptedObservationCount,
            expectedEventRows: expArtifacts.strategyEventRows.length,
            continuousCsv: expArtifacts.continuousCsv,
            representationCsv: expArtifacts.representationCsv,
            strategyEventsCsv: expArtifacts.strategyEventsCsv,
            include15mMtf: true,
            includeExperimentalDtfxCbc: false,
            is1mBase: true
        });
        assert(!strictAudit.passed, 'Frozen 4-teacher auditor must reject DTFX_STRICTCBC rows');

        // Also test spoofing strategy_id as DTFX_ZONES while keeping DTFX_CBC_DEMAND_CREATED event_type
        const frozenArtifacts = await AIExporter.buildV3ExportArtifacts({
            rawCandleBuffer: shortBuf,
            symbol: 'SOLUSDT',
            interval: '1m',
            intervalMs: 60_000,
            buildTimestamp: fixedTs
        });
        const evRecords = parseCsvDocumentCRLF(frozenArtifacts.strategyEventsCsv);
        const repRecords = parseCsvDocumentCRLF(frozenArtifacts.representationCsv);
        const evTypeCol = evRecords[0].indexOf('event_type');
        const repTypeCol = repRecords[0].indexOf('tierB_event_type');
        evRecords[1][evTypeCol] = 'DTFX_CBC_DEMAND_CREATED';
        repRecords[1][repTypeCol] = 'DTFX_CBC_DEMAND_CREATED';
        const spoofAudit = DatasetAuditor.runV3CausalityAudit({
            rawCandleBuffer: shortBuf,
            intervalMs: 60_000,
            expectedContinuousRows: 650,
            expectedEventRows: frozenArtifacts.strategyEventRows.length,
            continuousCsv: frozenArtifacts.continuousCsv,
            representationCsv: repRecords.map(serializeCsvRecord).join('\r\n'),
            strategyEventsCsv: evRecords.map(serializeCsvRecord).join('\r\n'),
            include15mMtf: true,
            includeExperimentalDtfxCbc: false,
            is1mBase: true
        });
        assert(!spoofAudit.passed, 'Auditor must reject DTFX_CBC_* event_type under frozen strategy_id');
    });

    await runTest('6. Manifest tampering rejection in createVerifiedV3DatasetArchive', async () => {
        const expArtifacts = await AIExporter.buildV3ExportArtifacts({
            rawCandleBuffer: richBuf,
            symbol: 'SOLUSDT',
            interval: '1m',
            intervalMs: 60_000,
            experimentalDtfxCbcTimeframes: ['1m', '5m'],
            buildTimestamp: fixedTs
        });

        const expectArchiveReject = async (tamperedManifest: typeof expArtifacts.manifest, label: string) => {
            let threw = false;
            try {
                await AIExporter.createVerifiedV3DatasetArchive(
                    { ...expArtifacts, manifest: tamperedManifest },
                    richBuf
                );
            } catch {
                threw = true;
            }
            assert(threw, `${label}: createVerifiedV3DatasetArchive must reject tampered manifest`);
        };

        await expectArchiveReject(
            { ...expArtifacts.manifest, teacherVersion: 'UNKNOWN_TEACHER_v9' },
            'unknown teacherVersion'
        );
        await expectArchiveReject(
            { ...expArtifacts.manifest, teacherVersion: V3_TEACHER_VERSION },
            'downgraded frozen V3_TEACHER_VERSION with experimental metadata & rows'
        );
        await expectArchiveReject(
            { ...expArtifacts.manifest, experimentalTeachers: undefined },
            'missing experimentalTeachers metadata'
        );
        await expectArchiveReject(
            {
                ...expArtifacts.manifest,
                experimentalTeachers: {
                    dtfxStrictCbc: {
                        enabled: true,
                        version: 'DTFX_STRICTCBC_v1',
                        baseTimeframe: '1m',
                        zoneTimeframes: []
                    }
                }
            },
            'empty zoneTimeframes'
        );
        await expectArchiveReject(
            {
                ...expArtifacts.manifest,
                experimentalTeachers: {
                    dtfxStrictCbc: {
                        enabled: true,
                        version: 'DTFX_STRICTCBC_v1',
                        baseTimeframe: '1m',
                        zoneTimeframes: ['15m']
                    }
                }
            },
            'mismatched zoneTimeframes vs remarks'
        );
    });

    await runTest('7. Missing ATR nullable metrics + unwarmed-ATR tracker exclusion', () => {
        const validNullJson = serializeAndValidateStructuralContext('DTFX_STRICTCBC', {
            zoneTimeframe: '1m',
            zoneId: 1,
            zoneStatus: 'CREATED',
            isChoch: false,
            retestCount: 0,
            zoneCreatedSourceBarIndex: 2,
            zoneCreatedConfirmationBarIndex: 5,
            zoneTop: 102,
            zoneBot: 100,
            fib03: 101.4,
            fib05: 101,
            fib07: 100.6,
            atr14Valid: false,
            zoneWidthAtr: null,
            fib05DistAtr: null
        });
        const parsed = JSON.parse(validNullJson);
        assert(parsed.atr14Valid === false && parsed.zoneWidthAtr === null && parsed.fib05DistAtr === null, 'Expected serialized null ATR fields');

        let invalidNullThrew = false;
        try {
            serializeAndValidateStructuralContext('DTFX_STRICTCBC', {
                atr14Valid: true,
                zoneWidthAtr: null,
                fib05DistAtr: null
            });
        } catch {
            invalidNullThrew = true;
        }
        assert(invalidNullThrew, 'Null zoneWidthAtr must be rejected when atr14Valid === true');

        let frozenNullThrew = false;
        try {
            serializeAndValidateStructuralContext('DTFX_ZONES', { zoneWidthAtr: null });
        } catch {
            frozenNullThrew = true;
        }
        assert(frozenNullThrew, 'Null must be rejected on frozen DTFX_ZONES strategy');

        // Verify MultiHorizonOutcomeTracker excludes unwarmed-ATR DTFX_STRICTCBC events cleanly
        const tracker = new MultiHorizonOutcomeTracker(['DTFX_STRICTCBC']);
        const baseTs = 1_700_000_040_000;
        const ev: V3PipelineStrategyEvent = {
            eventId: 'SE1|14:DTFX_STRICTCBC|15:DTFX_STRICTCBC_v1|7:SOLUSDT|2:1m|23:DTFX_CBC_DEMAND_CREATED|1:2|1:5|36:SOLUSDT:1m:1m:bull:1700000160000:1700000340000:C',
            eventDiscriminator: 'SOLUSDT:1m:1m:bull:1700000160000:1700000340000:C',
            strategyId: 'DTFX_STRICTCBC',
            strategyVersion: 'DTFX_STRICTCBC_v1',
            eventType: 'DTFX_CBC_DEMAND_CREATED',
            eventDirection: 'bull',
            sourceBarIndex: 2,
            sourceTimestamp: baseTs + 2 * 60_000,
            confirmationBarIndex: 5,
            confirmationTimestamp: baseTs + 5 * 60_000,
            confirmationLagBars: 3,
            observationBarIndex: 5,
            observationTimestamp: baseTs + 6 * 60_000,
            entryBarIndex: 6,
            entryTimestamp: null,
            structuralContext: JSON.parse(validNullJson)
        };
        const tierA: V3TierAAtConfirmation = {
            tierAObservationId: 'OBS_5',
            atr14: 0,
            exhaustion20: 0,
            exhaustion20Valid: false,
            vcsRatio360: 0,
            vcsZScore360: 0,
            vcsRegime360: 0,
            vcsValid: false,
            vamCenterDistAtr: 0,
            vamSlope3Atr: 0,
            vamEfficiency: 0,
            vamAdx14: 0,
            vamDiSpread14: 0,
            vamRsi14: 0,
            vamTrend: 0,
            vamValid: false,
            context15mAvailable: false,
            context15mStatus: 'UNAVAILABLE'
        };
        tracker.enqueueEvents([ev], 'SOLUSDT', '1m', tierA, false);
        const emitted = tracker.stepBar(6, {
            time: baseTs + 6 * 60_000,
            open: 101,
            high: 102,
            low: 100,
            close: 101.5
        });
        assert(emitted.length === 0, 'Unwarmed ATR event must not emit outcome row');
        const acct = tracker.finalizeEndOfStream(200);
        assert(acct.excludedUnwarmedAtr === 1 && acct.eligibleEvents === 0, 'Unwarmed ATR exclusion accounting mismatch');
        assert(acct.countsByStrategy['DTFX_STRICTCBC'] === 0, 'Expected DTFX_STRICTCBC count === 0 after exclusion');
    });

    await runTest('8. Zero-event policy (0 eligible DTFX_STRICTCBC events on 15m short slice)', async () => {
        const zeroExp = await AIExporter.buildV3ExportArtifacts({
            rawCandleBuffer: shortBuf,
            symbol: 'SOLUSDT',
            interval: '1m',
            intervalMs: 60_000,
            include15mMtf: true,
            experimentalDtfxCbcTimeframes: ['15m'],
            buildTimestamp: fixedTs
        });
        assert(zeroExp.manifest.teacherVersion === V3_EXP_DTFX_TEACHER_VERSION, 'Zero-event slice must emit V3_EXP_DTFX_TEACHER_VERSION');
        assert(zeroExp.outcomeAccounting.countsByStrategy['DTFX_STRICTCBC'] === 0, 'Expected countsByStrategy.DTFX_STRICTCBC === 0');
        assert(
            zeroExp.strategyEventRows.filter(r => r.strategy_id === 'DTFX_STRICTCBC').length === 0,
            'Expected 0 DTFX_STRICTCBC rows in CSV'
        );
        assert(
            zeroExp.manifest.auditResults.remarks.some(r => r.includes('"DTFX_STRICTCBC":0')),
            'Manifest remarks must explicitly record DTFX_STRICTCBC: 0'
        );
        const zipBytes = await AIExporter.createVerifiedV3DatasetArchive(zeroExp, shortBuf);
        assert(zipBytes.byteLength > 0, 'Zero-event experimental export must archive cleanly');
    });

    await runTest('9. Batch vs Streaming byte-for-byte parity (experimental 1m/3m/5m/15m mode)', async () => {
        const parityBuf = richBuf.subarray(0, 1400 * 6);
        const batch = await AIExporter.buildV3ExportArtifacts({
            rawCandleBuffer: parityBuf,
            symbol: 'SOLUSDT',
            interval: '1m',
            intervalMs: 60_000,
            include15mMtf: true,
            experimentalDtfxCbcTimeframes: ['1m', '3m', '5m', '15m'],
            buildTimestamp: fixedTs
        });

        const memCont = new MemoryCaptureStream();
        const memRep = new MemoryCaptureStream();
        const memEv = new MemoryCaptureStream();
        const streamed = await StreamingDatasetExporter.runV3StreamingCore({
            rawCandleBuffer: parityBuf,
            symbol: 'SOLUSDT',
            interval: '1m',
            intervalMs: 60_000,
            include15mMtf: true,
            experimentalDtfxCbcTimeframes: ['1m', '3m', '5m', '15m'],
            buildTimestamp: fixedTs,
            continuousSink: new BufferedTextSink(memCont, 128),
            representationSink: new BufferedTextSink(memRep, 128),
            strategyEventSink: new BufferedTextSink(memEv, 128)
        });

        assert(memCont.toStringUtf8() === batch.continuousCsv, 'Experimental Continuous CSV parity mismatch');
        assert(memRep.toStringUtf8() === batch.representationCsv, 'Experimental Representation CSV parity mismatch');
        assert(memEv.toStringUtf8() === batch.strategyEventsCsv, 'Experimental StrategyEvents CSV parity mismatch');
        assert(
            streamed.fileChecksums[batch.continuousFileName].sha256 === batch.verifiedFileChecksums.continuousSha256 &&
            streamed.fileChecksums[batch.representationFileName].sha256 === batch.verifiedFileChecksums.representationSha256 &&
            streamed.fileChecksums[batch.strategyEventsFileName].sha256 === batch.verifiedFileChecksums.strategyEventsSha256,
            'Experimental SHA-256 parity mismatch'
        );
        assert(JSON.stringify(streamed.manifest) === JSON.stringify(batch.manifest), 'Experimental manifest parity mismatch');
        assert(
            (batch.outcomeAccounting.countsByStrategy['DTFX_STRICTCBC'] ?? 0) > 0,
            'Expected > 0 DTFX_STRICTCBC events in 1400-candle experimental parity run'
        );
    });

    console.log(`\nStep 3 Export Integration Suite: ${passed} passed, ${failed} failed.\n`);
    return failed === 0;
}
