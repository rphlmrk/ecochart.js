import { ML1_CONFIG_A, ML1_CONFIG_B, ML1_CONFIG_C } from '../indicators/mlr1/ML1FeatureConfigs';
import {
    createInitialML1FeatureState,
    createInitialML1FeatureStateV5,
    stepML1Features,
    stepML1FeaturesV5,
    validateML1ConfigV5
} from '../indicators/mlr1/ML1FeatureEngine';
import { updateExhaustionCCI } from '../indicators/mlr1/momentum/Exhaustion';
import { updateVolumeCandleSize } from '../indicators/mlr1/volume/VolumeCandleSize';
import { createInitialVAMState, stepVolatilityAdjustedMean } from '../indicators/mlr1/trend/VolatilityAdjustedMean';
import type { ML1Candle } from '../indicators/mlr1/ML1FeatureTypes';
import { IncrementalSha256 } from '../data/StreamingDatasetExporter';

function assert(condition: boolean, msg: string): asserts condition {
    if (!condition) throw new Error(`[Phase5DPhase1Failed] ${msg}`);
}

function makeCandle(time: number, open: number, high: number, low: number, close: number, volume = 100): ML1Candle {
    return { time, open, high, low, close, volume, isSynthetic: false };
}

export function runPhase5DPhase1Tests(): boolean {
    console.log('\n======================================================');
    console.log('🧪 Starting Phase 5D Phase 1 Remediated Acceptance Suite');
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

    const t0 = 1_700_000_000_000;

    // 1. Exhaustion CCI(20): parity, zero-MAD, invalid OHLC guard, and discontinuity reset
    runTest('1. Exhaustion CCI(20): warmup bar 19, zero-MAD, invalid OHLC, discontinuity reset', () => {
        let state: ReturnType<typeof updateExhaustionCCI>['nextState'] | undefined;
        for (let i = 0; i < 19; i++) {
            const res = updateExhaustionCCI(105 + i, 95 + i, 100 + i, 20, state, false);
            assert(!res.isValid && res.cciValue === 0, `Bar ${i} must be invalid before bar 19`);
            state = res.nextState;
        }
        const res19 = updateExhaustionCCI(124, 114, 119, 20, state, false);
        assert(res19.isValid && Math.abs(res19.cciValue - 126.6666666667) < 1e-6, 'CCI parity mismatch at bar 19');

        // Zero-MAD flat market
        let flatState: typeof state;
        for (let i = 0; i < 20; i++) {
            const flat = updateExhaustionCCI(100, 100, 100, 20, flatState, false);
            flatState = flat.nextState;
            if (i === 19) assert(!flat.isValid && flat.cciValue === 0, 'Zero MAD must return 0 and valid=false');
        }

        // Invalid OHLC structural input guards (high < low, high < close, low > close)
        const badRange = updateExhaustionCCI(90, 110, 100, 20, res19.nextState, false);
        const badHighClose = updateExhaustionCCI(105, 95, 108, 20, res19.nextState, false);
        const badLowClose = updateExhaustionCCI(105, 95, 92, 20, res19.nextState, false);
        assert(!badRange.isValid && badRange.nextState.unbrokenRun === 0, 'high < low must invalidate');
        assert(!badHighClose.isValid && badHighClose.nextState.unbrokenRun === 0, 'high < close must invalidate');
        assert(!badLowClose.isValid && badLowClose.nextState.unbrokenRun === 0, 'low > close must invalidate');

        // +/-300 clamping guard on extreme outlier after flat-ish series
        let clampState: typeof state;
        for (let i = 0; i < 19; i++) {
            clampState = updateExhaustionCCI(101 + (i % 2) * 0.01, 99, 100, 20, clampState, false).nextState;
        }
        const highOutlier = updateExhaustionCCI(500, 100, 500, 20, clampState, false);
        assert(highOutlier.isValid && highOutlier.cciValue === 300, `Expected +300 clamp, got ${highOutlier.cciValue}`);

        // Discontinuity reset
        const disc = updateExhaustionCCI(130, 120, 125, 20, res19.nextState, true);
        assert(!disc.isValid && disc.nextState.unbrokenRun === 1, 'Discontinuity must reset CCI buffer');
    });

    // 2. VolumeCandleSize(360): prior-window [t-360..t-1], exact regime boundaries (1.0, 1.5, 2.0, >2.0)
    runTest('2. VolumeCandleSize(360): prior-window bar 360 & exact regime boundaries', () => {
        let state: ReturnType<typeof updateVolumeCandleSize>['nextState'] | undefined;
        for (let i = 0; i < 360; i++) {
            const vol = i % 2 === 0 ? 100 : 200; // mean vol = 150, pop std = 50
            const res = updateVolumeCandleSize(105, 95, vol, 360, state, false);
            assert(!res.isRatioValid && !res.isZScoreValid && !res.isRegimeValid, `Bar ${i} must be invalid`);
            state = res.nextState;
        }

        // Exact boundary checks from the same 360-bar baseline (without advancing state)
        const r1 = updateVolumeCandleSize(105, 95, 150, 360, state, false); // ratio === 1.0
        assert(r1.isRatioValid && Math.abs(r1.ratio - 1.0) < 1e-9 && r1.regime === 0, 'Ratio 1.0 must be regime 0');

        const r15 = updateVolumeCandleSize(105, 95, 225, 360, state, false); // ratio === 1.5
        assert(r15.isRatioValid && Math.abs(r15.ratio - 1.5) < 1e-9 && r15.regime === 1, 'Ratio 1.5 must be regime 1');

        const r20 = updateVolumeCandleSize(105, 95, 300, 360, state, false); // ratio === 2.0
        assert(r20.isRatioValid && Math.abs(r20.ratio - 2.0) < 1e-9 && r20.regime === 1, 'Ratio exactly 2.0 must produce regime 1');

        const r25 = updateVolumeCandleSize(105, 95, 375, 360, state, false); // ratio === 2.5 (> 2.0)
        assert(r25.isRatioValid && Math.abs(r25.ratio - 2.5) < 1e-9 && r25.regime === 2, 'Ratio > 2.0 must produce regime 2');
        assert(r25.isZScoreValid && Math.abs(r25.zScore - 4.5) < 1e-6, 'Z-score parity failed');

        // Zero-variance & non-positive hl2 guards
        let flatState: typeof state;
        for (let i = 0; i < 360; i++) {
            flatState = updateVolumeCandleSize(105, 95, 100, 360, flatState, false).nextState;
        }
        const flatCheck = updateVolumeCandleSize(105, 95, 100, 360, flatState, false);
        assert(flatCheck.isRatioValid && !flatCheck.isZScoreValid && flatCheck.zScore === 0, 'Zero std must invalidate ZScore');

        const badHl2 = updateVolumeCandleSize(0, 0, 100, 360, state, false);
        assert(!badHl2.isRatioValid && !badHl2.isZScoreValid && badHl2.nextState.unbrokenRun === 0, 'hl2 <= 0 must invalidate');

        const discVcs = updateVolumeCandleSize(105, 95, 200, 360, state, true);
        assert(!discVcs.isRatioValid && !discVcs.isZScoreValid && discVcs.nextState.unbrokenRun === 1,
            'Discontinuity must reset VCS 360 baseline');
    });

    // 3. Closed-Form Pine Parity Reference Fixture for VolatilityAdjustedMean
    runTest('3. VolatilityAdjustedMean: exact bar 4/7/13/14/18/27 values, signals & 6-bar cooldown', () => {
        let vam = createInitialVAMState();
        const slowSC = 2.0 / 31.0;
        let expectedAdaptive = 100.0;
        const adaptiveTrace: number[] = [];

        // Phase A (bars 0..27): open=99+i, high=102+i, low=98+i, close=100+i -> hlc3 = 100+i, TR = 4.0
        for (let i = 0; i <= 27; i++) {
            const h = 102 + i;
            const l = 98 + i;
            const c = 100 + i;
            const out = stepVolatilityAdjustedMean(h, l, c, vam, false);
            vam = out.nextState;

            if (i === 0) {
                expectedAdaptive = 100.0;
            } else {
                const eff = i >= 18 ? 1.0 : 0.0;
                const sc = Math.pow(eff * (0.4 - slowSC) + slowSC, 2);
                expectedAdaptive = expectedAdaptive + sc * ((100 + i) - expectedAdaptive);
            }
            adaptiveTrace.push(expectedAdaptive);
            assert(Math.abs((vam.adaptive ?? 0) - expectedAdaptive) < 1e-10, `Adaptive mismatch at bar ${i}`);

            if (i < 4) assert(vam.center === null, `Center must be null before bar 4 (bar ${i})`);
            if (i === 4) {
                const expectedCenter4 = adaptiveTrace.reduce((a, b) => a + b, 0) / 5;
                assert(vam.center !== null && Math.abs(vam.center - expectedCenter4) < 1e-10, 'Bar 4 center EMA seed mismatch');
            }
            if (i < 7) assert(!out.isTrendValid && out.trend === 0, `Trend must stay 0 before bar 7 (bar ${i})`);
            if (i === 7) assert(out.isTrendValid && out.trend === 1, 'Bar 7 trend must initialize to +1');
            if (i === 13) assert(out.isCenterDistValid && Math.abs((vam.atrState.atr ?? 0) - 4.0) < 1e-10, 'Bar 13 ATR must equal 4.0');
            if (i === 14) {
                assert(out.isRsiValid && Math.abs(out.rsi14 - 100.0) < 1e-9, 'Bar 14 RSI must equal 100');
                assert(out.isDiSpreadValid && Math.abs(out.diSpread14 - 25.0) < 1e-9, 'Bar 14 DI spread must equal +25');
            }
            if (i < 18) assert(!out.isEfficiencyValid, `Efficiency must be invalid at bar ${i}`);
            if (i === 18) assert(out.isEfficiencyValid && Math.abs(out.efficiency - 1.0) < 1e-9, 'Bar 18 efficiency must equal 1.0');
            if (i < 27) assert(!out.isAdxValid, `ADX must be invalid at bar ${i}`);
            if (i === 27) assert(out.isAdxValid && Math.abs(out.adx14 - 100.0) < 1e-9, 'Bar 27 ADX must equal 100');
        }

        // Phase B: Exact pinned bearish reversal at bar 38
        const post27State = vam;
        let sellBar = -1;
        for (let i = 28; i < 85; i++) {
            const p = 127 - (i - 27) * 2.5;
            const out = stepVolatilityAdjustedMean(p + 2, p - 2, p - 1, vam, false);
            vam = out.nextState;
            if (out.signal === -1) {
                sellBar = i;
                assert(sellBar === 38, `Expected sellBar === 38, got ${sellBar}`);
                assert(vam.lastSignalAcceptedIndex === 38, 'Expected lastSignalAcceptedIndex === 38');
                assert(out.trend === -1 && out.sellStreak === 2, 'Sell signal must flip trend to -1 on streak 2');
                break;
            }
        }
        assert(sellBar === 38, 'Expected deterministic VAM sell signal at bar 38');

        // Phase C1: Existing fixture buy reversal pinned at bar 49
        let vamC1 = vam;
        let buyBar = -1;
        for (let i = 39; i <= 58; i++) {
            const p = 99.5 + (i - 38) * 4.0;
            const out = stepVolatilityAdjustedMean(p + 2, p - 2, p + 1, vamC1, false);
            vamC1 = out.nextState;
            if (out.signal === 1) {
                buyBar = i;
                assert(buyBar === 49 && vamC1.lastSignalAcceptedIndex === 49, `Expected buyBar=49, got ${buyBar}`);
                assert(out.trend === 1 && out.buyStreak === 2, 'Buy signal must flip trend to +1');
                break;
            }
        }
        assert(buyBar === 49, 'Expected buy signal at bar 49');

        // Phase C2: Isolated Cooldown Boundary Proof (delta = 6 rejected while ALL buy conditions hold, delta = 7 accepted)
        // Jump sharply at bar 39 (+45.5) then steady +2/bar climb so slope3Atr >= 0.12, RSI > 52, +DI > -DI, ADX >= 20, buyStreak >= 2 by delta = 6
        let vamCool = vam;
        for (let i = 39; i <= 45; i++) {
            const delta = i - 38;
            const p = 145 + (delta - 1) * 2.0;
            const out = stepVolatilityAdjustedMean(p + 1, p - 1, p + 0.5, vamCool, false);
            vamCool = out.nextState;

            if (delta === 6) {
                // Verify ALL buy conditions except cooldown are strictly satisfied at delta = 6
                assert(out.trend === -1, 'Pre-signal trend must remain -1 at delta = 6');
                assert(out.buyStreak >= 2, `buyStreak must be >= 2 at delta = 6 (got ${out.buyStreak})`);
                assert(out.adx14 >= 20 && out.diSpread14 > 0 && out.rsi14 > 52 && out.slope3Atr >= 0.12 && out.centerDistAtr > 0.5,
                    'All buy filters must hold at delta = 6 to isolate cooldown');
                assert(out.signal === 0, 'Cooldown must reject buySignal at delta = 6');
                assert(vamCool.lastSignalAcceptedIndex === 38, 'lastSignalAcceptedIndex must remain 38 at delta = 6');
            }
            if (delta === 7) {
                assert(out.signal === 1, 'Buy signal must fire immediately at delta = 7 (> 6)');
                assert(out.trend === 1 && vamCool.lastSignalAcceptedIndex === 45, 'Trend and lastSignalAcceptedIndex must update at bar 45');
            }
        }
        // Keep post27State referenced to verify no unused warning
        assert(post27State.unbrokenRun === 28, 'Post-27 run must be 28');
    });

    // 4. Config V5 Validation & Restored State Guard Tests
    runTest('4. CONFIG_C validation (1m-only VCS) & complete V5 + embedded V4 restored-state checks', () => {
        let threw15m = false;
        try {
            validateML1ConfigV5({ ...ML1_CONFIG_C, timeframe: '15m', expectedIntervalMs: 900_000, gapDiscontinuityThresholdMs: 4_500_000 });
        } catch (e: any) {
            threw15m = String(e.message).includes("'1m' only");
        }
        assert(threw15m, 'validateML1ConfigV5 must reject VolumeCandleSize on 15m');

        let s = createInitialML1FeatureStateV5(ML1_CONFIG_C);
        for (let i = 0; i < 30; i++) {
            s = stepML1FeaturesV5(makeCandle(t0 + i * 60_000, 100 + i, 102 + i, 98 + i, 101 + i, 100), i, s, ML1_CONFIG_C).nextState;
        }
        const nextCandle = makeCandle(t0 + 30 * 60_000, 130, 132, 128, 131, 100);

        const expectIntegrityError = (badState: any, substr: string, label: string) => {
            let matched = false;
            try {
                stepML1FeaturesV5(nextCandle, 30, badState, ML1_CONFIG_C);
            } catch (e: any) {
                matched = e instanceof Error && e.message.includes('State Integrity Error') && e.message.includes(substr);
            }
            assert(matched, `${label}: expected State Integrity Error containing '${substr}'`);
        };

        // V5 VAM checks
        expectIntegrityError({ ...s, vamState: { ...s.vamState!, adaptive: Infinity } }, 'adaptive must be finite', 'adaptive=Infinity');
        expectIntegrityError({ ...s, configFingerprint: 'MISMATCHED_CONFIG' }, 'configFingerprint', 'configFingerprint');
        expectIntegrityError({ ...s, vamState: { ...s.vamState!, centerSeedCount: 2, center: null, centerHistory: null as any } }, 'Invalid centerHistory', 'centerHistory=null (must not TypeError)');
        expectIntegrityError({ ...s, vamState: { ...s.vamState!, centerHistory: [1, 2, 3, 4, 5] } }, 'Invalid centerHistory', 'oversized centerHistory');
        expectIntegrityError({ ...s, vamState: { ...s.vamState!, adx: 101 } }, '[0, 100]', 'adx=101');
        expectIntegrityError({ ...s, vamState: { ...s.vamState!, dmiCount: s.vamState!.dmiCount + 1 } }, 'Corrupted DMI count', 'inconsistent dmiCount');
        expectIntegrityError({ ...s, vamState: { ...s.vamState!, buyStreak: 1, sellStreak: 1 } }, 'mutually exclusive streaks', 'simultaneous streaks');

        // Embedded V4 baseState checks
        expectIntegrityError({ ...s, baseState: { ...s.baseState, stateVersion: 3 as any } }, 'Incompatible state version', 'baseState.stateVersion=3');
        expectIntegrityError({ ...s, baseState: { ...s.baseState, lastBarIndex: 5, lastClose: null } }, 'Partial state detected', 'baseState partial state');
        expectIntegrityError({ ...s, baseState: { ...s.baseState, atrState: { ...s.baseState.atrState, 14: { count: 14, seedMean: 1, atr: -5, isSeeded: true } } } }, 'Inconsistent seeded ATR', 'baseState negative atr');
    });

    // 5. 750-Bar Serialization & Restoration with Active Cooldown at 260, Rejections, VCS(360) @ 513 & Post-Restore Reset
    runTest('5. V5 serialization & restoration: active cooldown @ 260, rejections, VCS(360) @ 513 & bar 700 reset', () => {
        const stream: ML1Candle[] = [];
        let ts = t0;
        for (let i = 0; i < 750; i++) {
            let p = 100 + Math.sin(i / 10) * 15;
            // Drive an uptrend (200..251) then sharp reversal at 252..260 so sellSignal fires right before bar 260
            if (i >= 200 && i <= 251) p = 100 + (i - 200) * 1.2;
            if (i >= 252 && i <= 260) p = 161.2 - (i - 251) * 4.5;
            // Immediate post-restore jump (261..270) to exercise active cooldown across checkpoint 260
            if (i >= 261 && i <= 270) p = 165 + (i - 261) * 2.0;

            if (i === 150 || i === 700) ts += 600_000; // Discontinuities before & after restore
            if (i === 180) {
                stream.push(makeCandle(ts, p, p + 1, p - 1, NaN, 100));
            } else if (i === 370) {
                stream.push(makeCandle(ts - 60_000, p, p + 1, p - 1, p, 100));
            } else if (i === 410) {
                stream.push(makeCandle(ts - 180_000, p, p + 1, p - 1, p, 100));
            } else {
                stream.push(makeCandle(ts, p - 0.2, p + 1.0, p - 1.0, p + 0.2, 100 + (i % 7) * 30));
            }
            ts += 60_000;
        }

        let fullState = createInitialML1FeatureStateV5(ML1_CONFIG_C);
        const fullObs: any[] = [];
        let stateAt700: typeof fullState | null = null;

        for (let i = 0; i < stream.length; i++) {
            const prev = fullState;
            const res = stepML1FeaturesV5(stream[i], i, prev, ML1_CONFIG_C);
            if (i === 180 || i === 370 || i === 410) {
                assert(res.nextState === prev, `Rejected bar ${i} must preserve exact V5 state reference`);
                assert(res.observation.features['Exhaustion_20'] === 0 && res.observation.validity['Exhaustion_20'] === false, `Rejected bar ${i} Exhaustion fallback`);
                assert(res.observation.features['VolumeCandleSize_Ratio_360'] === 0 && res.observation.validity['VolumeCandleSize_Ratio_360'] === false, `Rejected bar ${i} VCS fallback`);
                assert(res.observation.features['VAM_Signal'] === 0 && res.observation.validity['VAM_Signal'] === false, `Rejected bar ${i} VAM_Signal fallback`);
            }
            fullState = res.nextState;
            fullObs.push(res.observation);
            if (i === 700) stateAt700 = res.nextState;
        }

        let splitState = createInitialML1FeatureStateV5(ML1_CONFIG_C);
        const splitObs: any[] = [];
        for (let i = 0; i <= 260; i++) {
            const res = stepML1FeaturesV5(stream[i], i, splitState, ML1_CONFIG_C);
            splitState = res.nextState;
            splitObs.push(res.observation);
        }

        // Assert active VAM cooldown is captured right at checkpoint bar 260
        const acceptedIdx260 = splitState.vamState!.unbrokenRun - 1;
        assert(
            splitState.vamState!.lastSignalAcceptedIndex !== null &&
            acceptedIdx260 - splitState.vamState!.lastSignalAcceptedIndex <= 6,
            `Expected active VAM cooldown at bar 260 (delta=${acceptedIdx260 - (splitState.vamState!.lastSignalAcceptedIndex ?? -999)})`
        );
        const checkpointSigIdx = splitState.vamState!.lastSignalAcceptedIndex;

        let restored = JSON.parse(JSON.stringify(splitState));
        for (let i = 261; i < stream.length; i++) {
            const prevRestored = restored;
            const res = stepML1FeaturesV5(stream[i], i, prevRestored, ML1_CONFIG_C);
            if (i === 370 || i === 410) {
                assert(res.nextState === prevRestored, `Post-restore rejected bar ${i} must preserve exact V5 state reference`);
            }
            restored = res.nextState;
            splitObs.push(res.observation);

            // While delta <= 6 post-restore, cooldown must stay active and block VAM_Signal
            const curAcceptedIdx = restored.vamState!.unbrokenRun - 1;
            if (i <= 264 && curAcceptedIdx - checkpointSigIdx <= 6) {
                assert(res.observation.features['VAM_Signal'] === 0, `Cooldown failed immediately after restore at bar ${i}`);
            }
        }

        assert(JSON.stringify(fullObs) === JSON.stringify(splitObs), '750-bar V5 restored observations diverged');
        assert(JSON.stringify(fullState) === JSON.stringify(restored), '750-bar V5 restored state diverged');

        // Exact post-restore VCS(360) activation boundary (invalid @ 512, valid @ 513)
        assert(splitObs[512].validity['VolumeCandleSize_Ratio_360'] === false, 'VCS(360) must be invalid at bar 512');
        assert(splitObs[513].validity['VolumeCandleSize_Ratio_360'] === true, 'VCS(360) must become valid at bar 513');

        // Full post-restore discontinuity reset at bar 700
        assert(splitObs[700].features['IsDiscontinuity'] === 1, 'Bar 700 must flag discontinuity');
        assert(!splitObs[700].validity['VolumeCandleSize_Ratio_360'], 'Bar 700 VCS must reset');
        assert(!splitObs[700].validity['Exhaustion_20'], 'Bar 700 Exhaustion must reset');
        assert(!splitObs[700].validity['VAM_Trend'] && splitObs[700].features['VAM_Trend'] === 0, 'Bar 700 VAM_Trend must reset');
        assert(
            stateAt700 !== null &&
            stateAt700.vamState!.unbrokenRun === 1 &&
            stateAt700.vamState!.trend === 0 &&
            stateAt700.vamState!.lastSignalAcceptedIndex === null &&
            stateAt700.exhaustionState[20].unbrokenRun === 1 &&
            stateAt700.volumeCandleSizeState[360].unbrokenRun === 1,
            'All V5 module unbrokenRun/trend/cooldown states must reset cleanly on bar 700 discontinuity'
        );
    });

    // 6. V4 Rejected-Row Identity, Closed-Form Non-Flat V4 Reference Fixture & V4-vs-V5 Delegation Parity
    runTest('6. V4 rejected identity, non-flat analytical V4 fixture, hashes & V4-vs-V5 parity', () => {
        const s0 = createInitialML1FeatureState();
        const r0 = stepML1Features(makeCandle(t0, 100, 105, 95, 102, 100), 0, s0, ML1_CONFIG_B);
        const rDup = stepML1Features(makeCandle(t0, 100, 105, 95, 102, 100), 1, r0.nextState, ML1_CONFIG_B);
        const rOoo = stepML1Features(makeCandle(t0 - 60_000, 100, 105, 95, 102, 100), 1, r0.nextState, ML1_CONFIG_B);
        const rNan = stepML1Features(makeCandle(t0 + 60_000, 100, 105, 95, NaN, 100), 1, r0.nextState, ML1_CONFIG_B);
        assert(rDup.nextState === r0.nextState && rOoo.nextState === r0.nextState && rNan.nextState === r0.nextState,
            'V4 engine failed exact reference-equality contract on rejected observations');

        // Independent non-flat alternating fixture (even: 100->104 vol 100; odd: 104->100 vol 200; constant TR=8)
        let sA = createInitialML1FeatureState();
        let sB = createInitialML1FeatureState();
        let sC = createInitialML1FeatureStateV5(ML1_CONFIG_C);

        const hashA = new IncrementalSha256();
        const hashB = new IncrementalSha256();
        const enc = new TextEncoder();

        for (let i = 0; i < 210; i++) {
            const isEven = i % 2 === 0;
            const c = isEven
                ? makeCandle(t0 + i * 60_000, 100, 106, 98, 104, 100)
                : makeCandle(t0 + i * 60_000, 104, 108, 100, 100, 200);

            const resA = stepML1Features(c, i, sA, ML1_CONFIG_A);
            const resB = stepML1Features(c, i, sB, ML1_CONFIG_B);
            const resC = stepML1FeaturesV5(c, i, sC, ML1_CONFIG_C);
            sA = resA.nextState;
            sB = resB.nextState;
            sC = resC.nextState;

            hashA.update(enc.encode(JSON.stringify(resA.observation)));
            hashB.update(enc.encode(JSON.stringify(resB.observation)));

            if (i === 50) assert(resA.observation.features['IsWarmupComplete'] === 1, 'CONFIG_A warmup pinned to bar 50');
            if (i === 198) assert(resB.observation.features['IsWarmupComplete'] === 0, 'CONFIG_B warming at bar 198');
            if (i === 199) assert(resB.observation.features['IsWarmupComplete'] === 1, 'CONFIG_B warmup pinned to bar 199');

            if (i === 209) {
                const fA = resA.observation.features;
                const fB = resB.observation.features;
                const vB = resB.observation.validity;

                // Exact total key counts (A=93, B=120, C=134)
                assert(Object.keys(fA).length === 93, `Expected CONFIG_A 93 keys, got ${Object.keys(fA).length}`);
                assert(Object.keys(fB).length === 120, `Expected CONFIG_B 120 keys, got ${Object.keys(fB).length}`);
                assert(Object.keys(resC.observation.features).length === 134, `Expected CONFIG_C 134 keys`);

                // Analytical non-flat expectations at bar 209 (odd bar: close=100, vol=200, TR=8, priorMean=150, priorStd=50)
                assert(Math.abs(fB['CandleRange'] - 8.0) < 1e-12, 'CandleRange=8.0');
                assert(Math.abs(fB['ATR_14'] - 8.0) < 1e-12 && vB['ATR_14'], 'ATR_14=8.0');
                assert(Math.abs(fB['VolumeZScore_20'] - 1.0) < 1e-9 && vB['VolumeZScore_20'], 'VolumeZScore_20=+1.0');
                assert(Math.abs(fB['RelativeVolume_20'] - (4 / 3)) < 1e-9 && vB['RelativeVolume_20'], 'RelativeVolume_20=4/3');
                assert(Math.abs(fB['Momentum_5'] - (-4.0)) < 1e-12 && vB['Momentum_5'], 'Momentum_5=-4.0');
                assert(Math.abs(fB['Return_5'] - (-4 / 104)) < 1e-12 && vB['Return_5'], 'Return_5=-4/104');
                assert(Math.abs(fB['DirectionalEfficiency_5'] - 0.2) < 1e-12 && vB['DirectionalEfficiency_5'], 'DE_5=0.2');
                assert(Math.abs(fB['EMA_9_Distance'] - (-2 / 9)) < 1e-9 && vB['EMA_9_Distance'], 'EMA_9_Distance=-2/9');
                assert(Math.abs(fB['EMA_9_Slope_3'] - (-1 / 54)) < 1e-9 && vB['EMA_9_Slope_3'], 'EMA_9_Slope_3=-1/54');

                // State transitions
                assert(sA.lastBarIndex === 209 && sA.lastClose === 100, 'sA state transitions');
                assert(sB.lastBarIndex === 209 && sB.lastClose === 100 && sB.emaState[9].isSeeded, 'sB state transitions');
            }

            // Current V4-vs-V5 delegation parity (kept distinct from analytical fixture above)
            for (const key of Object.keys(resB.observation.features)) {
                assert(resB.observation.features[key] === resC.observation.features[key] &&
                    resB.observation.validity[key] === resC.observation.validity[key], `V4/V5 delegation mismatch on ${key}`);
            }
        }

        const obsAHash = hashA.digestHex();
        const obsBHash = hashB.digestHex();
        console.log(`  📌 V4 Non-Flat 210-Bar SHA-256 (pin after pre-change check): obsA=${obsAHash}, obsB=${obsBHash}`);
    });

    console.log(`\nPhase 5D Phase 1 Acceptance: ${passed} passed, ${failed} failed.`);
    return failed === 0;
}
