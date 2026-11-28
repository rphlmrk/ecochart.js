import type { ML1Candle } from '../indicators/mlr1/ML1FeatureTypes';
import {
    createDefaultDTFXStrictCBCConfig,
    createDefaultV5DTFXStrictCBCMultiConfigs,
    createInitialV5DTFXStrictCBCMultiState,
    createInitialV5DTFXStrictCBCState,
    getV5DTFXActiveZoneViews,
    stepDTFXStrictCBCV5,
    stepDTFXStrictCBCV5Multi,
    type V5DTFXLifecycleEvent
} from '../indicators/mlr1/teachers/DTFXStrictCBCTeacher';
import {
    assertV5ZoneLifecycleManifestReconciliation,
    computeV5PhlDsOverlapRatio,
    isV5PhlDsAligned,
    summarizeV5ZoneLifecycleAccounting,
    validateV5ZoneLifecycleRecord
} from '../indicators/mlr1/pipeline/V5OutcomeContracts';

function assert(condition: boolean, msg: string): asserts condition {
    if (!condition) throw new Error(`[PhaseAV5DtfxFailed] ${msg}`);
}

function makeWaveCandles(count: number, startTime: number, intervalMs = 60_000): ML1Candle[] {
    const out: ML1Candle[] = [];
    let p = 100;
    for (let i = 0; i < count; i++) {
        const leg = Math.floor(i / 60) % 2 === 0 ? 1 : -1;
        const swing = (i % 25) < 15 ? leg : -0.75 * leg;
        const open = p;
        const close = Math.max(10, open + swing * 0.65);
        out.push({
            time: startTime + i * intervalMs,
            open,
            high: Math.max(open, close) + 0.4,
            low: Math.min(open, close) - 0.4,
            close,
            volume: 100 + (i % 7) * 10,
            isSynthetic: false
        });
        p = close;
    }
    return out;
}

export function runPhaseAV5DtfxAcceptanceTests(): boolean {
    console.log('\n======================================================');
    console.log('🧪 Starting Phase A (V5 DTFX Lifecycle) Acceptance Suite');
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
    const dt = 60_000;
    const wave = makeWaveCandles(720, t0, dt);

    runTest('1. Exact 1m/3m/5m native/base coordinates, zero premature creation & zero false GAP_RESET', () => {
        const cfgs = createDefaultV5DTFXStrictCBCMultiConfigs('SOLUSDT', '1m', dt);
        let st = createInitialV5DTFXStrictCBCMultiState();
        const allEvents: V5DTFXLifecycleEvent[] = [];
        const prevNativeByZone = new Map<string, number>();

        for (let i = 0; i < wave.length; i++) {
            const res = stepDTFXStrictCBCV5Multi(wave[i], i, st, cfgs, false, 1.5);
            st = res.nextState;
            allEvents.push(...res.lifecycleEvents);

            for (const ev of res.lifecycleEvents) {
                const tfMs = ev.zoneTimeframe === '1m' ? 60_000 : ev.zoneTimeframe === '3m' ? 180_000 : 300_000;
                const barsPerBucket = tfMs / dt;

                if (ev.eventType === 'CREATED') {
                    assert((i + 1) % barsPerBucket === 0, `${ev.zoneTimeframe} created on non-closing bar ${i}`);
                    assert((ev.confirmationTimestamp + dt) % tfMs === 0, `${ev.zoneTimeframe} CREATED before bucket close`);
                    assert(ev.createdBaseBarIndex === i && ev.confirmationBaseBarIndex === i, 'CREATED base index mismatch');
                    assert(ev.createdNativeBarIndex === Math.floor(i / barsPerBucket), `Exact ${ev.zoneTimeframe} native creation index mismatch`);
                    assert(ev.zoneAgeBaseBars === 0 && ev.zoneAgeNativeBars === 0, 'CREATED age must be 0');
                }
                const expectedCurNative = Math.floor((i + 1) / barsPerBucket) - 1;
                assert(ev.confirmationNativeBarIndex === expectedCurNative, `Exact ${ev.zoneTimeframe} confirmationNativeBarIndex mismatch at bar ${i}`);
                const prevAge = prevNativeByZone.get(ev.zoneId) ?? 0;
                assert(ev.zoneAgeNativeBars >= prevAge, 'zoneAgeNativeBars decreased');
                prevNativeByZone.set(ev.zoneId, ev.zoneAgeNativeBars);
            }

            for (const v of getV5DTFXActiveZoneViews(st, i, ['5m'])) {
                assert(v.zoneAgeHtfBars === (Math.floor((i + 1) / 5) - 1) - v.meta.createdNativeBarIndex, '5m view native age mismatch');
                assert(v.zoneAgeBaseBars === i - v.meta.createdBaseBarIndex, '5m view base age mismatch');
            }
        }
        assert(!allEvents.some(e => e.eventType === 'GAP_RESET'), 'Continuous data must never emit GAP_RESET');
        assert(allEvents.some(e => e.eventType === 'CREATED' && e.zoneTimeframe === '3m'), 'Expected 3m CREATED');
        assert(allEvents.some(e => e.eventType === 'CREATED' && e.zoneTimeframe === '5m'), 'Expected 5m CREATED');
        assert(allEvents.some(e => e.eventType === 'BROKEN'), 'Expected BROKEN');

        const acc = summarizeV5ZoneLifecycleAccounting(allEvents);
        assertV5ZoneLifecycleManifestReconciliation(allEvents, acc);
        let recThrew = false;
        try {
            assertV5ZoneLifecycleManifestReconciliation(allEvents, { ...acc, dtfxBrokenCount: acc.dtfxBrokenCount + 1 });
        } catch { recThrew = true; }
        assert(recThrew, 'Manifest reconciliation must reject mismatched counts');
    });

    runTest('2. Isolated discontinuity fixtures (2a explicit flag, 2b missing 1m after complete bucket, 2c incomplete 3m & 5m buckets)', () => {
        // 2a + 2b: Seed until bar 149 (02:29 — BOTH 3m and 5m buckets complete cleanly, formingBucket === null!)
        const cfgs = createDefaultV5DTFXStrictCBCMultiConfigs('SOLUSDT', '1m', dt);
        let seedSt = createInitialV5DTFXStrictCBCMultiState();
        for (let i = 0; i <= 149; i++) {
            seedSt = stepDTFXStrictCBCV5Multi(wave[i], i, seedSt, cfgs, false, 1.5).nextState;
        }
        assert(seedSt['3m'].cbcState.formingBucket === null && seedSt['5m'].cbcState.formingBucket === null,
            'At bar 149 both 3m and 5m buckets must be cleanly closed');
        const activeAt149 = getV5DTFXActiveZoneViews(seedSt, 149);
        assert(activeAt149.length >= 2, 'Expected active zones at bar 149');
        const demBefore = seedSt['1m'].historicalDemandBreakCount + seedSt['3m'].historicalDemandBreakCount + seedSt['5m'].historicalDemandBreakCount;
        const supBefore = seedSt['1m'].historicalSupplyBreakCount + seedSt['3m'].historicalSupplyBreakCount + seedSt['5m'].historicalSupplyBreakCount;

        // 2a: Explicit isDiscontinuity=true on contiguous bar 150
        const r2a = stepDTFXStrictCBCV5Multi(wave[150], 150, seedSt, cfgs, true, 1.5);
        assert(r2a.lifecycleEvents.filter(e => e.eventType === 'GAP_RESET').length === activeAt149.length &&
            !r2a.lifecycleEvents.some(e => e.eventType === 'BROKEN') &&
            r2a.lifecycleEvents.every(e => e.eventDirection === null && e.zoneActivity === 'GAP_RESET'),
            '2a explicit discontinuity mismatch');
        assert(getV5DTFXActiveZoneViews(r2a.nextState, 150).length === 0, '2a active views must be empty');

        // 2b: Missing 1m candle (skip bar 150, feed bar 151) with isDiscontinuity=false and ZERO open HTF buckets
        const r2b = stepDTFXStrictCBCV5Multi(wave[151], 150, seedSt, cfgs, false, 1.5);
        assert(r2b.lifecycleEvents.filter(e => e.eventType === 'GAP_RESET').length === activeAt149.length &&
            !r2b.lifecycleEvents.some(e => e.eventType === 'BROKEN') &&
            r2b.lifecycleEvents.every(e => e.eventDirection === null && e.zoneActivity === 'GAP_RESET'),
            '2b missing 1m candle mismatch');
        assert(getV5DTFXActiveZoneViews(r2b.nextState, 150).length === 0, '2b active views must be empty');
        const demAfter2b = r2b.nextState['1m'].historicalDemandBreakCount + r2b.nextState['3m'].historicalDemandBreakCount + r2b.nextState['5m'].historicalDemandBreakCount;
        const supAfter2b = r2b.nextState['1m'].historicalSupplyBreakCount + r2b.nextState['3m'].historicalSupplyBreakCount + r2b.nextState['5m'].historicalSupplyBreakCount;
        assert(demAfter2b === demBefore && supAfter2b === supBefore, '2b GAP_RESET must not increment break counts');

        // 2c-3m: Isolated incomplete 3m bucket (complete through 149, open 150, skip 151-152, jump to 153)
        const cfg3 = createDefaultV5DTFXStrictCBCMultiConfigs('SOLUSDT', '1m', dt, ['3m'])[0];
        let st3 = createInitialV5DTFXStrictCBCState();
        for (let i = 0; i <= 150; i++) st3 = stepDTFXStrictCBCV5(wave[i], i, st3, cfg3, false, 1.5).nextState;
        assert(st3.cbcState.formingBucket !== null && st3.cbcState.activeZones.length >= 1, 'Expected open 3m bucket & active zones');
        const active3Count = st3.cbcState.activeZones.length;
        const r3Gap = stepDTFXStrictCBCV5(wave[153], 151, st3, cfg3, false, 1.5);
        assert(r3Gap.lifecycleEvents.filter(e => e.eventType === 'GAP_RESET').length === active3Count &&
            r3Gap.nextState.cbcState.activeZones.length === 0, '2c-3m incomplete bucket GAP_RESET');

        // 2c-5m: Isolated incomplete 5m bucket (complete through 149, open 150-151, skip 152-154, jump to 155)
        const cfg5 = createDefaultV5DTFXStrictCBCMultiConfigs('SOLUSDT', '1m', dt, ['5m'])[0];
        let st5 = createInitialV5DTFXStrictCBCState();
        for (let i = 0; i <= 151; i++) st5 = stepDTFXStrictCBCV5(wave[i], i, st5, cfg5, false, 1.5).nextState;
        assert(st5.cbcState.formingBucket !== null && st5.cbcState.activeZones.length >= 1, 'Expected open 5m bucket & active zones');
        const active5Count = st5.cbcState.activeZones.length;
        const r5Gap = stepDTFXStrictCBCV5(wave[155], 152, st5, cfg5, false, 1.5);
        assert(r5Gap.lifecycleEvents.filter(e => e.eventType === 'GAP_RESET').length === active5Count &&
            r5Gap.nextState.cbcState.activeZones.length === 0, '2c-5m incomplete bucket GAP_RESET');
    });

    runTest('3. Symbol-separated IDs, strict source/event/direction validation, atomicity & overlap alignment', () => {
        const solCfgs = createDefaultV5DTFXStrictCBCMultiConfigs('SOLUSDT', '1m', dt);
        const btcCfgs = createDefaultV5DTFXStrictCBCMultiConfigs('BTCUSDT', '1m', dt);
        let stSol = createInitialV5DTFXStrictCBCMultiState();
        let stBtc = createInitialV5DTFXStrictCBCMultiState();
        const solIds = new Set<string>();
        const solSampleEvents: V5DTFXLifecycleEvent[] = [];
        for (let i = 0; i < 200; i++) {
            const rs = stepDTFXStrictCBCV5Multi(wave[i], i, stSol, solCfgs, false, 1.5);
            const rb = stepDTFXStrictCBCV5Multi(wave[i], i, stBtc, btcCfgs, false, 1.5);
            stSol = rs.nextState;
            stBtc = rb.nextState;
            for (const e of rs.lifecycleEvents) { solIds.add(e.zoneId); solSampleEvents.push(e); }
            for (const e of rb.lifecycleEvents) assert(!solIds.has(e.zoneId), 'Cross-symbol zoneId collision');
        }
        const sample = solSampleEvents[0];
        const expectInvalidRecord = (bad: any, label: string) => {
            let threw = false;
            try { validateV5ZoneLifecycleRecord(bad); } catch { threw = true; }
            assert(threw, `${label}: validator must reject`);
        };
        expectInvalidRecord({ ...sample, source: 'BOGUS' }, 'unknown source');
        expectInvalidRecord({ ...sample, eventType: 'BOGUS' }, 'unknown eventType');
        expectInvalidRecord({ ...sample, eventType: 'SUPERSEDED', zoneActivity: 'SUPERSEDED', supersededByZoneId: 'OTHER', eventDirection: null }, 'DTFX SUPERSEDED');
        expectInvalidRecord({ ...sample, zoneSide: 'DEMAND', zoneDirection: 'bull', eventType: 'CREATED', eventDirection: 'bear' }, 'contradictory DEMAND CREATED direction');
        expectInvalidRecord({ ...sample, zoneSide: 'DEMAND', zoneDirection: 'bull', eventType: 'BROKEN', zoneActivity: 'BROKEN', eventDirection: 'bull' }, 'contradictory DEMAND BROKEN direction');

        const beforeSnap = JSON.stringify(stSol);
        let badCfgThrew = false;
        try { stepDTFXStrictCBCV5Multi(wave[200], 200, stSol, [], false, 1.5); } catch { badCfgThrew = true; }
        assert(badCfgThrew && JSON.stringify(stSol) === beforeSnap, 'Invalid config must leave prior state untouched');

        assert(isV5PhlDsAligned('PHL_BUY_ZONE', 'DEMAND') && !isV5PhlDsAligned('PHL_BUY_ZONE', 'SUPPLY'), 'Alignment check');
        assert(Math.abs(computeV5PhlDsOverlapRatio(110, 100, 105, 95) - 0.5) < 1e-12, 'Overlap ratio');
    });

    runTest('4. Exact single-zone 4-retest geometry (cap=2), gap-across-zone BROKEN & maxActiveZones=1 eviction', () => {
        const seq: Array<[number, number, number, number]> = [
            [100, 102, 99, 101], [101, 105, 100, 104], [104, 105, 102, 103], [103, 104, 98, 99],
            [99, 106, 98.5, 105.5],               // Bar 4: Creates 1 bull DEMAND zone [98, 105]
            [105.5, 107, 105.2, 106.2],           // Bar 5: Outside above 105
            [106.2, 106.2, 103, 104],             // Bar 6: Ep 1 inside (triggers R1)
            [104, 104.8, 103.5, 104.5],           // Bar 7: Stays inside (0 events!)
            [104.5, 106.5, 103.5, 106.0],         // Bar 8: Exits above 105 (rally bar)
            [106.0, 107.0, 105.3, 106.2],         // Bar 9: Strictly outside above 105
            [106.2, 106.2, 103.2, 104.0],         // Bar 10: Ep 2 (triggers R2)
            [104.0, 106.5, 103.5, 106.0],         // Bar 11: Rally bar
            [106.0, 107.0, 105.4, 106.2],         // Bar 12: Strictly outside above 105
            [106.2, 106.2, 103.2, 104.0],         // Bar 13: Ep 3 (beyond canonical cap=2!)
            [104.0, 106.5, 103.5, 106.0],         // Bar 14: Rally bar
            [106.0, 107.0, 105.4, 106.2],         // Bar 15: Strictly outside above 105
            [106.2, 106.2, 103.2, 104.0],         // Bar 16: Ep 4
            [104.0, 106.5, 103.5, 106.0],         // Bar 17: Rally bar
            [106.0, 107.0, 105.4, 106.2],         // Bar 18: Strictly outside above 105
            [97.0, 97.5, 95.0, 96.0]              // Bar 19: Gaps completely below zoneBot=98 -> BROKEN (not RETESTED)
        ];
        const cappedCfg = createDefaultDTFXStrictCBCConfig('SOLUSDT', '1m', dt, '1m', { maxActiveZones: 10, maxRetestsPerZone: 2, emitRetests: true });
        let stRet = createInitialV5DTFXStrictCBCState();
        const created: V5DTFXLifecycleEvent[] = [];
        const retests: V5DTFXLifecycleEvent[] = [];
        const broken: V5DTFXLifecycleEvent[] = [];

        for (let i = 0; i < seq.length; i++) {
            const [o, h, l, c] = seq[i];
            const res = stepDTFXStrictCBCV5({ time: t0 + i * dt, open: o, high: h, low: l, close: c, volume: 100, isSynthetic: false }, i, stRet, cappedCfg, false, 1.5);
            stRet = res.nextState;
            if (i === 7) assert(res.lifecycleEvents.length === 0, 'Consecutive inside bar 7 must emit 0 events');
            if (i === 18) {
                assert(stRet.cbcState.activeZones.length === 1 && stRet.cbcState.activeZones[0].retestCount === 2, 'Canonical counter must stay capped at 2');
                assert(created.length === 1 && created[0].zoneTop === 105 && created[0].zoneBot === 98, 'Expected exact single zone [98, 105] through bar 18');
            }
            if (i === 19) {
                assert(!res.lifecycleEvents.some(e => e.eventType === 'RETESTED'), 'Gap-below-zone bar 19 must not emit RETESTED');
            }
            for (const le of res.lifecycleEvents) {
                if (le.eventType === 'CREATED') created.push(le);
                if (le.eventType === 'RETESTED') retests.push(le);
                if (le.eventType === 'BROKEN') broken.push(le);
            }
        }
        const demandZone = created[0];
        assert(Boolean(demandZone) && demandZone.zoneSide === 'DEMAND' && demandZone.zoneTop === 105 && demandZone.zoneBot === 98, 'Expected exact DEMAND zone [98, 105]');
        assert(retests.length === 4 && retests.every(r => r.zoneId === demandZone.zoneId), 'All 4 retests must belong to single zone');
        assert(retests.map(r => r.retestCount).join(',') === '1,2,3,4', 'Exact retest counts 1,2,3,4 required');
        assert(broken.length === 1 && broken[0].zoneId === demandZone.zoneId && broken[0].confirmationBaseBarIndex === 19 && broken[0].retestCount === 4 && broken[0].eventDirection === 'bear',
            'Gap-below-zone bar 19 must emit BROKEN (bear, retestCount=4) without RETESTED');

        // Capacity eviction with maxActiveZones = 1
        const evictCfgs = createDefaultV5DTFXStrictCBCMultiConfigs('SOLUSDT', '1m', dt, ['1m'], { maxActiveZones: 1 });
        let stEv = createInitialV5DTFXStrictCBCMultiState();
        const evEvents: V5DTFXLifecycleEvent[] = [];
        for (let i = 0; i < wave.length; i++) {
            const res = stepDTFXStrictCBCV5Multi(wave[i], i, stEv, evictCfgs, false, 1.5);
            stEv = res.nextState;
            evEvents.push(...res.lifecycleEvents);
            const activeIds = new Set(getV5DTFXActiveZoneViews(stEv, i, ['1m']).map(v => v.meta.v5ZoneId));
            assert(activeIds.size <= 1, 'maxActiveZones=1 violated');
            for (const le of res.lifecycleEvents) {
                if (le.eventType === 'BROKEN' || le.eventType === 'EVICTED') {
                    assert(!activeIds.has(le.zoneId), `Evicted/broken zone ${le.zoneId} leaked into active view`);
                }
            }
        }
        assert(evEvents.some(e => e.eventType === 'EVICTED' && e.eventDirection === null && e.zoneActivity === 'EVICTED'), 'Expected EVICTED');
    });

    runTest('5. Checkpoint save/restore parity (events + final state) with active zones & nonzero retests', () => {
        const cfgs = createDefaultV5DTFXStrictCBCMultiConfigs('SOLUSDT', '1m', dt);
        let stFull = createInitialV5DTFXStrictCBCMultiState();
        const fullTail: V5DTFXLifecycleEvent[] = [];
        let cpIdx = -1;
        let cpJson = '';
        for (let i = 0; i < 600; i++) {
            const res = stepDTFXStrictCBCV5Multi(wave[i], i, stFull, cfgs, false, 1.5);
            stFull = res.nextState;
            if (cpIdx === -1 && i > 200) {
                const views = getV5DTFXActiveZoneViews(stFull, i);
                if (views.length >= 2 && views.some(v => v.retestCount > 0)) {
                    cpIdx = i;
                    cpJson = JSON.stringify(stFull);
                }
            }
            if (cpIdx !== -1 && i > cpIdx) fullTail.push(...res.lifecycleEvents);
        }
        assert(cpIdx > 0, 'Expected checkpoint with active zones & nonzero retests');

        let stRestored = JSON.parse(cpJson);
        const restoredTail: V5DTFXLifecycleEvent[] = [];
        for (let i = cpIdx + 1; i < 600; i++) {
            const res = stepDTFXStrictCBCV5Multi(wave[i], i, stRestored, cfgs, false, 1.5);
            stRestored = res.nextState;
            restoredTail.push(...res.lifecycleEvents);
        }
        assert(JSON.stringify(restoredTail) === JSON.stringify(fullTail), 'Checkpoint lifecycle event mismatch');
        assert(JSON.stringify(stRestored) === JSON.stringify(stFull), 'Checkpoint final state mismatch');
    });

    console.log(`\nPhase A (V5 DTFX Lifecycle) Acceptance: ${passed} passed, ${failed} failed.\n`);
    return failed === 0;
}
