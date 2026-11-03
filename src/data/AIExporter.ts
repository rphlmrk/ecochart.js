// =========================================================================
// 🔒 FROZEN RESEARCH CONTRACT: EXPLICIT FEATURE / OUTCOME SEPARATION
// =========================================================================
import type { SourceBackboneAcceptedRow } from '../indicators/mlr1/dataset/ObservationBackbone';
import type { ExportAccounting } from '../indicators/mlr1/dataset/DatasetManifest';
import type { StrictZigZagPivot } from '../indicators/plugins/StrictCBCZigZagIndicator';
import { DataStore } from './DataStore';
import { ML1_CONFIG_B, ML1_CONFIG_B_VERSION } from '../indicators/mlr1/ML1FeatureConfigs';
import {
    createInitialML1FeatureState,
    stepML1Features,
    validateML1Config
} from '../indicators/mlr1/ML1FeatureEngine';
import {
    buildSourceBackbone,
    createDatasetManifest,
    evaluateAcceptance,
    extractDataQuality,
    validateCandleOhlcv
} from '../indicators/mlr1/dataset/ObservationBackbone';
import {
    STRICT_CBC_ZIGZAG_TEACHER_VERSION,
    StrictCBCZigZagIndicator
} from '../indicators/plugins/StrictCBCZigZagIndicator';

export const MLR1_OUTCOME_CONFIG_VERSION = 'MLR1_v2';

export const MLR1_REPRESENTATION_FEATURE_ALLOWLIST = [
    'pivot_type',
    'pivot_label',
    'completed_leg_direction',
    'zigzag_next_leg_orientation',
    'bars_since_last_pivot',
    'leg_distance_atr',
    'context_net_return_atr',
    'context_max_favorable_atr',
    'context_max_adverse_atr',
    'context_candle_count',
    'context_relative_volume',
    'context_relative_volume_valid_fraction'
] as const;

export type MLR1RepresentationFeature = typeof MLR1_REPRESENTATION_FEATURE_ALLOWLIST[number];

/**
 * 🔒 STRICT PROJECTION: This allowlist is the sole model-input projection.
 * The combined event CSV is archival/label output and must not be used as input.
 */
export function buildRepresentationInput(ev: MLR1EventRow): Record<MLR1RepresentationFeature, string | number> {
    const input = {} as Record<MLR1RepresentationFeature, string | number>;
    for (const key of MLR1_REPRESENTATION_FEATURE_ALLOWLIST) {
        input[key] = ev[key];
    }
    return input;
}

export const MLR1_OUTCOME_LABEL_ALLOWLIST = [
    'entry_bar_index',
    'entry_time',
    'entry_price',
    'atr_at_confirmation',
    'long_stop_price',
    'long_target_price',
    'long_exit_price',
    'long_net_r',
    'long_outcome',
    'short_stop_price',
    'short_target_price',
    'short_exit_price',
    'short_net_r',
    'short_outcome'
] as const;

export interface MLR1EventRow {
    event_id: string;
    symbol: string;
    timeframe: string;
    pivot_type: 'high' | 'low';
    pivot_label: string;
    pivot_price: number;
    previous_pivot_price: number;                          // Retained for independent leg verification
    previous_pivot_bar_index: number;
    previous_pivot_confirmed_bar_index: number;
    previous_pivot_confirmation_time_ms: number;
    previous_pivot_type: 'high' | 'low';
    pivot_bar_index: number;
    pivot_time_ms: number;
    confirmed_bar_index: number;
    confirmation_time_ms: number;

    // Structural Features (Disambiguated Legs & Flat Handling)
    completed_leg_direction: 'up' | 'down' | 'flat';       // Verified vector from previous pivot -> current pivot
    zigzag_next_leg_orientation: 'up' | 'down';           // Structural alternating descriptor
    bars_since_last_pivot: number;
    leg_distance_atr: number;

    // Causal Candle Context
    context_net_return_atr: number;
    context_max_favorable_atr: number;
    context_max_adverse_atr: number;
    context_candle_count: number;
    context_relative_volume: number;                       // -1.0 sentinel when no mature volume SMA available
    context_relative_volume_valid_fraction: number;        // Fraction of context bars with mature volume SMA (0.0 to 1.0)
    
    // Execution (Frozen next_open)
    entry_bar_index: number;
    entry_time: number;
    entry_price: number;
    atr_at_confirmation: number;
    
    // Counterfactual 1: LONG (Cost-Adjusted Net Outcomes)
    long_stop_price: number;
    long_target_price: number;
    long_exit_price: number;
    long_net_r: number;
    long_outcome: 'full_target' | 'hard_stop' | 'timeout_net_gain' | 'timeout_net_loss';
    
    // Counterfactual 2: SHORT (Cost-Adjusted Net Outcomes)
    short_stop_price: number;
    short_target_price: number;
    short_exit_price: number;
    short_net_r: number;
    short_outcome: 'full_target' | 'hard_stop' | 'timeout_net_gain' | 'timeout_net_loss';
}

export class MarketFeatureEngine {
    public static calculateATRArray(dataStore: any, period: number = 14): Float64Array {
        const len = dataStore.length;
        const atr = new Float64Array(len);
        const tr = new Float64Array(len);
        if (len === 0) return atr;

        tr[0] = dataStore.data[2] - dataStore.data[3]; 
        for (let i = 1; i < len; i++) {
            const base = i * 6;
            const prevC = dataStore.data[(i - 1) * 6 + 4]; 
            const h = dataStore.data[base + 2];
            const l = dataStore.data[base + 3];
            tr[i] = Math.max(h - l, Math.abs(h - prevC), Math.abs(l - prevC));
        }

        let sum = 0;
        for (let i = 0; i < period && i < len; i++) {
            sum += tr[i];
        }
        if (len >= period) {
            atr[period - 1] = sum / period;
        }

        for (let i = period; i < len; i++) {
            atr[i] = (atr[i - 1] * (period - 1) + tr[i]) / period;
        }

        for (let i = 0; i < period - 1 && i < len; i++) {
            atr[i] = 0; 
        }
        return atr;
    }

    public static calculateVolumeSMA(dataStore: any, period: number = 20): { sma: Float64Array; validMask: Uint8Array } {
        const len = dataStore.length;
        const sma = new Float64Array(len).fill(0);
        const validMask = new Uint8Array(len).fill(0);
        if (len < period) return { sma, validMask };

        let sum = 0;
        for (let i = 0; i < period; i++) {
            sum += dataStore.data[i * 6 + 5];
        }
        sma[period - 1] = sum / period;
        validMask[period - 1] = 1;

        for (let i = period; i < len; i++) {
            sum += dataStore.data[i * 6 + 5] - dataStore.data[(i - period) * 6 + 5];
            sma[i] = sum / period;
            validMask[i] = 1;
        }
        return { sma, validMask };
    }
}

export class CandleContextAggregator {
    public static summarize(
        acceptedRows: readonly SourceBackboneAcceptedRow[],
        startBar: number, 
        endBar: number, 
        currentAtr: number
    ) {
        if (!Number.isFinite(currentAtr) || currentAtr <= 0) {
            throw new Error('CandleContextAggregator Error: currentAtr must be a positive finite number.');
        }
        if (!Array.isArray(acceptedRows)) {
            throw new Error('CandleContextAggregator Error: acceptedRows must be an array.');
        }
        if (!Number.isSafeInteger(startBar) || !Number.isSafeInteger(endBar) ||
            startBar > endBar || startBar < 0 || endBar >= acceptedRows.length) {
            throw new Error(
                `CandleContextAggregator Error: Invalid context window bounds [${startBar}, ${endBar}] ` +
                `across ${acceptedRows.length} rows.`
            );
        }

        const startRow = acceptedRows[startBar];
        const endRow = acceptedRows[endBar];
        if (!startRow?.candle || !endRow?.candle) {
            throw new Error('CandleContextAggregator Error: Context window contains a missing baseline candle.');
        }
        const startOpen = startRow.candle.open;
        const endClose = endRow.candle.close;
        if (!Number.isFinite(startOpen) || !Number.isFinite(endClose) || startOpen <= 0 || endClose <= 0) {
            throw new Error('CandleContextAggregator Error: Non-finite or non-positive baseline open/close.');
        }
        let maxH = -Infinity;
        let minL = Infinity;
        let matureCount = 0;
        let sumRelativeVolume = 0;

        for (let i = startBar; i <= endBar; i++) {
            const row = acceptedRows[i];
            if (!row?.candle || !row.observation?.features || !row.observation.validity) {
                throw new Error(`CandleContextAggregator Error: Accepted row ${i} is malformed.`);
            }
            const { open, high, low, close, volume } = row.candle;
            if (!Number.isFinite(open) || open <= 0 ||
                !Number.isFinite(high) || high <= 0 ||
                !Number.isFinite(low) || low <= 0 ||
                !Number.isFinite(close) || close <= 0 ||
                !Number.isFinite(volume) || volume < 0 ||
                high < Math.max(open, close) || low > Math.min(open, close) || high < low) {
                throw new Error(`CandleContextAggregator Error: Malformed OHLCV geometry in accepted row ${i}.`);
            }
            const candleHigh = row.candle.high;
            const candleLow = row.candle.low;
            if (candleHigh > maxH) maxH = candleHigh;
            if (candleLow < minL) minL = candleLow;

            const relativeVolume = row.observation.features['RelativeVolume_20'];
            const isValid = row.observation.validity['RelativeVolume_20'];
            if (typeof isValid !== 'boolean') {
                throw new Error(
                    `CandleContextAggregator Error: Non-boolean validity on RelativeVolume_20 at row ${i}.`
                );
            }
            if (isValid) {
                if (!Number.isFinite(relativeVolume) || relativeVolume < 0) {
                    throw new Error(
                        `CandleContextAggregator Error: RelativeVolume_20 marked valid but is invalid at row ${i}.`
                    );
                }
                matureCount++;
                sumRelativeVolume += relativeVolume;
            }
        }

        const count = endBar - startBar + 1;
        const netReturnAtr = (endClose - startOpen) / currentAtr;
        const maxFavorableAtr = (maxH - startOpen) / currentAtr;
        const maxAdverseAtr = (startOpen - minL) / currentAtr;
        const validFraction = count > 0 ? (matureCount / count) : 0.0;
        const relativeVolume = matureCount > 0 ? sumRelativeVolume / matureCount : -1.0;

        return {
            netReturnAtr,
            maxFavorableAtr,
            maxAdverseAtr,
            count,
            relativeVolume,
            validFraction
        };
    }
}

export class HybridTokenBuilder {
    public static build(
        event: StrictZigZagPivot,
        prevEvent: StrictZigZagPivot,
        acceptedRows: readonly SourceBackboneAcceptedRow[],
        currentAtr: number
    ) {
        if (!event || typeof event !== 'object' ||
            !prevEvent || typeof prevEvent !== 'object' ||
            !Array.isArray(acceptedRows) || acceptedRows.length === 0) {
            throw new Error('HybridTokenBuilder Error: pivot events and accepted rows are required.');
        }
        if (!Number.isFinite(currentAtr) || currentAtr <= 0) {
            throw new Error('HybridTokenBuilder Error: currentAtr must be a positive finite number.');
        }
        if (!['high', 'low'].includes(event.type) ||
            !['high', 'low'].includes(prevEvent.type) ||
            event.type === prevEvent.type) {
            throw new Error('HybridTokenBuilder Error: pivot types must be valid and alternate.');
        }
        const confBar = event.confirmedBarIndex;
        const prevConfBar = prevEvent.confirmedBarIndex;
        if (!Number.isSafeInteger(confBar) || !Number.isSafeInteger(prevConfBar) ||
            confBar < 0 || confBar >= acceptedRows.length ||
            prevConfBar < 0 || prevConfBar >= confBar) {
            throw new Error(
                `HybridTokenBuilder Error: invalid confirmed-bar indices: previous=${prevConfBar}, current=${confBar}.`
            );
        }
        if (!Number.isSafeInteger(event.barIndex) || !Number.isSafeInteger(prevEvent.barIndex) ||
            event.barIndex < 0 || event.barIndex > confBar ||
            prevEvent.barIndex < 0 || prevEvent.barIndex > prevConfBar ||
            event.barIndex <= prevEvent.barIndex) {
            throw new Error('HybridTokenBuilder Error: pivot indices must be valid and ordered before confirmation.');
        }
        if (!Number.isFinite(event.price) || event.price <= 0 ||
            !Number.isFinite(prevEvent.price) || prevEvent.price <= 0) {
            throw new Error('HybridTokenBuilder Error: pivot prices must be positive finite numbers.');
        }
        
        const barsSinceLast = confBar - prevConfBar;
        const legDistAtr = (event.price - prevEvent.price) / currentAtr;

        // Issue C Fix: Explicitly handle equal prices without fabricating 'down'
        const completed_leg_direction: 'up' | 'down' | 'flat' = 
            event.price > prevEvent.price ? 'up' : 
            event.price < prevEvent.price ? 'down' : 'flat';
            
        // Issue B Fix: Structural descriptor, not a directional forecast
        const zigzag_next_leg_orientation: 'up' | 'down' = event.type === 'high' ? 'down' : 'up';

        const contextStart = prevConfBar + 1;
        const contextEnd = confBar; 
        for (let index = contextStart; index <= contextEnd; index++) {
            const row = acceptedRows[index];
            const candle = row?.candle;
            if (!row || !candle || !row.observation ||
                !Number.isSafeInteger(row.sourceTimestamp) ||
                row.sourceTimestamp !== candle.time ||
                row.observation.timestamp !== row.sourceTimestamp ||
                !Number.isSafeInteger(row.observationTimestamp) ||
                row.observationTimestamp <= row.sourceTimestamp ||
                !Number.isFinite(candle.open) || candle.open <= 0 ||
                !Number.isFinite(candle.high) || candle.high <= 0 ||
                !Number.isFinite(candle.low) || candle.low <= 0 ||
                !Number.isFinite(candle.close) || candle.close <= 0 ||
                !Number.isFinite(candle.volume) || candle.volume < 0 ||
                candle.high < Math.max(candle.open, candle.close) ||
                candle.low > Math.min(candle.open, candle.close) ||
                candle.high < candle.low ||
                (index > contextStart && row.sourceTimestamp <= acceptedRows[index - 1].sourceTimestamp)) {
                throw new Error(`HybridTokenBuilder Error: accepted row ${index} is invalid or out of order.`);
            }
        }

        const ctx = CandleContextAggregator.summarize(acceptedRows, contextStart, contextEnd, currentAtr);

        return {
            completed_leg_direction,
            zigzag_next_leg_orientation,
            bars_since_last_pivot: barsSinceLast,
            leg_distance_atr: legDistAtr,
            context_net_return_atr: ctx.netReturnAtr,
            context_max_favorable_atr: ctx.maxFavorableAtr,
            context_max_adverse_atr: ctx.maxAdverseAtr,
            context_candle_count: ctx.count,
            context_relative_volume: ctx.relativeVolume,
            context_relative_volume_valid_fraction: ctx.validFraction
        };
    }
}

export class AIExporter {
    public static buildMLR1Dataset(
        dataStore: any,
        acceptedRows: readonly SourceBackboneAcceptedRow[],
        cachedPivots: any[],
        symbol: string,
        timeframe: string,
        expectedIntervalMs: number = 60000
    ): MLR1EventRow[] {
        // ==========================================
        // 🔒 FROZEN RESEARCH CONTRACT PARAMETERS
        // ==========================================
        const ATR_PERIOD = 14;
        const STOP_ATR_MULT = 1.5;
        const TARGET_R_MULT = 2.0;
        const MAX_HORIZON_BARS = 60; 
        const TRADE_COST_R = 0.05; 
        // ==========================================

        if (!dataStore || !dataStore.data) {
            throw new Error('AIExporter Error: dataStore with candle data is required.');
        }
        const len = dataStore.length;
        if (!Number.isSafeInteger(len) || len < 0 || dataStore.data.length < len * 6 ||
            !Number.isSafeInteger(expectedIntervalMs) || expectedIntervalMs <= 0 ||
            !Array.isArray(acceptedRows) || acceptedRows.length !== len ||
            !Array.isArray(cachedPivots)) {
            throw new Error(
                `AIExporter Error: valid dataStore, pivots, positive interval, and acceptedRows matching dataStore length (${len}) are required.`
            );
        }
        for (let i = 0; i < len; i++) {
            const base = i * 6;
            const candle = acceptedRows[i]?.candle;
            if (!acceptedRows[i] || !acceptedRows[i].candle || !acceptedRows[i].observation ||
                !acceptedRows[i].observation.features || !acceptedRows[i].observation.validity ||
                !candle ||
                candle.time !== dataStore.data[base] ||
                candle.open !== dataStore.data[base + 1] ||
                candle.high !== dataStore.data[base + 2] ||
                candle.low !== dataStore.data[base + 3] ||
                candle.close !== dataStore.data[base + 4] ||
                candle.volume !== dataStore.data[base + 5] ||
                acceptedRows[i].sourceTimestamp !== dataStore.data[base] ||
                acceptedRows[i].observation.timestamp !== dataStore.data[base] ||
                acceptedRows[i].observationTimestamp !== dataStore.data[base] + expectedIntervalMs ||
                acceptedRows[i].observation.sourceOpen !== candle.open ||
                acceptedRows[i].observation.sourceHigh !== candle.high ||
                acceptedRows[i].observation.sourceLow !== candle.low ||
                acceptedRows[i].observation.sourceClose !== candle.close ||
                acceptedRows[i].observation.sourceVolume !== candle.volume ||
                acceptedRows[i].observation.barIndex !== i) {
                throw new Error(`AIExporter Error: accepted row ${i} does not match the downstream dataStore timeline.`);
            }
        }

        for (let pivotIndex = 0; pivotIndex < cachedPivots.length; pivotIndex++) {
            const pivot = cachedPivots[pivotIndex];
            if (!pivot || typeof pivot !== 'object' ||
                (pivot.type !== 'high' && pivot.type !== 'low') ||
                typeof pivot.label !== 'string' || pivot.label.length === 0 ||
                !Number.isFinite(pivot.price) || pivot.price <= 0 ||
                !Number.isSafeInteger(pivot.barIndex) || pivot.barIndex < 0 || pivot.barIndex >= len ||
                !Number.isSafeInteger(pivot.confirmedBarIndex) ||
                pivot.confirmedBarIndex < 0 || pivot.confirmedBarIndex >= len ||
                pivot.barIndex > pivot.confirmedBarIndex) {
                throw new Error(`AIExporter Schema Error: Malformed pivot structure at index ${pivotIndex}.`);
            }
            const sourceRow = acceptedRows[pivot.barIndex];
            const expectedPrice = pivot.type === 'high' ? sourceRow.candle.high : sourceRow.candle.low;
            if (pivot.time !== sourceRow.sourceTimestamp ||
                Math.abs(pivot.price - expectedPrice) > 0.0001) {
                throw new Error(
                    `AIExporter Schema Error: Pivot ${pivotIndex} timestamp or price does not match its accepted source candle.`
                );
            }
            if (pivotIndex > 0 &&
                (pivot.type === cachedPivots[pivotIndex - 1].type ||
                    pivot.barIndex <= cachedPivots[pivotIndex - 1].barIndex ||
                    pivot.confirmedBarIndex <= cachedPivots[pivotIndex - 1].confirmedBarIndex)) {
                throw new Error(
                    `AIExporter Schema Error: Non-alternating or out-of-order pivot sequence at index ${pivotIndex}.`
                );
            }
        }
        const events: MLR1EventRow[] = [];

        const indVersion = `v2_ATR${ATR_PERIOD}_SL${STOP_ATR_MULT}_TP${TARGET_R_MULT}_HZ${MAX_HORIZON_BARS}`;
        
        const excludedIndexZero = cachedPivots.length > 0 ? 1 : 0;
        let excludedMissingNextOpen = 0;
        let excludedUnwarmedAtr = 0;
        let excludedIncompleteHorizon = 0;

        // Exclude index 0 (no completed leg, unbounded context)
        for (let i = 1; i < cachedPivots.length; i++) {
            const pivot = cachedPivots[i];
            const prevPivot = cachedPivots[i - 1];
            const confBar = pivot.confirmedBarIndex;
            if (!Number.isSafeInteger(confBar) || confBar < 0 || confBar >= len ||
                !Number.isSafeInteger(prevPivot.confirmedBarIndex) || prevPivot.confirmedBarIndex < 0 ||
                confBar <= prevPivot.confirmedBarIndex ||
                !Number.isSafeInteger(pivot.barIndex) || pivot.barIndex < 0 ||
                pivot.barIndex > confBar ||
                !Number.isSafeInteger(prevPivot.barIndex) || prevPivot.barIndex < 0 ||
                prevPivot.barIndex > prevPivot.confirmedBarIndex) {
                throw new Error(`AIExporter Error: pivot confirmation index ${confBar} is invalid or out of order.`);
            }
            if (pivot.time !== acceptedRows[pivot.barIndex].sourceTimestamp ||
                prevPivot.time !== acceptedRows[prevPivot.barIndex].sourceTimestamp) {
                throw new Error(`AIExporter Error: pivot timestamp does not match its accepted source candle at index ${pivot.barIndex}.`);
            }
            const entryBar = confBar + 1; // Strict rule: next_open

            if (entryBar >= len) {
                excludedMissingNextOpen++;
                continue;
            }

            // Use the authoritative Tier A ATR and its validity marker.
            const currentAtr = acceptedRows[confBar].observation.features['ATR_14'];
            const isAtrValid = acceptedRows[confBar].observation.validity['ATR_14'];
            if (isAtrValid !== true || !Number.isFinite(currentAtr) || currentAtr <= 0) {
                excludedUnwarmedAtr++;
                continue; 
            }

            // Exactly 60 bars inclusive [entryBar .. entryBar + 59]
            const horizonEnd = entryBar + MAX_HORIZON_BARS - 1;
            if (horizonEnd >= len) {
                excludedIncompleteHorizon++;
                continue; 
            }

            const entryTime = dataStore.data[entryBar * 6];
            const entryOpen = dataStore.data[entryBar * 6 + 1];

            // 1. Hybrid Token Construction
            const tokenFeatures = HybridTokenBuilder.build(pivot, prevPivot, acceptedRows, currentAtr);

            // 2. Counterfactual Simulation
            const lStop = entryOpen - (currentAtr * STOP_ATR_MULT);
            const lTarget = entryOpen + (currentAtr * STOP_ATR_MULT * TARGET_R_MULT);
            const lRisk = entryOpen - lStop;

            const sStop = entryOpen + (currentAtr * STOP_ATR_MULT);
            const sTarget = entryOpen - (currentAtr * STOP_ATR_MULT * TARGET_R_MULT);
            const sRisk = sStop - entryOpen;

            let lExitPrice = entryOpen, lOutcomeType: 'barrier' | 'timeout' = 'timeout', lOutcomeBarrier: any = 'hard_stop', lResolved = false;
            let sExitPrice = entryOpen, sOutcomeType: 'barrier' | 'timeout' = 'timeout', sOutcomeBarrier: any = 'hard_stop', sResolved = false;

            for (let f = entryBar; f <= horizonEnd; f++) {
                const base = f * 6;
                const fOpen = dataStore.data[base + 1];
                const fHigh = dataStore.data[base + 2];
                const fLow = dataStore.data[base + 3];
                const fClose = dataStore.data[base + 4];

                // LONG Counterfactual
                if (!lResolved) {
                    if (fOpen <= lStop) { lExitPrice = fOpen; lOutcomeBarrier = 'hard_stop'; lOutcomeType = 'barrier'; lResolved = true; }
                    else if (fOpen >= lTarget) { lExitPrice = fOpen; lOutcomeBarrier = 'full_target'; lOutcomeType = 'barrier'; lResolved = true; }
                    else {
                        const hitSL = fLow <= lStop;
                        const hitTP = fHigh >= lTarget;
                        if (hitSL && hitTP) { lExitPrice = lStop; lOutcomeBarrier = 'hard_stop'; lOutcomeType = 'barrier'; lResolved = true; } 
                        else if (hitSL) { lExitPrice = lStop; lOutcomeBarrier = 'hard_stop'; lOutcomeType = 'barrier'; lResolved = true; }
                        else if (hitTP) { lExitPrice = lTarget; lOutcomeBarrier = 'full_target'; lOutcomeType = 'barrier'; lResolved = true; }
                    }
                    if (!lResolved && f === horizonEnd) {
                        lExitPrice = fClose; 
                        lOutcomeType = 'timeout';
                        lResolved = true;
                    }
                }

                // SHORT Counterfactual
                if (!sResolved) {
                    if (fOpen >= sStop) { sExitPrice = fOpen; sOutcomeBarrier = 'hard_stop'; sOutcomeType = 'barrier'; sResolved = true; }
                    else if (fOpen <= sTarget) { sExitPrice = fOpen; sOutcomeBarrier = 'full_target'; sOutcomeType = 'barrier'; sResolved = true; }
                    else {
                        const hitSL = fHigh >= sStop;
                        const hitTP = fLow <= sTarget;
                        if (hitSL && hitTP) { sExitPrice = sStop; sOutcomeBarrier = 'hard_stop'; sOutcomeType = 'barrier'; sResolved = true; } 
                        else if (hitSL) { sExitPrice = sStop; sOutcomeBarrier = 'hard_stop'; sOutcomeType = 'barrier'; sResolved = true; }
                        else if (hitTP) { sExitPrice = sTarget; sOutcomeBarrier = 'full_target'; sOutcomeType = 'barrier'; sResolved = true; }
                    }
                    if (!sResolved && f === horizonEnd) {
                        sExitPrice = fClose; 
                        sOutcomeType = 'timeout';
                        sResolved = true;
                    }
                }
                if (lResolved && sResolved) break;
            }

            const lGrossR = (lExitPrice - entryOpen) / lRisk;
            const lNetR = Math.min(TARGET_R_MULT, lGrossR) - TRADE_COST_R;

            const sGrossR = (entryOpen - sExitPrice) / sRisk;
            const sNetR = Math.min(TARGET_R_MULT, sGrossR) - TRADE_COST_R;

            // Issue D Fix: Classify timeouts based on NET return after all trading costs
            const long_outcome: MLR1EventRow['long_outcome'] = lOutcomeType === 'barrier' 
                ? lOutcomeBarrier 
                : (lNetR > 0 ? 'timeout_net_gain' : 'timeout_net_loss');

            const short_outcome: MLR1EventRow['short_outcome'] = sOutcomeType === 'barrier' 
                ? sOutcomeBarrier 
                : (sNetR > 0 ? 'timeout_net_gain' : 'timeout_net_loss');

            // --- 3. ROW ASSEMBLY (Full Unrounded Precision: Eliminates Math Drift) ---
            events.push({
                event_id: `MLR1_${symbol}_${timeframe}_${indVersion}_${dataStore.data[confBar * 6]}_${pivot.time}_${pivot.type}`,
                symbol, timeframe,
                pivot_type: pivot.type,
                pivot_label: pivot.label,
                pivot_price: pivot.price,
                previous_pivot_price: prevPivot.price,
                previous_pivot_bar_index: prevPivot.barIndex,
                previous_pivot_confirmed_bar_index: prevPivot.confirmedBarIndex,
                previous_pivot_confirmation_time_ms: dataStore.data[prevPivot.confirmedBarIndex * 6],
                previous_pivot_type: prevPivot.type,
                pivot_bar_index: pivot.barIndex,
                pivot_time_ms: pivot.time,
                confirmed_bar_index: confBar,
                confirmation_time_ms: dataStore.data[confBar * 6],
                
                completed_leg_direction: tokenFeatures.completed_leg_direction,
                zigzag_next_leg_orientation: tokenFeatures.zigzag_next_leg_orientation,
                bars_since_last_pivot: tokenFeatures.bars_since_last_pivot,
                leg_distance_atr: tokenFeatures.leg_distance_atr,
                
                context_net_return_atr: tokenFeatures.context_net_return_atr,
                context_max_favorable_atr: tokenFeatures.context_max_favorable_atr,
                context_max_adverse_atr: tokenFeatures.context_max_adverse_atr,
                context_candle_count: tokenFeatures.context_candle_count,
                context_relative_volume: tokenFeatures.context_relative_volume,
                context_relative_volume_valid_fraction: tokenFeatures.context_relative_volume_valid_fraction,

                entry_bar_index: entryBar,
                entry_time: entryTime,
                entry_price: entryOpen,
                atr_at_confirmation: currentAtr,
                
                long_stop_price: lStop,
                long_target_price: lTarget,
                long_exit_price: lExitPrice,
                long_net_r: lNetR,
                long_outcome,

                short_stop_price: sStop,
                short_target_price: sTarget,
                short_exit_price: sExitPrice,
                short_net_r: sNetR,
                short_outcome
            });
        }

        // Strict Mathematical Reconciliation: Candidates = Excluded + Final
        const totalExcluded = excludedIndexZero + excludedMissingNextOpen + excludedUnwarmedAtr + excludedIncompleteHorizon;
        const totalAccounted = totalExcluded + events.length;
        const isReconciled = totalAccounted === cachedPivots.length;

        const datasetStartMs = len > 0 ? dataStore.data[0] : 0;
        const datasetEndMs = len > 0 ? dataStore.data[(len - 1) * 6] : 0;

        console.log(`=======================================`);
        console.log(`📊 ML-R1 DATASET GENERATION & ACCOUNTING RECONCILIATION:`);
        console.log(`   ↳ Source Candle Range:        ${new Date(datasetStartMs).toISOString()} → ${new Date(datasetEndMs).toISOString()}`);
        console.log(`   ↳ Total Candidate Pivots:     ${cachedPivots.length}`);
        console.log(`   ↳ Excluded (Index 0 / Unbnd): ${excludedIndexZero}`);
        console.log(`   ↳ Excluded (ATR Warm-up):     ${excludedUnwarmedAtr}`);
        console.log(`   ↳ Excluded (Missing Open):    ${excludedMissingNextOpen}`);
        console.log(`   ↳ Excluded (Incomplete HZ):   ${excludedIncompleteHorizon}`);
        console.log(`   ↳ Total Excluded:             ${totalExcluded}`);
        console.log(`   ↳ Final Eligible Events:      ${events.length}`);
        console.log(`   ↳ Reconciliation Check:       ${isReconciled ? '✅ 100% RECONCILED' : '❌ DISCREPANCY DETECTED'}`);
        if (events.length > 0) {
            console.log(`   ↳ Event Coverage Range:       ${new Date(events[0].confirmation_time_ms).toISOString()} → ${new Date(events[events.length - 1].confirmation_time_ms).toISOString()}`);
        }
        console.log(`=======================================`);

        return events;
    }

    private static csvEscape(value: unknown): string {
        if (value == null) return '';
        const raw = String(value);
        if (/[",\r\n]/.test(raw)) {
            return `"${raw.replace(/"/g, '""')}"`;
        }
        return raw;
    }

    public static exportMLR1CSV(events: MLR1EventRow[], symbol: string, timeframe: string): string | null {
        void symbol;
        void timeframe;
        if (events.length === 0) return null;

        // RFC-4180 Key-driven serialization: Never rely on Object.values() property order
        const keys = Object.keys(events[0]) as (keyof MLR1EventRow)[];
        const headers = keys.map(k => this.csvEscape(k)).join(',');

        const schemaKey = keys.join(',');
        const lines = events.map((event, rowIndex) => {
            if (Object.keys(event).join(',') !== schemaKey) {
                throw new Error(`CSV Schema Consistency Error: event row ${rowIndex} fields do not match header schema.`);
            }
            return keys.map(key => {
                const val = event[key];
                if (typeof val === 'number') {
                    if (!Number.isFinite(val)) {
                        throw new Error(`Non-finite numeric export value on key ${String(key)} in event row ${rowIndex}.`);
                    }
                    return String(val);
                }
                return this.csvEscape(val);
            }).join(',');
        });

        return [headers, ...lines].join('\r\n');
    }

    /**
     * Physical File Segregation: Exports ONLY the 12 representation features for Transformer input.
     * Guarantees zero outcome or execution metadata exists in the training file.
     */
    public static exportMLR1RepresentationCSV(events: MLR1EventRow[], symbol: string, timeframe: string): string | null {
        void symbol;
        void timeframe;
        if (events.length === 0) return null;

        const headers = MLR1_REPRESENTATION_FEATURE_ALLOWLIST.map(this.csvEscape).join(',');
        const lines = events.map(e => {
            const input = buildRepresentationInput(e);
            return MLR1_REPRESENTATION_FEATURE_ALLOWLIST.map(key => this.csvEscape(input[key])).join(',');
        });

        return [headers, ...lines].join('\r\n');
    }

    public static exportMLR1ContinuousObservationsCSV(
        acceptedRows: readonly SourceBackboneAcceptedRow[]
    ): string | null {
        if (acceptedRows.length === 0) return null;
        const firstRow = acceptedRows[0];
        if (!firstRow || !firstRow.observation ||
            !firstRow.observation.features || !firstRow.observation.validity) {
            throw new Error('Continuous Observation Schema Error: first row must include features and validity maps.');
        }

        const featureKeys = Object.keys(firstRow.observation.features).sort();
        const validityKeys = Object.keys(firstRow.observation.validity).sort();
        if (featureKeys.length !== validityKeys.length ||
            featureKeys.some((key, index) => key !== validityKeys[index])) {
            throw new Error('Continuous Observation Schema Error: feature and validity keys must match exactly.');
        }
        const observationIds = new Set<string>();
        const headerNames = [
            'observation_id',
            'source_timestamp',
            'observation_timestamp',
            'open',
            'high',
            'low',
            'close',
            'volume',
            ...featureKeys,
            ...featureKeys.map(key => `valid_${key}`)
        ];
        if (new Set(headerNames).size !== headerNames.length) {
            throw new Error('Continuous Observation Schema Error: generated CSV column names must be unique.');
        }
        const headers = headerNames.map(this.csvEscape).join(',');
        const lines = acceptedRows.map((row, index) => {
            if (!row || !row.observation || !row.observation.features ||
                !row.observation.validity || !row.candle) {
                throw new Error(`Continuous Observation Schema Error: row ${index} is incomplete.`);
            }
            const currentFeatureKeys = Object.keys(row.observation.features).sort();
            const currentValidityKeys = Object.keys(row.observation.validity).sort();
            if (currentFeatureKeys.length !== featureKeys.length ||
                currentFeatureKeys.some((key, keyIndex) => key !== featureKeys[keyIndex]) ||
                currentValidityKeys.length !== validityKeys.length ||
                currentValidityKeys.some((key, keyIndex) => key !== validityKeys[keyIndex])) {
                throw new Error(`Continuous Observation Schema Error: row ${index} feature or validity keys differ from the schema.`);
            }
            if (typeof row.observationId !== 'string' || row.observationId.trim().length === 0 ||
                observationIds.has(row.observationId) ||
                !Number.isSafeInteger(row.sourceTimestamp) ||
                !Number.isSafeInteger(row.observationTimestamp) ||
                row.sourceTimestamp < 0 ||
                row.observationTimestamp < 0 ||
                row.sourceTimestamp !== row.candle.time ||
                row.sourceTimestamp !== row.observation.timestamp ||
                row.observationTimestamp <= row.sourceTimestamp ||
                !Number.isSafeInteger(row.observation.barIndex) ||
                row.observation.barIndex < 0 ||
                (index > 0 && (
                    row.sourceTimestamp <= acceptedRows[index - 1].sourceTimestamp ||
                    row.observationTimestamp <= acceptedRows[index - 1].observationTimestamp
                )) ||
                !Number.isFinite(row.candle.open) ||
                !Number.isFinite(row.candle.high) ||
                !Number.isFinite(row.candle.low) ||
                !Number.isFinite(row.candle.close) ||
                !Number.isFinite(row.candle.volume) ||
                row.candle.open <= 0 ||
                row.candle.high <= 0 ||
                row.candle.low <= 0 ||
                row.candle.close <= 0 ||
                row.candle.volume < 0 ||
                row.candle.high < Math.max(row.candle.open, row.candle.close) ||
                row.candle.low > Math.min(row.candle.open, row.candle.close) ||
                row.candle.high < row.candle.low) {
                throw new Error(`Continuous Observation Schema Error: row ${index} has invalid identity, timestamps, or OHLCV.`);
            }
            observationIds.add(row.observationId);

            const values = [
                this.csvEscape(row.observationId),
                String(row.sourceTimestamp),
                String(row.observationTimestamp),
                String(row.candle.open),
                String(row.candle.high),
                String(row.candle.low),
                String(row.candle.close),
                String(row.candle.volume),
                ...featureKeys.map(key => {
                    const featureValue = row.observation.features[key];
                    if (!Number.isFinite(featureValue)) {
                        throw new Error(`Non-finite feature ${key} in continuous row ${index}.`);
                    }
                    return String(featureValue);
                }),
                ...featureKeys.map(key => {
                    const isValid = row.observation.validity[key];
                    if (typeof isValid !== 'boolean') {
                        throw new Error(`Invalid validity marker for feature ${key} in continuous row ${index}.`);
                    }
                    return String(isValid);
                })
            ];
            return values.join(',');
        });

        return [headers, ...lines].join('\r\n');
    }

    public static countCsvDataRows(csv: string): number {
        if (typeof csv !== 'string' || csv.length === 0) {
            throw new Error('CSV Row Count Error: CSV content must be a non-empty string.');
        }
        let inQuotedField = false;
        let recordCount = 1;
        for (let i = 0; i < csv.length; i++) {
            const character = csv[i];
            if (character === '"') {
                if (inQuotedField && csv[i + 1] === '"') {
                    i++;
                } else {
                    inQuotedField = !inQuotedField;
                }
            } else if (!inQuotedField && character === '\r') {
                if (csv[i + 1] !== '\n') {
                    throw new Error('CSV Row Count Error: CSV must use CRLF record separators.');
                }
                recordCount++;
                i++;
            } else if (!inQuotedField && character === '\n') {
                throw new Error('CSV Row Count Error: CSV contains an unpaired line feed.');
            }
        }
        if (inQuotedField) {
            throw new Error('CSV Row Count Error: CSV contains an unterminated quoted field.');
        }
        return recordCount - 1;
    }

    public static async buildExportArtifacts(params: {
        rawCandleBuffer: Float64Array;
        symbol: string;
        interval: string;
        intervalMs: number;
        buildTimestamp?: number;
        zigZagParameters?: Readonly<Record<string, unknown>>;
        onProgress?: (detail: string) => void;
    }) {
        const { rawCandleBuffer, symbol, interval, intervalMs } = params;
        if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
            throw new Error(`Unsupported chart interval for export: ${interval}`);
        }
        if (!(rawCandleBuffer instanceof Float64Array) ||
            rawCandleBuffer.length === 0 || rawCandleBuffer.length % 6 !== 0) {
            throw new Error('Historical fetch returned empty or malformed data buffer (length not divisible by 6).');
        }

        const rawCandleCount = rawCandleBuffer.length / 6;
        const strictPolicy = {
            rejectInvalidSource: true,
            rejectInvalidOhlcv: true,
            rejectDuplicateTimestamp: true,
            rejectOutOfOrder: true,
            requireMinimumUptimeFraction: 1.0
        };
        const featureConfig = validateML1Config({
            ...ML1_CONFIG_B,
            symbol,
            timeframe: interval,
            expectedIntervalMs: intervalMs,
            gapDiscontinuityThresholdMs: Math.max(ML1_CONFIG_B.gapDiscontinuityThresholdMs, intervalMs),
            emaPeriods: [...ML1_CONFIG_B.emaPeriods],
            atrPeriods: [...ML1_CONFIG_B.atrPeriods],
            rollingRangePeriods: [...ML1_CONFIG_B.rollingRangePeriods],
            momentumPeriods: [...ML1_CONFIG_B.momentumPeriods],
            volumeSmaPeriods: [...ML1_CONFIG_B.volumeSmaPeriods]
        });
        const firstTimestamp = rawCandleBuffer[0];
        const backboneInputs: Array<{
            candle: {
                time: number;
                open: number;
                high: number;
                low: number;
                close: number;
                volume: number;
                isSynthetic: false;
            };
            observation: ReturnType<typeof stepML1Features>['observation'];
            isValidOhlcv: boolean;
        }> = [];
        let state = createInitialML1FeatureState();
        let expectedNextTime = -1;

        params.onProgress?.(`Validating ${rawCandleCount.toLocaleString()} source candles...`);
        for (let offset = 0; offset < rawCandleBuffer.length; offset += 6) {
            const candle = {
                time: rawCandleBuffer[offset],
                open: rawCandleBuffer[offset + 1],
                high: rawCandleBuffer[offset + 2],
                low: rawCandleBuffer[offset + 3],
                close: rawCandleBuffer[offset + 4],
                volume: rawCandleBuffer[offset + 5],
                isSynthetic: false as const
            };
            if (!Number.isSafeInteger(candle.time) || candle.time < 1e12) {
                throw new Error(`Invalid millisecond timestamp at candle index ${offset / 6}.`);
            }
            if (candle.time % intervalMs !== 0) {
                throw new Error(`Timestamp ${candle.time} is not aligned to ${interval}.`);
            }
            const isValidOhlcv = validateCandleOhlcv(candle);
            if (!isValidOhlcv) {
                throw new Error(`Structurally invalid OHLCV at ${new Date(candle.time).toISOString()}.`);
            }
            if (expectedNextTime !== -1 && candle.time !== expectedNextTime) {
                throw new Error(
                    `Missing candle detected. Expected ${expectedNextTime}, got ${candle.time}. ` +
                    'A continuous timeline is required.'
                );
            }
            expectedNextTime = candle.time + intervalMs;

            const result = stepML1Features(candle, offset / 6, state, featureConfig);
            const quality = extractDataQuality(result.observation);
            const acceptance = evaluateAcceptance(quality, strictPolicy, isValidOhlcv, {
                gridAnchor: firstTimestamp,
                isOnGrid: (candle.time - firstTimestamp) % intervalMs === 0,
                isWithinRange: true
            });
            const continuityFailures = [
                quality.hasDataGap ? 'DATA_GAP' : '',
                quality.isDiscontinuity ? 'DISCONTINUITY' : '',
                quality.isUnexpectedInterval ? 'UNEXPECTED_INTERVAL' : ''
            ].filter(Boolean);
            if (!acceptance.isAccepted || continuityFailures.length > 0) {
                throw new Error(
                    `Candle at timestamp ${candle.time} rejected: ` +
                    [...acceptance.rejectionReasons, ...continuityFailures].join(', ')
                );
            }
            state = result.nextState;
            backboneInputs.push({ candle, observation: result.observation, isValidOhlcv });
        }

        const dateRange = {
            startTimestamp: backboneInputs[0].candle.time,
            endTimestamp: backboneInputs[backboneInputs.length - 1].candle.time
        };
        const backboneResult = buildSourceBackbone(
            backboneInputs,
            symbol,
            interval,
            1,
            strictPolicy,
            intervalMs,
            dateRange
        );
        if (!backboneResult.uptime.isUptimeValid || backboneResult.rejectedRows.length > 0 ||
            backboneResult.acceptedRows.length !== rawCandleCount) {
            throw new Error(
                `M4B accepted-row accounting mismatch. Expected ${rawCandleCount}, ` +
                `accepted ${backboneResult.acceptedRows.length}, rejected ${backboneResult.rejectedRows.length}.`
            );
        }

        const cleanData = new Float64Array(backboneResult.acceptedRows.length * 6);
        for (let index = 0; index < backboneResult.acceptedRows.length; index++) {
            const candle = backboneResult.acceptedRows[index].candle;
            const offset = index * 6;
            cleanData[offset] = candle.time;
            cleanData[offset + 1] = candle.open;
            cleanData[offset + 2] = candle.high;
            cleanData[offset + 3] = candle.low;
            cleanData[offset + 4] = candle.close;
            cleanData[offset + 5] = candle.volume;
        }
        const dataStore = new DataStore(backboneResult.acceptedRows.length);
        dataStore.data = cleanData;
        dataStore.length = backboneResult.acceptedRows.length;

        params.onProgress?.('Computing structural pivots and events...');
        const zigZag = new StrictCBCZigZagIndicator();
        zigZag.currentSymbol = symbol;
        for (const parameter of zigZag.params) {
            const value = params.zigZagParameters?.[parameter.id];
            if (value !== undefined) parameter.value = value;
        }
        zigZag.calculate(dataStore);
        const events = AIExporter.buildMLR1Dataset(
            dataStore,
            backboneResult.acceptedRows,
            zigZag.cachedPivots,
            symbol,
            interval,
            intervalMs
        );
        if (events.length === 0) {
            throw new Error('No valid confirmed structural events were detected in this historical window.');
        }

        params.onProgress?.('Auditing event chronology and outcomes...');
        const auditResult = DatasetAuditor.runCausalityAudit(
            events,
            dataStore,
            backboneResult.acceptedRows,
            intervalMs,
            zigZag.cachedPivots
        );
        const chronologyValid = auditResult.chronologyValid &&
            backboneResult.stats.outOfOrderCount === 0;
        const identityUnique = auditResult.identityUnique &&
            new Set(backboneResult.acceptedRows.map(row => row.observationId)).size ===
                backboneResult.acceptedRows.length;
        if (!auditResult.passed || !chronologyValid || !identityUnique ||
            !auditResult.inputOutcomeSeparationValid) {
            throw new Error('Pre-flight master audit failed: source integrity, identity, chronology, or separation invariant broken.');
        }

        params.onProgress?.('Generating and reconciling CSV artifacts...');
        const continuousCsv = AIExporter.exportMLR1ContinuousObservationsCSV(backboneResult.acceptedRows);
        const representationCsv = AIExporter.exportMLR1RepresentationCSV(events, symbol, interval);
        const eventCsv = AIExporter.exportMLR1CSV(events, symbol, interval);
        if (!continuousCsv || !representationCsv || !eventCsv) {
            throw new Error('CSV generation failed for one or more dataset tiers.');
        }
        const continuousFileName = `MLR1_${symbol}_${interval}_Continuous_Observations.csv`;
        const representationFileName = `MLR1_${symbol}_${interval}_Representation_Features.csv`;
        const eventFileName = `MLR1_${symbol}_${interval}_Events.csv`;
        const actualFileRowCounts = {
            [continuousFileName]: AIExporter.countCsvDataRows(continuousCsv),
            [representationFileName]: AIExporter.countCsvDataRows(representationCsv),
            [eventFileName]: AIExporter.countCsvDataRows(eventCsv)
        };
        if (actualFileRowCounts[continuousFileName] !== backboneResult.acceptedRows.length ||
            actualFileRowCounts[representationFileName] !== events.length ||
            actualFileRowCounts[eventFileName] !== events.length) {
            throw new Error('Physical CSV data row count reconciliation failed.');
        }

        const exportAccounting: ExportAccounting = {
            rawSourceCandleCount: rawCandleCount,
            acceptedSourceObservationCount: backboneResult.acceptedRows.length,
            rejectedSourceObservationCount: backboneResult.rejectedRows.length,
            tierAContinuousObservationCount: backboneResult.acceptedRows.length,
            tierAEventRepresentationRowCount: events.length,
            tierBConfirmedTeacherEventCount: events.length,
            tierCOutcomeRowCount: events.length,
            actualFileRowCounts
        };
        const manifest = createDatasetManifest(
            `DS_${symbol}_${interval}_V1`,
            'BINANCE_SPOT',
            {
                symbol,
                baseTimeframe: interval,
                datasetVersion: 1,
                sourceIntervalMs: intervalMs,
                featureConfigVersion: ML1_CONFIG_B_VERSION,
                teacherVersion: STRICT_CBC_ZIGZAG_TEACHER_VERSION,
                outcomeConfigVersion: MLR1_OUTCOME_CONFIG_VERSION,
                dateRange,
                integrityPolicy: strictPolicy,
                exportConfig: {
                    exportTierA: true,
                    exportTierB: true,
                    exportTierC: true,
                    separateFiles: false
                }
            },
            backboneResult.stats,
            backboneResult.uptime,
            {
                passed: auditResult.passed && chronologyValid && identityUnique &&
                    auditResult.inputOutcomeSeparationValid,
                chronologyValid,
                identityUnique,
                inputOutcomeSeparationValid: auditResult.inputOutcomeSeparationValid,
                remarks: [
                    `Artifact 1 (${continuousFileName}): Tier A continuous causal observations ` +
                    `(${actualFileRowCounts[continuousFileName]} rows). Available for approved baseline ` +
                    'model inputs; contains 1:1 feature values and validity masks.',
                    `Artifact 2 (${representationFileName}): Tier A confirmed-event representation tensor ` +
                    `(${actualFileRowCounts[representationFileName]} rows). Authoritative model-input boundary ` +
                    'strictly whitelisted against MLR1_REPRESENTATION_FEATURE_ALLOWLIST.',
                    `Artifact 3 (${eventFileName}): Combined archival and supervised target dataset ` +
                    `(${actualFileRowCounts[eventFileName]} rows). Combines Tier B teacher events with Tier C ` +
                    'quarantined forward outcomes; not an unrestricted model input source. separateFiles is false.'
                ]
            },
            exportAccounting
        );

        return {
            manifest: params.buildTimestamp === undefined
                ? manifest
                : { ...manifest, buildTimestamp: params.buildTimestamp },
            continuousCsv,
            representationCsv,
            eventCsv,
            continuousFileName,
            representationFileName,
            eventFileName,
            events,
            backboneResult,
            exportAccounting,
            auditResult
        };
    }
}

export class DatasetAuditor {
    /**
     * Master Verification Suite:
     * 1. Row-level Contract & Numerical Integrity Audit
     * 2. Training Allowlist Leakage Audit
     * 3. Independent Candle-Level Execution Replay Audit (verifying entry/exit/outcomes against DataStore candles)
     * 4. Tier A context provenance recomputation
     */
    public static runCausalityAudit(
        events: MLR1EventRow[],
        dataStore: any,
        acceptedRows: readonly SourceBackboneAcceptedRow[],
        intervalMs: number,
        cachedPivots?: readonly StrictZigZagPivot[]
    ): {
        passed: boolean;
        chronologyValid: boolean;
        identityUnique: boolean;
        inputOutcomeSeparationValid: boolean;
    } {
        console.log('🛡️ Running ML-R1 Comprehensive Contract & Integrity Audit...');

        const failResult = {
            passed: false,
            chronologyValid: false,
            identityUnique: false,
            inputOutcomeSeparationValid: false
        };
        if (!Array.isArray(events)) {
            console.error('DatasetAuditor Error: events must be an array.');
            return failResult;
        }
        if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
            console.error('DatasetAuditor Error: intervalMs must be a positive safe integer.');
            return failResult;
        }
        if (!dataStore || !dataStore.data || !Number.isSafeInteger(dataStore.length) ||
            dataStore.length === 0 || dataStore.data.length !== dataStore.length * 6 ||
            !Array.isArray(acceptedRows) || acceptedRows.length === 0) {
            console.error("❌ DatasetAuditor Error: dataStore and acceptedRows are mandatory for the 3-way verification pass.");
            return failResult;
        }
        if (cachedPivots !== undefined && !Array.isArray(cachedPivots)) {
            console.error('DatasetAuditor Error: cachedPivots must be an array when supplied.');
            return failResult;
        }
        if (dataStore.length !== acceptedRows.length) {
            console.error("❌ DatasetAuditor Error: dataStore length does not match acceptedRows length.");
            return failResult;
        }
        for (let rowIndex = 0; rowIndex < dataStore.length; rowIndex++) {
            const row = acceptedRows[rowIndex];
            const base = rowIndex * 6;
            if (!row || !row.candle || !row.observation ||
                !row.observation.features || !row.observation.validity ||
                row.candle.time !== dataStore.data[base] ||
                row.candle.open !== dataStore.data[base + 1] ||
                row.candle.high !== dataStore.data[base + 2] ||
                row.candle.low !== dataStore.data[base + 3] ||
                row.candle.close !== dataStore.data[base + 4] ||
                row.candle.volume !== dataStore.data[base + 5] ||
                row.sourceTimestamp !== dataStore.data[base] ||
                row.observation.timestamp !== dataStore.data[base] ||
                row.observationTimestamp !== row.sourceTimestamp + intervalMs ||
                row.observation.sourceOpen !== row.candle.open ||
                row.observation.sourceHigh !== row.candle.high ||
                row.observation.sourceLow !== row.candle.low ||
                row.observation.sourceClose !== row.candle.close ||
                row.observation.sourceVolume !== row.candle.volume ||
                row.observation.barIndex !== rowIndex ||
                (rowIndex > 0 &&
                    row.sourceTimestamp !== acceptedRows[rowIndex - 1].sourceTimestamp + intervalMs)) {
                console.error(`❌ DatasetAuditor Error: accepted row ${rowIndex} does not match the dataStore bar.`);
                return failResult;
            }
        }

        let timeFailures = 0;
        let indexFailures = 0;
        let mathFailures = 0;
        let duplicateFailures = 0;
        let directionFailures = 0;
        let volumeFractionFailures = 0;
        let barrierGeometryFailures = 0;
        let exitIntegrityFailures = 0;
        let outcomeMathFailures = 0;
        let timeoutClassFailures = 0;
        let allowlistFailures = 0;
        let provenanceFailures = 0;
        let candleExecutionFailures = 0;

        const idSet = new Set<string>();
        const VALID_OUTCOMES = new Set(['full_target', 'hard_stop', 'timeout_net_gain', 'timeout_net_loss']);
        const ALLOWLIST_SET = new Set<string>(MLR1_REPRESENTATION_FEATURE_ALLOWLIST);

        for (let i = 0; i < events.length; i++) {
            const ev = events[i];
            if (!ev || typeof ev !== 'object') {
                directionFailures++;
                continue;
            }
            const previousEvent = i > 0 ? events[i - 1] : undefined;

            // 1. Uniqueness
            if (typeof ev.event_id !== 'string' || ev.event_id.trim().length === 0 ||
                typeof ev.symbol !== 'string' || ev.symbol.trim().length === 0 ||
                typeof ev.timeframe !== 'string' || ev.timeframe.trim().length === 0 ||
                typeof ev.pivot_label !== 'string' || ev.pivot_label.trim().length === 0) {
                duplicateFailures++;
            }
            if (idSet.has(ev.event_id)) duplicateFailures++;
            idSet.add(ev.event_id);

            // 2. Strict Chronology & Integer Timestamps
            if (i > 0) {
                if (!previousEvent || typeof previousEvent !== 'object') {
                    timeFailures++;
                } else {
                    if (ev.confirmation_time_ms <= previousEvent.confirmation_time_ms) timeFailures++;
                    if (ev.confirmed_bar_index <= previousEvent.confirmed_bar_index) timeFailures++;
                }
            }

            // 3. Exact next_open Causality & bounded structural-pivot provenance
            if (!Number.isSafeInteger(ev.pivot_bar_index) ||
                !Number.isSafeInteger(ev.previous_pivot_bar_index) ||
                !Number.isSafeInteger(ev.confirmed_bar_index) ||
                !Number.isSafeInteger(ev.entry_bar_index) ||
                !Number.isSafeInteger(ev.previous_pivot_confirmed_bar_index) ||
                ev.pivot_bar_index < 0 ||
                ev.previous_pivot_bar_index < 0 ||
                ev.previous_pivot_confirmed_bar_index < 0 ||
                ev.previous_pivot_confirmed_bar_index < ev.previous_pivot_bar_index ||
                ev.previous_pivot_bar_index >= ev.pivot_bar_index ||
                ev.previous_pivot_bar_index >= acceptedRows.length ||
                ev.previous_pivot_confirmed_bar_index >= ev.confirmed_bar_index ||
                ev.previous_pivot_confirmed_bar_index >= acceptedRows.length ||
                ev.pivot_bar_index > ev.confirmed_bar_index ||
                ev.confirmed_bar_index >= acceptedRows.length ||
                ev.entry_bar_index !== ev.confirmed_bar_index + 1 ||
                ev.entry_bar_index >= acceptedRows.length ||
                ev.entry_bar_index >= dataStore.length) {
                indexFailures++;
                candleExecutionFailures++;
                continue;
            }

            if (ev.entry_time <= ev.confirmation_time_ms) indexFailures++;
            const sourcePivotRow = acceptedRows[ev.pivot_bar_index];
            const sourcePreviousPivotRow = acceptedRows[ev.previous_pivot_bar_index];
            const sourceConfirmedRow = acceptedRows[ev.confirmed_bar_index];
            const sourcePreviousConfirmedRow = acceptedRows[ev.previous_pivot_confirmed_bar_index];
            const expectedPivotPrice = ev.pivot_type === 'high'
                ? sourcePivotRow.candle.high
                : sourcePivotRow.candle.low;
            const expectedPreviousPivotPrice = ev.previous_pivot_type === 'high'
                ? sourcePreviousPivotRow.candle.high
                : sourcePreviousPivotRow.candle.low;
            if (!['high', 'low'].includes(ev.pivot_type) ||
                !['high', 'low'].includes(ev.previous_pivot_type) ||
                ev.pivot_type === ev.previous_pivot_type ||
                Math.abs(ev.pivot_price - expectedPivotPrice) > 0.0001 ||
                Math.abs(ev.previous_pivot_price - expectedPreviousPivotPrice) > 0.0001 ||
                ev.bars_since_last_pivot !==
                    ev.confirmed_bar_index - ev.previous_pivot_confirmed_bar_index ||
                ev.confirmation_time_ms !== sourceConfirmedRow.sourceTimestamp ||
                ev.entry_time !== sourceConfirmedRow.observationTimestamp ||
                ev.pivot_time_ms !== sourcePivotRow.sourceTimestamp ||
                ev.previous_pivot_confirmation_time_ms !== sourcePreviousConfirmedRow.sourceTimestamp ||
                ev.pivot_time_ms > ev.confirmation_time_ms ||
                (i > 0 && (!previousEvent ||
                    !Number.isSafeInteger(previousEvent.pivot_bar_index) ||
                    ev.pivot_bar_index <= previousEvent.pivot_bar_index))) {
                indexFailures++;
            }
            if (cachedPivots) {
                const currentTeacherIndex = cachedPivots.findIndex(
                    pivot => pivot.barIndex === ev.pivot_bar_index &&
                        pivot.confirmedBarIndex === ev.confirmed_bar_index
                );
                const previousTeacher = currentTeacherIndex > 0
                    ? cachedPivots[currentTeacherIndex - 1]
                    : undefined;
                if (!previousTeacher ||
                    previousTeacher.barIndex !== ev.previous_pivot_bar_index ||
                    previousTeacher.confirmedBarIndex !== ev.previous_pivot_confirmed_bar_index ||
                    previousTeacher.type !== ev.previous_pivot_type ||
                    Math.abs(previousTeacher.price - ev.previous_pivot_price) > 0.0001) {
                    provenanceFailures++;
                }
            }

            // 4. Exhaustive Anti-NaN Gate on all 25 numeric fields
            const requiredFiniteNumbers = [
                ev.pivot_price, ev.previous_pivot_price, ev.previous_pivot_bar_index,
                ev.previous_pivot_confirmed_bar_index, ev.previous_pivot_confirmation_time_ms,
                ev.pivot_bar_index,
                ev.pivot_time_ms, ev.confirmed_bar_index, ev.confirmation_time_ms, ev.bars_since_last_pivot,
                ev.leg_distance_atr, ev.context_net_return_atr, ev.context_max_favorable_atr,
                ev.context_max_adverse_atr, ev.context_candle_count, ev.context_relative_volume,
                ev.context_relative_volume_valid_fraction, ev.entry_bar_index, ev.entry_time,
                ev.entry_price, ev.atr_at_confirmation, ev.long_stop_price, ev.long_target_price,
                ev.long_exit_price, ev.long_net_r, ev.short_stop_price, ev.short_target_price,
                ev.short_exit_price, ev.short_net_r
            ];

            for (let v = 0; v < requiredFiniteNumbers.length; v++) {
                if (!Number.isFinite(requiredFiniteNumbers[v])) mathFailures++;
            }

            // Strict Integer Fields
            const requiredIntegerFields = [
                ev.previous_pivot_bar_index, ev.previous_pivot_confirmed_bar_index,
                ev.previous_pivot_confirmation_time_ms, ev.pivot_bar_index, ev.pivot_time_ms,
                ev.confirmed_bar_index, ev.confirmation_time_ms,
                ev.bars_since_last_pivot, ev.context_candle_count, ev.entry_bar_index, ev.entry_time
            ];
            for (let k = 0; k < requiredIntegerFields.length; k++) {
                if (!Number.isSafeInteger(requiredIntegerFields[k])) mathFailures++;
            }

            if (ev.atr_at_confirmation <= 0 || ev.context_max_favorable_atr < 0 || ev.context_max_adverse_atr < 0) {
                mathFailures++;
            }

            // 5. Completed-Leg Direction Verification
            const expectedDir = ev.pivot_price > ev.previous_pivot_price ? 'up' : 
                               (ev.pivot_price < ev.previous_pivot_price ? 'down' : 'flat');
            if (ev.completed_leg_direction !== expectedDir) directionFailures++;
            if (ev.atr_at_confirmation > 0) {
                const expectedLegDistance = (ev.pivot_price - ev.previous_pivot_price) / ev.atr_at_confirmation;
                if (Math.abs(ev.leg_distance_atr - expectedLegDistance) > 0.0001) mathFailures++;
            } else {
                mathFailures++;
            }

            // Categorical validation
            if (!['high', 'low'].includes(ev.pivot_type)) directionFailures++;
            if (!['high', 'low'].includes(ev.previous_pivot_type)) directionFailures++;
            if (ev.pivot_type === ev.previous_pivot_type) directionFailures++;
            if (!['up', 'down', 'flat'].includes(ev.completed_leg_direction)) directionFailures++;
            if (!['up', 'down'].includes(ev.zigzag_next_leg_orientation)) directionFailures++;

            // 6. Volume Two-Way Sentinel Checks
            if (ev.context_relative_volume_valid_fraction < 0 || ev.context_relative_volume_valid_fraction > 1.0) {
                volumeFractionFailures++;
            }
            if (ev.context_relative_volume_valid_fraction === 0 && ev.context_relative_volume !== -1.0) {
                volumeFractionFailures++;
            }
            if (ev.context_relative_volume_valid_fraction > 0 && (ev.context_relative_volume < 0 || !Number.isFinite(ev.context_relative_volume))) {
                volumeFractionFailures++;
            }

            // 7. Barrier Geometry Verification (Stop = 1.5 ATR, Target = 3.0 ATR)
            const expectedLongStop = ev.entry_price - (ev.atr_at_confirmation * 1.5);
            const expectedLongTarget = ev.entry_price + (ev.atr_at_confirmation * 3.0);
            const expectedShortStop = ev.entry_price + (ev.atr_at_confirmation * 1.5);
            const expectedShortTarget = ev.entry_price - (ev.atr_at_confirmation * 3.0);

            if (Math.abs(ev.long_stop_price - expectedLongStop) > 0.001) barrierGeometryFailures++;
            if (Math.abs(ev.long_target_price - expectedLongTarget) > 0.001) barrierGeometryFailures++;
            if (Math.abs(ev.short_stop_price - expectedShortStop) > 0.001) barrierGeometryFailures++;
            if (Math.abs(ev.short_target_price - expectedShortTarget) > 0.001) barrierGeometryFailures++;

            // 8. Exit & Permitted Outcome Enumeration Verification
            if (!VALID_OUTCOMES.has(ev.long_outcome) || !VALID_OUTCOMES.has(ev.short_outcome)) {
                exitIntegrityFailures++;
            }

            if (ev.long_outcome === 'full_target' && ev.long_exit_price < ev.long_target_price - 0.001) exitIntegrityFailures++;
            if (ev.long_outcome === 'hard_stop' && ev.long_exit_price > ev.long_stop_price + 0.001) exitIntegrityFailures++;
            if (ev.short_outcome === 'full_target' && ev.short_exit_price > ev.short_target_price + 0.001) exitIntegrityFailures++;
            if (ev.short_outcome === 'hard_stop' && ev.short_exit_price < ev.short_stop_price - 0.001) exitIntegrityFailures++;

            // 9. Positive Risk Check & Net R Math Agreement
            const lRisk = ev.entry_price - ev.long_stop_price;
            const sRisk = ev.short_stop_price - ev.entry_price;

            if (!Number.isFinite(lRisk) || lRisk <= 0 || !Number.isFinite(sRisk) || sRisk <= 0) {
                outcomeMathFailures++;
            } else {
                const expectedLongNetR = Math.min(2.0, (ev.long_exit_price - ev.entry_price) / lRisk) - 0.05;
                if (Math.abs(expectedLongNetR - ev.long_net_r) > 0.01) outcomeMathFailures++;

                const expectedShortNetR = Math.min(2.0, (ev.entry_price - ev.short_exit_price) / sRisk) - 0.05;
                if (Math.abs(expectedShortNetR - ev.short_net_r) > 0.01) outcomeMathFailures++;
            }

            // 10. Timeout Net Classification Check
            if (ev.long_outcome === 'timeout_net_gain' && ev.long_net_r <= 0) timeoutClassFailures++;
            if (ev.long_outcome === 'timeout_net_loss' && ev.long_net_r > 0) timeoutClassFailures++;
            if (ev.short_outcome === 'timeout_net_gain' && ev.short_net_r <= 0) timeoutClassFailures++;
            if (ev.short_outcome === 'timeout_net_loss' && ev.short_net_r > 0) timeoutClassFailures++;

            // 11. Training Feature Allowlist Projection Check
            const repInput = buildRepresentationInput(ev);
            const inputKeys = Object.keys(repInput);
            if (inputKeys.length !== MLR1_REPRESENTATION_FEATURE_ALLOWLIST.length) allowlistFailures++;
            for (let k = 0; k < inputKeys.length; k++) {
                if (!ALLOWLIST_SET.has(inputKeys[k])) allowlistFailures++;
            }

            // Recompute each causal context feature from its authoritative accepted rows.
            const contextStart = ev.confirmed_bar_index - ev.bars_since_last_pivot + 1;
            const contextEnd = ev.confirmed_bar_index;
            if (!Number.isSafeInteger(contextStart) || !Number.isSafeInteger(contextEnd) ||
                contextStart < 0 || contextEnd >= acceptedRows.length ||
                contextStart > contextEnd || !Number.isFinite(ev.atr_at_confirmation) ||
                ev.atr_at_confirmation <= 0) {
                provenanceFailures++;
            } else {
                let matureCount = 0;
                let sumRelativeVolume = 0;
                let maxHigh = -Infinity;
                let minLow = Infinity;
                const startOpen = acceptedRows[contextStart].candle.open;
                const endClose = acceptedRows[contextEnd].candle.close;
                let validContext = Number.isFinite(startOpen) && Number.isFinite(endClose) &&
                    startOpen > 0 && endClose > 0;

                for (let bar = contextStart; bar <= contextEnd; bar++) {
                    const row = acceptedRows[bar];
                    const candleHigh = row.candle.high;
                    const candleLow = row.candle.low;
                    if (!Number.isFinite(candleHigh) || !Number.isFinite(candleLow)) {
                        validContext = false;
                        break;
                    }
                    maxHigh = Math.max(maxHigh, candleHigh);
                    minLow = Math.min(minLow, candleLow);

                    const relativeVolume = row.observation.features['RelativeVolume_20'];
                    const relativeVolumeValid = row.observation.validity['RelativeVolume_20'];
                    if (typeof relativeVolumeValid !== 'boolean') {
                        provenanceFailures++;
                    } else if (relativeVolumeValid) {
                        if (!Number.isFinite(relativeVolume) || relativeVolume < 0) {
                            provenanceFailures++;
                        } else {
                            matureCount++;
                            sumRelativeVolume += relativeVolume;
                        }
                    }
                }

                if (!validContext || maxHigh < minLow ||
                    maxHigh < Math.max(startOpen, endClose) ||
                    minLow > Math.min(startOpen, endClose)) {
                    provenanceFailures++;
                } else {
                    const contextCount = contextEnd - contextStart + 1;
                    const expectedContext = {
                        count: contextCount,
                        netReturnAtr: (endClose - startOpen) / ev.atr_at_confirmation,
                        maxFavorableAtr: (maxHigh - startOpen) / ev.atr_at_confirmation,
                        maxAdverseAtr: (startOpen - minLow) / ev.atr_at_confirmation,
                        relativeVolume: matureCount > 0 ? sumRelativeVolume / matureCount : -1,
                        validFraction: matureCount / contextCount
                    };
                    const tolerance = 0.0001;
                    if (expectedContext.count !== ev.context_candle_count ||
                        Math.abs(expectedContext.netReturnAtr - ev.context_net_return_atr) > tolerance ||
                        Math.abs(expectedContext.maxFavorableAtr - ev.context_max_favorable_atr) > tolerance ||
                        Math.abs(expectedContext.maxAdverseAtr - ev.context_max_adverse_atr) > tolerance ||
                        Math.abs(expectedContext.relativeVolume - ev.context_relative_volume) > tolerance ||
                        Math.abs(expectedContext.validFraction - ev.context_relative_volume_valid_fraction) > tolerance) {
                        provenanceFailures++;
                    }
                }
            }

            // 12. Independent Candle-Level Execution Replay (Tracking LONG and SHORT trajectories)
            if (!Number.isSafeInteger(ev.pivot_bar_index) ||
                !Number.isSafeInteger(ev.confirmed_bar_index) ||
                !Number.isSafeInteger(ev.entry_bar_index) ||
                !Number.isSafeInteger(ev.pivot_time_ms) ||
                ev.pivot_bar_index < 0 ||
                ev.confirmed_bar_index < 0 ||
                ev.pivot_bar_index > ev.confirmed_bar_index ||
                ev.confirmed_bar_index >= dataStore.length ||
                ev.entry_bar_index !== ev.confirmed_bar_index + 1 ||
                ev.entry_bar_index >= dataStore.length) {
                indexFailures++;
                candleExecutionFailures++;
                continue;
            }
            const pivotRow = acceptedRows[ev.pivot_bar_index];
            const confirmedRow = acceptedRows[ev.confirmed_bar_index];
            if (ev.confirmation_time_ms !== confirmedRow.sourceTimestamp ||
                confirmedRow.sourceTimestamp !== dataStore.data[ev.confirmed_bar_index * 6]) {
                timeFailures++;
            }
            if (ev.entry_time !== confirmedRow.observationTimestamp) {
                timeFailures++;
            }
            if (pivotRow.sourceTimestamp !== pivotRow.candle.time ||
                pivotRow.sourceTimestamp !== dataStore.data[ev.pivot_bar_index * 6] ||
                ev.pivot_time_ms !== pivotRow.sourceTimestamp ||
                ev.pivot_time_ms > ev.confirmation_time_ms) {
                timeFailures++;
            }
            const entryBar = ev.entry_bar_index;
            const horizonEnd = entryBar + 60 - 1;

            if (horizonEnd >= dataStore.length) {
                candleExecutionFailures++;
            } else {
                const entryBase = entryBar * 6;
                const actualOpen = dataStore.data[entryBase + 1];
                const actualEntryTime = dataStore.data[entryBase];
                const actualConfTime = dataStore.data[ev.confirmed_bar_index * 6];

                if (Math.abs(ev.entry_price - actualOpen) > 0.0001) candleExecutionFailures++;
                if (ev.entry_time !== actualEntryTime) candleExecutionFailures++;
                if (ev.confirmation_time_ms !== actualConfTime) candleExecutionFailures++;

                // Independent replay of LONG and SHORT forward paths
                let replayLResolved = false;
                let replayLExit = 0;
                let replayLOutcome: 'full_target' | 'hard_stop' | 'timeout_net_gain' | 'timeout_net_loss' = 'hard_stop';

                let replaySResolved = false;
                let replaySExit = 0;
                let replaySOutcome: 'full_target' | 'hard_stop' | 'timeout_net_gain' | 'timeout_net_loss' = 'hard_stop';

                for (let f = entryBar; f <= horizonEnd; f++) {
                    const bF = f * 6;
                    const fOpen = dataStore.data[bF + 1];
                    const fHigh = dataStore.data[bF + 2];
                    const fLow = dataStore.data[bF + 3];
                    const fClose = dataStore.data[bF + 4];

                    // LONG Replay
                    if (!replayLResolved) {
                        if (fOpen <= ev.long_stop_price) {
                            replayLExit = fOpen;
                            replayLOutcome = 'hard_stop';
                            replayLResolved = true;
                        } else if (fOpen >= ev.long_target_price) {
                            replayLExit = fOpen;
                            replayLOutcome = 'full_target';
                            replayLResolved = true;
                        } else {
                            const hitSL = fLow <= ev.long_stop_price;
                            const hitTP = fHigh >= ev.long_target_price;
                            if (hitSL && hitTP) {
                                replayLExit = ev.long_stop_price;
                                replayLOutcome = 'hard_stop';
                                replayLResolved = true;
                            } else if (hitSL) {
                                replayLExit = ev.long_stop_price;
                                replayLOutcome = 'hard_stop';
                                replayLResolved = true;
                            } else if (hitTP) {
                                replayLExit = ev.long_target_price;
                                replayLOutcome = 'full_target';
                                replayLResolved = true;
                            }
                        }
                        if (!replayLResolved && f === horizonEnd) {
                            replayLExit = fClose;
                            const grossR = (replayLExit - ev.entry_price) / lRisk;
                            const netR = Math.min(2.0, grossR) - 0.05;
                            replayLOutcome = netR > 0 ? 'timeout_net_gain' : 'timeout_net_loss';
                            replayLResolved = true;
                        }
                    }

                    // SHORT Replay
                    if (!replaySResolved) {
                        if (fOpen >= ev.short_stop_price) {
                            replaySExit = fOpen;
                            replaySOutcome = 'hard_stop';
                            replaySResolved = true;
                        } else if (fOpen <= ev.short_target_price) {
                            replaySExit = fOpen;
                            replaySOutcome = 'full_target';
                            replaySResolved = true;
                        } else {
                            const hitSL = fHigh >= ev.short_stop_price;
                            const hitTP = fLow <= ev.short_target_price;
                            if (hitSL && hitTP) {
                                replaySExit = ev.short_stop_price;
                                replaySOutcome = 'hard_stop';
                                replaySResolved = true;
                            } else if (hitSL) {
                                replaySExit = ev.short_stop_price;
                                replaySOutcome = 'hard_stop';
                                replaySResolved = true;
                            } else if (hitTP) {
                                replaySExit = ev.short_target_price;
                                replaySOutcome = 'full_target';
                                replaySResolved = true;
                            }
                        }
                        if (!replaySResolved && f === horizonEnd) {
                            replaySExit = fClose;
                            const grossR = (ev.entry_price - replaySExit) / sRisk;
                            const netR = Math.min(2.0, grossR) - 0.05;
                            replaySOutcome = netR > 0 ? 'timeout_net_gain' : 'timeout_net_loss';
                            replaySResolved = true;
                        }
                    }

                    if (replayLResolved && replaySResolved) break;
                }

                // Verify replay outcomes match recorded row data
                if (Math.abs(replayLExit - ev.long_exit_price) > 0.0001) candleExecutionFailures++;
                if (replayLOutcome !== ev.long_outcome) candleExecutionFailures++;
                if (Math.abs(replaySExit - ev.short_exit_price) > 0.0001) candleExecutionFailures++;
                if (replaySOutcome !== ev.short_outcome) candleExecutionFailures++;
            }
        }

        console.log(`=======================================`);
        console.log(`📊 ML-R1 FULL REINFORCED AUDIT: ${events.length} Events Checked`);
        console.log(`   ↳ Chronology & Time Int: ${timeFailures === 0 ? '✅ PASSED' : '❌ FAILED'}`);
        console.log(`   ↳ next_open Causality:   ${indexFailures === 0 ? '✅ PASSED' : '❌ FAILED'}`);
        console.log(`   ↳ Finite Anti-NaN Gate:  ${mathFailures === 0 ? '✅ PASSED' : '❌ FAILED'}`);
        console.log(`   ↳ Event Uniqueness:      ${duplicateFailures === 0 ? '✅ PASSED' : '❌ FAILED'}`);
        console.log(`   ↳ Completed Leg Math:    ${directionFailures === 0 ? '✅ PASSED' : '❌ FAILED'}`);
        console.log(`   ↳ Two-Way Volume Check:  ${volumeFractionFailures === 0 ? '✅ PASSED' : '❌ FAILED'}`);
        console.log(`   ↳ Barrier Geometry (ATR):${barrierGeometryFailures === 0 ? '✅ PASSED' : '❌ FAILED'}`);
        console.log(`   ↳ Exit & Gap Integrity:  ${exitIntegrityFailures === 0 ? '✅ PASSED' : '❌ FAILED'}`);
        console.log(`   ↳ Outcome Net R & Risk:  ${outcomeMathFailures === 0 ? '✅ PASSED' : '❌ FAILED'}`);
        console.log(`   ↳ Timeout Net Classes:   ${timeoutClassFailures === 0 ? '✅ PASSED' : '❌ FAILED'}`);
        console.log(`   ↳ Allowlist Enforcement: ${allowlistFailures === 0 ? '✅ PASSED' : '❌ FAILED'}`);
        console.log(`   ↳ Tier A Context Provenance: ${provenanceFailures === 0 ? '✅ PASSED' : '❌ FAILED'}`);
        console.log(`   ↳ Candle Execution Replay:${candleExecutionFailures === 0 ? '✅ PASSED' : '❌ FAILED'}`);
        console.log(`=======================================`);

        const passed = timeFailures === 0 && indexFailures === 0 &&
            mathFailures === 0 && duplicateFailures === 0 &&
            directionFailures === 0 && volumeFractionFailures === 0 &&
            barrierGeometryFailures === 0 && exitIntegrityFailures === 0 &&
            outcomeMathFailures === 0 && timeoutClassFailures === 0 &&
            allowlistFailures === 0 && provenanceFailures === 0 &&
            candleExecutionFailures === 0;
        if (!passed) {
            if (typeof alert !== 'undefined') alert(`⚠️ ML-R1 Audit Failed!\nCheck developer console.`);
        }
        return {
            passed,
            chronologyValid: timeFailures === 0 && indexFailures === 0,
            identityUnique: duplicateFailures === 0,
            inputOutcomeSeparationValid: allowlistFailures === 0
        };
    }
}
