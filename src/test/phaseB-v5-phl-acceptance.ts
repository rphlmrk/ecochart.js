import type { ML1Candle } from '../indicators/mlr1/ML1FeatureTypes';
import {
    createDefaultV5PHLMultiConfigs,
    createInitialV5PHLMultiState,
    createInitialV5PHLState,
    getV5PHLActiveZoneViews,
    stepPHLV5,
    stepPHLV5Multi
} from '../indicators/mlr1/teachers/ProtectedHighsLowsTeacher';
import { buildCompletedNativeIndexTimeline } from '../indicators/mlr1/pipeline/V5LifecycleArtifact';

function assert(condition: boolean, msg: string): asserts condition {
    if (!condition) throw new Error(`[PhaseBV5PhlFailed] ${msg}`);
}

function makeWaveCandles(count: number, startTime: number, intervalMs = 60_000): ML1Candle[] {
    const out: ML1Candle[] = [];
    let p = 100;
    for (let i = 0; i < count; i++) {
        const leg = Math.floor(i / 180) % 2 === 0 ? 1 : -1;
        const swing = (i % 60) < 35 ? leg : -0.65 * leg;
        const micro = (i % 5 === 0) ? -0.4 * swing : 0.65 * swing;
        const open = p;
        const close = Math.max(20, open + micro);
        out.push({
            time: startTime + i * intervalMs,
            open,
            high: Math.max(open, close) + 0.5,
            low: Math.min(open, close) - 0.5,
            close,
            volume: 100 + (i % 7) * 15,
            isSynthetic: false
        });
        p = close;
    }
    return out;
}

export function runPhaseBV5PhlAcceptanceTests(): boolean {
    console.log('\n======================================================');
    console.log('🧪 Starting Phase B (V5 PHL Entry Zones) Acceptance Suite');
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
    const wave = makeWaveCandles(1500, t0, dt);

    runTest('1. Frozen buy/sell boundaries, 1m retest episodes, uncapped counts, raw/clamped depth & linked candidates', () => {
        // pivotStrength=1, useValidPullbacks=false deterministic 1m buy zone -> 4 retests -> BROKEN
        const cfg1 = createDefaultV5PHLMultiConfigs('SOLUSDT', '1m', dt, ['1m'], {
            pivotStrength: 1,
            useValidPullbacks: false
        })[0];
        const seq: Array<[number, number, number, number]> = [
            [100, 102, 99, 101],           // Bar 0
            [101, 105, 100, 104],          // Bar 1: PH=105
            [104, 104.5, 101, 102],        // Bar 2: confirms PH=105
            [102, 102.5, 98, 99],          // Bar 3: PL=98
            [99, 103, 98.5, 102.5],        // Bar 4: confirms PL=98 (trackLow=98)
            [102.5, 106.5, 102, 106.0],    // Bar 5: PHL_MSS_BULL breaks 105 -> PHL_BUY_ZONE [98, 105] CREATED!
            // Ep 1 (2 bars inside = 1 episode, 1 candidate)
            [106.0, 106.2, 101.0, 102.0],  // Bar 6: R1
            [102.0, 103.5, 101.5, 103.0],  // Bar 7: Stays inside (0 events, 0 candidates)
            // Exit above 105
            [105.5, 106.2, 105.2, 105.8],  // Bar 8: Exits above 105 (below new ph if any? no new ph broken)
            // Ep 2: deep wick below zoneBot=98 (low=97.0) with close=99.0 >= 98 -> raw depth > 1, clamped = 1, NOT broken!
            [105.6, 105.8, 97.0, 99.0],    // Bar 9: R2 (raw > 1)
            [105.5, 106.2, 105.2, 105.8],  // Bar 10: Exits
            [105.6, 105.8, 101.0, 102.0],  // Bar 11: R3
            [105.5, 106.2, 105.2, 105.8],  // Bar 12: Exits
            [105.6, 105.8, 101.0, 102.0],  // Bar 13: R4
            [97.5, 97.8, 96.0, 96.5]       // Bar 14: close 96.5 < 98 -> BROKEN (even if MSS_BEAR fires, BROKEN wins!)
        ];

        let st = createInitialV5PHLState();
        let buyZoneId = '';
        const retests = [];
        const candidates = [];
        const broken = [];
        const superseded = [];

        for (let i = 0; i < seq.length; i++) {
            const [o, h, l, c] = seq[i];
            assert(l <= o && o <= h && l <= c && c <= h, `Invalid OHLCV at bar ${i}`);
            const res = stepPHLV5({ time: t0 + i * dt, open: o, high: h, low: l, close: c, volume: 100, isSynthetic: false }, i, st, cfg1, false, 1.5);
            st = res.nextState;

            if (i === 5) {
                const cr = res.lifecycleEvents.filter(e => e.eventType === 'CREATED');
                assert(cr.length === 1 && cr[0].zoneSide === 'PHL_BUY_ZONE' && cr[0].zoneTop === 105 && cr[0].zoneBot === 98,
                    'Bar 5 must create frozen PHL_BUY_ZONE [98, 105]');
                buyZoneId = cr[0].zoneId;
            }
            if (i === 7) assert(res.lifecycleEvents.length === 0 && res.retestCandidates.length === 0, 'Consecutive inside bar must emit 0 events');
            if (i >= 6 && i <= 13) {
                const az = st.activeZones.find(z => z.zoneId === buyZoneId);
                assert(az !== undefined && az.zoneTop === 105 && az.zoneBot === 98, `Frozen bounds shifted at bar ${i}`);
            }
            if (i === 9) {
                assert(res.retestCandidates.length === 1 &&
                    res.retestCandidates[0].touchDepthNormRaw > 1.0 &&
                    res.retestCandidates[0].touchDepthNormClamped === 1.0,
                    'Deep wick must preserve raw depth > 1 while clamping to 1');
            }
            for (const le of res.lifecycleEvents) {
                if (le.eventType === 'RETESTED' && le.zoneId === buyZoneId) retests.push(le);
                if (le.eventType === 'BROKEN' && le.zoneId === buyZoneId) broken.push(le);
                if (le.eventType === 'SUPERSEDED' && le.zoneId === buyZoneId) superseded.push(le);
            }
            candidates.push(...res.retestCandidates.filter(cand => cand.phlZoneId === buyZoneId));
        }
        assert(retests.length === 4 && retests.map(r => r.retestCount).join(',') === '1,2,3,4', 'Expected 4 distinct PHL retests');
        assert(candidates.length === 4, 'Expected exactly 1 candidate per distinct PHL retest episode');
        for (let k = 0; k < 4; k++) {
            assert(candidates[k].phlRetestEpisodeId === retests[k].retestEpisodeId &&
                candidates[k].retestCount === retests[k].retestCount &&
                candidates[k].outcomeEligible === true,
                'Candidate-to-retest episode link mismatch');
        }
        assert(broken.length === 1 && superseded.length === 0 && broken[0].eventDirection === 'bear' && broken[0].retestCount === 4,
            'Protected boundary break must produce BROKEN (bear, retestCount=4) and never SUPERSEDED');
        assert(!st.activeZones.some(z => z.zoneId === buyZoneId), 'Broken PHL zone must leave active state');
    });

    runTest('2. 5m PHL zone survives mid-bucket 1m close breach when 5m closes back inside, & breaks strictly on 5m close', () => {
        const cfg5 = createDefaultV5PHLMultiConfigs('SOLUSDT', '1m', dt, ['5m'], {
            pivotStrength: 1,
            useValidPullbacks: false
        })[0];
        // Build 4 completed 5m buckets (bars 0..19) creating 5m PHL_BUY_ZONE [98, 105] at bar 19
        const bars: Array<[number, number, number, number]> = [
            // B0 (0..4): up to 102
            [100, 101, 99.5, 100.5], [100.5, 101.5, 100, 101], [101, 102, 100.5, 101.5], [101.5, 102, 101, 101.8], [101.8, 102, 101, 101.8],
            // B1 (5..9): PH=105
            [101.8, 103, 101.5, 102.5], [102.5, 104, 102, 103.5], [103.5, 105, 103, 104.5], [104.5, 105, 103.5, 104.2], [104.2, 104.8, 103.5, 104.0],
            // B2 (10..14): confirms PH=105
            [104.0, 104.2, 102.5, 103.0], [103.0, 103.5, 101.5, 102.0], [102.0, 102.5, 101.0, 101.5], [101.5, 102.0, 100.5, 101.0], [101.0, 101.5, 100.5, 101.0],
            // B3 (15..19): PL=98
            [101.0, 101.2, 99.5, 100.0], [100.0, 100.5, 98.5, 99.0], [99.0, 99.5, 98.0, 98.5], [98.5, 99.5, 98.2, 99.0], [99.0, 99.5, 98.5, 99.2],
            // B4 (20..24): confirms PL=98
            [99.2, 101, 99, 100.5], [100.5, 102, 100, 101.5], [101.5, 103, 101, 102.5], [102.5, 104, 102, 103.5], [103.5, 104.5, 103, 104.0],
            // B5 (25..29): breaks 105 -> creates 5m PHL_BUY_ZONE [98, 105] at bar 29!
            [104.0, 105, 103.5, 104.5], [104.5, 105.5, 104, 105.2], [105.2, 106, 105, 105.8], [105.8, 106.5, 105.2, 106.0], [106.0, 106.5, 105.5, 106.2],
            // B6 (30..34): mid-bucket 1m closes BELOW 98 at bar 31 (close=97.0!), then recovers to 100.0 at bar 34 (5m close >= 98!)
            [106.2, 106.3, 103.0, 104.0], // Bar 30: 1m RETESTED (R1)
            [104.0, 104.2, 96.5, 97.0],   // Bar 31: mid-bucket 1m close < 98 -> MUST NOT BREAK 5m zone!
            [97.0, 99.0, 96.8, 98.5],
            [98.5, 100.0, 98.0, 99.5],
            [99.5, 100.5, 99.0, 100.0],    // Bar 34: 5m closes at 100.0 >= 98 -> zone MUST SURVIVE!
            // B7 (35..39): 5m bucket closes below 98 at bar 39 -> MUST BREAK strictly at bar 39!
            [100.0, 100.2, 98.5, 99.0],
            [99.0, 99.2, 97.5, 98.0],
            [98.0, 98.2, 96.5, 97.0],
            [97.0, 97.5, 96.0, 96.5],
            [96.5, 96.8, 95.5, 96.0]       // Bar 39: 5m closes at 96.0 < 98 -> BROKEN!
        ];

        let st = createInitialV5PHLState();
        let saw5mCreated = false;
        let sawMidBucketRetest = false;
        let saw5mBrokenAt39 = false;
        for (let i = 0; i < bars.length; i++) {
            const [o, h, l, c] = bars[i];
            const res = stepPHLV5({ time: t0 + i * dt, open: o, high: h, low: l, close: c, volume: 100, isSynthetic: false }, i, st, cfg5, false, 1.5);
            st = res.nextState;
            if (i === 29) {
                saw5mCreated = res.lifecycleEvents.some(e => e.eventType === 'CREATED' && e.zoneBot === 98 && e.zoneTop === 105);
            }
            if (i === 30) {
                sawMidBucketRetest = res.lifecycleEvents.some(e => e.eventType === 'RETESTED' && e.confirmationNativeBarIndex === 5);
            }
            if (i >= 30 && i <= 38) {
                assert(!res.lifecycleEvents.some(e => e.eventType === 'BROKEN'), `5m PHL zone prematurely broken on unfinished bar ${i}`);
                assert(st.activeZones.length === 1, `5m PHL zone must survive through bar ${i}`);
            }
            if (i === 39) {
                saw5mBrokenAt39 = res.lifecycleEvents.some(e => e.eventType === 'BROKEN' && e.eventDirection === 'bear' && e.retestCount === 1);
                assert(!st.activeZones.some(z => z.zoneSide === 'PHL_BUY_ZONE'), '5m PHL buy zone must clear at bar 39');
            }
        }
        assert(saw5mCreated && sawMidBucketRetest && saw5mBrokenAt39, 'Expected 5m creation, mid-bucket retest & own-TF close break');
    });

    runTest('3. Multi-TF (1m/3m/5m ps=8): both buy & sell zones, SUPERSEDED != BROKEN, independence across TFs', () => {
        const cfgs = createDefaultV5PHLMultiConfigs('SOLUSDT', '1m', dt);
        let st = createInitialV5PHLMultiState();
        const allLifecycle = [];
        const allCandidates = [];

        for (let i = 0; i < wave.length; i++) {
            const res = stepPHLV5Multi(wave[i], i, st, cfgs, false, 1.5);
            st = res.nextState;
            allLifecycle.push(...res.lifecycleEvents);
            allCandidates.push(...res.retestCandidates);
            for (const tf of ['1m', '3m', '5m'] as const) {
                assert(st[tf].activeZones.length <= 1, `${tf} must have <= 1 active PHL zone under supersession`);
            }
        }

        assert(allLifecycle.some(e => e.zoneSide === 'PHL_BUY_ZONE' && e.eventType === 'CREATED'), 'Expected PHL_BUY_ZONE');
        assert(allLifecycle.some(e => e.zoneSide === 'PHL_SELL_ZONE' && e.eventType === 'CREATED'), 'Expected PHL_SELL_ZONE');
        assert(allLifecycle.some(e => e.eventType === 'BROKEN'), 'Expected BROKEN');
        assert(allLifecycle.some(e => e.eventType === 'SUPERSEDED' && e.eventDirection === null && e.supersededByZoneId !== null),
            'Expected valid SUPERSEDED');

        // A zone cannot be both BROKEN and SUPERSEDED
        const brokenIds = new Set(allLifecycle.filter(e => e.eventType === 'BROKEN').map(e => e.zoneId));
        const supersededIds = new Set(allLifecycle.filter(e => e.eventType === 'SUPERSEDED').map(e => e.zoneId));
        for (const id of brokenIds) {
            assert(!supersededIds.has(id), `Zone ${id} emitted both BROKEN and SUPERSEDED`);
        }
        assert(allCandidates.length === allLifecycle.filter(e => e.eventType === 'RETESTED').length,
            '1 candidate per PHL RETESTED episode invariant');
    });

    runTest('4. Mid-bucket GAP_RESET, post-gap 1m/3m/5m native-index restart parity & JSON checkpoint parity', () => {
        const cfgs = createDefaultV5PHLMultiConfigs('SOLUSDT', '1m', dt);
        const gapped = [...wave.slice(0, 600), ...wave.slice(602, 1300)];
        let gSt = createInitialV5PHLMultiState();
        const gLifecycle = [];
        const gTimeline: number[] = [];

        for (let i = 0; i < gapped.length; i++) {
            gTimeline.push(gapped[i].time);
            const res = stepPHLV5Multi(gapped[i], i, gSt, cfgs, false, 1.5);
            gSt = res.nextState;
            gLifecycle.push(...res.lifecycleEvents);
        }

        const resets = gLifecycle.filter(e => e.eventType === 'GAP_RESET' && e.confirmationBaseBarIndex === 600);
        assert(resets.length >= 1 && resets.every(r => r.eventDirection === null && r.zoneActivity === 'GAP_RESET'),
            'Expected GAP_RESET on gap bar 600');

        const expectedByTf = {
            '1m': buildCompletedNativeIndexTimeline(gTimeline, 60_000, 60_000, true),
            '3m': buildCompletedNativeIndexTimeline(gTimeline, 180_000, 60_000, true),
            '5m': buildCompletedNativeIndexTimeline(gTimeline, 300_000, 60_000, true)
        };
        for (const tf of ['1m', '3m', '5m'] as const) {
            const postGap = gLifecycle.filter(e => e.zoneTimeframe === tf && e.eventType !== 'GAP_RESET' && e.confirmationBaseBarIndex >= 600);
            assert(postGap.some(e => e.eventType === 'CREATED'), `Expected post-gap ${tf} CREATED`);
            for (const ev of postGap) {
                assert(ev.createdNativeBarIndex === expectedByTf[tf][ev.createdBaseBarIndex], `${tf} post-gap createdNativeBarIndex mismatch`);
                assert(ev.confirmationNativeBarIndex === expectedByTf[tf][ev.confirmationBaseBarIndex], `${tf} post-gap confirmationNativeBarIndex mismatch`);
            }
        }

        // Checkpoint parity (full state + lifecycle + candidates)
        let stFull = createInitialV5PHLMultiState();
        const tailLife = [];
        const tailCand = [];
        let cpIdx = -1;
        let cpJson = '';
        for (let i = 0; i < 1100; i++) {
            const res = stepPHLV5Multi(wave[i], i, stFull, cfgs, false, 1.5);
            stFull = res.nextState;
            if (cpIdx === -1 && i > 400) {
                const views = getV5PHLActiveZoneViews(stFull, i);
                if (views.length >= 2 && views.some(v => v.zone.retestCount > 0)) {
                    cpIdx = i;
                    cpJson = JSON.stringify(stFull);
                }
            }
            if (cpIdx !== -1 && i > cpIdx) {
                tailLife.push(...res.lifecycleEvents);
                tailCand.push(...res.retestCandidates);
            }
        }
        assert(cpIdx > 0, 'Expected checkpoint with active PHL zones and nonzero retests');
        let stRest = JSON.parse(cpJson);
        const restLife = [];
        const restCand = [];
        for (let i = cpIdx + 1; i < 1100; i++) {
            const res = stepPHLV5Multi(wave[i], i, stRest, cfgs, false, 1.5);
            stRest = res.nextState;
            restLife.push(...res.lifecycleEvents);
            restCand.push(...res.retestCandidates);
        }
        assert(JSON.stringify(restLife) === JSON.stringify(tailLife) &&
            JSON.stringify(restCand) === JSON.stringify(tailCand) &&
            JSON.stringify(stRest) === JSON.stringify(stFull),
            'PHL V5 checkpoint parity mismatch');
    });

    console.log(`\nPhase B (V5 PHL Entry Zones) Acceptance: ${passed} passed, ${failed} failed.\n`);
    return failed === 0;
}

