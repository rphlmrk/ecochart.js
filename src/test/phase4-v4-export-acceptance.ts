import JSZip from 'jszip';
import {
    buildV4ExportArtifacts,
    createVerifiedV4DatasetArchive,
    DatasetAuditor
} from '../data/AIExporter';
import { runV4StreamingExportParityTest } from '../data/StreamingDatasetExporter';
import {
    createML1ZipExportRequest,
    validateML1ExportRequestAgainstManifest
} from '../indicators/mlr1/integration/ML1IntegrationTypes';
import { validateV4DatasetManifest } from '../indicators/mlr1/pipeline/V4CsvSerializer';
import {
    V4_FROZEN_TEACHERS,
    V4_HORIZONS,
    V4_OUTCOME_CONFIG_VERSION,
    V4_STOP_ATR_MULT,
    V4_TARGET_R_MULT,
    V4_TRADE_COST_R,
    V4MultiHorizonOutcomeTracker,
    assertV4RepresentationZeroTierCLeakage,
    serializeAndValidateV4StructuralContext,
    type V4PipelineStrategyEvent,
    type V4TierAAtConfirmation
} from '../indicators/mlr1/pipeline/V4OutcomeContracts';
import { createV4PipelineConfig, V4PipelineRunner } from '../indicators/mlr1/pipeline/V4PipelineEngine';
import { parseCsvDocumentCRLF, serializeCsvRecord } from '../indicators/mlr1/pipeline/V3ArtifactAuditor';
import { TIER_C_V4_QUARANTINE_LIST } from '../indicators/mlr1/dataset/DatasetSchema';
import { MTF_V4_CONFIG_D } from '../indicators/mlr1/mtf/MTFConfig';
import { createInitialV4MTFState } from '../indicators/mlr1/mtf/MTFState';
import { stepV4MTFCombined } from '../indicators/mlr1/mtf/MTFFeatureEngine';

function assert(condition: boolean, msg: string): asserts condition {
    if (!condition) throw new Error(`[Phase4V4Failed] ${msg}`);
}

function makeWaveBuffer(count: number, startTime: number, dt = 60_000, scale = 1.0): Float64Array {
    const buf = new Float64Array(count * 6);
    let price = 100 * scale;
    for (let i = 0; i < count; i++) {
        const major = Math.floor(i / 180) % 2 === 0 ? 1 : -1;
        const swing = (i % 60) < 35 ? major : -0.65 * major;
        const micro = (i % 5 === 0) ? -0.4 * swing : 0.65 * swing;
        const open = price;
        const close = Math.max(0.0001, open + micro * scale);
        buf.set(
            [startTime + i * dt, open, Math.max(open, close) + 0.5 * scale, Math.min(open, close) - 0.5 * scale, close, 100 + (i % 7) * 15],
            i * 6
        );
        price = close;
    }
    return buf;
}

function makeDummyTierA(obsId: string, atr = 2.0): V4TierAAtConfirmation {
    return {
        tierAObservationId: obsId,
        atr14: atr,
        exhaustion14: 0, exhaustion14Valid: true,
        exhaustion20: 0, exhaustion20Valid: true,
        vcsRatio360: 1.0, vcsZScore360: 0, vcsRegime360: 0, vcsValid: true,
        vamCenterDistAtr: 0, vamSlope3Atr: 0, vamEfficiency: 0.5, vamAdx14: 25,
        vamDiSpread14: 5, vamRsi14: 55, vamTrend: 1, vamValid: true,
        sma20DistAtr: 0, sma50DistAtr: 0, sma200DistAtr: 0, sma20Above50: 1, sma50Above200: 1, smaValid: true,
        macdLineAtr: 0, macdSignalAtr: 0, macdHistAtr: 0, macdValid: true,
        bbWidth20: 0.02, bbPctB20: 0.5, bbValid: true,
        context3mAvailable: true, context3mStatus: 'AVAILABLE_VALID',
        context5mAvailable: true, context5mStatus: 'AVAILABLE_VALID'
    };
}

function makeDummyEvent(confBar: number, t0: number, dt: number, idSuffix = 'A'): V4PipelineStrategyEvent {
    return {
        eventId: `SE1|7:VAM_BUY|${confBar}|${idSuffix}`,
        eventDiscriminator: `DISC_${confBar}_${idSuffix}`,
        strategyId: 'VAM_REVERSAL',
        strategyVersion: 'VAM_v1',
        eventType: 'VAM_BUY',
        eventDirection: 'bull',
        sourceBarIndex: confBar,
        sourceTimestamp: t0 + confBar * dt,
        confirmationBarIndex: confBar,
        confirmationTimestamp: t0 + confBar * dt,
        confirmationLagBars: 0,
        observationBarIndex: confBar,
        observationTimestamp: t0 + (confBar + 1) * dt,
        entryBarIndex: confBar + 1,
        entryTimestamp: null,
        structuralContext: {
            vamTrendPostTransition: 1, centerDistAtr: 0.6, slope3Atr: 0.2,
            adx14: 25, diSpread14: 10, rsi14: 60, buyStreak: 2, sellStreak: 0
        }
    };
}

export async function runPhase4V4ExportAcceptanceTests(): Promise<boolean> {
    console.log('\n======================================================');
    console.log('🧪 Starting Phase 4 (V4 Pipeline & Export) Acceptance Suite');
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

    const t0 = Date.UTC(2026, 9, 15, 0, 0, 0); // Strictly aligned to 900_000ms (both 3m & 5m)
    const dt = 60_000;
    const waveBuf = makeWaveBuffer(1400, t0, dt);

    await runTest('1. V4 config validation, pinned economics & retired teacher/15m rejection', () => {
        assert(V4_STOP_ATR_MULT === 1.5 && V4_TARGET_R_MULT === 2.0 && V4_TRADE_COST_R === 0.05 &&
            V4_HORIZONS.join(',') === '60,120,180' && V4_OUTCOME_CONFIG_VERSION.includes('SL1.5ATR_RR2.0_COST0.05R'),
            'V4 outcome economics must be pinned explicitly');

        const expectThrow = (fn: () => unknown, label: string) => {
            let threw = false;
            try { fn(); } catch { threw = true; }
            assert(threw, `${label}: expected rejection`);
        };
        expectThrow(() => createV4PipelineConfig({ symbol: 'SOLUSDT', interval: '5m', intervalMs: 300_000 }), 'non-1m base');
        expectThrow(() => createV4PipelineConfig({ symbol: 'SOLUSDT', interval: '1m', intervalMs: dt, phlTimeframes: ['1m', '15m' as any] }), '15m PHL');
        expectThrow(() => createV4PipelineConfig({ symbol: 'SOLUSDT', interval: '1m', intervalMs: dt, dtfxStrictCbcTimeframes: ['3m', '3m'] }), 'dup DTFX');
        expectThrow(() => serializeAndValidateV4StructuralContext('DTFX_ZONES' as any, {}), 'retired DTFX_ZONES');
        expectThrow(() => serializeAndValidateV4StructuralContext('DTFX_STRICTCBC', { zoneTimeframe: '15m', atr14Valid: true }), '15m in DTFX_STRICTCBC context');
        expectThrow(() => serializeAndValidateV4StructuralContext('PHL_BOS_MSS', { phlTimeframe: '15m', hasProtectedLevel: false, atr14Valid: false }), '15m in PHL context');
    });

    await runTest('2. Outcome tracker atomic validation, cross-bar duplicate IDs, immutable copies, H60/120/180 boundaries & stop-first', () => {
        const tracker = new V4MultiHorizonOutcomeTracker();
        const tierA = makeDummyTierA('OBS_0', 2.0);
        const ev0 = makeDummyEvent(0, t0, dt, 'OK');
        tracker.stepBar(0, { time: t0, open: 100, high: 100.5, low: 99.5, close: 100 });
        tracker.enqueueEvents([ev0], 'SOLUSDT', '1m', tierA, true);

        // Adversarial malformed inputs must throw WITHOUT mutating pending, totalCandidates, or seenEventIds
        const expectEnqueueReject = (events: any[], label: string, badTierA: any = tierA, atrValid = true) => {
            const beforePending = tracker.getPendingCount();
            const beforeAcc = JSON.stringify(tracker.getAccountingSnapshot());
            const beforeSeen = tracker.getSeenEventIdCount();
            let threw = false;
            try { tracker.enqueueEvents(events, 'SOLUSDT', '1m', badTierA, atrValid); } catch { threw = true; }
            assert(
                threw &&
                tracker.getPendingCount() === beforePending &&
                JSON.stringify(tracker.getAccountingSnapshot()) === beforeAcc &&
                tracker.getSeenEventIdCount() === beforeSeen,
                `${label}: must reject atomically without mutating pending, accounting, or seenEventIds`
            );
        };

        expectEnqueueReject([{ ...ev0, eventId: '' }], 'blank eventId');
        expectEnqueueReject([{ ...ev0, strategyId: 'DTFX_ZONES' }], 'retired strategyId');
        expectEnqueueReject([{ ...ev0, eventType: 'PHL_BOS_BULL' }], 'mismatched eventType for VAM_REVERSAL');
        expectEnqueueReject([{ ...ev0, strategyVersion: '' }], 'blank strategyVersion');
        expectEnqueueReject([{ ...ev0, eventDirection: 'sideways' }], 'invalid direction');
        expectEnqueueReject([{ ...ev0, sourceBarIndex: 5, confirmationBarIndex: 4 }], 'source > confirmation');
        expectEnqueueReject([{ ...ev0, confirmationLagBars: 99 }], 'bad lag');
        expectEnqueueReject([{ ...ev0, entryBarIndex: 99 }], 'bad entryBarIndex');
        expectEnqueueReject([{ ...ev0, observationTimestamp: t0 }], 'bad observationTimestamp');
        expectEnqueueReject([{ ...ev0, confirmationTimestamp: t0 + dt }], 'confirmationTimestamp disagrees with stepBar(0) clock');
        expectEnqueueReject([{ ...ev0, structuralContext: { badKey: 1 } }], 'malformed structuralContext');
        expectEnqueueReject([{ ...makeDummyEvent(5, t0, dt, 'DUP'), eventId: ev0.eventId }], 'duplicate eventId at different bar/tuple');
        expectEnqueueReject([makeDummyEvent(1, t0, dt, 'B1'), makeDummyEvent(1, t0, dt, 'B1')], 'duplicate eventId within batch');
        expectEnqueueReject([makeDummyEvent(1, t0, dt, 'T1')], 'non-finite tierA', { ...tierA, atr14: Number.NaN });
        expectEnqueueReject([makeDummyEvent(1, t0, dt, 'T2')], 'extra key in tierA', { ...tierA, extraField: 1 });
        expectEnqueueReject([makeDummyEvent(1, t0, dt, 'T3')], 'inconsistent tierA context3mAvailable vs status', { ...tierA, context3mAvailable: false, context3mStatus: 'AVAILABLE_VALID' });

        // Post-enqueue mutation of caller objects must NOT affect queued ev0
        const evMutable = makeDummyEvent(1, t0, dt, 'MUT');
        const tierAMutable = makeDummyTierA('OBS_1', 2.0);
        tracker.stepBar(1, { time: t0 + dt, open: 100, high: 100.5, low: 99.5, close: 100 });
        tracker.enqueueEvents([evMutable], 'SOLUSDT', '1m', tierAMutable, true);
        (evMutable as any).eventDirection = 'bear';
        (evMutable.structuralContext as any).rsi14 = -999;
        (tierAMutable as any).atr14 = 9999;

        // No-barrier test: distinct closes at bars 60 (H60), 120 (H120), 180 (H180), and wild spikes at 61, 121, 181 (must be excluded for prior horizon!)
        const tNoBarrier = new V4MultiHorizonOutcomeTracker();
        tNoBarrier.enqueueEvents([makeDummyEvent(0, t0, dt, 'NB')], 'SOLUSDT', '1m', makeDummyTierA('OBS_NB', 2.0), true);
        let nbRow!: ReturnType<V4MultiHorizonOutcomeTracker['stepBar']>[number];
        for (let b = 1; b <= 181; b++) {
            // entry = bar 1 (open=100, risk=3, lStop=97, lTarget=106). No bar breaches 97 or 106; closes at 60/120/180 differ from 61/121/181!
            let c = 100;
            if (b === 60) c = 100.6;       // +0.2R - 0.05R = +0.15R
            else if (b === 61) c = 98.5;   // Excluded from H60!
            else if (b === 120) c = 99.4;  // -0.2R - 0.05R = -0.25R
            else if (b === 121) c = 102.0; // Excluded from H120!
            else if (b === 180) c = 101.5; // +0.5R - 0.05R = +0.45R
            else if (b === 181) c = 98.0;  // Excluded from H180!
            const rows = tNoBarrier.stepBar(b, { time: t0 + b * dt, open: 100, high: 100.5, low: 99.5, close: c });
            if (b === 180) {
                assert(rows.length === 1, 'Expected resolution exactly at entryBar + 180 - 1 = 180');
                nbRow = rows[0];
            }
            if (b === 181) assert(rows.length === 0, 'Bar 181 must not emit duplicate or alter H180');
        }
        assert(nbRow.long_outcome_60 === 'timeout_net_gain' && Math.abs(nbRow.long_exit_price_60 - 100.6) < 1e-12 && Math.abs(nbRow.long_net_r_60 - 0.15) < 1e-9, 'Inclusive H60 boundary failed');
        assert(nbRow.long_outcome_120 === 'timeout_net_loss' && Math.abs(nbRow.long_exit_price_120 - 99.4) < 1e-12 && Math.abs(nbRow.long_net_r_120 - (-0.25)) < 1e-9, 'Inclusive H120 boundary failed');
        assert(nbRow.long_outcome_180 === 'timeout_net_gain' && Math.abs(nbRow.long_exit_price_180 - 101.5) < 1e-12 && Math.abs(nbRow.long_net_r_180 - 0.45) < 1e-9, 'Inclusive H180 boundary failed');

        // Separate stop-first simultaneous SL+TP test + confirm evMutable was insulated from caller mutations
        for (let b = 2; b <= 181; b++) {
            const h = b === 60 ? 108 : 100.5;
            const l = b === 60 ? 96 : 99.5;
            const rows = tracker.stepBar(b, { time: t0 + b * dt, open: 100, high: h, low: l, close: 100 });
            for (const r of rows) {
                if (r.event_id === ev0.eventId) assert(r.long_outcome_60 === 'hard_stop', 'Simultaneous SL/TP stop-first');
                if (r.event_id === evMutable.eventId) {
                    assert(r.event_direction === 'bull' && r.atr_at_confirmation === 2.0 && JSON.parse(r.structural_context_json).rsi14 === 60,
                        'Queued event/tierA must stay immutable against post-enqueue caller mutation');
                }
            }
        }
    });

    await runTest('3. Four-teacher roster, aligned MTF gap/invalid/duplicate counter separation & manifest validation', async () => {
        const artifacts = await buildV4ExportArtifacts({
            rawCandleBuffer: waveBuf,
            symbol: 'SOLUSDT',
            interval: '1m',
            intervalMs: dt,
            buildTimestamp: 1_700_000_000_000
        });

        for (const s of V4_FROZEN_TEACHERS) {
            assert((artifacts.outcomeAccounting.countsByStrategy[s] ?? 0) > 0, `Expected >0 eligible events for ${s}`);
        }
        assert(artifacts.strategyEventRows.every(r => r.strategy_id !== 'DTFX_ZONES'), 'Zero DTFX_ZONES');
        for (const tf of ['1m', '3m', '5m'] as const) {
            assert(artifacts.strategyEventRows.some(r => r.strategy_id === 'PHL_BOS_MSS' && JSON.parse(r.structural_context_json).phlTimeframe === tf), `PHL ${tf}`);
            assert(artifacts.strategyEventRows.some(r => r.strategy_id === 'DTFX_STRICTCBC' && JSON.parse(r.structural_context_json).zoneTimeframe === tf), `DTFX ${tf}`);
        }

        const m = artifacts.manifest;
        validateV4DatasetManifest(m);
        assert(m.exportAccounting.tierBConfirmedTeacherEventCount === m.outcomeAccounting!.totalCandidateEvents &&
            m.exportAccounting.tierCOutcomeRowCount === m.outcomeAccounting!.eligibleEvents,
            'Manifest accounting contract');

        // Runtime manifest validation rejects tampered outcomeAccounting
        let badManifestThrew = false;
        try {
            validateV4DatasetManifest({
                ...m,
                outcomeAccounting: { ...m.outcomeAccounting!, totalCandidateEvents: m.outcomeAccounting!.totalCandidateEvents + 1 }
            });
        } catch { badManifestThrew = true; }
        assert(badManifestThrew, 'validateV4DatasetManifest must reject accounting sum mismatch');

        const repRows = parseCsvDocumentCRLF(artifacts.representationCsv);
        assertV4RepresentationZeroTierCLeakage(repRows[0]);
        for (const q of TIER_C_V4_QUARANTINE_LIST) assert(!repRows[0].includes(q), `Quarantined '${q}'`);

        const reqV4 = createML1ZipExportRequest(m);
        validateML1ExportRequestAgainstManifest(reqV4, m);

        const zipBytes = await createVerifiedV4DatasetArchive(artifacts, waveBuf);
        const reopened = await JSZip.loadAsync(zipBytes);
        assert((await reopened.file(artifacts.continuousFileName)!.async('string')) === artifacts.continuousCsv, 'ZIP Continuous');
        assert((await reopened.file(artifacts.representationFileName)!.async('string')) === artifacts.representationCsv, 'ZIP Rep');
        assert((await reopened.file(artifacts.strategyEventsFileName)!.async('string')) === artifacts.strategyEventsCsv, 'ZIP Ev');

        // Aligned t0 MTF gap counter check: missing bar 00:17 triggers INCOMPLETE_MISSING on 3m & 5m (gapCount=1, resetCount=1, incomplete=1)
        const gappedBuf = new Float64Array(30 * 6);
        let gt = t0;
        for (let i = 0; i < 30; i++) {
            if (i === 17) gt += dt;
            gappedBuf.set([gt, 100, 101, 99, 100.5, 100], i * 6);
            gt += dt;
        }
        const runnerGap = new V4PipelineRunner(createV4PipelineConfig({ symbol: 'SOLUSDT', interval: '1m', intervalMs: dt, requireContiguous: false }));
        for (let i = 0; i < 30; i++) {
            const o = i * 6;
            runnerGap.stepCandle({ time: gappedBuf[o], open: gappedBuf[o + 1], high: gappedBuf[o + 2], low: gappedBuf[o + 3], close: gappedBuf[o + 4], volume: gappedBuf[o + 5], isSynthetic: false });
        }
        const hs = runnerGap.getHtfStats();
        assert(hs.htf3mGapCount === 1 && hs.htf3mResetCount === 1 && hs.htf3mIncompleteWindowCount === 1 &&
            hs.htf5mGapCount === 1 && hs.htf5mResetCount === 1 && hs.htf5mIncompleteWindowCount === 1,
            'Aligned INCOMPLETE_MISSING increments gap, reset, and incomplete counts by exactly 1');

        // Verify INCOMPLETE_INVALID & INCOMPLETE_DUPLICATE at MTF layer do NOT classify as missing-source gaps
        let stInv = createInitialV4MTFState(MTF_V4_CONFIG_D);
        let invGap = 0, invReset = 0;
        for (let i = 0; i < 4; i++) {
            const c = { time: t0 + i * dt, open: 100, high: 101, low: 99, close: 100, volume: 100, isSynthetic: false };
            const r = stepV4MTFCombined(c, i !== 1, stInv, MTF_V4_CONFIG_D, i);
            stInv = r.nextState;
            if (r.diagnostic3m) {
                invReset++;
                if (r.diagnostic3m.completeness === 'INCOMPLETE_MISSING') invGap++;
                assert(r.diagnostic3m.completeness === 'INCOMPLETE_INVALID', 'Expected INCOMPLETE_INVALID');
            }
        }
        assert(invReset === 1 && invGap === 0, 'INCOMPLETE_INVALID increments resetCount without incrementing gapCount');

        let stDup = createInitialV4MTFState(MTF_V4_CONFIG_D);
        let dupGap = 0, dupReset = 0;
        for (const [idx, ts] of [[0, t0], [1, t0 + dt], [2, t0 + dt], [3, t0 + 2 * dt], [4, t0 + 3 * dt]] as const) {
            const r = stepV4MTFCombined({ time: ts, open: 100, high: 101, low: 99, close: 100, volume: 100, isSynthetic: false }, true, stDup, MTF_V4_CONFIG_D, idx);
            stDup = r.nextState;
            if (r.diagnostic3m) {
                dupReset++;
                if (r.diagnostic3m.completeness === 'INCOMPLETE_MISSING') dupGap++;
                assert(r.diagnostic3m.completeness === 'INCOMPLETE_DUPLICATE', 'Expected INCOMPLETE_DUPLICATE');
            }
        }
        assert(dupReset === 1 && dupGap === 0, 'INCOMPLETE_DUPLICATE increments resetCount without incrementing gapCount');
    });

    await runTest('4. Adversarial auditor tests (identity, 1m/HTF feature replay & tolerance, cloned real diagnostics)', async () => {
        // 4a. Export real aligned gapped stream so CSV has genuine non-null htf3mDiagnostic & passes baseline audit first
        const subLen = 900;
        const gappedRaw = makeWaveBuffer(subLen, t0, dt);
        for (let i = 10; i < subLen; i++) gappedRaw[i * 6] += dt; // Missing 00:10 -> genuine INCOMPLETE_MISSING on 3m [00:09, 00:12)

        const base = await buildV4ExportArtifacts({
            rawCandleBuffer: gappedRaw, symbol: 'SOLUSDT', interval: '1m', intervalMs: dt,
            requireContiguous: false, buildTimestamp: 1_700_000_000_000
        });
        assert(DatasetAuditor.runV4CausalityAudit({
            expectedSymbol: 'SOLUSDT', expectedTimeframe: '1m', rawCandleBuffer: gappedRaw, intervalMs: dt,
            expectedContinuousRows: subLen, expectedEventRows: base.strategyEventRows.length,
            continuousCsv: base.continuousCsv, representationCsv: base.representationCsv, strategyEventsCsv: base.strategyEventsCsv, include3m5mMtf: true
        }).passed, 'Gapped baseline CSV must pass auditor before tampering');

        const contRecs = parseCsvDocumentCRLF(base.continuousCsv);
        const evRecs = parseCsvDocumentCRLF(base.strategyEventsCsv);
        const toCsv = (recs: string[][]) => recs.map(serializeCsvRecord).join('\r\n');

        // 4b. Continuous symbol tampering & Event-row symbol/timeframe tampering
        const symCol = contRecs[0].indexOf('symbol');
        assert(symCol >= 0, 'symbol column must exist');
        const badSymCont = contRecs.map((r, i) => (i === 0 ? r : r.map((c, ci) => (ci === symCol ? 'BTCUSDT' : c))));
        assert(!DatasetAuditor.runV4CausalityAudit({
            expectedSymbol: 'SOLUSDT', expectedTimeframe: '1m', rawCandleBuffer: gappedRaw, intervalMs: dt,
            expectedContinuousRows: subLen, expectedEventRows: base.strategyEventRows.length,
            continuousCsv: toCsv(badSymCont), representationCsv: base.representationCsv, strategyEventsCsv: base.strategyEventsCsv, include3m5mMtf: true
        }).passed, 'Mislabelled continuous symbol rejected');

        const evSymCol = evRecs[0].indexOf('symbol'), evTfCol = evRecs[0].indexOf('timeframe');
        assert(evSymCol >= 0 && evTfCol >= 0, 'event symbol/timeframe columns must exist');
        for (const [col, badVal, label] of [[evSymCol, 'BTCUSDT', 'event symbol'], [evTfCol, '5m', 'event timeframe']] as const) {
            const badEv = evRecs.map((r, i) => (i === 1 ? r.map((c, ci) => (ci === col ? badVal : c)) : r));
            assert(!DatasetAuditor.runV4CausalityAudit({
                expectedSymbol: 'SOLUSDT', expectedTimeframe: '1m', rawCandleBuffer: gappedRaw, intervalMs: dt,
                expectedContinuousRows: subLen, expectedEventRows: base.strategyEventRows.length,
                continuousCsv: base.continuousCsv, representationCsv: base.representationCsv, strategyEventsCsv: toCsv(badEv), include3m5mMtf: true
            }).passed, `Tampered ${label} rejected`);
        }

        // 4c. 1m feature tampering (1e-9 drift > 1e-12 tolerance) & 3m HTF feature tampering
        const smaCol = contRecs[0].indexOf('SMA_20_Distance');
        assert(smaCol >= 0, 'SMA_20_Distance column must exist');
        const origSmaVal = Number(contRecs[251][smaCol]);
        const badFeatCont = contRecs.map((r, i) => (i === 251 ? r.map((c, ci) => (ci === smaCol ? String(origSmaVal + 1e-9) : c)) : r));
        assert(!DatasetAuditor.runV4CausalityAudit({
            expectedSymbol: 'SOLUSDT', expectedTimeframe: '1m', rawCandleBuffer: gappedRaw, intervalMs: dt,
            expectedContinuousRows: subLen, expectedEventRows: base.strategyEventRows.length,
            continuousCsv: toCsv(badFeatCont), representationCsv: base.representationCsv, strategyEventsCsv: base.strategyEventsCsv, include3m5mMtf: true
        }).passed, '1e-9 feature corruption rejected');

        const ctx3Col = contRecs[0].indexOf('context3m');
        assert(ctx3Col >= 0, 'context3m column must exist');
        const row120 = [...contRecs[121]];
        const parsedC3 = JSON.parse(row120[ctx3Col]);
        assert(parsedC3.isAvailable === true, 'Row 120 must have available context3m');
        parsedC3.features['ATR_14'] = Number(parsedC3.features['ATR_14']) + 1e-9;
        row120[ctx3Col] = JSON.stringify(parsedC3);
        const badHtfCont = contRecs.map((r, i) => (i === 121 ? row120 : r));
        assert(!DatasetAuditor.runV4CausalityAudit({
            expectedSymbol: 'SOLUSDT', expectedTimeframe: '1m', rawCandleBuffer: gappedRaw, intervalMs: dt,
            expectedContinuousRows: subLen, expectedEventRows: base.strategyEventRows.length,
            continuousCsv: toCsv(badHtfCont), representationCsv: base.representationCsv, strategyEventsCsv: base.strategyEventsCsv, include3m5mMtf: true
        }).passed, 'Tampered 3m HTF feature rejected');

        // 4d. Find genuine non-null htf3mDiagnostic row from verified CSV, clone it, and mutate 1 field per adversarial test
        const diag3Col = contRecs[0].indexOf('htf3mDiagnostic');
        assert(diag3Col >= 0, 'htf3mDiagnostic column must exist');
        const diagRowIdx = contRecs.findIndex((r, i) => i > 0 && r[diag3Col] !== 'null');
        assert(diagRowIdx > 0, 'Expected genuine non-null htf3mDiagnostic row in gapped baseline');
        const realDiag = JSON.parse(contRecs[diagRowIdx][diag3Col]);

        const mutCases = [
            { ...realDiag, duplicateCount: '0' },
            { ...realDiag, duplicateCount: -1 },
            { ...realDiag, invalidSourceCount: '0' },
            { ...realDiag, invalidSourceCount: -1 },
            { ...realDiag, actualSourceCount: 1.5 },
            { ...realDiag, missingTimestamps: [realDiag.openTimestamp - 60_000] },
            { ...realDiag, missingTimestamps: [realDiag.openTimestamp, realDiag.openTimestamp], actualSourceCount: 1 },
            { ...realDiag, completeness: 'INCOMPLETE_DUPLICATE' },
            { ...realDiag, completeness: 'INCOMPLETE_UNFINISHED' },
            { ...realDiag, duplicateCount: 1 }, // Wrong precedence vs INCOMPLETE_MISSING
            { ...realDiag, invalidSourceCount: 1, completeness: 'INCOMPLETE_INVALID' } // Replay mismatch against baseline
        ];
        for (const mutatedDiag of mutCases) {
            const modRow = [...contRecs[diagRowIdx]];
            modRow[diag3Col] = JSON.stringify(mutatedDiag);
            const modCont = contRecs.map((r, i) => (i === diagRowIdx ? modRow : r));
            assert(!DatasetAuditor.runV4CausalityAudit({
                expectedSymbol: 'SOLUSDT', expectedTimeframe: '1m', rawCandleBuffer: gappedRaw, intervalMs: dt,
                expectedContinuousRows: subLen, expectedEventRows: base.strategyEventRows.length,
                continuousCsv: toCsv(modCont), representationCsv: base.representationCsv, strategyEventsCsv: base.strategyEventsCsv, include3m5mMtf: true
            }).passed, `Mutated real diagnostic ${JSON.stringify(mutatedDiag)} must be rejected`);
        }

        // 4e. Replay precision test across small (0.0001x) and large (1000x) price scales
        for (const scale of [0.0001, 1000]) {
            const scaledBuf = makeWaveBuffer(420, t0, dt, scale);
            const scaledArt = await buildV4ExportArtifacts({
                rawCandleBuffer: scaledBuf, symbol: 'SOLUSDT', interval: '1m', intervalMs: dt, buildTimestamp: 1_700_000_000_000
            });
            assert(scaledArt.auditResult.passed, `Scale=${scale} export must pass 1e-12 replay tolerance`);
        }
    });

    await runTest('5. Streaming vs Batch V4 byte-for-byte CSV, SHA-256 & Manifest parity (900 candles, all 4 teachers)', async () => {
        const parityOk = await runV4StreamingExportParityTest(900);
        assert(parityOk, 'runV4StreamingExportParityTest failed');
    });

    console.log(`\nPhase 4 (V4 Pipeline & Export) Acceptance: ${passed} passed, ${failed} failed.\n`);
    return failed === 0;
}
