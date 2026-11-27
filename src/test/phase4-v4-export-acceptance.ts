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

        if (typeof document !== 'undefined') {
            assert(
                document.querySelector('#ai-export-schema-version') === null &&
                document.querySelector('#check-ai-v3-15m-mtf') === null &&
                document.querySelector('#check-ai-v4-3m5m-mtf') !== null &&
                document.querySelectorAll('.ai-v4-teacher-tf').length === 3 &&
                document.querySelectorAll('.ai-v4-teacher-tf[value="15m"]').length === 0 &&
                document.querySelectorAll('.ai-pack-card[data-pack="stream_folder"]').length === 1,
                'Live V4 export modal must expose 3m/5m MTF and 1m/3m/5m teacher TFs without 15m or V2/V3 selectors'
            );
            const infoBody = document.querySelector('#ai-export-info-body')?.textContent || '';
            assert(infoBody.includes('ML1_CONFIG_D_v1') && !infoBody.includes('ML1_CONFIG_C_v1'),
                'Live V4 export modal info body must reflect ML1_CONFIG_D_v1');
        }
    });

    await runTest('2. Outcome tracker atomic validation, cross-bar duplicate IDs, immutable copies, H60/120/180 boundaries & stop-first', () => {
        const tracker = new V4MultiHorizonOutcomeTracker();
        const tierA = makeDummyTierA('OBS_0', 2.0);
        const ev0 = makeDummyEvent(0, t0, dt, 'OK');

        // Calling enqueueEvents before stepBar(0) must be rejected cleanly
        let preStepThrew = false;
        try { tracker.enqueueEvents([ev0], 'SOLUSDT', '1m', tierA, true); } catch { preStepThrew = true; }
        assert(preStepThrew && tracker.getPendingCount() === 0 && tracker.getAccountingSnapshot().totalCandidateEvents === 0,
            'enqueueEvents before stepBar(0) must throw without mutating state');

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

        // Directional contradiction checks across all 4 V4 teachers
        expectEnqueueReject([{ ...ev0, eventType: 'VAM_BUY', eventDirection: 'bear' }], 'VAM_BUY bear contradiction');
        expectEnqueueReject([{ ...ev0, eventType: 'VAM_SELL', eventDirection: 'bull' }], 'VAM_SELL bull contradiction');
        expectEnqueueReject([{ ...ev0, strategyId: 'PHL_BOS_MSS', eventType: 'PHL_BOS_BULL', eventDirection: 'bear', structuralContext: { phlTimeframe: '1m', breakType: 'BOS', brokenLevelPrice: 105, hasProtectedLevel: false, protectedLevelPrice: null, protectedLevelBarIndex: null, protectedLevelTimestamp: null, atr14Valid: true, distToProtectedAtr: null, pbFromLowValid: true, pbFromHighValid: false } }], 'PHL_BOS_BULL bear contradiction');
        expectEnqueueReject([{ ...ev0, strategyId: 'DTFX_STRICTCBC', eventType: 'DTFX_CBC_SUPPLY_CREATED', eventDirection: 'bull', structuralContext: { zoneTimeframe: '1m', zoneId: 1, zoneStatus: 'CREATED', isChoch: false, retestCount: 0, zoneCreatedSourceBarIndex: 0, zoneCreatedConfirmationBarIndex: 0, zoneTop: 105, zoneBot: 100, fib03: 103.5, fib05: 102.5, fib07: 101.5, atr14Valid: true, zoneWidthAtr: 2.5, fib05DistAtr: 1.0 } }], 'DTFX_CBC_SUPPLY_CREATED bull contradiction');
        expectEnqueueReject([{ ...ev0, strategyId: 'STRICT_CBC', eventType: 'CBC_HIGH_HH', eventDirection: 'bull', structuralContext: { pivotId: 1, pivotType: 'high', pivotLabel: 'HH', pivotPrice: 105, hasPrevPivot: false, prevPivotPrice: 0, barsSinceLastPivot: 0, legDistanceAtr: 0 } }], 'CBC_HIGH_HH bull contradiction');

        expectEnqueueReject([{ ...ev0, sourceBarIndex: 5, confirmationBarIndex: 4 }], 'source > confirmation');
        expectEnqueueReject([{ ...ev0, confirmationLagBars: 99 }], 'bad lag');
        expectEnqueueReject([{ ...ev0, entryBarIndex: 99 }], 'bad entryBarIndex');
        expectEnqueueReject([{ ...ev0, observationTimestamp: t0 }], 'bad observationTimestamp');
        expectEnqueueReject([{ ...makeDummyEvent(5, t0, dt, 'FUT') }], 'future confirmationBarIndex > lastStepBarIndex(0)');
        expectEnqueueReject([{ ...ev0, eventId: 'BAD_ENT1', entryTimestamp: t0 + 30_000 }], 'non-aligned entryTimestamp (t0 + 30s)');
        expectEnqueueReject([{ ...ev0, eventId: 'BAD_ENT2', entryTimestamp: t0 + 2 * dt }], 'skipped entryTimestamp on contiguous tracker');
        expectEnqueueReject([{ ...ev0, confirmationTimestamp: t0 + dt }], 'confirmationTimestamp disagrees with stepBar(0) clock');
        expectEnqueueReject([{ ...ev0, structuralContext: { badKey: 1 } }], 'malformed structuralContext');
        expectEnqueueReject([{ ...makeDummyEvent(5, t0, dt, 'DUP'), eventId: ev0.eventId }], 'duplicate eventId at different bar/tuple');
        expectEnqueueReject([makeDummyEvent(0, t0, dt, 'B1'), makeDummyEvent(0, t0, dt, 'B1')], 'duplicate eventId within batch');

        // Exact 35-key Tier A object boundary checks (non-finite, extra enumerable, non-enumerable, symbol key, custom prototype)
        expectEnqueueReject([makeDummyEvent(0, t0, dt, 'T1')], 'non-finite tierA', { ...tierA, atr14: Number.NaN });
        expectEnqueueReject([makeDummyEvent(0, t0, dt, 'T2')], 'extra enumerable key in tierA', { ...tierA, extraField: 1 });
        const nonEnumTierA = { ...tierA };
        Object.defineProperty(nonEnumTierA, 'hiddenKey', { value: 1, enumerable: false });
        expectEnqueueReject([makeDummyEvent(0, t0, dt, 'T3')], 'non-enumerable extra key in tierA', nonEnumTierA);
        const symTierA = { ...tierA, [Symbol('leak')]: 1 };
        expectEnqueueReject([makeDummyEvent(0, t0, dt, 'T4')], 'symbol key in tierA', symTierA);
        class CustomTierA {}
        const protoTierA = Object.assign(new CustomTierA(), tierA);
        expectEnqueueReject([makeDummyEvent(0, t0, dt, 'T5')], 'unexpected prototype on tierA', protoTierA);
        expectEnqueueReject([makeDummyEvent(0, t0, dt, 'T6')], 'inconsistent tierA context3mAvailable vs status', { ...tierA, context3mAvailable: false, context3mStatus: 'AVAILABLE_VALID' });

        // Positive non-null entryTimestamp accepted on contiguous (exact observationTimestamp) & gapped (aligned >= observationTimestamp)
        const tPosEnt = new V4MultiHorizonOutcomeTracker(true);
        tPosEnt.stepBar(0, { time: t0, open: 100, high: 101, low: 99, close: 100 });
        tPosEnt.enqueueEvents([{ ...makeDummyEvent(0, t0, dt, 'POS_ENT'), entryTimestamp: t0 + dt }], 'SOLUSDT', '1m', tierA, true);
        assert(tPosEnt.getPendingCount() === 1, 'Valid non-null entryTimestamp accepted on contiguous tracker');
        const tGapEnt = new V4MultiHorizonOutcomeTracker(false);
        tGapEnt.stepBar(0, { time: t0, open: 100, high: 101, low: 99, close: 100 });
        tGapEnt.enqueueEvents([{ ...makeDummyEvent(0, t0, dt, 'GAP_ENT'), entryTimestamp: t0 + 2 * dt }], 'SOLUSDT', '1m', tierA, true);
        assert(tGapEnt.getPendingCount() === 1, 'Valid gapped entryTimestamp accepted on non-contiguous tracker');

        // Post-enqueue mutation of caller objects must NOT affect queued ev0
        const evMutable = makeDummyEvent(1, t0, dt, 'MUT');
        const tierAMutable = makeDummyTierA('OBS_1', 2.0);
        tracker.stepBar(1, { time: t0 + dt, open: 100, high: 100.5, low: 99.5, close: 100 });
        tracker.enqueueEvents([evMutable], 'SOLUSDT', '1m', tierAMutable, true);
        (evMutable as any).eventDirection = 'bear';
        (evMutable.structuralContext as any).rsi14 = -999;
        (tierAMutable as any).atr14 = 9999;

        // No-barrier test: stepBar(0) then enqueue at bar 0; distinct closes at bars 60/120/180 and spikes at 61/121/181
        const tNoBarrier = new V4MultiHorizonOutcomeTracker();
        tNoBarrier.stepBar(0, { time: t0, open: 100, high: 100.5, low: 99.5, close: 100 });
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

        // Also test 3-class end-of-stream exclusions following exact stepBar(b) -> enqueueEvents(b) order
        const t2 = new V4MultiHorizonOutcomeTracker();
        for (let b = 0; b <= 50; b++) {
            t2.stepBar(b, { time: t0 + b * dt, open: 100, high: 101, low: 99, close: 100 });
            if (b === 2) t2.enqueueEvents([makeDummyEvent(2, t0, dt, 'UNW')], 'SOLUSDT', '1m', makeDummyTierA('OBS_2', 0), false);
            if (b === 10) t2.enqueueEvents([makeDummyEvent(10, t0, dt, 'INC')], 'SOLUSDT', '1m', makeDummyTierA('OBS_10', 2), true);
            if (b === 50) t2.enqueueEvents([makeDummyEvent(50, t0, dt, 'MIS')], 'SOLUSDT', '1m', makeDummyTierA('OBS_50', 2), true);
        }
        const t2Acc = t2.finalizeEndOfStream(51);
        assert(
            t2Acc.totalCandidateEvents === 3 &&
            t2Acc.eligibleEvents === 0 &&
            t2Acc.excludedUnwarmedAtr === 1 &&
            t2Acc.excludedIncompleteHorizon === 1 &&
            t2Acc.excludedMissingNextOpen === 1,
            '3-class end-of-stream exclusions must partition cleanly'
        );
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

        // Verify live teacher-to-direction parity across emitted events (including DTFX DEMAND/SUPPLY CREATED & RETEST)
        const expectedDirMap: Record<string, 'bull' | 'bear'> = {
            CBC_HIGH_HH: 'bear', CBC_HIGH_LH: 'bear', CBC_LOW_HL: 'bull', CBC_LOW_LL: 'bull',
            PHL_BOS_BULL: 'bull', PHL_MSS_BULL: 'bull', PHL_BOS_BEAR: 'bear', PHL_MSS_BEAR: 'bear',
            DTFX_CBC_DEMAND_CREATED: 'bull', DTFX_CBC_DEMAND_RETEST: 'bull',
            DTFX_CBC_SUPPLY_CREATED: 'bear', DTFX_CBC_SUPPLY_RETEST: 'bear',
            VAM_BUY: 'bull', VAM_SELL: 'bear'
        };
        for (const row of artifacts.strategyEventRows) {
            assert(expectedDirMap[row.event_type] === row.event_direction,
                `Live teacher direction parity mismatch: ${row.event_type} emitted ${row.event_direction}`);
        }
        assert(
            artifacts.strategyEventRows.some(r => r.event_type === 'DTFX_CBC_DEMAND_RETEST' && r.event_direction === 'bull') &&
            artifacts.strategyEventRows.some(r => r.event_type === 'DTFX_CBC_SUPPLY_RETEST' && r.event_direction === 'bear'),
            'Expected both DTFX_CBC_DEMAND_RETEST (bull) and DTFX_CBC_SUPPLY_RETEST (bear) in live 1400-bar export'
        );

        const m = artifacts.manifest;
        validateV4DatasetManifest(m);
        assert(m.exportAccounting.tierBConfirmedTeacherEventCount === m.outcomeAccounting!.totalCandidateEvents &&
            m.exportAccounting.tierCOutcomeRowCount === m.outcomeAccounting!.eligibleEvents,
            'Manifest accounting contract');

        // Runtime manifest validation rejects tampering on every outcomeAccounting field & actualFileRowCounts
        const expectManifestReject = (badManifest: any, label: string) => {
            let threw = false;
            try { validateV4DatasetManifest(badManifest); } catch { threw = true; }
            assert(threw, `${label}: validateV4DatasetManifest must reject`);
        };
        expectManifestReject({ ...m, outcomeAccounting: { ...m.outcomeAccounting!, totalCandidateEvents: m.outcomeAccounting!.totalCandidateEvents + 1 } }, 'tampered totalCandidateEvents');
        expectManifestReject({ ...m, outcomeAccounting: { ...m.outcomeAccounting!, eligibleEvents: m.outcomeAccounting!.eligibleEvents + 1 } }, 'tampered eligibleEvents');
        expectManifestReject({ ...m, outcomeAccounting: { ...m.outcomeAccounting!, excludedMissingNextOpen: -1 } }, 'negative excludedMissingNextOpen');
        expectManifestReject({ ...m, outcomeAccounting: { ...m.outcomeAccounting!, excludedUnwarmedAtr: m.outcomeAccounting!.excludedUnwarmedAtr + 1 } }, 'tampered excludedUnwarmedAtr');
        expectManifestReject({ ...m, outcomeAccounting: { ...m.outcomeAccounting!, excludedIncompleteHorizon: m.outcomeAccounting!.excludedIncompleteHorizon + 1 } }, 'tampered excludedIncompleteHorizon');
        expectManifestReject({
            ...m,
            exportAccounting: {
                ...m.exportAccounting,
                actualFileRowCounts: { ...m.exportAccounting.actualFileRowCounts, [artifacts.continuousFileName]: 1 }
            }
        }, 'tampered continuous actualFileRowCounts');
        expectManifestReject({
            ...m,
            exportAccounting: {
                ...m.exportAccounting,
                actualFileRowCounts: { ...m.exportAccounting.actualFileRowCounts, [artifacts.strategyEventsFileName]: m.outcomeAccounting!.eligibleEvents + 1 }
            }
        }, 'tampered strategyEvents actualFileRowCounts');
        expectManifestReject({
            ...m,
            exportAccounting: {
                ...m.exportAccounting,
                actualFileRowCounts: { ...m.exportAccounting.actualFileRowCounts, extra_file: 0 }
            }
        }, 'unexpected key in actualFileRowCounts');
        // Positive excludedMissingNextOpen tampering + unsafe-integer sum + acceptedSourceObservationCount mismatch
        expectManifestReject({ ...m, outcomeAccounting: { ...m.outcomeAccounting!, excludedMissingNextOpen: m.outcomeAccounting!.excludedMissingNextOpen + 1 } }, 'tampered +1 excludedMissingNextOpen');
        expectManifestReject({
            ...m,
            outcomeAccounting: {
                totalCandidateEvents: Number.MAX_SAFE_INTEGER,
                eligibleEvents: Number.MAX_SAFE_INTEGER,
                excludedMissingNextOpen: 1,
                excludedUnwarmedAtr: 0,
                excludedIncompleteHorizon: 0
            }
        }, 'unsafe-integer outcomeAccounting sum');
        expectManifestReject({
            ...m,
            exportAccounting: {
                ...m.exportAccounting,
                acceptedSourceObservationCount: m.exportAccounting.acceptedSourceObservationCount - 1,
                rejectedSourceObservationCount: m.exportAccounting.rejectedSourceObservationCount + 1
            }
        }, 'acceptedSourceObservationCount disagrees with manifest.acceptedObservationCount');

        // Extra, missing, symbol, custom-prototype, getter, non-enumerable keys on exportAccounting & actualFileRowCounts
        expectManifestReject({ ...m, exportAccounting: { ...m.exportAccounting, extraKey: 1 } }, 'extra key in exportAccounting');
        const eaMissing = { ...m.exportAccounting } as any;
        delete eaMissing.tierCOutcomeRowCount;
        expectManifestReject({ ...m, exportAccounting: eaMissing }, 'missing key in exportAccounting');

        const eaSym = { ...m.exportAccounting, [Symbol('sym')]: 1 };
        expectManifestReject({ ...m, exportAccounting: eaSym }, 'symbol key in exportAccounting');

        class CustomAcc {}
        const eaProto = Object.assign(new CustomAcc(), m.exportAccounting);
        expectManifestReject({ ...m, exportAccounting: eaProto }, 'custom prototype on exportAccounting');

        const eaGetter = { ...m.exportAccounting } as any;
        Object.defineProperty(eaGetter, 'tierCOutcomeRowCount', { get: () => m.outcomeAccounting!.eligibleEvents, enumerable: true });
        expectManifestReject({ ...m, exportAccounting: eaGetter }, 'getter accessor on exportAccounting');

        const eaNonEnum = { ...m.exportAccounting } as any;
        Object.defineProperty(eaNonEnum, 'tierCOutcomeRowCount', { value: m.outcomeAccounting!.eligibleEvents, enumerable: false });
        expectManifestReject({ ...m, exportAccounting: eaNonEnum }, 'non-enumerable property on exportAccounting');

        const countsMissing = { ...m.exportAccounting.actualFileRowCounts } as any;
        delete countsMissing[artifacts.continuousFileName];
        expectManifestReject({ ...m, exportAccounting: { ...m.exportAccounting, actualFileRowCounts: countsMissing } }, 'missing canonical filename in actualFileRowCounts');
        expectManifestReject({
            ...m,
            exportAccounting: {
                ...m.exportAccounting,
                actualFileRowCounts: { ...m.exportAccounting.actualFileRowCounts, [artifacts.continuousFileName]: -1 }
            }
        }, 'negative row count in actualFileRowCounts');
        expectManifestReject({
            ...m,
            exportAccounting: {
                ...m.exportAccounting,
                actualFileRowCounts: { ...m.exportAccounting.actualFileRowCounts, [artifacts.continuousFileName]: Number.MAX_SAFE_INTEGER + 1 }
            }
        }, 'unsafe-integer row count in actualFileRowCounts');

        const countsSym = { ...m.exportAccounting.actualFileRowCounts, [Symbol('sym')]: 1 };
        expectManifestReject({ ...m, exportAccounting: { ...m.exportAccounting, actualFileRowCounts: countsSym } }, 'symbol key in actualFileRowCounts');
        const countsProto = Object.assign(new CustomAcc(), m.exportAccounting.actualFileRowCounts);
        expectManifestReject({ ...m, exportAccounting: { ...m.exportAccounting, actualFileRowCounts: countsProto } }, 'custom prototype on actualFileRowCounts');
        const countsGetter = { ...m.exportAccounting.actualFileRowCounts } as any;
        Object.defineProperty(countsGetter, artifacts.continuousFileName, { get: () => m.acceptedObservationCount, enumerable: true });
        expectManifestReject({ ...m, exportAccounting: { ...m.exportAccounting, actualFileRowCounts: countsGetter } }, 'getter accessor on actualFileRowCounts');

        const countsNonEnum = { ...m.exportAccounting.actualFileRowCounts } as any;
        Object.defineProperty(countsNonEnum, artifacts.continuousFileName, { value: m.acceptedObservationCount, enumerable: false });
        expectManifestReject({ ...m, exportAccounting: { ...m.exportAccounting, actualFileRowCounts: countsNonEnum } }, 'non-enumerable property on actualFileRowCounts');

        // Isolate unsafe accepted+rejected sum check (order-independent: all accepted/continuous fields agree with MAX_SAFE_INTEGER)
        expectManifestReject({
            ...m,
            acceptedObservationCount: Number.MAX_SAFE_INTEGER,
            exportAccounting: {
                ...m.exportAccounting,
                rawSourceCandleCount: Number.MAX_SAFE_INTEGER,
                acceptedSourceObservationCount: Number.MAX_SAFE_INTEGER,
                rejectedSourceObservationCount: 1,
                tierAContinuousObservationCount: Number.MAX_SAFE_INTEGER,
                actualFileRowCounts: {
                    ...m.exportAccounting.actualFileRowCounts,
                    [artifacts.continuousFileName]: Number.MAX_SAFE_INTEGER
                }
            }
        }, 'unsafe-integer rawSourceCandleCount sum');

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

        // Verify non-contiguous baseline gapped export also produced eligible events and passed validateV4DatasetManifest
        validateV4DatasetManifest(base.manifest);
        assert(base.strategyEventRows.length > 0 && base.manifest.missingDataStats.htf3mGapCount! >= 1,
            'Non-contiguous gapped export must produce eligible events and pass manifest validation');

        // 4e. Replay precision test across extreme small (1e-5x) and large (1e3x) price scales (valid passes <= 1e-12; 1e-9 corruption rejected)
        for (const scale of [1e-5, 0.0001, 1000]) {
            const scaledBuf = makeWaveBuffer(420, t0, dt, scale);
            const scaledArt = await buildV4ExportArtifacts({
                rawCandleBuffer: scaledBuf, symbol: 'SOLUSDT', interval: '1m', intervalMs: dt, buildTimestamp: 1_700_000_000_000
            });
            assert(scaledArt.auditResult.passed, `Scale=${scale} export must pass 1e-12 replay tolerance`);

            const sRecs = parseCsvDocumentCRLF(scaledArt.continuousCsv);
            const sSmaCol = sRecs[0].indexOf('SMA_20_Distance');
            const sSmaValidCol = sRecs[0].indexOf('valid_SMA_20_Distance');
            assert(sSmaCol >= 0 && sSmaValidCol >= 0 && sRecs[100][sSmaValidCol] === 'true',
                `Scale=${scale} row 100 must have valid SMA_20_Distance`);
            const origVal = Number(sRecs[100][sSmaCol]);
            assert(Number.isFinite(origVal), `Scale=${scale} SMA_20_Distance must be finite`);
            const badSRecs = sRecs.map((r, i) => (i === 100 ? r.map((c, ci) => (ci === sSmaCol ? String(origVal + 1e-9) : c)) : r));
            assert(!DatasetAuditor.runV4CausalityAudit({
                expectedSymbol: 'SOLUSDT', expectedTimeframe: '1m', rawCandleBuffer: scaledBuf, intervalMs: dt,
                expectedContinuousRows: 420, expectedEventRows: scaledArt.strategyEventRows.length,
                continuousCsv: toCsv(badSRecs), representationCsv: scaledArt.representationCsv, strategyEventsCsv: scaledArt.strategyEventsCsv, include3m5mMtf: true
            }).passed, `Scale=${scale} must reject 1e-9 feature corruption`);
        }
    });

    await runTest('5. Streaming vs Batch V4 byte-for-byte CSV, SHA-256 & Manifest parity (900 candles, all 4 teachers)', async () => {
        const parityOk = await runV4StreamingExportParityTest(900);
        assert(parityOk, 'runV4StreamingExportParityTest failed');
    });

    console.log(`\nPhase 4 (V4 Pipeline & Export) Acceptance: ${passed} passed, ${failed} failed.\n`);
    return failed === 0;
}
