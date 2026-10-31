// =========================================================================
// 🔒 FROZEN RESEARCH CONTRACT: EXPLICIT FEATURE / OUTCOME SEPARATION
// =========================================================================
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
 * 🔒 STRICT PROJECTION: Constructs Transformer input strictly from the allowlist.
 * Ensures future outcome fields can NEVER enter the model.
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
    pivot_bar_index: number;
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
        dataStore: any, 
        startBar: number, 
        endBar: number, 
        currentAtr: number,
        volSma: Float64Array,
        volValidMask: Uint8Array
    ) {
        if (startBar > endBar || currentAtr <= 0) {
            return { netReturnAtr: 0, maxFavorableAtr: 0, maxAdverseAtr: 0, count: 0, relativeVolume: -1.0, validFraction: 0.0 };
        }

        const startOpen = dataStore.data[startBar * 6 + 1];
        const endClose = dataStore.data[endBar * 6 + 4];
        let maxH = -Infinity;
        let minL = Infinity;
        
        let matureCount = 0;
        let volSum = 0;
        let volSmaSum = 0;
        
        for (let i = startBar; i <= endBar; i++) {
            const base = i * 6;
            if (dataStore.data[base + 2] > maxH) maxH = dataStore.data[base + 2];
            if (dataStore.data[base + 3] < minL) minL = dataStore.data[base + 3];
            
            // Safeguard: Ensure volume is non-negative and finite, and SMA denominator is positive and finite
            const vol = dataStore.data[base + 5];
            const sma = volSma[i];

            if (
                volValidMask[i] === 1 &&
                Number.isFinite(vol) &&
                vol >= 0 &&
                Number.isFinite(sma) &&
                sma > 0
            ) {
                matureCount++;
                volSum += vol;
                volSmaSum += sma;
            }
        }

        const count = endBar - startBar + 1;
        const netReturnAtr = (endClose - startOpen) / currentAtr;
        const maxFavorableAtr = (maxH - startOpen) / currentAtr;
        const maxAdverseAtr = (startOpen - minL) / currentAtr;
        
        const validFraction = count > 0 ? (matureCount / count) : 0.0;
        const relativeVolume = (matureCount > 0 && volSmaSum > 0) ? (volSum / volSmaSum) : -1.0;

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
        event: any, 
        prevEvent: any, 
        dataStore: any, 
        currentAtr: number,
        volSmaRaw: Float64Array,
        volValidMask: Uint8Array
    ) {
        const confBar = event.confirmedBarIndex;
        const prevConfBar = prevEvent.confirmedBarIndex;
        
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
        
        const ctx = CandleContextAggregator.summarize(dataStore, contextStart, contextEnd, currentAtr, volSmaRaw, volValidMask);

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
        cachedPivots: any[],
        symbol: string,
        timeframe: string
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

        const len = dataStore.length;
        const atrRaw = MarketFeatureEngine.calculateATRArray(dataStore, ATR_PERIOD);
        const { sma: volSmaRaw, validMask: volValidMask } = MarketFeatureEngine.calculateVolumeSMA(dataStore, 20);
        const events: MLR1EventRow[] = [];

        const indVersion = `v2_ATR${ATR_PERIOD}_SL${STOP_ATR_MULT}_TP${TARGET_R_MULT}_HZ${MAX_HORIZON_BARS}`;
        
        let excludedMissingNextOpen = 0;
        let excludedUnwarmedAtr = 0;
        let excludedIncompleteHorizon = 0;

        // Exclude index 0 (no completed leg, unbounded context)
        for (let i = 1; i < cachedPivots.length; i++) {
            const pivot = cachedPivots[i];
            const prevPivot = cachedPivots[i - 1];
            const confBar = pivot.confirmedBarIndex;
            const entryBar = confBar + 1; // Strict rule: next_open

            if (entryBar >= len) {
                excludedMissingNextOpen++;
                continue;
            }

            // Enforce validated confirmation ATR; zero fallback permitted
            const currentAtr = atrRaw[confBar];
            if (confBar < ATR_PERIOD - 1 || !Number.isFinite(currentAtr) || currentAtr <= 0) {
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
            const tokenFeatures = HybridTokenBuilder.build(pivot, prevPivot, dataStore, currentAtr, volSmaRaw, volValidMask);

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
                pivot_bar_index: pivot.barIndex,
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

        // Telemetry reconciliation report
        console.log(`=======================================`);
        console.log(`📊 ML-R1 DATASET GENERATION TELEMETRY:`);
        console.log(`   ↳ Total Candidate Pivots:     ${cachedPivots.length}`);
        console.log(`   ↳ Excluded (Index 0):         1`);
        console.log(`   ↳ Excluded (ATR Warm-up):     ${excludedUnwarmedAtr}`);
        console.log(`   ↳ Excluded (Missing Open):    ${excludedMissingNextOpen}`);
        console.log(`   ↳ Excluded (Incomplete HZ):   ${excludedIncompleteHorizon}`);
        console.log(`   ↳ Final Eligible Events:      ${events.length}`);
        if (events.length > 0) {
            console.log(`   ↳ Dataset Coverage Range:     ${new Date(events[0].confirmation_time_ms).toISOString()} → ${new Date(events[events.length - 1].confirmation_time_ms).toISOString()}`);
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

    public static exportMLR1CSV(events: MLR1EventRow[], symbol: string, timeframe: string): boolean {
        if (typeof document === 'undefined' || events.length === 0) return false;

        // RFC-4180 compliant header escaping
        const headers = Object.keys(events[0]).map(this.csvEscape).join(',');
        
        // Full JavaScript float precision preserved: No rounding loss for training scripts
        const lines = events.map(e =>
            Object.values(e).map(val => {
                if (typeof val === 'number') {
                    return String(val);
                }
                return this.csvEscape(val);
            }).join(',')
        );
        const csv = `${headers}\n${lines.join('\n')}`;

        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `MLR1_${symbol}_${timeframe}_Events.csv`;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        return true;
    }
}

export class DatasetAuditor {
    /**
     * Master Verification Suite:
     * 1. Row-level Contract & Numerical Integrity Audit
     * 2. Training Allowlist Leakage Audit
     * 3. Independent Candle-Level Execution Audit (verifying entry/exit against DataStore candles)
     */
    public static runCausalityAudit(events: MLR1EventRow[], dataStore?: any): boolean {
        console.log('🛡️ Running ML-R1 Comprehensive Contract & Integrity Audit...');
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
        let candleExecutionFailures = 0;

        const idSet = new Set<string>();
        const VALID_OUTCOMES = new Set(['full_target', 'hard_stop', 'timeout_net_gain', 'timeout_net_loss']);
        const ALLOWLIST_SET = new Set<string>(MLR1_REPRESENTATION_FEATURE_ALLOWLIST);

        for (let i = 0; i < events.length; i++) {
            const ev = events[i];

            // 1. Uniqueness
            if (idSet.has(ev.event_id)) duplicateFailures++;
            idSet.add(ev.event_id);

            // 2. Strict Chronology & Integer Timestamps
            if (i > 0) {
                if (ev.confirmation_time_ms <= events[i - 1].confirmation_time_ms) timeFailures++;
                if (ev.confirmed_bar_index <= events[i - 1].confirmed_bar_index) timeFailures++;
            }

            // 3. Exact next_open Causality Contract
            if (ev.entry_bar_index !== ev.confirmed_bar_index + 1) indexFailures++;
            if (ev.entry_time <= ev.confirmation_time_ms) indexFailures++;

            // 4. Exhaustive Anti-NaN Gate on all 24 numeric fields
            const requiredFiniteNumbers = [
                ev.pivot_price, ev.previous_pivot_price, ev.pivot_bar_index,
                ev.confirmed_bar_index, ev.confirmation_time_ms, ev.bars_since_last_pivot,
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
                ev.pivot_bar_index, ev.confirmed_bar_index, ev.confirmation_time_ms,
                ev.bars_since_last_pivot, ev.context_candle_count, ev.entry_bar_index, ev.entry_time
            ];
            for (let k = 0; k < requiredIntegerFields.length; k++) {
                if (!Number.isInteger(requiredIntegerFields[k])) mathFailures++;
            }

            if (ev.atr_at_confirmation <= 0 || ev.context_max_favorable_atr < 0 || ev.context_max_adverse_atr < 0) {
                mathFailures++;
            }

            // 5. Completed-Leg Direction Verification
            const expectedDir = ev.pivot_price > ev.previous_pivot_price ? 'up' : 
                               (ev.pivot_price < ev.previous_pivot_price ? 'down' : 'flat');
            if (ev.completed_leg_direction !== expectedDir) directionFailures++;

            // Categorical validation
            if (!['high', 'low'].includes(ev.pivot_type)) directionFailures++;
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

            // 12. Independent Candle-Level Execution Audit (if DataStore is supplied)
            if (dataStore && dataStore.length > 0) {
                const base = ev.entry_bar_index * 6;
                const candleOpen = dataStore.data[base + 1];
                if (Math.abs(ev.entry_price - candleOpen) > 0.0001) candleExecutionFailures++;

                // Verify timeout exit price exactly equals the close of bar entry_bar_index + 60 - 1
                const horizonBar = ev.entry_bar_index + 60 - 1;
                if (horizonBar < dataStore.length) {
                    const horizonClose = dataStore.data[horizonBar * 6 + 4];
                    if (ev.long_outcome.startsWith('timeout') && Math.abs(ev.long_exit_price - horizonClose) > 0.0001) {
                        candleExecutionFailures++;
                    }
                    if (ev.short_outcome.startsWith('timeout') && Math.abs(ev.short_exit_price - horizonClose) > 0.0001) {
                        candleExecutionFailures++;
                    }
                }
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
        if (dataStore && dataStore.length > 0) {
            console.log(`   ↳ Candle Execution Truth:${candleExecutionFailures === 0 ? '✅ PASSED' : '❌ FAILED'}`);
        }
        console.log(`=======================================`);

        if (timeFailures > 0 || indexFailures > 0 || mathFailures > 0 || duplicateFailures > 0 || 
            directionFailures > 0 || volumeFractionFailures > 0 || barrierGeometryFailures > 0 ||
            exitIntegrityFailures > 0 || outcomeMathFailures > 0 || timeoutClassFailures > 0 ||
            allowlistFailures > 0 || candleExecutionFailures > 0) {
            if (typeof alert !== 'undefined') alert(`⚠️ ML-R1 Audit Failed!\nCheck developer console.`);
            return false;
        }
        return true;
    }
}
