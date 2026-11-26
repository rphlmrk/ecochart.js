import { DataStore } from '../data/DataStore';
import { IndicatorRegistry } from '../indicators/IndicatorRegistry';
import type { ML1Candle } from '../indicators/mlr1/ML1FeatureTypes';
import { updateWilderATR } from '../indicators/mlr1/volatility/ATR';
import { createDefaultV4DTFXStrictCBCMultiConfigs } from '../indicators/mlr1/teachers/DTFXStrictCBCTeacher';
import {
    createDefaultPHLConfig,
    createDefaultPHLV4Config,
    createDefaultPHLV4MultiConfigs,
    createInitialPHLState,
    createInitialPHLV4MultiState,
    createInitialPHLV4State,
    PHL_TIMEFRAME_MS,
    stepPHL,
    stepPHLV4,
    stepPHLV4Multi,
    validatePHLV4State
} from '../indicators/mlr1/teachers/ProtectedHighsLowsTeacher';
import { ProtectedHighsLowsIndicator } from '../indicators/plugins/ProtectedHighsLowsIndicator';
import { DTFXStrictCBCIndicator } from '../indicators/plugins/DTFXStrictCBCIndicator';

function assert(condition: boolean, msg: string): asserts condition {
    if (!condition) throw new Error(`[Phase3V4TeachersFailed] ${msg}`);
}

function makeWaveStream(count: number, startTime: number, intervalMs = 60_000, gapAt?: number): ML1Candle[] {
    const out: ML1Candle[] = [];
    let ts = startTime;
    let p = 100;
    for (let i = 0; i < count; i++) {
        if (gapAt !== undefined && i === gapAt) ts += 10 * intervalMs;
        const major = Math.floor(i / 180) % 2 === 0 ? 1 : -1;
        const swing = (i % 60) < 35 ? major : -0.65 * major;
        const micro = (i % 5 === 0) ? -0.4 * swing : 0.65 * swing;
        const open = p;
        const close = Math.max(20, open + micro);
        out.push({
            time: ts,
            open,
            high: Math.max(open, close) + 0.5,
            low: Math.min(open, close) - 0.5,
            close,
            volume: 100 + (i % 7) * 15,
            isSynthetic: false
        });
        p = close;
        ts += intervalMs;
    }
    return out;
}

function normalizePHLEvent(e: any) {
    return {
        eventType: e.eventType,
        eventDirection: e.eventDirection,
        sourceBarIndex: e.sourceBarIndex,
        sourceTimestamp: e.sourceTimestamp,
        confirmationBarIndex: e.confirmationBarIndex,
        confirmationTimestamp: e.confirmationTimestamp,
        breakType: e.structuralContext.breakType,
        brokenLevelPrice: e.structuralContext.brokenLevelPrice,
        hasProtectedLevel: e.structuralContext.hasProtectedLevel,
        protectedLevelPrice: e.structuralContext.protectedLevelPrice,
        protectedLevelBarIndex: e.structuralContext.protectedLevelBarIndex,
        protectedLevelTimestamp: e.structuralContext.protectedLevelTimestamp,
        atr14Valid: e.structuralContext.atr14Valid,
        distToProtectedAtr: e.structuralContext.distToProtectedAtr === null || e.structuralContext.distToProtectedAtr === undefined
            ? null
            : Math.round(Number(e.structuralContext.distToProtectedAtr) * 1e9) / 1e9,
        pbFromLowValid: e.structuralContext.pbFromLowValid,
        pbFromHighValid: e.structuralContext.pbFromHighValid
    };
}

export function runPhase3V4TeachersAcceptanceTests(): boolean {
    console.log('\n======================================================');
    console.log('🧪 Starting Phase 3 (V4 Teachers & Plugins) Acceptance Suite');
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
    const stream = makeWaveStream(1200, t0, dt);

    runTest('1. Config contracts enforce 1m/3m/5m, PHL pivotStrength=8, and reject duplicates/empty/15m/invalid', () => {
        const dtfxCfgs = createDefaultV4DTFXStrictCBCMultiConfigs('SOLUSDT', '1m', dt);
        assert(dtfxCfgs.map(c => c.zoneTimeframe).join(',') === '1m,3m,5m', 'V4 DTFXStrictCBC timeframes');
        const phlCfgs = createDefaultPHLV4MultiConfigs('SOLUSDT', '1m', dt);
        assert(phlCfgs.map(c => c.phlTimeframe).join(',') === '1m,3m,5m', 'V4 PHL timeframes');
        assert(phlCfgs.every(c => c.pivotStrength === 8), 'Default V4 PHL pivotStrength must be 8');

        const expectThrow = (fn: () => unknown, label: string) => {
            let threw = false;
            try { fn(); } catch { threw = true; }
            assert(threw, `${label}: expected rejection`);
        };
        expectThrow(() => createDefaultV4DTFXStrictCBCMultiConfigs('SOLUSDT', '1m', dt, ['1m', '15m' as any]), 'DTFX 15m');
        expectThrow(() => createDefaultV4DTFXStrictCBCMultiConfigs('SOLUSDT', '1m', dt, ['3m', '3m']), 'DTFX duplicate');
        expectThrow(() => createDefaultV4DTFXStrictCBCMultiConfigs('SOLUSDT', '1m', dt, []), 'DTFX empty');
        expectThrow(() => createDefaultV4DTFXStrictCBCMultiConfigs('SOLUSDT', '5m', dt, ['1m']), 'DTFX base mismatch');

        expectThrow(() => createDefaultPHLV4MultiConfigs('SOLUSDT', '1m', dt, ['1m', '15m' as any]), 'PHL 15m');
        expectThrow(() => createDefaultPHLV4MultiConfigs('SOLUSDT', '1m', dt, ['5m', '5m']), 'PHL duplicate');
        expectThrow(() => createDefaultPHLV4MultiConfigs('SOLUSDT', '1m', dt, []), 'PHL empty');
        expectThrow(() => createDefaultPHLV4MultiConfigs('SOLUSDT', '1m', dt, ['7m' as any]), 'PHL invalid 7m');
        expectThrow(() => createDefaultPHLV4Config('SOLUSDT', '5m', 300_000, '1m'), 'PHL HTF < base interval');
        expectThrow(() => createDefaultPHLV4Config('SOLUSDT', '5m', 60_000, '3m'), 'PHL baseTf vs ms mismatch');
        expectThrow(() => stepPHLV4Multi(stream[0], 0, createInitialPHLV4MultiState(), [phlCfgs[0], phlCfgs[0]], false, null), 'stepPHLV4Multi duplicate config');
        const btcCfg3m = createDefaultPHLV4Config('BTCUSDT', '1m', dt, '3m');
        expectThrow(() => stepPHLV4Multi(stream[0], 0, createInitialPHLV4MultiState(), [phlCfgs[0], btcCfg3m], false, null), 'stepPHLV4Multi mixed-symbol configs');
        const base5mCfg = createDefaultPHLV4Config('SOLUSDT', '5m', 300_000, '5m');
        expectThrow(() => stepPHLV4Multi(stream[0], 0, createInitialPHLV4MultiState(), [phlCfgs[0], base5mCfg], false, null), 'stepPHLV4Multi mixed-base-timeframe configs');
        expectThrow(() => stepPHLV4Multi(stream[0], 0, createInitialPHLV4MultiState(), [], false, null), 'stepPHLV4Multi empty configs');
        assert(phlCfgs[0].baseIntervalMs === 60_000 && phlCfgs[1].baseIntervalMs === 60_000, 'Base interval precondition');
        const badIntervalCfg = { ...phlCfgs[1], baseIntervalMs: 120_000 };
        expectThrow(() => stepPHLV4Multi(stream[0], 0, createInitialPHLV4MultiState(), [phlCfgs[0], badIntervalCfg], false, null), 'stepPHLV4Multi mismatched baseIntervalMs');
    });

    runTest('2. Complete native 1m parity against original stepPHL (pivotStrength=8)', () => {
        const cfgV4 = createDefaultPHLV4Config('SOLUSDT', '1m', dt, '1m');
        const cfgOrig = { ...createDefaultPHLConfig('SOLUSDT', '1m', dt), pivotStrength: 8 };
        let sV4 = createInitialPHLV4State();
        let sOrig = createInitialPHLState();
        let atrState: ReturnType<typeof updateWilderATR>['nextState'] | undefined;
        let prevClose: number | null = null;
        const evV4: any[] = [];
        const evOrig: any[] = [];

        for (let i = 0; i < stream.length; i++) {
            const c = stream[i];
            const atrRes = updateWilderATR(c.high, c.low, prevClose, 14, atrState, false);
            atrState = atrRes.nextState;
            prevClose = c.close;
            const atrVal = atrRes.isValid && atrRes.atrValue > 0 ? atrRes.atrValue : null;

            const r4 = stepPHLV4(c, i, sV4, cfgV4, false, atrVal);
            const rO = stepPHL(c, i, sOrig, cfgOrig, false, atrVal, null);
            sV4 = r4.nextState;
            sOrig = rO.nextState;
            evV4.push(...r4.events);
            evOrig.push(...rO.events);
        }
        assert(evV4.length > 0 && evV4.length === evOrig.length, `1m PHL count mismatch: ${evV4.length} vs ${evOrig.length}`);
        for (let k = 0; k < evV4.length; k++) {
            const a = evV4[k];
            const b = evOrig[k];
            const expProt = Boolean(b.structuralContext['hasProtectedLevel']) ? Number(b.structuralContext['protectedLevelPrice']) : null;
            assert(
                a.eventType === b.eventType &&
                a.eventDirection === b.eventDirection &&
                a.sourceBarIndex === b.sourceBarIndex &&
                a.sourceTimestamp === b.sourceTimestamp &&
                a.confirmationBarIndex === b.confirmationBarIndex &&
                a.confirmationTimestamp === b.confirmationTimestamp &&
                a.structuralContext.breakType === b.structuralContext['breakType'] &&
                a.structuralContext.brokenLevelPrice === b.structuralContext['brokenLevelPrice'] &&
                a.structuralContext.hasProtectedLevel === b.structuralContext['hasProtectedLevel'] &&
                a.structuralContext.protectedLevelPrice === expProt &&
                a.structuralContext.pbFromLowValid === b.structuralContext['pbFromLowValid'] &&
                a.structuralContext.pbFromHighValid === b.structuralContext['pbFromHighValid'],
                `1m PHL full-context parity mismatch at event ${k}`
            );
        }
    });

    runTest('3. Exhaustive prefix-invariance (continuous + gapped), HTF bucket closes, and HTF ATR warmup', () => {
        // 3a. Continuous prefix invariance + strict bucket close + HTF ATR (warms on 14th HTF bar, NOT 14th 1m bar!)
        const sub = stream.slice(0, 300);
        for (const tf of ['1m', '3m', '5m'] as const) {
            const cfg = createDefaultPHLV4Config('SOLUSDT', '1m', dt, tf);
            const tfMs = PHL_TIMEFRAME_MS[tf];
            const runPrefix = (arr: readonly ML1Candle[]) => {
                let s = createInitialPHLV4State();
                const evs: any[] = [];
                for (let i = 0; i < arr.length; i++) {
                    const r = stepPHLV4(arr[i], i, s, cfg, false, 1.5); // Pass dummy 1m atr to prove 3m/5m ignore it!
                    s = r.nextState;
                    evs.push(...r.events);
                    if (tf !== '1m') {
                        if (s.htfBarIndex < 14 && s.htfBarIndex > 0) assert(s.htfAtrState!.isSeeded === false, `${tf} HTF ATR must stay unseeded before 14th HTF candle`);
                        if (s.htfBarIndex === 14) assert(s.htfAtrState!.isSeeded === true, `${tf} HTF ATR seeds strictly on 14th HTF candle`);
                        if (s.htfBarIndex >= 14 && (i + 1) % (tfMs / dt) === 0) {
                            // Independent brute-force HTF Wilder ATR(14) over completed buckets
                            const barsPerB = tfMs / dt;
                            const numB = (i + 1) / barsPerB;
                            const trs: number[] = [];
                            let prevHtfC: number | null = null;
                            for (let b = 0; b < numB; b++) {
                                const slice = arr.slice(b * barsPerB, (b + 1) * barsPerB);
                                const bh = Math.max(...slice.map(x => x.high));
                                const bl = Math.min(...slice.map(x => x.low));
                                const bc = slice[slice.length - 1].close;
                                trs.push(prevHtfC === null ? bh - bl : Math.max(bh - bl, Math.abs(bh - prevHtfC), Math.abs(bl - prevHtfC)));
                                prevHtfC = bc;
                            }
                            let refAtr = trs.slice(0, 14).reduce((a, b) => a + b, 0) / 14;
                            for (let b = 14; b < trs.length; b++) refAtr = refAtr + (trs[b] - refAtr) / 14;
                            assert(Math.abs(s.htfAtrState!.atr! - refAtr) < 1e-10, `${tf} HTF Wilder ATR numerical mismatch at HTF bar ${numB}`);
                        }
                    }
                }
                return evs;
            };
            const full = runPrefix(sub);
            assert(full.length > 0, `Expected PHL events for ${tf}`);

            for (const ev of full) {
                assert((ev.confirmationTimestamp + dt) % tfMs === 0, `${tf} PHL confirmed before HTF close`);
                assert(ev.sourceBarIndex < ev.confirmationBarIndex && ev.sourceTimestamp < ev.confirmationTimestamp, `${tf} source < confirm`);
                if (ev.structuralContext.hasProtectedLevel) {
                    assert(ev.structuralContext.protectedLevelBarIndex < ev.confirmationBarIndex, `${tf} prot < confirm`);
                }
            }
            for (let k = 1; k <= sub.length; k++) {
                const pref = runPrefix(sub.slice(0, k));
                const exp = full.filter(e => e.confirmationBarIndex < k);
                assert(JSON.stringify(pref) === JSON.stringify(exp), `${tf} continuous prefix lookahead at k=${k}`);
            }

            // 3b. Prefix invariance across an explicit discontinuity at bar 150
            const gappedRun = (arr: readonly ML1Candle[]) => {
                let s = createInitialPHLV4State();
                const evs: any[] = [];
                for (let i = 0; i < arr.length; i++) {
                    const r = stepPHLV4(arr[i], i, s, cfg, i === 150, null);
                    s = r.nextState;
                    evs.push(...r.events);
                }
                return evs;
            };
            const fullDisc = gappedRun(sub);
            for (let k = 140; k <= 200; k++) {
                const pref = gappedRun(sub.slice(0, k));
                const exp = fullDisc.filter(e => e.confirmationBarIndex < k);
                assert(JSON.stringify(pref) === JSON.stringify(exp), `${tf} discontinuity prefix lookahead at k=${k}`);
            }

            // 3c. Reset-aware numerical HTF ATR parity (3m & 5m) after explicit discontinuity at bar 150
            if (tf !== '1m') {
                const barsPerB = tfMs / dt;
                let sReset = createInitialPHLV4State();
                const postResetBuckets: ML1Candle[] = [];
                let curB = null as ML1Candle | null;
                let countInB = 0;

                // Discontinuity at bar 151 (mid-bucket for both 3m [02:30,02:33) and 5m [02:30,02:35)) proves partial bucket is discarded and ATR restarts cleanly at first aligned post-reset bucket
                for (let i = 0; i < 300; i++) {
                    const isDisc = i === 151;
                    const r = stepPHLV4(sub[i], i, sReset, cfg, isDisc, null);
                    sReset = r.nextState;

                    if (isDisc) {
                        assert(sReset.htfAtrState === null && sReset.prevHtfClose === null && sReset.formingBucket === null && sReset.htfBarIndex === 0,
                            `${tf} mid-bucket discontinuity @151 must discard forming bucket and reset HTF ATR state`);
                        curB = null;
                        countInB = 0;
                    } else if (i > 151) {
                        const c = sub[i];
                        const bStart = Math.floor(c.time / tfMs) * tfMs;
                        if (curB === null) {
                            if (c.time === bStart) { curB = { ...c }; countInB = 1; }
                        } else {
                            curB = { ...curB, high: Math.max(curB.high, c.high), low: Math.min(curB.low, c.low), close: c.close, volume: curB.volume + c.volume };
                            countInB++;
                        }
                        if (curB !== null && countInB === barsPerB && c.time === bStart + tfMs - dt) {
                            postResetBuckets.push(curB);
                            if (postResetBuckets.length === 1) {
                                assert(curB.time === Math.ceil((sub[151].time + 1) / tfMs) * tfMs,
                                    `${tf} first complete post-reset bucket must align to next HTF boundary`);
                            }
                            curB = null;
                            countInB = 0;
                            if (postResetBuckets.length >= 14) {
                                assert(sReset.htfAtrState !== null && sReset.htfAtrState.isSeeded &&
                                    sReset.htfAtrState.atr !== null && Number.isFinite(sReset.htfAtrState.atr),
                                    `${tf} post-reset htfAtrState must be valid & seeded`);
                                const trs: number[] = [];
                                for (let b = 0; b < postResetBuckets.length; b++) {
                                    const kb = postResetBuckets[b];
                                    trs.push(b === 0 ? kb.high - kb.low : Math.max(kb.high - kb.low, Math.abs(kb.high - postResetBuckets[b - 1].close), Math.abs(kb.low - postResetBuckets[b - 1].close)));
                                }
                                let refResetAtr = trs.slice(0, 14).reduce((a, b) => a + b, 0) / 14;
                                for (let b = 14; b < trs.length; b++) refResetAtr = refResetAtr + (trs[b] - refResetAtr) / 14;
                                assert(Math.abs(sReset.htfAtrState.atr - refResetAtr) < 1e-10,
                                    `${tf} post-reset HTF Wilder ATR mismatch at post-reset HTF bar ${postResetBuckets.length}`);
                            }
                        }
                    }
                }
                assert(postResetBuckets.length >= 15, 'Expected >= 15 post-reset HTF buckets for ATR parity');
            }
        }
    });

    runTest('4. State resets (boundary, mid-bucket, pre-close gaps + explicit isDiscontinuity), corrupt state rejection & discriminators', () => {
        for (const tf of ['1m', '3m', '5m'] as const) {
            const cfg = createDefaultPHLV4Config('SOLUSDT', '1m', dt, tf);

            // 4a. Opening partial bucket rejected (starts at 00:02)
            const midStart = makeWaveStream(120, t0 + 2 * dt, dt);
            let sMid = createInitialPHLV4State();
            for (let i = 0; i < midStart.length; i++) {
                const r = stepPHLV4(midStart[i], i, sMid, cfg, false, null);
                sMid = r.nextState;
                if (tf !== '1m' && i === 0) assert(sMid.formingBucket === null, `${tf} partial opening bar must leave formingBucket=null`);
                if (tf !== '1m') {
                    for (const ev of r.events) assert(ev.sourceTimestamp >= t0 + 3 * dt, `${tf} leaked opening bucket`);
                }
            }

            // 4b. Gap at bucket boundary (drop index 300 = 05:00), mid-bucket (301 = 05:01), and pre-close (302/304)
            for (const dropIdx of [300, 301, tf === '3m' ? 302 : 304]) {
                const gapped = stream.filter((_, idx) => idx !== dropIdx);
                let sGap = createInitialPHLV4State();
                const postEvs: any[] = [];
                for (let i = 0; i < gapped.length; i++) {
                    const r = stepPHLV4(gapped[i], i, sGap, cfg, false, null);
                    sGap = r.nextState;
                    if (i === dropIdx) {
                        assert(sGap.phlState.window.length <= 1 && sGap.phlState.ph === null && sGap.phlState.pl === null &&
                            sGap.htfAtrState === null && sGap.prevHtfClose === null,
                            `${tf} gap at ${dropIdx} must reset PHL window, protected levels, and HTF ATR`);
                    }
                    if (i >= dropIdx) postEvs.push(...r.events);
                }
                assert(postEvs.length > 0 && postEvs.every(e => e.sourceBarIndex >= dropIdx && e.confirmationBarIndex >= dropIdx),
                    `${tf} post-gap (drop=${dropIdx}) must recover and emit only post-reset events`);
            }

            // 4c. Explicit isDiscontinuity=true with contiguous timestamps
            let sExpDisc = createInitialPHLV4State();
            const postDiscEvs: any[] = [];
            for (let i = 0; i < stream.length; i++) {
                const isDisc = i === 300;
                const r = stepPHLV4(stream[i], i, sExpDisc, cfg, isDisc, null);
                sExpDisc = r.nextState;
                if (isDisc) {
                    assert(r.events.length === 0 && sExpDisc.phlState.ph === null && sExpDisc.phlState.pl === null &&
                        sExpDisc.htfAtrState === null && sExpDisc.prevHtfClose === null,
                        `${tf} explicit isDiscontinuity must reset PHL & HTF ATR`);
                }
                if (i > 300) postDiscEvs.push(...r.events);
            }
            assert(postDiscEvs.length > 0 && postDiscEvs.every(e => e.sourceBarIndex >= 300),
                `${tf} explicit discontinuity must emit post-reset events only`);
        }

        // 4d. PHLV4State corruption validation + JSON checkpoint round-trip
        const cfg5 = createDefaultPHLV4Config('SOLUSDT', '1m', dt, '5m');
        let st = createInitialPHLV4State();
        const fullEvs: any[] = [];
        let cp242 = '';
        let cpWithLastHigh = '';
        let cpWithLastLow = '';
        for (let i = 0; i < 600; i++) {
            const r = stepPHLV4(stream[i], i, st, cfg5, false, null);
            st = r.nextState;
            fullEvs.push(...r.events);
            if (i === 242) cp242 = JSON.stringify(st); // Mid-5m forming bucket (242 = 04:02)
            if (cpWithLastHigh === '' && st.phlState.lastHighIdx !== null) cpWithLastHigh = JSON.stringify(st);
            if (cpWithLastLow === '' && st.phlState.lastLowIdx !== null) cpWithLastLow = JSON.stringify(st);
        }
        const restored = JSON.parse(cp242);
        validatePHLV4State(restored, cfg5);
        let stRest = restored;
        const restEvs: any[] = [];
        for (let i = 243; i < 600; i++) {
            const r = stepPHLV4(stream[i], i, stRest, cfg5, false, null);
            stRest = r.nextState;
            restEvs.push(...r.events);
        }
        assert(JSON.stringify(restEvs) === JSON.stringify(fullEvs.filter(e => e.confirmationBarIndex >= 243)),
            'PHLV4 JSON checkpoint replay & discriminator stability failed');

        const expectStateErr = (badState: any, label: string) => {
            let threw = false;
            try { validatePHLV4State(badState, cfg5); } catch (e: any) {
                threw = e instanceof Error && e.message.includes('PHL V4 State Error');
            }
            assert(threw, `${label}: expected PHL V4 State Error`);
        };
        expectStateErr({ ...restored, stateVersion: 99 }, 'bad stateVersion');
        expectStateErr({ ...restored, htfBarIndex: 999 }, 'htfBarIndex mismatch');
        expectStateErr({ ...restored, htfAtrState: { ...restored.htfAtrState, count: 1 } }, 'corrupt htfAtrState count');
        expectStateErr({ ...restored, prevHtfClose: 99999 }, 'prevHtfClose mismatch');
        expectStateErr({ ...restored, htfBarAnchors: {} }, 'missing active htfBarAnchors');

        assert(cpWithLastHigh !== '' && cpWithLastLow !== '', 'Stream must populate both lastHighIdx and lastLowIdx');
        const stH = JSON.parse(cpWithLastHigh);
        const withoutLastHigh = { ...stH.htfBarAnchors };
        delete withoutLastHigh[String(stH.phlState.lastHighIdx)];
        expectStateErr({ ...stH, htfBarAnchors: withoutLastHigh }, 'missing lastHighIdx anchor');

        const stL = JSON.parse(cpWithLastLow);
        const withoutLastLow = { ...stL.htfBarAnchors };
        delete withoutLastLow[String(stL.phlState.lastLowIdx)];
        expectStateErr({ ...stL, htfBarAnchors: withoutLastLow }, 'missing lastLowIdx anchor');
        expectStateErr({ ...restored, formingBucket: { ...restored.formingBucket, barCount: 99 } }, 'bad formingBucket barCount');
        expectStateErr({ ...restored, formingBucket: { ...restored.formingBucket, high: 1, low: 500 } }, 'bad formingBucket OHLC');

        // 4e. Cross-symbol & multi-TF discriminator uniqueness
        const btcStream = makeWaveStream(400, t0, dt);
        const solCfgs = createDefaultPHLV4MultiConfigs('SOLUSDT', '1m', dt);
        const btcCfgs = createDefaultPHLV4MultiConfigs('BTCUSDT', '1m', dt);
        let msSol = createInitialPHLV4MultiState();
        let msBtc = createInitialPHLV4MultiState();
        const solDiscs = new Set<string>();
        const btcDiscs = new Set<string>();
        for (let i = 0; i < 400; i++) {
            const rs = stepPHLV4Multi(stream[i], i, msSol, solCfgs, false, null);
            const rb = stepPHLV4Multi(btcStream[i], i, msBtc, btcCfgs, false, null);
            msSol = rs.nextState;
            msBtc = rb.nextState;
            rs.events.forEach(e => { assert(!solDiscs.has(e.eventDiscriminator), 'SOL dup disc'); solDiscs.add(e.eventDiscriminator); });
            rb.events.forEach(e => { assert(!btcDiscs.has(e.eventDiscriminator), 'BTC dup disc'); assert(!solDiscs.has(e.eventDiscriminator), 'Cross-symbol disc collision'); btcDiscs.add(e.eventDiscriminator); });
        }
        assert(solDiscs.size > 0 && btcDiscs.size > 0, 'Expected cross-symbol discriminators');
    });

    runTest('5. Full normalized chart-vs-teacher parity (1m/3m/5m, continuous + gapped), customTf validation & Registry', () => {
        const indDefault = new ProtectedHighsLowsIndicator();
        assert(indDefault.getParam<number>('pivotStrength', -1) === 8, 'Chart PHL default pivotStrength must be 8');
        assert(!indDefault.getTimeframeOptions('1m').includes('15m'), 'Chart PHL must exclude 15m option');

        // Incompatible / invalid customTfMins safely falls back to chartTfMs (never processes partial buckets)
        indDefault.updateParams({ timeframe: 'Custom HTF', customTfMins: 7 });
        assert(indDefault.getEffectiveTfMs(180_000) === 180_000, 'Non-multiple 7m over 3m must fall back to chartTfMs');
        indDefault.updateParams({ timeframe: 'Custom HTF', customTfMins: Number.NaN });
        assert(indDefault.getEffectiveTfMs(60_000) === 60_000, 'NaN customTfMins must fall back to chartTfMs');
        indDefault.updateParams({ timeframe: 'Custom HTF', customTfMins: -5 });
        assert(indDefault.getEffectiveTfMs(60_000) === 60_000, 'Negative customTfMins must fall back to chartTfMs');

        const ds = new DataStore(stream.length);
        ds.setAll(stream.map(c => [c.time, c.open, c.high, c.low, c.close, c.volume]));

        for (const tf of ['1m', '3m', '5m'] as const) {
            const ind = new ProtectedHighsLowsIndicator();
            ind.currentSymbol = 'SOLUSDT';
            ind.updateParams({ timeframe: tf === '1m' ? 'Current' : tf });
            ind.calculate(ds);

            const cfg = createDefaultPHLV4Config('SOLUSDT', '1m', dt, tf);
            let s = createInitialPHLV4State();
            let atr1mState: ReturnType<typeof updateWilderATR>['nextState'] | undefined;
            let prev1mClose: number | null = null;
            const teacherEvs: any[] = [];
            for (let i = 0; i < stream.length; i++) {
                const c = stream[i];
                const atrRes = updateWilderATR(c.high, c.low, prev1mClose, 14, atr1mState, false);
                atr1mState = atrRes.nextState;
                prev1mClose = c.close;
                const atrVal = atrRes.isValid && atrRes.atrValue > 0 ? atrRes.atrValue : null;

                const r = stepPHLV4(c, i, s, cfg, false, atrVal);
                s = r.nextState;
                teacherEvs.push(...r.events);
            }

            assert(ind.cachedEvents.length === teacherEvs.length && teacherEvs.length > 0,
                `${tf} chart vs teacher count mismatch: ${ind.cachedEvents.length} vs ${teacherEvs.length}`);
            for (let k = 0; k < teacherEvs.length; k++) {
                assert(
                    JSON.stringify(normalizePHLEvent(ind.cachedEvents[k])) === JSON.stringify(normalizePHLEvent(teacherEvs[k])),
                    `${tf} normalized chart-vs-teacher parity mismatch at event ${k}`
                );
            }
        }

        // Multi-case chart-vs-teacher reset parity (boundary drop 400, mid-bucket drop 402, incomplete-bucket drop 404)
        for (const [label, dropIdx] of [['boundary', 400], ['mid-bucket', 402], ['pre-close-incomplete', 404]] as const) {
            const gappedStream = stream.filter((_, i) => i !== dropIdx);
            const gapDs = new DataStore(gappedStream.length);
            gapDs.setAll(gappedStream.map(c => [c.time, c.open, c.high, c.low, c.close, c.volume]));
            const indGap = new ProtectedHighsLowsIndicator();
            indGap.currentSymbol = 'SOLUSDT';
            indGap.updateParams({ timeframe: '5m' });
            indGap.calculate(gapDs);

            const cfg5 = createDefaultPHLV4Config('SOLUSDT', '1m', dt, '5m');
            let sGap = createInitialPHLV4State();
            const tGapEvs: any[] = [];
            for (let i = 0; i < gappedStream.length; i++) {
                const r = stepPHLV4(gappedStream[i], i, sGap, cfg5, false, null);
                sGap = r.nextState;
                tGapEvs.push(...r.events);
            }
            assert(indGap.cachedEvents.length === tGapEvs.length && tGapEvs.length > 0, `${label} 5m chart-vs-teacher count`);
            for (let k = 0; k < tGapEvs.length; k++) {
                assert(
                    JSON.stringify(normalizePHLEvent(indGap.cachedEvents[k])) === JSON.stringify(normalizePHLEvent(tGapEvs[k])),
                    `${label} 5m chart-vs-teacher mismatch at event ${k}`
                );
            }
        }

        // Corrupt-bucket recovery parity: run identical corrupt stream (corrupt OHLCV @451 inside 5m [07:30, 07:35)) through BOTH Chart & Teacher
        const corruptCandles = stream.map((c, idx) => (idx === 451 ? { ...c, high: c.low - 1 } : c));
        let tailP = corruptCandles[corruptCandles.length - 1].close;
        let tailTs = corruptCandles[corruptCandles.length - 1].time + dt;
        for (let j = 0; j < 120; j++) {
            const open = tailP;
            const close = open + 0.4;
            corruptCandles.push({ time: tailTs, open, high: close + 0.5, low: open - 0.5, close, volume: 120, isSynthetic: false });
            tailP = close;
            tailTs += dt;
        }
        const corruptDs = new DataStore(corruptCandles.length);
        corruptDs.setAll(corruptCandles.map(c => [c.time, c.open, c.high, c.low, c.close, c.volume]));
        const indCorrupt = new ProtectedHighsLowsIndicator();
        indCorrupt.currentSymbol = 'SOLUSDT';
        indCorrupt.updateParams({ timeframe: '5m' });
        indCorrupt.calculate(corruptDs);

        // Teacher processes accepted valid candles (skipping corrupt bar 451 upstream)
        const cfg5Corrupt = createDefaultPHLV4Config('SOLUSDT', '1m', dt, '5m');
        let sCorrupt = createInitialPHLV4State();
        const tCorruptEvs: any[] = [];
        let acceptIdx = 0;
        for (let i = 0; i < corruptCandles.length; i++) {
            if (i === 451) continue;
            const r = stepPHLV4(corruptCandles[i], acceptIdx, sCorrupt, cfg5Corrupt, false, null);
            sCorrupt = r.nextState;
            tCorruptEvs.push(...r.events);
            if (i === 452) {
                assert(sCorrupt.formingBucket === null && sCorrupt.htfBarIndex === 0 &&
                    sCorrupt.phlState.ph === null && sCorrupt.phlState.pl === null && sCorrupt.htfAtrState === null,
                    'Teacher must discard corrupt bucket and clear all pre-corruption PHL/ATR state at bar 452');
            }
            if (i === 455) {
                assert(sCorrupt.formingBucket !== null && sCorrupt.formingBucket.bucketStart === t0 + 455 * dt &&
                    sCorrupt.formingBucket.barCount === 1,
                    'First clean 5m bucket [07:35, 07:40) must start at bar 455');
            }
            if (i === 459) {
                assert(sCorrupt.formingBucket === null && sCorrupt.htfBarIndex === 1,
                    'First clean post-corruption 5m bucket must complete at bar 459');
            }
            acceptIdx++;
        }

        for (const seg of indCorrupt.targetSegments) {
            assert(!(seg.startBar < 451 && seg.endBar >= 451), 'Corrupt candle @451 must close pre-gap active target');
        }
        assert(!indCorrupt.cachedEvents.some(e => e.confirmationBarIndex >= 450 && e.confirmationBarIndex <= 454),
            'Corrupt bucket [450..454] must emit zero events');
        const chartPre = indCorrupt.cachedEvents.filter(e => e.confirmationBarIndex < 450).map(normalizePHLEvent);
        const teacherPre = tCorruptEvs.filter(e => e.confirmationBarIndex < 450).map(normalizePHLEvent);
        assert(chartPre.length > 0 && JSON.stringify(chartPre) === JSON.stringify(teacherPre),
            'Pre-corruption chart vs teacher normalized parity');

        const chartPost = indCorrupt.cachedEvents.filter(e => e.confirmationBarIndex >= 455).map(e => ({
            ...normalizePHLEvent(e),
            sourceBarIndex: e.sourceBarIndex - 1, // Account for skipped bar 451 in teacher accepted index
            confirmationBarIndex: e.confirmationBarIndex - 1,
            protectedLevelBarIndex: e.structuralContext['protectedLevelBarIndex'] !== null
                ? Number(e.structuralContext['protectedLevelBarIndex']) - 1
                : null
        }));
        const teacherPost = tCorruptEvs.filter(e => e.confirmationBarIndex >= 454).map(normalizePHLEvent);
        assert(chartPost.length > 0 && JSON.stringify(chartPost) === JSON.stringify(teacherPost),
            'Post-corruption chart vs teacher recovery parity');

        // Deterministic same-candle multi-event order, per-event context, pivot dedup, and target reset policy check
        const multiCached: any[] = [];
        const multiPivots: any[] = [];
        const multiTargets: any[] = [];
        const ev1: any = {
            eventId: 'E1', eventDiscriminator: 'D1', strategyId: 'PHL_BOS_MSS', strategyVersion: 'PHL_BOS_MSS_v1',
            eventType: 'PHL_MSS_BULL', eventDirection: 'bull', sourceBarIndex: 10, sourceTimestamp: t0 + 10 * dt,
            confirmationBarIndex: 50, confirmationTimestamp: t0 + 50 * dt, confirmationLagBars: 40,
            observationBarIndex: 50, observationTimestamp: t0 + 51 * dt, entryBarIndex: 51, entryTimestamp: null,
            structuralContext: { breakType: 'MSS', brokenLevelPrice: 110, hasProtectedLevel: true, protectedLevelPrice: 95, distToProtectedAtr: 2.0, pbFromLowValid: true, pbFromHighValid: true }
        };
        const ev2: any = {
            eventId: 'E2', eventDiscriminator: 'D2', strategyId: 'PHL_BOS_MSS', strategyVersion: 'PHL_BOS_MSS_v1',
            eventType: 'PHL_MSS_BEAR', eventDirection: 'bear', sourceBarIndex: 12, sourceTimestamp: t0 + 12 * dt,
            confirmationBarIndex: 50, confirmationTimestamp: t0 + 50 * dt, confirmationLagBars: 38,
            observationBarIndex: 50, observationTimestamp: t0 + 51 * dt, entryBarIndex: 51, entryTimestamp: null,
            structuralContext: { breakType: 'MSS', brokenLevelPrice: 98, hasProtectedLevel: true, protectedLevelPrice: 115, distToProtectedAtr: 1.5, pbFromLowValid: true, pbFromHighValid: true }
        };
        const multiRes = ProtectedHighsLowsIndicator.applyBarEvents({
            events: [ev1, ev2],
            activeProtectedLow: { barIndex: 48, price: 95, time: t0 + 48 * dt },
            activeProtectedHigh: { barIndex: 49, price: 115, time: t0 + 49 * dt },
            confirmationBar: 50, closePrice: 100, atrVal: 2.0, stepAtr: 2.0,
            targetReset: 'MSS & BOS', targetStepMult: 2.0,
            cachedEvents: multiCached, confirmedPivots: multiPivots, targetSegments: multiTargets,
            activeTarget: { startBar: 30, price: 120, entryPrice: 105, stepNum: 1, dir: 1 },
            curTrailPrice: 100, curTrailDir: 1
        });
        assert(multiCached.length === 2 && multiCached[0].eventType === 'PHL_MSS_BULL' && multiCached[1].eventType === 'PHL_MSS_BEAR',
            'Multi-event order preserved');
        assert(multiCached[0].structuralContext.protectedLevelPrice === 95 &&
            multiCached[0].structuralContext.distToProtectedAtr === 2.5 &&
            multiCached[1].structuralContext.protectedLevelPrice === 115 &&
            multiCached[1].structuralContext.distToProtectedAtr === 7.5,
            'Each event retained its own protectedLevelPrice & confirmation-bar distToProtectedAtr');
        assert(multiPivots.length === 2 && multiTargets.length === 2, 'Expected 2 pivots & 2 closed target segments');
        assert(
            multiTargets[0].startBar === 30 && multiTargets[0].endBar === 50 && multiTargets[0].dir === 1 &&
            multiTargets[0].price === 120 && multiTargets[0].entryPrice === 105 && multiTargets[0].hit === false,
            'First closed segment must close original active target at confirmation bar 50'
        );
        assert(
            multiTargets[1].startBar === 50 && multiTargets[1].endBar === 50 && multiTargets[1].dir === 1 &&
            multiTargets[1].entryPrice === 110 && multiTargets[1].price === 114 && multiTargets[1].hit === false,
            'Second closed segment must close ev1 target at confirmation bar 50'
        );
        assert(
            multiRes.activeTarget?.startBar === 50 && multiRes.activeTarget?.dir === -1 &&
            multiRes.activeTarget?.entryPrice === 98 && multiRes.activeTarget?.price === 94,
            'Final active target must reflect ev2'
        );

        // Duplicate pivot suppression: two events referencing same protected pivot on same confirmation bar -> 1 pivot marker
        const dupCached: any[] = [];
        const dupPivots: any[] = [];
        const dupTargets: any[] = [];
        const ev1b: any = { ...ev1, eventId: 'E1B', eventDiscriminator: 'D1B' };
        ProtectedHighsLowsIndicator.applyBarEvents({
            events: [ev1, ev1b],
            activeProtectedLow: { barIndex: 48, price: 95, time: t0 + 48 * dt },
            activeProtectedHigh: null,
            confirmationBar: 50, closePrice: 100, atrVal: 2.0, stepAtr: 2.0,
            targetReset: 'MSS & BOS', targetStepMult: 2.0,
            cachedEvents: dupCached, confirmedPivots: dupPivots, targetSegments: dupTargets,
            activeTarget: null, curTrailPrice: 0, curTrailDir: 0
        });
        assert(dupCached.length === 2 && dupPivots.length === 1, 'Duplicate pivot marker must be suppressed');

        // Atomicity on malformed second event: throws without leaving partial side effects from event 1
        const atomCached: any[] = [];
        const atomPivots: any[] = [];
        const atomTargets: any[] = [];
        const badEv2: any = { ...ev2, structuralContext: { ...ev2.structuralContext, protectedLevelPrice: Number.NaN } };
        let atomThrew = false;
        try {
            ProtectedHighsLowsIndicator.applyBarEvents({
                events: [ev1, badEv2],
                activeProtectedLow: { barIndex: 48, price: 95, time: t0 + 48 * dt },
                activeProtectedHigh: { barIndex: 49, price: 115, time: t0 + 49 * dt },
                confirmationBar: 50, closePrice: 100, atrVal: 2.0, stepAtr: 2.0,
                targetReset: 'MSS & BOS', targetStepMult: 2.0,
                cachedEvents: atomCached, confirmedPivots: atomPivots, targetSegments: atomTargets,
                activeTarget: null, curTrailPrice: 0, curTrailDir: 0
            });
        } catch { atomThrew = true; }
        assert(atomThrew && atomCached.length === 0 && atomPivots.length === 0 && atomTargets.length === 0,
            'applyBarEvents must reject atomically with zero partial mutations');

        // IndicatorRegistry: legacy DTFX_ZONES ignored; DTFX_STRICTCBC_ZONES & PHL_BOS_MSS round-trip
        assert(IndicatorRegistry.deserialize({ type: 'DTFX_ZONES', visible: true, params: {} }) === null,
            'Legacy DTFX_ZONES must deserialize to null');

        const strictInd = new DTFXStrictCBCIndicator();
        strictInd.updateParams({ timeframe: '5m' });
        const restoredStrict = IndicatorRegistry.deserialize(IndicatorRegistry.serialize(strictInd));
        assert(restoredStrict instanceof DTFXStrictCBCIndicator && restoredStrict.getParam('timeframe') === '5m',
            'DTFX_STRICTCBC_ZONES round-trip');

        const phl5m = new ProtectedHighsLowsIndicator();
        phl5m.updateParams({ timeframe: '5m', pivotStrength: 8 });
        const restoredPhl = IndicatorRegistry.deserialize(IndicatorRegistry.serialize(phl5m));
        assert(restoredPhl instanceof ProtectedHighsLowsIndicator &&
            restoredPhl.getParam('timeframe') === '5m' &&
            restoredPhl.getParam('pivotStrength') === 8,
            'HTF PHL_BOS_MSS round-trip');
    });

    console.log(`\nPhase 3 (V4 Teachers & Plugins) Acceptance: ${passed} passed, ${failed} failed.\n`);
    return failed === 0;
}
