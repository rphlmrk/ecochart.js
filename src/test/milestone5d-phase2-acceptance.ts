import {
    adaptStrictCBCtoStrategyEvent,
    adaptVAMtoStrategyEvent,
    buildStrategyEventId,
    compareStrategyEvents,
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
    type DTFXZoneRecord
} from '../indicators/mlr1/teachers/DTFXAlgoZonesTeacher';
import { STRICT_CBC_ZIGZAG_TEACHER_VERSION, type StrictCBCState, type StrictZigZagPivot } from '../indicators/plugins/StrictCBCZigZagIndicator';
import { createInitialVAMState, stepVolatilityAdjustedMean, type VAMStepOutput } from '../indicators/mlr1/trend/VolatilityAdjustedMean';
import type { ML1Candle } from '../indicators/mlr1/ML1FeatureTypes';

function assert(condition: boolean, msg: string): asserts condition {
    if (!condition) throw new Error(`[Phase5DPhase2Failed] ${msg}`);
}

function makeCandle(time: number, open: number, high: number, low: number, close: number, volume = 100): ML1Candle {
    return { time, open, high, low, close, volume, isSynthetic: false };
}

function expectErrorMatching(fn: () => void, substring: string, label: string): void {
    let threw = false;
    let message = '';
    try {
        fn();
    } catch (e: any) {
        threw = true;
        message = e?.message || String(e);
    }
    assert(threw, `${label}: expected error containing '${substring}', but none was thrown`);
    assert(message.includes(substring), `${label}: expected error containing '${substring}', got '${message}'`);
}

/**
 * PHASE 2 ENTRY GATE 1: StrategyEvent Runtime Contract, Unambiguous IDs, Chronology & Final-Bar Semantics
 */
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

    runTest('Gate1.1: Unambiguous eventId encoding, delimiter injection & collision rejection', () => {
        const id1 = buildStrategyEventId({
            strategyId: 'PHL_BOS_MSS',
            strategyVersion: 'v1',
            symbol: 'A_B',
            timeframe: 'C',
            eventType: 'PHL_MSS_BULL',
            sourceBarIndex: 5,
            confirmationBarIndex: 8,
            eventDiscriminator: 'PH'
        });
        const id2 = buildStrategyEventId({
            strategyId: 'PHL_BOS_MSS',
            strategyVersion: 'v1',
            symbol: 'A',
            timeframe: 'B_C',
            eventType: 'PHL_MSS_BULL',
            sourceBarIndex: 5,
            confirmationBarIndex: 8,
            eventDiscriminator: 'PH'
        });
        assert(id1 !== id2, 'Delimiter split A_B + C vs A + B_C must never collide');

        const idPipe1 = buildStrategyEventId({
            strategyId: 'DTFX_ZONES',
            strategyVersion: '1|2:X',
            symbol: 'SOL|USDT',
            timeframe: '1m',
            eventType: 'DTFX_DEMAND_RETEST',
            sourceBarIndex: 10,
            confirmationBarIndex: 10,
            eventDiscriminator: '1_R1'
        });
        const idPipe2 = buildStrategyEventId({
            strategyId: 'DTFX_ZONES',
            strategyVersion: '1',
            symbol: '2:X|8:SOL|USDT',
            timeframe: '1m',
            eventType: 'DTFX_DEMAND_RETEST',
            sourceBarIndex: 10,
            confirmationBarIndex: 10,
            eventDiscriminator: '1_R1'
        });
        assert(idPipe1 !== idPipe2, 'Pipe/length delimiter injection must never collide');

        const evA = createStrategyEvent({
            strategyId: 'PHL_BOS_MSS', strategyVersion: 'PHL_BOS_MSS_v1', symbol: 'SOLUSDT', timeframe: '1m',
            intervalMs: interval, eventType: 'PHL_MSS_BULL', eventDirection: 'bull', eventDiscriminator: 'PH',
            sourceBarIndex: 1, sourceTimestamp: t0 + interval, confirmationBarIndex: 5, confirmationTimestamp: t0 + 5 * interval,
            entryTimestamp: null, structuralContext: {}
        });
        const evDup = createStrategyEvent({
            strategyId: 'PHL_BOS_MSS', strategyVersion: 'PHL_BOS_MSS_v1', symbol: 'SOLUSDT', timeframe: '1m',
            intervalMs: interval, eventType: 'PHL_MSS_BULL', eventDirection: 'bull', eventDiscriminator: 'PH',
            sourceBarIndex: 1, sourceTimestamp: t0 + interval, confirmationBarIndex: 5, confirmationTimestamp: t0 + 5 * interval,
            entryTimestamp: null, structuralContext: {}
        });
        expectErrorMatching(() => sortAndVerifyUniqueStrategyEvents([evA, evDup]), 'Collision Error', 'duplicate eventId');
    });

    runTest('Gate1.2: Factory validation (VAM chronology, entryBarIndex guard, accepted entry clock)', () => {
        const acceptedTs = [t0, t0 + interval, t0 + 11 * interval];
        const valid = createStrategyEvent({
            strategyId: 'DTFX_ZONES',
            strategyVersion: 'DTFX_ZONES_v1',
            symbol: 'SOLUSDT',
            timeframe: '1m',
            intervalMs: interval,
            eventType: 'DTFX_DEMAND_RETEST',
            eventDirection: 'bull',
            eventDiscriminator: '7_R1',
            sourceBarIndex: 1,
            sourceTimestamp: acceptedTs[1],
            confirmationBarIndex: 1,
            confirmationTimestamp: acceptedTs[1],
            entryTimestamp: acceptedTs[2],
            acceptedTimestampsByBarIndex: acceptedTs,
            structuralContext: { zoneId: 7, retestCount: 1 }
        });
        assert(Object.isFrozen(valid) && Object.isFrozen(valid.structuralContext), 'Must freeze event & context');
        assert(valid.entryTimestamp === acceptedTs[2], 'Must accept matching accepted entry timestamp');

        expectErrorMatching(() => createStrategyEvent({
            strategyId: 'PHL_BOS_MSS', strategyVersion: 'v1', symbol: 'SOLUSDT', timeframe: '1m',
            intervalMs: interval, eventType: 'PHL_MSS_BULL', eventDirection: 'sideways' as any,
            eventDiscriminator: 'PH', sourceBarIndex: 1, sourceTimestamp: t0,
            confirmationBarIndex: 2, confirmationTimestamp: t0 + interval,
            entryTimestamp: null, structuralContext: {}
        }), 'Contract Error', 'invalid eventDirection');

        expectErrorMatching(() => createStrategyEvent({
            strategyId: 'PHL_BOS_MSS', strategyVersion: 'v1', symbol: 'SOLUSDT', timeframe: '1m',
            intervalMs: interval, eventType: 'PHL_MSS_BULL', eventDirection: 'bull',
            eventDiscriminator: 'PH', sourceBarIndex: 1, sourceTimestamp: t0,
            confirmationBarIndex: 2, confirmationTimestamp: t0 + interval,
            entryTimestamp: null, structuralContext: ['not-a-record'] as any
        }), 'Contract Error', 'array structuralContext');

        expectErrorMatching(() => createStrategyEvent({
            strategyId: 'PHL_BOS_MSS', strategyVersion: 'v1', symbol: 'SOLUSDT', timeframe: '1m',
            intervalMs: interval, eventType: 'PHL_MSS_BULL', eventDirection: 'bull',
            eventDiscriminator: '  ', sourceBarIndex: 1, sourceTimestamp: t0,
            confirmationBarIndex: 2, confirmationTimestamp: t0 + interval,
            entryTimestamp: null, structuralContext: {}
        }), 'Contract Error', 'blank discriminator');

        expectErrorMatching(() => createStrategyEvent({
            strategyId: 'VAM_REVERSAL', strategyVersion: 'VAM_v1', symbol: 'SOLUSDT', timeframe: '1m',
            intervalMs: interval, eventType: 'VAM_BUY', eventDirection: 'bull',
            eventDiscriminator: 'BUY', sourceBarIndex: 1, sourceTimestamp: t0 + interval,
            confirmationBarIndex: 2, confirmationTimestamp: t0 + 2 * interval,
            entryTimestamp: null, structuralContext: {}
        }), 'Chronology Error', 'VAM lag > 0');

        expectErrorMatching(() => createStrategyEvent({
            strategyId: 'PHL_BOS_MSS', strategyVersion: 'v1', symbol: 'SOLUSDT', timeframe: '1m',
            intervalMs: interval, eventType: 'PHL_MSS_BULL', eventDirection: 'bull',
            eventDiscriminator: 'PH', sourceBarIndex: 0, sourceTimestamp: acceptedTs[0],
            confirmationBarIndex: 1, confirmationTimestamp: acceptedTs[1],
            entryTimestamp: acceptedTs[1] + interval, acceptedTimestampsByBarIndex: acceptedTs,
            structuralContext: {}
        }), 'Chronology Error', 'naive entryTimestamp across gap');

        expectErrorMatching(() => createStrategyEvent({
            strategyId: 'VAM_REVERSAL', strategyVersion: 'VAM_v1', symbol: 'SOLUSDT', timeframe: '1m',
            intervalMs: interval, eventType: 'VAM_BUY', eventDirection: 'bull',
            eventDiscriminator: 'BUY', sourceBarIndex: 2, sourceTimestamp: acceptedTs[2],
            confirmationBarIndex: 2, confirmationTimestamp: acceptedTs[2],
            entryTimestamp: acceptedTs[2] + interval, acceptedTimestampsByBarIndex: acceptedTs,
            structuralContext: {}
        }), 'Chronology Error', 'non-null entryTimestamp on final bar');

        expectErrorMatching(() => createStrategyEvent({
            strategyId: 'PHL_BOS_MSS', strategyVersion: 'v1', symbol: 'SOLUSDT', timeframe: '1m',
            intervalMs: interval, eventType: 'PHL_MSS_BULL', eventDirection: 'bull',
            eventDiscriminator: 'PH', sourceBarIndex: 0, sourceTimestamp: t0,
            confirmationBarIndex: Number.MAX_SAFE_INTEGER, confirmationTimestamp: t0 + interval,
            entryTimestamp: null, structuralContext: {}
        }), 'entryBarIndex', 'entryBarIndex safe-integer overflow');
    });

    runTest('Gate1.3: Accepted clock, expectedIntervalMs, derived fields, gap & final-bar semantics', () => {
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
        assert(resolved[0].entryTimestamp === acceptedTs[2], 'Must resolve actual next candle across gap');
        assert(resolved[1].entryTimestamp === null, 'Final bar must preserve entryTimestamp=null');

        expectErrorMatching(() => resolveStrategyEventsEntryTimestamps([evGap], [t0, t0, t0 + 2 * interval]), 'Chronology Error', 'duplicate accepted timestamp');
        expectErrorMatching(() => resolveStrategyEventsEntryTimestamps([evGap], [t0, t0 + 2 * interval, t0 + interval]), 'Chronology Error', 'out-of-order accepted timestamp');
        expectErrorMatching(() => resolveStrategyEventsEntryTimestamps([evGap], [t0, Number.NaN, t0 + 2 * interval]), 'Chronology Error', 'NaN accepted timestamp');
        expectErrorMatching(() => resolveStrategyEventsEntryTimestamps([evGap], [t0, t0 + 99 * interval, t0 + 100 * interval]), 'Chronology Error', 'mismatched confirmationTimestamp');
        expectErrorMatching(() => resolveStrategyEventsEntryTimestamps([evGap], [t0, t0 + interval, t0 + 11 * interval + 500], interval), 'Chronology Error', 'unaligned clock delta');
        expectErrorMatching(() => resolveStrategyEventsEntryTimestamps([{ ...evGap, observationBarIndex: 99 }], acceptedTs, interval), 'observationBarIndex', 'tampered observationBarIndex');
        expectErrorMatching(() => resolveStrategyEventsEntryTimestamps([{ ...evGap, confirmationLagBars: 99 }], acceptedTs, interval), 'confirmationLagBars', 'tampered confirmationLagBars');
        expectErrorMatching(() => resolveStrategyEventsEntryTimestamps([{ ...evGap, observationTimestamp: evGap.confirmationTimestamp + 1234 }], acceptedTs, interval), 'observationTimestamp', 'tampered observationTimestamp');
    });

    runTest('Gate1.4: Canonical sort comparator (confirmationBarIndex, strategyId, eventType, eventId)', () => {
        const make = (strategyId: any, eventType: any, disc: string, confBar: number) =>
            createStrategyEvent({
                strategyId,
                strategyVersion: 'v1',
                symbol: 'SOLUSDT',
                timeframe: '1m',
                intervalMs: interval,
                eventType,
                eventDirection: 'bull',
                eventDiscriminator: disc,
                sourceBarIndex: confBar,
                sourceTimestamp: t0 + confBar * interval,
                confirmationBarIndex: confBar,
                confirmationTimestamp: t0 + confBar * interval,
                entryTimestamp: null,
                structuralContext: {}
            });

        const e1 = make('VAM_REVERSAL', 'VAM_BUY', 'BUY', 5);
        const e2 = make('DTFX_ZONES', 'DTFX_DEMAND_RETEST', '2_R1', 5);
        const e3 = make('DTFX_ZONES', 'DTFX_DEMAND_RETEST', '1_R1', 5);
        const e4 = make('DTFX_ZONES', 'DTFX_DEMAND_CREATED', '1', 5);
        const e5 = make('STRICT_CBC', 'CBC_LOW_HL', '1', 4);

        const sorted = sortAndVerifyUniqueStrategyEvents([e1, e2, e3, e4, e5]);
        assert(sorted[0] === e5, 'Earliest confirmationBarIndex (4) must sort first');
        assert(sorted[1] === e4, 'DTFX_ZONES + DTFX_DEMAND_CREATED before DTFX_DEMAND_RETEST');
        assert(sorted[2] === e3 && sorted[3] === e2, 'Same bar/strategy/type must tie-break deterministically by eventId');
        assert(sorted[4] === e1, 'VAM_REVERSAL sorts after STRICT_CBC/DTFX_ZONES alphabetically');
        assert(compareStrategyEvents(sorted[2], sorted[3]) < 0, 'Comparator sign check');
    });

    console.log(`\nPhase 5D Phase 2 Gate 1: ${passed} passed, ${failed} failed.`);
    return failed === 0;
}

/**
 * PHASE 2 FULL TEACHER ACCEPTANCE SUITE
 */
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

    // 1. StrictCBC Exhaustive Label Mapping, Input Validation & Gap Reset Proof
    runTest('1. StrictCBC Adapter: exhaustive labels, guards & discontinuity reset', () => {
        assert(STRICT_CBC_ZIGZAG_TEACHER_VERSION === 'StrictCBCZigZag_v1', 'Unexpected StrictCBC version constant');

        const cases: Array<[StrictZigZagPivot['type'], StrictZigZagPivot['label'], StrategyEvent['eventType'], 'bull' | 'bear']> = [
            ['high', 'HH', 'CBC_HIGH_HH', 'bear'],
            ['high', 'LH', 'CBC_HIGH_LH', 'bear'],
            ['low', 'HL', 'CBC_LOW_HL', 'bull'],
            ['low', 'LL', 'CBC_LOW_LL', 'bull']
        ];
        for (let idx = 0; idx < cases.length; idx++) {
            const [pType, pLabel, expectedEvType, expectedDir] = cases[idx];
            const ev = adaptStrictCBCtoStrategyEvent({
                pivot: {
                    id: idx + 1, barIndex: 2, time: t0 + 2 * interval, price: 105,
                    type: pType, label: pLabel, confirmedBarIndex: 3
                },
                prevPivot: null,
                confirmationTimestamp: t0 + 3 * interval,
                entryTimestamp: null,
                atr14AtConfirmation: 2,
                symbol: 'SOLUSDT',
                timeframe: '1m',
                intervalMs: interval
            });
            assert(ev.eventType === expectedEvType && ev.eventDirection === expectedDir, `Label mapping ${pType}/${pLabel}`);
        }

        expectErrorMatching(() => adaptStrictCBCtoStrategyEvent({
            pivot: { id: 1, barIndex: 2, time: t0 + 2 * interval, price: 105, type: 'high', label: 'HL' as any, confirmedBarIndex: 3 },
            prevPivot: null, confirmationTimestamp: t0 + 3 * interval, entryTimestamp: null, atr14AtConfirmation: 2,
            symbol: 'SOLUSDT', timeframe: '1m', intervalMs: interval
        }), 'invalid label', 'mismatched high/HL label');

        expectErrorMatching(() => adaptStrictCBCtoStrategyEvent({
            pivot: { id: 0, barIndex: 2, time: t0 + 2 * interval, price: 105, type: 'high', label: 'HH', confirmedBarIndex: 3 },
            prevPivot: null, confirmationTimestamp: t0 + 3 * interval, entryTimestamp: null, atr14AtConfirmation: 2,
            symbol: 'SOLUSDT', timeframe: '1m', intervalMs: interval
        }), 'invalid pivot', 'pivot.id < 1');

        expectErrorMatching(() => adaptStrictCBCtoStrategyEvent({
            pivot: { id: 1, barIndex: 2, time: t0 + 2 * interval, price: 105, type: 'high', label: 'HH', confirmedBarIndex: 3 },
            prevPivot: null, confirmationTimestamp: t0 + 3 * interval, entryTimestamp: null, atr14AtConfirmation: -1,
            symbol: 'SOLUSDT', timeframe: '1m', intervalMs: interval
        }), 'atr14AtConfirmation', 'negative ATR');

        // Discontinuity prevents cross-gap pivot & clears prevPivot
        const c0 = makeCandle(t0, 100, 105, 95, 103, 100);
        const c1 = makeCandle(t0 + interval, 103, 112, 100, 110, 100);
        const c2Break = makeCandle(t0 + 12 * interval, 104, 105, 89, 90, 100);

        let sNoGap: StrictCBCState | null = null;
        sNoGap = stepStrictCBCWithReset(c0, 0, sNoGap, null, false).nextState;
        sNoGap = stepStrictCBCWithReset(c1, 1, sNoGap, null, false).nextState;
        const flipWithoutReset = stepStrictCBCWithReset(c2Break, 2, sNoGap, null, false);
        assert(flipWithoutReset.confirmedPivot !== null, 'Control without reset confirms flip');

        let sGap: StrictCBCState | null = null;
        const prevGap: StrictZigZagPivot = { id: 99, barIndex: 0, time: t0, price: 95, type: 'low', label: 'LL', confirmedBarIndex: 0 };
        sGap = stepStrictCBCWithReset(c0, 0, sGap, null, false).nextState;
        sGap = stepStrictCBCWithReset(c1, 1, sGap, prevGap, false).nextState;
        const r2 = stepStrictCBCWithReset(c2Break, 2, sGap, prevGap, true);
        assert(r2.confirmedPivot === null && r2.nextPrevPivot === null, 'Discontinuity must block cross-gap pivot and clear prevPivot');
        assert(r2.nextState.anchorHigh === c2Break.high && r2.nextState.anchorLow === c2Break.low, 'Anchor must re-seed from post-gap candle');
    });

    // 2. PHL Teacher: pinned bars, pullback modes, input guards & deep state integrity
    runTest('2. PHL Teacher: pinned transitions, pullback modes, input guards & state integrity', () => {
        const cfgValid = createDefaultPHLConfig('SOLUSDT', '1m', interval);
        const cfgNoPb = { ...cfgValid, useValidPullbacks: false };
        const cfgExtra = { ...cfgValid, extraValidPullbacks: true };

        const bars: Array<[number, number, number, number]> = [
            [100, 102, 99, 101], [101, 105, 100, 104], [104, 107, 103, 106], [106, 110, 105, 107],
            [107, 108, 103, 104], [104, 106, 100, 101], [101, 103, 98, 99],
            [99, 100, 96, 97],   [97, 98, 95, 96],    [96, 97, 94, 95],
            [95, 99, 95, 98],    [98, 102, 97, 101],  [101, 105, 100, 104],
            [104, 108, 103, 107],[107, 109, 106, 108],[108, 113, 107, 112],
            [112, 115, 111, 114],[114, 118, 113, 115],[115, 116, 110, 111],
            [111, 113, 109, 110],[110, 112, 108, 109],[109, 116, 109, 115],
            [115, 121, 114, 120],[120, 120, 100, 101],[101, 102, 95, 96],
            [96, 96, 89, 90]
        ];
        const stream = bars.map(([o, h, l, c], i) => makeCandle(t0 + i * interval, o, h, l, c, 100));

        let st = createInitialPHLState();
        const evs: StrategyEvent[] = [];
        for (let i = 0; i < stream.length; i++) {
            const res = stepPHL(stream[i], i, st, cfgValid, false, 2.0, null);
            st = res.nextState;
            evs.push(...res.events);
            if (i === 6) assert(res.confirmedPivotHigh?.barIndex === 3 && res.confirmedPivotHigh.price === 110, 'Bar 6 confirms PH @3');
            if (i === 12) assert(res.confirmedPivotLow?.barIndex === 9 && res.confirmedPivotLow.price === 94, 'Bar 12 confirms PL @9');
        }

        assert(evs.length === 3, `Expected 3 PHL breaks, got ${evs.length}`);
        assert(evs[0].eventType === 'PHL_MSS_BULL' && evs[0].sourceBarIndex === 3 && evs[0].confirmationBarIndex === 15, 'Pinned PHL_MSS_BULL @15');
        assert(evs[1].eventType === 'PHL_BOS_BULL' && evs[1].sourceBarIndex === 17 && evs[1].confirmationBarIndex === 22, 'Pinned PHL_BOS_BULL @22');
        assert(evs[2].eventType === 'PHL_MSS_BEAR' && evs[2].sourceBarIndex === 9 && evs[2].confirmationBarIndex === 25, 'Pinned PHL_MSS_BEAR @25');

        let stNoPb = createInitialPHLState();
        let stExtra = createInitialPHLState();
        for (let i = 0; i < stream.length; i++) {
            stNoPb = stepPHL(stream[i], i, stNoPb, cfgNoPb, false, 2.0, null).nextState;
            stExtra = stepPHL(stream[i], i, stExtra, cfgExtra, false, 2.0, null).nextState;
        }
        assert(stNoPb.bull === false && stExtra.bull === false, 'Alternate pullback modes must execute cleanly');

        // Negative input & state integrity checks
        expectErrorMatching(
            () => stepPHL(makeCandle(t0 + 26 * interval, 90, 92, 88, 91, -5), 26, st, cfgValid),
            'PHL Input Error', 'negative volume'
        );
        expectErrorMatching(
            () => stepPHL(makeCandle(t0 + 26 * interval + 500, 90, 92, 88, 91, 100), 26, st, cfgValid),
            'PHL Chronology Error', 'unaligned timestamp delta'
        );
        expectErrorMatching(
            () => stepPHL(makeCandle(t0 + 26 * interval, 90, 92, 88, 91, 100), 26, { ...st, bull: 'YES' as any }, cfgValid),
            'PHL State Integrity Error', 'invalid bull'
        );
        expectErrorMatching(
            () => stepPHL(makeCandle(t0 + 26 * interval, 90, 92, 88, 91, 100), 26, { ...st, trackHigh: 120, trackHighIdx: null, trackHighTime: null }, cfgValid),
            'PHL State Integrity Error', 'partial trackHigh triple'
        );
        // Window cross-validation mismatch on ph
        const latestWinBar = st.window[st.window.length - 1];
        expectErrorMatching(
            () => stepPHL(
                makeCandle(t0 + 26 * interval, 90, 92, 88, 91, 100),
                26,
                { ...st, ph: { price: latestWinBar.high + 5, barIndex: latestWinBar.barIndex, time: latestWinBar.time } },
                cfgValid
            ),
            'PHL State Integrity Error', 'ph disagrees with window bar'
        );
    });

    // 3. DTFX Teacher: multi-retest (_R1/_R2), lingering bar suppression, invalidation precedence, maxActiveZones & deep integrity
    runTest('3. DTFX Teacher: overlapping zones, _R1/_R2 distinct retests, invalidation precedence, bounds & integrity', () => {
        const cfg = createDefaultDTFXConfig('SOLUSDT', '1m', interval);

        expectErrorMatching(
            () => stepDTFX(makeCandle(t0, 100, 101, 99, 100), 0, createInitialDTFXState(), { ...cfg, fibLevels: [0.5, 0.3, 0.7] }),
            'strictly ascending', 'unordered fibLevels'
        );
        expectErrorMatching(
            () => stepDTFX(makeCandle(t0, 100, 101, 99, 100), 0, createInitialDTFXState(), { ...cfg, maxActiveZones: 0 }),
            'maxActiveZones', 'maxActiveZones < 1'
        );

        const z1: DTFXZoneRecord = {
            zoneId: 1, direction: 'bull', top: 110, bot: 100, fib03: 103, fib05: 105, fib07: 107,
            createdSourceBarIndex: 2, createdSourceTimestamp: t0 + 2 * interval,
            createdConfirmationBarIndex: 12, createdConfirmationTimestamp: t0 + 12 * interval,
            status: 'ACTIVE', retestCount: 0, firstRetestBarIndex: null, lastRetestBarIndex: null,
            isCurrentlyInZone: false, invalidationBarIndex: null
        };
        const z2: DTFXZoneRecord = {
            zoneId: 2, direction: 'bull', top: 108, bot: 104, fib03: 105.2, fib05: 106, fib07: 106.8,
            createdSourceBarIndex: 5, createdSourceTimestamp: t0 + 5 * interval,
            createdConfirmationBarIndex: 15, createdConfirmationTimestamp: t0 + 15 * interval,
            status: 'ACTIVE', retestCount: 0, firstRetestBarIndex: null, lastRetestBarIndex: null,
            isCurrentlyInZone: false, invalidationBarIndex: null
        };
        const overlapState = { ...createInitialDTFXState(3), activeZones: Object.freeze([z1, z2]) };

        // Bar 20: dips to low=109, close=111 -> Zone 1 emits _R1 (isCurrentlyInZone=true); Zone 2 stays ACTIVE
        const step20 = stepDTFX(makeCandle(t0 + 20 * interval, 111, 112, 109, 111, 100), 20, overlapState, cfg, false, 2.0, null);
        assert(step20.retestedZones.length === 1 && step20.retestedZones[0].zoneId === 1, 'Only Zone 1 retests at low=109');
        assert(step20.events[0].eventDiscriminator === '1_R1', 'First retest discriminator must be 1_R1');
        assert(step20.nextState.activeZones[0].isCurrentlyInZone === true && step20.nextState.activeZones[1].status === 'ACTIVE', 'Zone 1 marked inside, Zone 2 unaffected');

        // Bar 21: still inside Zone 1 [100..110] without leaving -> ZERO duplicate retest events!
        const step21 = stepDTFX(makeCandle(t0 + 21 * interval, 111, 112, 109.2, 111, 100), 21, step20.nextState, cfg, false, 2.0, null);
        assert(step21.retestedZones.length === 0 && step21.events.length === 0, 'Consecutive lingering bar must NOT emit duplicate retest');

        // Bar 22: strictly above Zone 1 [112..114] -> exits zone (isCurrentlyInZone=false)
        const step22 = stepDTFX(makeCandle(t0 + 22 * interval, 112, 114, 112, 113, 100), 22, step21.nextState, cfg, false, 2.0, null);
        assert(step22.retestedZones.length === 0 && step22.nextState.activeZones[0].isCurrentlyInZone === false, 'Exiting zone clears isCurrentlyInZone');

        // Bar 23: revisits Zone 1 [109..112] -> emits distinct _R2 event!
        const step23 = stepDTFX(makeCandle(t0 + 23 * interval, 112, 112, 109, 111, 100), 23, step22.nextState, cfg, false, 2.0, null);
        assert(step23.retestedZones.length === 1 && step23.retestedZones[0].retestCount === 2, 'Revisit after exit increments retestCount to 2');
        assert(step23.events[0].eventDiscriminator === '1_R2', 'Second distinct visit discriminator must be 1_R2');
        assert(step23.nextState.activeZones[0].firstRetestBarIndex === 20 && step23.nextState.activeZones[0].lastRetestBarIndex === 23, 'Track first and last retest bars');

        // Bar 24: invalidates Zone 2 (low=102, close=102 < bot=104) while touching Zone 2 -> Invalidation beats Retest (0 retests for Zone 2!), and Zone 1 ALSO touches & stays inside without re-emitting because already inside? Wait: Zone 1 was already inside at bar 23!
        const step24 = stepDTFX(makeCandle(t0 + 24 * interval, 109, 109, 102, 102, 100), 24, step23.nextState, cfg, false, 2.0, null);
        assert(step24.invalidatedZones.length === 1 && step24.invalidatedZones[0].zoneId === 2, 'Only Zone 2 invalidates at close=102');
        assert(step24.retestedZones.every(z => z.zoneId !== 2), 'Same-bar invalidation strictly suppresses Zone 2 retest');

        // Dedicated fresh same-bar invalidation > retest precedence check (never-retested zone)
        const freshZ: DTFXZoneRecord = { ...z2, zoneId: 10, top: 108, bot: 104 };
        const freshState = { ...createInitialDTFXState(11), activeZones: Object.freeze([freshZ]) };
        const sameBarInv = stepDTFX(makeCandle(t0 + 20 * interval, 107, 107, 102, 102), 20, freshState, cfg);
        assert(sameBarInv.invalidatedZones.length === 1 && sameBarInv.retestedZones.length === 0 && sameBarInv.events.length === 0,
            'Same-bar close below bot must emit invalidation only, never retest');

        // maxActiveZones overflow pruning check (starts with 1 zone under maxActiveZones=1, mssUp creates zone 2 -> prunes zone 1)
        const cfgSmallBound = { ...cfg, maxActiveZones: 1 };
        const preWindow = Array.from({ length: cfg.structureLen }, (_, k) => ({
            barIndex: 10 + k,
            time: t0 + (10 + k) * interval,
            open: 110,
            high: k === 8 ? 112 : 111,
            low: 109,
            close: 111,
            volume: 100
        }));
        const overflowStartState = {
            ...createInitialDTFXState(2),
            window: Object.freeze(preWindow),
            dir: -1 as const,
            tDir: 1 as const,
            t: { price: 112, barIndex: 18, time: t0 + 18 * interval },
            prevTPrice: 112,
            prevClose: 111,
            bosUpCheck: true,
            activeZones: Object.freeze([z1])
        };
        const boundedRes = stepDTFX(makeCandle(t0 + 20 * interval, 111, 116, 111, 115), 20, overflowStartState, cfgSmallBound);
        assert(boundedRes.createdZones.length === 1 && boundedRes.createdZones[0].zoneId === 2, 'mssUp must create zone 2');
        assert(boundedRes.nextState.activeZones.length === 1 && boundedRes.nextState.activeZones[0].zoneId === 2,
            'maxActiveZones overflow must prune oldest zone and keep zone 2');
        assert(boundedRes.nextState.bosUpCheck === false, 'mssUp must consume bosUpCheck');

        // Degenerate geometry guard (zTop === zBot): skips zone creation AND still consumes bosUpCheck
        const degenWindow = Array.from({ length: cfg.structureLen }, (_, k) => ({
            barIndex: 10 + k,
            time: t0 + (10 + k) * interval,
            open: 112,
            high: 112,
            low: 112,
            close: 112,
            volume: 100
        }));
        const degenState = {
            ...createInitialDTFXState(2),
            window: Object.freeze(degenWindow),
            dir: -1 as const,
            tDir: 1 as const,
            t: { price: 112, barIndex: 18, time: t0 + 18 * interval },
            prevTPrice: 112,
            prevClose: 112,
            bosUpCheck: true
        };
        const degenRes = stepDTFX(makeCandle(t0 + 20 * interval, 112, 115, 112, 115), 20, degenState, cfg);
        assert(degenRes.createdZones.length === 0 && degenRes.events.length === 0, 'Degenerate zTop <= zBot candidate must not create zone');
        assert(degenRes.nextState.bosUpCheck === false, 'bosUpCheck must still clear on mssUp even when degenerate candidate is skipped');

        // Corrupt DTFX state & provenance rejection
        expectErrorMatching(
            () => stepDTFX(makeCandle(t0 + 25 * interval, 103, 104, 102, 103), 25, { ...step24.nextState, dir: 2 as any }, cfg),
            'DTFX State Integrity Error', 'invalid dir=2'
        );
        expectErrorMatching(
            () => stepDTFX(makeCandle(t0 + 25 * interval, 103, 104, 102, 103), 25, { ...step24.nextState, activeZones: [{ ...z1, top: 99, bot: 100 }] }, cfg),
            'DTFX State Integrity Error', 'inverted zone geometry'
        );
        expectErrorMatching(
            () => stepDTFX(makeCandle(t0 + 25 * interval, 103, 104, 102, 103), 25, { ...step24.nextState, activeZones: [{ ...z1, zoneId: 99 }] }, cfg),
            'DTFX State Integrity Error', 'zoneId >= nextZoneId'
        );
        expectErrorMatching(
            () => stepDTFX(makeCandle(t0 + 25 * interval, 103, 104, 102, 103), 25, { ...step24.nextState, activeZones: [{ ...z1, status: 'RETESTED', retestCount: 1, firstRetestBarIndex: 20, lastRetestBarIndex: 21 }] }, cfg),
            'DTFX State Integrity Error', 'retestCount=1 with mismatched lastRetestBarIndex'
        );
        const latestDtfxWin = step24.nextState.window[step24.nextState.window.length - 1];
        expectErrorMatching(
            () => stepDTFX(
                makeCandle(t0 + 25 * interval, 103, 104, 102, 103),
                25,
                { ...step24.nextState, t: { price: latestDtfxWin.high + 10, barIndex: latestDtfxWin.barIndex, time: latestDtfxWin.time } },
                cfg
            ),
            'DTFX State Integrity Error', 'swing t disagrees with window bar'
        );
    });

    // 4. VAM Adapter: signal=0 returns null, BUY/SELL mapping, unexpected signal throws
    runTest('4. VAM Adapter: signal mapping, lag-0 parity & invalid signal guard', () => {
        const baseOut: VAMStepOutput = {
            nextState: createInitialVAMState(),
            centerDistAtr: 0.6,
            isCenterDistValid: true,
            slope3Atr: 0.2,
            isSlopeValid: true,
            efficiency: 0.5,
            isEfficiencyValid: true,
            adx14: 25,
            isAdxValid: true,
            diSpread14: 5,
            isDiSpreadValid: true,
            rsi14: 58,
            isRsiValid: true,
            trend: 1,
            isTrendValid: true,
            buyStreak: 2,
            sellStreak: 0,
            signal: 0
        };
        assert(adaptVAMtoStrategyEvent({
            vamOutput: baseOut, confirmationBarIndex: 10, confirmationTimestamp: t0 + 10 * interval,
            entryTimestamp: null, symbol: 'SOLUSDT', timeframe: '1m', intervalMs: interval
        }) === null, 'signal=0 must return null');

        const buyEv = adaptVAMtoStrategyEvent({
            vamOutput: { ...baseOut, signal: 1, trend: 1 },
            confirmationBarIndex: 10, confirmationTimestamp: t0 + 10 * interval,
            entryTimestamp: null, symbol: 'SOLUSDT', timeframe: '1m', intervalMs: interval
        });
        assert(buyEv !== null && buyEv.eventType === 'VAM_BUY' && buyEv.confirmationLagBars === 0, 'signal=1 maps to VAM_BUY lag-0');

        const sellEv = adaptVAMtoStrategyEvent({
            vamOutput: { ...baseOut, signal: -1, trend: -1, sellStreak: 2, buyStreak: 0 },
            confirmationBarIndex: 11, confirmationTimestamp: t0 + 11 * interval,
            entryTimestamp: null, symbol: 'SOLUSDT', timeframe: '1m', intervalMs: interval
        });
        assert(sellEv !== null && sellEv.eventType === 'VAM_SELL' && sellEv.eventDirection === 'bear', 'signal=-1 maps to VAM_SELL');

        expectErrorMatching(() => adaptVAMtoStrategyEvent({
            vamOutput: { ...baseOut, signal: 2 as any },
            confirmationBarIndex: 12, confirmationTimestamp: t0 + 12 * interval,
            entryTimestamp: null, symbol: 'SOLUSDT', timeframe: '1m', intervalMs: interval
        }), 'unexpected signal', 'invalid VAM signal');
    });

    // 5. Combined 4-Teacher Stream: all 4 emit pre+post gap, gap resets all 4, final-bar null & 2-run determinism
    runTest('5. Combined 4-Teacher Stream: all 4 emit, gap resets all 4, final-bar null & 2-run determinism', () => {
        const stream: ML1Candle[] = [];
        let ts = t0;
        let p = 100;
        for (let i = 0; i < 300; i++) {
            if (i === 110) ts += 600_000; // 10-minute discontinuity

            const mod = i % 100;
            const delta = mod < 48
                ? ((i % 7 === 0 || i % 7 === 1) ? -0.4 : 1.6)
                : ((i % 7 === 0 || i % 7 === 1) ? 0.4 : -1.5);
            const o = p;
            const c = Math.max(10, p + delta);
            const h = Math.max(o, c) + 0.6;
            const l = Math.min(o, c) - 0.6;
            stream.push(makeCandle(ts, o, h, l, c, 100 + (i % 5) * 20));
            p = c;
            ts += interval;
        }

        const runPipeline = () => {
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

                const vamOut = stepVolatilityAdjustedMean(c.high, c.low, c.close, vamState, isDisc);
                vamState = vamOut.nextState;
                const atr = vamState.atrState.isSeeded ? vamState.atrState.atr : null;

                const vamEv = adaptVAMtoStrategyEvent({
                    vamOutput: vamOut,
                    confirmationBarIndex: i,
                    confirmationTimestamp: c.time,
                    entryTimestamp: null,
                    symbol: 'SOLUSDT',
                    timeframe: '1m',
                    intervalMs: interval
                });
                if (vamEv) rawEvents.push(vamEv);

                const cbcStep = stepStrictCBCWithReset(c, i, cbcState, lastCbcPivot, isDisc);
                cbcState = cbcStep.nextState;
                lastCbcPivot = cbcStep.nextPrevPivot;
                if (cbcStep.confirmedPivot) {
                    rawEvents.push(
                        adaptStrictCBCtoStrategyEvent({
                            pivot: cbcStep.confirmedPivot,
                            prevPivot: cbcStep.prevPivotForEvent,
                            confirmationTimestamp: c.time,
                            entryTimestamp: null,
                            atr14AtConfirmation: atr,
                            symbol: 'SOLUSDT',
                            timeframe: '1m',
                            intervalMs: interval
                        })
                    );
                }

                const phlRes = stepPHL(c, i, phlState, phlCfg, isDisc, atr, null);
                phlState = phlRes.nextState;
                rawEvents.push(...phlRes.events);

                const dtfxRes = stepDTFX(c, i, dtfxState, dtfxCfg, isDisc, atr, null);
                dtfxState = dtfxRes.nextState;
                rawEvents.push(...dtfxRes.events);

                if (i === 110) {
                    assert(lastCbcPivot === null && cbcState.anchorHigh === c.high && cbcState.anchorLow === c.low, 'StrictCBC failed gap reset');
                    assert(phlState.window.length === 1 && phlState.bull === null && phlState.ph === null && phlState.pl === null, 'PHL failed gap reset');
                    assert(dtfxState.window.length === 1 && dtfxState.activeZones.length === 0 && dtfxState.dir === 0 && dtfxState.tDir === 0, 'DTFX failed gap reset');
                    assert(vamState.unbrokenRun === 1 && vamState.trend === 0 && vamState.lastSignalAcceptedIndex === null, 'VAM failed gap reset');
                }
            }

            const resolved = resolveStrategyEventsEntryTimestamps(rawEvents, acceptedTimestamps, interval);
            return {
                acceptedTimestamps,
                verified: sortAndVerifyUniqueStrategyEvents(resolved)
            };
        };

        const run1 = runPipeline();
        const run2 = runPipeline();
        assert(JSON.stringify(run1.verified) === JSON.stringify(run2.verified), 'Two independent runs must be byte-identical');

        const { verified, acceptedTimestamps } = run1;
        const byStrategy: Record<string, number> = { STRICT_CBC: 0, PHL_BOS_MSS: 0, DTFX_ZONES: 0, VAM_REVERSAL: 0 };
        const byType: Record<string, number> = {};
        let preGapCount = 0;
        let postGapCount = 0;

        for (const ev of verified) {
            byStrategy[ev.strategyId] = (byStrategy[ev.strategyId] || 0) + 1;
            byType[ev.eventType] = (byType[ev.eventType] || 0) + 1;
            if (ev.confirmationBarIndex < 110) preGapCount++;
            if (ev.confirmationBarIndex >= 110) postGapCount++;

            if (ev.strategyId === 'PHL_BOS_MSS') {
                assert(ev.eventDiscriminator === 'PH' || ev.eventDiscriminator === 'PL', 'PHL discriminator');
            } else if (ev.strategyId === 'VAM_REVERSAL') {
                assert(ev.eventDiscriminator === 'BUY' || ev.eventDiscriminator === 'SELL', 'VAM discriminator');
            } else if (ev.strategyId === 'STRICT_CBC') {
                assert(/^\d+$/.test(ev.eventDiscriminator), 'StrictCBC discriminator must be pivotId');
            } else if (ev.strategyId === 'DTFX_ZONES') {
                assert(/^\d+(_R\d+)?$/.test(ev.eventDiscriminator), 'DTFX discriminator must be zoneId or zoneId_R<n>');
            }
        }

        console.log('  📊 Combined 4-Teacher Event Counts:', JSON.stringify({ byStrategy, byType, preGapCount, postGapCount }));
        assert(byStrategy.STRICT_CBC > 0, 'STRICT_CBC must emit events');
        assert(byStrategy.PHL_BOS_MSS > 0, 'PHL_BOS_MSS must emit events');
        assert(byStrategy.DTFX_ZONES > 0, 'DTFX_ZONES must emit events');
        assert(byStrategy.VAM_REVERSAL > 0, 'VAM_REVERSAL must emit events');
        assert(preGapCount > 0 && postGapCount > 0, 'Must emit events both pre-gap and post-gap');

        for (let k = 0; k < verified.length; k++) {
            const ev = verified[k];
            if (ev.confirmationBarIndex === 109) {
                assert(ev.entryTimestamp === acceptedTimestamps[110], 'Bar 109 must resolve actual post-gap timestamp');
            }
            if (ev.confirmationBarIndex === stream.length - 1) {
                assert(ev.entryTimestamp === null, 'Final bar must preserve entryTimestamp === null');
            }
            if (k > 0) {
                assert(compareStrategyEvents(verified[k - 1], ev) < 0, 'Canonical sort strict ordering invariant');
            }
        }
    });

    console.log(`\nPhase 5D Phase 2 Full Acceptance: ${passed} passed, ${failed} failed.`);
    return failed === 0;
}
