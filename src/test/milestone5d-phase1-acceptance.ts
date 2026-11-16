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

        // Invalid OHLC structural input guard
        const badOhlc = updateExhaustionCCI(90, 110, 100, 20, res19.nextState, false);
        assert(!badOhlc.isValid && badOhlc.cciValue === 0 && badOhlc.nextState.unbrokenRun === 0, 'Invalid OHLC must invalidate cleanly');

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

        // Phase B: Trigger an exact bearish signal (2 consecutive qualifiedSell bars), then test 6-bar cooldown
        let sellBar = -1;
        for (let i = 28; i < 85; i++) {
            const p = 127 - (i - 27) * 2.5;
            const out = stepVolatilityAdjustedMean(p + 2, p - 2, p - 1, vam, false);
            vam = out.nextState;
            if (out.signal === -1) {
                sellBar = i;
                assert(out.trend === -1 && out.sellStreak >= 2, 'Sell signal must flip trend to -1 on streak >= 2');
                break;
            }
        }
        assert(sellBar > 27, 'Expected deterministic VAM sell signal');

        // Phase C: Immediately rally hard within <= 6 bars; verify cooldown blocks buySignal until bar > sellBar + 6
        let buyBar = -1;
        for (let i = sellBar + 1; i <= sellBar + 20; i++) {
            const p = (127 - (sellBar - 27) * 2.5) + (i - sellBar) * 4.0;
            const out = stepVolatilityAdjustedMean(p + 2, p - 2, p + 1, vam, false);
            vam = out.nextState;
            if (i <= sellBar + 6) {
                assert(out.signal === 0, `Cooldown failed: signal fired too early at delta=${i - sellBar}`);
            }
            if (out.signal === 1) {
                buyBar = i;
                assert(i - sellBar > 6 && out.trend === 1, 'Buy signal must occur only after > 6 cooldown bars');
                break;
            }
        }
        assert(buyBar > sellBar + 6, 'Expected VAM buy signal after cooldown expiry');
    });

    // 4. Config V5 Validation & Restored State Guard Tests
    runTest('4. CONFIG_C validation (1m-only VCS) & V5 restored-state integrity checks', () => {
        let threw15m = false;
        try {
            validateML1ConfigV5({ ...ML1_CONFIG_C, timeframe: '15m', expectedIntervalMs: 900_000, gapDiscontinuityThresholdMs: 4_500_000 });
        } catch (e: any) {
            threw15m = String(e.message).includes("'1m' only");
        }
        assert(threw15m, 'validateML1ConfigV5 must reject VolumeCandleSize on 15m');

        const validState = stepML1FeaturesV5(makeCandle(t0, 100, 102, 98, 101, 100), 0, createInitialML1FeatureStateV5(ML1_CONFIG_C), ML1_CONFIG_C).nextState;

        // Non-finite VAM adaptive must fail closed
        let threwBadVam = false;
        try {
            stepML1FeaturesV5(makeCandle(t0 + 60_000, 100, 102, 98, 101, 100), 1, {
                ...validState,
                vamState: { ...validState.vamState!, adaptive: Infinity }
            }, ML1_CONFIG_C);
        } catch (e: any) {
            threwBadVam = String(e.message).includes('adaptive must be finite');
        }
        assert(threwBadVam, 'validateRestoredV5State must reject non-finite VAM adaptive');

        // Config fingerprint mismatch must fail closed
        let threwFingerprint = false;
        try {
            stepML1FeaturesV5(makeCandle(t0 + 60_000, 100, 102, 98, 101, 100), 1, {
                ...validState,
                configFingerprint: 'MISMATCHED_CONFIG'
            }, ML1_CONFIG_C);
        } catch (e: any) {
            threwFingerprint = String(e.message).includes('configFingerprint');
        }
        assert(threwFingerprint, 'validateRestoredV5State must reject mismatched configFingerprint');
    });

    // 5. 750-Bar Serialization & Restoration with Discontinuities, Rejections & VAM Cooldown
    runTest('5. V5 serialization & restoration across discontinuities, rejections & 360-bar boundary', () => {
        const stream: ML1Candle[] = [];
        let ts = t0;
        for (let i = 0; i < 750; i++) {
            let p = 100 + Math.sin(i / 10) * 15;
            if (i >= 245 && i <= 310) p = 120 - (i - 245) * 1.5; // Reversal crossing checkpoint bar 260
            if (i === 150 || i === 700) ts += 600_000;            // Discontinuities before & after restore
            if (i === 180) {
                stream.push(makeCandle(ts, p, p + 1, p - 1, NaN, 100)); // Invalid OHLCV
            } else if (i === 370) {
                stream.push(makeCandle(ts - 60_000, p, p + 1, p - 1, p, 100)); // Duplicate timestamp
            } else if (i === 410) {
                stream.push(makeCandle(ts - 180_000, p, p + 1, p - 1, p, 100)); // Out-of-order
            } else {
                stream.push(makeCandle(ts, p - 0.2, p + 1.0, p - 1.0, p + 0.2, 100 + (i % 7) * 30));
            }
            ts += 60_000;
        }

        let fullState = createInitialML1FeatureStateV5(ML1_CONFIG_C);
        const fullObs: any[] = [];
        for (let i = 0; i < stream.length; i++) {
            const res = stepML1FeaturesV5(stream[i], i, fullState, ML1_CONFIG_C);
            fullState = res.nextState;
            fullObs.push(res.observation);
        }

        let splitState = createInitialML1FeatureStateV5(ML1_CONFIG_C);
        const splitObs: any[] = [];
        for (let i = 0; i <= 260; i++) {
            const res = stepML1FeaturesV5(stream[i], i, splitState, ML1_CONFIG_C);
            splitState = res.nextState;
            splitObs.push(res.observation);
        }

        let restored = JSON.parse(JSON.stringify(splitState));
        for (let i = 261; i < stream.length; i++) {
            const res = stepML1FeaturesV5(stream[i], i, restored, ML1_CONFIG_C);
            restored = res.nextState;
            splitObs.push(res.observation);
        }

        assert(JSON.stringify(fullObs) === JSON.stringify(splitObs), '750-bar V5 restored observations diverged');
        assert(JSON.stringify(fullState) === JSON.stringify(restored), '750-bar V5 restored state diverged');
        assert(fullObs[700].features['IsDiscontinuity'] === 1 && !fullObs[700].validity['VolumeCandleSize_Ratio_360'], 'Post-restore discontinuity did not reset VCS 360');
    });

    // 6. V4 Rejected-Row Identity & A/B Pinned Baseline Parity Proof
    runTest('6. V4 rejected-row identity & pre-change CONFIG_A / CONFIG_B baseline parity', () => {
        const s0 = createInitialML1FeatureState();
        const r0 = stepML1Features(makeCandle(t0, 100, 105, 95, 102, 100), 0, s0, ML1_CONFIG_B);
        const rDup = stepML1Features(makeCandle(t0, 100, 105, 95, 102, 100), 1, r0.nextState, ML1_CONFIG_B);
        const rOoo = stepML1Features(makeCandle(t0 - 60_000, 100, 105, 95, 102, 100), 1, r0.nextState, ML1_CONFIG_B);
        const rNan = stepML1Features(makeCandle(t0 + 60_000, 100, 105, 95, NaN, 100), 1, r0.nextState, ML1_CONFIG_B);
        assert(rDup.nextState === r0.nextState && rOoo.nextState === r0.nextState && rNan.nextState === r0.nextState,
            'V4 engine failed exact reference-equality contract on rejected observations');

        // Pinned deterministic A/B check across 210 clean bars: open=100, high=105, low=95, close=102, vol=100
        let sA = createInitialML1FeatureState();
        let sB = createInitialML1FeatureState();
        let sC = createInitialML1FeatureStateV5(ML1_CONFIG_C);

        for (let i = 0; i < 210; i++) {
            const c = makeCandle(t0 + i * 60_000, 100, 105, 95, 102, 100);
            const resA = stepML1Features(c, i, sA, ML1_CONFIG_A);
            const resB = stepML1Features(c, i, sB, ML1_CONFIG_B);
            const resC = stepML1FeaturesV5(c, i, sC, ML1_CONFIG_C);
            sA = resA.nextState;
            sB = resB.nextState;
            sC = resC.nextState;

            if (i === 50) assert(resA.observation.features['IsWarmupComplete'] === 1, 'CONFIG_A warmup pinned to bar 50');
            if (i === 198) assert(resB.observation.features['IsWarmupComplete'] === 0, 'CONFIG_B must still be warming at bar 198');
            if (i === 199) {
                assert(resB.observation.features['IsWarmupComplete'] === 1, 'CONFIG_B warmup pinned to bar 199');
                assert(Math.abs(resB.observation.features['ATR_14'] - 10.0) < 1e-9, 'Pinned ATR_14=10.0');
                assert(Math.abs(resB.observation.features['EMA_9_Distance'] - 0.0) < 1e-9, 'Pinned EMA_9_Distance=0.0');
                assert(Object.keys(resA.observation.features).filter(k => k.startsWith('EMA_')).length === 0, 'CONFIG_A EMA keys must be 0');
                assert(Object.keys(resB.observation.features).filter(k => k.startsWith('EMA_')).length === 27, 'CONFIG_B EMA keys must be 27');
            }
            for (const key of Object.keys(resB.observation.features)) {
                assert(resB.observation.features[key] === resC.observation.features[key] &&
                    resB.observation.validity[key] === resC.observation.validity[key], `V4/V5 mismatch on ${key}`);
            }
        }
    });

    console.log(`\nPhase 5D Phase 1 Acceptance: ${passed} passed, ${failed} failed.`);
    return failed === 0;
}
