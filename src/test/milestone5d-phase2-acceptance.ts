import {
    adaptStrictCBCtoStrategyEvent,
    adaptVAMtoStrategyEvent,
    buildStrategyEventId,
    createStrategyEvent,
    resolveStrategyEventsEntryTimestamps,
    sortAndVerifyUniqueStrategyEvents,
    stepStrictCBCWithReset,
    validateAcceptedTimestampsSequence,
    validateStrictCBCCheckpoint,
    validateVAMCheckpoint,
    type StrategyEvent
} from '../indicators/mlr1/teachers/StrategyEventTypes';
import {
    createDefaultPHLConfig,
    createInitialPHLState,
    stepPHL,
    validatePHLState
} from '../indicators/mlr1/teachers/ProtectedHighsLowsTeacher';
import {
    createDefaultDTFXConfig,
    createInitialDTFXState,
    stepDTFX,
    validateDTFXState,
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

        const evEarlierBar = createStrategyEvent({
            strategyId: 'VAM_REVERSAL', strategyVersion: 'VAM_v1', symbol: 'SOLUSDT', timeframe: '1m',
            intervalMs: interval, eventType: 'VAM_BUY', eventDirection: 'bull',
            eventDiscriminator: 'BUY', sourceBarIndex: 29, sourceTimestamp: t0 + 29 * interval,
            confirmationBarIndex: 29, confirmationTimestamp: t0 + 29 * interval,
            entryTimestamp: t0 + 30 * interval, structuralContext: {}
        });
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

        const sorted = sortAndVerifyUniqueStrategyEvents([evVam, evDtfxR2, evCbc, evEarlierBar, evDtfxR1, evDtfxCreate]);
        assert(
            sorted[0] === evEarlierBar &&
            sorted[1] === evDtfxCreate &&
            sorted[2] === evDtfxR1 &&
            sorted[3] === evDtfxR2 &&
            sorted[4] === evCbc &&
            sorted[5] === evVam,
            'Canonical 4-key tie-breaking sort order failed'
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
        expectChronoErr(() => resolveStrategyEventsEntryTimestamps([evGap], [t0, t0 + 30_000, t0 + interval], interval), 'sub-interval gap < expectedIntervalMs');
        expectChronoErr(() => resolveStrategyEventsEntryTimestamps([evGap], [t0, t0 + interval, t0 + interval + 75_000], interval), 'off-grid timestamp gap');

        // Direct validateAcceptedTimestampsSequence() checks: 10m gap allowed; invalid expectedIntervalMs rejected
        validateAcceptedTimestampsSequence([t0, t0 + 10 * interval], interval);
        for (const badInterval of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
            expectChronoErr(
                () => validateAcceptedTimestampsSequence([t0, t0 + interval], badInterval),
                `validateAcceptedTimestampsSequence bad interval=${badInterval}`
            );
        }
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

        const ctrlClock = [c0.time, c1.time, c2.time, c3Contig.time];
        const gapClock = [c0.time, c1.time, c2.time, c3Gap.time, c4.time, c5.time];

        // 1. Prove BOTH real-engine directions pass validateStrictCBCCheckpoint WITH accepted clocks BEFORE negative checks
        validateStrictCBCCheckpoint(sCtrl, pCtrl, 3, c3Contig.time, ctrlClock);
        validateStrictCBCCheckpoint(sGap, pGap, 5, c5.time, gapClock);
        assert(sCtrl!.isBullish === true && pCtrl!.type === 'low' && sCtrl!.phaseHighIdx >= pCtrl!.confirmedBarIndex,
            'Bullish pair & active phase index verified');
        assert(sGap!.isBullish === false && pGap!.type === 'high' && sGap!.phaseLowIdx >= pGap!.confirmedBarIndex,
            'Bearish pair & active phase index verified');

        // 2. Reject stale/mismatched prevPivot, corrupted prevPivot.time, clock disagreement & activePhaseIdx < confirmedBarIndex
        const expectCbcReject = (
            stIn: StrictCBCState, pvIn: StrictZigZagPivot | null, barIdx: number,
            tsIn: number, clk: readonly number[] | undefined, label: string
        ) => {
            let threw = false;
            try { validateStrictCBCCheckpoint(stIn, pvIn, barIdx, tsIn, clk); }
            catch (e: any) { threw = String(e.message).includes('StrictCBC Checkpoint Error'); }
            assert(threw, `${label}: expected StrictCBC Checkpoint Error`);
        };
        expectCbcReject(sGap!, { ...pGap!, price: 999 }, 5, c5.time, gapClock, 'mismatched price');
        expectCbcReject(sGap!, { ...pGap!, type: 'low', label: 'LL' }, 5, c5.time, gapClock, 'wrong direction type');
        expectCbcReject(sGap!, { ...pGap!, time: -1 }, 5, c5.time, gapClock, 'negative prevPivot.time');
        expectCbcReject(sGap!, { ...pGap!, time: c5.time + interval }, 5, c5.time, gapClock, 'prevPivot.time > currentCandleTimestamp');
        expectCbcReject(sGap!, { ...pGap!, time: t0 }, 5, c5.time, gapClock, 'prevPivot.time disagrees with acceptedTimestamps[barIndex]');
        expectCbcReject({ ...sGap!, phaseLowIdx: 4 }, pGap!, 5, c5.time, gapClock, 'activePhaseIdx < prevPivot.confirmedBarIndex');
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
        expectPHLInputErr(() => stepPHL(validNext, 26, { ...st, ph: { price: 999, barIndex: 25, time: t0 + 25 * interval } }, cfgValid), 'retained ph disagrees with window');

        // Self-verifying preconditions on retained window
        assert(st.window.length === 10, `Expected PHL window length 10, got ${st.window.length}`);
        const firstWindowBar = st.window[0].barIndex;
        const lastWindowBar = st.window[st.window.length - 1].barIndex;
        assert(firstWindowBar === 16 && lastWindowBar === 25, `Unexpected PHL window [${firstWindowBar}..${lastWindowBar}]`);
        assert(st.trackLowIdx === 9 && st.trackLowIdx < firstWindowBar, 'trackLowIdx=9 must be genuinely expired');

        // Expired reference: valid index/time passes, shifted timestamp/index fail
        const validExpiredStep = stepPHL(validNext, 26, {
            ...st, trackLowIdx: 9, trackLowTime: t0 + 9 * interval, trackLow: 94
        }, cfgValid);
        assert(validExpiredStep.nextState.window.length === 10, 'Valid expired reference must be accepted');

        expectPHLInputErr(() => stepPHL(validNext, 26, {
            ...st, trackLowIdx: 9, trackLowTime: t0 + 8 * interval, trackLow: 94
        }, cfgValid), 'expired-window shifted timestamp');
        expectPHLInputErr(() => stepPHL(validNext, 26, {
            ...st, trackLowIdx: 8, trackLowTime: t0 + 9 * interval, trackLow: 94
        }, cfgValid), 'expired-window shifted index');
        expectPHLInputErr(() => stepPHL(validNext, 26, {
            ...st, trackLowIdx: 9, trackLowTime: st.window[0].time, trackLow: 94
        }, cfgValid), 'expired-window timestamp >= minTime');

        // Isolated absent-from-window index check (all other invariants valid)
        const gappedWindow = st.window.filter(w => w.barIndex !== 20);
        let absentErrMsg = '';
        try {
            stepPHL(validNext, 26, {
                ...st, window: gappedWindow, trackHighIdx: 20, trackHighTime: t0 + 20 * interval, trackHigh: 112
            }, cfgValid);
        } catch (e: any) { absentErrMsg = e?.message || ''; }
        assert(absentErrMsg.includes('missing from retained window'), `Expected missing-index error, got: ${absentErrMsg}`);

        // lastHigh retained-window timestamp & price checks
        expectPHLInputErr(() => stepPHL(validNext, 26, { ...st, lastHighTime: t0 + 999 }, cfgValid), 'corrupted lastHighTime');
        expectPHLInputErr(() => stepPHL(validNext, 26, { ...st, lastHigh: 999 }, cfgValid), 'corrupted lastHigh price');

        // Out-of-range index (> lastWindowBar)
        expectPHLInputErr(() => stepPHL(validNext, 26, { ...st, trackHighIdx: 999 }, cfgValid), 'out-of-range trackHighIdx');

        // Gapped-segment clock provenance tests (3m non-discontinuity gap at bar 10)
        let stGap = createInitialPHLState();
        for (let i = 0; i < stream.length; i++) {
            const gTime = i < 10 ? t0 + i * interval : t0 + (i + 2) * interval;
            const c = makeCandle(gTime, stream[i].open, stream[i].high, stream[i].low, stream[i].close, 100);
            stGap = stepPHL(c, i, stGap, cfgValid, false, 2.0, null).nextState;
        }
        assert(
            stGap.clockCheckpoints.length === 2 &&
            stGap.clockCheckpoints[0].barIndex === 0 &&
            stGap.clockCheckpoints[0].time === t0 &&
            stGap.clockCheckpoints[1].barIndex === 10 &&
            stGap.clockCheckpoints[1].time === t0 + 12 * interval,
            'PHL checkpoints must identify exact pre-gap (0) and post-gap (10) anchors'
        );
        assert(stGap.trackLowIdx === 9 && stGap.trackLowTime === t0 + 9 * interval, 'Pre-gap expired trackLow @9');

        const postGap26 = makeCandle(t0 + 28 * interval, 90, 92, 88, 91, 100);
        // Valid expired pre-gap reference passes
        const gapOk = stepPHL(postGap26, 26, stGap, cfgValid, false, 2.0, null);
        assert(gapOk.nextState.window.length === 10, 'Valid expired pre-gap reference after genuine gap must pass');
        // Shifted pre-gap index/time & wrong post-gap offset fail
        expectPHLInputErr(() => stepPHL(postGap26, 26, { ...stGap, trackLowTime: t0 + 10 * interval }, cfgValid), 'gapped shifted pre-gap time');
        expectPHLInputErr(() => stepPHL(postGap26, 26, { ...stGap, trackLowIdx: 8 }, cfgValid), 'gapped shifted pre-gap index');
        expectPHLInputErr(() => stepPHL(postGap26, 26, {
            ...stGap, trackLowIdx: 11, trackLowTime: t0 + 11 * interval, trackLow: 94
        }, cfgValid), 'post-gap expired ref using wrong pre-gap arithmetic');

        // Retained missing barIndex & expired-window clock alignment checks
        const minW = st.window[0];
        expectPHLInputErr(() => stepPHL(validNext, 26, {
            ...st,
            window: st.window.filter(w => w.barIndex !== minW.barIndex + 2),
            ph: { price: st.window[2].high, barIndex: st.window[2].barIndex, time: st.window[2].time }
        }, cfgValid), 'retained ph missing from window');
        expectPHLInputErr(() => stepPHL(validNext, 26, {
            ...st,
            ph: { price: 125, barIndex: minW.barIndex - 1, time: minW.time }
        }, cfgValid), 'expired ph time >= minTime');
        expectPHLInputErr(() => stepPHL(validNext, 26, {
            ...st,
            ph: { price: 125, barIndex: minW.barIndex - 1, time: minW.time - 30_000 }
        }, cfgValid), 'expired ph off-grid time');
        expectPHLInputErr(() => stepPHL(validNext, 26, {
            ...st,
            pl: { price: 85, barIndex: minW.barIndex - 1, time: minW.time - 15_000 }
        }, cfgValid), 'expired pl off-grid time');
        expectPHLInputErr(() => stepPHL(validNext, 26, {
            ...st,
            trackHigh: 125,
            trackHighIdx: minW.barIndex - 1,
            trackHighTime: minW.time + interval
        }, cfgValid), 'expired trackHigh time >= minTime');
        expectPHLInputErr(() => stepPHL(validNext, 26, {
            ...st,
            trackLow: 85,
            trackLowIdx: minW.barIndex - 1,
            trackLowTime: minW.time - 30_000
        }, cfgValid), 'expired trackLow off-grid time');
        expectPHLInputErr(() => stepPHL(validNext, 26, {
            ...st,
            window: st.window.map((w, idx) => idx === st.window.length - 1 ? { ...w, time: w.time + 1_000 } : w)
        }, cfgValid), 'window timestamps off-grid');
        expectPHLInputErr(() => stepPHL(validNext, 26, {
            ...st,
            window: [{ ...st.window[0], volume: -1 }, ...st.window.slice(1)]
        }, cfgValid), 'window[0].volume: -1');

        // Valid expired ph on intervalMs grid (< minTime) must be accepted
        const expiredValidRes = stepPHL(validNext, 26, {
            ...st,
            ph: { price: 125, barIndex: minW.barIndex - 2, time: minW.time - 2 * interval }
        }, cfgValid);
        assert(expiredValidRes.nextState.ph?.price === 125, 'Valid grid-aligned expired ph must be accepted');

        // Single-field checkpoint corruption anchored by retained window
        expectPHLInputErr(() => stepPHL(validNext, 26, {
            ...st,
            clockCheckpoints: [{ barIndex: 0, time: t0 + 1 }]
        }, cfgValid), 'single-field PHL checkpoint corruption');

        // B2.1 Empty-window non-null reference rejections
        const emptyPhl = createInitialPHLState();
        // Verify production createInitialPHLState() passes validatePHLState cleanly when window is empty
        validatePHLState(emptyPhl, 2 * cfgValid.pivotStrength + 4, interval);
        expectPHLInputErr(() => stepPHL(makeCandle(t0, 100, 102, 98, 101, 100), 0, {
            ...emptyPhl, lastHigh: 105, lastHighIdx: 0, lastHighTime: t0
        }, cfgValid), 'empty window + non-null lastHigh');
        expectPHLInputErr(() => stepPHL(makeCandle(t0, 100, 102, 98, 101, 100), 0, {
            ...emptyPhl, trackLow: 95, trackLowIdx: 0, trackLowTime: t0
        }, cfgValid), 'empty window + non-null trackLow');
        expectPHLInputErr(() => stepPHL(makeCandle(t0, 100, 102, 98, 101, 100), 0, {
            ...emptyPhl, ph: { price: 105, barIndex: 0, time: t0 }
        }, cfgValid), 'empty window + non-null ph');

        // Null / malformed trackers and wrong-direction empty-window tracker must throw PHL State Integrity Error (never TypeError)
        expectPHLInputErr(() => stepPHL(makeCandle(t0, 100, 102, 98, 101, 100), 0, {
            ...emptyPhl, pbFromHigh: null as any
        }, cfgValid), 'pbFromHigh: null');
        expectPHLInputErr(() => stepPHL(makeCandle(t0, 100, 102, 98, 101, 100), 0, {
            ...emptyPhl, pbFromLow: null as any
        }, cfgValid), 'pbFromLow: null');
        expectPHLInputErr(() => stepPHL(makeCandle(t0, 100, 102, 98, 101, 100), 0, {
            ...emptyPhl, pbFromHigh: { price: null, idx: null, bull: true } as any
        }, cfgValid), 'tracker missing valid field');
        expectPHLInputErr(() => stepPHL(makeCandle(t0, 100, 102, 98, 101, 100), 0, {
            ...emptyPhl, pbFromHigh: { price: null, idx: null, valid: false, bull: false }
        }, cfgValid), 'empty-window tracker wrong bull direction');
        expectPHLInputErr(() => stepPHL(makeCandle(t0, 100, 102, 98, 101, 100), 0, {
            ...emptyPhl, bull: true
        }, cfgValid), 'empty window with bull !== null');

        // B2.3 Direct validatePHLState argument checks
        let badPhlArgs = false;
        try { validatePHLState(emptyPhl, 0, interval); } catch { badPhlArgs = true; }
        assert(badPhlArgs, 'validatePHLState must reject maxWin=0');
        badPhlArgs = false;
        try { validatePHLState(emptyPhl, 10, 0); } catch { badPhlArgs = true; }
        assert(badPhlArgs, 'validatePHLState must reject intervalMs=0');
    });

    // 3. DTFX Teacher: bar-by-bar lifecycle, immediate touch @17, post-exit check, non-vacuous BOS preservation, verified cap [1,2,3], discontinuity latches & full corruption suite
    runTest('3. DTFX Teacher: lifecycle, immediate touch, post-exit, BOS preservation, cap & corruptions', () => {
        const cfg = createDefaultDTFXConfig('SOLUSDT', '1m', interval);
        assert(createInitialDTFXState(3).nextZoneId === 3, 'createInitialDTFXState(3) must set nextZoneId=3');

        // Exact 24-bar hand-verified lifecycle sequence
        const lcCandles: ML1Candle[] = [];
        for (let i = 0; i <= 15; i++) {
            if (i === 0) lcCandles.push(makeCandle(t0, 105, 115, 104, 106, 100));
            else if (i === 5) lcCandles.push(makeCandle(t0 + i * interval, 104, 106, 98, 103, 100));
            else lcCandles.push(makeCandle(t0 + i * interval, 105, 108, 102, 105, 100));
        }
        lcCandles.push(makeCandle(t0 + 16 * interval, 106, 118, 106, 117, 100));
        lcCandles.push(makeCandle(t0 + 17 * interval, 117, 119, 116, 118, 100));
        lcCandles.push(makeCandle(t0 + 18 * interval, 116, 117, 94, 114, 100)); // wick < 95 keeps Bar 22 from making 10-bar low
        lcCandles.push(makeCandle(t0 + 19 * interval, 114, 115, 109, 113, 100));
        lcCandles.push(makeCandle(t0 + 20 * interval, 116, 118, 116, 117, 100));
        lcCandles.push(makeCandle(t0 + 21 * interval, 117, 117, 110, 111, 100));
        lcCandles.push(makeCandle(t0 + 22 * interval, 111, 111, 95, 96, 100));
        lcCandles.push(makeCandle(t0 + 23 * interval, 96, 105, 96, 104, 100));

        let lcState = createInitialDTFXState();
        let stateAt16!: DTFXState;
        let stateAt18!: DTFXState;
        let stateAt20!: DTFXState;
        let stateAt21!: DTFXState;

        for (let i = 0; i < lcCandles.length; i++) {
            const res = stepDTFX(lcCandles[i], i, lcState, cfg, false, 2.0, null);
            lcState = res.nextState;
            if (i === 16) stateAt16 = lcState;
            if (i === 18) stateAt18 = lcState;
            if (i === 20) stateAt20 = lcState;
            if (i === 21) stateAt21 = lcState;

            if (i === 16) {
                assert(res.createdZones.length === 1 && res.events[0].eventType === 'DTFX_DEMAND_CREATED', 'Bar 16 CREATED');
                const z = lcState.activeZones[0];
                assert(z.status === 'ACTIVE' && z.retestCount === 0 && !z.isCurrentlyInZone && z.top === 115 && z.bot === 98, 'Bar 16 state');
            } else if (i === 17) {
                const z = lcState.activeZones[0];
                assert(res.events.length === 0 && z.status === 'ACTIVE' && z.retestCount === 0 && !z.isCurrentlyInZone, 'Bar 17 above');
            } else if (i === 18) {
                const z = lcState.activeZones[0];
                assert(res.events.length === 1 && res.events[0].eventDiscriminator === '1_R1', 'Bar 18 _R1 event');
                assert(z.status === 'RETESTED' && z.retestCount === 1 && z.isCurrentlyInZone &&
                    z.firstRetestBarIndex === 18 && z.firstRetestTimestamp === t0 + 18 * interval &&
                    z.lastRetestBarIndex === 18 && z.lastRetestTimestamp === t0 + 18 * interval, 'Bar 18 state');
            } else if (i === 19) {
                const z = lcState.activeZones[0];
                assert(res.events.length === 0 && z.status === 'RETESTED' && z.retestCount === 1 && z.isCurrentlyInZone &&
                    z.firstRetestBarIndex === 18 && z.lastRetestBarIndex === 18, 'Bar 19 linger preserves metadata');
            } else if (i === 20) {
                const z = lcState.activeZones[0];
                assert(res.events.length === 0 && z.status === 'RETESTED' && z.retestCount === 1 && !z.isCurrentlyInZone, 'Bar 20 exit clears latch');
            } else if (i === 21) {
                const z = lcState.activeZones[0];
                assert(res.events.length === 1 && res.events[0].eventDiscriminator === '1_R2', 'Bar 21 _R2 event');
                assert(z.status === 'RETESTED' && z.retestCount === 2 && z.isCurrentlyInZone &&
                    z.firstRetestBarIndex === 18 && z.lastRetestBarIndex === 21 && z.lastRetestTimestamp === t0 + 21 * interval, 'Bar 21 state');
            } else if (i === 22) {
                assert(res.invalidatedZones.length === 1 && res.retestedZones.length === 0 && res.events.length === 0 && lcState.activeZones.length === 0, 'Bar 22 invalidation beats retest');
                const inv = res.invalidatedZones[0];
                assert(inv.status === 'INVALIDATED' && inv.retestCount === 2 &&
                    inv.firstRetestBarIndex === 18 && inv.firstRetestTimestamp === t0 + 18 * interval &&
                    inv.lastRetestBarIndex === 21 && inv.lastRetestTimestamp === t0 + 21 * interval && !inv.isCurrentlyInZone,
                    'Invalidated zone preserves full retest history');
            } else if (i === 23) {
                assert(res.events.length === 0 && lcState.activeZones.length === 0, 'Bar 23 post-invalidation silent');
            }
        }

        // Repeated-bar chronology rejection
        let repeatRejected = false;
        try { stepDTFX(lcCandles[23], 23, lcState, cfg); } catch (e: any) { repeatRejected = String(e.message).includes('Chronology Error'); }
        assert(repeatRejected, 'Repeated bar 23 must be rejected');

        // Fixed post-exit test: verify stateAt20 latch/count BEFORE stepping, then feed a valid NON-INTERSECTING bar 21 (low=117 > top=115)
        assert(stateAt20.activeZones[0].isCurrentlyInZone === false && stateAt20.activeZones[0].retestCount === 1,
            'State after bar 20 exit must have isCurrentlyInZone=false and retestCount=1');
        const postExitCheck = stepDTFX(makeCandle(t0 + 21 * interval, 117, 120, 117, 119, 100), 21, stateAt20, cfg);
        assert(postExitCheck.events.length === 0 &&
            postExitCheck.nextState.activeZones[0].status === 'RETESTED' &&
            postExitCheck.nextState.activeZones[0].retestCount === 1 &&
            postExitCheck.nextState.activeZones[0].firstRetestBarIndex === 18 &&
            postExitCheck.nextState.activeZones[0].firstRetestTimestamp === t0 + 18 * interval &&
            postExitCheck.nextState.activeZones[0].lastRetestBarIndex === 18 &&
            postExitCheck.nextState.activeZones[0].lastRetestTimestamp === t0 + 18 * interval &&
            !postExitCheck.nextState.activeZones[0].isCurrentlyInZone,
            'Non-intersecting candle after exit must emit nothing and preserve retest metadata');

        // Immediate touch on first eligible bar (bar 17 right after bar 16 creation) transitions ACTIVE -> RETESTED (1_R1)
        const immediateTouch = stepDTFX(makeCandle(t0 + 17 * interval, 117, 117, 112, 114, 100), 17, stateAt16, cfg);
        assert(immediateTouch.retestedZones.length === 1 && immediateTouch.events[0].eventDiscriminator === '1_R1' &&
            immediateTouch.nextState.activeZones[0].status === 'RETESTED',
            'First eligible bar touching zone must transition ACTIVE -> RETESTED');

        // Exact null-candle + non-null entryTimestamp check asserting 'DTFX Input Error'
        let nullDtfxMatched = false;
        try {
            stepDTFX(null as any, 0, createInitialDTFXState(), cfg, false, null, t0 + interval);
        } catch (e: any) {
            nullDtfxMatched = e instanceof Error && !(e instanceof TypeError) && e.message.includes('DTFX Input Error');
        }
        assert(nullDtfxMatched, 'Null candle + entryTimestamp must throw DTFX Input Error');

        // Non-vacuous Bullish & Bearish degenerate geometry tests (valid state passing validateDTFXState where zTop === zBot):
        // 1. Assert candidate setup BEFORE break, 2. Trigger degenerate candidate -> no zone + BOS check preserved,
        // 3. Prove preserved BOS check creates a REAL valid zone and consumes the flag!
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
            clockCheckpoints: Object.freeze([Object.freeze({ barIndex: 10, time: t0 + 10 * interval })]),
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
        assert(degBullState.bosUpCheck === true && degBullState.t?.price === 112 && degBullState.prevTPrice === 112 && degBullState.prevClose === 112,
            'Bull degenerate precondition: bosUpCheck armed at 112');
        const degBullRes = stepDTFX(makeCandle(t0 + 20 * interval, 112, 115, 112, 114, 100), 20, degBullState, cfg, false, 2.0, null);
        assert(degBullRes.createdZones.length === 0 && degBullRes.events.length === 0 && degBullRes.nextState.bosUpCheck === true,
            'Bull degenerate candidate must skip zone and preserve bosUpCheck');
        const degBullRecoverWindow = Array.from({ length: cfg.structureLen }, (_, k) => ({
            barIndex: 10 + k,
            time: t0 + (10 + k) * interval,
            open: 110,
            high: 112,
            low: 108,
            close: 111,
            volume: 100
        }));
        const degBullValid = stepDTFX(
            makeCandle(t0 + 20 * interval, 111, 115, 111, 114, 100),
            20,
            {
                ...createInitialDTFXState(2),
                clockCheckpoints: Object.freeze([Object.freeze({ barIndex: 10, time: t0 + 10 * interval })]),
                window: Object.freeze(degBullRecoverWindow),
                dir: 1 as const,
                tDir: 1 as const,
                t: Object.freeze({ price: 112, barIndex: 18, time: t0 + 18 * interval }),
                b: Object.freeze({ price: 108, barIndex: 19, time: t0 + 19 * interval }),
                prevTPrice: 112,
                prevBPrice: 108,
                prevClose: 111,
                bosUpCheck: degBullRes.nextState.bosUpCheck
            },
            cfg,
            false,
            2.0,
            null
        );
        assert(degBullValid.createdZones.length === 1 && !degBullValid.nextState.bosUpCheck,
            'Preserved bosUpCheck must create subsequent valid demand zone and then consume bosUpCheck');

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
            clockCheckpoints: Object.freeze([Object.freeze({ barIndex: 10, time: t0 + 10 * interval })]),
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
        assert(degBearState.bosDownCheck === true && degBearState.b?.price === 98 && degBearState.prevBPrice === 98 && degBearState.prevClose === 98,
            'Bear degenerate precondition: bosDownCheck armed at 98');
        const degBearRes = stepDTFX(makeCandle(t0 + 20 * interval, 98, 98, 95, 96, 100), 20, degBearState, cfg, false, 2.0, null);
        assert(degBearRes.createdZones.length === 0 && degBearRes.events.length === 0 && degBearRes.nextState.bosDownCheck === true,
            'Bear degenerate candidate must skip zone and preserve bosDownCheck');
        const degBearRecoverWindow = Array.from({ length: cfg.structureLen }, (_, k) => ({
            barIndex: 10 + k,
            time: t0 + (10 + k) * interval,
            open: 100,
            high: 102,
            low: 98,
            close: 99,
            volume: 100
        }));
        const degBearValid = stepDTFX(
            makeCandle(t0 + 20 * interval, 99, 99, 95, 96, 100),
            20,
            {
                ...createInitialDTFXState(2),
                clockCheckpoints: Object.freeze([Object.freeze({ barIndex: 10, time: t0 + 10 * interval })]),
                window: Object.freeze(degBearRecoverWindow),
                dir: -1 as const,
                tDir: -1 as const,
                b: Object.freeze({ price: 98, barIndex: 18, time: t0 + 18 * interval }),
                t: Object.freeze({ price: 102, barIndex: 19, time: t0 + 19 * interval }),
                prevTPrice: 102,
                prevBPrice: 98,
                prevClose: 99,
                bosDownCheck: degBearRes.nextState.bosDownCheck
            },
            cfg,
            false,
            2.0,
            null
        );
        assert(degBearValid.createdZones.length === 1 && !degBearValid.nextState.bosDownCheck,
            'Preserved bosDownCheck must create subsequent valid supply zone and then consume bosDownCheck');

        // Exact maxActiveZones = 2 eviction test: verify exact bars (16, 33, 50) & bounds ([101,115], [131,145], [161,175])
        const capCfg = { ...cfg, maxActiveZones: 2 };
        let capState = createInitialDTFXState();
        const capCreated: Array<{ id: number; bar: number; bot: number; top: number }> = [];
        const capInvalidatedTotal: number[] = [];
        let capBar = 0;
        let sawEvictionOnBar50 = false;
        const pushCap = (c: ML1Candle) => {
            const r = stepDTFX(c, capBar, capState, capCfg, false, 2.0, null);
            capState = r.nextState;
            for (const z of r.createdZones) capCreated.push({ id: z.zoneId, bar: capBar, bot: z.bot, top: z.top });
            if (capBar === 50) {
                assert(
                    r.createdZones.length === 1 &&
                    r.createdZones[0].zoneId === 3 &&
                    r.invalidatedZones.length === 0 &&
                    r.events.length === 1 &&
                    r.events[0].eventType === 'DTFX_DEMAND_CREATED',
                    'Bar 50 must create zone 3 and evict oldest zone without invalidation'
                );
                sawEvictionOnBar50 = true;
            }
            if (r.invalidatedZones.length > 0) capInvalidatedTotal.push(capBar);
            capBar++;
        };
        for (let wave = 0; wave < 3; wave++) {
            const base = 100 + wave * 30;
            pushCap(makeCandle(t0 + capBar * interval, base + 5, base + 15, base + 4, base + 6, 100));
            for (let k = 1; k <= 10; k++) pushCap(makeCandle(t0 + capBar * interval, base + 5, base + 8, k === 5 ? base + 1 : base + 4, base + 5, 100));
            for (let k = 0; k < 5; k++) pushCap(makeCandle(t0 + capBar * interval, base + 5, base + 8, base + 4, base + 5, 100));
            pushCap(makeCandle(t0 + capBar * interval, base + 6, base + 20, base + 6, base + 19, 100));
        }
        assert(sawEvictionOnBar50, 'Eviction bar 50 executed');
        assert(
            capCreated.length === 3 &&
            capCreated[0].id === 1 && capCreated[0].bar === 16 && capCreated[0].bot === 101 && capCreated[0].top === 115 &&
            capCreated[1].id === 2 && capCreated[1].bar === 33 && capCreated[1].bot === 131 && capCreated[1].top === 145 &&
            capCreated[2].id === 3 && capCreated[2].bar === 50 && capCreated[2].bot === 161 && capCreated[2].top === 175,
            `Unexpected cap creation sequence: ${JSON.stringify(capCreated)}`
        );
        assert(capInvalidatedTotal.length === 0 && capState.activeZones.length === 2 &&
            capState.activeZones[0].zoneId === 2 && capState.activeZones[1].zoneId === 3 && capState.nextZoneId === 4,
            'Oldest zone 1 evicted without invalidation; zones [2,3] retained and nextZoneId=4');

        // Genuinely progress stateAt18 -> bar 19 exit -> bars 20..36 creating Zone 2 (ACTIVE) while Zone 1 remains RETESTED!
        let mixedProgress = stepDTFX(makeCandle(t0 + 19 * interval, 116, 122, 116, 121, 100), 19, stateAt18, cfg).nextState;
        mixedProgress = stepDTFX(makeCandle(t0 + 20 * interval, 121, 140, 121, 135, 100), 20, mixedProgress, cfg).nextState;
        for (let bIdx = 21; bIdx <= 35; bIdx++) {
            const c = bIdx === 25
                ? makeCandle(t0 + bIdx * interval, 129, 131, 125, 128, 100)
                : makeCandle(t0 + bIdx * interval, 130, 134, 128, 130, 100);
            mixedProgress = stepDTFX(c, bIdx, mixedProgress, cfg).nextState;
        }
        const z2CreateRes = stepDTFX(makeCandle(t0 + 36 * interval, 130, 145, 130, 144, 100), 36, mixedProgress, cfg);
        assert(
            z2CreateRes.createdZones.length === 1 &&
            z2CreateRes.createdZones[0].zoneId === 2 &&
            z2CreateRes.createdZones[0].bot === 121 &&
            z2CreateRes.createdZones[0].top === 140 &&
            z2CreateRes.events.length === 1 &&
            z2CreateRes.events[0].eventType === 'DTFX_DEMAND_CREATED' &&
            z2CreateRes.events[0].sourceBarIndex === 20 &&
            z2CreateRes.events[0].confirmationBarIndex === 36,
            'Bar 36 must create Zone 2 [121, 140] from bar 20 swing'
        );
        mixedProgress = z2CreateRes.nextState;
        assert(
            mixedProgress.activeZones.length === 2 &&
            mixedProgress.activeZones[0].zoneId === 1 && mixedProgress.activeZones[0].status === 'RETESTED' &&
            mixedProgress.activeZones[1].zoneId === 2 && mixedProgress.activeZones[1].status === 'ACTIVE' &&
            mixedProgress.nextZoneId === 3,
            'Genuine mixed RETESTED (zone 1) + ACTIVE (zone 2) state established before discontinuity'
        );
        const discRes = stepDTFX(makeCandle(t0 + 46 * interval, 144, 145, 143, 144, 100), 37, mixedProgress, cfg, true);
        assert(discRes.nextState.activeZones.length === 0 && discRes.nextState.nextZoneId === 3 &&
            discRes.nextState.clockCheckpoints.length === 1 &&
            discRes.nextState.dir === 0 && discRes.nextState.tDir === 0 && discRes.nextState.t === null && discRes.nextState.b === null,
            'Discontinuity must clear ACTIVE+RETESTED zones, latches, and clockCheckpoints while preserving nextZoneId=3');

        // Exhaustive DTFX state corruption & config validation negative suite
        const expectDTFXReject = (badState: DTFXState, testCfg = cfg, nextBar = 22, nextC = makeCandle(t0 + 22 * interval, 111, 112, 110, 111, 100), label = '') => {
            let threw = false;
            try { stepDTFX(nextC, nextBar, badState, testCfg); } catch (e: any) { threw = String(e.message).includes('DTFX '); }
            assert(threw, `${label}: expected DTFX error`);
        };
        const baseZ16 = stateAt16.activeZones[0];
        const baseZ18 = stateAt18.activeZones[0];
        const baseZ21 = stateAt21.activeZones[0];

        expectDTFXReject({ ...stateAt16, activeZones: [{ ...baseZ16, firstRetestTimestamp: t0 + 17 * interval }] }, cfg, 17, lcCandles[17], 'ACTIVE with retest timestamp');
        expectDTFXReject({ ...stateAt18, activeZones: [{ ...baseZ18, isCurrentlyInZone: 'true' as any }] }, cfg, 19, lcCandles[19], 'non-boolean isCurrentlyInZone');
        expectDTFXReject({ ...stateAt18, activeZones: [{ ...baseZ18, firstRetestBarIndex: null }] }, cfg, 19, lcCandles[19], 'RETESTED missing firstRetestBarIndex');
        expectDTFXReject({ ...stateAt18, activeZones: [{ ...baseZ18, lastRetestBarIndex: null }] }, cfg, 19, lcCandles[19], 'RETESTED missing lastRetestBarIndex');
        expectDTFXReject({ ...stateAt18, activeZones: [{ ...baseZ18, firstRetestTimestamp: null }] }, cfg, 19, lcCandles[19], 'RETESTED missing firstRetestTimestamp');
        expectDTFXReject({ ...stateAt18, activeZones: [{ ...baseZ18, lastRetestTimestamp: null }] }, cfg, 19, lcCandles[19], 'RETESTED missing lastRetestTimestamp');
        expectDTFXReject({ ...stateAt18, activeZones: [{ ...baseZ18, firstRetestBarIndex: 16, firstRetestTimestamp: t0 + 16 * interval }] }, cfg, 19, lcCandles[19], 'retest metadata <= creation');
        expectDTFXReject({ ...stateAt18, activeZones: [{ ...baseZ18, lastRetestBarIndex: 19, lastRetestTimestamp: t0 + 19 * interval }] }, cfg, 19, lcCandles[19], 'retestCount=1 different first/last bars');
        expectDTFXReject({ ...stateAt21, activeZones: [{ ...baseZ21, firstRetestBarIndex: 21, firstRetestTimestamp: t0 + 21 * interval }] }, cfg, 22, lcCandles[22], 'retestCount>1 same first/last bars');
        expectDTFXReject({ ...stateAt21, activeZones: [{ ...baseZ21, lastRetestBarIndex: 25, lastRetestTimestamp: t0 + 25 * interval }] }, cfg, 22, lcCandles[22], 'lastRetest beyond latest retained bar');
        expectDTFXReject({ ...stateAt18, activeZones: [{ ...baseZ18, firstRetestTimestamp: t0 + 18 * interval + 1 }] }, cfg, 19, lcCandles[19], 'retest timestamp disagrees with window');
        expectDTFXReject({ ...stateAt18, activeZones: [{ ...baseZ18, firstRetestBarIndex: 17, firstRetestTimestamp: t0 + 17 * interval, lastRetestBarIndex: 17, lastRetestTimestamp: t0 + 17 * interval }] }, cfg, 19, lcCandles[19], 'retest candle does not intersect zone');
        expectDTFXReject({ ...stateAt18, activeZones: [{ ...baseZ18, isCurrentlyInZone: false }] }, cfg, 19, lcCandles[19], 'isCurrentlyInZone=false while latest bar intersects');
        expectDTFXReject({ ...stateAt20, activeZones: [{ ...stateAt20.activeZones[0], isCurrentlyInZone: true }] }, cfg, 21, lcCandles[21], 'isCurrentlyInZone=true while latest bar outside');
        expectDTFXReject({ ...stateAt18, activeZones: [{ ...baseZ18, zoneId: 1.5 }] }, cfg, 19, lcCandles[19], 'non-integer zoneId');
        expectDTFXReject({ ...stateAt18, activeZones: [{ ...baseZ18, top: 100, bot: 100 }] }, cfg, 19, lcCandles[19], 'zero-width stored zone geometry');
        expectDTFXReject({ ...stateAt18, activeZones: [{ ...baseZ18, fib05: 200 }] }, cfg, 19, lcCandles[19], 'fib05 out of zone bounds');
        expectDTFXReject({ ...stateAt18, nextZoneId: 1 }, cfg, 19, lcCandles[19], 'nextZoneId <= retained zoneId');
        expectDTFXReject({ ...stateAt18, activeZones: [baseZ18, { ...baseZ18, bot: 97 }] }, cfg, 19, lcCandles[19], 'duplicate zoneIds across distinct records');
        expectDTFXReject({ ...capState, activeZones: [...capState.activeZones, { ...capState.activeZones[0], zoneId: 1 }] }, capCfg, capBar, makeCandle(t0 + capBar * interval, 180, 181, 179, 180, 100), 'exceeds maxActiveZones=2');

        // Additional config & clock alignment checks
        expectDTFXReject(createInitialDTFXState(), { ...cfg, fibLevels: [0.5, 0.3, 0.7] }, 0, lcCandles[0], 'unordered fibLevels');
        expectDTFXReject(createInitialDTFXState(), { ...cfg, fibLevels: [0, 0.5, 0.7] }, 0, lcCandles[0], 'fibLevel=0 outside (0,1)');
        expectDTFXReject(createInitialDTFXState(), { ...cfg, fibLevels: [0.3, 0.3, 0.7] }, 0, lcCandles[0], 'duplicate fibLevels');
        expectDTFXReject({
            ...stateAt16,
            window: stateAt16.window.map((w, idx) => idx === stateAt16.window.length - 1 ? { ...w, time: w.time + 1_000 } : w)
        }, cfg, 17, lcCandles[17], 'off-grid window bar timestamp');
        expectDTFXReject({
            ...stateAt16,
            t: { price: 115, barIndex: 0, time: stateAt16.window[0].time - 15_000 }
        }, cfg, 17, lcCandles[17], 'expired swing t off-grid timestamp');
        expectDTFXReject({
            ...stateAt16,
            t: { price: 115, barIndex: 0, time: stateAt16.window[0].time }
        }, cfg, 17, lcCandles[17], 'expired swing t >= minTime');

        // Gap-specific DTFX provenance tests (3m non-discontinuity gap at bar 11)
        let dtfxGap = createInitialDTFXState();
        for (let i = 0; i <= 18; i++) {
            const gTime = i < 11 ? t0 + i * interval : t0 + (i + 2) * interval;
            const src = lcCandles[i];
            dtfxGap = stepDTFX(makeCandle(gTime, src.open, src.high, src.low, src.close, 100), i, dtfxGap, cfg, false, 2.0, null).nextState;
        }
        assert(
            dtfxGap.clockCheckpoints.length === 2 &&
            dtfxGap.clockCheckpoints[0].barIndex === 0 &&
            dtfxGap.clockCheckpoints[0].time === t0 &&
            dtfxGap.clockCheckpoints[1].barIndex === 11 &&
            dtfxGap.clockCheckpoints[1].time === t0 + 13 * interval &&
            dtfxGap.activeZones[0].status === 'RETESTED',
            'DTFX gap checkpoints must identify exact pre-gap (0) and post-gap (11) anchors'
        );
        const gZone = dtfxGap.activeZones[0];
        const postGap19 = makeCandle(t0 + 21 * interval, 114, 115, 109, 113, 100);
        // Valid gapped state passes
        assert(stepDTFX(postGap19, 19, dtfxGap, cfg).nextState.activeZones.length === 1, 'Valid gapped DTFX state must pass');
        // Shifted/cross-gap corruptions fail
        expectDTFXReject({ ...dtfxGap, activeZones: [{ ...gZone, createdSourceBarIndex: 1, createdSourceTimestamp: t0 }] }, cfg, 19, postGap19, 'gapped shifted source index');
        expectDTFXReject({ ...dtfxGap, activeZones: [{ ...gZone, createdSourceTimestamp: t0 + interval }] }, cfg, 19, postGap19, 'gapped shifted source timestamp');
        expectDTFXReject({ ...dtfxGap, activeZones: [{ ...gZone, createdConfirmationTimestamp: t0 + 16 * interval }] }, cfg, 19, postGap19, 'gapped creation span ignoring gap');
        expectDTFXReject({ ...dtfxGap, activeZones: [{ ...gZone, firstRetestTimestamp: t0 + 18 * interval }] }, cfg, 19, postGap19, 'gapped retest timestamp ignoring gap');

        // C2.1 Equal source & confirmation bars must be rejected
        expectDTFXReject({
            ...stateAt16,
            activeZones: [{ ...baseZ16, createdSourceBarIndex: 16, createdSourceTimestamp: t0 + 16 * interval }]
        }, cfg, 17, lcCandles[17], 'equal source and confirmation indices');

        // C2.2 Empty window with non-empty activeZones must be rejected
        expectDTFXReject({
            ...createInitialDTFXState(2),
            activeZones: [baseZ16]
        }, cfg, 0, lcCandles[0], 'empty window with activeZones');

        // Complete field-by-field DTFXState empty-window audit:
        // DTFXState fields = { stateVersion, clockCheckpoints, window, dir, tDir, t, b, prevTPrice, prevBPrice, prevClose, bosUpCheck, bosDownCheck, nextZoneId, activeZones }
        const emptyDtfx = createInitialDTFXState();
        validateDTFXState(emptyDtfx, cfg.structureLen + 1, cfg.maxActiveZones, cfg.intervalMs);
        const dummyPt = { price: 105, barIndex: 0, time: t0 };
        expectDTFXReject({ ...emptyDtfx, clockCheckpoints: [{ barIndex: 0, time: t0 }] }, cfg, 0, lcCandles[0], 'empty window with clockCheckpoints');
        expectDTFXReject({ ...emptyDtfx, stateVersion: -1 as any }, cfg, 0, lcCandles[0], 'empty window with invalid stateVersion');
        expectDTFXReject({ ...emptyDtfx, nextZoneId: 0 }, cfg, 0, lcCandles[0], 'empty window with invalid nextZoneId');
        expectDTFXReject({ ...emptyDtfx, t: dummyPt }, cfg, 0, lcCandles[0], 'empty window with non-null t');
        expectDTFXReject({ ...emptyDtfx, t: { price: null, barIndex: 0, time: t0 } as any }, cfg, 0, lcCandles[0], 'empty window with partial swing t index/time');
        expectDTFXReject({ ...emptyDtfx, b: dummyPt }, cfg, 0, lcCandles[0], 'empty window with non-null b');
        expectDTFXReject({ ...emptyDtfx, b: { price: null, barIndex: 0, time: t0 } as any }, cfg, 0, lcCandles[0], 'empty window with partial swing b index/time');
        expectDTFXReject({ ...emptyDtfx, prevTPrice: 105 }, cfg, 0, lcCandles[0], 'empty window with non-null prevTPrice');
        expectDTFXReject({ ...emptyDtfx, prevBPrice: 95 }, cfg, 0, lcCandles[0], 'empty window with non-null prevBPrice');
        expectDTFXReject({ ...emptyDtfx, prevClose: 100 }, cfg, 0, lcCandles[0], 'empty window with non-null prevClose');
        expectDTFXReject({ ...emptyDtfx, dir: 1 }, cfg, 0, lcCandles[0], 'empty window with dir !== 0');
        expectDTFXReject({ ...emptyDtfx, tDir: -1 }, cfg, 0, lcCandles[0], 'empty window with tDir !== 0');
        expectDTFXReject({ ...emptyDtfx, bosUpCheck: true }, cfg, 0, lcCandles[0], 'empty window with bosUpCheck=true');
        expectDTFXReject({ ...emptyDtfx, bosDownCheck: true }, cfg, 0, lcCandles[0], 'empty window with bosDownCheck=true');

        // Explicit non-vacuous R1 (equal pair) vs R2 (strictly later pair) assertions before validateDTFXState
        const r1Zone = stateAt18.activeZones[0];
        assert(
            r1Zone.zoneId === 1 &&
            r1Zone.retestCount === 1 &&
            r1Zone.firstRetestBarIndex === 18 && r1Zone.lastRetestBarIndex === 18 &&
            r1Zone.firstRetestTimestamp === t0 + 18 * interval && r1Zone.lastRetestTimestamp === t0 + 18 * interval,
            'stateAt18 precondition: zone 1 R1 requires equal first/last retest bars and timestamps'
        );
        validateDTFXState(stateAt18, cfg.structureLen + 1, cfg.maxActiveZones, cfg.intervalMs);

        const r2Zone = stateAt21.activeZones[0];
        assert(
            r2Zone.zoneId === r1Zone.zoneId &&
            r2Zone.retestCount === 2 &&
            r2Zone.firstRetestBarIndex === 18 && r2Zone.lastRetestBarIndex === 21 &&
            r2Zone.lastRetestBarIndex > r2Zone.firstRetestBarIndex &&
            r2Zone.lastRetestTimestamp! > r2Zone.firstRetestTimestamp!,
            'stateAt21 precondition: same zoneId=1 R2 requires strictly later lastRetest bar and timestamp'
        );
        validateDTFXState(stateAt21, cfg.structureLen + 1, cfg.maxActiveZones, cfg.intervalMs);

        // Single-field checkpoint corruption anchored by retained window
        expectDTFXReject({
            ...stateAt18,
            clockCheckpoints: [{ barIndex: 0, time: t0 + 1 }]
        }, cfg, 19, lcCandles[19], 'single-field DTFX checkpoint corruption');

        // C2.3 Direct validateDTFXState argument checks
        let badDtfxArgs = false;
        try { validateDTFXState(createInitialDTFXState(), 1, 10, interval); } catch { badDtfxArgs = true; }
        assert(badDtfxArgs, 'validateDTFXState must reject maxWin < 2');
        badDtfxArgs = false;
        try { validateDTFXState(createInitialDTFXState(), 11, 0, interval); } catch { badDtfxArgs = true; }
        assert(badDtfxArgs, 'validateDTFXState must reject maxActiveZones < 1');
        badDtfxArgs = false;
        try { validateDTFXState(createInitialDTFXState(), 11, 10, 0); } catch { badDtfxArgs = true; }
        assert(badDtfxArgs, 'validateDTFXState must reject intervalMs <= 0');
    });

    // 4. VAM Adapter: Multi-bar engine progression (real BUY/SELL signals), no-signal & invalid signal rejection
    runTest('4. VAM Adapter: multi-bar real signals, no-signal & invalid signal rejection', () => {
        const baseOut = stepVolatilityAdjustedMean(102, 98, 100, createInitialVAMState(), false);
        assert(adaptVAMtoStrategyEvent({
            vamOutput: { ...baseOut, signal: 0 }, confirmationBarIndex: 10, confirmationTimestamp: t0 + 10 * interval,
            entryTimestamp: null, symbol: 'SOLUSDT', timeframe: '1m', intervalMs: interval
        }) === null, 'signal=0 must return null');

        // Multi-bar real progression: initial downtrend -> sustained uptrend (VAM_BUY) -> sustained downtrend (VAM_SELL)
        let vamSt = createInitialVAMState();
        const vamEvents: StrategyEvent[] = [];
        let px = 150;
        for (let i = 0; i < 120; i++) {
            const delta = i < 40 ? -0.8 : i < 80 ? 1.5 : -1.5;
            px = Math.max(20, px + delta);
            const h = px + 0.5;
            const l = px - 0.5;
            const out = stepVolatilityAdjustedMean(h, l, px, vamSt, false);
            vamSt = out.nextState;
            const ev = adaptVAMtoStrategyEvent({
                vamOutput: out,
                confirmationBarIndex: i,
                confirmationTimestamp: t0 + i * interval,
                entryTimestamp: null,
                symbol: 'SOLUSDT',
                timeframe: '1m',
                intervalMs: interval
            });
            if (ev) {
                assert(
                    ev.sourceBarIndex === i &&
                    ev.confirmationBarIndex === i &&
                    ev.confirmationLagBars === 0 &&
                    ev.sourceTimestamp === ev.confirmationTimestamp &&
                    Number.isFinite(ev.structuralContext['adx14'] as number),
                    'Real VAM event must satisfy lag=0 and finite structuralContext'
                );
                vamEvents.push(ev);
            }
        }
        assert(
            vamEvents.some(e => e.eventType === 'VAM_BUY' && e.eventDiscriminator === 'BUY') &&
            vamEvents.some(e => e.eventType === 'VAM_SELL' && e.eventDiscriminator === 'SELL'),
            `Multi-bar VAM progression must produce real VAM_BUY and VAM_SELL events (got ${vamEvents.map(e => e.eventType).join(',')})`
        );

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

        // Verify validateVAMCheckpoint passes at every key warmup boundary (bars 0, 3, 4, 7, 13, 14, 18, 27, 38)
        let vamWalk = createInitialVAMState();
        for (let i = 0; i <= 38; i++) {
            const h = i <= 27 ? 102 + i : 127 - (i - 27) * 2.5 + 2;
            const l = i <= 27 ? 98 + i : 127 - (i - 27) * 2.5 - 2;
            const c = i <= 27 ? 100 + i : 127 - (i - 27) * 2.5 - 1;
            vamWalk = stepVolatilityAdjustedMean(h, l, c, vamWalk, false).nextState;
            if ([0, 3, 4, 7, 13, 14, 18, 27, 38].includes(i)) {
                validateVAMCheckpoint(vamWalk);
            }
        }

        // Post-discontinuity checkpoint test where global barIndex (145) >> unbrokenRun (46)
        // Proves lastSignalAcceptedIndex is segment-relative (< unbrokenRun), survives JSON restore & produces identical signals
        let vamFull = createInitialVAMState();
        const postDiscFullEvents: Array<{ gBar: number; signal: number }> = [];
        const preCheckpointEvents: Array<{ gBar: number; signal: number }> = [];
        let postDiscCheckpointJson = '';
        for (let gBar = 0; gBar < 170; gBar++) {
            const isDisc = gBar === 100;
            const segIdx = gBar >= 100 ? gBar - 100 : gBar;
            let h: number, l: number, c: number;
            if (segIdx <= 27) { h = 102 + segIdx; l = 98 + segIdx; c = 100 + segIdx; }
            else if (segIdx <= 38) { const p = 127 - (segIdx - 27) * 2.5; h = p + 2; l = p - 2; c = p - 1; }
            else { const p = 99.5 + (segIdx - 38) * 4.0; h = p + 2; l = p - 2; c = p + 1; }

            const out = stepVolatilityAdjustedMean(h, l, c, vamFull, isDisc);
            vamFull = out.nextState;
            if (gBar >= 100 && gBar <= 145 && out.signal !== 0) {
                preCheckpointEvents.push({ gBar, signal: out.signal });
            }
            if (gBar === 145) {
                assert(JSON.stringify(preCheckpointEvents) === JSON.stringify([{ gBar: 138, signal: -1 }]),
                    `Expected single VAM_SELL at global bar 138, got ${JSON.stringify(preCheckpointEvents)}`);
                assert(vamFull.unbrokenRun === 46 && vamFull.lastSignalAcceptedIndex === 38,
                    `Expected post-discontinuity unbrokenRun=46 & lastSignalAcceptedIndex=38`);
                validateVAMCheckpoint(vamFull);
                postDiscCheckpointJson = JSON.stringify(vamFull);
            }
            if (gBar > 145 && out.signal !== 0) {
                postDiscFullEvents.push({ gBar, signal: out.signal });
            }
        }

        let vamRestored = JSON.parse(postDiscCheckpointJson) as ReturnType<typeof createInitialVAMState>;
        validateVAMCheckpoint(vamRestored);

        // Negative VAM checkpoint check: string atrState.isSeeded must throw VAM Checkpoint Error
        let badSeedTypeRejected = false;
        try {
            validateVAMCheckpoint({
                ...vamRestored,
                atrState: { ...vamRestored.atrState, isSeeded: 'yes' as any }
            });
        } catch (e: any) { badSeedTypeRejected = String(e.message).includes('VAM Checkpoint Error'); }
        assert(badSeedTypeRejected, 'validateVAMCheckpoint must reject non-boolean atrState.isSeeded');

        const postDiscRestoredEvents: Array<{ gBar: number; signal: number }> = [];
        for (let gBar = 146; gBar < 170; gBar++) {
            const segIdx = gBar - 100;
            const p = 99.5 + (segIdx - 38) * 4.0;
            const out = stepVolatilityAdjustedMean(p + 2, p - 2, p + 1, vamRestored, false);
            vamRestored = out.nextState;
            if (out.signal !== 0) postDiscRestoredEvents.push({ gBar, signal: out.signal });
        }
        assert(
            JSON.stringify(postDiscRestoredEvents) === JSON.stringify(postDiscFullEvents) &&
            JSON.stringify(postDiscRestoredEvents) === JSON.stringify([{ gBar: 149, signal: 1 }]),
            `Post-discontinuity VAM restoration must emit VAM_BUY strictly at global bar 149, got ${JSON.stringify(postDiscRestoredEvents)}`
        );
    });

    // 5. Combined 4-Teacher Stream: all 4 emit, REAL bar 109 event resolved across bar 110 gap, full reset checks & 2-run serialized determinism
    runTest('5. Combined 4-Teacher Stream: all 4 emit, real bar 109 gap entry, full resets & determinism', () => {
        const stream: ML1Candle[] = [];
        let ts = t0;
        let p = 100;
        for (let i = 0; i < 300; i++) {
            if (i === 110) ts += 600_000;

            // Engineer bars 105..109 so StrictCBC reaches a new cycle HH (>149.4) at 108 and confirms CBC_HIGH_HH at bar 109!
            if (i >= 105 && i <= 108) {
                const o = p;
                const c = p + 12.0;
                stream.push(makeCandle(ts, o, c + 0.5, o - 0.5, c, 150));
                p = c;
                ts += interval;
                continue;
            }
            if (i === 109) {
                const o = p - 0.5;
                const c = p - 16.0; // Breaks well below bar 108 anchorLow -> guaranteed CBC_HIGH_HH @109
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

        const phlCfg = createDefaultPHLConfig('SOLUSDT', '1m', interval);
        const dtfxCfg = createDefaultDTFXConfig('SOLUSDT', '1m', interval);

        const stepAll = (
            i: number,
            c: ML1Candle,
            isDisc: boolean,
            states: {
                cbcState: StrictCBCState | null;
                lastCbcPivot: StrictZigZagPivot | null;
                phlState: ReturnType<typeof createInitialPHLState>;
                dtfxState: DTFXState;
                vamState: ReturnType<typeof createInitialVAMState>;
            }
        ) => {
            const events: StrategyEvent[] = [];

            const vamOut = stepVolatilityAdjustedMean(c.high, c.low, c.close, states.vamState, isDisc);
            const nextVamState = vamOut.nextState;
            const atr = nextVamState.atrState.isSeeded ? nextVamState.atrState.atr : null;

            const vamEv = adaptVAMtoStrategyEvent({
                vamOutput: vamOut, confirmationBarIndex: i, confirmationTimestamp: c.time,
                entryTimestamp: null, symbol: 'SOLUSDT', timeframe: '1m', intervalMs: interval
            });
            if (vamEv) events.push(vamEv);

            const cbcStep = stepStrictCBCWithReset(c, i, states.cbcState, states.lastCbcPivot, isDisc);
            if (cbcStep.confirmedPivot) {
                events.push(adaptStrictCBCtoStrategyEvent({
                    pivot: cbcStep.confirmedPivot, prevPivot: cbcStep.prevPivotForEvent,
                    confirmationTimestamp: c.time, entryTimestamp: null, atr14AtConfirmation: atr,
                    symbol: 'SOLUSDT', timeframe: '1m', intervalMs: interval
                }));
            }

            const phlRes = stepPHL(c, i, states.phlState, phlCfg, isDisc, atr, null);
            events.push(...phlRes.events);

            const dtfxRes = stepDTFX(c, i, states.dtfxState, dtfxCfg, isDisc, atr, null);
            events.push(...dtfxRes.events);

            return {
                nextStates: {
                    cbcState: cbcStep.nextState,
                    lastCbcPivot: cbcStep.nextPrevPivot,
                    phlState: phlRes.nextState,
                    dtfxState: dtfxRes.nextState,
                    vamState: nextVamState
                },
                events
            };
        };

        const runFullStream = (captureCheckpointBar?: number) => {
            let states = {
                cbcState: null as StrictCBCState | null,
                lastCbcPivot: null as StrictZigZagPivot | null,
                phlState: createInitialPHLState(),
                dtfxState: createInitialDTFXState(),
                vamState: createInitialVAMState()
            };
            let checkpointJson = '';
            const rawEvents: StrategyEvent[] = [];
            const acceptedTs: number[] = [];

            for (let i = 0; i < stream.length; i++) {
                const c = stream[i];
                acceptedTs.push(c.time);
                const isDisc = i > 0 && c.time - stream[i - 1].time >= 300_000;
                const prevZoneIdBefore110 = i === 110 ? states.dtfxState.nextZoneId : 0;

                const res = stepAll(i, c, isDisc, states);
                states = res.nextStates;
                rawEvents.push(...res.events);

                if (i === 110) {
                    assert(states.lastCbcPivot === null && states.cbcState!.anchorHigh === c.high && states.cbcState!.anchorLow === c.low &&
                        states.cbcState!.phaseHighIdx === 110 && states.cbcState!.phaseLowIdx === 110 &&
                        states.cbcState!.lastHighPrice === null && states.cbcState!.lastLowPrice === null,
                        'StrictCBC global-index reset @110');
                    assert(states.phlState.window.length === 1 && states.phlState.bull === null && states.phlState.ph === null &&
                        states.phlState.pl === null && states.phlState.clockCheckpoints.length === 1 &&
                        states.phlState.pbFromHigh.price === null && states.phlState.pbFromLow.price === null &&
                        states.phlState.trackHigh === null && states.phlState.trackLow === null &&
                        states.phlState.lastHigh === null && states.phlState.lastLow === null &&
                        states.phlState.lastHighTime === null && states.phlState.lastLowTime === null,
                        'PHL reset @110');
                    assert(states.dtfxState.window.length === 1 && states.dtfxState.activeZones.length === 0 &&
                        states.dtfxState.clockCheckpoints.length === 1 && states.dtfxState.dir === 0 && states.dtfxState.tDir === 0 &&
                        states.dtfxState.t === null && states.dtfxState.b === null &&
                        states.dtfxState.prevTPrice === null && states.dtfxState.prevBPrice === null &&
                        !states.dtfxState.bosUpCheck && !states.dtfxState.bosDownCheck &&
                        states.dtfxState.nextZoneId === prevZoneIdBefore110,
                        'DTFX reset @110');
                    assert(states.vamState.unbrokenRun === 1 && states.vamState.trend === 0 &&
                        states.vamState.lastSignalAcceptedIndex === null && states.vamState.buyStreak === 0 &&
                        states.vamState.sellStreak === 0 && !states.vamState.atrState.isSeeded && states.vamState.adx === null,
                        'VAM reset @110');
                }
                if (captureCheckpointBar !== undefined && i === captureCheckpointBar) {
                    checkpointJson = JSON.stringify(states);
                }
            }
            const resolved = sortAndVerifyUniqueStrategyEvents(resolveStrategyEventsEntryTimestamps(rawEvents, acceptedTs, interval));
            return { rawEvents, resolved, acceptedTs, finalStates: states, checkpointJson };
        };

        // 1. Two independent full uninterrupted replays (bars 0..299) -> deterministic serialized equality
        const fullRun1 = runFullStream(120);
        const fullRun2 = runFullStream();
        assert(JSON.stringify(fullRun1.rawEvents) === JSON.stringify(fullRun2.rawEvents), '2-run deterministic serialized equality failed on raw events');
        assert(JSON.stringify(fullRun1.resolved) === JSON.stringify(fullRun2.resolved), '2-run deterministic serialized equality failed on resolved events');
        assert(JSON.stringify(fullRun1.finalStates) === JSON.stringify(fullRun2.finalStates), '2-run deterministic serialized equality failed on final states');

        // 2. Checkpoint serialization, explicit bar-120 + validator verification & restoration -> bars 121..299
        assert(fullRun1.checkpointJson.length > 0, 'Checkpoint @120 was not captured');
        let restoredStates = JSON.parse(fullRun1.checkpointJson) as typeof fullRun1.finalStates;
        assert(
            restoredStates.phlState.window[restoredStates.phlState.window.length - 1]?.barIndex === 120 &&
            restoredStates.dtfxState.window[restoredStates.dtfxState.window.length - 1]?.barIndex === 120,
            'Restored checkpoint must correspond to bar 120'
        );
        validateStrictCBCCheckpoint(
            restoredStates.cbcState,
            restoredStates.lastCbcPivot,
            120,
            stream[120].time,
            fullRun1.acceptedTs.slice(0, 121)
        );
        validatePHLState(restoredStates.phlState, 2 * phlCfg.pivotStrength + 4, phlCfg.intervalMs);
        validateDTFXState(restoredStates.dtfxState, dtfxCfg.structureLen + 1, dtfxCfg.maxActiveZones, dtfxCfg.intervalMs);
        validateVAMCheckpoint(restoredStates.vamState);
        const postCheckpointRestoredEvents: StrategyEvent[] = [];
        for (let i = 121; i < stream.length; i++) {
            const c = stream[i];
            const isDisc = c.time - stream[i - 1].time >= 300_000;
            const res = stepAll(i, c, isDisc, restoredStates);
            restoredStates = res.nextStates;
            postCheckpointRestoredEvents.push(...res.events);
        }

        const fullResolved = fullRun1.resolved;
        const acceptedTimestamps = fullRun1.acceptedTs;
        const fullPost120 = fullResolved.filter(e => e.confirmationBarIndex > 120);
        const restoredPost120 = sortAndVerifyUniqueStrategyEvents(
            resolveStrategyEventsEntryTimestamps(postCheckpointRestoredEvents, acceptedTimestamps, interval)
        );

        // Compare combined stream AND each of the 4 teachers independently (deterministic serialized equality)
        assert(JSON.stringify(restoredPost120) === JSON.stringify(fullPost120),
            'Deterministic serialized equality failed on combined post-120 events');
        for (const sid of ['STRICT_CBC', 'PHL_BOS_MSS', 'DTFX_ZONES', 'VAM_REVERSAL'] as const) {
            const expStrat = fullPost120.filter(e => e.strategyId === sid);
            const actStrat = restoredPost120.filter(e => e.strategyId === sid);
            assert(JSON.stringify(actStrat) === JSON.stringify(expStrat),
                `Deterministic serialized equality failed for teacher ${sid}`);
        }
        assert(JSON.stringify(restoredStates.cbcState) === JSON.stringify(fullRun1.finalStates.cbcState) &&
            JSON.stringify(restoredStates.lastCbcPivot) === JSON.stringify(fullRun1.finalStates.lastCbcPivot),
            'Deterministic serialized equality failed for StrictCBC final state');
        assert(JSON.stringify(restoredStates.phlState) === JSON.stringify(fullRun1.finalStates.phlState),
            'Deterministic serialized equality failed for PHL final state');
        assert(JSON.stringify(restoredStates.dtfxState) === JSON.stringify(fullRun1.finalStates.dtfxState),
            'Deterministic serialized equality failed for DTFX final state');
        assert(JSON.stringify(restoredStates.vamState) === JSON.stringify(fullRun1.finalStates.vamState),
            'Deterministic serialized equality failed for VAM final state');

        const byStrategy: Record<string, number> = { STRICT_CBC: 0, PHL_BOS_MSS: 0, DTFX_ZONES: 0, VAM_REVERSAL: 0 };
        const byType: Record<string, number> = {};
        let preGapCount = 0;
        let postGapCount = 0;
        let realBar109CbcHH = false;

        for (const ev of fullResolved) {
            byStrategy[ev.strategyId] = (byStrategy[ev.strategyId] || 0) + 1;
            byType[ev.eventType] = (byType[ev.eventType] || 0) + 1;
            if (ev.confirmationBarIndex < 110) preGapCount++;
            if (ev.confirmationBarIndex > 110) {
                postGapCount++;
                assert(ev.sourceBarIndex >= 110, `Post-gap event ${ev.eventId} referenced pre-gap sourceBarIndex ${ev.sourceBarIndex}`);
            }
            if (ev.confirmationBarIndex === 109) {
                assert(ev.entryTimestamp === acceptedTimestamps[110], 'Real bar 109 event must resolve actual post-gap bar 110 timestamp');
                if (ev.strategyId === 'STRICT_CBC' && ev.eventType === 'CBC_HIGH_HH') {
                    realBar109CbcHH = true;
                }
            }
            if (ev.confirmationBarIndex === stream.length - 1) {
                assert(ev.entryTimestamp === null, 'Final bar event must keep entryTimestamp === null');
            }
            if (ev.strategyId === 'DTFX_ZONES') assert(/^\d+(?:_R\d+)?$/.test(ev.eventDiscriminator), 'DTFX disc');
        }

        console.log('  📊 Combined 4-Teacher Counts:', JSON.stringify({ byStrategy, byType, preGapCount, postGapCount }));
        assert(realBar109CbcHH, 'Combined stream must emit real CBC_HIGH_HH at bar 109 to verify gap entry resolution');
        assert(byStrategy.STRICT_CBC > 0 && byStrategy.PHL_BOS_MSS > 0 && byStrategy.DTFX_ZONES > 0 && byStrategy.VAM_REVERSAL > 0,
            'All 4 strategies must emit events');
        assert(preGapCount > 0 && postGapCount > 0, 'Events must emit on both sides of bar 110 discontinuity');

        // 3. Independent Isolated Per-Teacher Checkpoint Restoration @120 (zero shared wrapper)
        // 3a. StrictCBC isolated
        let cbcFullS: StrictCBCState | null = null;
        let cbcFullP: StrictZigZagPivot | null = null;
        let cbcCpJson = '';
        const cbcFullPost120: StrategyEvent[] = [];
        for (let i = 0; i < stream.length; i++) {
            const c = stream[i];
            const isDisc = i > 0 && c.time - stream[i - 1].time >= 300_000;
            const r = stepStrictCBCWithReset(c, i, cbcFullS, cbcFullP, isDisc);
            cbcFullS = r.nextState;
            cbcFullP = r.nextPrevPivot;
            if (i === 120) cbcCpJson = JSON.stringify({ s: cbcFullS, p: cbcFullP });
            if (i > 120 && r.confirmedPivot) {
                cbcFullPost120.push(adaptStrictCBCtoStrategyEvent({
                    pivot: r.confirmedPivot, prevPivot: r.prevPivotForEvent, confirmationTimestamp: c.time,
                    entryTimestamp: null, atr14AtConfirmation: 2.0, symbol: 'SOLUSDT', timeframe: '1m', intervalMs: interval
                }));
            }
        }
        const cbcParsed = JSON.parse(cbcCpJson) as { s: StrictCBCState; p: StrictZigZagPivot | null };
        const isoClockPrefix = fullRun1.acceptedTs.slice(0, 121);
        assert(
            isoClockPrefix.length === 121 && isoClockPrefix[120] === stream[120].time,
            'isoClockPrefix must span bars 0..120 and end at stream[120].time'
        );
        validateStrictCBCCheckpoint(cbcParsed.s, cbcParsed.p, 120, stream[120].time, isoClockPrefix);
        let cbcRestS: StrictCBCState | null = cbcParsed.s;
        let cbcRestP: StrictZigZagPivot | null = cbcParsed.p;
        const cbcRestPost120: StrategyEvent[] = [];
        for (let i = 121; i < stream.length; i++) {
            const c = stream[i];
            const isDisc = c.time - stream[i - 1].time >= 300_000;
            const r = stepStrictCBCWithReset(c, i, cbcRestS, cbcRestP, isDisc);
            cbcRestS = r.nextState;
            cbcRestP = r.nextPrevPivot;
            if (r.confirmedPivot) {
                cbcRestPost120.push(adaptStrictCBCtoStrategyEvent({
                    pivot: r.confirmedPivot, prevPivot: r.prevPivotForEvent, confirmationTimestamp: c.time,
                    entryTimestamp: null, atr14AtConfirmation: 2.0, symbol: 'SOLUSDT', timeframe: '1m', intervalMs: interval
                }));
            }
        }
        const cbcFullResolved = resolveStrategyEventsEntryTimestamps(cbcFullPost120, fullRun1.acceptedTs, interval);
        const cbcRestResolved = resolveStrategyEventsEntryTimestamps(cbcRestPost120, fullRun1.acceptedTs, interval);
        assert(JSON.stringify(cbcRestResolved) === JSON.stringify(cbcFullResolved) &&
            JSON.stringify(cbcRestS) === JSON.stringify(cbcFullS) &&
            JSON.stringify(cbcRestP) === JSON.stringify(cbcFullP),
            'Isolated StrictCBC checkpoint restoration mismatch');
        // Bars 110..239 span bullish -> bearish -> bullish waves, driving transitions in both directions
        assert(
            cbcRestS !== null &&
            cbcFullS !== null &&
            cbcFullPost120.length > 0 &&
            cbcRestPost120.length > 0 &&
            cbcFullPost120.some(ev => ev.eventDirection === 'bear') &&
            cbcFullPost120.some(ev => ev.eventDirection === 'bull') &&
            cbcRestPost120.some(ev => ev.eventDirection === 'bear') &&
            cbcRestPost120.some(ev => ev.eventDirection === 'bull') &&
            cbcRestS.phaseHighIdx > 110 &&
            cbcRestS.phaseLowIdx > 110 &&
            cbcFullS.phaseHighIdx > 110 &&
            cbcFullS.phaseLowIdx > 110 &&
            cbcFullPost120.every(ev => ev.sourceBarIndex > 110 && ev.confirmationBarIndex > 120) &&
            cbcRestPost120.every(ev => ev.sourceBarIndex > 110 && ev.confirmationBarIndex > 120),
            'Full and restored StrictCBC must emit post-gap transitions in both directions and retain global phase indices (> 110)'
        );

        // 3b. PHL isolated
        let phlFullS = createInitialPHLState();
        let phlCpJson = '';
        const phlFullPost120: StrategyEvent[] = [];
        for (let i = 0; i < stream.length; i++) {
            const c = stream[i];
            const isDisc = i > 0 && c.time - stream[i - 1].time >= 300_000;
            const r = stepPHL(c, i, phlFullS, phlCfg, isDisc, 2.0, null);
            phlFullS = r.nextState;
            if (i === 120) phlCpJson = JSON.stringify(phlFullS);
            if (i > 120) phlFullPost120.push(...r.events);
        }
        let phlRestS = JSON.parse(phlCpJson) as ReturnType<typeof createInitialPHLState>;
        validatePHLState(phlRestS, 2 * phlCfg.pivotStrength + 4, phlCfg.intervalMs);
        const phlRestPost120: StrategyEvent[] = [];
        for (let i = 121; i < stream.length; i++) {
            const c = stream[i];
            const isDisc = c.time - stream[i - 1].time >= 300_000;
            const r = stepPHL(c, i, phlRestS, phlCfg, isDisc, 2.0, null);
            phlRestS = r.nextState;
            phlRestPost120.push(...r.events);
        }
        assert(JSON.stringify(phlRestPost120) === JSON.stringify(phlFullPost120) &&
            JSON.stringify(phlRestS) === JSON.stringify(phlFullS),
            'Isolated PHL checkpoint restoration mismatch');

        // 3c. DTFX isolated
        let dtfxFullS = createInitialDTFXState();
        let dtfxCpJson = '';
        const dtfxFullPost120: StrategyEvent[] = [];
        for (let i = 0; i < stream.length; i++) {
            const c = stream[i];
            const isDisc = i > 0 && c.time - stream[i - 1].time >= 300_000;
            const r = stepDTFX(c, i, dtfxFullS, dtfxCfg, isDisc, 2.0, null);
            dtfxFullS = r.nextState;
            if (i === 120) dtfxCpJson = JSON.stringify(dtfxFullS);
            if (i > 120) dtfxFullPost120.push(...r.events);
        }
        let dtfxRestS = JSON.parse(dtfxCpJson) as DTFXState;
        validateDTFXState(dtfxRestS, dtfxCfg.structureLen + 1, dtfxCfg.maxActiveZones, dtfxCfg.intervalMs);
        const dtfxRestPost120: StrategyEvent[] = [];
        for (let i = 121; i < stream.length; i++) {
            const c = stream[i];
            const isDisc = c.time - stream[i - 1].time >= 300_000;
            const r = stepDTFX(c, i, dtfxRestS, dtfxCfg, isDisc, 2.0, null);
            dtfxRestS = r.nextState;
            dtfxRestPost120.push(...r.events);
        }
        assert(JSON.stringify(dtfxRestPost120) === JSON.stringify(dtfxFullPost120) &&
            JSON.stringify(dtfxRestS) === JSON.stringify(dtfxFullS),
            'Isolated DTFX checkpoint restoration mismatch');

        // 3d. VAM isolated
        let vamFullS = createInitialVAMState();
        let vamCpJson = '';
        const vamFullPost120: StrategyEvent[] = [];
        for (let i = 0; i < stream.length; i++) {
            const c = stream[i];
            const isDisc = i > 0 && c.time - stream[i - 1].time >= 300_000;
            const out = stepVolatilityAdjustedMean(c.high, c.low, c.close, vamFullS, isDisc);
            vamFullS = out.nextState;
            if (i === 120) vamCpJson = JSON.stringify(vamFullS);
            if (i > 120) {
                const ev = adaptVAMtoStrategyEvent({
                    vamOutput: out, confirmationBarIndex: i, confirmationTimestamp: c.time,
                    entryTimestamp: null, symbol: 'SOLUSDT', timeframe: '1m', intervalMs: interval
                });
                if (ev) vamFullPost120.push(ev);
            }
        }
        let vamRestS = JSON.parse(vamCpJson) as ReturnType<typeof createInitialVAMState>;
        validateVAMCheckpoint(vamRestS);
        const vamRestPost120: StrategyEvent[] = [];
        for (let i = 121; i < stream.length; i++) {
            const c = stream[i];
            const isDisc = c.time - stream[i - 1].time >= 300_000;
            const out = stepVolatilityAdjustedMean(c.high, c.low, c.close, vamRestS, isDisc);
            vamRestS = out.nextState;
            const ev = adaptVAMtoStrategyEvent({
                vamOutput: out, confirmationBarIndex: i, confirmationTimestamp: c.time,
                entryTimestamp: null, symbol: 'SOLUSDT', timeframe: '1m', intervalMs: interval
            });
            if (ev) vamRestPost120.push(ev);
        }
        assert(JSON.stringify(vamRestPost120) === JSON.stringify(vamFullPost120) &&
            JSON.stringify(vamRestS) === JSON.stringify(vamFullS),
            'Isolated VAM checkpoint restoration mismatch');
    });

    console.log(`\nPhase 5D Phase 2 Full Acceptance: ${passed} passed, ${failed} failed.`);
    return failed === 0;
}
