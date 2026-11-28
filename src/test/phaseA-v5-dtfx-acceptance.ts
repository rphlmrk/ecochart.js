import { buildV5DtfxLifecycleExportArtifacts } from '../data/AIExporter';
import type { ML1Candle } from '../indicators/mlr1/ML1FeatureTypes';
import {
    classifyV5DTFXDiscontinuity,
    createDefaultDTFXStrictCBCConfig,
    createDefaultV5DTFXStrictCBCMultiConfigs,
    createInitialDTFXStrictCBCState,
    createInitialV5DTFXStrictCBCMultiState,
    createInitialV5DTFXStrictCBCState,
    getV5DTFXActiveZoneViews,
    stepDTFXStrictCBCV5,
    stepDTFXStrictCBCV5Multi
} from '../indicators/mlr1/teachers/DTFXStrictCBCTeacher';
import {
    computeV5PhlDsOverlapRatio,
    isV5PhlDsAligned,
    validateV5ZoneLifecycleRecord
} from '../indicators/mlr1/pipeline/V5OutcomeContracts';
import { auditV5LifecycleArtifacts } from '../indicators/mlr1/pipeline/V5LifecycleArtifact';

function assert(condition: boolean, msg: string): asserts condition {
    if (!condition) throw new Error(`[PhaseAV5DtfxFailed] ${msg}`);
}

function makeWaveCandles(count: number, startTime: number, intervalMs = 60_000): ML1Candle[] {
    const out: ML1Candle[] = [];
    let p = 100;
    for (let i = 0; i < count; i++) {
        const leg = Math.floor(i / 60) % 2 === 0 ? 1 : -1;
        const swing = (i % 20) < 12 ? leg : -0.7 * leg;
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

export async function runPhaseAV5DtfxAcceptanceTests(): Promise<boolean> {
    console.log('\n======================================================');
    console.log('🧪 Starting Phase A (V5 DTFX Lifecycle) Acceptance Suite');
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

    const t0 = Date.UTC(2026, 9, 15, 0, 0, 0);
    const dt = 60_000;
    const wave = makeWaveCandles(720, t0, dt);

    await runTest('1. Completed-native-bar coordinates, deterministic mid-bucket 3m/5m RETESTED & BROKEN & zero false GAP_RESET', () => {
        // 1a. Wave stream over 1m/3m/5m
        const cfgs = createDefaultV5DTFXStrictCBCMultiConfigs('SOLUSDT', '1m', dt);
        let st = createInitialV5DTFXStrictCBCMultiState();
        const allEvents = [];
        const prevNativeByZone = new Map<string, number>();

        for (let i = 0; i < wave.length; i++) {
            const res = stepDTFXStrictCBCV5Multi(wave[i], i, st, cfgs, false, 1.5);
            st = res.nextState;
            allEvents.push(...res.lifecycleEvents);

            for (const ev of res.lifecycleEvents) {
                const tfMs = ev.zoneTimeframe === '1m' ? 60_000 : ev.zoneTimeframe === '3m' ? 180_000 : 300_000;
                const barsPerBucket = tfMs / dt;
                const expectedCompletedNative = Math.floor((i + 1) / barsPerBucket) - 1;

                if (ev.eventType === 'CREATED') {
                    assert((i + 1) % barsPerBucket === 0, `${ev.zoneTimeframe} created on non-closing bar ${i}`);
                    assert((ev.confirmationTimestamp + dt) % tfMs === 0, `${ev.zoneTimeframe} CREATED before bucket close`);
                    assert(ev.createdBaseBarIndex === i && ev.confirmationBaseBarIndex === i, 'CREATED base index mismatch');
                    assert(ev.createdNativeBarIndex === expectedCompletedNative, `Exact ${ev.zoneTimeframe} native creation index mismatch`);
                    assert(ev.zoneAgeBaseBars === 0 && ev.zoneAgeNativeBars === 0, 'CREATED age must be 0');
                }
                assert(ev.confirmationNativeBarIndex === expectedCompletedNative,
                    `Completed-native index mismatch on ${ev.zoneTimeframe} ${ev.eventType} @ bar ${i}`);
                const prevAge = prevNativeByZone.get(ev.zoneId) ?? 0;
                assert(ev.zoneAgeNativeBars >= prevAge, 'zoneAgeNativeBars decreased');
                prevNativeByZone.set(ev.zoneId, ev.zoneAgeNativeBars);
            }
        }
        assert(!allEvents.some(e => e.eventType === 'GAP_RESET'), 'Continuous data must never emit GAP_RESET');

        // 1b. Deterministic mid-bucket RETESTED + BROKEN fixtures for BOTH 3m and 5m
        const makeHtfMidBucketFixture = (barsPerBucket: 3 | 5) => {
            const bars: Array<[number, number, number, number]> = [];
            // Bucket 0: up
            for (let b = 0; b < barsPerBucket; b++) bars.push([100 + b * 0.5, 102 + b * 0.5, 99.5, 100.5 + b * 0.5]);
            // Bucket 1: peak to 105
            for (let b = 0; b < barsPerBucket; b++) bars.push([102 + b * 0.6, 105, 101.5, 104.5]);
            // Bucket 2: drop & flip -> confirms t=105, phaseLow=98
            for (let b = 0; b < barsPerBucket; b++) bars.push([104 - b, 104.5 - b, 98, 99]);
            // Bucket 3: break above 105 -> creates DEMAND [98, 105] on closing bar (4*barsPerBucket - 1), native idx = 3
            for (let b = 0; b < barsPerBucket; b++) bars.push([99 + b, 106.5, 98.5, b === barsPerBucket - 1 ? 106 : 103]);
            // Next unfinished Bucket 4:
            bars.push([106, 107, 105.4, 106.2]); // Bar 4*N (outside above 105)
            bars.push([106.2, 106.3, 102.0, 103.0]); // Bar 4*N+1: mid-bucket RETESTED!
            bars.push([103.0, 103.2, 96.5, 97.0]);   // Bar 4*N+2 (3m close or 5m mid): BROKEN! (Wait: for 3m shift 1 bar earlier if needed)
            return bars;
        };

        // 3m mid-bucket RETESTED (bar 12: (12+1)%3 !== 0) & mid-bucket BROKEN (bar 13: (13+1)%3 !== 0)
        const bars3m: Array<[number, number, number, number]> = [
            [100, 102, 99.5, 100.5], [100.5, 102.5, 100, 101], [101, 103, 100.5, 102],
            [102, 104, 101.5, 103], [103, 105, 102.5, 104.5], [104.5, 104.8, 103.5, 104],
            [104, 104.2, 101, 101.5], [101.5, 102, 98, 99.5], [99.5, 100, 98.5, 99],
            [99, 102, 98.8, 101.5], [101.5, 104, 101, 103.5], [103.5, 106.5, 103, 106.0], // Bar 11: 3m CREATED [98, 105] (native=3)
            [106.0, 106.2, 102.0, 103.0], // Bar 12 (mid-bucket 4!): RETESTED, native STILL 3 (ageNative=0)!
            [103.0, 103.2, 96.5, 97.0]    // Bar 13 (mid-bucket 4!): BROKEN, native STILL 3 (ageNative=0)!
        ];
        const cfg3 = createDefaultV5DTFXStrictCBCMultiConfigs('SOLUSDT', '1m', dt, ['3m'])[0];
        let st3 = createInitialV5DTFXStrictCBCState();
        let sawMidBucket3mRetest = false, sawMidBucket3mBroken = false;
        for (let i = 0; i < bars3m.length; i++) {
            const [o, h, l, c] = bars3m[i];
            const res = stepDTFXStrictCBCV5({ time: t0 + i * dt, open: o, high: h, low: l, close: c, volume: 100, isSynthetic: false }, i, st3, cfg3, false, 1.5);
            st3 = res.nextState;
            for (const ev of res.lifecycleEvents) {
                if (ev.eventType === 'RETESTED' && i === 12) {
                    assert(ev.confirmationNativeBarIndex === 3 && ev.zoneAgeNativeBars === 0 && ev.zoneAgeBaseBars === 1, '3m mid-bucket RETESTED native index');
                    sawMidBucket3mRetest = true;
                }
                if (ev.eventType === 'BROKEN' && i === 13) {
                    assert(ev.confirmationNativeBarIndex === 3 && ev.zoneAgeNativeBars === 0 && ev.zoneAgeBaseBars === 2, '3m mid-bucket BROKEN native index');
                    sawMidBucket3mBroken = true;
                }
            }
        }

        // 5m mid-bucket RETESTED (bar 21: (21+1)%5 !== 0) & mid-bucket BROKEN (bar 22: (22+1)%5 !== 0)
        const bars5m = makeHtfMidBucketFixture(5);
        const cfg5 = createDefaultV5DTFXStrictCBCMultiConfigs('SOLUSDT', '1m', dt, ['5m'])[0];
        let st5 = createInitialV5DTFXStrictCBCState();
        let sawMidBucket5mRetest = false, sawMidBucket5mBroken = false;
        for (let i = 0; i < bars5m.length; i++) {
            const [o, h, l, c] = bars5m[i];
            const res = stepDTFXStrictCBCV5({ time: t0 + i * dt, open: o, high: h, low: l, close: c, volume: 100, isSynthetic: false }, i, st5, cfg5, false, 1.5);
            st5 = res.nextState;
            for (const ev of res.lifecycleEvents) {
                if (ev.eventType === 'RETESTED' && i === 21) {
                    assert(ev.confirmationNativeBarIndex === 3 && ev.zoneAgeNativeBars === 0, '5m mid-bucket RETESTED native index');
                    sawMidBucket5mRetest = true;
                }
                if (ev.eventType === 'BROKEN' && i === 22) {
                    assert(ev.confirmationNativeBarIndex === 3 && ev.zoneAgeNativeBars === 0, '5m mid-bucket BROKEN native index');
                    sawMidBucket5mBroken = true;
                }
            }
        }
        assert(sawMidBucket3mRetest && sawMidBucket3mBroken && sawMidBucket5mRetest && sawMidBucket5mBroken,
            'Expected explicit mid-bucket RETESTED and BROKEN events for both 3m and 5m');
    });

    await runTest('2. Valid-state discontinuity classifier unit test + 3 integration GAP_RESET fixtures', () => {
        const cfg5 = createDefaultV5DTFXStrictCBCMultiConfigs('SOLUSDT', '1m', dt, ['5m'])[0];
        const baseCbc = createInitialDTFXStrictCBCState();

        // Valid closed state at bar 4 (00:04)
        const normPrev = { ...baseCbc, lastProcessedTimestamp: t0 + 4 * dt, formingBucket: null };
        const cNorm = classifyV5DTFXDiscontinuity(wave[5], normPrev, cfg5, false);
        assert(!cNorm.effectiveDiscontinuity && !cNorm.explicitDiscontinuity && !cNorm.hasMissingBaseCandle && !cNorm.isGenuineIncompleteBucket,
            'Normal 5m boundary must not trigger discontinuity');

        const cExp = classifyV5DTFXDiscontinuity(wave[5], normPrev, cfg5, true);
        assert(cExp.effectiveDiscontinuity && cExp.explicitDiscontinuity && !cExp.hasMissingBaseCandle && !cExp.isGenuineIncompleteBucket,
            'Explicit flag must isolate');

        const cMiss = classifyV5DTFXDiscontinuity(wave[6], normPrev, cfg5, false);
        assert(cMiss.effectiveDiscontinuity && !cMiss.explicitDiscontinuity && cMiss.hasMissingBaseCandle && !cMiss.isGenuineIncompleteBucket,
            'Missing base candle after closed bucket must isolate');

        // Valid reachable incomplete-bucket state: lastProcessedTimestamp === formingBucket.lastCandleTime!
        // Note: on any reachable canonical state, jumping across an incomplete bucket implies hasMissingBaseCandle is also true.
        let reachableSt5 = createInitialV5DTFXStrictCBCState();
        for (let i = 0; i <= 151; i++) reachableSt5 = stepDTFXStrictCBCV5(wave[i], i, reachableSt5, cfg5, false, 1.5).nextState;
        assert(reachableSt5.cbcState.formingBucket !== null &&
            reachableSt5.cbcState.lastProcessedTimestamp === reachableSt5.cbcState.formingBucket.lastCandleTime,
            'Reachable state invariant: lastProcessedTimestamp === formingBucket.lastCandleTime');
        const cInc = classifyV5DTFXDiscontinuity(wave[155], reachableSt5.cbcState, cfg5, false);
        assert(cInc.effectiveDiscontinuity && !cInc.explicitDiscontinuity && cInc.hasMissingBaseCandle && cInc.isGenuineIncompleteBucket,
            'Reachable incomplete-bucket jump must detect both hasMissingBaseCandle and isGenuineIncompleteBucket');

        // Integration GAP_RESET checks
        const cfgs = createDefaultV5DTFXStrictCBCMultiConfigs('SOLUSDT', '1m', dt);
        let seedSt = createInitialV5DTFXStrictCBCMultiState();
        for (let i = 0; i <= 149; i++) seedSt = stepDTFXStrictCBCV5Multi(wave[i], i, seedSt, cfgs, false, 1.5).nextState;
        const activeAt149 = getV5DTFXActiveZoneViews(seedSt, 149);
        assert(activeAt149.length >= 2, 'Expected active zones at bar 149');
        const demBefore = seedSt['1m'].historicalDemandBreakCount + seedSt['3m'].historicalDemandBreakCount + seedSt['5m'].historicalDemandBreakCount;

        const rExp = stepDTFXStrictCBCV5Multi(wave[150], 150, seedSt, cfgs, true, 1.5);
        assert(rExp.lifecycleEvents.filter(e => e.eventType === 'GAP_RESET').length === activeAt149.length &&
            getV5DTFXActiveZoneViews(rExp.nextState, 150).length === 0, 'Explicit GAP_RESET integration failed');

        const rMiss = stepDTFXStrictCBCV5Multi(wave[151], 150, seedSt, cfgs, false, 1.5);
        assert(rMiss.lifecycleEvents.filter(e => e.eventType === 'GAP_RESET').length === activeAt149.length &&
            !rMiss.lifecycleEvents.some(e => e.eventType === 'BROKEN') &&
            getV5DTFXActiveZoneViews(rMiss.nextState, 150).length === 0, 'Missing-candle GAP_RESET integration failed');
        const demAfter = rMiss.nextState['1m'].historicalDemandBreakCount + rMiss.nextState['3m'].historicalDemandBreakCount + rMiss.nextState['5m'].historicalDemandBreakCount;
        assert(demAfter === demBefore, 'GAP_RESET must not increment break counts');
    });

    await runTest('3. Symbol-separated IDs, strict source/event/direction validation, atomicity & overlap alignment', () => {
        const solCfgs = createDefaultV5DTFXStrictCBCMultiConfigs('SOLUSDT', '1m', dt);
        const btcCfgs = createDefaultV5DTFXStrictCBCMultiConfigs('BTCUSDT', '1m', dt);
        let stSol = createInitialV5DTFXStrictCBCMultiState();
        let stBtc = createInitialV5DTFXStrictCBCMultiState();
        const solIds = new Set<string>();
        const solSampleEvents = [];
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

    await runTest('4. Single-zone 4-retest geometry (retains v5RetestCount=4 into BROKEN) & maxActiveZones=1 eviction', () => {
        const seq: Array<[number, number, number, number]> = [
            [100, 102, 99, 101], [101, 105, 100, 104], [104, 105, 102, 103], [103, 104, 98, 99],
            [99, 106, 98.5, 105.5],               // Bar 4: Creates 1 DEMAND zone [98, 105]
            [105.5, 107, 105.2, 106.2],           // Bar 5: Outside above 105
            [106.2, 106.2, 103, 104],             // Bar 6: R1
            [104, 104.8, 103.5, 104.5],           // Bar 7: Stays inside (0 events)
            [105.5, 106.5, 105.3, 106.0],         // Bar 8: Exits
            [106.0, 106.0, 103.2, 104.0],         // Bar 9: R2 (canonical cap=2 reached)
            [105.5, 106.5, 105.4, 106.0],         // Bar 10: Exits
            [106.0, 106.0, 103.2, 104.0],         // Bar 11: R3 (V5=3, canonical=2)
            [105.5, 106.5, 105.4, 106.0],         // Bar 12: Exits
            [106.0, 106.0, 103.2, 104.0],         // Bar 13: R4 (V5=4, canonical=2)
            [105.5, 106.5, 105.4, 106.0],         // Bar 14: Exits (meta still retains v5RetestCount === 4)
            [97.0, 97.5, 95.0, 96.0]              // Bar 15: Gaps completely below zoneBot=98 -> BROKEN (retestCount === 4)
        ];
        const cappedCfg = createDefaultDTFXStrictCBCConfig('SOLUSDT', '1m', dt, '1m', { maxActiveZones: 10, maxRetestsPerZone: 2, emitRetests: true });
        let stRet = createInitialV5DTFXStrictCBCState();
        let targetV5ZoneId = '';
        let targetNumericId = -1;
        const expectedCanonicalAtBar = new Map<number, number>([[6, 1], [7, 1], [9, 2], [11, 2], [13, 2], [14, 2]]);
        const expectedV5AtBar = new Map<number, number>([[6, 1], [7, 1], [9, 2], [11, 3], [13, 4], [14, 4]]);
        const retests = [];
        const broken = [];

        for (let i = 0; i < seq.length; i++) {
            const [o, h, l, c] = seq[i];
            const res = stepDTFXStrictCBCV5({ time: t0 + i * dt, open: o, high: h, low: l, close: c, volume: 100, isSynthetic: false }, i, stRet, cappedCfg, false, 1.5);
            stRet = res.nextState;

            if (i === 4) {
                assert(res.lifecycleEvents.length === 1 && res.lifecycleEvents[0].eventType === 'CREATED', 'Bar 4 must create 1 zone');
                targetV5ZoneId = res.lifecycleEvents[0].zoneId;
                targetNumericId = stRet.cbcState.activeZones.find(z => stRet.zoneMetaByNumericId[z.zoneId]?.v5ZoneId === targetV5ZoneId)!.zoneId;
                assert(res.lifecycleEvents[0].zoneTop === 105 && res.lifecycleEvents[0].zoneBot === 98, 'Expected bounds [98, 105]');
            }
            if (i >= 5 && i <= 14) {
                const canonZone = stRet.cbcState.activeZones.find(z => z.zoneId === targetNumericId);
                assert(canonZone !== undefined, `Canonical zone missing at bar ${i}`);
                const meta = stRet.zoneMetaByNumericId[targetNumericId];
                assert(meta.v5ZoneId === targetV5ZoneId, `Metadata zoneId drifted at bar ${i}`);
                if (expectedCanonicalAtBar.has(i)) {
                    assert(canonZone.retestCount === expectedCanonicalAtBar.get(i), `Bar ${i} canonical retestCount mismatch`);
                    assert(meta.v5RetestCount === expectedV5AtBar.get(i), `Bar ${i} V5 retestCount mismatch`);
                }
                if (i === 7 || i === 14) assert(res.lifecycleEvents.length === 0, `Bar ${i} must emit 0 events`);
            }
            for (const le of res.lifecycleEvents) {
                if (le.eventType === 'RETESTED') retests.push(le);
                if (le.eventType === 'BROKEN') broken.push(le);
            }
        }
        assert(retests.length === 4 && retests.every(r => r.zoneId === targetV5ZoneId), 'All 4 retests must match target zone');
        assert(retests.map(r => r.retestCount).join(',') === '1,2,3,4', 'Exact counts 1,2,3,4 required');
        assert(broken.length === 1 && broken[0].zoneId === targetV5ZoneId && broken[0].retestCount === 4 &&
            broken[0].eventDirection === 'bear' && !stRet.cbcState.activeZones.some(z => z.zoneId === targetNumericId),
            'Bar 15 must emit BROKEN (bear, retestCount=4) and clear active zone');

        // Capacity eviction with maxActiveZones = 1
        const evictCfgs = createDefaultV5DTFXStrictCBCMultiConfigs('SOLUSDT', '1m', dt, ['1m'], { maxActiveZones: 1 });
        let stEv = createInitialV5DTFXStrictCBCMultiState();
        const evEvents = [];
        for (let i = 0; i < wave.length; i++) {
            const res = stepDTFXStrictCBCV5Multi(wave[i], i, stEv, evictCfgs, false, 1.5);
            stEv = res.nextState;
            evEvents.push(...res.lifecycleEvents);
            const activeIds = new Set(getV5DTFXActiveZoneViews(stEv, i, ['1m']).map(v => v.meta.v5ZoneId));
            assert(activeIds.size <= 1, 'maxActiveZones=1 violated');
            for (const le of res.lifecycleEvents) {
                if (le.eventType === 'BROKEN' || le.eventType === 'EVICTED') {
                    assert(!activeIds.has(le.zoneId), `Terminal zone ${le.zoneId} leaked into active view`);
                }
            }
        }
        assert(evEvents.some(e => e.eventType === 'EVICTED' && e.eventDirection === null && e.zoneActivity === 'EVICTED'), 'Expected EVICTED');
    });

    await runTest('5. Checkpoint parity (events + full final state) with active zones & nonzero retests', () => {
        const cfgs = createDefaultV5DTFXStrictCBCMultiConfigs('SOLUSDT', '1m', dt);
        let stFull = createInitialV5DTFXStrictCBCMultiState();
        const fullTail = [];
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
        const restoredTail = [];
        for (let i = cpIdx + 1; i < 600; i++) {
            const res = stepDTFXStrictCBCV5Multi(wave[i], i, stRestored, cfgs, false, 1.5);
            stRestored = res.nextState;
            restoredTail.push(...res.lifecycleEvents);
        }
        assert(JSON.stringify(restoredTail) === JSON.stringify(fullTail), 'Checkpoint lifecycle event mismatch');
        assert(JSON.stringify(stRestored) === JSON.stringify(stFull), 'Checkpoint final state mismatch');
    });

    await runTest('6. Real V5 exporter -> SHA-256 tampering, strict CSV, timeline validation & post-gap native-reset parity', async () => {
        const rawBuf = new Float64Array(wave.length * 6);
        for (let i = 0; i < wave.length; i++) {
            const c = wave[i];
            rawBuf.set([c.time, c.open, c.high, c.low, c.close, c.volume], i * 6);
        }

        const exported = await buildV5DtfxLifecycleExportArtifacts({
            rawCandleBuffer: rawBuf,
            symbol: 'SOLUSDT',
            interval: '1m',
            intervalMs: dt,
            buildTimestamp: 1_700_000_000_000
        });
        assert(exported.auditResult.passed && exported.lifecycleRecords.length > 0, 'Real V5 export audit must pass');
        assert(exported.manifest.fileChecksums?.[exported.lifecycleFileName] === exported.lifecycleSha256,
            'Manifest must store structured lifecycle SHA-256');

        // Negative 1: Tamper manifest counter
        const badManifest = JSON.parse(exported.manifestJson);
        badManifest.zoneLifecycleAccounting.dtfxBrokenCount += 1;
        assert(!(await auditV5LifecycleArtifacts({
            lifecycleCsv: exported.lifecycleCsv,
            manifestJson: JSON.stringify(badManifest),
            continuousBaseTimestamps: exported.timeline
        })).passed, 'Auditor must reject tampered manifest counter');

        // Negative 2: Modify a valid numeric CSV value (zoneTop) preserving valid geometry, row count & accounting -> SHA-256 must reject!
        const lines = exported.lifecycleCsv.split('\r\n');
        const hdr = lines[0].split(',');
        const zoneTopIdx = hdr.indexOf('zoneTop');
        const row1Cells = lines[1].split(',');
        const origTop = Number(row1Cells[zoneTopIdx]);
        row1Cells[zoneTopIdx] = String(origTop + 0.0001); // Still > zoneBot, valid decimal, same row count & accounting
        const validLookingTamperedCsv = [lines[0], row1Cells.join(','), ...lines.slice(2)].join('\r\n');
        const shaReject = await auditV5LifecycleArtifacts({
            lifecycleCsv: validLookingTamperedCsv,
            manifestJson: exported.manifestJson,
            continuousBaseTimestamps: exported.timeline
        });
        assert(!shaReject.passed && shaReject.remarks.some(r => r.includes('SHA-256 mismatch')),
            'Auditor must reject valid-looking numeric CSV edit via SHA-256');

        // Negative 3: Corrupt boolean cells, eventRole, whitespace numeric & native index
        const tamperCell = async (colName: string, badVal: string) => {
            const colIdx = hdr.indexOf(colName);
            assert(colIdx >= 0, `Column '${colName}' missing`);
            const cells = lines[1].split(',');
            cells[colIdx] = badVal;
            const modCsv = [lines[0], cells.join(','), ...lines.slice(2)].join('\r\n');
            assert(!(await auditV5LifecycleArtifacts({
                lifecycleCsv: modCsv,
                manifestJson: exported.manifestJson,
                continuousBaseTimestamps: exported.timeline
            })).passed, `Auditor must reject corrupted '${colName}'='${badVal}'`);
        };
        await tamperCell('outcomeEligible', 'garbage');
        await tamperCell('outcomeEligible', 'true');
        await tamperCell('atr14Valid', 'garbage');
        await tamperCell('eventRole', 'TRADE_CANDIDATE');
        await tamperCell('zoneTop', '   ');
        await tamperCell('confirmationNativeBarIndex', String(exported.lifecycleRecords[0].confirmationNativeBarIndex + 1));

        // Negative 4: Timeline input validation (duplicate, decreasing, non-integer, off-grid, unexpected gap)
        const expectTimelineReject = async (badTl: number[], label: string) => {
            const r = await auditV5LifecycleArtifacts({
                lifecycleCsv: exported.lifecycleCsv,
                manifestJson: exported.manifestJson,
                continuousBaseTimestamps: badTl
            });
            assert(!r.passed, `${label}: auditor must reject invalid timeline`);
        };
        const tlDup = [...exported.timeline]; tlDup[10] = tlDup[9];
        const tlDec = [...exported.timeline]; tlDec[10] = tlDec[9] - dt;
        const tlOff = [...exported.timeline]; tlOff[10] += 30_000;
        const tlNan = [...exported.timeline]; tlNan[10] = Number.NaN;
        const tlGap = exported.timeline.map((t, idx) => (idx >= 10 ? t + dt : t));
        await expectTimelineReject(tlDup, 'duplicate timestamp');
        await expectTimelineReject(tlDec, 'non-increasing timestamp');
        await expectTimelineReject(tlOff, 'off-grid timestamp');
        await expectTimelineReject(tlNan, 'NaN timestamp');
        await expectTimelineReject(tlGap, 'unexpected 120s gap in continuous timeline');

        // Positive 5: Post-gap recovery fixture -> verify 1m, 3m & 5m native indices restart cleanly at 0 after GAP_RESET
        // Construct stream: pre-gap bars 0..149 (3m/5m close cleanly), skip 1 bar (150), feed post-gap bars 151..449!
        const postGapCandles: ML1Candle[] = [];
        let gp = wave[149].close;
        for (let i = 151; i < 450; i++) {
            const k = i - 151;
            const phase = k % 36;
            const swing = phase < 10 ? 1 : phase < 22 ? -1.2 : 1.5;
            const open = gp;
            const close = Math.max(10, open + swing * 0.8);
            postGapCandles.push({
                time: t0 + i * dt,
                open,
                high: Math.max(open, close) + 0.4,
                low: Math.min(open, close) - 0.4,
                close,
                volume: 100 + (i % 7) * 10,
                isSynthetic: false
            });
            gp = close;
        }
        const gappedCandles = [...wave.slice(0, 150), ...postGapCandles];
        const cfgs = createDefaultV5DTFXStrictCBCMultiConfigs('SOLUSDT', '1m', dt);
        let gSt = createInitialV5DTFXStrictCBCMultiState();
        const gRecords = [];
        const gTimeline: number[] = [];
        for (let i = 0; i < gappedCandles.length; i++) {
            gTimeline.push(gappedCandles[i].time);
            const res = stepDTFXStrictCBCV5Multi(gappedCandles[i], i, gSt, cfgs, false, 1.5);
            gSt = res.nextState;
            gRecords.push(...res.lifecycleEvents);
        }
        assert(gRecords.some(e => e.eventType === 'GAP_RESET' && e.confirmationBaseBarIndex === 150), 'Expected GAP_RESET at bar 150');
        for (const tf of ['1m', '3m', '5m'] as const) {
            const postGapCreated = gRecords.filter(e => e.zoneTimeframe === tf && e.eventType === 'CREATED' && e.confirmationBaseBarIndex > 150);
            assert(postGapCreated.length > 0, `Expected post-gap ${tf} CREATED zones`);
            // Verify restarted native indices stay much smaller than base indices (prove post-gap restart from 0!)
            assert(postGapCreated[0].createdNativeBarIndex < 40, `Expected restarted ${tf} native index after gap, got ${postGapCreated[0].createdNativeBarIndex}`);
        }
        const gCsv = (await import('../indicators/mlr1/pipeline/V5LifecycleArtifact')).serializeV5ZoneLifecycleCsv(gRecords);
        const gSha = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(gCsv)))).map(b => b.toString(16).padStart(2, '0')).join('');
        const gManifest = JSON.stringify((await import('../indicators/mlr1/pipeline/V5LifecycleArtifact')).buildV5LifecycleDatasetManifest({
            symbol: 'SOLUSDT',
            timeframe: '1m',
            intervalMs: dt,
            candles: gappedCandles,
            observations: gappedCandles.map((c, idx) => ({
                symbol: 'SOLUSDT',
                timeframe: '1m',
                barIndex: idx,
                timestamp: c.time,
                sourceOpen: c.open,
                sourceHigh: c.high,
                sourceLow: c.low,
                sourceClose: c.close,
                sourceVolume: c.volume,
                features: {
                    IsSourceValid: 1,
                    HasDataGap: idx === 150 ? 1 : 0,
                    IsDiscontinuity: idx === 150 ? 1 : 0,
                    IsDuplicateTimestamp: 0,
                    IsOutOfOrder: 0,
                    IsUnexpectedInterval: 0
                },
                validity: {}
            })),
            lifecycleRecords: gRecords,
            lifecycleSha256: gSha,
            buildTimestamp: 1_700_000_000_000
        }), null, 2);

        const gapAudit = await auditV5LifecycleArtifacts({
            lifecycleCsv: gCsv,
            manifestJson: gManifest,
            continuousBaseTimestamps: gTimeline,
            allowGaps: true
        });
        assert(gapAudit.passed, `Post-gap native index restart audit failed: ${gapAudit.remarks.join('; ')}`);
    });

    console.log(`\nPhase A (V5 DTFX Lifecycle) Acceptance: ${passed} passed, ${failed} failed.\n`);
    return failed === 0;
}
