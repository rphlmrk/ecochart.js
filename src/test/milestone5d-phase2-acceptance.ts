import {
    adaptStrictCBCtoStrategyEvent,
    adaptVAMtoStrategyEvent,
    buildStrategyEventId,
    createStrategyEvent,
    resolveStrategyEventsEntryTimestamps,
    sortAndVerifyUniqueStrategyEvents,
    stepStrictCBCWithReset,
    type StrategyEvent
} from '../indicators/mlr1/teachers/StrategyEventTypes';
import {
    createDefaultPHLConfig,
    createInitialPHLState,
    stepPHL
} from '../indicators/mlr1/teachers/ProtectedHighsLowsTeacher';
import {
    createDefaultDTFXConfig,
    createInitialDTFXState,
    stepDTFX,
    type DTFXState
} from '../indicators/mlr1/teachers/DTFXAlgoZonesTeacher';
import {
    STRICT_CBC_ZIGZAG_TEACHER_VERSION,
    type StrictCBCState,
    type StrictZigZagPivot
} from '../indicators/plugins/StrictCBCZigZagIndicator';
import { createInitialVAMState, stepVolatilityAdjustedMean } from '../indicators/mlr1/trend/VolatilityAdjustedMean';
import type { ML1Candle } from '../indicators/mlr1/ML1FeatureTypes';

function assert(condition: boolean, msg: string): asserts condition {
    if (!condition) throw new Error(`[Phase5DPhase2Failed] ${msg}`);
}

function makeCandle(time: number, open: number, high: number, low: number, close: number, volume = 100): ML1Candle {
    return { time, open, high, low, close, volume, isSynthetic: false };
}

export function runPhase5DPhase2Gate1Tests(): boolean {
    console.log('\n======================================================');
    console.log('🧪 Starting Phase 5D Phase 2 GATE 1 (StrategyEvent Contract)');
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
    const interval = 60_000;

    runTest('Gate1.1: Unambiguous SE1 eventId encoding, duplicate rejection & 4-level sort', () => {
        const id1 = buildStrategyEventId({
            strategyId: 'PHL_BOS_MSS', strategyVersion: 'v1', symbol: 'A_B', timeframe: 'C',
            eventType: 'PHL_MSS_BULL', sourceBarIndex: 5, confirmationBarIndex: 8, eventDiscriminator: 'PH'
        });
        const id2 = buildStrategyEventId({
            strategyId: 'PHL_BOS_MSS', strategyVersion: 'v1', symbol: 'A', timeframe: 'B_C',
            eventType: 'PHL_MSS_BULL', sourceBarIndex: 5, confirmationBarIndex: 8, eventDiscriminator: 'PH'
        });
        assert(id1 !== id2, 'Delimiter split A_B + C vs A + B_C must never collide');

        const idPipe1 = buildStrategyEventId({
            strategyId: 'DTFX_ZONES', strategyVersion: '1|2:X', symbol: 'SOL|USDT', timeframe: '1m',
            eventType: 'DTFX_DEMAND_RETEST', sourceBarIndex: 10, confirmationBarIndex: 10, eventDiscriminator: '1_R1'
        });
        const idPipe2 = buildStrategyEventId({
            strategyId: 'DTFX_ZONES', strategyVersion: '1', symbol: '2:X|8:SOL|USDT', timeframe: '1m',
            eventType: 'DTFX_DEMAND_RETEST', sourceBarIndex: 10, confirmationBarIndex: 10, eventDiscriminator: '1_R1'
        });
        assert(idPipe1 !== idPipe2, 'Pipe/length delimiter injection must never collide');

        const evDtfxR2 = createStrategyEvent({
            strategyId: 'DTFX_ZONES', strategyVersion: 'DTFX_ZONES_v1', symbol: 'SOLUSDT', timeframe: '1m',
            intervalMs: interval, eventType: 'DTFX_DEMAND_RETEST', eventDirection: 'bull',
            eventDiscriminator: '2_R1', sourceBarIndex: 30, sourceTimestamp: t0 + 30 * interval,
            confirmationBarIndex: 30, confirmationTimestamp: t0 + 30 * interval,
            entryTimestamp: t0 + 31 * interval, structuralContext: { zoneId: 2 }
        });
        const evDtfxR1 = createStrategyEvent({
            strategyId: 'DTFX_ZONES', strategyVersion: 'DTFX_ZONES_v1', symbol: 'SOLUSDT', timeframe: '1m',
            intervalMs: interval, eventType: 'DTFX_DEMAND_RETEST', eventDirection: 'bull',
            eventDiscriminator: '1_R1', sourceBarIndex: 30, sourceTimestamp: t0 + 30 * interval,
            confirmationBarIndex: 30, confirmationTimestamp: t0 + 30 * interval,
            entryTimestamp: t0 + 31 * interval, structuralContext: { zoneId: 1 }
        });
        const evDtfxCreate = createStrategyEvent({
            strategyId: 'DTFX_ZONES', strategyVersion: 'DTFX_ZONES_v1', symbol: 'SOLUSDT', timeframe: '1m',
            intervalMs: interval, eventType: 'DTFX_DEMAND_CREATED', eventDirection: 'bull',
            eventDiscriminator: '3', sourceBarIndex: 20, sourceTimestamp: t0 + 20 * interval,
            confirmationBarIndex: 30, confirmationTimestamp: t0 + 30 * interval,
            entryTimestamp: t0 + 31 * interval, structuralContext: { zoneId: 3 }
        });
        const evCbc = createStrategyEvent({
            strategyId: 'STRICT_CBC', strategyVersion: 'StrictCBCZigZag_v1', symbol: 'SOLUSDT', timeframe: '1m',
            intervalMs: interval, eventType: 'CBC_LOW_HL', eventDirection: 'bull',
            eventDiscriminator: '4', sourceBarIndex: 28, sourceTimestamp: t0 + 28 * interval,
            confirmationBarIndex: 30, confirmationTimestamp: t0 + 30 * interval,
            entryTimestamp: t0 + 31 * interval, structuralContext: {}
        });
        const evVam = createStrategyEvent({
            strategyId: 'VAM_REVERSAL', strategyVersion: 'VAM_v1', symbol: 'SOLUSDT', timeframe: '1m',
            intervalMs: interval, eventType: 'VAM_BUY', eventDirection: 'bull',
            eventDiscriminator: 'BUY', sourceBarIndex: 30, sourceTimestamp: t0 + 30 * interval,
            confirmationBarIndex: 30, confirmationTimestamp: t0 + 30 * interval,
            entryTimestamp: t0 + 31 * interval, structuralContext: {}
        });

        const sorted = sortAndVerifyUniqueStrategyEvents([evVam, evDtfxR2, evCbc, evDtfxR1, evDtfxCreate]);
        assert(
            sorted[0] === evDtfxCreate &&
            sorted[1] === evDtfxR1 &&
            sorted[2] === evDtfxR2 &&
            sorted[3] === evCbc &&
            sorted[4] === evVam,
            'Canonical tie-breaking sort order failed'
        );

        const expectDupReject = (arr: StrategyEvent[], label: string) => {
            let threw = false;
            try { sortAndVerifyUniqueStrategyEvents(arr); } catch (e: any) { threw = String(e.message).includes('Collision'); }
            assert(threw, `${label}: expected collision error`);
        };
        expectDupReject([evDtfxR1, evDtfxR1], 'same reference twice');
        expectDupReject([evDtfxR1, { ...evDtfxR1, structuralContext: Object.freeze({ zoneId: 999 }) }], 'same ID different payload');
        const evClone = createStrategyEvent({
            strategyId: 'DTFX_ZONES', strategyVersion: 'DTFX_ZONES_v1', symbol: 'SOLUSDT', timeframe: '1m',
            intervalMs: interval, eventType: 'DTFX_DEMAND_RETEST', eventDirection: 'bull',
            eventDiscriminator: '1_R1', sourceBarIndex: 30, sourceTimestamp: t0 + 30 * interval,
            confirmationBarIndex: 30, confirmationTimestamp: t0 + 30 * interval,
            entryTimestamp: t0 + 31 * interval, structuralContext: { zoneId: 1 }
        });
        expectDupReject([evDtfxR1, evClone], 'identical tuple recreated');
    });

    runTest('Gate1.2: Factory input validation (VAM lag=0, clock check, nested context, bad fields)', () => {
        const expectInvalid = (fn: () => void, label: string) => {
            let threw = false;
            try { fn(); } catch { threw = true; }
            assert(threw, `${label}: expected contract rejection`);
        };

        expectInvalid(() => createStrategyEvent({
            strategyId: 'VAM_REVERSAL', strategyVersion: 'VAM_v1', symbol: 'SOLUSDT', timeframe: '1m',
            intervalMs: interval, eventType: 'VAM_BUY', eventDirection: 'bull', eventDiscriminator: 'BUY',
            sourceBarIndex: 9, sourceTimestamp: t0 + 9 * interval, confirmationBarIndex: 10, confirmationTimestamp: t0 + 10 * interval,
            entryTimestamp: null, structuralContext: {}
        }), 'VAM lag > 0');

        expectInvalid(() => createStrategyEvent({
            strategyId: 'VAM_REVERSAL', strategyVersion: 'VAM_v1', symbol: 'SOLUSDT', timeframe: '1m',
            intervalMs: interval, eventType: 'VAM_BUY', eventDirection: 'bull', eventDiscriminator: 'BUY',
            sourceBarIndex: 10, sourceTimestamp: t0 + 9 * interval, confirmationBarIndex: 10, confirmationTimestamp: t0 + 10 * interval,
            entryTimestamp: null, structuralContext: {}
        }), 'VAM sourceTimestamp != confirmationTimestamp');

        expectInvalid(() => createStrategyEvent({
            strategyId: 'PHL_BOS_MSS', strategyVersion: 'v1', symbol: 'SOLUSDT', timeframe: '1m',
            intervalMs: interval, eventType: 'PHL_MSS_BULL', eventDirection: 'bull', eventDiscriminator: 'PH',
            sourceBarIndex: 1, sourceTimestamp: t0, confirmationBarIndex: 2, confirmationTimestamp: t0 + interval,
            entryTimestamp: null, structuralContext: { nested: { a: 1 } } as any
        }), 'nested structuralContext');

        expectInvalid(() => createStrategyEvent({
            strategyId: 'PHL_BOS_MSS', strategyVersion: 'v1', symbol: 'SOLUSDT', timeframe: '1m',
            intervalMs: interval, eventType: 'PHL_MSS_BULL', eventDirection: 'bull', eventDiscriminator: 'PH',
            sourceBarIndex: 0, sourceTimestamp: t0, confirmationBarIndex: 1, confirmationTimestamp: t0 + interval,
            entryTimestamp: t0 + 99 * interval, structuralContext: {},
            acceptedTimestampsByBarIndex: [t0, t0 + interval, t0 + 2 * interval]
        }), 'factory wrong entryTimestamp vs accepted clock');

        expectInvalid(() => createStrategyEvent({
            strategyId: 'PHL_BOS_MSS', strategyVersion: 'v1', symbol: 'SOLUSDT', timeframe: '1m',
            intervalMs: 0, eventType: 'PHL_MSS_BULL', eventDirection: 'bull', eventDiscriminator: 'PH',
            sourceBarIndex: 1, sourceTimestamp: t0, confirmationBarIndex: 2, confirmationTimestamp: t0 + interval,
            entryTimestamp: null, structuralContext: {}
        }), 'intervalMs=0');

        expectInvalid(() => createStrategyEvent({
            strategyId: 'PHL_BOS_MSS', strategyVersion: 'v1', symbol: 'SOLUSDT', timeframe: '1m',
            intervalMs: interval, eventType: 'VAM_BUY', eventDirection: 'bull', eventDiscriminator: 'PH',
            sourceBarIndex: 1, sourceTimestamp: t0, confirmationBarIndex: 2, confirmationTimestamp: t0 + interval,
            entryTimestamp: null, structuralContext: {}
        }), 'mismatched eventType for strategyId');

        expectInvalid(() => createStrategyEvent({
            strategyId: 'PHL_BOS_MSS', strategyVersion: 'v1', symbol: 'SOLUSDT', timeframe: '1m',
            intervalMs: interval, eventType: 'PHL_MSS_BULL', eventDirection: 'bull', eventDiscriminator: 'PH',
            sourceBarIndex: -1, sourceTimestamp: Number.NaN, confirmationBarIndex: 2, confirmationTimestamp: t0 + interval,
            entryTimestamp: null, structuralContext: {}
        }), 'negative index & NaN timestamp');
    });

    runTest('Gate1.3: Resolver clock validation, expectedIntervalMs rejections, gap & final-bar null', () => {
        const acceptedTs = [t0, t0 + interval, t0 + 11 * interval];
        const evGap = createStrategyEvent({
            strategyId: 'PHL_BOS_MSS', strategyVersion: 'PHL_BOS_MSS_v1', symbol: 'SOLUSDT', timeframe: '1m',
            intervalMs: interval, eventType: 'PHL_BOS_BULL', eventDirection: 'bull', eventDiscriminator: 'PH',
            sourceBarIndex: 0, sourceTimestamp: acceptedTs[0], confirmationBarIndex: 1, confirmationTimestamp: acceptedTs[1],
            entryTimestamp: null, structuralContext: {}
        });
        const evFinal = createStrategyEvent({
            strategyId: 'VAM_REVERSAL', strategyVersion: 'VAM_v1', symbol: 'SOLUSDT', timeframe: '1m',
            intervalMs: interval, eventType: 'VAM_BUY', eventDirection: 'bull', eventDiscriminator: 'BUY',
            sourceBarIndex: 2, sourceTimestamp: acceptedTs[2], confirmationBarIndex: 2, confirmationTimestamp: acceptedTs[2],
            entryTimestamp: null, structuralContext: {}
        });

        const resolved = resolveStrategyEventsEntryTimestamps([evGap, evFinal], acceptedTs, interval);
        assert(resolved[0].entryTimestamp === acceptedTs[2], 'Gap entryTimestamp must use actual next accepted candle');
        assert(resolved[1].entryTimestamp === null, 'Final bar must keep entryTimestamp === null');

        const expectChronoErr = (fn: () => void, label: string) => {
            let threw = false;
            try { fn(); } catch (e: any) { threw = String(e.message).includes('Chronology Error'); }
            assert(threw, `${label}: expected Chronology Error`);
        };

        // expectedIntervalMs negative cases
        expectChronoErr(() => resolveStrategyEventsEntryTimestamps([evGap], acceptedTs, 0), 'expectedIntervalMs=0');
        expectChronoErr(() => resolveStrategyEventsEntryTimestamps([evGap], acceptedTs, -60_000), 'expectedIntervalMs=-60000');
        expectChronoErr(() => resolveStrategyEventsEntryTimestamps([evGap], acceptedTs, 1.5), 'expectedIntervalMs=1.5');
        expectChronoErr(() => resolveStrategyEventsEntryTimestamps([evGap], acceptedTs, Number.MAX_SAFE_INTEGER + 1), 'unsafe expectedIntervalMs');
        expectChronoErr(
            () => resolveStrategyEventsEntryTimestamps([{ ...evGap, observationTimestamp: evGap.confirmationTimestamp + 120_000 }], acceptedTs, 60_000),
            'observationTimestamp != confirmation + expectedIntervalMs'
        );

        // Index / timestamp / derived field rejections
        expectChronoErr(() => resolveStrategyEventsEntryTimestamps([{ ...evGap, confirmationBarIndex: -1 }], acceptedTs, interval), 'negative confirmationBarIndex');
        expectChronoErr(() => resolveStrategyEventsEntryTimestamps([{ ...evGap, confirmationBarIndex: 99 }], acceptedTs, interval), 'out-of-range confirmationBarIndex');
        expectChronoErr(() => resolveStrategyEventsEntryTimestamps([{ ...evGap, confirmationTimestamp: t0 + 999 }], acceptedTs, interval), 'mismatched confirmationTimestamp');
        expectChronoErr(() => resolveStrategyEventsEntryTimestamps([{ ...evGap, observationBarIndex: 99 }], acceptedTs, interval), 'corrupt observationBarIndex');
        expectChronoErr(() => resolveStrategyEventsEntryTimestamps([{ ...evGap, confirmationLagBars: 99 }], acceptedTs, interval), 'corrupt confirmationLagBars');
        expectChronoErr(() => resolveStrategyEventsEntryTimestamps([{ ...evGap, sourceTimestamp: t0 + 999 }], acceptedTs, interval), 'mismatched sourceTimestamp');
        expectChronoErr(() => resolveStrategyEventsEntryTimestamps([evGap], [t0, t0, t0 + 2 * interval], interval), 'duplicate accepted timestamp');
        expectChronoErr(() => resolveStrategyEventsEntryTimestamps([evGap], [t0, t0 + 2 * interval, t0 + interval], interval), 'out-of-order accepted timestamp');
    });

    console.log(`\nPhase 5D Phase 2 Gate 1: ${passed} passed, ${failed} failed.`);
    return failed === 0;
}

export function runPhase5DPhase2Tests(): boolean {
    if (!runPhase5DPhase2Gate1Tests()) {
        console.error('❌ Phase 2 halted: Gate 1 failed.');
        return false;
    }

    console.log('\n======================================================');
    console.log('🧪 Starting Phase 5D Phase 2 Teacher Acceptance Suite');
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
    const interval = 60_000;

    // 1. StrictCBC: all 4 labels, contiguous no-gap control, real-state gap reset & checkpoint restoration of BOTH nextState & nextPrevPivot
    runTest('1. StrictCBC Adapter: 4 labels, contiguous control, gap reset & restoration with prevPivot', () => {
        assert(STRICT_CBC_ZIGZAG_TEACHER_VERSION === 'StrictCBCZigZag_v1', 'Unexpected version');

        for (const [type, label, expectedType] of [
            ['high', 'HH', 'CBC_HIGH_HH'],
            ['high', 'LH', 'CBC_HIGH_LH'],
            ['low', 'HL', 'CBC_LOW_HL'],
            ['low', 'LL', 'CBC_LOW_LL']
        ] as const) {
            const ev = adaptStrictCBCtoStrategyEvent({
                pivot: { id: 1, barIndex: 1, time: t0 + interval, price: 105, type, label, confirmedBarIndex: 2 },
                prevPivot: null, confirmationTimestamp: t0 + 2 * interval, entryTimestamp: null,
                atr14AtConfirmation: 2, symbol: 'SOLUSDT', timeframe: '1m', intervalMs: interval
            });
            assert(ev.eventType === expectedType && ev.eventDiscriminator === '1', `Label ${label} mapping failed`);
        }

        for (const badPivot of [
            { id: 1, barIndex: 1, time: t0, price: 105, type: 'high', label: 'HL', confirmedBarIndex: 2 },
            { id: 1, barIndex: 1, time: t0, price: 105, type: 'low', label: 'HH', confirmedBarIndex: 2 },
            { id: 0, barIndex: 1, time: t0, price: 105, type: 'high', label: 'HH', confirmedBarIndex: 2 }
        ] as any[]) {
            let threw = false;
            try {
                adaptStrictCBCtoStrategyEvent({
                    pivot: badPivot, prevPivot: null, confirmationTimestamp: t0 + 2 * interval,
                    entryTimestamp: null, atr14AtConfirmation: 2, symbol: 'SOLUSDT', timeframe: '1m', intervalMs: interval
                });
            } catch { threw = true; }
            assert(threw, 'Malformed StrictCBC pivot must throw');
        }

        const c0 = makeCandle(t0, 100, 105, 95, 103, 100);
        const c1 = makeCandle(t0 + interval, 103, 112, 100, 110, 100);
        const c2 = makeCandle(t0 + 2 * interval, 105, 106, 92, 94, 100);
        const c3Contig = makeCandle(t0 + 3 * interval, 94, 108, 94, 107, 100); // Genuinely contiguous control
        const c3Gap = makeCandle(t0 + 12 * interval, 94, 108, 94, 107, 100);   // 10m gap
        const c4 = makeCandle(t0 + 13 * interval, 107, 115, 106, 114, 100);
        const c5 = makeCandle(t0 + 14 * interval, 110, 111, 100, 102, 100);

        // Control without gap (genuinely contiguous timestamps): confirms id=1 @ bar 2 and id=2 @ bar 3
        let sCtrl: StrictCBCState | null = null;
        let pCtrl: StrictZigZagPivot | null = null;
        for (const [idx, c] of [[0, c0], [1, c1], [2, c2], [3, c3Contig]] as const) {
            const r = stepStrictCBCWithReset(c, idx, sCtrl, pCtrl, false);
            sCtrl = r.nextState;
            pCtrl = r.nextPrevPivot;
            if (idx === 2) assert(r.confirmedPivot?.id === 1 && r.confirmedPivot.type === 'high', 'Bar 2 confirms id=1');
            if (idx === 3) assert(r.confirmedPivot?.id === 2 && r.confirmedPivot.type === 'low' && r.prevPivotForEvent?.id === 1, 'Contiguous bar 3 confirms id=2 with prevPivot=1');
        }

        // Uninterrupted gap stream 0..5 (discontinuity at bar 3)
        let sGap: StrictCBCState | null = null;
        let pGap: StrictZigZagPivot | null = null;
        const gapEvents: StrategyEvent[] = [];
        const gapPivots: StrictZigZagPivot[] = [];

        for (const [idx, c, isDisc] of [[0, c0, false], [1, c1, false], [2, c2, false], [3, c3Gap, true], [4, c4, false], [5, c5, false]] as const) {
            const r = stepStrictCBCWithReset(c, idx, sGap, pGap, isDisc);
            sGap = r.nextState;
            pGap = r.nextPrevPivot;
            if (idx === 3) {
                assert(r.confirmedPivot === null && r.nextPrevPivot === null && sGap.nextPivotId === 2, 'Bar 3 gap resets and keeps nextPivotId=2');
            }
            if (r.confirmedPivot) {
                gapPivots.push(r.confirmedPivot);
                gapEvents.push(adaptStrictCBCtoStrategyEvent({
                    pivot: r.confirmedPivot, prevPivot: r.prevPivotForEvent,
                    confirmationTimestamp: c.time, entryTimestamp: null, atr14AtConfirmation: 2.0,
                    symbol: 'SOLUSDT', timeframe: '1m', intervalMs: interval
                }));
            }
        }
        assert(gapEvents.length === 2 && gapEvents[1].confirmationBarIndex === 5 && gapEvents[1].structuralContext['hasPrevPivot'] === false,
            'Post-gap pivot must confirm @ bar 5 with no cross-gap leg');

        // Checkpoint restoration at bar 2 (where nextPrevPivot is NON-NULL id=1!) -> replay bar 3 (gap) .. 5
        let sPre: StrictCBCState | null = null;
        let pPre: StrictZigZagPivot | null = null;
        const preEvents: StrategyEvent[] = [];
        const prePivots: StrictZigZagPivot[] = [];
        for (const [idx, c] of [[0, c0], [1, c1], [2, c2]] as const) {
            const r = stepStrictCBCWithReset(c, idx, sPre, pPre, false);
            sPre = r.nextState;
            pPre = r.nextPrevPivot;
            if (r.confirmedPivot) {
                prePivots.push(r.confirmedPivot);
                preEvents.push(adaptStrictCBCtoStrategyEvent({
                    pivot: r.confirmedPivot, prevPivot: r.prevPivotForEvent,
                    confirmationTimestamp: c.time, entryTimestamp: null, atr14AtConfirmation: 2.0,
                    symbol: 'SOLUSDT', timeframe: '1m', intervalMs: interval
                }));
            }
        }
        assert(pPre !== null && pPre.id === 1, 'Checkpoint at bar 2 must hold non-null prevPivot');
        let sRestored: StrictCBCState = JSON.parse(JSON.stringify(sPre));
        let pRestored: StrictZigZagPivot | null = JSON.parse(JSON.stringify(pPre));

        for (const [idx, c, isDisc] of [[3, c3Gap, true], [4, c4, false], [5, c5, false]] as const) {
            const r = stepStrictCBCWithReset(c, idx, sRestored, pRestored, isDisc);
            sRestored = r.nextState;
            pRestored = r.nextPrevPivot;
            if (r.confirmedPivot) {
                prePivots.push(r.confirmedPivot);
                preEvents.push(adaptStrictCBCtoStrategyEvent({
                    pivot: r.confirmedPivot, prevPivot: r.prevPivotForEvent,
                    confirmationTimestamp: c.time, entryTimestamp: null, atr14AtConfirmation: 2.0,
                    symbol: 'SOLUSDT', timeframe: '1m', intervalMs: interval
                }));
            }
        }
        assert(
            JSON.stringify(preEvents) === JSON.stringify(gapEvents) &&
            JSON.stringify(prePivots) === JSON.stringify(gapPivots) &&
            JSON.stringify(sRestored) === JSON.stringify(sGap) &&
            JSON.stringify(pRestored) === JSON.stringify(pGap),
            'StrictCBC restoration with non-null prevPivot must match uninterrupted replay'
        );
    });

    // 2. PHL Teacher: pinned bar 24 MSS + no bar 25 MSS, null-candle validation order, entryTimestamp/OHLC rejections
    runTest('2. PHL Teacher: pinned bar 24 MSS, no duplicate @25, pullback modes & input/state rejections', () => {
        const cfgValid = createDefaultPHLConfig('SOLUSDT', '1m', interval);
        const bars: Array<[number, number, number, number]> = [
            [100, 102, 99, 101], [101, 105, 100, 104], [104, 107, 103, 106], [106, 110, 105, 107],
            [107, 108, 103, 104], [104, 106, 100, 101], [101, 103, 98, 99],
            [99, 100, 96, 97],   [97, 98, 95, 96],    [96, 97, 94, 95],
            [95, 99, 95, 98],    [98, 102, 97, 101],  [101, 105, 100, 104],
            [104, 108, 103, 107],[107, 109, 106, 108],[108, 113, 107, 112],
            [112, 115, 111, 114],[114, 118, 113, 115],[115, 116, 110, 111],
            [111, 113, 109, 110],[110, 112, 108, 109],[109, 116, 109, 115],
            [115, 121, 114, 120],[120, 120, 100, 101],[101, 102, 92, 93],
            [93, 94, 89, 90]
        ];
        const stream = bars.map(([o, h, l, c], i) => makeCandle(t0 + i * interval, o, h, l, c, 100));

        let st = createInitialPHLState();
        const evs: StrategyEvent[] = [];
        for (let i = 0; i < stream.length; i++) {
            const res = stepPHL(stream[i], i, st, cfgValid, false, 2.0, null);
            st = res.nextState;
            evs.push(...res.events);
        }
        assert(evs.length === 3, `Expected 3 PHL events, got ${evs.length}`);
        assert(evs[0].eventType === 'PHL_MSS_BULL' && evs[0].sourceBarIndex === 3 && evs[0].confirmationBarIndex === 15, 'Pinned PHL_MSS_BULL @15');
        assert(evs[1].eventType === 'PHL_BOS_BULL' && evs[1].sourceBarIndex === 17 && evs[1].confirmationBarIndex === 22, 'Pinned PHL_BOS_BULL @22');
        assert(evs[2].eventType === 'PHL_MSS_BEAR' && evs[2].sourceBarIndex === 9 && evs[2].confirmationBarIndex === 24, 'Pinned PHL_MSS_BEAR @24');
        assert(!evs.some(e => e.confirmationBarIndex === 25), 'Bar 25 must NOT emit a second PHL_MSS_BEAR');

        // useValidPullbacks true vs false divergence
        const divBars: Array<[number, number, number, number]> = [
            [105, 107, 105, 106], [106, 108, 105, 107], [107, 109, 106, 108], [108, 110, 105, 109],
            [108, 109, 105, 107], [107, 108, 105, 106], [106, 107, 105, 106],
            [106, 107, 100, 106], [106, 107, 98, 106],  [106, 107, 94, 106],
            [106, 107, 96, 106],  [106, 108, 97, 107],  [107, 109, 99, 108],
            [108, 112, 107, 111]
        ];
        const divStream = divBars.map(([o, h, l, c], i) => makeCandle(t0 + i * interval, o, h, l, c, 100));
        let stPbTrue = createInitialPHLState();
        let stPbFalse = createInitialPHLState();
        for (let i = 0; i < divStream.length; i++) {
            stPbTrue = stepPHL(divStream[i], i, stPbTrue, cfgValid, false, 2.0, null).nextState;
            stPbFalse = stepPHL(divStream[i], i, stPbFalse, { ...cfgValid, useValidPullbacks: false }, false, 2.0, null).nextState;
        }
        assert(stPbTrue.pl === null && stPbFalse.pl?.price === 94, 'useValidPullbacks=true must block invalid-PB protected low while false allows it');

        // extraValidPullbacks match & no-match pinned to bar 6
        const cfgExtra = { ...cfgValid, extraValidPullbacks: true };
        const noMatchBars: Array<[number, number, number, number]> = [
            [106, 107, 105, 105.5], [107, 108, 105, 106], [108, 109, 106, 107], [109, 110, 104, 108],
            [108, 109, 105, 106],   [106, 107, 105, 105.5],[105.5, 106, 104, 105]
        ];
        let stNoMatch = createInitialPHLState();
        for (let i = 0; i < noMatchBars.length; i++) {
            const [o, h, l, c] = noMatchBars[i];
            stNoMatch = stepPHL(makeCandle(t0 + i * interval, o, h, l, c, 100), i, stNoMatch, cfgExtra, false, 2.0, null).nextState;
        }
        assert(stNoMatch.pbFromHigh.price === null && !stNoMatch.pbFromHigh.valid, 'extraValidPullbacks no-match at bar 6');

        const matchBars: Array<[number, number, number, number]> = [
            [106, 107, 105, 105.5], [107, 108, 105, 106], [106, 109, 99, 108], [109, 110, 104, 108],
            [108, 109, 105, 106],   [106, 107, 105, 105.5],[105.5, 106, 104, 105]
        ];
        let stMatch = createInitialPHLState();
        for (let i = 0; i < matchBars.length; i++) {
            const [o, h, l, c] = matchBars[i];
            stMatch = stepPHL(makeCandle(t0 + i * interval, o, h, l, c, 100), i, stMatch, cfgExtra, false, 2.0, null).nextState;
        }
        assert(stMatch.pbFromHigh.price === 99 && stMatch.pbFromHigh.idx === 6, 'extraValidPullbacks match picks bar 2 low=99 at bar 6');

        // Validation-order (null candle + non-null entryTimestamp), OHLC, entryTimestamp, ATR, volume, off-grid & state checks
        const expectPHLInputErr = (fn: () => void, label: string) => {
            let matched = false;
            try { fn(); } catch (e: any) { matched = e instanceof Error && !(e instanceof TypeError) && e.message.includes('PHL '); }
            assert(matched, `${label}: expected intentional PHL Error (never TypeError)`);
        };
        const validNext = makeCandle(t0 + 26 * interval, 90, 92, 88, 91, 100);
        expectPHLInputErr(() => stepPHL(null as any, 26, st, cfgValid, false, 2.0, t0 + 27 * interval), 'null candle + non-null entryTimestamp');
        expectPHLInputErr(() => stepPHL(makeCandle(t0 + 26 * interval, 90, 88, 92, 91, 100), 26, st, cfgValid), 'malformed high < low');
        expectPHLInputErr(() => stepPHL(makeCandle(t0 + 26 * interval, 90, 92, 88, 95, 100), 26, st, cfgValid), 'malformed close > high');
        expectPHLInputErr(() => stepPHL(validNext, 26, st, cfgValid, false, 2.0, t0 + 26 * interval), 'entryTimestamp <= candle.time');
        expectPHLInputErr(() => stepPHL(validNext, 26, st, cfgValid, false, 2.0, Number.NaN), 'entryTimestamp = NaN');
        expectPHLInputErr(() => stepPHL(validNext, 26, st, cfgValid, false, Number.NaN, null), 'atr14 = NaN');
        expectPHLInputErr(() => stepPHL(validNext, 26, st, cfgValid, false, -1, null), 'atr14 = -1');
        expectPHLInputErr(() => stepPHL(makeCandle(t0 + 26 * interval, 90, 92, 88, 91, -1), 26, st, cfgValid), 'negative volume');
        expectPHLInputErr(() => stepPHL(makeCandle(t0 + 25 * interval + 30_000, 90, 92, 88, 91, 100), 26, st, cfgValid), 'off-grid delta');
        expectPHLInputErr(() => stepPHL(validNext, 26, { ...st, ph: { price: 999, barIndex: 25, time: t0 + 25 * interval } }, cfgValid), 'ph disagrees with window');
    });

    // 3. DTFX Teacher: exact bar-by-bar lifecycle (_R1 -> linger -> exit -> _R2 -> INVALIDATED -> post-invalidation), maxActiveZones eviction, real-progression geometry guards, & full negative checks
    runTest('3. DTFX Teacher: bar-by-bar _R1/_R2 lifecycle, maxActiveZones eviction, geometry guards & validations', () => {
        const cfg = createDefaultDTFXConfig('SOLUSDT', '1m', interval);
        assert(createInitialDTFXState(3).nextZoneId === 3, 'createInitialDTFXState(3) must set nextZoneId=3');

        // Exact 24-bar hand-verified lifecycle sequence:
        // 0: [105,115,104,106], 1..4: [105,108,102,105], 5: [104,106,98,103], 6..15: [105,108,102,105]
        // 16: break >115 -> CREATED @16 ([98..115])
        // 17: above [116..119], 18: touch [112..117] -> 1_R1, 19: linger [109..115], 20: exit [116..118],
        // 21: re-enter [110..117] -> 1_R2, 22: touch+close<98 [95..111, c=96] -> INVALIDATED (no retest!), 23: [96..105] -> 0 events
        const lcCandles: ML1Candle[] = [];
        for (let i = 0; i <= 15; i++) {
            if (i === 0) lcCandles.push(makeCandle(t0, 105, 115, 104, 106, 100));
            else if (i === 5) lcCandles.push(makeCandle(t0 + i * interval, 104, 106, 98, 103, 100));
            else lcCandles.push(makeCandle(t0 + i * interval, 105, 108, 102, 105, 100));
        }
        lcCandles.push(makeCandle(t0 + 16 * interval, 106, 118, 106, 117, 100)); // 16: DTFX_DEMAND_CREATED
        lcCandles.push(makeCandle(t0 + 17 * interval, 117, 119, 116, 118, 100)); // 17: above
        lcCandles.push(makeCandle(t0 + 18 * interval, 116, 117, 94, 114, 100));  // 18: 1_R1 (wick < 95 keeps Bar 22 from making 10-bar low)
        lcCandles.push(makeCandle(t0 + 19 * interval, 114, 115, 109, 113, 100)); // 19: linger
        lcCandles.push(makeCandle(t0 + 20 * interval, 116, 118, 116, 117, 100)); // 20: exit
        lcCandles.push(makeCandle(t0 + 21 * interval, 117, 117, 110, 111, 100)); // 21: 1_R2
        lcCandles.push(makeCandle(t0 + 22 * interval, 111, 111, 95, 96, 100));   // 22: INVALIDATED (beats retest)
        lcCandles.push(makeCandle(t0 + 23 * interval, 96, 105, 96, 104, 100));   // 23: post-invalidation

        let lcState = createInitialDTFXState();
        for (let i = 0; i < lcCandles.length; i++) {
            const res = stepDTFX(lcCandles[i], i, lcState, cfg, false, 2.0, null);
            lcState = res.nextState;

            if (i === 16) {
                assert(res.createdZones.length === 1 && res.events[0].eventType === 'DTFX_DEMAND_CREATED', 'Bar 16 must create demand zone');
                assert(lcState.activeZones[0].top === 115 && lcState.activeZones[0].bot === 98 && lcState.activeZones[0].retestCount === 0, 'Bar 16 zone bounds');
            } else if (i === 17) {
                assert(res.events.length === 0 && lcState.activeZones[0].status === 'ACTIVE', 'Bar 17 above zone');
            } else if (i === 18) {
                assert(res.events.length === 1 && res.events[0].eventDiscriminator === '1_R1' && lcState.activeZones[0].retestCount === 1 && lcState.activeZones[0].isCurrentlyInZone, 'Bar 18 must emit 1_R1');
            } else if (i === 19) {
                assert(res.events.length === 0 && lcState.activeZones[0].retestCount === 1 && lcState.activeZones[0].isCurrentlyInZone, 'Bar 19 linger must not duplicate');
            } else if (i === 20) {
                assert(res.events.length === 0 && lcState.activeZones[0].retestCount === 1 && !lcState.activeZones[0].isCurrentlyInZone, 'Bar 20 exit must reset latch');
            } else if (i === 21) {
                assert(res.events.length === 1 && res.events[0].eventDiscriminator === '1_R2' && lcState.activeZones[0].retestCount === 2 && lcState.activeZones[0].lastRetestBarIndex === 21, 'Bar 21 must emit 1_R2');
            } else if (i === 22) {
                assert(res.invalidatedZones.length === 1 && res.retestedZones.length === 0 && res.events.length === 0 && lcState.activeZones.length === 0, 'Bar 22 invalidation must beat retest');
                assert(res.invalidatedZones[0].status === 'INVALIDATED' && res.invalidatedZones[0].retestCount === 2, 'Zone preserves final retestCount=2 on invalidation');
            } else if (i === 23) {
                assert(res.events.length === 0 && lcState.activeZones.length === 0, 'Bar 23 post-invalidation must emit nothing');
            }
        }

        // Repeated-bar chronology rejection
        let repeatRejected = false;
        try { stepDTFX(lcCandles[23], 23, lcState, cfg); } catch (e: any) { repeatRejected = String(e.message).includes('Chronology Error'); }
        assert(repeatRejected, 'Repeated bar 23 must be rejected');

        // Real-progression maxActiveZones = 2 eviction test (3 created zones -> zones 2 & 3 remain, nextZoneId=4)
        const capCfg = { ...cfg, maxActiveZones: 2 };
        let capState = createInitialDTFXState();
        const capCreatedIds: number[] = [];
        let capBar = 0;
        const pushCap = (c: ML1Candle) => {
            const r = stepDTFX(c, capBar, capState, capCfg, false, 2.0, null);
            capState = r.nextState;
            for (const z of r.createdZones) capCreatedIds.push(z.zoneId);
            capBar++;
        };
        // Build 3 clean rising breakouts with higher highs and higher lows so earlier zones don't invalidate
        for (let wave = 0; wave < 3; wave++) {
            const base = 100 + wave * 30;
            pushCap(makeCandle(t0 + capBar * interval, base + 5, base + 15, base + 4, base + 6, 100));
            for (let k = 1; k <= 10; k++) {
                pushCap(makeCandle(t0 + capBar * interval, base + 5, base + 8, k === 5 ? base + 1 : base + 4, base + 5, 100));
            }
            for (let k = 0; k < 5; k++) {
                pushCap(makeCandle(t0 + capBar * interval, base + 5, base + 8, base + 4, base + 5, 100));
            }
            pushCap(makeCandle(t0 + capBar * interval, base + 6, base + 20, base + 6, base + 19, 100));
        }
        assert(capCreatedIds.length >= 3, `Expected >=3 zones for eviction test, got ${capCreatedIds.length}`);
        assert(capState.activeZones.length === 2, 'activeZones must be capped at 2');
        assert(
            capState.activeZones[0].zoneId === capCreatedIds[capCreatedIds.length - 2] &&
            capState.activeZones[1].zoneId === capCreatedIds[capCreatedIds.length - 1] &&
            capState.nextZoneId === capCreatedIds[capCreatedIds.length - 1] + 1,
            'Oldest zone must be evicted while keeping newest 2 and monotonic nextZoneId'
        );

        // Degenerate geometry guard tests (valid state passing validateDTFXState where zTop === zBot)
        const degBullWindow = Array.from({ length: cfg.structureLen }, (_, k) => ({
            barIndex: 10 + k,
            time: t0 + (10 + k) * interval,
            open: k === 9 ? 112 : 111,
            high: 112,
            low: k === 9 ? 112 : 110,
            close: k === 9 ? 112 : 111,
            volume: 100
        }));
        const degBullState: DTFXState = {
            ...createInitialDTFXState(2),
            window: Object.freeze(degBullWindow),
            dir: 1 as const,
            tDir: 1 as const,
            t: Object.freeze({ price: 112, barIndex: 18, time: t0 + 18 * interval }),
            b: Object.freeze({ price: 112, barIndex: 19, time: t0 + 19 * interval }),
            prevTPrice: 112,
            prevBPrice: 112,
            prevClose: 112,
            bosUpCheck: true
        };
        const degBullRes = stepDTFX(makeCandle(t0 + 20 * interval, 112, 115, 112, 114, 100), 20, degBullState, cfg, false, 2.0, null);
        assert(degBullRes.createdZones.length === 0 && degBullRes.events.length === 0 && !degBullRes.nextState.bosUpCheck,
            'Bull degenerate zero-height zone must be skipped and bosUpCheck cleared per contract');

        const degBearWindow = Array.from({ length: cfg.structureLen }, (_, k) => ({
            barIndex: 10 + k,
            time: t0 + (10 + k) * interval,
            open: k === 9 ? 98 : 99,
            high: k === 9 ? 98 : 100,
            low: 98,
            close: k === 9 ? 98 : 99,
            volume: 100
        }));
        const degBearState: DTFXState = {
            ...createInitialDTFXState(2),
            window: Object.freeze(degBearWindow),
            dir: -1 as const,
            tDir: -1 as const,
            b: Object.freeze({ price: 98, barIndex: 18, time: t0 + 18 * interval }),
            t: Object.freeze({ price: 98, barIndex: 19, time: t0 + 19 * interval }),
            prevTPrice: 98,
            prevBPrice: 98,
            prevClose: 98,
            bosDownCheck: true
        };
        const degBearRes = stepDTFX(makeCandle(t0 + 20 * interval, 98, 98, 95, 96, 100), 20, degBearState, cfg, false, 2.0, null);
        assert(degBearRes.createdZones.length === 0 && degBearRes.events.length === 0 && !degBearRes.nextState.bosDownCheck,
            'Bear degenerate zero-height zone must be skipped and bosDownCheck cleared per contract');

        // Discontinuity preserves nextZoneId while clearing activeZones & swings
        const preResetZoneCount = lcCandles.slice(0, 17).reduce((stAcc: DTFXState, c, idx) => stepDTFX(c, idx, stAcc, cfg).nextState, createInitialDTFXState());
        assert(preResetZoneCount.nextZoneId === 2 && preResetZoneCount.activeZones.length === 1, 'Pre-reset zoneId=1 active');
        const postReset = stepDTFX(makeCandle(t0 + 30 * interval, 120, 121, 119, 120, 100), 17, preResetZoneCount, cfg, true);
        assert(postReset.nextState.nextZoneId === 2 && postReset.nextState.activeZones.length === 0 && postReset.nextState.dir === 0 && postReset.nextState.t === null,
            'Discontinuity must clear DTFX swings/zones and preserve monotonic nextZoneId');

        // Negative validation checks (null candle + non-null entryTimestamp, bad fibs, corrupt zoneId/provenance/retest metadata)
        const expectDTFXErr = (fn: () => void, label: string) => {
            let matched = false;
            try { fn(); } catch (e: any) { matched = e instanceof Error && !(e instanceof TypeError) && e.message.includes('DTFX '); }
            assert(matched, `${label}: expected intentional DTFX Error`);
        };
        expectDTFXErr(() => stepDTFX(null as any, 17, preResetZoneCount, cfg, false, 2.0, t0 + 99 * interval), 'null candle + non-null entryTimestamp');
        expectDTFXErr(() => stepDTFX(lcCandles[0], 0, createInitialDTFXState(), { ...cfg, fibLevels: [0.5, 0.3, 0.7] }), 'unordered fibLevels');
        expectDTFXErr(() => stepDTFX(lcCandles[0], 0, createInitialDTFXState(), { ...cfg, fibLevels: [0, 0.5, 0.7] }), 'fibLevel=0 outside (0,1)');
        expectDTFXErr(() => stepDTFX(lcCandles[0], 0, createInitialDTFXState(), { ...cfg, fibLevels: [0.3, 0.3, 0.7] }), 'duplicate fibLevels');
        expectDTFXErr(() => stepDTFX(lcCandles[17], 17, {
            ...preResetZoneCount,
            activeZones: [{ ...preResetZoneCount.activeZones[0], zoneId: 99 }]
        }, cfg), 'zoneId >= nextZoneId');
        expectDTFXErr(() => stepDTFX(lcCandles[17], 17, {
            ...preResetZoneCount,
            activeZones: [{ ...preResetZoneCount.activeZones[0], createdConfirmationTimestamp: 1 }]
        }, cfg), 'corrupt createdConfirmationTimestamp vs window');
        const at18 = stepDTFX(lcCandles[18], 18, preResetZoneCount, cfg).nextState;
        expectDTFXErr(() => stepDTFX(lcCandles[19], 19, {
            ...at18,
            activeZones: [{ ...at18.activeZones[0], firstRetestTimestamp: 1 }]
        }, cfg), 'corrupt firstRetestTimestamp vs window');
    });

    // 4. VAM Adapter Standalone Check (BUY, SELL, No-Signal & Invalid Non-Zero Signal Rejection)
    runTest('4. VAM Adapter: BUY, SELL, no-signal & invalid signal rejection', () => {
        const baseOut = stepVolatilityAdjustedMean(102, 98, 100, createInitialVAMState(), false);
        assert(adaptVAMtoStrategyEvent({
            vamOutput: { ...baseOut, signal: 0 }, confirmationBarIndex: 10, confirmationTimestamp: t0 + 10 * interval,
            entryTimestamp: null, symbol: 'SOLUSDT', timeframe: '1m', intervalMs: interval
        }) === null, 'signal=0 must return null');

        const evBuy = adaptVAMtoStrategyEvent({
            vamOutput: { ...baseOut, signal: 1, trend: 1, buyStreak: 2 }, confirmationBarIndex: 30, confirmationTimestamp: t0 + 30 * interval,
            entryTimestamp: null, symbol: 'SOLUSDT', timeframe: '1m', intervalMs: interval
        });
        const evSell = adaptVAMtoStrategyEvent({
            vamOutput: { ...baseOut, signal: -1, trend: -1, sellStreak: 2 }, confirmationBarIndex: 40, confirmationTimestamp: t0 + 40 * interval,
            entryTimestamp: null, symbol: 'SOLUSDT', timeframe: '1m', intervalMs: interval
        });
        assert(evBuy?.eventType === 'VAM_BUY' && evBuy.eventDiscriminator === 'BUY' && evBuy.sourceBarIndex === 30 && evBuy.confirmationLagBars === 0, 'VAM_BUY check');
        assert(evSell?.eventType === 'VAM_SELL' && evSell.eventDiscriminator === 'SELL' && evSell.sourceBarIndex === 40 && evSell.confirmationLagBars === 0, 'VAM_SELL check');

        for (const badSig of [2, -2, Number.NaN] as any[]) {
            let threw = false;
            try {
                adaptVAMtoStrategyEvent({
                    vamOutput: { ...baseOut, signal: badSig }, confirmationBarIndex: 10, confirmationTimestamp: t0 + 10 * interval,
                    entryTimestamp: null, symbol: 'SOLUSDT', timeframe: '1m', intervalMs: interval
                });
            } catch (e: any) { threw = String(e.message).includes('VAM Adapter Error'); }
            assert(threw, `Invalid signal ${badSig} must throw`);
        }
    });

    // 5. Combined 4-Teacher Stream: all 4 emit, REAL bar 109 event resolved across bar 110 gap, full reset checks & 2-run serialized determinism
    runTest('5. Combined 4-Teacher Stream: all 4 emit, real bar 109 gap entry, full resets & determinism', () => {
        const stream: ML1Candle[] = [];
        let ts = t0;
        let p = 100;
        for (let i = 0; i < 300; i++) {
            if (i === 110) ts += 600_000;

            // Engineer bars 106..109 so StrictCBC is bullish at bar 108 and guaranteed to flip bearish on bar 109!
            if (i >= 106 && i <= 108) {
                const o = p;
                const c = p + 3.0;
                stream.push(makeCandle(ts, o, c + 0.5, o - 0.5, c, 150));
                p = c;
                ts += interval;
                continue;
            }
            if (i === 109) {
                const o = p - 0.5;
                const c = p - 8.0; // Breaks well below bar 108 anchorLow -> guaranteed real STRICT_CBC event @109
                stream.push(makeCandle(ts, o, o + 0.3, c - 0.5, c, 200));
                p = c;
                ts += interval;
                continue;
            }

            const mod = i % 100;
            const delta = mod < 48
                ? (i % 7 === 0 || i % 7 === 1) ? -0.4 : 1.6
                : (i % 7 === 0 || i % 7 === 1) ? 0.4 : -1.5;
            const o = p;
            const c = Math.max(10, p + delta);
            stream.push(makeCandle(ts, o, Math.max(o, c) + 0.6, Math.min(o, c) - 0.6, c, 100 + (i % 5) * 20));
            p = c;
            ts += interval;
        }

        const runCombined = () => {
            const phlCfg = createDefaultPHLConfig('SOLUSDT', '1m', interval);
            const dtfxCfg = createDefaultDTFXConfig('SOLUSDT', '1m', interval);

            let cbcState: StrictCBCState | null = null;
            let lastCbcPivot: StrictZigZagPivot | null = null;
            let phlState = createInitialPHLState();
            let dtfxState = createInitialDTFXState();
            let vamState = createInitialVAMState();

            const rawEvents: StrategyEvent[] = [];
            const acceptedTimestamps: number[] = [];

            for (let i = 0; i < stream.length; i++) {
                const c = stream[i];
                acceptedTimestamps.push(c.time);
                const isDisc = i > 0 && c.time - stream[i - 1].time >= 300_000;
                const prevZoneIdBefore110 = i === 110 ? dtfxState.nextZoneId : 0;

                const vamOut = stepVolatilityAdjustedMean(c.high, c.low, c.close, vamState, isDisc);
                vamState = vamOut.nextState;
                const atr = vamState.atrState.isSeeded ? vamState.atrState.atr : null;

                const vamEv = adaptVAMtoStrategyEvent({
                    vamOutput: vamOut, confirmationBarIndex: i, confirmationTimestamp: c.time,
                    entryTimestamp: null, symbol: 'SOLUSDT', timeframe: '1m', intervalMs: interval
                });
                if (vamEv) rawEvents.push(vamEv);

                const cbcStep = stepStrictCBCWithReset(c, i, cbcState, lastCbcPivot, isDisc);
                cbcState = cbcStep.nextState;
                lastCbcPivot = cbcStep.nextPrevPivot;
                if (cbcStep.confirmedPivot) {
                    rawEvents.push(adaptStrictCBCtoStrategyEvent({
                        pivot: cbcStep.confirmedPivot, prevPivot: cbcStep.prevPivotForEvent,
                        confirmationTimestamp: c.time, entryTimestamp: null, atr14AtConfirmation: atr,
                        symbol: 'SOLUSDT', timeframe: '1m', intervalMs: interval
                    }));
                }

                const phlRes = stepPHL(c, i, phlState, phlCfg, isDisc, atr, null);
                phlState = phlRes.nextState;
                rawEvents.push(...phlRes.events);

                const dtfxRes = stepDTFX(c, i, dtfxState, dtfxCfg, isDisc, atr, null);
                dtfxState = dtfxRes.nextState;
                rawEvents.push(...dtfxRes.events);

                // Exhaustive reset assertions for ALL 4 teachers at bar 110 discontinuity
                if (i === 110) {
                    assert(lastCbcPivot === null && cbcState.anchorHigh === c.high && cbcState.anchorLow === c.low &&
                        cbcState.phaseHighIdx === 110 && cbcState.phaseLowIdx === 110 && cbcState.lastHighPrice === null && cbcState.lastLowPrice === null,
                        'StrictCBC full gap reset failed');
                    assert(phlState.window.length === 1 && phlState.bull === null && phlState.ph === null && phlState.pl === null &&
                        phlState.pbFromHigh.price === null && phlState.pbFromLow.price === null &&
                        phlState.trackHigh === null && phlState.trackLow === null &&
                        phlState.lastHigh === null && phlState.lastLow === null,
                        'PHL full gap reset failed');
                    assert(dtfxState.window.length === 1 && dtfxState.activeZones.length === 0 && dtfxState.dir === 0 && dtfxState.tDir === 0 &&
                        dtfxState.t === null && dtfxState.b === null && dtfxState.prevTPrice === null && dtfxState.prevBPrice === null &&
                        !dtfxState.bosUpCheck && !dtfxState.bosDownCheck && dtfxState.nextZoneId === prevZoneIdBefore110,
                        'DTFX full gap reset failed (or nextZoneId not preserved)');
                    assert(vamState.unbrokenRun === 1 && vamState.trend === 0 && vamState.lastSignalAcceptedIndex === null &&
                        vamState.buyStreak === 0 && vamState.sellStreak === 0 && !vamState.atrState.isSeeded && vamState.adx === null,
                        'VAM full gap reset failed');
                }
            }

            const resolved = resolveStrategyEventsEntryTimestamps(rawEvents, acceptedTimestamps, interval);
            const verified = sortAndVerifyUniqueStrategyEvents(resolved);
            return { verified, acceptedTimestamps, finalStates: { cbcState, lastCbcPivot, phlState, dtfxState, vamState } };
        };

        const run1 = runCombined();
        const run2 = runCombined();
        assert(JSON.stringify(run1.verified) === JSON.stringify(run2.verified), 'Serialized determinism failed on events');
        assert(JSON.stringify(run1.finalStates) === JSON.stringify(run2.finalStates), 'Serialized determinism failed on final states');

        const byStrategy: Record<string, number> = { STRICT_CBC: 0, PHL_BOS_MSS: 0, DTFX_ZONES: 0, VAM_REVERSAL: 0 };
        const byType: Record<string, number> = {};
        let preGapCount = 0;
        let postGapCount = 0;
        let realBar109Checked = false;

        for (const ev of run1.verified) {
            byStrategy[ev.strategyId] = (byStrategy[ev.strategyId] || 0) + 1;
            byType[ev.eventType] = (byType[ev.eventType] || 0) + 1;
            if (ev.confirmationBarIndex < 110) preGapCount++;
            if (ev.confirmationBarIndex > 110) {
                postGapCount++;
                // Post-gap events must not reference pre-gap source bar indices
                assert(ev.sourceBarIndex >= 110, `Post-gap event ${ev.eventId} referenced pre-gap sourceBarIndex ${ev.sourceBarIndex}`);
            }
            if (ev.confirmationBarIndex === 109) {
                assert(ev.entryTimestamp === run1.acceptedTimestamps[110], 'Real bar 109 event must resolve actual post-gap bar 110 timestamp');
                realBar109Checked = true;
            }
            if (ev.confirmationBarIndex === stream.length - 1) {
                assert(ev.entryTimestamp === null, 'Final bar event must keep entryTimestamp === null');
            }
            if (ev.strategyId === 'DTFX_ZONES') assert(/^\d+(?:_R\d+)?$/.test(ev.eventDiscriminator), 'DTFX disc');
        }

        console.log('  📊 Combined 4-Teacher Counts:', JSON.stringify({ byStrategy, byType, preGapCount, postGapCount }));
        assert(realBar109Checked, 'Combined stream must produce at least one REAL teacher event at bar 109 to test gap entry resolution');
        assert(byStrategy.STRICT_CBC > 0 && byStrategy.PHL_BOS_MSS > 0 && byStrategy.DTFX_ZONES > 0 && byStrategy.VAM_REVERSAL > 0,
            'All 4 strategies must emit events');
        assert(preGapCount > 0 && postGapCount > 0, 'Events must emit on both sides of bar 110 discontinuity');
    });

    console.log(`\nPhase 5D Phase 2 Full Acceptance: ${passed} passed, ${failed} failed.`);
    return failed === 0;
}
