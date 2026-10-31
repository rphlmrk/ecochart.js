// src/test/milestone1-acceptance.ts
import { DataStore } from '../data/DataStore';
import {
    StrictCBCZigZagIndicator,
    stepStrictCBC,
    createInitialStrictCBCState,
    type StrictZigZagPivot,
    type StrictCBCCandleTeacher
} from '../indicators/plugins/StrictCBCZigZagIndicator';

/**
 * Hard assertion helper: throws immediately on failure
 */
function assert(condition: boolean, message: string): asserts condition {
    if (!condition) {
        throw new Error(`[AssertionFailed] ${message}`);
    }
}

/**
 * Fast, seedable Mulberry32 PRNG for 100% reproducible test datasets
 */
class SeededRNG {
    private s: number;
    constructor(seed = 42) {
        this.s = seed;
    }
    next(): number {
        let t = (this.s += 0x6d2b79f5);
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }
}

function generateDeterministicDataset(count: number, seed = 42): DataStore {
    const ds = new DataStore(count);
    const rng = new SeededRNG(seed);
    let price = 50000;
    let time = 1700000000000;

    for (let i = 0; i < count; i++) {
        const delta = Math.sin(i / 15) * 40 + (rng.next() - 0.495) * 50;
        const open = price;
        const close = open + delta;
        const high = Math.max(open, close) + rng.next() * 20;
        const low = Math.min(open, close) - rng.next() * 20;
        const vol = 10 + rng.next() * 50;

        ds.appendOrUpdate(time, open, high, low, close, vol);
        price = close;
        time += 60000;
    }
    return ds;
}

/**
 * Frozen reference implementation of the pre-refactor state machine.
 * Used exclusively for legacy parity verification.
 */
function legacyReferenceStrictCBC(ds: DataStore): StrictZigZagPivot[] {
    const len = ds.length;
    const data = ds.data;
    const pivots: StrictZigZagPivot[] = [];
    if (len === 0) return pivots;

    let nextPivotId = 1;
    let anchorHigh = data[2];
    let anchorLow = data[3];
    let isBullish = true;

    let phaseHigh = data[2];
    let phaseHighIdx = 0;
    let phaseLow = data[3];
    let phaseLowIdx = 0;

    let lastHighPrice: number | null = null;
    let lastLowPrice: number | null = null;

    for (let i = 0; i < len; i++) {
        const base = i * 6;
        const o = data[base + 1];
        const h = data[base + 2];
        const l = data[base + 3];
        const c = data[base + 4];

        const isBuy = c > o;
        const isSell = c < o;

        const bearishFlip = isBullish && isSell && c < anchorLow;
        const bullishFlip = !isBullish && isBuy && c > anchorHigh;

        if (isBullish) {
            if (h > phaseHigh) {
                phaseHigh = h;
                phaseHighIdx = i;
            }
        } else {
            if (l < phaseLow) {
                phaseLow = l;
                phaseLowIdx = i;
            }
        }

        if (bearishFlip) {
            isBullish = false;
            const label: 'HH' | 'LH' = lastHighPrice === null || phaseHigh >= lastHighPrice ? 'HH' : 'LH';
            lastHighPrice = phaseHigh;

            pivots.push({
                id: nextPivotId++,
                barIndex: phaseHighIdx,
                time: data[phaseHighIdx * 6],
                price: phaseHigh,
                type: 'high',
                label,
                confirmedBarIndex: i
            });
            phaseLow = l;
            phaseLowIdx = i;
        }

        if (bullishFlip) {
            isBullish = true;
            const label: 'LL' | 'HL' = lastLowPrice === null || phaseLow <= lastLowPrice ? 'LL' : 'HL';
            lastLowPrice = phaseLow;

            pivots.push({
                id: nextPivotId++,
                barIndex: phaseLowIdx,
                time: data[phaseLowIdx * 6],
                price: phaseLow,
                type: 'low',
                label,
                confirmedBarIndex: i
            });
            phaseHigh = h;
            phaseHighIdx = i;
        }

        const validContinuation = (isBullish && c > anchorHigh) || (!isBullish && c < anchorLow);
        if (validContinuation || bearishFlip || bullishFlip) {
            anchorHigh = h;
            anchorLow = l;
        }
    }

    return pivots;
}

export function runMilestone1AcceptanceSuite(): boolean {
    console.log('🧪 Starting Milestone 1 Acceptance Suite...');
    const N = 50000;
    const ds = generateDeterministicDataset(N, 1337);

    // Verify pure single-step contract & typing
    const sampleCandle = { time: 0, open: 10, high: 12, low: 9, close: 11 };
    const sampleStep = stepStrictCBC(sampleCandle, 0, createInitialStrictCBCState(sampleCandle));
    const _typeCheckTeacher: StrictCBCCandleTeacher = sampleStep.teacher;
    assert(_typeCheckTeacher.trend === 1, 'stepStrictCBC contract valid');

    // -----------------------------------------------------------------
    // TEST 1: Buffer Capacity Check for BOTH calculate() and update()
    // -----------------------------------------------------------------
    console.log('  -> Running Test 1: Buffer Capacity & Allocation...');
    const indCalc = new StrictCBCZigZagIndicator();
    indCalc.calculate(ds);

    const assertBuffers = (ind: StrictCBCZigZagIndicator, label: string) => {
        assert(ind.pivotTypes.length >= N, `${label}: pivotTypes truncated (${ind.pivotTypes.length} < ${N})`);
        assert(ind.pivotPrices.length >= N, `${label}: pivotPrices truncated`);
        assert(ind.trends.length >= N, `${label}: trends truncated`);
        assert(ind.candidateTypes.length >= N, `${label}: candidateTypes truncated`);
        assert(ind.candidatePrices.length >= N, `${label}: candidatePrices truncated`);
        assert(ind.candidateBarIndices.length >= N, `${label}: candidateBarIndices truncated`);
        assert(ind.candidateAges.length >= N, `${label}: candidateAges truncated`);
        assert(ind.anchorHighs.length >= N, `${label}: anchorHighs truncated`);
        assert(ind.anchorLows.length >= N, `${label}: anchorLows truncated`);
        assert(ind.confirmedEvents.length >= N, `${label}: confirmedEvents truncated`);
        assert(ind.confirmedPrices.length >= N, `${label}: confirmedPrices truncated`);
        assert(ind.confirmedLags.length >= N, `${label}: confirmedLags truncated`);
    };

    assertBuffers(indCalc, 'calculate() path');

    const indUpdate = new StrictCBCZigZagIndicator();
    indUpdate.update(ds, true);
    assertBuffers(indUpdate, 'update() path');

    console.log('  ✅ Test 1 Passed: All 12 telemetry buffers resized past 50,000 candles.');

    // -----------------------------------------------------------------
    // TEST 2: Exact Legacy Parity Verification
    // -----------------------------------------------------------------
    console.log('  -> Running Test 2: Legacy Reference Parity (50,000 candles)...');
    const legacyPivots = legacyReferenceStrictCBC(ds);
    const { pivots: refactoredPivots, teachers } = StrictCBCZigZagIndicator.extractPointInTimeTeacher(ds);

    assert(
        legacyPivots.length === refactoredPivots.length,
        `Pivot count mismatch: Legacy=${legacyPivots.length}, Refactored=${refactoredPivots.length}`
    );

    for (let i = 0; i < legacyPivots.length; i++) {
        const leg = legacyPivots[i];
        const ref = refactoredPivots[i];

        assert(leg.id === ref.id, `Pivot #${i} ID mismatch: ${leg.id} vs ${ref.id}`);
        assert(leg.price === ref.price, `Pivot #${i} Price mismatch at bar ${leg.barIndex}`);
        assert(leg.barIndex === ref.barIndex, `Pivot #${i} BarIndex mismatch`);
        assert(leg.type === ref.type, `Pivot #${i} Type mismatch`);
        assert(leg.label === ref.label, `Pivot #${i} Label mismatch`);
        assert(leg.confirmedBarIndex === ref.confirmedBarIndex, `Pivot #${i} ConfirmedBarIndex mismatch`);
    }

    console.log(`  ✅ Test 2 Passed: 100% exact match against frozen legacy code across ${legacyPivots.length} pivots.`);

    // -----------------------------------------------------------------
    // TEST 3: Candidate Point-in-Time Integrity
    // -----------------------------------------------------------------
    console.log('  -> Running Test 3: Candidate Extrema Point-in-Time Integrity...');
    let runningMaxHigh = -Infinity;
    let runningMinLow = Infinity;

    for (let i = 0; i < N; i++) {
        const h = ds.data[i * 6 + 2];
        const l = ds.data[i * 6 + 3];
        if (h > runningMaxHigh) runningMaxHigh = h;
        if (l < runningMinLow) runningMinLow = l;

        const t = teachers[i];
        assert(t.candidateBarIndex <= i, `Bar ${i}: candidateBarIndex (${t.candidateBarIndex}) is in the future!`);
        assert(t.candidateAgeBars === i - t.candidateBarIndex, `Bar ${i}: candidateAgeBars arithmetic corrupted`);

        const recordedCandleH = ds.data[t.candidateBarIndex * 6 + 2];
        const recordedCandleL = ds.data[t.candidateBarIndex * 6 + 3];

        if (t.candidateType === 'high') {
            assert(t.candidatePrice === recordedCandleH, `Bar ${i}: candidatePrice != high of recorded candidate bar`);
            assert(t.candidatePrice <= runningMaxHigh, `Bar ${i}: candidatePrice exceeded running max high`);
        } else {
            assert(t.candidatePrice === recordedCandleL, `Bar ${i}: candidatePrice != low of recorded candidate bar`);
            assert(t.candidatePrice >= runningMinLow, `Bar ${i}: candidatePrice dropped below running min low`);
        }
    }

    console.log('  ✅ Test 3 Passed: Zero candidate repainting or lookahead across all 50,000 candles.');

    // -----------------------------------------------------------------
    // TEST 4: Confirmation Lag Verification
    // -----------------------------------------------------------------
    console.log('  -> Running Test 4: Confirmation Lag & Stamping...');
    for (const p of refactoredPivots) {
        const expectedLag = p.confirmedBarIndex - p.barIndex;
        assert(expectedLag >= 0, `Negative lag detected at pivot ID ${p.id}`);

        const confirmationTeacher = teachers[p.confirmedBarIndex];
        assert(confirmationTeacher.confirmedPivotEvent !== 0, `No confirmation event recorded on bar ${p.confirmedBarIndex}`);
        assert(confirmationTeacher.confirmedPivotId === p.id, `Pivot ID mismatch on confirmation bar ${p.confirmedBarIndex}`);
        assert(confirmationTeacher.confirmedPivotBarIndex === p.barIndex, `Pivot barIndex mismatch on bar ${p.confirmedBarIndex}`);
        assert(confirmationTeacher.confirmedPivotConfirmedBarIndex === p.confirmedBarIndex, `ConfirmedBarIndex mismatch`);
        assert(confirmationTeacher.confirmedPivotLagBars === expectedLag, `Lag mismatch on bar ${p.confirmedBarIndex}`);
    }

    console.log('  ✅ Test 4 Passed: Confirmation events and lag arithmetic verified for all pivots.');

    // -----------------------------------------------------------------
    // TEST 5: Full Teacher Prefix Invariance (1,000 rows against 50k run)
    // -----------------------------------------------------------------
    console.log('  -> Running Test 5: Full 16-Field Prefix Invariance...');
    const prefixDs = new DataStore(1000);
    for (let i = 0; i < 1000; i++) {
        const b = i * 6;
        prefixDs.appendOrUpdate(ds.data[b], ds.data[b + 1], ds.data[b + 2], ds.data[b + 3], ds.data[b + 4], ds.data[b + 5]);
    }

    const { teachers: prefixTeachers } = StrictCBCZigZagIndicator.extractPointInTimeTeacher(prefixDs);

    for (let i = 0; i < 1000; i++) {
        const a = prefixTeachers[i];
        const b = teachers[i];

        assert(a.barIndex === b.barIndex, `Row ${i}: barIndex mismatch`);
        assert(a.timestamp === b.timestamp, `Row ${i}: timestamp mismatch`);
        assert(a.trend === b.trend, `Row ${i}: trend mismatch`);
        assert(a.anchorHigh === b.anchorHigh, `Row ${i}: anchorHigh mismatch`);
        assert(a.anchorLow === b.anchorLow, `Row ${i}: anchorLow mismatch`);
        assert(a.candidateType === b.candidateType, `Row ${i}: candidateType mismatch`);
        assert(a.candidatePrice === b.candidatePrice, `Row ${i}: candidatePrice mismatch`);
        assert(a.candidateBarIndex === b.candidateBarIndex, `Row ${i}: candidateBarIndex mismatch`);
        assert(a.candidateAgeBars === b.candidateAgeBars, `Row ${i}: candidateAgeBars mismatch`);
        assert(a.confirmedPivotEvent === b.confirmedPivotEvent, `Row ${i}: confirmedPivotEvent mismatch`);
        assert(a.confirmedPivotId === b.confirmedPivotId, `Row ${i}: confirmedPivotId mismatch`);
        assert(a.confirmedPivotPrice === b.confirmedPivotPrice, `Row ${i}: confirmedPivotPrice mismatch`);
        assert(a.confirmedPivotBarIndex === b.confirmedPivotBarIndex, `Row ${i}: confirmedPivotBarIndex mismatch`);
        assert(a.confirmedPivotConfirmedBarIndex === b.confirmedPivotConfirmedBarIndex, `Row ${i}: confirmedPivotConfirmedBarIndex mismatch`);
        assert(a.confirmedPivotLabel === b.confirmedPivotLabel, `Row ${i}: confirmedPivotLabel mismatch`);
        assert(a.confirmedPivotLagBars === b.confirmedPivotLagBars, `Row ${i}: confirmedPivotLagBars mismatch`);
    }

    console.log('  ✅ Test 5 Passed: Full 16-field teacher prefix invariance established.');

    // -----------------------------------------------------------------
    // TEST 6: Deterministic Event Delivery & De-duplication (Issue 1)
    // -----------------------------------------------------------------
    console.log('  -> Running Test 6: Deterministic Event Delivery & Cache Invalidation...');
    const deterministicDs = new DataStore(5);
    const t0 = 1700000000000;

    // Bar 0: Bullish start. Anchor: [95, 105]
    deterministicDs.appendOrUpdate(t0, 100, 105, 95, 103, 10);
    // Bar 1: Continuation. Higher high. Anchor: [100, 112]. phaseHigh = 112 @ bar 1
    deterministicDs.appendOrUpdate(t0 + 60000, 103, 112, 100, 110, 10);
    // Bar 2: Bearish flip candle! Close 94 < anchorLow 100. Confirms Swing High at bar 1!
    deterministicDs.appendOrUpdate(t0 + 120000, 105, 106, 92, 94, 20);

    const tracker = { count: 0, lastEmittedDetail: null as any };
    const alertListener = (e: any) => {
        tracker.count++;
        tracker.lastEmittedDetail = e.detail;
    };
    window.addEventListener('ecochart-alert', alertListener);

    try {
        const testInd = new StrictCBCZigZagIndicator();

        // 1. Unclosed tick on Bar 2
        testInd.update(deterministicDs, false);
        assert(Boolean(tracker.count === 0), `Event dispatched prematurely on unclosed bar! count=${tracker.count}`);

        // 2. Closed tick on Bar 2 with identical OHLC
        testInd.update(deterministicDs, true);
        assert(Boolean(tracker.count === 1), `Closed tick failed to emit event! count=${tracker.count}`);
        assert(tracker.lastEmittedDetail.title.includes('Swing High'), `Event detail title mismatch`);

        // 3. Repeated closed tick with identical OHLC (must de-duplicate via notifiedPivots)
        testInd.update(deterministicDs, true);
        assert(Boolean(tracker.count === 1), `Duplicate event emitted on repeated closed tick! count=${tracker.count}`);
    } finally {
        window.removeEventListener('ecochart-alert', alertListener);
    }

    console.log('  ✅ Test 6 Passed: Deterministic open-to-closed transition delivers exactly 1 event with zero duplicates.');

    console.log('\n======================================================');
    console.log('🏆 ALL MILESTONE 1 ACCEPTANCE CRITERIA RIGOROUSLY MET');
    console.log('======================================================\n');
    return true;
}