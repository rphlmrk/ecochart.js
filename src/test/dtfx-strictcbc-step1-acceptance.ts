import { DataStore } from '../data/DataStore';
import { TimeframeResampler } from '../data/TimeframeResampler';
import { IndicatorManager } from '../indicators/IndicatorManager';
import { IndicatorRegistry } from '../indicators/IndicatorRegistry';
import {
    DTFXAlgoZonesIndicator,
    DTFXStrictCBCIndicator,
    StrictCBCZigZagIndicator
} from '../indicators/plugins';
import {
    createDefaultDTFXConfig,
    createInitialDTFXState,
    stepDTFX
} from '../indicators/mlr1/teachers/DTFXAlgoZonesTeacher';
import { updateWilderATR } from '../indicators/mlr1/volatility/ATR';
import { stepStrictCBCWithReset } from '../indicators/mlr1/teachers/StrategyEventTypes';
import type { ATRPeriodState, ML1Candle } from '../indicators/mlr1/ML1FeatureTypes';
import type { StrictCBCState, StrictZigZagPivot } from '../indicators/plugins/StrictCBCZigZagIndicator';

function assert(condition: boolean, msg: string): asserts condition {
    if (!condition) throw new Error(`[DTFXStrictCBCStep1Failed] ${msg}`);
}

function makeBucketAligned1mStream(
    count: number,
    startTime = 1_700_000_100_000, // 2023-11-14T22:15:00.000Z (aligned to 3m, 5m, 15m)
    gapAtIndex?: number,
    gapDurationMs = 0
): ML1Candle[] {
    const out: ML1Candle[] = [];
    let ts = startTime;
    let p = 100;
    for (let i = 0; i < count; i++) {
        if (gapAtIndex !== undefined && i === gapAtIndex) {
            ts += gapDurationMs;
        }
        const cycle = i % 96;
        const amp = 1.2 + (Math.floor(i / 48) % 3) * 0.4;
        const delta = cycle < 44
            ? (i % 7 === 0 ? -0.9 : amp)
            : (i % 7 === 0 ? 0.9 : -amp);
        const o = p;
        const c = Math.max(20, p + delta);
        out.push({
            time: ts,
            open: o,
            high: Math.max(o, c) + 0.6,
            low: Math.min(o, c) - 0.6,
            close: c,
            volume: 100 + (i % 11) * 15
        });
        p = c;
        ts += 60_000;
    }
    return out;
}

function toDataStore(candles: readonly ML1Candle[]): DataStore {
    const ds = new DataStore(candles.length);
    ds.setAll(candles.map(c => [c.time, c.open, c.high, c.low, c.close, c.volume]));
    return ds;
}

export function runDTFXStrictCBCStep1Tests(): boolean {
    console.log('\n======================================================');
    console.log('🧪 Starting DTFXStrictCBCIndicator Step 1 Acceptance Suite');
    console.log('======================================================\n');
    let passed = 0;
    let failed = 0;

    const runTest = (name: string, fn: () => void) => {
        try {
            fn();
            passed++;
            console.log(`  ✅ Passed: ${name}`);
        } catch (err: unknown) {
            failed++;
            console.error(`  ❌ Failed: ${name} - ${err instanceof Error ? err.message : String(err)}`);
        }
    };

    runTest('1. Normal DTFXAlgoZonesIndicator isolation and pure-engine parity remain 100% unchanged', () => {
        const candles = makeBucketAligned1mStream(360, 1_700_000_100_000, 180, 10 * 60_000);
        const ds = toDataStore(candles);

        const normalDtfx = new DTFXAlgoZonesIndicator();
        normalDtfx.currentSymbol = 'SOLUSDT';
        normalDtfx.calculate(ds);

        assert(normalDtfx.id === 'DTFX_ZONES', `Expected DTFX_ZONES id, got ${normalDtfx.id}`);
        assert(normalDtfx.name === 'DTFX Algo Zones', `Expected DTFX Algo Zones name, got ${normalDtfx.name}`);

        let dtfxState = createInitialDTFXState();
        let atrState: ATRPeriodState | undefined;
        let prevClose: number | null = null;
        const cfg = createDefaultDTFXConfig('SOLUSDT', '1m', 60_000);
        const pureEvents: string[] = [];

        for (let i = 0; i < candles.length; i++) {
            const c = candles[i];
            const isDisc = i > 0 && (c.time - candles[i - 1].time) >= 300_000;
            const atrStep = updateWilderATR(c.high, c.low, prevClose, 14, atrState, isDisc);
            atrState = atrStep.nextState;
            prevClose = c.close;
            const atrVal = atrStep.isValid && atrStep.atrValue > 0 ? atrStep.atrValue : null;
            const step = stepDTFX(c, i, dtfxState, cfg, isDisc, atrVal, null);
            dtfxState = step.nextState;
            pureEvents.push(...step.events.map(e => `${e.eventType}@${e.confirmationBarIndex}`));
        }

        assert(
            JSON.stringify(normalDtfx.cachedEvents.map(e => `${e.eventType}@${e.confirmationBarIndex}`)) === JSON.stringify(pureEvents),
            'Normal DTFXAlgoZonesIndicator events diverged from pure DTFX teacher engine'
        );
        assert(normalDtfx.zoneLifecycles.length > 0, 'Expected normal DTFX indicator to produce zones');
    });

    runTest('2. Simultaneous IndicatorManager load, catalog disambiguation & IndicatorRegistry workspace persistence', () => {
        const candles = makeBucketAligned1mStream(360);
        const ds = toDataStore(candles);

        const manager = new IndicatorManager();
        const normalDtfx = new DTFXAlgoZonesIndicator();
        const strictDtfx = new DTFXStrictCBCIndicator();

        normalDtfx.updateParams({ structureLen: 8, bullZoneColor: '#12345633' });
        strictDtfx.updateParams({
            timeframe: '15m',
            bullZoneColor: '#11AA88',
            bearZoneColor: '#DD3344',
            f2Lvl: 0.382,
            zoneDispNum: 3
        });

        manager.addIndicator(normalDtfx);
        manager.addIndicator(strictDtfx);
        manager.update(ds);

        assert(normalDtfx.id === 'DTFX_ZONES', 'Normal DTFX ID mismatch');
        assert(strictDtfx.id === 'DTFX_STRICTCBC_ZONES', 'StrictCBC DTFX ID mismatch');
        assert(strictDtfx.name === 'DTFX Algo Zones (StrictCBC) [15m]', `Unexpected HTF legend name: ${strictDtfx.name}`);
        assert(!(strictDtfx instanceof DTFXAlgoZonesIndicator), 'Class inheritance must stay isolated');

        // Verify catalog matching logic mirrors src/index.ts mutual exclusivity
        const matchDtfxZones = manager.activeIndicators.find(
            i => (i instanceof DTFXAlgoZonesIndicator) && !(i instanceof DTFXStrictCBCIndicator)
        );
        const matchStrictCbc = manager.activeIndicators.find(
            i => i instanceof DTFXStrictCBCIndicator || i.id === 'DTFX_STRICTCBC_ZONES'
        );
        assert(matchDtfxZones === normalDtfx && matchStrictCbc === strictDtfx, 'Catalog matchers must isolate both DTFX plugins');

        const serialized = manager.activeIndicators.map(ind => IndicatorRegistry.serialize(ind));
        assert(serialized[0].type === 'DTFX_ZONES', `Expected serialized type DTFX_ZONES, got ${serialized[0].type}`);
        assert(serialized[1].type === 'DTFX_STRICTCBC_ZONES', `Expected serialized type DTFX_STRICTCBC_ZONES, got ${serialized[1].type}`);

        const restoredManager = new IndicatorManager();
        for (const state of serialized) {
            const restored = IndicatorRegistry.deserialize(state);
            assert(restored !== null, `Failed to deserialize ${state.type}`);
            restoredManager.addIndicator(restored);
        }
        restoredManager.update(ds);

        const restoredNormal = restoredManager.activeIndicators[0];
        const restoredStrict = restoredManager.activeIndicators[1];
        assert(restoredNormal instanceof DTFXAlgoZonesIndicator && !(restoredNormal instanceof DTFXStrictCBCIndicator),
            'Restored normal indicator type mismatch');
        assert(restoredStrict instanceof DTFXStrictCBCIndicator, 'Restored StrictCBC indicator type mismatch');
        assert(restoredNormal.getParam<number>('structureLen', -1) === 8, 'Normal DTFX params not restored');
        assert(restoredStrict.getParam<string>('timeframe', '') === '15m', 'StrictCBC timeframe not restored');
        assert(restoredStrict.getParam<string>('bullZoneColor', '') === '#11AA88', 'StrictCBC color not restored');
        assert(restoredStrict.getParam<number>('f2Lvl', -1) === 0.382, 'StrictCBC fib param not restored');
        assert(restoredStrict.getParam<number>('zoneDispNum', -1) === 3, 'StrictCBC zoneDispNum not restored');
        assert(restoredStrict.name === 'DTFX Algo Zones (StrictCBC) [15m]', 'Restored HTF legend name mismatch');
        assert(
            JSON.stringify(restoredStrict.cachedPivots) === JSON.stringify(strictDtfx.cachedPivots) &&
                JSON.stringify(restoredStrict.cachedZones) === JSON.stringify(strictDtfx.cachedZones),
            'Restored StrictCBC outputs must match pre-persistence outputs'
        );
        assert(
            JSON.stringify(restoredNormal.cachedEvents) === JSON.stringify(normalDtfx.cachedEvents),
            'Restored normal DTFX events must match pre-persistence outputs'
        );
    });

    runTest('3. HTF vs Canonical StrictCBC parity across 3m, 5m, and 15m', () => {
        const candles = makeBucketAligned1mStream(450); // 150 x 3m, 90 x 5m, 30 x 15m complete aligned buckets
        const ds = toDataStore(candles);

        for (const tf of ['3m', '5m', '15m'] as const) {
            const tfMs = TimeframeResampler.parseMs(tf);
            interface Bucket {
                time: number;
                open: number;
                high: number;
                low: number;
                close: number;
                lastChartBar: number;
                peakChartBar: number;
                troughChartBar: number;
            }
            const buckets: Bucket[] = [];
            let currTime = -1;
            let curr: Bucket | null = null;

            for (let i = 0; i < candles.length; i++) {
                const c = candles[i];
                const bTime = TimeframeResampler.getBucketStart(c.time, tfMs);
                if (bTime !== currTime) {
                    currTime = bTime;
                    curr = {
                        time: bTime,
                        open: c.open,
                        high: c.high,
                        low: c.low,
                        close: c.close,
                        lastChartBar: i,
                        peakChartBar: i,
                        troughChartBar: i
                    };
                    buckets.push(curr);
                } else if (curr) {
                    curr.lastChartBar = i;
                    curr.close = c.close;
                    if (c.high > curr.high) {
                        curr.high = c.high;
                        curr.peakChartBar = i;
                    }
                    if (c.low < curr.low) {
                        curr.low = c.low;
                        curr.troughChartBar = i;
                    }
                }
            }

            // Canonical StrictCBCZigZagIndicator run directly on resampled HTF DataStore
            const htfDs = new DataStore(buckets.length);
            htfDs.setAll(buckets.map(b => [b.time, b.open, b.high, b.low, b.close, 100]));
            const canonicalZigZag = new StrictCBCZigZagIndicator();
            canonicalZigZag.calculate(htfDs);

            // Also cross-check direct stepStrictCBCWithReset stepping
            let cbcState: StrictCBCState | null = null;
            let prevPivot: StrictZigZagPivot | null = null;
            const expectedMapped: StrictZigZagPivot[] = [];
            for (let bIdx = 0; bIdx < buckets.length; bIdx++) {
                const b = buckets[bIdx];
                const step = stepStrictCBCWithReset(
                    { time: b.time, open: b.open, high: b.high, low: b.low, close: b.close },
                    bIdx,
                    cbcState,
                    prevPivot,
                    false
                );
                cbcState = step.nextState;
                if (step.confirmedPivot) {
                    prevPivot = step.confirmedPivot;
                    const srcBucket = buckets[step.confirmedPivot.barIndex];
                    const chartBarIdx = step.confirmedPivot.type === 'high'
                        ? srcBucket.peakChartBar
                        : srcBucket.troughChartBar;
                    expectedMapped.push({
                        ...step.confirmedPivot,
                        barIndex: chartBarIdx,
                        time: candles[chartBarIdx].time,
                        confirmedBarIndex: b.lastChartBar
                    });
                }
            }

            assert(
                canonicalZigZag.cachedPivots.length === expectedMapped.length &&
                    expectedMapped.length > 3,
                `Expected >3 canonical HTF pivots for ${tf}, got ${expectedMapped.length}`
            );
            for (let k = 0; k < expectedMapped.length; k++) {
                assert(
                    canonicalZigZag.cachedPivots[k].price === expectedMapped[k].price &&
                        canonicalZigZag.cachedPivots[k].type === expectedMapped[k].type &&
                        canonicalZigZag.cachedPivots[k].label === expectedMapped[k].label,
                    `Canonical StrictCBCZigZag mismatch at pivot ${k} on ${tf}`
                );
            }

            const dtfxStrict = new DTFXStrictCBCIndicator();
            dtfxStrict.updateParams({ timeframe: tf });
            dtfxStrict.calculate(ds);

            assert(
                JSON.stringify(dtfxStrict.cachedPivots) === JSON.stringify(expectedMapped),
                `DTFXStrictCBCIndicator HTF pivots diverged from canonical StrictCBC on ${tf}`
            );
        }
    });

    runTest('4. HTF confirmation timing: zero pivots or zones confirm before HTF bucket closes (3m, 5m, 15m)', () => {
        const candles = makeBucketAligned1mStream(450);

        for (const [tf, barsPerBucket] of [['3m', 3], ['5m', 5], ['15m', 15]] as const) {
            const dtfxStrict = new DTFXStrictCBCIndicator();
            dtfxStrict.updateParams({ timeframe: tf });

            let lastClosedPivots: typeof dtfxStrict.cachedPivots = [];
            let lastClosedZones: typeof dtfxStrict.cachedZones = [];

            for (let len = 1; len <= candles.length; len++) {
                const prefixDs = toDataStore(candles.slice(0, len));
                dtfxStrict.calculate(prefixDs);

                if (len % barsPerBucket !== 0) {
                    // Up to 1 bar before HTF bucket closes: no new pivot or zone may confirm early
                    assert(
                        dtfxStrict.cachedPivots.length === lastClosedPivots.length,
                        `${tf} prefix len=${len} prematurely confirmed pivot before bucket close`
                    );
                    assert(
                        dtfxStrict.cachedZones.length === lastClosedZones.length,
                        `${tf} prefix len=${len} prematurely confirmed zone before bucket close`
                    );
                } else {
                    for (const p of dtfxStrict.cachedPivots) {
                        assert(
                            (p.confirmedBarIndex + 1) % barsPerBucket === 0,
                            `${tf} pivot confirmedBarIndex=${p.confirmedBarIndex} is not a bucket closing bar`
                        );
                    }
                    for (const z of dtfxStrict.cachedZones) {
                        assert(
                            (z.rightBar + 1) % barsPerBucket === 0,
                            `${tf} zone rightBar=${z.rightBar} is not a bucket closing bar`
                        );
                    }
                    lastClosedPivots = dtfxStrict.cachedPivots.map(p => ({ ...p }));
                    lastClosedZones = dtfxStrict.cachedZones.map(z => ({ ...z, fibs: [...z.fibs] }));
                }
            }
            assert(lastClosedPivots.length > 0 && lastClosedZones.length > 0,
                `Expected confirmed pivots & zones on ${tf} full stream`);
        }
    });

    runTest('5. HTF discontinuity reset enforces Math.max(300_000, tfMs * 5) on 5m and 15m', () => {
        // Test A: 5m base chart + 15m HTF mode (tfMs = 15m => threshold = 75m; raw 5m threshold = 25m)
        // Build clean 5m candles forming 6 pre-gap 15m bars with alternating High/Low pivots + active MSS zone
        const baseCandles5m: ML1Candle[] = [];
        const t0 = 1_700_000_100_000; // 22:15:00Z (aligned to 15m)
        const htfPatterns5m = [
            // 15m #0 (bull): H=105, L=99, C=104
            [[100, 102, 99, 101], [101, 104, 100, 103], [103, 105, 102, 104]],
            // 15m #1 (strong rally -> sets higher phaseHigh=112): C=111
            [[104, 107, 103, 106], [106, 110, 105, 109], [109, 112, 108, 111]],
            // 15m #2 (bear flip: close < 108 -> confirms Swing High @ 112): C=105
            [[111, 111.5, 108, 109], [109, 109.5, 106, 107], [107, 107.5, 104, 105]],
            // 15m #3 (down): C=98
            [[105, 105.5, 101, 102], [102, 102.5, 99, 100], [100, 100.5, 97, 98]],
            // 15m #4 (bull flip: close > 100.5 -> confirms Swing Low @ 97): C=104
            [[98, 101, 97.5, 100], [100, 103, 99.5, 102], [102, 105, 101.5, 104]],
            // 15m #5 (BOS up > 112? No, keep close=110 so bosUpCheck remains armed & tDir still 0 or 1)
            [[104, 107, 103.5, 106], [106, 109, 105.5, 108], [108, 111, 107.5, 110]]
        ];

        for (let b = 0; b < htfPatterns5m.length; b++) {
            const bStart = t0 + b * 15 * 60_000;
            for (let s = 0; s < 3; s++) {
                const [o, h, l, c] = htfPatterns5m[b][s];
                baseCandles5m.push({ time: bStart + s * 5 * 60_000, open: o, high: h, low: l, close: c, volume: 100 });
            }
        }

        // Case A1: Sub-threshold HTF gap (skip 1x 15m bucket -> 5m gap = 20m < 25m rawDisc, HTF gap = 30m < 75m)
        // Post-gap bar breaks above t.price (112) to prove pre-gap structure t=112 & lastHighPrice=112 were RETAINED
        const subGapStart = t0 + 7 * 15 * 60_000; // skipped bucket #6 (15m #6)
        const subGapCandles: ML1Candle[] = [
            ...baseCandles5m,
            { time: subGapStart, open: 110, high: 112, low: 109.5, close: 111.5, volume: 100 },
            { time: subGapStart + 5 * 60_000, open: 111.5, high: 114, low: 111, close: 113.5, volume: 100 },
            { time: subGapStart + 10 * 60_000, open: 113.5, high: 115, low: 113, close: 114.5, volume: 100 } // closes 114.5 > t.price=112 => triggers bullish MSS zone!
        ];
        const subGapInd = new DTFXStrictCBCIndicator();
        subGapInd.updateParams({ timeframe: '15m' });
        subGapInd.calculate(toDataStore(subGapCandles));
        assert(
            subGapInd.cachedZones.some(z => z.direction === 1 && z.top === 112 && z.rightBar === subGapCandles.length - 1),
            'Sub-threshold gap (< tfMs * 5 without internal raw gap) must preserve pre-gap t=112 and trigger bullish zone'
        );

        // Case A2: Exact >= tfMs * 5 gap (75m between bucket #5 start and post-gap bucket start -> 01:30 + 75m)
        // Even though post-gap bar closes at 114.5 > old t.price (112), structure MUST reset cleanly (no stale zone, trend=0)
        // And subsequent post-gap flip at high=108 (< old lastHighPrice 112) MUST label 'HH' (proving lastHighPrice reset to null)
        const discStart = (t0 + 5 * 15 * 60_000) + 75 * 60_000;
        const postDiscPatterns = [
            // Post-gap bar 0 (discontinuity bar -> skipped/initialized cleanly to H=115, L=109): C=114.5 (> old t=112!)
            [[110, 112, 109, 111], [111, 114, 110.5, 113], [113, 115, 112.5, 114.5]],
            // Post-gap bar 1 (rises mildly to H=118): C=117
            [[114.5, 116, 114, 115.5], [115.5, 117, 115, 116.5], [116.5, 118, 116, 117]],
            // Post-gap bar 2 (bear flip: C < 114 -> confirms HIGH @ 118; if lastHighPrice hadn't reset, wait: pick lower than 112!):
            // Actually drop prices to ~106 first! So post-gap HH=108 < pre-gap 112!
        ];
        void postDiscPatterns;

        const lowRangePostGapPatterns = [
            // Post-gap bar 0 (discontinuity bar -> reset): H=106, L=102, C=105
            [[103, 105, 102, 104], [104, 105.5, 103.5, 105], [105, 106, 104, 105]],
            // Post-gap bar 1 (continues slightly up): H=108, L=104.5, C=107
            [[105, 106.5, 104.5, 106], [106, 107.5, 105.5, 107], [107, 108, 106.5, 107]],
            // Post-gap bar 2 (bear flip: C=103 < anchorLow=104.5 -> confirms Swing High @ 108; < old lastHighPrice=112 => MUST be 'HH'!)
            [[107, 107.5, 105, 105.5], [105.5, 106, 103.5, 104], [104, 104.5, 102.5, 103]]
        ];

        const discCandles15m: ML1Candle[] = [...baseCandles5m];
        for (let b = 0; b < lowRangePostGapPatterns.length; b++) {
            const bStart = discStart + b * 15 * 60_000;
            for (let s = 0; s < 3; s++) {
                const [o, h, l, c] = lowRangePostGapPatterns[b][s];
                discCandles15m.push({ time: bStart + s * 5 * 60_000, open: o, high: h, low: l, close: c, volume: 100 });
            }
        }
        const discInd15m = new DTFXStrictCBCIndicator();
        discInd15m.updateParams({ timeframe: '15m' });
        discInd15m.calculate(toDataStore(discCandles15m));

        // Verify post-gap trend reset to 0 and no stale crossover zone against old t=112 or b=97
        const firstPostGapBar = baseCandles5m.length;
        assert(discInd15m.trends[firstPostGapBar] === 0, 'Trend tDir must reset to 0 on >= tfMs*5 HTF discontinuity');
        const postGapZonesAtBar0 = discInd15m.cachedZones.filter(z => z.rightBar >= firstPostGapBar);
        assert(postGapZonesAtBar0.length === 0, 'Stale pre-gap t/b/bosUpCheck/bosDownCheck must not emit post-gap zones');

        const postGapFirstPivot = discInd15m.cachedPivots.find(p => p.barIndex >= firstPostGapBar);
        assert(postGapFirstPivot !== undefined, 'Expected a confirmed post-gap HTF high pivot');
        assert(
            postGapFirstPivot.price === 108 && postGapFirstPivot.label === 'HH',
            `Expected post-gap 108 high pivot to reset lastHighPrice and label 'HH' (got ${postGapFirstPivot.label} @ ${postGapFirstPivot.price})`
        );

        // Test B: 1m base chart + 5m HTF mode with 25m discontinuity gap (>= tfMs * 5 = 25m)
        const feed5mDisc = makeBucketAligned1mStream(120, t0, 60, 25 * 60_000);
        const ind5mDisc = new DTFXStrictCBCIndicator();
        ind5mDisc.updateParams({ timeframe: '5m' });
        ind5mDisc.calculate(toDataStore(feed5mDisc));
        assert(ind5mDisc.trends[60] === 0, '5m HTF trend must reset to 0 at 25m discontinuity bar');
    });

    runTest('6. getTimeframeOptions hides timeframes <= chart interval', () => {
        const ind = new DTFXStrictCBCIndicator();
        const opts1m = ind.getTimeframeOptions('1m');
        assert(opts1m[0] === 'Current' && opts1m[opts1m.length - 1] === 'Custom HTF', 'Unexpected bounds on 1m options');
        assert(opts1m.includes('3m') && opts1m.includes('5m') && opts1m.includes('15m'), '1m chart must expose 3m, 5m, 15m');
        assert(!opts1m.includes('1m'), '1m chart must not expose 1m in HTF list (uses Current)');

        const opts5m = ind.getTimeframeOptions('5m');
        assert(!opts5m.includes('1m') && !opts5m.includes('3m') && !opts5m.includes('5m'),
            `5m chart must exclude <=5m options, got ${opts5m.join(',')}`);
        assert(opts5m.includes('15m') && opts5m[0] === 'Current', '5m chart must expose Current and 15m');

        const opts15m = ind.getTimeframeOptions('15m');
        assert(!opts15m.includes('1m') && !opts15m.includes('3m') && !opts15m.includes('5m') && !opts15m.includes('15m'),
            `15m chart must exclude <=15m options, got ${opts15m.join(',')}`);
    });

    console.log(`\nDTFXStrictCBCIndicator Step 1 Acceptance: ${passed} passed, ${failed} failed.`);
    return failed === 0;
}
