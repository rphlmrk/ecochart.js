import { ML1_CONFIG_D, ML1_CONFIG_D_3M, ML1_CONFIG_D_5M } from '../indicators/mlr1/ML1FeatureConfigs';
import {
    createInitialML1FeatureStateV6,
    stepML1FeaturesV6
} from '../indicators/mlr1/ML1FeatureEngine';
import type { ML1Candle } from '../indicators/mlr1/ML1FeatureTypes';

function assert(condition: boolean, msg: string): asserts condition {
    if (!condition) throw new Error(`[Phase1V6Failed] ${msg}`);
}

function makeCandle(time: number, open: number, high: number, low: number, close: number, volume = 100): ML1Candle {
    return { time, open, high, low, close, volume, isSynthetic: false };
}

function refWilderAtr14(candles: readonly ML1Candle[], uptoIdx: number): number {
    const trs: number[] = [];
    for (let i = 0; i <= uptoIdx; i++) {
        const c = candles[i];
        if (i === 0) trs.push(c.high - c.low);
        else {
            const pc = candles[i - 1].close;
            trs.push(Math.max(c.high - c.low, Math.abs(c.high - pc), Math.abs(c.low - pc)));
        }
    }
    let atr = trs.slice(0, 14).reduce((a, b) => a + b, 0) / 14;
    for (let i = 14; i < trs.length; i++) atr = atr + (trs[i] - atr) / 14;
    return atr;
}

function refEmaSeries(values: readonly number[], period: number): number[] {
    const out: number[] = [];
    const alpha = 2 / (period + 1);
    let ema = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
    for (let i = 0; i < period - 1; i++) out.push(NaN);
    out.push(ema);
    for (let i = period; i < values.length; i++) {
        ema = ema * (1 - alpha) + values[i] * alpha;
        out.push(ema);
    }
    return out;
}

export function runPhase1V6AcceptanceTests(): boolean {
    console.log('\n======================================================');
    console.log('🧪 Starting Phase 1 (V6 / CONFIG_D) Acceptance Suite');
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
    const dt = 60_000;

    runTest('1. Warmup boundaries (SMA 20/50/100/200, SMA slope, MACD 25/33, BB 19, IsWarmupComplete 199) + independent parity', () => {
        const candles: ML1Candle[] = [];
        for (let i = 0; i < 210; i++) {
            const close = 100 + Math.sin(i / 5) * 4 + i * 0.1;
            candles.push(makeCandle(t0 + i * dt, close - 0.3, close + 1.2, close - 1.2, close, 100 + (i % 5) * 20));
        }

        let state = createInitialML1FeatureStateV6(ML1_CONFIG_D);
        const obsList: any[] = [];
        for (let i = 0; i < candles.length; i++) {
            const res = stepML1FeaturesV6(candles[i], i, state, ML1_CONFIG_D);
            state = res.nextState;
            obsList.push(res.observation);

            const v = res.observation.validity;
            assert(v['SMA_20_Distance'] === (i >= 19), `SMA_20 first valid at bar 19 (bar ${i})`);
            assert(v['SMA_20_Slope_3'] === (i >= 22), `SMA_20_Slope_3 first valid after 4 consecutive SMAs at bar 22 (bar ${i})`);
            assert(v['SMA_50_Distance'] === (i >= 49), `SMA_50 first valid at bar 49 (bar ${i})`);
            assert(v['SMA_100_Distance'] === (i >= 99), `SMA_100 first valid at bar 99 (bar ${i})`);
            assert(v['SMA_200_Distance'] === (i >= 199), `SMA_200 first valid at bar 199 (bar ${i})`);
            assert(v['MACD_Line_ATR'] === (i >= 25), `MACD line first valid at bar 25 (bar ${i})`);
            assert(v['MACD_Signal_ATR'] === (i >= 33), `MACD signal first valid at bar 33 (bar ${i})`);
            assert(v['MACD_Hist_ATR'] === (i >= 33), `MACD hist first valid at bar 33 (bar ${i})`);
            assert(v['BB_Width_20'] === (i >= 19), `BB_Width_20 first valid at bar 19 (bar ${i})`);
            assert(v['BB_PctB_20'] === (i >= 19), `BB_PctB_20 first valid at bar 19 (bar ${i})`);
            assert(v['Exhaustion_14'] === (i >= 13), `CCI(14) first valid at bar 13 (bar ${i})`);
            assert(v['Exhaustion_20'] === (i >= 19), `CCI(20) first valid at bar 19 (bar ${i})`);
            assert(res.observation.features['IsWarmupComplete'] === (i >= 199 ? 1 : 0), `IsWarmupComplete @ 199 (bar ${i})`);
        }

        // Independent brute-force numerical parity at bar 209
        const idx = 209;
        const closes = candles.map(c => c.close);
        const atr14 = refWilderAtr14(candles, idx);
        const sma20 = closes.slice(idx - 19, idx + 1).reduce((a, b) => a + b, 0) / 20;
        const sma20Past3 = closes.slice(idx - 22, idx - 2).reduce((a, b) => a + b, 0) / 20;
        const sma50 = closes.slice(idx - 49, idx + 1).reduce((a, b) => a + b, 0) / 50;
        const sma200 = closes.slice(idx - 199, idx + 1).reduce((a, b) => a + b, 0) / 200;

        const ema12 = refEmaSeries(closes, 12);
        const ema26 = refEmaSeries(closes, 26);
        const macdRaw = ema26.map((s, k) => (Number.isNaN(s) ? NaN : ema12[k] - s)).slice(25);
        const sigSeries = refEmaSeries(macdRaw, 9);
        const macdLine = macdRaw[macdRaw.length - 1];
        const sigLine = sigSeries[sigSeries.length - 1];

        const bbWin = closes.slice(idx - 19, idx + 1);
        const bbMean = bbWin.reduce((a, b) => a + b, 0) / 20;
        const bbStd = Math.sqrt(bbWin.reduce((a, x) => a + (x - bbMean) ** 2, 0) / 20);
        const bbWidthExp = (4 * bbStd) / bbMean;
        const bbPctBExp = (closes[idx] - (bbMean - 2 * bbStd)) / (4 * bbStd);

        const f209 = obsList[idx].features;
        assert(Object.keys(f209).length === 150, `Expected 150 1m features in ML1_CONFIG_D, got ${Object.keys(f209).length}`);
        assert(Math.abs(f209['SMA_20_Distance'] - (closes[idx] - sma20) / atr14) < 1e-9, 'SMA_20_Distance parity');
        assert(Math.abs(f209['SMA_20_Slope_3'] - (sma20 - sma20Past3) / (3 * atr14)) < 1e-9, 'SMA_20_Slope_3 parity');
        assert(f209['SMA_20_Above_SMA_50'] === (sma20 > sma50 ? 1 : -1), 'SMA_20_Above_SMA_50 parity');
        assert(f209['SMA_50_Above_SMA_200'] === (sma50 > sma200 ? 1 : -1), 'SMA_50_Above_SMA_200 parity');
        assert(Math.abs(f209['MACD_Line_ATR'] - macdLine / atr14) < 1e-9, 'MACD_Line_ATR parity');
        assert(Math.abs(f209['MACD_Signal_ATR'] - sigLine / atr14) < 1e-9, 'MACD_Signal_ATR parity');
        assert(Math.abs(f209['MACD_Hist_ATR'] - (macdLine - sigLine) / atr14) < 1e-9, 'MACD_Hist_ATR parity');
        assert(Math.abs(f209['BB_Width_20'] - bbWidthExp) < 1e-9, 'BB_Width_20 parity');
        assert(Math.abs(f209['BB_PctB_20'] - bbPctBExp) < 1e-9, 'BB_PctB_20 parity');
    });

    runTest('2. Flat market & zero ATR handling', () => {
        let state = createInitialML1FeatureStateV6(ML1_CONFIG_D);
        let lastObs: any;
        for (let i = 0; i < 40; i++) {
            const res = stepML1FeaturesV6(makeCandle(t0 + i * dt, 100, 100, 100, 100, 100), i, state, ML1_CONFIG_D);
            state = res.nextState;
            lastObs = res.observation;
        }
        assert(lastObs.validity['BB_Width_20'] === true && lastObs.features['BB_Width_20'] === 0, 'Flat BB width must be valid 0');
        assert(lastObs.validity['BB_PctB_20'] === false && lastObs.features['BB_PctB_20'] === 0, 'Flat BB %B must be invalid 0');
        assert(lastObs.validity['SMA_20_Distance'] === false && lastObs.features['SMA_20_Distance'] === 0, 'Zero ATR invalidates SMA distance');
        assert(lastObs.validity['SMA_20_Slope_3'] === false && lastObs.features['SMA_20_Slope_3'] === 0, 'Zero ATR invalidates SMA slope');
        assert(lastObs.validity['MACD_Line_ATR'] === false && lastObs.features['MACD_Line_ATR'] === 0, 'Zero ATR invalidates MACD_Line_ATR');
        assert(lastObs.validity['MACD_Signal_ATR'] === false && lastObs.features['MACD_Signal_ATR'] === 0, 'Zero ATR invalidates MACD_Signal_ATR');
    });

    runTest('3. Ordinary HasDataGap resets SMA and BollingerBands without pre-gap leakage', () => {
        let state = createInitialML1FeatureStateV6(ML1_CONFIG_D);
        for (let i = 0; i < 40; i++) {
            const c = 100 + i * 0.2;
            state = stepML1FeaturesV6(makeCandle(t0 + i * dt, c, c + 2, c - 2, c), i, state, ML1_CONFIG_D).nextState;
        }
        // Ordinary 2m gap (120_000ms < 300_000ms discontinuity threshold) at bar 40
        const gapTs = t0 + 41 * dt;
        const rGap = stepML1FeaturesV6(makeCandle(gapTs, 200, 202, 198, 200), 40, state, ML1_CONFIG_D);
        assert(rGap.observation.features['HasDataGap'] === 1 && rGap.observation.features['IsDiscontinuity'] === 0, 'Ordinary gap expected');
        assert(rGap.observation.validity['SMA_20_Distance'] === false && rGap.observation.validity['SMA_20_Slope_3'] === false, 'SMA must reset on gap');
        assert(rGap.observation.validity['BB_Width_20'] === false && rGap.observation.validity['BB_PctB_20'] === false, 'BB must reset on gap');
        assert(rGap.nextState.smaState[20].closeHistory.length === 1 && rGap.nextState.smaState[20].smaHistory.length === 0, 'SMA histories cleared');
        assert(rGap.nextState.bbState!.closeHistory.length === 1, 'BB history cleared');

        // Re-accumulate 19 more contiguous bars (post-gap bar 19 = global bar 59): pre-gap values (100) must not affect SMA/BB (200)
        let st2 = rGap.nextState;
        for (let k = 1; k <= 19; k++) {
            const res = stepML1FeaturesV6(makeCandle(gapTs + k * dt, 200, 202, 198, 200), 40 + k, st2, ML1_CONFIG_D);
            st2 = res.nextState;
            if (k < 19) {
                assert(res.observation.validity['SMA_20_Distance'] === false && res.observation.validity['BB_Width_20'] === false, 'Post-gap warmup');
            } else {
                assert(res.observation.validity['SMA_20_Distance'] === true && Math.abs(res.observation.features['SMA_20_Distance']) < 1e-12,
                    'Post-gap SMA_20 must equal 200 (zero pre-gap contamination)');
                assert(res.observation.validity['BB_Width_20'] === true && res.observation.features['BB_Width_20'] === 0,
                    'Post-gap BB_Width_20 must equal 0 (zero pre-gap contamination)');
            }
        }
    });

    runTest('4a. Ordinary gap during MACD signal accumulation: resets & recovers at 26th / 34th / 200th post-gap obs + checkpoint', () => {
        const stream: ML1Candle[] = [];
        let ts = t0;
        for (let i = 0; i < 235; i++) {
            if (i === 29) ts += dt; // Exact 2 * dt (120_000ms) delta = 2m ordinary gap (1 missing bar); no later discontinuity
            const c = 100 + Math.sin(i / 4) * 3 + i * 0.15;
            stream.push(makeCandle(ts, c - 0.2, c + 1, c - 1, c, 120));
            ts += dt;
        }

        let fullState = createInitialML1FeatureStateV6(ML1_CONFIG_D);
        const fullObs: any[] = [];
        let cp28 = '';

        for (let i = 0; i < stream.length; i++) {
            const res = stepML1FeaturesV6(stream[i], i, fullState, ML1_CONFIG_D);
            fullState = res.nextState;
            fullObs.push(res.observation);
            if (i === 28) cp28 = JSON.stringify(fullState);

            if (i >= 29) {
                const postGapObs = i - 28; // Bar 29 = 1st post-gap observation
                if (postGapObs === 1) {
                    assert(res.observation.features['HasDataGap'] === 1 && res.observation.features['IsDiscontinuity'] === 0, 'Ordinary gap @ 29');
                    assert(res.nextState.macdState!.signalEma === null, 'MACD signalEma resets on ordinary gap');
                }
                assert(res.observation.validity['MACD_Line_ATR'] === (postGapObs >= 26),
                    `Post-gap MACD line valid from 26th post-gap obs (obs=${postGapObs})`);
                assert(res.observation.validity['MACD_Signal_ATR'] === (postGapObs >= 34),
                    `Post-gap MACD signal valid from 34th post-gap obs (obs=${postGapObs})`);
                assert(res.observation.validity['MACD_Hist_ATR'] === (postGapObs >= 34),
                    `Post-gap MACD hist valid from 34th post-gap obs (obs=${postGapObs})`);
                assert(res.observation.features['IsWarmupComplete'] === (postGapObs >= 200 ? 1 : 0),
                    `IsWarmupComplete stays 0 until 200th post-gap obs (obs=${postGapObs})`);
            }
        }

        let restored = JSON.parse(cp28);
        for (let i = 29; i < stream.length; i++) {
            const res = stepML1FeaturesV6(stream[i], i, restored, ML1_CONFIG_D);
            restored = res.nextState;
            assert(JSON.stringify(res.observation) === JSON.stringify(fullObs[i]), `Restored ordinary-gap obs mismatch at bar ${i}`);
        }
        assert(JSON.stringify(restored) === JSON.stringify(fullState), 'Restored ordinary-gap final state mismatch');
    });

    runTest('4b. Major discontinuity after full warmup resets all MACD EMAs + full 200-bar warmup recovery', () => {
        const stream: ML1Candle[] = [];
        let ts = t0;
        for (let i = 0; i < 420; i++) {
            if (i === 210) ts += 9 * dt; // Exact 10 * dt (600_000ms) delta = 10m major discontinuity (9 missing bars)
            const c = 100 + Math.sin(i / 4) * 3 + i * 0.12;
            stream.push(makeCandle(ts, c - 0.2, c + 1, c - 1, c, 120));
            ts += dt;
        }

        let state = createInitialML1FeatureStateV6(ML1_CONFIG_D);
        for (let i = 0; i < stream.length; i++) {
            const res = stepML1FeaturesV6(stream[i], i, state, ML1_CONFIG_D);
            state = res.nextState;
            if (i === 209) {
                assert(res.observation.features['IsWarmupComplete'] === 1, 'Warmed before discontinuity');
            }
            if (i >= 210) {
                const postDiscObs = i - 209; // Bar 210 = 1st post-discontinuity observation
                if (postDiscObs === 1) {
                    assert(res.observation.features['IsDiscontinuity'] === 1, 'Expected discontinuity at bar 210');
                    assert(state.macdState!.fastEma!.count === 1 && state.macdState!.slowEma!.count === 1 && state.macdState!.signalEma === null,
                        'All MACD EMAs must reset on discontinuity');
                }
                assert(res.observation.validity['MACD_Line_ATR'] === (postDiscObs >= 26), `Post-disc MACD line @ 26 (obs=${postDiscObs})`);
                assert(res.observation.validity['MACD_Signal_ATR'] === (postDiscObs >= 34), `Post-disc MACD signal @ 34 (obs=${postDiscObs})`);
                assert(res.observation.features['IsWarmupComplete'] === (postDiscObs >= 200 ? 1 : 0),
                    `Post-disc IsWarmupComplete @ 200 (obs=${postDiscObs})`);
            }
        }
    });

    runTest('5. Invalid candle, operator-precedence fix, strict checkpoint integrity & HTF 3m/5m parity/no-VCS', () => {
        let st = createInitialML1FeatureStateV6(ML1_CONFIG_D);
        for (let i = 0; i < 30; i++) {
            const c = 100 + i * 0.5;
            st = stepML1FeaturesV6(makeCandle(t0 + i * dt, c - 0.2, c + 1, c - 1, c), i, st, ML1_CONFIG_D).nextState;
        }

        const rBad = stepML1FeaturesV6(makeCandle(t0 + 30 * dt, 100, 95, 98, 101), 30, st, ML1_CONFIG_D);
        assert(rBad.nextState === st, 'Invalid candle must preserve exact V6 state reference');
        assert(rBad.observation.features['IsValidOHLCV'] === 0 && rBad.observation.features['IsSourceValid'] === 0, 'Rejected row flags invalid OHLCV/source');
        assert(Object.keys(rBad.observation.features).length === 54, `Expected 54 base+V5+V6 keys on OHLCV-rejected row, got ${Object.keys(rBad.observation.features).length}`);
        for (const k of Object.keys(rBad.observation.features)) {
            assert(k in rBad.observation.validity && typeof rBad.observation.validity[k] === 'boolean', `Missing/non-bool validity on ${k}`);
            if (
                !rBad.observation.validity[k] &&
                (k.startsWith('SMA_') || k.startsWith('MACD_') || k.startsWith('BB_'))
            ) {
                assert(rBad.observation.features[k] === 0, `Invalid fallback must be 0 on ${k}`);
            }
        }

        const expectIntegrity = (badState: any, nextBar: number, label: string) => {
            let matched = false;
            try {
                stepML1FeaturesV6(makeCandle(t0 + nextBar * dt, 100, 102, 98, 101), nextBar, badState, ML1_CONFIG_D);
            } catch (e: any) {
                matched = e instanceof Error && e.message.includes('State Integrity Error');
            }
            assert(matched, `${label}: expected State Integrity Error`);
        };

        // Checkpoint integrity checks (including missing SMA periods, missing signalEma after slow EMA seeds, wrong signalEma count)
        expectIntegrity({ ...st, configFingerprint: 'WRONG' }, 30, 'config mismatch');
        expectIntegrity({ ...st, smaState: { 20: st.smaState[20] } }, 30, 'missing configured SMA 50/100/200 state');
        expectIntegrity({ ...st, bbState: { closeHistory: [100], unbrokenRun: 5 } }, 30, 'corrupted bbState unbrokenRun');
        expectIntegrity({ ...st, smaState: { ...st.smaState, 20: { closeHistory: [100], smaHistory: [100], unbrokenRun: 1 } } }, 30, 'corrupted unseeded smaHistory');
        expectIntegrity({ ...st, macdState: { fastEma: st.macdState!.fastEma, slowEma: st.macdState!.slowEma, signalEma: null } }, 30,
            'missing signalEma after MACD line becomes valid');
        expectIntegrity({
            ...st,
            macdState: {
                fastEma: st.macdState!.fastEma,
                slowEma: st.macdState!.slowEma,
                signalEma: { ...st.macdState!.signalEma!, count: 1, unbrokenRun: 1 }
            }
        }, 30, 'signalEma count inconsistent with MACD-line history (too low)');
        expectIntegrity({
            ...st,
            macdState: {
                fastEma: st.macdState!.fastEma,
                slowEma: st.macdState!.slowEma,
                signalEma: { ...st.macdState!.signalEma!, count: 8, unbrokenRun: 8 }
            }
        }, 30, 'signalEma count inconsistent with MACD-line history (too high)');

        // Verify HTF 3m/5m feature values, validity masks, and zero VCS_360 emission/state
        for (const [cfg, stepMs, label] of [
            [ML1_CONFIG_D_3M, 180_000, '3m'],
            [ML1_CONFIG_D_5M, 300_000, '5m']
        ] as const) {
            let htfState = createInitialML1FeatureStateV6(cfg);
            let obs35: any;
            for (let i = 0; i < 36; i++) {
                const close = 100 + i * 0.5;
                const res = stepML1FeaturesV6(makeCandle(t0 + i * stepMs, close - 0.2, close + 1, close - 1, close), i, htfState, cfg);
                htfState = res.nextState;
                obs35 = res.observation;
            }
            assert(Object.keys(obs35.features).length === 147 && Object.keys(obs35.validity).length === 147,
                `${label} feature/validity count must be 147`);
            assert(
                !Object.keys(obs35.features).some(k => k.startsWith('VolumeCandleSize_') || k.startsWith('VCS_')) &&
                !Object.keys(obs35.validity).some(k => k.startsWith('VolumeCandleSize_') || k.startsWith('VCS_')),
                `${label} must not emit VolumeCandleSize_ or VCS_ features/masks`
            );
            assert(Object.keys(htfState.v5State.volumeCandleSizeState).length === 0,
                `${label} must not allocate VCS_360 state`);
            assert(obs35.validity['SMA_20_Distance'] === true && obs35.features['SMA_20_Distance'] > 0,
                `${label} SMA_20_Distance must be valid & positive in uptrend`);
            assert(obs35.validity['MACD_Signal_ATR'] === true && obs35.validity['BB_Width_20'] === true,
                `${label} MACD signal & BB width must be valid at bar 35`);
        }
    });

    console.log(`\nPhase 1 (V6 / CONFIG_D) Acceptance: ${passed} passed, ${failed} failed.\n`);
    return failed === 0;
}
