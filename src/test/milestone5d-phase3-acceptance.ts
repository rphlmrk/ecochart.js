import {
    assertV3RepresentationRowZeroLeakage,
    assertV3RepresentationZeroTierCLeakage,
    buildV3RepresentationRow,
    MultiHorizonOutcomeTracker,
    serializeAndValidateStructuralContext,
    V3_DATASET_VERSION,
    V3_REPRESENTATION_COLUMNS,
    type V3TierAAtConfirmation
} from '../indicators/mlr1/pipeline/MultiHorizonOutcomeEngine';
import {
    createV3PipelineConfig,
    getV3FeatureConfigVersion,
    V3PipelineRunner
} from '../indicators/mlr1/pipeline/V3PipelineEngine';
import {
    adaptStrictCBCtoStrategyEvent,
    adaptVAMtoStrategyEvent,
    createStrategyEvent,
    stepStrictCBCWithReset,
    type StrategyEvent
} from '../indicators/mlr1/teachers/StrategyEventTypes';
import { createDefaultPHLConfig, createInitialPHLState, stepPHL } from '../indicators/mlr1/teachers/ProtectedHighsLowsTeacher';
import { createDefaultDTFXConfig, createInitialDTFXState, stepDTFX } from '../indicators/mlr1/teachers/DTFXAlgoZonesTeacher';
import { createInitialVAMState, stepVolatilityAdjustedMean } from '../indicators/mlr1/trend/VolatilityAdjustedMean';
import type { StrictCBCState, StrictZigZagPivot } from '../indicators/plugins/StrictCBCZigZagIndicator';
import { MLR1_DATASET_VERSION, MLR1_REPRESENTATION_COLUMNS } from '../data/AIExporter';
import type { ML1Candle } from '../indicators/mlr1/ML1FeatureTypes';

function assert(condition: boolean, msg: string): asserts condition {
    if (!condition) throw new Error(`[Phase5DPhase3Failed] ${msg}`);
}

function makeCandle(time: number, open: number, high: number, low: number, close: number, volume = 100): ML1Candle {
    return { time, open, high, low, close, volume, isSynthetic: false };
}

function makeSyntheticStream(count: number, startTime: number, intervalMs: number, gapAtIndex?: number): ML1Candle[] {
    const out: ML1Candle[] = [];
    let ts = startTime;
    let p = 100;
    for (let i = 0; i < count; i++) {
        if (gapAtIndex !== undefined && i === gapAtIndex) ts += 10 * intervalMs;
        const mod = i % 100;
        const delta = mod < 45
            ? (i % 7 === 0 || i % 7 === 1) ? -0.4 : 1.6
            : (i % 7 === 0 || i % 7 === 1) ? 0.4 : -1.7;
        const o = p;
        const c = Math.max(10, p + delta);
        out.push(makeCandle(ts, o, Math.max(o, c) + 0.6, Math.min(o, c) - 0.6, c, 100 + (i % 5) * 20));
        p = c;
        ts += intervalMs;
    }
    return out;
}

function makeDummyEventAndTierA(confBar: number, t0: number, interval: number, direction: 'bull' | 'bear' = 'bull') {
    const ev = createStrategyEvent({
        strategyId: 'PHL_BOS_MSS',
        strategyVersion: 'PHL_BOS_MSS_v1',
        symbol: 'SOLUSDT',
        timeframe: '1m',
        intervalMs: interval,
        eventType: direction === 'bull' ? 'PHL_MSS_BULL' : 'PHL_MSS_BEAR',
        eventDirection: direction,
        eventDiscriminator: direction === 'bull' ? 'PH' : 'PL',
        sourceBarIndex: Math.max(0, confBar - 3),
        sourceTimestamp: t0 + Math.max(0, confBar - 3) * interval,
        confirmationBarIndex: confBar,
        confirmationTimestamp: t0 + confBar * interval,
        entryTimestamp: null,
        structuralContext: {
            breakType: 'MSS',
            brokenLevelPrice: 105,
            hasProtectedLevel: true,
            protectedLevelPrice: 95,
            distToProtectedAtr: 1.2,
            pbFromLowValid: true,
            pbFromHighValid: true
        }
    });
    const tierA: V3TierAAtConfirmation = {
        tierAObservationId: `OBS_SOLUSDT_1m_V3_${t0 + confBar * interval}`,
        atr14: 2.0, // SL = 1.5*2 = 3.0; TP = 3.0*2 = 6.0
        exhaustion20: 10,
        exhaustion20Valid: true,
        vcsRatio360: 1.2,
        vcsZScore360: 0.5,
        vcsRegime360: 1,
        vcsValid: true,
        vamCenterDistAtr: 0.4,
        vamSlope3Atr: 0.2,
        vamEfficiency: 0.7,
        vamAdx14: 25,
        vamDiSpread14: 10,
        vamRsi14: 58,
        vamTrend: 1,
        vamValid: true,
        context15mAvailable: true,
        context15mStatus: 'AVAILABLE_VALID'
    };
    return { ev, tierA };
}

export function runPhase5DPhase3Tests(): boolean {
    console.log('\n======================================================');
    console.log('🧪 Starting Phase 5D Phase 3 Acceptance Suite (Shared v3 Engine)');
    console.log('======================================================\n');
    let passed = 0;
    let failed = 0;

    const runTest = (name: string, fn: () => void) => {
        try {
            fn();
            passed++;
            console.log(`  ✅ Passed: ${name}`);
        } catch (e: any) {
            failed++;
            console.error(`  ❌ Failed: ${name} - ${e?.message || String(e)}`);
        }
    };

    const t0 = Date.UTC(2026, 9, 15, 0, 0, 0);
    const interval = 60_000;

    // 1. Gap Execution (Normal Target, Gap Through Target, Gap Through Stop, Same-Bar Precedence, Long/Short Symmetry)
    runTest('1. Gap Execution & Same-Bar Precedence (Long & Short Symmetry, No 2R Cap on Gap Target)', () => {
        const runScenario = (
            buildBar1: (entry: number) => { o: number; h: number; l: number; c: number }
        ) => {
            const tracker = new MultiHorizonOutcomeTracker();
            const { ev, tierA } = makeDummyEventAndTierA(0, t0, interval);
            tracker.enqueueEvents([ev], 'SOLUSDT', '1m', tierA, true);

            // Bar 1 = entry bar (open = 100 -> lStop=97, lTarget=106, sStop=103, sTarget=94, risk=3)
            tracker.stepBar(1, { time: t0 + interval, open: 100, high: 100.5, low: 99.5, close: 100 });

            // Bar 2 = execution event bar
            const b2 = buildBar1(100);
            tracker.stepBar(2, { time: t0 + 2 * interval, open: b2.o, high: b2.h, low: b2.l, close: b2.c });

            for (let f = 3; f <= 180; f++) {
                const rows = tracker.stepBar(f, { time: t0 + f * interval, open: 100, high: 100.5, low: 99.5, close: 100 });
                if (f === 180) {
                    assert(rows.length === 1, 'Expected 1 resolved row at bar 180');
                    return rows[0];
                }
            }
            throw new Error('Did not resolve');
        };

        // 1a. Normal target fill (Long TP @106 -> +2.0R - 0.05R = +1.95R) and Short SL @103 (-1.0R - 0.05R = -1.05R)
        const normalLongTp = runScenario(() => ({ o: 101, h: 106.5, l: 101, c: 106 }));
        assert(normalLongTp.long_outcome_60 === 'full_target' && normalLongTp.long_exit_price_60 === 106 &&
            Math.abs(normalLongTp.long_net_r_60 - 1.95) < 1e-9, 'Normal Long TP failed');
        assert(normalLongTp.short_outcome_60 === 'hard_stop' && normalLongTp.short_exit_price_60 === 103 &&
            Math.abs(normalLongTp.short_net_r_60 - (-1.05)) < 1e-9, 'Normal Short SL failed');

        // 1b. Gap through Long Target (open=109.6 -> +3.2R, NOT capped at 2.0R! netR = 3.2 - 0.05 = +3.15R)
        //     and simultaneous Gap through Short Stop (open=109.6 -> -(109.6-100)/3 = -3.2R - 0.05 = -3.25R)
        const gapUp = runScenario(() => ({ o: 109.6, h: 110, l: 109, c: 109.5 }));
        assert(gapUp.long_outcome_60 === 'full_target' && gapUp.long_exit_price_60 === 109.6 &&
            Math.abs(gapUp.long_net_r_60 - 3.15) < 1e-9, `Gap through Long TP must not cap at 2R (got ${gapUp.long_net_r_60})`);
        assert(gapUp.short_outcome_60 === 'hard_stop' && gapUp.short_exit_price_60 === 109.6 &&
            Math.abs(gapUp.short_net_r_60 - (-3.25)) < 1e-9, 'Gap through Short SL failed');

        // 1c. Gap through Short Target & Long Stop symmetrically (open=90.4 -> Short +3.15R, Long -3.25R)
        const gapDown = runScenario(() => ({ o: 90.4, h: 91, l: 90, c: 90.5 }));
        assert(gapDown.short_outcome_60 === 'full_target' && gapDown.short_exit_price_60 === 90.4 &&
            Math.abs(gapDown.short_net_r_60 - 3.15) < 1e-9, `Gap through Short TP must not cap at 2R (got ${gapDown.short_net_r_60})`);
        assert(gapDown.long_outcome_60 === 'hard_stop' && gapDown.long_exit_price_60 === 90.4 &&
            Math.abs(gapDown.long_net_r_60 - (-3.25)) < 1e-9, 'Gap through Long SL failed');

        // 1d. Same-bar SL & TP touched intrabar (open=100, low=96, high=108): SL MUST win for both Long and Short
        const sameBar = runScenario(() => ({ o: 100, h: 108, l: 96, c: 100 }));
        assert(sameBar.long_outcome_60 === 'hard_stop' && sameBar.long_exit_price_60 === 97 &&
            Math.abs(sameBar.long_net_r_60 - (-1.05)) < 1e-9, 'Same-bar Long SL precedence failed');
        assert(sameBar.short_outcome_60 === 'hard_stop' && sameBar.short_exit_price_60 === 103 &&
            Math.abs(sameBar.short_net_r_60 - (-1.05)) < 1e-9, 'Same-bar Short SL precedence failed');
    });

    // 2. Independent Horizon Verification (60 / 120 / 180) & Single Cost Deduction
    runTest('2. Independent Horizon Replay (60 / 120 / 180) & Single Cost Deduction', () => {
        const evalOffset = (hitOffset: number | null, hitType: 'stop' | 'target' | null, closes: Record<number, number>) => {
            const tracker = new MultiHorizonOutcomeTracker();
            const { ev, tierA } = makeDummyEventAndTierA(0, t0, interval);
            tracker.enqueueEvents([ev], 'SOLUSDT', '1m', tierA, true);

            for (let f = 1; f <= 180; f++) {
                // entryBar = 1 -> offset 1..180 corresponds to f = 1..180
                let o = 100, h = 100.5, l = 99.5, c = closes[f] ?? 100;
                if (hitOffset === f && hitType === 'stop') l = 96.5;
                if (hitOffset === f && hitType === 'target') h = 106.5;
                const rows = tracker.stepBar(f, { time: t0 + f * interval, open: o, high: h, low: l, close: c });
                if (f === 180) return rows[0];
            }
            throw new Error('Did not resolve');
        };

        // Case A: Stop hit at bar 20 -> all 3 horizons = hard_stop (-1.05R)
        const rA = evalOffset(20, 'stop', {});
        assert(rA.long_outcome_60 === 'hard_stop' && rA.long_outcome_120 === 'hard_stop' && rA.long_outcome_180 === 'hard_stop', 'Bar 20 stop across all horizons');
        assert(Math.abs(rA.long_net_r_60 - (-1.05)) < 1e-9 && Math.abs(rA.long_net_r_180 - (-1.05)) < 1e-9, 'Single 0.05R deduction');

        // Case B: Target hit at bar 80 (with close@60 = 101.5 -> +0.5R - 0.05R = +0.45R) -> 60=timeout_net_gain, 120=full_target, 180=full_target
        const rB = evalOffset(80, 'target', { 60: 101.5 });
        assert(rB.long_outcome_60 === 'timeout_net_gain' && rB.long_exit_price_60 === 101.5 && Math.abs(rB.long_net_r_60 - 0.45) < 1e-9, 'H60 timeout before bar 80 target');
        assert(rB.long_outcome_120 === 'full_target' && Math.abs(rB.long_net_r_120 - 1.95) < 1e-9, 'H120 full_target');
        assert(rB.long_outcome_180 === 'full_target' && Math.abs(rB.long_net_r_180 - 1.95) < 1e-9, 'H180 full_target');

        // Case C: No barrier hit -> independent closes at 60, 120, 180
        const rC = evalOffset(null, null, { 60: 100.9, 120: 99.1, 180: 102.4 });
        assert(rC.long_outcome_60 === 'timeout_net_gain' && Math.abs(rC.long_net_r_60 - (0.3 - 0.05)) < 1e-9, 'H60 close');
        assert(rC.long_outcome_120 === 'timeout_net_loss' && Math.abs(rC.long_net_r_120 - (-0.3 - 0.05)) < 1e-9, 'H120 close');
        assert(rC.long_outcome_180 === 'timeout_net_gain' && Math.abs(rC.long_net_r_180 - (0.8 - 0.05)) < 1e-9, 'H180 close');

        // Case D: Stop hit at bar 150 -> 60=timeout, 120=timeout, 180=hard_stop
        const rD = evalOffset(150, 'stop', { 60: 101.5, 120: 99.1 });
        assert(rD.long_outcome_60 === 'timeout_net_gain' && rD.long_outcome_120 === 'timeout_net_loss' && rD.long_outcome_180 === 'hard_stop',
            'Bar 150 stop must leave 60 & 120 as timeouts and 180 as hard_stop');
    });

    // 3. Structural JSON & Column Leakage Guard (Including Adversarial Leakage Tests)
    runTest('3. Representation Schema & Nested Structural JSON Zero-Leakage Audit', () => {
        assertV3RepresentationZeroTierCLeakage(V3_REPRESENTATION_COLUMNS);

        const expectLeak = (fn: () => void, label: string) => {
            let threw = false;
            try { fn(); } catch { threw = true; }
            assert(threw, `${label}: expected leakage/contract rejection`);
        };

        expectLeak(() => assertV3RepresentationZeroTierCLeakage([...V3_REPRESENTATION_COLUMNS.slice(0, -1), 'long_net_r_60']), 'Tier C column');
        expectLeak(() => serializeAndValidateStructuralContext('PHL_BOS_MSS', { breakType: 'MSS', entry_price: 100 }), 'entry_price inside context');
        expectLeak(() => serializeAndValidateStructuralContext('PHL_BOS_MSS', { breakType: 'MSS', unknownKey: 1 }), 'unapproved context key');
        expectLeak(() => serializeAndValidateStructuralContext('PHL_BOS_MSS', { breakType: { nested: 1 } }), 'nested object inside context');
        class NonPlainContext { breakType = 'MSS'; }
        expectLeak(
            () => serializeAndValidateStructuralContext('PHL_BOS_MSS', new NonPlainContext() as any),
            'non-plain class instance inside context'
        );
        const nullPrototypeContext = Object.assign(Object.create(null), { breakType: 'MSS' });
        assert(
            serializeAndValidateStructuralContext('PHL_BOS_MSS', nullPrototypeContext).length > 0,
            'Null-prototype structural context should be accepted'
        );
        const symObj: Record<string | symbol, unknown> = { breakType: 'MSS', [Symbol('leak')]: 1 };
        expectLeak(() => serializeAndValidateStructuralContext('PHL_BOS_MSS', symObj as any), 'symbol key inside context');

        const accessorObj = {};
        Object.defineProperty(accessorObj, 'breakType', { get: () => 'MSS', enumerable: true });
        expectLeak(() => serializeAndValidateStructuralContext('PHL_BOS_MSS', accessorObj as any), 'accessor getter inside context');

        const nonEnumObj = {};
        Object.defineProperty(nonEnumObj, 'breakType', { value: 'MSS', enumerable: false });
        expectLeak(
            () => serializeAndValidateStructuralContext('PHL_BOS_MSS', nonEnumObj as any),
            'non-enumerable property inside context'
        );

        // Adversarial serialized JSON injection on a V3RepresentationRow
        const tracker = new MultiHorizonOutcomeTracker();
        const { ev, tierA } = makeDummyEventAndTierA(0, t0, interval);
        tracker.enqueueEvents([ev], 'SOLUSDT', '1m', tierA, true);
        let row!: ReturnType<typeof buildV3RepresentationRow>;
        for (let f = 1; f <= 180; f++) {
            const out = tracker.stepBar(f, { time: t0 + f * interval, open: 100, high: 100.5, low: 99.5, close: 100 });
            if (f === 180) row = buildV3RepresentationRow(out[0]);
        }
        assertV3RepresentationRowZeroLeakage(row);
        expectLeak(() => assertV3RepresentationRowZeroLeakage({
            ...row,
            tierB_structural_context_json: JSON.stringify({ breakType: 'MSS', future_outcome: 'win' })
        }), 'injected future_outcome inside serialized JSON');
    });

    // 4. Direct Isolated Teacher Adapter Contracts, Separate Controlled Streams & Explicit All-3-Class Censoring
    runTest('4. Independent Teacher Adapters, Separate Controlled Routing & All-3-Class Censoring', () => {
        const runControlled = (stream: ML1Candle[]) => {
            const cfg = createV3PipelineConfig({ symbol: 'SOLUSDT', interval: '1m', intervalMs: interval, requireContiguous: true });
            const runner = new V3PipelineRunner(cfg);
            const confirmed: StrategyEvent[] = [];
            const resolved: StrategyEvent[] = [];
            const outcomes = [];
            for (const c of stream) {
                const out = runner.stepCandle(c);
                confirmed.push(...out.confirmedEvents);
                resolved.push(...out.resolvedPreviousBarEvents);
                outcomes.push(...out.completedOutcomeRows);
            }
            const fin = runner.finalize();
            for (const row of outcomes) {
                assertV3RepresentationRowZeroLeakage(buildV3RepresentationRow(row));
            }
            return { confirmed, resolved, outcomes, fin };
        };

        // 4a. Controlled StrictCBC stream (early bar 2 unwarmed ATR, mature bar 22, incomplete horizon @100, final-bar missing open @229)
        const cbcStream: ML1Candle[] = [];
        for (let i = 0; i < 230; i++) {
            if (i === 0) cbcStream.push(makeCandle(t0, 100, 105, 95, 103, 100));
            else if (i === 1) cbcStream.push(makeCandle(t0 + interval, 103, 112, 100, 110, 100));
            else if (i === 2) cbcStream.push(makeCandle(t0 + 2 * interval, 105, 106, 92, 94, 100));       // Unwarmed ATR
            else if (i === 20) cbcStream.push(makeCandle(t0 + i * interval, 100, 115, 100, 114, 100));
            else if (i === 21) cbcStream.push(makeCandle(t0 + i * interval, 114, 120, 112, 119, 100));
            else if (i === 22) cbcStream.push(makeCandle(t0 + i * interval, 119, 119.5, 105, 106, 100));  // Eligible (>180 bars)
            else if (i === 98) cbcStream.push(makeCandle(t0 + i * interval, 106, 115, 106, 114, 100));
            else if (i === 99) cbcStream.push(makeCandle(t0 + i * interval, 114, 120, 112, 119, 100));
            else if (i === 100) cbcStream.push(makeCandle(t0 + i * interval, 119, 119.5, 105, 106, 100)); // Incomplete 180-bar horizon
            else if (i === 228) cbcStream.push(makeCandle(t0 + i * interval, 106, 122, 106, 121, 100));
            else if (i === 229) cbcStream.push(makeCandle(t0 + i * interval, 121, 121.5, 100, 101, 100)); // Missing next open
            else cbcStream.push(makeCandle(t0 + i * interval, 100, 102, 98, 101, 100));
        }
        // Isolated StrictCBC adapter check
        let isoCbcS: StrictCBCState | null = null;
        let isoCbcP: StrictZigZagPivot | null = null;
        const isoCbcEvents: StrategyEvent[] = [];
        for (let i = 0; i < cbcStream.length; i++) {
            const r = stepStrictCBCWithReset(cbcStream[i], i, isoCbcS, isoCbcP, false);
            isoCbcS = r.nextState;
            isoCbcP = r.nextPrevPivot;
            if (r.confirmedPivot) {
                const ev = adaptStrictCBCtoStrategyEvent({
                    pivot: r.confirmedPivot, prevPivot: r.prevPivotForEvent, confirmationTimestamp: cbcStream[i].time,
                    entryTimestamp: null, atr14AtConfirmation: 2.0, symbol: 'SOLUSDT', timeframe: '1m', intervalMs: interval
                });
                serializeAndValidateStructuralContext(ev.strategyId, ev.structuralContext);
                isoCbcEvents.push(ev);
            }
        }
        const expectedCbcSummary = [
            { type: 'CBC_HIGH_HH', bar: 2 },
            { type: 'CBC_LOW_LL', bar: 20 },
            { type: 'CBC_HIGH_HH', bar: 22 },
            { type: 'CBC_LOW_HL', bar: 98 },
            { type: 'CBC_HIGH_HH', bar: 100 },
            { type: 'CBC_LOW_LL', bar: 228 },
            { type: 'CBC_HIGH_HH', bar: 229 }
        ];
        assert(
            JSON.stringify(isoCbcEvents.map(e => ({ type: e.eventType, bar: e.confirmationBarIndex }))) ===
                JSON.stringify(expectedCbcSummary),
            'Isolated StrictCBC event sequence mismatch'
        );
        const cbcRes = runControlled(cbcStream);
        const pipelineCbcEvents = cbcRes.confirmed.filter(e => e.strategyId === 'STRICT_CBC');
        assert(
            pipelineCbcEvents.length === isoCbcEvents.length &&
            JSON.stringify(pipelineCbcEvents.map(e => ({ id: e.eventId, type: e.eventType, bar: e.confirmationBarIndex }))) ===
                JSON.stringify(isoCbcEvents.map(e => ({ id: e.eventId, type: e.eventType, bar: e.confirmationBarIndex }))),
            'StrictCBC pipeline confirmed events must match isolated adapter events exactly'
        );
        assert((cbcRes.fin.outcomeAccounting.countsByStrategy['STRICT_CBC'] ?? 0) >= 1, 'STRICT_CBC must route eligible outcomes');
        assert(cbcRes.fin.outcomeAccounting.excludedUnwarmedAtr >= 1, 'Aggregate pipeline must record excludedUnwarmedAtr');
        assert(cbcRes.fin.outcomeAccounting.excludedIncompleteHorizon >= 1, 'Aggregate pipeline must record excludedIncompleteHorizon');
        assert(cbcRes.fin.outcomeAccounting.excludedMissingNextOpen >= 1, 'Aggregate pipeline must record excludedMissingNextOpen');
        assert(
            cbcRes.fin.unresolvedFinalBarEvents.some(e => e.strategyId === 'STRICT_CBC' && e.entryTimestamp === null && e.entryBarIndex === cbcStream.length),
            'Final bar STRICT_CBC event must stay unresolved with entryTimestamp=null'
        );

        // 4b. Dedicated Controlled PHL stream (verified 26-bar PHL BOS/MSS fixture + 185 forward bars)
        const phlBars: Array<[number, number, number, number]> = [
            [100, 102, 99, 101], [101, 105, 100, 104], [104, 107, 103, 106], [106, 110, 105, 107],
            [107, 108, 103, 104], [104, 106, 100, 101], [101, 103, 98, 99],
            [99, 100, 96, 97],   [97, 98, 95, 96],    [96, 97, 94, 95],
            [95, 99, 95, 98],    [98, 102, 97, 101],  [101, 105, 100, 104],
            [104, 108, 103, 107],[107, 109, 106, 108],[108, 113, 107, 112],
            [112, 115, 111, 114],[114, 118, 113, 115],[115, 116, 110, 111],
            [111, 113, 109, 110],[110, 112, 108, 109],[109, 116, 109, 115],
            [115, 121, 114, 120],[120, 120, 100, 101],[101, 102, 92, 93],
            [93, 94, 89, 90]
        ];
        const phlStream: ML1Candle[] = [];
        for (let i = 0; i < 210; i++) {
            const [o, h, l, c] = i < phlBars.length ? phlBars[i] : [90, 91, 89, 90.5];
            phlStream.push(makeCandle(t0 + i * interval, o, h, l, c, 100));
        }
        // Isolated PHL teacher check
        const phlCfg = createDefaultPHLConfig('SOLUSDT', '1m', interval);
        let isoPhlS = createInitialPHLState();
        const isoPhlEvents: StrategyEvent[] = [];
        for (let i = 0; i < phlStream.length; i++) {
            const r = stepPHL(phlStream[i], i, isoPhlS, phlCfg, false, 2.0, null);
            isoPhlS = r.nextState;
            for (const ev of r.events) {
                serializeAndValidateStructuralContext(ev.strategyId, ev.structuralContext);
                isoPhlEvents.push(ev);
            }
        }
        const expectedPhlSummary = [
            { type: 'PHL_MSS_BULL', bar: 15 },
            { type: 'PHL_BOS_BULL', bar: 22 },
            { type: 'PHL_MSS_BEAR', bar: 24 }
        ];
        assert(
            JSON.stringify(isoPhlEvents.map(e => ({ type: e.eventType, bar: e.confirmationBarIndex }))) ===
                JSON.stringify(expectedPhlSummary),
            'Isolated PHL event types/bars mismatch'
        );
        const phlRes = runControlled(phlStream);
        const pipelinePhlEvents = phlRes.confirmed.filter(e => e.strategyId === 'PHL_BOS_MSS');
        assert(
            pipelinePhlEvents.length === isoPhlEvents.length &&
            JSON.stringify(pipelinePhlEvents.map(e => ({ id: e.eventId, type: e.eventType, bar: e.confirmationBarIndex }))) ===
                JSON.stringify(isoPhlEvents.map(e => ({ id: e.eventId, type: e.eventType, bar: e.confirmationBarIndex }))),
            'PHL pipeline confirmed events must match isolated teacher events exactly'
        );
        assert((phlRes.fin.outcomeAccounting.countsByStrategy['PHL_BOS_MSS'] ?? 0) === 3,
            `PHL_BOS_MSS must route all 3 eligible outcomes, got ${phlRes.fin.outcomeAccounting.countsByStrategy['PHL_BOS_MSS']}`);

        // 4c. Dedicated Controlled DTFX stream (verified 24-bar DTFX creation + R1 + R2 fixture + 185 forward bars)
        const dtfxStream: ML1Candle[] = [];
        for (let i = 0; i <= 15; i++) {
            if (i === 0) dtfxStream.push(makeCandle(t0, 105, 115, 104, 106, 100));
            else if (i === 5) dtfxStream.push(makeCandle(t0 + i * interval, 104, 106, 98, 103, 100));
            else dtfxStream.push(makeCandle(t0 + i * interval, 105, 108, 102, 105, 100));
        }
        dtfxStream.push(makeCandle(t0 + 16 * interval, 106, 118, 106, 117, 100)); // CREATED @16
        dtfxStream.push(makeCandle(t0 + 17 * interval, 117, 119, 116, 118, 100));
        dtfxStream.push(makeCandle(t0 + 18 * interval, 116, 117, 112, 114, 100)); // R1 @18
        dtfxStream.push(makeCandle(t0 + 19 * interval, 114, 115, 109, 113, 100));
        dtfxStream.push(makeCandle(t0 + 20 * interval, 116, 118, 116, 117, 100));
        dtfxStream.push(makeCandle(t0 + 21 * interval, 117, 117, 110, 111, 100)); // R2 @21
        for (let i = 22; i < 210; i++) {
            dtfxStream.push(makeCandle(t0 + i * interval, 111, 112, 110, 111, 100));
        }
        // Isolated DTFX teacher check
        const dtfxCfg = createDefaultDTFXConfig('SOLUSDT', '1m', interval);
        let isoDtfxS = createInitialDTFXState();
        const isoDtfxEvents: StrategyEvent[] = [];
        for (let i = 0; i < dtfxStream.length; i++) {
            const r = stepDTFX(dtfxStream[i], i, isoDtfxS, dtfxCfg, false, 2.0, null);
            isoDtfxS = r.nextState;
            for (const ev of r.events) {
                serializeAndValidateStructuralContext(ev.strategyId, ev.structuralContext);
                isoDtfxEvents.push(ev);
            }
        }
        const expectedDtfxSummary = [
            { type: 'DTFX_DEMAND_CREATED', bar: 16 },
            { type: 'DTFX_DEMAND_RETEST', bar: 18 },
            { type: 'DTFX_DEMAND_RETEST', bar: 21 }
        ];
        assert(
            JSON.stringify(isoDtfxEvents.map(e => ({ type: e.eventType, bar: e.confirmationBarIndex }))) ===
                JSON.stringify(expectedDtfxSummary),
            'Isolated DTFX event types/bars mismatch'
        );
        const dtfxRes = runControlled(dtfxStream);
        const pipelineDtfxEvents = dtfxRes.confirmed.filter(e => e.strategyId === 'DTFX_ZONES');
        assert(
            pipelineDtfxEvents.length === isoDtfxEvents.length &&
            JSON.stringify(pipelineDtfxEvents.map(e => ({ id: e.eventId, type: e.eventType, bar: e.confirmationBarIndex }))) ===
                JSON.stringify(isoDtfxEvents.map(e => ({ id: e.eventId, type: e.eventType, bar: e.confirmationBarIndex }))),
            'DTFX pipeline confirmed events must match isolated teacher events exactly'
        );
        assert((dtfxRes.fin.outcomeAccounting.countsByStrategy['DTFX_ZONES'] ?? 0) === 3,
            `DTFX_ZONES must route all 3 eligible outcomes, got ${dtfxRes.fin.outcomeAccounting.countsByStrategy['DTFX_ZONES']}`);

        // 4d. Dedicated Controlled VAM stream (verified bar 38 VAM_SELL + bar 49 VAM_BUY + 190 forward bars)
        const vamStream: ML1Candle[] = [];
        for (let i = 0; i < 245; i++) {
            let o: number, h: number, l: number, c: number;
            if (i <= 27) { o = 99 + i; h = 102 + i; l = 98 + i; c = 100 + i; }
            else if (i <= 38) { const p = 127 - (i - 27) * 2.5; o = p + 0.5; h = p + 2; l = p - 2; c = p - 1; }
            else { const p = 99.5 + (i - 38) * 4.0; o = p - 0.5; h = p + 2; l = p - 2; c = p + 1; }
            vamStream.push(makeCandle(t0 + i * interval, o, h, l, c, 100));
        }
        // Isolated VAM adapter check
        let isoVamS = createInitialVAMState();
        const isoVamEvents: StrategyEvent[] = [];
        for (let i = 0; i < vamStream.length; i++) {
            const out = stepVolatilityAdjustedMean(vamStream[i].high, vamStream[i].low, vamStream[i].close, isoVamS, false);
            isoVamS = out.nextState;
            const ev = adaptVAMtoStrategyEvent({
                vamOutput: out, confirmationBarIndex: i, confirmationTimestamp: vamStream[i].time,
                entryTimestamp: null, symbol: 'SOLUSDT', timeframe: '1m', intervalMs: interval
            });
            if (ev) {
                serializeAndValidateStructuralContext(ev.strategyId, ev.structuralContext);
                isoVamEvents.push(ev);
            }
        }
        const expectedVamSummary = [
            { type: 'VAM_SELL', bar: 38 },
            { type: 'VAM_BUY', bar: 49 }
        ];
        assert(
            JSON.stringify(isoVamEvents.map(e => ({ type: e.eventType, bar: e.confirmationBarIndex }))) ===
                JSON.stringify(expectedVamSummary),
            'Isolated VAM adapter must emit VAM_SELL @38 and VAM_BUY @49'
        );
        const vamRes = runControlled(vamStream);
        const pipelineVamEvents = vamRes.confirmed.filter(e => e.strategyId === 'VAM_REVERSAL');
        assert(
            pipelineVamEvents.length === isoVamEvents.length &&
            JSON.stringify(pipelineVamEvents.map(e => ({ id: e.eventId, type: e.eventType, bar: e.confirmationBarIndex }))) ===
                JSON.stringify(isoVamEvents.map(e => ({ id: e.eventId, type: e.eventType, bar: e.confirmationBarIndex }))),
            'VAM pipeline confirmed events must match isolated adapter events exactly'
        );
        assert((vamRes.fin.outcomeAccounting.countsByStrategy['VAM_REVERSAL'] ?? 0) === 2,
            `VAM_REVERSAL must route both eligible outcomes, got ${vamRes.fin.outcomeAccounting.countsByStrategy['VAM_REVERSAL']}`);

        // 4e. Direct MultiHorizonOutcomeTracker 3-Class Censoring Test (unwarmed ATR = 1, incomplete horizon = 1, missing next open = 1)
        const censorTracker = new MultiHorizonOutcomeTracker();
        const { ev: evUnwarmed, tierA: taUnwarmed } = makeDummyEventAndTierA(2, t0, interval);
        const { ev: evIncomp, tierA: taIncomp } = makeDummyEventAndTierA(20, t0, interval);
        const { ev: evMissingOpen, tierA: taMissingOpen } = makeDummyEventAndTierA(100, t0, interval);
        for (let i = 0; i <= 100; i++) {
            const c = { time: t0 + i * interval, open: 100, high: 101, low: 99, close: 100 };
            censorTracker.stepBar(i, c);
            if (i === 2) censorTracker.enqueueEvents([evUnwarmed], 'SOLUSDT', '1m', taUnwarmed, false);
            if (i === 20) censorTracker.enqueueEvents([evIncomp], 'SOLUSDT', '1m', taIncomp, true);
            if (i === 100) censorTracker.enqueueEvents([evMissingOpen], 'SOLUSDT', '1m', taMissingOpen, true);
        }
        const censorAcc = censorTracker.finalizeEndOfStream(101);
        assert(
            censorAcc.totalCandidateEvents === 3 &&
            censorAcc.excludedUnwarmedAtr === 1 &&
            censorAcc.excludedIncompleteHorizon === 1 &&
            censorAcc.excludedMissingNextOpen === 1 &&
            censorAcc.eligibleEvents === 0,
            `Direct 3-class censoring mismatch: ${JSON.stringify(censorAcc)}`
        );
    });

    // 5. End-to-End Pipeline Integration, Exactly-Once Entry Resolution, Strict Accounting, Bounded Memory & Parity
    runTest('5. Shared V3PipelineRunner: 15m-Only MTF, Exactly-Once Entry Identity, Accounting, Memory & Parity', () => {
        const candles = makeSyntheticStream(650, t0, interval, 420);

        const runPass = (requireContiguous: boolean) => {
            const cfg = createV3PipelineConfig({ symbol: 'SOLUSDT', interval: '1m', intervalMs: interval, requireContiguous });
            const runner = new V3PipelineRunner(cfg);
            const steps = [];
            const confirmedById = new Map<string, StrategyEvent>();
            const resolvedSeenIds = new Set<string>();
            const outcomeRows = [];
            let maxPending = 0;

            for (const c of candles) {
                const out = runner.stepCandle(c);
                steps.push(out);

                for (const ev of out.confirmedEvents) {
                    assert(ev.entryTimestamp === null, `Confirmed event ${ev.eventId} must start with entryTimestamp=null`);
                    assert(!confirmedById.has(ev.eventId), `Duplicate confirmed eventId ${ev.eventId}`);
                    confirmedById.set(ev.eventId, ev);
                }

                for (const resEv of out.resolvedPreviousBarEvents) {
                    assert(!resolvedSeenIds.has(resEv.eventId), `Event ${resEv.eventId} resolved more than once`);
                    resolvedSeenIds.add(resEv.eventId);

                    const orig = confirmedById.get(resEv.eventId);
                    assert(orig !== undefined, `Resolved event ${resEv.eventId} has no matching confirmed event`);
                    assert(
                        resEv.eventId === orig.eventId &&
                        resEv.confirmationBarIndex === orig.confirmationBarIndex &&
                        resEv.confirmationTimestamp === orig.confirmationTimestamp &&
                        resEv.entryBarIndex === orig.entryBarIndex &&
                        resEv.entryBarIndex === out.acceptedBarIndex &&
                        resEv.entryTimestamp !== null &&
                        resEv.entryTimestamp > resEv.confirmationTimestamp &&
                        resEv.entryTimestamp === candles[resEv.entryBarIndex].time,
                        `Resolved identity/timestamp mismatch for ${resEv.eventId}`
                    );
                }

                outcomeRows.push(...out.completedOutcomeRows);
                maxPending = Math.max(maxPending, runner.getPendingOutcomeCount());
            }
            const fin = runner.finalize();
            return { cfg, runner, steps, confirmedById, resolvedSeenIds, outcomeRows, fin, maxPending };
        };

        let strictRejected = false;
        try { runPass(true); } catch (e: any) { strictRejected = String(e.message).includes('non-contiguous'); }
        assert(strictRejected, 'requireContiguous=true must reject gap');

        const passA = runPass(false);
        const passB = runPass(false);

        assert(JSON.stringify(passA.steps) === JSON.stringify(passB.steps), 'V3PipelineRunner steps parity failed');
        assert(JSON.stringify(passA.fin) === JSON.stringify(passB.fin), 'V3PipelineRunner finalize parity failed');
        assert(getV3FeatureConfigVersion(passA.cfg).includes('M3_15M_ONLY_v1'), 'Expected 15m-only version tag');

        // Every confirmed event was either resolved exactly once OR remained in unresolvedFinalBarEvents
        assert(
            passA.confirmedById.size === passA.resolvedSeenIds.size + passA.fin.unresolvedFinalBarEvents.length,
            'Confirmed events must partition cleanly into resolved + unresolvedFinalBarEvents'
        );
        const outcomeIdSet = new Set(passA.outcomeRows.map(r => r.event_id));
        for (const finalEv of passA.fin.unresolvedFinalBarEvents) {
            const origFinal = passA.confirmedById.get(finalEv.eventId);
            assert(
                origFinal !== undefined &&
                origFinal.entryTimestamp === null &&
                finalEv.eventId === origFinal.eventId &&
                finalEv.entryTimestamp === null &&
                finalEv.confirmationBarIndex === candles.length - 1 &&
                finalEv.entryBarIndex === candles.length,
                'Unresolved final-bar event must exist in confirmedById with entryTimestamp === null and entryBarIndex === candles.length'
            );
            assert(!passA.resolvedSeenIds.has(finalEv.eventId) && !outcomeIdSet.has(finalEv.eventId),
                'Final-bar unresolved event must not be marked resolved or eligible');
        }

        // Verify 15m-only MTF (no 1h properties)
        for (const s of passA.steps) {
            assert(!('context1h' in s) && !('htf1hDiagnostic' in s), '1h MTF fields must not exist in v3');
        }
        assert(passA.steps[14].context15m?.isAvailable === false, '15m unavailable before bar 15 close');
        assert(passA.steps[15].context15m?.isAvailable === true && passA.steps[15].context15m.contextAgeMs === interval, '15m available at bar 15');
        assert(passA.steps[359].observation.validity['VolumeCandleSize_Ratio_360'] === false, 'VCS(360) invalid before bar 360');
        assert(passA.steps[360].observation.validity['VolumeCandleSize_Ratio_360'] === true, 'VCS(360) warms strictly at bar 360');
        assert(passA.steps[400].observation.validity['VolumeCandleSize_Ratio_360'] === true, 'VCS(360) valid on 1m after bar 360');
        assert(passA.steps[420].observation.validity['VolumeCandleSize_Ratio_360'] === false, 'VCS(360) resets on gap discontinuity at bar 420');

        // Explicit non-negative integer & mutually-exclusive accounting checks
        const acc = passA.fin.outcomeAccounting;
        for (const n of [
            acc.totalCandidateEvents,
            acc.excludedMissingNextOpen,
            acc.excludedUnwarmedAtr,
            acc.excludedIncompleteHorizon,
            acc.eligibleEvents
        ]) {
            assert(Number.isSafeInteger(n) && n >= 0, `Accounting count must be non-negative safe integer, got ${n}`);
        }
        assert(acc.eligibleEvents === passA.outcomeRows.length && acc.eligibleEvents > 0, 'eligibleEvents must equal outcomeRows.length');
        assert(
            acc.excludedMissingNextOpen + acc.excludedUnwarmedAtr + acc.excludedIncompleteHorizon + acc.eligibleEvents === acc.totalCandidateEvents,
            'Candidate event reconciliation failed'
        );
        const stratSum = Object.values(acc.countsByStrategy).reduce((a, b) => a + b, 0);
        const typeSum = Object.values(acc.countsByEventType).reduce((a, b) => a + b, 0);
        assert(stratSum === acc.eligibleEvents && typeSum === acc.eligibleEvents, 'Strategy/event-type sums must equal eligibleEvents');

        // Bounded memory & v2 protection
        assert(passA.runner.getPendingOutcomeCount() === 0 && passA.maxPending < 180, `Pending queue unbounded: ${passA.maxPending}`);
        assert(MLR1_DATASET_VERSION === 2 && V3_DATASET_VERSION === 3, 'v2 dataset version must stay 2');
        assert(MLR1_REPRESENTATION_COLUMNS.length === 13, 'v2 representation columns must remain untouched');
    });

    console.log(`\nPhase 5D Phase 3 Acceptance: ${passed} passed, ${failed} failed.`);
    return failed === 0;
}
