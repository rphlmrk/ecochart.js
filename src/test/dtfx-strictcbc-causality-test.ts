import type { ML1Candle } from '../indicators/mlr1/ML1FeatureTypes';
import {
    createDefaultDTFXStrictCBCConfig,
    createDefaultDTFXStrictCBCMultiConfigs,
    createInitialDTFXStrictCBCMultiState,
    createInitialDTFXStrictCBCState,
    DTFX_STRICTCBC_TIMEFRAME_MS,
    stepDTFXStrictCBC,
    stepDTFXStrictCBCMulti,
    type DTFXStrictCBCTeacherEvent,
    type DTFXStrictCBCTimeframe
} from '../indicators/mlr1/teachers/DTFXStrictCBCTeacher';
import type { StrictZigZagPivot } from '../indicators/plugins/StrictCBCZigZagIndicator';
import { DTFXStrictCBCIndicator } from '../indicators/plugins/DTFXStrictCBCIndicator';
import { DataStore } from '../data/DataStore';

function assert(condition: boolean, msg: string): asserts condition {
    if (!condition) throw new Error(`[DTFXStrictCBCCausalityFailed] ${msg}`);
}

function makeTestStream(count: number, startTime: number, intervalMs = 60_000, gapAtIndex?: number): ML1Candle[] {
    const out: ML1Candle[] = [];
    let ts = startTime;
    let price = 100;
    for (let i = 0; i < count; i++) {
        if (gapAtIndex !== undefined && i === gapAtIndex) {
            ts += 10 * intervalMs;
        }
        const wave = Math.floor(i / 30) % 2 === 0 ? 1 : -1;
        const micro = (i % 7 === 0 || i % 7 === 1) ? -0.35 * wave : 0.75 * wave;
        const open = price;
        const close = Math.max(20, open + micro);
        const high = Math.max(open, close) + 0.5;
        const low = Math.min(open, close) - 0.5;
        out.push({ time: ts, open, high, low, close, volume: 100 + (i % 5) * 10, isSynthetic: false });
        price = close;
        ts += intervalMs;
    }
    return out;
}

function runSingleTf(
    stream: readonly ML1Candle[],
    tf: DTFXStrictCBCTimeframe,
    atrByBar: (i: number) => number | null = () => 1.5
): { events: DTFXStrictCBCTeacherEvent[]; pivots: StrictZigZagPivot[]; activeZoneCountAtEnd: number } {
    const cfg = createDefaultDTFXStrictCBCConfig('SOLUSDT', '1m', 60_000, tf);
    let state = createInitialDTFXStrictCBCState();
    const events: DTFXStrictCBCTeacherEvent[] = [];
    const pivots: StrictZigZagPivot[] = [];
    let prevTime = -1;
    for (let i = 0; i < stream.length; i++) {
        const c = stream[i];
        const isDisc = prevTime !== -1 && (c.time - prevTime) >= 300_000;
        prevTime = c.time;
        const res = stepDTFXStrictCBC(c, i, state, cfg, isDisc, atrByBar(i));
        state = res.nextState;
        events.push(...res.events);
        if (res.confirmedPivot) pivots.push(res.confirmedPivot);
    }
    return { events, pivots, activeZoneCountAtEnd: state.activeZones.length };
}

export function runDTFXStrictCBCCausalityTests(): boolean {
    console.log('\n======================================================');
    console.log('🧪 Starting Step 2 (2A–2C): DTFXStrictCBCTeacher Audit Suite');
    console.log('======================================================\n');
    let passed = 0;
    let failed = 0;

    const runTest = (name: string, fn: () => void) => {
        try {
            fn();
            passed++;
            console.log(`  ✅ Passed: ${name}`);
        } catch (e: unknown) {
            failed++;
            console.error(`  ❌ Failed: ${name} - ${e instanceof Error ? e.message : String(e)}`);
        }
    };

    const t0 = Date.UTC(2026, 9, 15, 0, 0, 0);
    const interval = 60_000;
    const fullStream = makeTestStream(450, t0, interval);

    // 1. Exhaustive Prefix-Invariance Proof (Zero Future Lookahead across 1m, 3m, 5m, 15m)
    runTest('1. Exhaustive Prefix-Invariance Across All Prefixes k=1..450', () => {
        for (const tf of ['1m', '3m', '5m', '15m'] as const) {
            const full = runSingleTf(fullStream, tf);
            assert(full.events.some(e => e.structuralContext.zoneStatus === 'CREATED'), `Expected CREATED for ${tf}`);
            assert(full.events.some(e => e.structuralContext.zoneStatus === 'RETESTED'), `Expected RETESTED for ${tf}`);

            for (let k = 1; k <= fullStream.length; k++) {
                const prefix = runSingleTf(fullStream.slice(0, k), tf);
                const expectedPrefix = full.events.filter(e => e.confirmationBarIndex < k);
                assert(
                    JSON.stringify(prefix.events) === JSON.stringify(expectedPrefix),
                    `Lookahead detected for ${tf} at prefix k=${k}`
                );
            }
        }
    });

    // 2. Strict Bucket-Close Confirmation Timing (3m / 5m / 15m)
    runTest('2. HTF Zone Creation Never Confirms Before Bucket Close (3m / 5m / 15m)', () => {
        for (const tf of ['3m', '5m', '15m'] as const) {
            const tfMs = DTFX_STRICTCBC_TIMEFRAME_MS[tf];
            const { events } = runSingleTf(fullStream, tf);
            const created = events.filter(e => e.structuralContext.zoneStatus === 'CREATED');
            assert(created.length > 0, `Expected CREATED events for ${tf}`);

            for (const ev of created) {
                assert(
                    (ev.confirmationTimestamp + interval) % tfMs === 0,
                    `${tf} CREATED event confirmed before HTF close at bar ${ev.confirmationBarIndex}`
                );
                assert(
                    ev.sourceBarIndex < ev.confirmationBarIndex &&
                    ev.sourceTimestamp < ev.confirmationTimestamp,
                    `${tf} sourceBarIndex must strictly precede confirmationBarIndex`
                );
            }

            const stepPerBucket = tfMs / interval;
            const partialEnd = stepPerBucket * 10 - 1;
            const partial = runSingleTf(fullStream.slice(0, partialEnd), tf);
            const partialMaxCreated = partial.events
                .filter(e => e.structuralContext.zoneStatus === 'CREATED')
                .reduce((mx, e) => Math.max(mx, e.confirmationBarIndex), -1);
            assert(
                partialMaxCreated < partialEnd - (stepPerBucket - 1),
                `${tf} emitted CREATED event from an incomplete forming bucket`
            );
        }
    });

    // 3. Mid-Bucket Start Rejection
    runTest('3. Mid-Bucket Stream Start Rejects Partial Opening Bucket (15m)', () => {
        const midStartStream = makeTestStream(120, t0 + 2 * interval, interval);
        const { events } = runSingleTf(midStartStream, '15m');
        for (const ev of events) {
            assert(ev.confirmationBarIndex >= 27, `Partial opening 15m bucket leaked event at ${ev.confirmationBarIndex}`);
        }
    });

    // 4. Exhaustive Gap & Corrupt-Bucket Active-Zone Reset (1m + 3m + 5m + 15m, all bucket positions)
    runTest('4. Gaps at Bucket Start, Mid-Bucket, Final Bar & 1m Mode Clear Active Zones', () => {
        // 4a. Explicit 10m discontinuity
        const gapIdx = 120;
        const gappedStream = makeTestStream(300, t0, interval, gapIdx);
        for (const tf of ['1m', '3m', '5m', '15m'] as const) {
            const { events } = runSingleTf(gappedStream, tf);
            for (const ev of events) {
                assert(ev.confirmationBarIndex !== gapIdx, `${tf} emitted event on discontinuity bar ${gapIdx}`);
                if (ev.confirmationBarIndex > gapIdx) {
                    assert(ev.sourceBarIndex >= gapIdx, `${tf} post-gap event referenced pre-gap source ${ev.sourceBarIndex}`);
                }
            }
        }

        // 4b. 1m mode: short 120,000ms gap (isDiscontinuity=false) after a zone is created MUST clear activeZones
        {
            const base1m = runSingleTf(fullStream, '1m');
            const firstZone1m = base1m.events.find(e => e.structuralContext.zoneStatus === 'CREATED');
            assert(firstZone1m !== undefined, 'Expected 1m zone for gap test');
            const dropAt = firstZone1m!.confirmationBarIndex + 1; // Immediately after completed 1m bar that created zone
            const gapped1m = fullStream.filter((_, i) => i !== dropAt).slice(0, dropAt + 20);
            const cfg = createDefaultDTFXStrictCBCConfig('SOLUSDT', '1m', interval, '1m');
            let s = createInitialDTFXStrictCBCState();
            let preZones = 0;
            const postRetests: DTFXStrictCBCTeacherEvent[] = [];

            for (let i = 0; i < gapped1m.length; i++) {
                const res = stepDTFXStrictCBC(gapped1m[i], i, s, cfg, false, 1.5);
                s = res.nextState;
                if (i === dropAt - 1) preZones = s.activeZones.length;
                if (i === dropAt) {
                    assert(s.activeZones.length === 0, '1m short gap must clear pre-gap activeZones immediately');
                }
                if (i >= dropAt) {
                    postRetests.push(...res.events.filter(e => e.structuralContext.zoneStatus === 'RETESTED'));
                    for (const ev of res.events) {
                        assert(ev.sourceBarIndex >= dropAt, '1m post-gap event cannot reference pre-gap source');
                    }
                }
            }
            assert(preZones >= 1, '1m expected active zone before gap');
            assert(postRetests.every(e => e.sourceBarIndex >= dropAt), '1m pre-gap zone must never emit post-gap retest');
        }

        // 4c. HTF 3m / 5m / 15m: missing FIRST candle of next bucket (resuming mid-bucket), MIDDLE candle, and FINAL candle
        for (const tf of ['3m', '5m', '15m'] as const) {
            const baseline = runSingleTf(fullStream, tf);
            const firstZoneEv = baseline.events.find(e => e.structuralContext.zoneStatus === 'CREATED');
            assert(firstZoneEv !== undefined, `Need at least one CREATED zone for ${tf}`);

            const barsPerBucket = DTFX_STRICTCBC_TIMEFRAME_MS[tf] / interval;
            const zoneBar = firstZoneEv!.confirmationBarIndex;
            const nextBucketStart = zoneBar + 1;
            const dropFirstOffset = nextBucketStart; // First candle of new bucket -> resumes mid-bucket
            const dropInsideOffset = nextBucketStart + Math.floor(barsPerBucket / 2); // Middle candle of new bucket
            const dropFinalOffset = nextBucketStart + barsPerBucket - 1; // Final candle of new bucket

            for (const [label, dropIdx] of [
                ['first-candle-resume-mid-bucket', dropFirstOffset],
                ['mid-bucket-candle', dropInsideOffset],
                ['final-bucket-candle', dropFinalOffset]
            ] as const) {
                const corruptStream = fullStream.filter((_, i) => i !== dropIdx).slice(0, nextBucketStart + barsPerBucket + 5);
                const cfg = createDefaultDTFXStrictCBCConfig('SOLUSDT', '1m', interval, tf);
                let state = createInitialDTFXStrictCBCState();
                let preGapZones = 0;

                for (let i = 0; i < corruptStream.length; i++) {
                    const res = stepDTFXStrictCBC(corruptStream[i], i, state, cfg, false, 1.5);
                    state = res.nextState;
                    if (i === dropIdx - 1) preGapZones = state.activeZones.length;
                    if (i === dropIdx) {
                        assert(
                            state.activeZones.length === 0,
                            `${tf} (${label}): gap at ${dropIdx} must clear activeZones before retest evaluation`
                        );
                        if (label === 'first-candle-resume-mid-bucket') {
                            assert(
                                state.formingBucket === null,
                                `${tf} (${label}): mid-bucket resumption must reject partial bucket until next grid start`
                            );
                        }
                    }
                    if (i >= dropIdx) {
                        for (const ev of res.events) {
                            assert(
                                ev.sourceBarIndex >= dropIdx && ev.structuralContext.zoneCreatedConfirmationBarIndex >= dropIdx,
                                `${tf} (${label}): post-gap event leaked pre-gap structure or zone retest`
                            );
                        }
                    }
                }
                assert(preGapZones >= 1, `${tf} (${label}): expected active zone before gap at ${dropIdx}`);
            }
        }

        // 4d. 1m explicit discontinuity (isDiscontinuity=true) event-integrity contract
        {
            const base1m = runSingleTf(fullStream, '1m');
            const firstZone1m = base1m.events.find(e => e.structuralContext.zoneStatus === 'CREATED');
            assert(firstZone1m !== undefined, 'Expected 1m CREATED zone before discontinuity');
            const discIdx = firstZone1m!.confirmationBarIndex + 1;

            const cfg1m = createDefaultDTFXStrictCBCConfig('SOLUSDT', '1m', interval, '1m');
            let s1m = createInitialDTFXStrictCBCState();
            let preZones1m = 0;
            const postEvents1m: DTFXStrictCBCTeacherEvent[] = [];

            for (let i = 0; i < Math.min(fullStream.length, discIdx + 180); i++) {
                const isDisc = i === discIdx;
                const res = stepDTFXStrictCBC(fullStream[i], i, s1m, cfg1m, isDisc, 1.5);
                s1m = res.nextState;
                if (i === discIdx - 1) preZones1m = s1m.activeZones.length;
                if (i === discIdx) {
                    assert(res.events.length === 0, '1m discontinuity bar must emit zero events (no pre-gap retest)');
                    assert(res.confirmedPivot === null, '1m discontinuity bar must not confirm a pivot');
                    assert(s1m.activeZones.length === 0, '1m discontinuity bar must not silently create zones in state');
                }
                if (i > discIdx) {
                    postEvents1m.push(...res.events);
                }
            }
            assert(preZones1m >= 1, 'Expected active 1m zone before explicit discontinuity');

            const createdByZoneId = new Map<number, DTFXStrictCBCTeacherEvent>();
            for (const ev of postEvents1m) {
                assert(ev.sourceBarIndex >= discIdx, '1m post-discontinuity event cannot reference pre-gap source');
                if (ev.structuralContext.zoneStatus === 'CREATED') {
                    createdByZoneId.set(ev.structuralContext.zoneId, ev);
                } else {
                    const parentCreated = createdByZoneId.get(ev.structuralContext.zoneId);
                    assert(
                        parentCreated !== undefined &&
                        parentCreated.confirmationBarIndex < ev.confirmationBarIndex,
                        `1m post-gap RETEST for zoneId=${ev.structuralContext.zoneId} lacked a prior post-gap CREATED event`
                    );
                }
            }
            assert(
                createdByZoneId.size > 0 && postEvents1m.some(e => e.structuralContext.zoneStatus === 'RETESTED'),
                '1m post-discontinuity stream must produce valid CREATED and RETESTED events'
            );
        }
    });

    // 5. Explicit ATR Missingness Handling
    runTest('5. Unwarmed / Invalid ATR Emits Null Metrics & atr14Valid=false (Never 0)', () => {
        const eventsNull = runSingleTf(fullStream.slice(0, 200), '1m', () => null).events;
        const eventsNeg = runSingleTf(fullStream.slice(0, 200), '1m', () => -2.0).events;
        const eventsNaN = runSingleTf(fullStream.slice(0, 200), '1m', () => Number.NaN).events;

        for (const evList of [eventsNull, eventsNeg, eventsNaN]) {
            assert(evList.length > 0, 'Expected teacher events during ATR missingness test');
            for (const ev of evList) {
                assert(
                    ev.structuralContext.atr14Valid === false &&
                    ev.structuralContext.zoneWidthAtr === null &&
                    ev.structuralContext.fib05DistAtr === null,
                    'Invalid ATR must emit atr14Valid=false and null ATR metrics'
                );
            }
        }

        const eventsValid = runSingleTf(fullStream.slice(0, 200), '1m', () => 2.0).events;
        assert(eventsValid.length > 0, 'Expected teacher events with valid ATR');
        for (const ev of eventsValid) {
            assert(
                ev.structuralContext.atr14Valid === true &&
                typeof ev.structuralContext.zoneWidthAtr === 'number' &&
                ev.structuralContext.zoneWidthAtr > 0 &&
                typeof ev.structuralContext.fib05DistAtr === 'number',
                'Valid ATR must emit atr14Valid=true and finite numeric metrics'
            );
        }
    });

    // 6. Boundary Validation (Config + baseTimeframe vs baseIntervalMs + Chronology + Grid)
    runTest('6. Boundary Validation Rejects Bad Config, BaseTF Mismatch, Out-of-Order & Off-Grid Bars', () => {
        const expectThrow = (fn: () => void, label: string) => {
            let threw = false;
            try { fn(); } catch { threw = true; }
            assert(threw, `${label} must throw`);
        };

        expectThrow(() => createDefaultDTFXStrictCBCConfig('SOLUSDT', '1m', 300_000, '5m'), 'baseTimeframe=1m vs 300_000ms');
        expectThrow(() => createDefaultDTFXStrictCBCConfig('SOLUSDT', '5m', 60_000, '5m'), 'baseTimeframe=5m vs 60_000ms');
        expectThrow(() => createDefaultDTFXStrictCBCConfig('SOLUSDT', '1m', 60_000, '15m', { maxActiveZones: 0 }), 'maxActiveZones=0');
        expectThrow(() => createDefaultDTFXStrictCBCConfig('SOLUSDT', '1m', 60_000, '15m', { maxRetestsPerZone: -1 }), 'maxRetestsPerZone=-1');

        const cfg = createDefaultDTFXStrictCBCConfig('SOLUSDT', '1m', 60_000, '5m');
        const s0 = createInitialDTFXStrictCBCState();
        expectThrow(() => stepDTFXStrictCBC(fullStream[0], 1, s0, cfg, false, 1.5), 'initial barIndex != 0');
        expectThrow(() => stepDTFXStrictCBC({ ...fullStream[0], time: t0 + 1000 }, 0, s0, cfg, false, 1.5), 'off-grid timestamp');

        const s1 = stepDTFXStrictCBC(fullStream[0], 0, s0, cfg, false, 1.5).nextState;
        expectThrow(() => stepDTFXStrictCBC(fullStream[0], 1, s1, cfg, false, 1.5), 'duplicate timestamp');
        expectThrow(() => stepDTFXStrictCBC({ ...fullStream[0], time: t0 - 60_000 }, 1, s1, cfg, false, 1.5), 'out-of-order timestamp');
        expectThrow(() => stepDTFXStrictCBC(fullStream[1], 2, s1, cfg, false, 1.5), 'skipped barIndex');
    });

    // 7. Retest & Wick-vs-Close Invalidation Contract
    runTest('7. Retest Exit-Before-Retest & Wick-vs-Close Invalidation Contract', () => {
        const cfg = createDefaultDTFXStrictCBCConfig('SOLUSDT', '1m', 60_000, '1m');
        let state = createInitialDTFXStrictCBCState();
        const synthetic: ML1Candle[] = [
            { time: t0 + 0 * interval, open: 100, high: 102, low: 99, close: 101, volume: 100 },
            { time: t0 + 1 * interval, open: 101, high: 105, low: 100, close: 104, volume: 100 },
            { time: t0 + 2 * interval, open: 104, high: 104.5, low: 98, close: 98.5, volume: 100 },
            { time: t0 + 3 * interval, open: 98.5, high: 106, low: 98, close: 105.5, volume: 100 },
            { time: t0 + 4 * interval, open: 105.5, high: 106, low: 103, close: 105.2, volume: 100 },
            { time: t0 + 5 * interval, open: 105.2, high: 105.5, low: 102, close: 104, volume: 100 },
            { time: t0 + 6 * interval, open: 105.3, high: 106, low: 105.2, close: 105.8, volume: 100 },
            { time: t0 + 7 * interval, open: 105.8, high: 106, low: 97.5, close: 98.5, volume: 100 },
            { time: t0 + 8 * interval, open: 105.5, high: 106, low: 105.4, close: 105.6, volume: 100 },
            { time: t0 + 9 * interval, open: 105.6, high: 105.8, low: 97.0, close: 97.5, volume: 100 },
            { time: t0 + 10 * interval, open: 105.3, high: 106, low: 105.2, close: 105.5, volume: 100 },
            { time: t0 + 11 * interval, open: 105.5, high: 106, low: 102, close: 104, volume: 100 }
        ];
        const evs: DTFXStrictCBCTeacherEvent[] = [];
        for (let i = 0; i < synthetic.length; i++) {
            const r = stepDTFXStrictCBC(synthetic[i], i, state, cfg, false, 2.0);
            state = r.nextState;
            evs.push(...r.events);
        }
        const retests = evs.filter(e => e.eventType === 'DTFX_CBC_DEMAND_RETEST');
        assert(
            retests.length === 2 &&
            retests[0].confirmationBarIndex === 4 &&
            retests[1].confirmationBarIndex === 7,
            `Expected 2 demand retests at bars [4, 7], got ${retests.map(r => r.confirmationBarIndex).join(',')}`
        );
    });

    // 8. Multi-TF Isolation + Partition/Restart-Invariant Event Discriminators
    runTest('8. Multi-TF Coordinator Isolation & Partition-Invariant Discriminators', () => {
        const tfs: DTFXStrictCBCTimeframe[] = ['1m', '3m', '5m', '15m'];
        const cfgs = createDefaultDTFXStrictCBCMultiConfigs('SOLUSDT', '1m', interval, tfs);
        let mState = createInitialDTFXStrictCBCMultiState();
        const collected: DTFXStrictCBCTeacherEvent[] = [];

        for (let i = 0; i < fullStream.length; i++) {
            const res = stepDTFXStrictCBCMulti(fullStream[i], i, mState, cfgs, false, 1.5);
            mState = res.nextState;
            collected.push(...res.events);
        }

        const single15 = runSingleTf(fullStream, '15m').events;
        const multi15 = collected.filter(e => e.zoneTimeframe === '15m');
        assert(JSON.stringify(multi15) === JSON.stringify(single15), '15m in multi-TF must match single-TF 15m identically');

        const seenKeys = new Set<string>();
        for (const ev of collected) {
            const key = `${ev.confirmationBarIndex}|${ev.eventType}|${ev.eventDiscriminator}`;
            assert(!seenKeys.has(key), `Duplicate event key: ${key}`);
            seenKeys.add(key);
        }

        // Cross-symbol namespace uniqueness (SOLUSDT vs BTCUSDT on identical timestamps)
        const cfgBtc = createDefaultDTFXStrictCBCConfig('BTCUSDT', '1m', interval, '15m');
        let btcState = createInitialDTFXStrictCBCState();
        const btcEvents: DTFXStrictCBCTeacherEvent[] = [];
        for (let i = 0; i < fullStream.length; i++) {
            const r = stepDTFXStrictCBC(fullStream[i], i, btcState, cfgBtc, false, 1.5);
            btcState = r.nextState;
            btcEvents.push(...r.events);
        }
        const solDiscs = new Set(single15.map(e => e.eventDiscriminator));
        for (const ev of btcEvents) {
            assert(ev.eventDiscriminator.startsWith('BTCUSDT:1m:15m:'), `Expected symbol+baseTF prefix in ${ev.eventDiscriminator}`);
            assert(!solDiscs.has(ev.eventDiscriminator), `Cross-symbol discriminator collision: ${ev.eventDiscriminator}`);
        }

        // Checkpoint-resume identity parity: resume immediately after first CREATED event and compare subsequent events
        const cfg15 = createDefaultDTFXStrictCBCConfig('SOLUSDT', '1m', interval, '15m');
        let uninterruptedState = createInitialDTFXStrictCBCState();
        let checkpointState: ReturnType<typeof createInitialDTFXStrictCBCState> | null = null;
        let checkpointBar = -1;
        const uninterruptedPostCheckpoint: DTFXStrictCBCTeacherEvent[] = [];

        for (let i = 0; i < fullStream.length; i++) {
            const r = stepDTFXStrictCBC(fullStream[i], i, uninterruptedState, cfg15, false, 1.5);
            uninterruptedState = r.nextState;
            if (checkpointState !== null) {
                uninterruptedPostCheckpoint.push(...r.events);
            } else if (r.events.some(e => e.structuralContext.zoneStatus === 'CREATED')) {
                checkpointState = JSON.parse(JSON.stringify(uninterruptedState));
                checkpointBar = i;
            }
        }
        assert(checkpointState !== null && checkpointBar >= 0, 'Expected a 15m CREATED event for checkpoint test');

        let resumedState = checkpointState!;
        const resumedEvents: DTFXStrictCBCTeacherEvent[] = [];
        for (let i = checkpointBar + 1; i < fullStream.length; i++) {
            const r = stepDTFXStrictCBC(fullStream[i], i, resumedState, cfg15, false, 1.5);
            resumedState = r.nextState;
            resumedEvents.push(...r.events);
        }
        assert(
            resumedEvents.length === uninterruptedPostCheckpoint.length && resumedEvents.length > 0,
            `Resumed event count (${resumedEvents.length}) != uninterrupted (${uninterruptedPostCheckpoint.length})`
        );
        for (let i = 0; i < resumedEvents.length; i++) {
            const a = resumedEvents[i];
            const b = uninterruptedPostCheckpoint[i];
            assert(
                a.eventDiscriminator === b.eventDiscriminator &&
                a.eventType === b.eventType &&
                a.sourceTimestamp === b.sourceTimestamp &&
                a.confirmationTimestamp === b.confirmationTimestamp,
                `Checkpoint-resume identity mismatch at index ${i}`
            );
        }
    });

    // 9. Comprehensive Pivot & Zone Parity vs Chart Indicator Across 1m, 3m, 5m, 15m (Equal Highs + Same-Bar Reversal Extreme)
    runTest('9. Full Pivot & Zone Parity Against Chart DTFXStrictCBCIndicator Across 1m, 3m, 5m, 15m', () => {
        const edgeStream = makeTestStream(450, t0, interval);
        // Case A: Equal-high plateau
        edgeStream[46] = { ...edgeStream[46], high: edgeStream[45].high };

        // Case B: Constructed same-bar reversal-extreme candle aligned to an HTF close (bar 149 closes 3m, 5m, and 15m simultaneously!)
        // Push bar 149 high sharply above prior phase high while closing strongly below prior anchorLow
        const prevLow = Math.min(edgeStream[145].low, edgeStream[146].low, edgeStream[147].low, edgeStream[148].low);
        const peakHigh = Math.max(...edgeStream.slice(120, 149).map(c => c.high)) + 15.0;
        const revClose = Math.max(20, prevLow - 10.0);
        edgeStream[149] = {
            ...edgeStream[149],
            open: peakHigh - 1.0,
            high: peakHigh,
            low: revClose - 0.5,
            close: revClose
        };

        for (const tf of ['1m', '3m', '5m', '15m'] as const) {
            const ds = new DataStore(edgeStream.length);
            const flat = new Float64Array(edgeStream.length * 6);
            edgeStream.forEach((c, idx) => flat.set([c.time, c.open, c.high, c.low, c.close, c.volume], idx * 6));
            ds.setFromBuffer(flat);

            const ind = new DTFXStrictCBCIndicator();
            ind.updateParams({
                timeframe: tf === '1m' ? 'Current' : tf,
                dispAll: true,
                noOverlap: false,
                zoneFilter: 'Both'
            });
            ind.calculate(ds);

            const teacherRes = runSingleTf(edgeStream, tf);
            const teacherCreated = teacherRes.events.filter(e => e.structuralContext.zoneStatus === 'CREATED');

            // 9a. Full Pivot Sequence Parity (price, type, label, time, barIndex, confirmedBarIndex)
            assert(
                ind.cachedPivots.length === teacherRes.pivots.length && teacherRes.pivots.length > 0,
                `${tf} pivot count mismatch: chart=${ind.cachedPivots.length}, teacher=${teacherRes.pivots.length}`
            );
            for (let i = 0; i < teacherRes.pivots.length; i++) {
                const cp = ind.cachedPivots[i];
                const tp = teacherRes.pivots[i];
                assert(
                    cp.type === tp.type &&
                    cp.label === tp.label &&
                    cp.barIndex === tp.barIndex &&
                    cp.time === tp.time &&
                    cp.confirmedBarIndex === tp.confirmedBarIndex &&
                    Math.abs(cp.price - tp.price) < 1e-9,
                    `${tf} pivot ${i} mismatch: chart=${JSON.stringify(cp)} vs teacher=${JSON.stringify(tp)}`
                );
            }

            // 9b. Full Zone Parity (direction, sourceBar, confirmationBar, top, bottom)
            assert(
                ind.cachedZones.length === teacherCreated.length && teacherCreated.length > 0,
                `${tf} zone count mismatch: chart=${ind.cachedZones.length}, teacher=${teacherCreated.length}`
            );
            for (let i = 0; i < teacherCreated.length; i++) {
                const cz = ind.cachedZones[i];
                const tz = teacherCreated[i];
                const chartDir = cz.direction === 1 ? 'bull' : 'bear';
                assert(
                    chartDir === tz.eventDirection &&
                    cz.leftBar === tz.sourceBarIndex &&
                    cz.rightBar === tz.confirmationBarIndex &&
                    Math.abs(cz.top - tz.structuralContext.zoneTop) < 1e-9 &&
                    Math.abs(cz.bottom - tz.structuralContext.zoneBot) < 1e-9,
                    `${tf} zone ${i} mismatch between chart indicator and causal teacher`
                );
            }

            // Verify CHoCH vs BOS structural flags are both exercised across the test stream
            assert(
                teacherCreated.some(e => e.structuralContext.isChoch) &&
                teacherCreated.some(e => !e.structuralContext.isChoch),
                `${tf}: expected both CHoCH and BOS zone creations`
            );
        }
    });

    console.log(`\nStep 2 Audit Suite: ${passed} passed, ${failed} failed.\n`);
    return failed === 0;
}

const isDirectRun = typeof process !== 'undefined' && process.argv && process.argv[1]?.includes('dtfx-strictcbc-causality-test');
if (isDirectRun) {
    const success = runDTFXStrictCBCCausalityTests();
    process.exit(success ? 0 : 1);
}
