import { DataStore } from '../data/DataStore';
import { ExhaustionIndicator } from '../indicators/plugins/Exhaustion';
import { VolumeCandleSizeIndicator } from '../indicators/plugins/VolumeCandleSizeIndicator';
import { VolatilityAdjustedMeanIndicator } from '../indicators/plugins/VolatilityAdjustedMeanIndicator';
import { ProtectedHighsLowsIndicator } from '../indicators/plugins/ProtectedHighsLowsIndicator';
import { DTFXAlgoZonesIndicator } from '../indicators/plugins/DTFXAlgoZonesIndicator';
import { StrictCBCZigZagIndicator } from '../indicators/plugins/StrictCBCZigZagIndicator';
import { updateExhaustionCCI } from '../indicators/mlr1/momentum/Exhaustion';
import { updateVolumeCandleSize } from '../indicators/mlr1/volume/VolumeCandleSize';
import { createInitialVAMState, stepVolatilityAdjustedMean } from '../indicators/mlr1/trend/VolatilityAdjustedMean';
import { createDefaultPHLConfig, createInitialPHLState, stepPHL } from '../indicators/mlr1/teachers/ProtectedHighsLowsTeacher';
import { createDefaultDTFXConfig, createInitialDTFXState, stepDTFX } from '../indicators/mlr1/teachers/DTFXAlgoZonesTeacher';
import { updateWilderATR } from '../indicators/mlr1/volatility/ATR';
import { stepStrictCBCWithReset } from '../indicators/mlr1/teachers/StrategyEventTypes';
import { ML1_CONFIG_C } from '../indicators/mlr1/ML1FeatureConfigs';
import { createInitialML1FeatureStateV5, stepML1FeaturesV5 } from '../indicators/mlr1/ML1FeatureEngine';
import type { ATRPeriodState, ML1Candle } from '../indicators/mlr1/ML1FeatureTypes';
import type { StrictCBCState, StrictZigZagPivot } from '../indicators/plugins/StrictCBCZigZagIndicator';

function assert(condition: boolean, msg: string): asserts condition {
    if (!condition) throw new Error(`[Phase5DPhase5Failed] ${msg}`);
}

function makeFeed(count: number, startTime: number, intervalMs: number, gapAtIndex?: number): ML1Candle[] {
    const out: ML1Candle[] = [];
    let ts = startTime;
    let p = 100;
    for (let i = 0; i < count; i++) {
        if (gapAtIndex !== undefined && i === gapAtIndex) ts += 10 * intervalMs;
        const mod = i % 90;
        const delta = mod < 42
            ? (i % 6 === 0 ? -0.5 : 1.4)
            : (i % 6 === 0 ? 0.5 : -1.5);
        const o = p;
        const c = Math.max(15, p + delta);
        out.push({
            time: ts,
            open: o,
            high: Math.max(o, c) + 0.8,
            low: Math.min(o, c) - 0.8,
            close: c,
            volume: 100 + (i % 7) * 25
        });
        p = c;
        ts += intervalMs;
    }
    return out;
}

function buildDataStore(candles: readonly ML1Candle[]): DataStore {
    const ds = new DataStore(candles.length);
    ds.setAll(candles.map(c => [c.time, c.open, c.high, c.low, c.close, c.volume]));
    return ds;
}

export function runPhase5DPhase5Tests(): boolean {
    console.log('\n======================================================');
    console.log('🧪 Starting Phase 5D Phase 5 Acceptance Suite (Chart vs Engine Parity)');
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

    const t0 = 1_700_000_040_000;
    const interval = 60_000;

    runTest('1. Numerical, Warmup & Discontinuity Parity across all 6 Chart Plugins vs Pure Engines', () => {
        const candles = makeFeed(480, t0, interval, 390); // 10m discontinuity gap at bar 390
        const ds = buildDataStore(candles);

        const indExh = new ExhaustionIndicator();
        const indVcs = new VolumeCandleSizeIndicator();
        const indVam = new VolatilityAdjustedMeanIndicator();
        const indPhl = new ProtectedHighsLowsIndicator();
        const indDtfx = new DTFXAlgoZonesIndicator();
        const indCbc = new StrictCBCZigZagIndicator();

        indPhl.currentSymbol = 'SOLUSDT';
        indDtfx.currentSymbol = 'SOLUSDT';
        indCbc.currentSymbol = 'SOLUSDT';

        indExh.calculate(ds);
        indVcs.calculate(ds);
        indVam.calculate(ds);
        indPhl.calculate(ds);
        indDtfx.calculate(ds);
        indCbc.calculate(ds);

        // Run authoritative pure engines independently
        let exhState: ReturnType<typeof updateExhaustionCCI>['nextState'] | undefined;
        let vcsState: ReturnType<typeof updateVolumeCandleSize>['nextState'] | undefined;
        let vamState = createInitialVAMState();
        let phlState = createInitialPHLState();
        let dtfxState = createInitialDTFXState();
        let cbcState: StrictCBCState | null = null;
        let cbcPrevPivot: StrictZigZagPivot | null = null;
        let atrState: ATRPeriodState | undefined;
        let prevClose: number | null = null;

        const phlStrength = indPhl.getParam<number>('pivotStrength', 10);
        assert(phlStrength >= 8 && phlStrength <= 15, `Default PHL pivotStrength must be tuned 8..15, got ${phlStrength}`);
        const phlCfg = { ...createDefaultPHLConfig('SOLUSDT', '1m', interval), pivotStrength: phlStrength };
        const dtfxCfg = createDefaultDTFXConfig('SOLUSDT', '1m', interval);
        const purePhlEvents: string[] = [];
        const pureDtfxEvents: string[] = [];
        const pureCbcConfirmedBars: number[] = [];

        for (let i = 0; i < candles.length; i++) {
            const c = candles[i];
            const isDisc = i > 0 && c.time - candles[i - 1].time >= 300_000;

            const eOut = updateExhaustionCCI(c.high, c.low, c.close, 20, exhState, isDisc);
            exhState = eOut.nextState;
            assert(
                (indExh.validMask[i] === 1) === eOut.isValid &&
                (!eOut.isValid || indExh.values[i] === eOut.cciValue),
                `Exhaustion parity mismatch at bar ${i}`
            );

            const vOut = updateVolumeCandleSize(c.high, c.low, c.volume, 360, vcsState, isDisc);
            vcsState = vOut.nextState;
            assert(
                (indVcs.validMask[i] === 1) === vOut.isRatioValid &&
                (!vOut.isRatioValid || (indVcs.ratios[i] === vOut.ratio && indVcs.regimes[i] === vOut.regime)),
                `VolumeCandleSize parity mismatch at bar ${i}`
            );

            const mOut = stepVolatilityAdjustedMean(c.high, c.low, c.close, vamState, isDisc);
            vamState = mOut.nextState;
            assert(
                (indVam.centerValid[i] === 1) === (vamState.center !== null) &&
                (vamState.center === null || indVam.centers[i] === vamState.center) &&
                indVam.trends[i] === mOut.trend &&
                indVam.signals[i] === mOut.signal,
                `VAM parity mismatch at bar ${i}`
            );

            const atrStep = updateWilderATR(c.high, c.low, prevClose, 14, atrState, isDisc);
            atrState = atrStep.nextState;
            prevClose = c.close;
            const atrVal = atrStep.isValid && atrStep.atrValue > 0 ? atrStep.atrValue : null;

            const pStep = stepPHL(c, i, phlState, phlCfg, isDisc, atrVal, null);
            phlState = pStep.nextState;
            purePhlEvents.push(...pStep.events.map(e => `${e.eventType}@${e.confirmationBarIndex}`));

            const dStep = stepDTFX(c, i, dtfxState, dtfxCfg, isDisc, atrVal, null);
            dtfxState = dStep.nextState;
            pureDtfxEvents.push(...dStep.events.map(e => `${e.eventType}@${e.confirmationBarIndex}`));

            const cStep = stepStrictCBCWithReset(c, i, cbcState, cbcPrevPivot, isDisc);
            cbcState = cStep.nextState;
            cbcPrevPivot = cStep.nextPrevPivot;
            if (cStep.confirmedPivot) pureCbcConfirmedBars.push(cStep.confirmedPivot.confirmedBarIndex);
        }

        // Verify warmup & discontinuity reset states
        assert(indExh.validMask[18] === 0 && indExh.validMask[19] === 1, 'CCI20 warmup boundary');
        assert(indVcs.validMask[359] === 0 && indVcs.validMask[360] === 1, 'VCS360 warmup boundary');
        assert(indExh.validMask[390] === 0 && indVcs.validMask[390] === 0, 'Discontinuity bar 390 must reset warmup');
        assert(indExh.getValueAt(10, ds, true, 0xffffff).valueStr === 'Warmup / Invalid', 'Warmup readout check');

        assert(
            JSON.stringify(indPhl.cachedEvents.map(e => `${e.eventType}@${e.confirmationBarIndex}`)) === JSON.stringify(purePhlEvents),
            'PHL chart events diverged from pure PHL engine'
        );

        // Verify Close Only target trigger ignores wicks while Wick (High/Low) triggers
        const wickSubset = candles.slice(0, 260);
        const wickDs = buildDataStore(wickSubset);
        const phlWickTest = new ProtectedHighsLowsIndicator();
        phlWickTest.currentSymbol = 'SOLUSDT';
        phlWickTest.updateParams({ pivotStrength: 3, targetTrigger: 'Close Only' });
        phlWickTest.calculate(wickDs);
        const openSeg = phlWickTest.targetSegments.find(s => !s.hit);
        assert(openSeg !== undefined, 'Expected an open trailing ATR target segment for wick test');

        const prevC = wickSubset[wickSubset.length - 1];
        const safeClose = openSeg.dir === 1
            ? Math.min(prevC.close, openSeg.price - 0.5)
            : Math.max(prevC.close, openSeg.price + 0.5);
        const spikeHigh = openSeg.dir === 1
            ? openSeg.price + 1.5
            : Math.max(prevC.close, safeClose) + 0.2;
        const spikeLow = openSeg.dir === -1
            ? Math.max(1, openSeg.price - 1.5)
            : Math.min(prevC.close, safeClose) - 0.2;
        wickDs.appendOrUpdate(
            prevC.time + interval,
            prevC.close,
            spikeHigh,
            spikeLow,
            safeClose,
            150
        );
        phlWickTest.calculate(wickDs);
        assert(
            !phlWickTest.targetSegments.some(s => s.startBar === openSeg.startBar && s.stepNum === openSeg.stepNum && s.hit),
            'Close Only target trigger must ignore wick-only pierces'
        );
        assert(
            JSON.stringify(indDtfx.cachedEvents.map(e => `${e.eventType}@${e.confirmationBarIndex}`)) === JSON.stringify(pureDtfxEvents),
            'DTFX chart events diverged from pure DTFX engine'
        );
        assert(
            JSON.stringify(indCbc.cachedPivots.map(p => p.confirmedBarIndex)) === JSON.stringify(pureCbcConfirmedBars),
            'StrictCBC chart pivots diverged from pure reset-aware CBC engine'
        );

        // Comprehensive 10-case Single-Bar Composite Comparison & Scale Tests
        const flatBaseCandles: ML1Candle[] = Array.from({ length: 368 }, (_, idx) => ({
            time: t0 + idx * interval,
            open: 100,
            high: 101,
            low: 99,
            close: 100,
            volume: 100
        }));

        // Case 1: VCS equals default volume (bar 360: solid teal, Diff: 0.0%)
        // Case 2: VCS exceeds default volume (bar 361: tighter range -> vcsRatio > defRatio, teal + amber)
        // Case 3: VCS below default volume (bar 362: wider range -> vcsRatio < defRatio, teal + grey)
        // Case 4: VCS = 3x default volume (bar 363: range solved for exact 3x -> +200.0%, amber = 2x teal)
        // Case 5: Zero default volume (bar 364: Diff: N/A, no division by zero)
        // Case 6: Ratio > 4 (bar 365: v = 600 -> ~6x defaultVolRatio, fixed 0-4x scale + overflow marker, uncapped tooltip)
        // Case 7: 5-minute discontinuity (bar 366: +300,000ms gap) followed by 362 clean post-gap bars at vol=500 to verify recovery
        const wideSpreadRange = 2.0 / 100 + 1 / 2000;
        const targetRange3x = ((wideSpreadRange / 3) - 1 / 2000) * 100;

        const cmpCandles: ML1Candle[] = flatBaseCandles.slice(0, 366).map((c, idx) => {
            if (idx === 361) return { ...c, high: 100.5, low: 99.5, volume: 100 };
            if (idx === 362) return { ...c, high: 102, low: 98, volume: 100 };
            if (idx === 363) return { ...c, high: 100 + targetRange3x * 0.5, low: 100 - targetRange3x * 0.5, volume: 100 };
            if (idx === 364) return { ...c, volume: 0 };
            if (idx === 365) return { ...c, volume: 600 };
            return c;
        });

        // Append 362 post-gap candles (bars 366..727) with distinct volume = 500 after a 5-minute discontinuity
        const postGapStart = t0 + 365 * interval + 300_000;
        for (let k = 0; k < 362; k++) {
            cmpCandles.push({
                time: postGapStart + k * interval,
                open: 100,
                high: 101,
                low: 99,
                close: 100,
                volume: 500
            });
        }

        const cmpDs = buildDataStore(cmpCandles);
        const vcsCmp = new VolumeCandleSizeIndicator();
        vcsCmp.calculate(cmpDs);

        // Bar 360: Equal -> solid teal, Diff: 0.0%, tooltip color = teal
        const g360 = vcsCmp.getCompositeBarGeometry(360);
        const r360 = vcsCmp.getValueAt(360, cmpDs, true, 0xffffff);
        assert(
            g360.mode === 'composite' && !g360.isOverflow && g360.amberTop === 0 && g360.greyTop === 0 &&
            r360.valueStr.includes('Diff: 0.0%') && r360.valueColor === 0x26A69A,
            'Equal VCS and Default Vol must render solid teal and Diff: 0.0%'
        );

        // Bar 361: VCS > Default Vol -> teal + amber, tooltip color = amber
        const g361 = vcsCmp.getCompositeBarGeometry(361);
        const r361 = vcsCmp.getValueAt(361, cmpDs, true, 0xffffff);
        assert(
            g361.mode === 'composite' && g361.amberTop > g361.amberBottom && g361.greyTop === 0 &&
            r361.valueStr.includes('Diff: +') && r361.valueColor === 0xFF9800,
            'VCS > Default Vol must render teal + amber and positive Diff'
        );

        // Bar 362: VCS < Default Vol -> teal + grey, tooltip color = grey
        const g362 = vcsCmp.getCompositeBarGeometry(362);
        const r362 = vcsCmp.getValueAt(362, cmpDs, true, 0xffffff);
        assert(
            g362.mode === 'composite' && g362.greyTop > g362.greyBottom && g362.amberTop === 0 &&
            r362.valueStr.includes('Diff: -') && r362.valueColor === 0x787B86,
            'VCS < Default Vol must render teal + grey and negative Diff'
        );

        // Bar 363: Verify actual generated ratios (VCS ~ 3.0, DefaultVol ~ 1.0) AND composite geometry
        const g363 = vcsCmp.getCompositeBarGeometry(363);
        const r363 = vcsCmp.getValueAt(363, cmpDs, true, 0xffffff);
        assert(
            Math.abs(vcsCmp.ratios[363] - 3.0) < 0.05 &&
            Math.abs(vcsCmp.defaultVolRatios[363] - 1.0) < 0.01 &&
            g363.mode === 'composite' &&
            Math.abs((g363.amberTop - g363.amberBottom) - 2 * g363.tealHeight) < 0.05 &&
            r363.valueStr.includes('VCS: 3.00x') && /Diff: \+(199|200)\.\d%/.test(r363.valueStr) && r363.valueColor === 0xFF9800,
            `3x VCS ratio/overflow mismatch: vcs=${vcsCmp.ratios[363]}, def=${vcsCmp.defaultVolRatios[363]}, ${r363.valueStr}`
        );

        // Bar 364: Zero volume -> Diff: N/A, no division by zero
        const r364 = vcsCmp.getValueAt(364, cmpDs, true, 0xffffff);
        assert(r364.valueStr.includes('Diff: N/A') && vcsCmp.ratios[364] === 0, 'Zero default volume must show Diff: N/A');

        // Bar 365: Ratio > 4 -> fixed 0-4x scale, rendered bar capped at 4x with overflow flag, tooltip uncapped
        const g365 = vcsCmp.getCompositeBarGeometry(365);
        const r365 = vcsCmp.getValueAt(365, cmpDs, true, 0xffffff);
        assert(
            vcsCmp.oscillatorScale!.min === 0 && vcsCmp.oscillatorScale!.max === 4 &&
            vcsCmp.defaultVolRatios[365] > 5.5 &&
            g365.isOverflow && Math.max(g365.tealHeight, g365.amberTop, g365.greyTop) === 4.0 &&
            r365.valueStr.includes('6.0'),
            `Bar > 4x must stay on fixed 0-4x scale with overflow marker and uncapped tooltip, got ${r365.valueStr}`
        );

        // Bar 366..726: Discontinuity resets baseline, stays unavailable for 360 post-gap bars, then recovers cleanly at bar 726 (volMean === 500)
        assert(vcsCmp.validMask[366] === 0 && vcsCmp.defaultVolValid[366] === 0, 'Bar 366 discontinuity must reset both baselines');
        assert(vcsCmp.validMask[725] === 0 && vcsCmp.defaultVolValid[725] === 0, 'Bar 725 (360th post-gap bar) must still be warming up');
        assert(
            vcsCmp.validMask[726] === 1 && vcsCmp.defaultVolValid[726] === 1 &&
            Math.abs(vcsCmp.defaultVolMeans[726] - 500) < 1e-9 &&
            Math.abs(vcsCmp.defaultVolRatios[726] - 1.0) < 1e-9 &&
            Math.abs(vcsCmp.ratios[726] - 1.0) < 1e-9,
            'Post-gap baseline must isolate pre-gap vol=100 and recover strictly on 360 post-gap bars of vol=500'
        );

        // Verify zero alteration to frozen Phase 1 ML1_CONFIG_C VolumeCandleSize feature values
        let mlState = createInitialML1FeatureStateV5(ML1_CONFIG_C);
        for (let idx = 0; idx < cmpCandles.length; idx++) {
            const step = stepML1FeaturesV5({ ...cmpCandles[idx], isSynthetic: false }, idx, mlState, ML1_CONFIG_C);
            mlState = step.nextState;
            const obs = step.observation;
            assert(
                (vcsCmp.validMask[idx] === 1) === obs.validity['VolumeCandleSize_Ratio_360'] &&
                vcsCmp.ratios[idx] === obs.features['VolumeCandleSize_Ratio_360'] &&
                vcsCmp.zScores[idx] === obs.features['VolumeCandleSize_ZScore_360'] &&
                vcsCmp.regimes[idx] === obs.features['VolumeCandleSize_Regime_360'],
                `Comparison-enabled VolumeCandleSizeIndicator diverged from frozen ML1_CONFIG_C at bar ${idx}`
            );
        }

        // Unavailable comparison state when VCS is valid but defaultVolValid === 0
        vcsCmp.defaultVolValid[360] = 0;
        const gUnavail = vcsCmp.getCompositeBarGeometry(360);
        const rUnavail = vcsCmp.getValueAt(360, cmpDs, true, 0xffffff);
        assert(
            gUnavail.mode === 'classic' && rUnavail.valueStr.includes('Comparison: Unavailable'),
            'Unavailable comparison must fall back to classic VCS bar and report Comparison: Unavailable'
        );
        vcsCmp.defaultVolValid[360] = 1;

        // Comparison disabled -> classic mode rendering & classic tooltip
        vcsCmp.updateParams({ compareDefaultVolume: false });
        vcsCmp.calculate(cmpDs);
        assert(
            vcsCmp.getCompositeBarGeometry(361).mode === 'classic' &&
            !vcsCmp.getValueAt(361, cmpDs, true, 0xffffff).valueStr.includes('Diff:'),
            'Disabling compareDefaultVolume must restore original VCS rendering and tooltip'
        );
    });

    runTest('2. Zero-Repainting Incremental Confirmation & DTFX Lifecycle (CREATED -> RETESTED -> INVALIDATED)', () => {
        const lcCandles: ML1Candle[] = [];
        for (let i = 0; i <= 15; i++) {
            if (i === 0) lcCandles.push({ time: t0, open: 105, high: 115, low: 104, close: 106, volume: 100 });
            else if (i === 5) lcCandles.push({ time: t0 + i * interval, open: 104, high: 106, low: 98, close: 103, volume: 100 });
            else lcCandles.push({ time: t0 + i * interval, open: 105, high: 108, low: 102, close: 105, volume: 100 });
        }
        lcCandles.push({ time: t0 + 16 * interval, open: 106, high: 118, low: 106, close: 117, volume: 100 }); // CREATED @16
        lcCandles.push({ time: t0 + 17 * interval, open: 117, high: 119, low: 116, close: 118, volume: 100 });
        lcCandles.push({ time: t0 + 18 * interval, open: 116, high: 117, low: 112, close: 114, volume: 100 }); // RETESTED @18
        lcCandles.push({ time: t0 + 19 * interval, open: 111, high: 111, low: 95, close: 96, volume: 100 });   // INVALIDATED @19

        const incDs = new DataStore(30);
        const indDtfx = new DTFXAlgoZonesIndicator();
        indDtfx.currentSymbol = 'SOLUSDT';

        let createdSnap = '';
        for (let i = 0; i < lcCandles.length; i++) {
            const c = lcCandles[i];
            incDs.appendOrUpdate(c.time, c.open, c.high, c.low, c.close, c.volume);
            indDtfx.update(incDs, true);

            if (i < 16) assert(indDtfx.zoneLifecycles.length === 0, `No DTFX zone before bar 16 (bar ${i})`);
            if (i === 16) {
                assert(indDtfx.zoneLifecycles.length === 1 && indDtfx.zoneLifecycles[0].zone.status === 'ACTIVE', 'CREATED @16');
                createdSnap = JSON.stringify(indDtfx.cachedEvents[0]);
            }
            if (i === 18) {
                assert(indDtfx.zoneLifecycles[0].zone.status === 'RETESTED', 'RETESTED @18');
                assert(JSON.stringify(indDtfx.cachedEvents[0]) === createdSnap, 'Confirmed CREATED event must never repaint');
            }
            if (i === 19) {
                assert(indDtfx.zoneLifecycles[0].zone.status === 'INVALIDATED' &&
                    indDtfx.zoneLifecycles[0].zone.invalidationBarIndex === 19, 'INVALIDATED @19');
            }
        }
    });

    runTest('3. Symbol/Timeframe Isolation & History Prepend Stability', () => {
        const fullCandles = makeFeed(180, t0, interval);
        const tailCandles = fullCandles.slice(60);

        const ds = buildDataStore(tailCandles);
        const indPhl = new ProtectedHighsLowsIndicator();
        const indCbc = new StrictCBCZigZagIndicator();
        indPhl.currentSymbol = 'BTCUSDT';
        indCbc.currentSymbol = 'BTCUSDT';
        indPhl.calculate(ds);
        indCbc.calculate(ds);

        // Simulate symbol/timeframe change -> reset clears state cleanly
        indPhl.reset();
        indCbc.reset();
        assert(indPhl.cachedEvents.length === 0 && indCbc.cachedPivots.length === 0, 'Reset must clear prior symbol/tf markers');

        // Simulate history prepend via DataStore.setAll (prepends 60 older candles and bumps revision)
        indPhl.currentSymbol = 'SOLUSDT';
        indCbc.currentSymbol = 'SOLUSDT';
        ds.setAll(fullCandles.map(c => [c.time, c.open, c.high, c.low, c.close, c.volume]));
        indPhl.reset();
        indCbc.reset();
        indPhl.calculate(ds);
        indCbc.calculate(ds);

        // Fresh full run must match prepended run 100% with zero duplicates
        const freshDs = buildDataStore(fullCandles);
        const freshPhl = new ProtectedHighsLowsIndicator();
        const freshCbc = new StrictCBCZigZagIndicator();
        freshPhl.currentSymbol = 'SOLUSDT';
        freshCbc.currentSymbol = 'SOLUSDT';
        freshPhl.calculate(freshDs);
        freshCbc.calculate(freshDs);

        assert(
            JSON.stringify(indPhl.cachedEvents) === JSON.stringify(freshPhl.cachedEvents) &&
            JSON.stringify(indCbc.cachedPivots) === JSON.stringify(freshCbc.cachedPivots),
            'History prepend + reset must produce identical markers with zero duplicates or displacement'
        );

        // Non-1m timeframe isolation on VolumeCandleSizeIndicator (15m -> 1m Only)
        const tf15Candles = makeFeed(400, t0, 900_000);
        const ds15 = buildDataStore(tf15Candles);
        const indVcs15 = new VolumeCandleSizeIndicator();
        indVcs15.calculate(ds15);
        assert(
            indVcs15.validMask[399] === 0 &&
            indVcs15.getValueAt(399, ds15, true, 0xffffff).valueStr === '1m Only',
            'VolumeCandleSize must stay inactive/non-1m-gated on 15m charts'
        );
    });

    console.log(`\nPhase 5D Phase 5 Visual-vs-Engine Acceptance: ${passed} passed, ${failed} failed.`);
    return failed === 0;
}
