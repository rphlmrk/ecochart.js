import { ML1_CONFIG_D, ML1_CONFIG_D_3M, ML1_CONFIG_D_5M } from '../indicators/mlr1/ML1FeatureConfigs';
import {
    createInitialML1FeatureStateV6,
    stepML1FeaturesV6,
    validateML1ConfigV6
} from '../indicators/mlr1/ML1FeatureEngine';
import type { ML1Candle } from '../indicators/mlr1/ML1FeatureTypes';
import { MTF_V4_CONFIG_D, validateV4MTFConfig } from '../indicators/mlr1/mtf/MTFConfig';
import { stepV4MTFAggregation } from '../indicators/mlr1/mtf/MTFAggregator';
import {
    stepV4MTFCombined,
    stepV4MTFFeatureEngine,
    stepV4TimeframeFeatureEngine
} from '../indicators/mlr1/mtf/MTFFeatureEngine';
import { alignV4MTFContext } from '../indicators/mlr1/mtf/MTFAligner';
import {
    createInitialV4MTFState,
    validateV4MTFState,
    validateV4MTFTimeframeState
} from '../indicators/mlr1/mtf/MTFState';
import {
    createInitialIntegratedV4MTFState,
    stepIntegratedV4MTFPipeline,
    validateIntegratedV4MTFConfig
} from '../indicators/mlr1/mtf/MTFEngine';
import type { V4HTFIncompleteDiagnostic, V4MTFCandle } from '../indicators/mlr1/mtf/MTFTypes';

function assert(condition: boolean, msg: string): asserts condition {
    if (!condition) throw new Error(`[Phase2V4MTFFailed] ${msg}`);
}

function makeCandle(time: number, open: number, high: number, low: number, close: number, volume = 100): ML1Candle {
    return { time, open, high, low, close, volume, isSynthetic: false };
}

export function runPhase2V4MTFAcceptanceTests(): boolean {
    console.log('\n======================================================');
    console.log('🧪 Starting Phase 2 (V4 3m & 5m MTF) Acceptance Suite');
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

    runTest('1. Strict config contracts: rejects 15m/1h, HTF VCS, wrong intervals/durations, and cross-symbol configs', () => {
        const expectThrow = (fn: () => unknown, label: string) => {
            let threw = false;
            try { fn(); } catch { threw = true; }
            assert(threw, `${label}: expected rejection`);
        };

        expectThrow(() => validateV4MTFConfig({
            symbol: 'SOLUSDT', baseTimeframe: '1m',
            config3m: { timeframe: '15m', durationMs: 900_000, alignment: 'UTC_HALF_OPEN', expectedSourceIntervalMs: 60_000, gapPolicy: 'REJECT_AND_RESET', featureConfig: ML1_CONFIG_D_3M },
            config5m: { timeframe: '5m', durationMs: 300_000, alignment: 'UTC_HALF_OPEN', expectedSourceIntervalMs: 60_000, gapPolicy: 'REJECT_AND_RESET', featureConfig: ML1_CONFIG_D_5M }
        }), '15m timeframe');

        expectThrow(() => validateV4MTFConfig({
            symbol: 'SOLUSDT', baseTimeframe: '1m',
            config3m: { timeframe: '3m', durationMs: 300_000, alignment: 'UTC_HALF_OPEN', expectedSourceIntervalMs: 60_000, gapPolicy: 'REJECT_AND_RESET', featureConfig: ML1_CONFIG_D_3M },
            config5m: { timeframe: '5m', durationMs: 300_000, alignment: 'UTC_HALF_OPEN', expectedSourceIntervalMs: 60_000, gapPolicy: 'REJECT_AND_RESET', featureConfig: ML1_CONFIG_D_5M }
        }), 'wrong 3m duration');

        expectThrow(() => validateV4MTFConfig({
            symbol: 'SOLUSDT', baseTimeframe: '1m',
            config3m: {
                timeframe: '3m', durationMs: 180_000, alignment: 'UTC_HALF_OPEN', expectedSourceIntervalMs: 60_000, gapPolicy: 'REJECT_AND_RESET',
                featureConfig: { ...ML1_CONFIG_D_3M, expectedIntervalMs: 60_000 }
            },
            config5m: { timeframe: '5m', durationMs: 300_000, alignment: 'UTC_HALF_OPEN', expectedSourceIntervalMs: 60_000, gapPolicy: 'REJECT_AND_RESET', featureConfig: ML1_CONFIG_D_5M }
        }), 'mismatched featureConfig.expectedIntervalMs');

        for (const badThreshold of [Number.NaN, Number.POSITIVE_INFINITY, 60_000]) {
            expectThrow(() => validateV4MTFConfig({
                symbol: 'SOLUSDT', baseTimeframe: '1m',
                config3m: {
                    timeframe: '3m', durationMs: 180_000, alignment: 'UTC_HALF_OPEN', expectedSourceIntervalMs: 60_000, gapPolicy: 'REJECT_AND_RESET',
                    featureConfig: { ...ML1_CONFIG_D_3M, gapDiscontinuityThresholdMs: badThreshold }
                },
                config5m: { timeframe: '5m', durationMs: 300_000, alignment: 'UTC_HALF_OPEN', expectedSourceIntervalMs: 60_000, gapPolicy: 'REJECT_AND_RESET', featureConfig: ML1_CONFIG_D_5M }
            }), `invalid gapDiscontinuityThresholdMs=${String(badThreshold)}`);
        }

        expectThrow(() => validateV4MTFConfig({
            symbol: 'SOLUSDT', baseTimeframe: '1m',
            config3m: {
                timeframe: '3m', durationMs: 180_000, alignment: 'UTC_HALF_OPEN', expectedSourceIntervalMs: 60_000, gapPolicy: 'REJECT_AND_RESET',
                featureConfig: { ...ML1_CONFIG_D_3M, volumeCandleSizePeriods: [360] }
            },
            config5m: { timeframe: '5m', durationMs: 300_000, alignment: 'UTC_HALF_OPEN', expectedSourceIntervalMs: 60_000, gapPolicy: 'REJECT_AND_RESET', featureConfig: ML1_CONFIG_D_5M }
        }), 'VCS enabled on 3m HTF');

        const btc1m = validateML1ConfigV6({ ...ML1_CONFIG_D, symbol: 'BTCUSDT' });
        expectThrow(() => validateIntegratedV4MTFConfig({ m1Config: btc1m, mtfConfig: MTF_V4_CONFIG_D }), 'cross-symbol 1m vs MTF');
        expectThrow(() => createInitialIntegratedV4MTFState({ m1Config: btc1m, mtfConfig: MTF_V4_CONFIG_D }), 'createInitialIntegratedV4MTFState cross-symbol');

        const sInit = createInitialV4MTFState(MTF_V4_CONFIG_D);
        expectThrow(() => alignV4MTFContext(t0, 'BTCUSDT', sInit, MTF_V4_CONFIG_D), 'alignV4MTFContext cross-symbol');
    });

    runTest('2. Exact causal boundaries (before / at / after 3m & 5m closes) + OHLCV + exact V6 schema parity', () => {
        const ref3 = stepML1FeaturesV6(makeCandle(t0, 100, 102, 99, 101, 100), 0, createInitialML1FeatureStateV6(ML1_CONFIG_D_3M), ML1_CONFIG_D_3M).observation;
        const expectedKeys = Object.keys(ref3.features).sort();
        assert(expectedKeys.length === 147, `Expected exactly 147 V6 HTF feature keys, got ${expectedKeys.length}`);
        assert(Object.keys(ref3.validity).length === 147, `Expected exactly 147 V6 HTF validity keys`);

        const cfg = { m1Config: ML1_CONFIG_D, mtfConfig: MTF_V4_CONFIG_D };
        let state = createInitialIntegratedV4MTFState(cfg);
        const obs: any[] = [];
        for (let i = 0; i < 8; i++) {
            const c = makeCandle(t0 + i * dt, 100 + i, 102 + i, 99 + i, 101 + i, 50 + i);
            const step = stepIntegratedV4MTFPipeline(c, i, state, cfg);
            state = step.nextState;
            obs.push(step.observation);
        }

        assert(obs[2].mtfContext.context3m.isAvailable === false && obs[2].mtfContext.context3m.contextAgeMs === null, '3m unavailable @ 00:02');
        assert(obs[3].mtfContext.context3m.isAvailable === true && obs[3].mtfContext.context3m.contextAgeMs === 0, '3m available @ 00:03 (age 0)');
        assert(obs[4].mtfContext.context3m.isAvailable === true && obs[4].mtfContext.context3m.contextAgeMs === dt, '3m available @ 00:04 (age 60s)');
        assert(obs[3].mtfContext.context3m.lastCompletedCandle.open === 100 && obs[3].mtfContext.context3m.lastCompletedCandle.close === 103 &&
            obs[3].mtfContext.context3m.lastCompletedCandle.volume === 153 && obs[3].mtfContext.context3m.lastCompletedCandle.sourceObservationCount === 3,
            '3m OHLCV mismatch');

        assert(obs[4].mtfContext.context5m.isAvailable === false && obs[4].mtfContext.context5m.contextAgeMs === null, '5m unavailable @ 00:04');
        assert(obs[5].mtfContext.context5m.isAvailable === true && obs[5].mtfContext.context5m.contextAgeMs === 0, '5m available @ 00:05 (age 0)');
        assert(obs[6].mtfContext.context5m.isAvailable === true && obs[6].mtfContext.context5m.contextAgeMs === dt, '5m available @ 00:06 (age 60s)');
        assert(obs[5].mtfContext.context5m.lastCompletedCandle.open === 100 && obs[5].mtfContext.context5m.lastCompletedCandle.close === 105 &&
            obs[5].mtfContext.context5m.lastCompletedCandle.volume === 260 && obs[5].mtfContext.context5m.lastCompletedCandle.sourceObservationCount === 5,
            '5m OHLCV mismatch');

        for (const ctx of [obs[3].mtfContext.context3m, obs[5].mtfContext.context5m]) {
            assert(JSON.stringify(Object.keys(ctx.features).sort()) === JSON.stringify(expectedKeys), 'HTF feature keys mismatch');
            assert(JSON.stringify(Object.keys(ctx.validity).sort()) === JSON.stringify(expectedKeys), 'HTF validity keys mismatch');
            assert(!expectedKeys.some(k => k.startsWith('VolumeCandleSize_') || k.startsWith('VCS_')), 'HTF must exclude VCS');
        }
    });

    runTest('3. Preceding-vs-milestone first-valid warmup checks (13/14, 19/20, 27/28, 33/34, 199/200) + 3m & 5m staleness', () => {
        const cfg = { m1Config: ML1_CONFIG_D, mtfConfig: MTF_V4_CONFIG_D };
        let state = createInitialIntegratedV4MTFState(cfg);

        for (let i = 0; i < 1006; i++) {
            const close = 100 + Math.sin(i / 25) * 6 + i * 0.02;
            const step = stepIntegratedV4MTFPipeline(
                makeCandle(t0 + i * dt, close - 0.2, close + 0.8, close - 0.8, close, 100 + (i % 7) * 10),
                i, state, cfg
            );
            state = step.nextState;
            const c3 = step.observation.mtfContext.context3m;
            const c5 = step.observation.mtfContext.context5m;

            // 3m preceding vs milestone boundaries
            if (i === 39) assert(c3.validity['Exhaustion_14'] === false, '3m CCI(14) invalid at 13th');
            if (i === 42) assert(c3.validity['Exhaustion_14'] === true, '3m CCI(14) valid at 14th');
            if (i === 57) assert(c3.validity['Exhaustion_20'] === false && c3.validity['BB_Width_20'] === false, '3m CCI(20)/BB invalid at 19th');
            if (i === 60) assert(c3.validity['Exhaustion_20'] === true && c3.validity['BB_Width_20'] === true, '3m CCI(20)/BB valid at 20th');
            if (i === 81) assert(c3.validity['VAM_ADX_14'] === false, '3m VAM ADX invalid at 27th');
            if (i === 84) assert(c3.validity['VAM_ADX_14'] === true, '3m VAM ADX valid at 28th');
            if (i === 99) assert(c3.validity['MACD_Signal_ATR'] === false, '3m MACD signal invalid at 33rd');
            if (i === 102) assert(c3.validity['MACD_Signal_ATR'] === true, '3m MACD signal valid at 34th');
            if (i === 597) assert(c3.validity['SMA_200_Distance'] === false && c3.isWarmupComplete === false && c3.availabilityStatus === 'WARMING_UP', '3m 199th WARMING_UP');
            if (i === 600) assert(c3.validity['SMA_200_Distance'] === true && c3.isWarmupComplete === true && c3.availabilityStatus === 'AVAILABLE_VALID', '3m 200th AVAILABLE_VALID');

            // 5m preceding vs milestone boundaries
            if (i === 65) assert(c5.validity['Exhaustion_14'] === false, '5m CCI(14) invalid at 13th');
            if (i === 70) assert(c5.validity['Exhaustion_14'] === true, '5m CCI(14) valid at 14th');
            if (i === 95) assert(c5.validity['Exhaustion_20'] === false && c5.validity['BB_Width_20'] === false, '5m CCI(20)/BB invalid at 19th');
            if (i === 100) assert(c5.validity['Exhaustion_20'] === true && c5.validity['BB_Width_20'] === true, '5m CCI(20)/BB valid at 20th');
            if (i === 135) assert(c5.validity['VAM_ADX_14'] === false, '5m VAM ADX invalid at 27th');
            if (i === 140) assert(c5.validity['VAM_ADX_14'] === true, '5m VAM ADX valid at 28th');
            if (i === 165) assert(c5.validity['MACD_Signal_ATR'] === false, '5m MACD signal invalid at 33rd');
            if (i === 170) assert(c5.validity['MACD_Signal_ATR'] === true, '5m MACD signal valid at 34th');
            if (i === 995) assert(c5.validity['SMA_200_Distance'] === false && c5.isWarmupComplete === false && c5.availabilityStatus === 'WARMING_UP', '5m 199th WARMING_UP');
            if (i === 1000) assert(c5.validity['SMA_200_Distance'] === true && c5.isWarmupComplete === true && c5.availabilityStatus === 'AVAILABLE_VALID', '5m 200th AVAILABLE_VALID');
        }

        // Staleness check for both 3m and 5m
        const staleCfg = {
            m1Config: ML1_CONFIG_D,
            mtfConfig: validateV4MTFConfig({
                symbol: 'SOLUSDT', baseTimeframe: '1m',
                config3m: { timeframe: '3m', durationMs: 180_000, alignment: 'UTC_HALF_OPEN', expectedSourceIntervalMs: 60_000, gapPolicy: 'REJECT_AND_RESET', maxStalenessMs: 60_000, featureConfig: ML1_CONFIG_D_3M },
                config5m: { timeframe: '5m', durationMs: 300_000, alignment: 'UTC_HALF_OPEN', expectedSourceIntervalMs: 60_000, gapPolicy: 'REJECT_AND_RESET', maxStalenessMs: 60_000, featureConfig: ML1_CONFIG_D_5M }
            })
        };
        let st2 = createInitialIntegratedV4MTFState(staleCfg);
        for (let i = 0; i < 8; i++) {
            const step = stepIntegratedV4MTFPipeline(makeCandle(t0 + i * dt, 100, 102, 98, 101, 100), i, st2, staleCfg);
            st2 = step.nextState;
            if (i === 5) assert(step.observation.mtfContext.context3m.availabilityStatus === 'STALE' && step.observation.mtfContext.context3m.isAvailable === false, '3m STALE @ 00:05');
            if (i === 7) assert(step.observation.mtfContext.context5m.availabilityStatus === 'STALE' && step.observation.mtfContext.context5m.isAvailable === false, '5m STALE @ 00:07');
        }
    });

    runTest('4. Duplicate & backward timestamps rejected with exact duplicateCount vs invalidSourceCount classification', () => {
        let st = createInitialV4MTFState(MTF_V4_CONFIG_D);
        st = stepV4MTFAggregation(makeCandle(t0, 100, 102, 98, 101, 50), true, st, MTF_V4_CONFIG_D, 0).nextState;
        st = stepV4MTFAggregation(makeCandle(t0 + dt, 101, 103, 99, 102, 60), true, st, MTF_V4_CONFIG_D, 1).nextState;

        const rDup = stepV4MTFAggregation(makeCandle(t0 + dt, 105, 108, 104, 107, 999), true, st, MTF_V4_CONFIG_D, 2);
        assert(rDup.nextState.state3m.aggregation.actualSourceCount === 2 && rDup.nextState.state3m.aggregation.duplicateCount === 1 &&
            rDup.nextState.state3m.aggregation.invalidSourceCount === 0, '3m dup classification');
        assert(rDup.nextState.state5m.aggregation.actualSourceCount === 2 && rDup.nextState.state5m.aggregation.duplicateCount === 1 &&
            rDup.nextState.state5m.aggregation.invalidSourceCount === 0, '5m dup classification');
        assert(rDup.nextState.last1mTimestamp === t0 + dt && rDup.nextState.last1mBarIndex === 1, 'Watermarks unchanged on dup');

        const rBack = stepV4MTFAggregation(makeCandle(t0 - dt, 105, 108, 104, 107, 999), true, st, MTF_V4_CONFIG_D, 2);
        assert(rBack.nextState.state3m.aggregation.actualSourceCount === 2 && rBack.nextState.state3m.aggregation.invalidSourceCount === 1 &&
            rBack.nextState.state3m.aggregation.duplicateCount === 0, '3m backward classification');
        assert(rBack.nextState.state5m.aggregation.actualSourceCount === 2 && rBack.nextState.state5m.aggregation.invalidSourceCount === 1 &&
            rBack.nextState.state5m.aggregation.duplicateCount === 0, '5m backward classification');

        const rDupNoIdx = stepV4MTFAggregation(makeCandle(t0 + dt, 105, 108, 104, 107, 999), true, st, MTF_V4_CONFIG_D);
        assert(rDupNoIdx.nextState.state3m.aggregation.actualSourceCount === 2 && rDupNoIdx.nextState.state3m.aggregation.duplicateCount === 1 &&
            rDupNoIdx.nextState.state5m.aggregation.duplicateCount === 1, 'Dup without barIndex classified as duplicate');
    });

    runTest('5. Aggregator-generated & feature-engine diagnostic ordering + independent 3m/5m gap recovery', () => {
        const tfCfg = MTF_V4_CONFIG_D.config3m;
        const baseState = createInitialV4MTFState(MTF_V4_CONFIG_D).state3m;
        const cWin0: V4MTFCandle = { timeframe: '3m', openTimestamp: t0, closeTimestamp: t0 + 180_000, open: 100, high: 102, low: 99, close: 101, volume: 300, sourceObservationCount: 3, completeness: 'COMPLETE' };
        const dWin0: V4HTFIncompleteDiagnostic = { timeframe: '3m', openTimestamp: t0, closeTimestamp: t0 + 180_000, expectedSourceCount: 3, actualSourceCount: 2, missingTimestamps: [t0 + 120_000], duplicateCount: 0, invalidSourceCount: 0, completeness: 'INCOMPLETE_MISSING' };
        const cWin1: V4MTFCandle = { ...cWin0, openTimestamp: t0 + 180_000, closeTimestamp: t0 + 360_000 };
        const dWin1: V4HTFIncompleteDiagnostic = { ...dWin0, openTimestamp: t0 + 180_000, closeTimestamp: t0 + 360_000, missingTimestamps: [t0 + 300_000] };

        const rCD = stepV4TimeframeFeatureEngine(baseState, cWin0, dWin1, tfCfg);
        validateV4MTFTimeframeState(rCD.nextTimeframeState, tfCfg);
        assert(rCD.observation !== null && rCD.nextTimeframeState.lastCompletedBarIndex === null &&
            rCD.nextTimeframeState.aggregation.lastCompletedCandle === null &&
            Object.keys(rCD.nextTimeframeState.latestFeatures).length === 0, 'Completed before diagnostic must emit then cleanly reset');

        const sSeed = stepV4TimeframeFeatureEngine(baseState, cWin0, null, tfCfg).nextTimeframeState;
        validateV4MTFTimeframeState(sSeed, tfCfg);
        const rDC = stepV4TimeframeFeatureEngine(sSeed, cWin1, dWin0, tfCfg);
        validateV4MTFTimeframeState(rDC.nextTimeframeState, tfCfg);
        assert(rDC.observation !== null && rDC.nextTimeframeState.lastCompletedBarIndex === 0 &&
            rDC.nextTimeframeState.aggregation.lastCompletedCandle?.openTimestamp === cWin1.openTimestamp,
            'Diagnostic before completed must reset then step bar 0');

        let overlapRejected = false;
        try { stepV4TimeframeFeatureEngine(baseState, cWin0, dWin0, tfCfg); } catch { overlapRejected = true; }
        assert(overlapRejected, 'Overlapping candle & diagnostic must throw');

        // Malformed incoming completed candle rejected BEFORE emitting observation
        let badCandleRejected = false;
        try {
            stepV4TimeframeFeatureEngine(baseState, { ...cWin0, high: 50, low: 200 }, null, tfCfg);
        } catch (e: any) {
            badCandleRejected = e instanceof Error && e.message.includes('V4 MTF State Integrity Error');
        }
        assert(badCandleRejected, 'Malformed incoming completedCandle must throw before processing');

        // Malformed incoming diagnostic (INCOMPLETE_MISSING with duplicateCount > 0) rejected BEFORE state mutation
        let badDiagRejected = false;
        try {
            stepV4TimeframeFeatureEngine(sSeed, null, { ...dWin1, duplicateCount: 1 }, tfCfg);
        } catch (e: any) {
            badDiagRejected = e instanceof Error && e.message.includes('V4 MTF State Integrity Error');
        }
        assert(badDiagRejected, 'Semantically inconsistent incoming diagnostic must throw before reset');

        // Direct stepV4MTFCombined merge validation: normal completion -> diagnostic invalidation -> full recovery (3m & 5m)
        let combSt = createInitialV4MTFState(MTF_V4_CONFIG_D);
        for (let i = 0; i < 6; i++) {
            const c = makeCandle(t0 + i * dt, 100 + i, 102 + i, 99 + i, 101 + i, 100);
            const r = stepV4MTFCombined(c, true, combSt, MTF_V4_CONFIG_D, i);
            combSt = r.nextState;
            validateV4MTFState(combSt, MTF_V4_CONFIG_D);
            if (i === 3) assert(r.completed3m !== null && combSt.state3m.aggregation.lastCompletedCandle?.openTimestamp === t0, 'Combined 3m completed');
            if (i === 5) assert(r.completed5m !== null && combSt.state5m.aggregation.lastCompletedCandle?.openTimestamp === t0, 'Combined 5m completed');
        }
        // Jump from 00:05 directly to 00:10 -> skips 3m [00:06, 00:09) and causes incomplete 5m [00:05, 00:10) -> BOTH emit diagnostics & clear lastCompletedCandle
        const combDiag = stepV4MTFCombined(makeCandle(t0 + 10 * dt, 110, 112, 109, 111, 100), true, combSt, MTF_V4_CONFIG_D, 6);
        validateV4MTFState(combDiag.nextState, MTF_V4_CONFIG_D);
        assert(combDiag.diagnostic3m !== null && combDiag.nextState.state3m.aggregation.lastCompletedCandle === null &&
            combDiag.nextState.state3m.lastCompletedBarIndex === null, '3m diagnostic invalidation preserved through merge');
        assert(combDiag.diagnostic5m !== null && combDiag.nextState.state5m.aggregation.lastCompletedCandle === null &&
            combDiag.nextState.state5m.lastCompletedBarIndex === null, '5m diagnostic invalidation preserved through merge');
        const alignedDuringDiag = alignV4MTFContext(t0 + 10 * dt, 'SOLUSDT', combDiag.nextState, MTF_V4_CONFIG_D);
        assert(!alignedDuringDiag.context3m.isAvailable && alignedDuringDiag.context3m.lastCompletedCandle === null &&
            !alignedDuringDiag.context5m.isAvailable && alignedDuringDiag.context5m.lastCompletedCandle === null,
            'Aligner must expose zero stale candles after combined diagnostic');

        // Feed contiguous candles from 00:11..00:15 -> verify clean recovery in both 3m (at 00:15 for [00:12,00:15) since [00:09,00:12) lacked 00:09) and 5m (at 00:15)
        let recSt = combDiag.nextState;
        for (let k = 11; k <= 15; k++) {
            const r = stepV4MTFCombined(makeCandle(t0 + k * dt, 100 + k, 102 + k, 99 + k, 101 + k, 100), true, recSt, MTF_V4_CONFIG_D, k - 4);
            recSt = r.nextState;
            validateV4MTFState(recSt, MTF_V4_CONFIG_D);
            if (k === 12) assert(r.diagnostic3m !== null && recSt.state3m.lastCompletedBarIndex === null, '3m [00:09,00:12) incomplete @ 00:12 due to missing 00:09');
            if (k === 15) {
                assert(r.completed3m !== null && recSt.state3m.lastCompletedBarIndex === 0, '3m recovered @ 00:15');
                assert(r.completed5m !== null && recSt.state5m.lastCompletedBarIndex === 0, '5m recovered @ 00:15');
            }
        }
        // Partial forming window at stream end never emits INCOMPLETE_UNFINISHED
        assert((recSt.state3m.aggregation.lastDiagnostic?.completeness as string) !== 'INCOMPLETE_UNFINISHED' &&
            (recSt.state5m.aggregation.lastDiagnostic?.completeness as string) !== 'INCOMPLETE_UNFINISHED',
            'Aggregator never emits INCOMPLETE_UNFINISHED');

        const rDD1 = stepV4TimeframeFeatureEngine(sSeed, null, dWin1, tfCfg).nextTimeframeState;
        validateV4MTFTimeframeState(rDD1, tfCfg);
        const rDD2 = stepV4TimeframeFeatureEngine(rDD1, null, dWin1, tfCfg).nextTimeframeState;
        validateV4MTFTimeframeState(rDD2, tfCfg);
        assert(rDD2.lastCompletedBarIndex === null && rDD2.aggregation.lastCompletedCandle === null &&
            Object.keys(rDD2.latestFeatures).length === 0, 'Consecutive diagnostics stay cleanly reset');

        // Real aggregator-generated diagnostic + completed candle in same step (window [00:00,00:03) completes, [00:03,00:06) skipped)
        let aggSt = createInitialV4MTFState(MTF_V4_CONFIG_D);
        for (let i = 0; i < 3; i++) {
            aggSt = stepV4MTFAggregation(makeCandle(t0 + i * dt, 100 + i, 102 + i, 99 + i, 101 + i, 100), true, aggSt, MTF_V4_CONFIG_D, i).nextState;
        }
        const aggSkip = stepV4MTFAggregation(makeCandle(t0 + 6 * dt, 106, 108, 105, 107, 100), true, aggSt, MTF_V4_CONFIG_D, 3);
        assert(aggSkip.completed3m !== null && aggSkip.diagnostic3m !== null &&
            aggSkip.diagnostic3m.completeness === 'INCOMPLETE_MISSING' && aggSkip.diagnostic3m.openTimestamp === t0 + 180_000,
            'Real aggregator emitted completed + skipped diagnostic');

        // Independent 3m vs 5m gap recovery via integrated pipeline
        const cfg = { m1Config: ML1_CONFIG_D, mtfConfig: MTF_V4_CONFIG_D };
        let st = createInitialIntegratedV4MTFState(cfg);
        let saw5mGap = false;
        for (let i = 0; i < 30; i++) {
            if (i === 17) continue; // Missing 00:17 inside 3m [00:15, 00:18) and 5m [00:15, 00:20)
            const c = makeCandle(t0 + i * dt, 100 + i, 102 + i, 99 + i, 101 + i, 100);
            const step = stepIntegratedV4MTFPipeline(c, i < 17 ? i : i - 1, st, cfg);
            st = step.nextState;
            validateV4MTFState(st.mtfState, MTF_V4_CONFIG_D);
            if (c.time === t0 + 18 * dt || c.time === t0 + 19 * dt) {
                assert(step.observation.mtfContext.context3m.isAvailable === false &&
                    step.observation.mtfContext.context3m.lastCompletedCandle === null,
                    'Invalidated 3m context must remain UNAVAILABLE and never expose stale candle');
                assert(step.nextState.mtfState.state3m.aggregation.lastDiagnostic?.completeness === 'INCOMPLETE_MISSING', '3m diagnostic recorded');
            }
            if (c.time === t0 + 20 * dt || c.time === t0 + 22 * dt) {
                if (c.time === t0 + 20 * dt) saw5mGap = true;
                assert(step.observation.mtfContext.context5m.isAvailable === false &&
                    step.observation.mtfContext.context5m.lastCompletedCandle === null,
                    'Invalidated 5m context must remain UNAVAILABLE and never expose stale candle');
                assert(step.nextState.mtfState.state5m.aggregation.lastDiagnostic?.completeness === 'INCOMPLETE_MISSING', '5m diagnostic recorded');
            }
            if (c.time === t0 + 21 * dt) {
                assert(step.observation.mtfContext.context3m.isAvailable === true && step.observation.mtfContext.context3m.lastCompletedOpenTimestamp === t0 + 18 * dt,
                    '3m recovers independently at 00:21 while 5m stays UNAVAILABLE');
                assert(step.observation.mtfContext.context5m.isAvailable === false, '5m must remain UNAVAILABLE until 00:25');
            }
            if (c.time === t0 + 25 * dt) {
                assert(step.observation.mtfContext.context5m.isAvailable === true && step.observation.mtfContext.context5m.lastCompletedOpenTimestamp === t0 + 20 * dt,
                    '5m recovers cleanly at 00:25');
            }
        }
        assert(saw5mGap, 'Expected 5m gap check');
    });

    runTest('6. Corrupted V4 checkpoint rejection across all public entry points & replay parity', () => {
        const cfg = { m1Config: ML1_CONFIG_D, mtfConfig: MTF_V4_CONFIG_D };
        let st = createInitialIntegratedV4MTFState(cfg);
        const obs: any[] = [];
        for (let i = 0; i < 12; i++) {
            const c = makeCandle(t0 + i * dt, 100 + i, 102 + i, 99 + i, 101 + i, 100);
            const r = stepIntegratedV4MTFPipeline(c, i, st, cfg);
            st = r.nextState;
            obs.push(r.observation);
        }

        const expectAllReject = (badMtfState: any, label: string) => {
            for (const [epLabel, fn] of [
                ['alignV4MTFContext', () => alignV4MTFContext(t0 + 11 * dt, 'SOLUSDT', badMtfState, MTF_V4_CONFIG_D)],
                ['stepV4MTFAggregation', () => stepV4MTFAggregation(makeCandle(t0 + 12 * dt, 112, 114, 111, 113), true, badMtfState, MTF_V4_CONFIG_D, 12)],
                ['stepV4MTFFeatureEngine', () => stepV4MTFFeatureEngine(badMtfState, null, null, null, null, MTF_V4_CONFIG_D)],
            ] as const) {
                let threw = false;
                try { fn(); } catch (e: any) {
                    threw = e instanceof Error && e.message.includes('V4 MTF State Integrity Error');
                }
                assert(threw, `${label} via ${epLabel}: expected V4 MTF State Integrity Error`);
            }
        };

        const m = st.mtfState;
        validateV4MTFState(m, MTF_V4_CONFIG_D);

        const feat146 = { ...m.state3m.latestFeatures };
        const val146 = { ...m.state3m.latestValidity };
        delete feat146['BB_Width_20'];
        delete val146['BB_Width_20'];

        const featWrongKey = { ...feat146, BOGUS_FEATURE_KEY: 0 };
        const valWrongKey = { ...val146, BOGUS_FEATURE_KEY: false };

        expectAllReject({ ...m, stateVersion: 99 }, 'invalid global stateVersion');
        expectAllReject({ ...m, last1mTimestamp: -1 }, 'negative last1mTimestamp');
        expectAllReject({ ...m, last1mTimestamp: t0 }, 'last1mTimestamp earlier than completed candle close');
        expectAllReject({ ...m, state3m: { ...m.state3m, timeframe: '15m' } }, 'invalid timeframe 15m');
        expectAllReject({ ...m, state3m: { ...m.state3m, aggregation: null } }, 'missing 3m aggregation state');
        expectAllReject({ ...m, state5m: { ...m.state5m, featureEngineState: null } }, 'missing 5m featureEngineState');
        expectAllReject({ ...m, state3m: { ...m.state3m, featureEngineState: { ...m.state3m.featureEngineState, v5State: null } } }, 'corrupted nested v5State');
        expectAllReject({ ...m, state3m: { ...m.state3m, featureEngineState: { ...m.state3m.featureEngineState, configFingerprint: 'WRONG' } } }, 'mismatched configFingerprint');
        expectAllReject({ ...m, state3m: { ...m.state3m, lastCompletedBarIndex: 99 } }, 'inconsistent aggregation vs feature watermark');
        expectAllReject({ ...m, state3m: { ...m.state3m, aggregation: { ...m.state3m.aggregation, lastCompletedCandle: null } } }, 'missing lastCompletedCandle with populated watermark');
        expectAllReject({ ...m, state3m: { ...m.state3m, latestFeatures: feat146, latestValidity: val146 } }, '146 matching keys rejected by canonical 147-key check');
        expectAllReject({ ...m, state3m: { ...m.state3m, latestFeatures: featWrongKey, latestValidity: valWrongKey } }, '147 keys with 1 wrong key rejected by canonical check');
        expectAllReject({
            ...m,
            state3m: { ...m.state3m, aggregation: { ...m.state3m.aggregation, lastCompletedCandle: { ...m.state3m.aggregation.lastCompletedCandle!, closeTimestamp: t0 + 999 } } }
        }, 'corrupted completed-candle timestamp');
        expectAllReject({
            ...m,
            state3m: { ...m.state3m, aggregation: { ...m.state3m.aggregation, lastCompletedCandle: { ...m.state3m.aggregation.lastCompletedCandle!, high: 50, low: 200 } } }
        }, 'corrupted completed-candle OHLC geometry');
        expectAllReject({
            ...m,
            state3m: { ...m.state3m, aggregation: { ...m.state3m.aggregation, lastCompletedCandle: { ...m.state3m.aggregation.lastCompletedCandle!, close: 999 } } }
        }, 'feature lastClose disagrees with completed candle close');
        expectAllReject({
            ...m,
            state3m: { ...m.state3m, latestFeatures: { ...m.state3m.latestFeatures, ATR_14: Number.NaN } }
        }, 'NaN feature value');
        expectAllReject({
            ...m,
            state3m: { ...m.state3m, latestValidity: { ...m.state3m.latestValidity, ATR_14: 'true' } }
        }, 'non-boolean validity value');
        expectAllReject({
            ...m,
            state3m: {
                ...m.state3m,
                aggregation: {
                    ...m.state3m.aggregation,
                    lastDiagnostic: {
                        timeframe: '3m', openTimestamp: m.state3m.aggregation.lastCompletedCandle!.openTimestamp,
                        closeTimestamp: m.state3m.aggregation.lastCompletedCandle!.closeTimestamp,
                        expectedSourceCount: 3, actualSourceCount: 2, missingTimestamps: [m.state3m.aggregation.lastCompletedCandle!.openTimestamp],
                        duplicateCount: 0, invalidSourceCount: 0, completeness: 'INCOMPLETE_MISSING'
                    }
                }
            }
        }, 'diagnostic overlapping active completed candle');
        expectAllReject({
            ...m,
            state3m: {
                ...m.state3m,
                aggregation: {
                    ...m.state3m.aggregation,
                    lastDiagnostic: {
                        timeframe: '3m', openTimestamp: t0, closeTimestamp: t0 + 180_000,
                        expectedSourceCount: 3, actualSourceCount: 2, missingTimestamps: [t0],
                        duplicateCount: 1, invalidSourceCount: 0, completeness: 'INCOMPLETE_MISSING'
                    }
                }
            }
        }, 'semantically inconsistent diagnostic (INCOMPLETE_MISSING with duplicateCount > 0)');
        expectAllReject({
            ...m,
            state3m: {
                ...m.state3m,
                aggregation: {
                    ...m.state3m.aggregation,
                    lastDiagnostic: {
                        timeframe: '3m', openTimestamp: t0, closeTimestamp: t0 + 180_000,
                        expectedSourceCount: 3, actualSourceCount: 1, missingTimestamps: [t0, t0],
                        duplicateCount: -1, invalidSourceCount: 0, completeness: 'INCOMPLETE_MISSING'
                    }
                }
            }
        }, 'duplicate missingTimestamps & negative diagnostic counter');
        expectAllReject({
            ...m,
            state3m: {
                ...m.state3m,
                aggregation: { ...m.state3m.aggregation, lastObservedSourceTimestamp: Number.NaN }
            }
        }, 'NaN lastObservedSourceTimestamp in aggregation state');
        expectAllReject({
            ...m,
            state3m: {
                ...m.state3m,
                aggregation: { ...m.state3m.aggregation, runningHigh: 50, runningLow: 200 }
            }
        }, 'corrupted forming-window OHLCV in aggregation state');
        expectAllReject({
            ...m,
            state3m: {
                ...m.state3m,
                aggregation: {
                    ...m.state3m.aggregation,
                    lastDiagnostic: {
                        timeframe: '3m', openTimestamp: t0, closeTimestamp: t0 + 180_000,
                        expectedSourceCount: 3, actualSourceCount: 2, missingTimestamps: [t0],
                        duplicateCount: 0, invalidSourceCount: 0, completeness: 'INCOMPLETE_UNFINISHED'
                    }
                }
            }
        }, 'obsolete INCOMPLETE_UNFINISHED diagnostic rejected');

        // Clean checkpoint round-trip from bar 6
        let st6 = createInitialIntegratedV4MTFState(cfg);
        let cp6 = '';
        for (let i = 0; i < 12; i++) {
            const c = makeCandle(t0 + i * dt, 100 + i, 102 + i, 99 + i, 101 + i, 100);
            if (i <= 6) {
                st6 = stepIntegratedV4MTFPipeline(c, i, st6, cfg).nextState;
                if (i === 6) cp6 = JSON.stringify(st6);
            } else {
                if (i === 7) st6 = JSON.parse(cp6);
                const res = stepIntegratedV4MTFPipeline(c, i, st6, cfg);
                st6 = res.nextState;
                assert(JSON.stringify(res.observation) === JSON.stringify(obs[i]), `Checkpoint replay mismatch at bar ${i}`);
            }
        }
    });

    console.log(`\nPhase 2 (V4 3m & 5m MTF) Acceptance: ${passed} passed, ${failed} failed.\n`);
    return failed === 0;
}
