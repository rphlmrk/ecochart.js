import {
    adaptStrictCBCtoStrategyEvent,
    adaptVAMtoStrategyEvent,
    createStrategyEvent,
    resolveStrategyEventsEntryTimestamps,
    sortAndVerifyUniqueStrategyEvents,
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
    stepDTFX
} from '../indicators/mlr1/teachers/DTFXAlgoZonesTeacher';
import { createInitialStrictCBCState, stepStrictCBC } from '../indicators/plugins/StrictCBCZigZagIndicator';
import { createInitialVAMState, stepVolatilityAdjustedMean } from '../indicators/mlr1/trend/VolatilityAdjustedMean';
import type { ML1Candle } from '../indicators/mlr1/ML1FeatureTypes';

function assert(condition: boolean, msg: string): asserts condition {
    if (!condition) throw new Error(`[Phase5DPhase2Failed] ${msg}`);
}

function makeCandle(time: number, open: number, high: number, low: number, close: number, volume = 100): ML1Candle {
    return { time, open, high, low, close, volume, isSynthetic: false };
}

/**
 * PHASE 2 ENTRY GATE 1: StrategyEvent Runtime Contract, Discriminators, Uniqueness & Final-Bar Semantics
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

    runTest('Gate1.1: StrategyEvent contract fields, immutability & discriminator validation', () => {
        const ev = createStrategyEvent({
            strategyId: 'DTFX_ZONES',
            strategyVersion: 'DTFX_ZONES_v1',
            symbol: 'SOLUSDT',
            timeframe: '1m',
            intervalMs: interval,
            eventType: 'DTFX_DEMAND_RETEST',
            eventDirection: 'bull',
            eventDiscriminator: '7_R1',
            sourceBarIndex: 25,
            sourceTimestamp: t0 + 25 * interval,
            confirmationBarIndex: 25,
            confirmationTimestamp: t0 + 25 * interval,
            entryTimestamp: t0 + 26 * interval,
            structuralContext: { zoneId: 7, retestCount: 1 }
        });
        assert(ev.eventId === 'DTFX_ZONES_DTFX_ZONES_v1_SOLUSDT_1m_DTFX_DEMAND_RETEST_25_25_7_R1', 'eventId format mismatch');
        assert(ev.eventDiscriminator === '7_R1', 'eventDiscriminator mismatch');
        assert(ev.observationTimestamp === ev.confirmationTimestamp + interval, 'observationTimestamp mismatch');
        assert(ev.entryBarIndex === 26 && ev.entryTimestamp === t0 + 26 * interval, 'entry mapping mismatch');
        assert(Object.isFrozen(ev) && Object.isFrozen(ev.structuralContext), 'StrategyEvent must be deeply frozen');

        let badDisc = false;
        try {
            createStrategyEvent({
                strategyId: 'PHL_BOS_MSS',
                strategyVersion: 'PHL_BOS_MSS_v1',
                symbol: 'SOLUSDT',
                timeframe: '1m',
                intervalMs: interval,
                eventType: 'PHL_MSS_BULL',
                eventDirection: 'bull',
                eventDiscriminator: '  ',
                sourceBarIndex: 5,
                sourceTimestamp: t0 + 5 * interval,
                confirmationBarIndex: 8,
                confirmationTimestamp: t0 + 8 * interval,
                entryTimestamp: null,
                structuralContext: {}
            });
        } catch {
            badDisc = true;
        }
        assert(badDisc, 'Empty eventDiscriminator must throw');
    });

    runTest('Gate1.2: Collision resistance & deterministic sorting across simultaneous events', () => {
        const eA = createStrategyEvent({
            strategyId: 'DTFX_ZONES',
            strategyVersion: 'DTFX_ZONES_v1',
            symbol: 'SOLUSDT',
            timeframe: '1m',
            intervalMs: interval,
            eventType: 'DTFX_DEMAND_RETEST',
            eventDirection: 'bull',
            eventDiscriminator: '2_R1',
            sourceBarIndex: 30,
            sourceTimestamp: t0 + 30 * interval,
            confirmationBarIndex: 30,
            confirmationTimestamp: t0 + 30 * interval,
            entryTimestamp: t0 + 31 * interval,
            structuralContext: { zoneId: 2 }
        });
        const eB = createStrategyEvent({
            strategyId: 'DTFX_ZONES',
            strategyVersion: 'DTFX_ZONES_v1',
            symbol: 'SOLUSDT',
            timeframe: '1m',
            intervalMs: interval,
            eventType: 'DTFX_DEMAND_RETEST',
            eventDirection: 'bull',
            eventDiscriminator: '1_R1',
            sourceBarIndex: 30,
            sourceTimestamp: t0 + 30 * interval,
            confirmationBarIndex: 30,
            confirmationTimestamp: t0 + 30 * interval,
            entryTimestamp: t0 + 31 * interval,
            structuralContext: { zoneId: 1 }
        });
        const eC = createStrategyEvent({
            strategyId: 'STRICT_CBC',
            strategyVersion: 'StrictCBCZigZag_v1',
            symbol: 'SOLUSDT',
            timeframe: '1m',
            intervalMs: interval,
            eventType: 'CBC_LOW_HL',
            eventDirection: 'bull',
            eventDiscriminator: '4',
            sourceBarIndex: 28,
            sourceTimestamp: t0 + 28 * interval,
            confirmationBarIndex: 29,
            confirmationTimestamp: t0 + 29 * interval,
            entryTimestamp: t0 + 30 * interval,
            structuralContext: {}
        });

        const sorted = sortAndVerifyUniqueStrategyEvents([eA, eB, eC]);
        assert(sorted[0] === eC && sorted[1] === eB && sorted[2] === eA, 'Deterministic tie-break sort failed');

        let dupThrew = false;
        try {
            sortAndVerifyUniqueStrategyEvents([eA, { ...eA }]);
        } catch (e: any) {
            dupThrew = String(e.message).includes('Collision');
        }
        assert(dupThrew, 'Duplicate eventId must fail closed');
    });

    runTest('Gate1.3: Final-bar entryTimestamp=null & discontinuous entryTimestamp resolution', () => {
        // Accepted timestamps with a 10-minute gap between bar 1 and bar 2
        const acceptedTs = [t0, t0 + interval, t0 + 11 * interval];
        const evGap = createStrategyEvent({
            strategyId: 'PHL_BOS_MSS',
            strategyVersion: 'PHL_BOS_MSS_v1',
            symbol: 'SOLUSDT',
            timeframe: '1m',
            intervalMs: interval,
            eventType: 'PHL_BOS_BULL',
            eventDirection: 'bull',
            eventDiscriminator: 'PH',
            sourceBarIndex: 0,
            sourceTimestamp: acceptedTs[0],
            confirmationBarIndex: 1,
            confirmationTimestamp: acceptedTs[1],
            entryTimestamp: null,
            structuralContext: {}
        });
        const evFinal = createStrategyEvent({
            strategyId: 'VAM_REVERSAL',
            strategyVersion: 'VAM_v1',
            symbol: 'SOLUSDT',
            timeframe: '1m',
            intervalMs: interval,
            eventType: 'VAM_BUY',
            eventDirection: 'bull',
            eventDiscriminator: 'BUY',
            sourceBarIndex: 1,
            sourceTimestamp: acceptedTs[1],
            confirmationBarIndex: 2,
            confirmationTimestamp: acceptedTs[2],
            entryTimestamp: null,
            structuralContext: {}
        });

        const resolved = resolveStrategyEventsEntryTimestamps([evGap, evFinal], acceptedTs);
        // Must resolve to actual next candle t0 + 11*interval (NOT t0 + 2*interval!)
        assert(resolved[0].entryTimestamp === t0 + 11 * interval, 'Discontinuous entryTimestamp must come from actual next accepted candle');
        // Final bar has no next accepted candle -> must remain null
        assert(resolved[1].entryTimestamp === null, 'Final bar event must retain entryTimestamp=null');
    });

    console.log(`\nPhase 5D Phase 2 Gate 1: ${passed} passed, ${failed} failed.`);
    return failed === 0;
}

/**
 * PHASE 2 FULL TEACHER ACCEPTANCE SUITE (Gate 1 + StrictCBC/VAM Adapters + PHL + DTFX)
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

    // 1. PHL Teacher: ps=3 lag, use_valid_pbs, unknown-dir MSS -> BOS -> reversal MSS, prefix invariance & serialization
    runTest('1. PHL Teacher: ps=3 confirmation timing, MSS/BOS transitions, prefix invariance & restoration', () => {
        const cfg = createDefaultPHLConfig('SOLUSDT', '1m', interval);
        // Construct swing sequence: low @3, bounce @5, lower break, rally break
        const closes = [
            100, 102, 105, 108, 104, 102, 100, // bar 6 confirms PH @3 (109)
            99, 98, 96, 98, 100, 102, 104,     // bar 13 confirms PL @9 (95) -> pullback from high validated
            106, 111,                          // bar 15 closes > 109 -> PHL_MSS_BULL (unknown dir -> bull=true)
            113, 116, 112, 110, 109, 108,      // pullback & pivot high @17 (117) confirmed @20
            110, 112, 115, 119,                // bar 25 closes > 117 -> PHL_BOS_BULL (bull=true -> BOS)
            114, 109, 104, 99, 94              // bar 30 breaks below protected low -> PHL_MSS_BEAR (reversal)
        ];
        const stream: ML1Candle[] = closes.map((c, i) => {
            const o = i === 0 ? c : closes[i - 1];
            const h = Math.max(o, c) + 1;
            const l = Math.min(o, c) - 1;
            return makeCandle(t0 + i * interval, o, h, l, c, 100);
        });

        let fullState = createInitialPHLState();
        const fullEvents: StrategyEvent[] = [];
        for (let i = 0; i < stream.length; i++) {
            const res = stepPHL(stream[i], i, fullState, cfg, false, 2.0, null);
            fullState = res.nextState;
            fullEvents.push(...res.events);
            // Every event must confirm strictly at i (never back-dated to sourceBarIndex)
            for (const ev of res.events) {
                assert(ev.confirmationBarIndex === i, `Event confirmed at ${ev.confirmationBarIndex}, expected ${i}`);
                assert(ev.sourceBarIndex <= i - 3, 'Pivot source must precede confirmation by >= ps bars');
            }
        }

        assert(fullEvents.some(e => e.eventType === 'PHL_MSS_BULL'), 'Expected initial PHL_MSS_BULL');
        assert(fullEvents.some(e => e.eventType === 'PHL_BOS_BULL'), 'Expected continuation PHL_BOS_BULL');
        assert(fullEvents.some(e => e.eventType === 'PHL_MSS_BEAR'), 'Expected reversal PHL_MSS_BEAR');

        // Prefix invariance & checkpoint restoration at bar 16
        let splitState = createInitialPHLState();
        const splitEvents: StrategyEvent[] = [];
        for (let i = 0; i <= 16; i++) {
            const res = stepPHL(stream[i], i, splitState, cfg, false, 2.0, null);
            splitState = res.nextState;
            splitEvents.push(...res.events);
        }
        // Prefix events up to 16 must match full events confirmed <= 16 bitwise
        assert(
            JSON.stringify(splitEvents) === JSON.stringify(fullEvents.filter(e => e.confirmationBarIndex <= 16)),
            'PHL prefix invariance failed'
        );

        let restored = JSON.parse(JSON.stringify(splitState));
        for (let i = 17; i < stream.length; i++) {
            const res = stepPHL(stream[i], i, restored, cfg, false, 2.0, null);
            restored = res.nextState;
            splitEvents.push(...res.events);
        }
        assert(JSON.stringify(fullEvents) === JSON.stringify(splitEvents), 'PHL restored events diverged');
        assert(JSON.stringify(fullState) === JSON.stringify(restored), 'PHL restored state diverged');
    });

    // 2. DTFX Teacher: CREATED -> ACTIVE -> RETESTED -> INVALIDATED, invalidation>retest precedence, overlapping zones & restoration
    runTest('2. DTFX Teacher: zone lifecycle, invalidation>retest precedence, overlap & restoration', () => {
        const cfg = createDefaultDTFXConfig('SOLUSDT', '1m', interval);
        // Wave stream long enough for structureLen=10 swings + break + retest + invalidation
        const stream: ML1Candle[] = [];
        for (let i = 0; i < 90; i++) {
            let p = 100;
            if (i < 15) p = 100 + i;               // high @14 (114)
            else if (i < 28) p = 114 - (i - 14);   // low @27 (101)
            else if (i < 42) p = 101 + (i - 27) * 1.4; // crosses above swing high -> DEMAND CREATED
            else if (i < 55) p = 121 - (i - 41) * 1.1; // dips back into demand zone -> RETEST
            else if (i < 70) p = 106 - (i - 54) * 1.5; // closes below demand zone -> INVALIDATED
            else p = 84 + (i - 69) * 1.2;

            const o = i === 0 ? p : stream[i - 1].close;
            stream.push(makeCandle(t0 + i * interval, o, Math.max(o, p) + 0.5, Math.min(o, p) - 0.5, p, 100));
        }

        let state = createInitialDTFXState();
        const events: StrategyEvent[] = [];
        let sawInvalidated = false;

        for (let i = 0; i < stream.length; i++) {
            const res = stepDTFX(stream[i], i, state, cfg, false, 2.0, null);
            state = res.nextState;
            events.push(...res.events);
            if (res.invalidatedZones.length > 0) sawInvalidated = true;
            for (const ev of res.events) {
                if (ev.eventType === 'DTFX_DEMAND_RETEST' || ev.eventType === 'DTFX_SUPPLY_RETEST') {
                    // Retest sourceBarIndex must be the retest candle i itself
                    assert(ev.sourceBarIndex === i && ev.confirmationBarIndex === i, 'Retest sourceBarIndex must equal retest bar');
                    assert(
                        (ev.structuralContext['zoneCreatedSourceBarIndex'] as number) < i,
                        'Retest must carry distinct creation provenance in structuralContext'
                    );
                }
            }
        }

        assert(events.some(e => e.eventType === 'DTFX_DEMAND_CREATED'), 'Expected DTFX_DEMAND_CREATED');
        assert(events.some(e => e.eventType === 'DTFX_DEMAND_RETEST'), 'Expected DTFX_DEMAND_RETEST');
        assert(sawInvalidated, 'Expected zone invalidation');

        // Explicit same-bar precedence test: touching zone AND closing below bot must invalidate WITHOUT emitting retest
        const preZone = {
            zoneId: 99,
            direction: 'bull' as const,
            top: 105,
            bot: 100,
            fib03: 101.5,
            fib05: 102.5,
            fib07: 103.5,
            createdSourceBarIndex: 2,
            createdSourceTimestamp: t0 + 2 * interval,
            createdConfirmationBarIndex: 12,
            createdConfirmationTimestamp: t0 + 12 * interval,
            status: 'ACTIVE' as const,
            retestCount: 0,
            firstRetestBarIndex: null,
            invalidationBarIndex: null
        };
        const baseSeeded = { ...createInitialDTFXState(100), activeZones: Object.freeze([preZone]) };
        // Candle touches [100..105] (high=103) AND closes at 98 (< bot 100)
        const killRes = stepDTFX(makeCandle(t0 + 20 * interval, 102, 103, 97, 98, 100), 20, baseSeeded, cfg, false, 2.0, null);
        assert(killRes.invalidatedZones.length === 1 && killRes.retestedZones.length === 0,
            'Invalidation must take precedence over retest on the same bar');
        assert(killRes.events.every(e => e.eventType !== 'DTFX_DEMAND_RETEST'), 'No retest event may emit on invalidation bar');

        // Serialization parity check at bar 45
        let sSplit = createInitialDTFXState();
        const evSplit: StrategyEvent[] = [];
        for (let i = 0; i <= 45; i++) {
            const r = stepDTFX(stream[i], i, sSplit, cfg, false, 2.0, null);
            sSplit = r.nextState;
            evSplit.push(...r.events);
        }
        let sRestored = JSON.parse(JSON.stringify(sSplit));
        for (let i = 46; i < stream.length; i++) {
            const r = stepDTFX(stream[i], i, sRestored, cfg, false, 2.0, null);
            sRestored = r.nextState;
            evSplit.push(...r.events);
        }
        assert(JSON.stringify(events) === JSON.stringify(evSplit), 'DTFX restored events diverged');
        assert(JSON.stringify(state) === JSON.stringify(sRestored), 'DTFX restored state diverged');
    });

    // 3. Combined 4-Teacher Stream (StrictCBC + PHL + DTFX + VAM): uniqueness, canonical sort & gap/final-bar handling
    runTest('3. Combined 4-Teacher Stream: global uniqueness, canonical sorting & gap/final-bar handling', () => {
        const stream: ML1Candle[] = [];
        let ts = t0;
        for (let i = 0; i < 180; i++) {
            if (i === 90) ts += 600_000; // Inject 10-minute discontinuity
            const p = 100 + Math.sin(i / 7) * 14 + (i > 90 ? (i - 90) * 0.25 : 0);
            const o = i === 0 ? p : stream[i - 1].close;
            stream.push(makeCandle(ts, o, Math.max(o, p) + 0.8, Math.min(o, p) - 0.8, p, 100 + (i % 5) * 20));
            ts += interval;
        }

        const phlCfg = createDefaultPHLConfig('SOLUSDT', '1m', interval);
        const dtfxCfg = createDefaultDTFXConfig('SOLUSDT', '1m', interval);

        let cbcState = createInitialStrictCBCState(stream[0]);
        let lastCbcPivot: ReturnType<typeof stepStrictCBC>['confirmedPivot'] = null;
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
                sourceBarIndex: Math.max(0, i - 1),
                sourceTimestamp: stream[Math.max(0, i - 1)].time,
                entryTimestamp: null,
                symbol: 'SOLUSDT',
                timeframe: '1m',
                intervalMs: interval
            });
            if (vamEv) rawEvents.push(vamEv);

            const cbcStep = stepStrictCBC(c, i, cbcState);
            cbcState = cbcStep.nextState;
            if (cbcStep.confirmedPivot) {
                rawEvents.push(
                    adaptStrictCBCtoStrategyEvent({
                        pivot: cbcStep.confirmedPivot,
                        prevPivot: lastCbcPivot,
                        confirmationTimestamp: c.time,
                        entryTimestamp: null,
                        atr14AtConfirmation: atr,
                        symbol: 'SOLUSDT',
                        timeframe: '1m',
                        intervalMs: interval
                    })
                );
                lastCbcPivot = cbcStep.confirmedPivot;
            }

            const phlRes = stepPHL(c, i, phlState, phlCfg, isDisc, atr, null);
            phlState = phlRes.nextState;
            rawEvents.push(...phlRes.events);

            const dtfxRes = stepDTFX(c, i, dtfxState, dtfxCfg, isDisc, atr, null);
            dtfxState = dtfxRes.nextState;
            rawEvents.push(...dtfxRes.events);
        }

        const resolved = resolveStrategyEventsEntryTimestamps(rawEvents, acceptedTimestamps);
        const verified = sortAndVerifyUniqueStrategyEvents(resolved);

        assert(verified.length > 10, 'Expected multi-teacher events across 180 bars');
        const strategySet = new Set(verified.map(e => e.strategyId));
        assert(strategySet.has('STRICT_CBC') && strategySet.has('PHL_BOS_MSS') && strategySet.has('DTFX_ZONES'),
            'Expected events from multiple strategies');

        // Verify monotonic ordering & entry timestamp accuracy across bar 90 gap
        for (let k = 0; k < verified.length; k++) {
            const ev = verified[k];
            if (ev.confirmationBarIndex === 89) {
                assert(ev.entryTimestamp === acceptedTimestamps[90], 'Bar 89 event must resolve entryTimestamp across 10m gap');
            }
            if (ev.confirmationBarIndex === stream.length - 1) {
                assert(ev.entryTimestamp === null, 'Final bar event must have entryTimestamp === null');
            }
            if (k > 0) {
                assert(verified[k - 1].confirmationBarIndex <= ev.confirmationBarIndex, 'Events must be sorted chronologically');
            }
        }
    });

    console.log(`\nPhase 5D Phase 2 Full Acceptance: ${passed} passed, ${failed} failed.`);
    return failed === 0;
}
