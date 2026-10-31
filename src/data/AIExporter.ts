export interface MLR1EventRow {
    event_id: string;
    symbol: string;
    timeframe: string;
    pivot_type: 'high' | 'low';
    pivot_label: string;
    pivot_price: number;
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
            
            // Issue B Fix: Measure maturity using explicit mask, not volSma[i] > 0
            if (volValidMask[i] === 1) {
                matureCount++;
                if (volSma[i] > 0) {
                    volSum += dataStore.data[base + 5];
                    volSmaSum += volSma[i];
                }
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

        // Issues A & E Fix: Exclude index 0 (no completed leg, unbounded context)
        for (let i = 1; i < cachedPivots.length; i++) {
            const pivot = cachedPivots[i];
            const prevPivot = cachedPivots[i - 1];
            const confBar = pivot.confirmedBarIndex;
            const entryBar = confBar + 1; // Strict rule: next_open

            if (entryBar >= len) continue;

            // Issue D Fix: Enforce validated confirmation ATR; zero fallback permitted
            const currentAtr = atrRaw[confBar];
            if (confBar < ATR_PERIOD - 1 || !Number.isFinite(currentAtr) || currentAtr <= 0) {
                continue; 
            }

            // Issue A Fix: Exactly 60 bars inclusive [entryBar .. entryBar + 59]
            const horizonEnd = entryBar + MAX_HORIZON_BARS - 1;
            if (horizonEnd >= len) {
                continue; // Censor incomplete horizons
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

            events.push({
                event_id: `MLR1_${symbol}_${timeframe}_${indVersion}_${dataStore.data[confBar * 6]}_${pivot.time}_${pivot.type}`,
                symbol, timeframe,
                pivot_type: pivot.type,
                pivot_label: pivot.label,
                pivot_price: parseFloat(pivot.price.toFixed(4)),
                pivot_bar_index: pivot.barIndex,
                confirmed_bar_index: confBar,
                confirmation_time_ms: dataStore.data[confBar * 6],
                
                completed_leg_direction: tokenFeatures.completed_leg_direction,
                zigzag_next_leg_orientation: tokenFeatures.zigzag_next_leg_orientation,
                bars_since_last_pivot: tokenFeatures.bars_since_last_pivot,
                leg_distance_atr: parseFloat(tokenFeatures.leg_distance_atr.toFixed(4)),
                
                context_net_return_atr: parseFloat(tokenFeatures.context_net_return_atr.toFixed(4)),
                context_max_favorable_atr: parseFloat(tokenFeatures.context_max_favorable_atr.toFixed(4)),
                context_max_adverse_atr: parseFloat(tokenFeatures.context_max_adverse_atr.toFixed(4)),
                context_candle_count: tokenFeatures.context_candle_count,
                context_relative_volume: parseFloat(tokenFeatures.context_relative_volume.toFixed(4)),
                context_relative_volume_valid_fraction: parseFloat(tokenFeatures.context_relative_volume_valid_fraction.toFixed(4)),

                entry_bar_index: entryBar,
                entry_time: entryTime,
                entry_price: entryOpen,
                atr_at_confirmation: parseFloat(currentAtr.toFixed(4)),
                
                long_stop_price: parseFloat(lStop.toFixed(4)),
                long_target_price: parseFloat(lTarget.toFixed(4)),
                long_exit_price: parseFloat(lExitPrice.toFixed(4)),
                long_net_r: parseFloat(lNetR.toFixed(4)),
                long_outcome,

                short_stop_price: parseFloat(sStop.toFixed(4)),
                short_target_price: parseFloat(sTarget.toFixed(4)),
                short_exit_price: parseFloat(sExitPrice.toFixed(4)),
                short_net_r: parseFloat(sNetR.toFixed(4)),
                short_outcome
            });
        }
        return events;
    }

    public static exportMLR1CSV(events: MLR1EventRow[], symbol: string, timeframe: string): boolean {
        if (typeof document === 'undefined' || events.length === 0) return false;

        const headers = Object.keys(events[0]).join(',');
        const lines = events.map(e => Object.values(e).join(','));
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
    public static runCausalityAudit(events: MLR1EventRow[]): boolean {
        console.log('🛡️ Running ML-R1 Comprehensive Dataset Audit...');
        let timeFailures = 0;
        let indexFailures = 0;
        let mathFailures = 0;
        let duplicateFailures = 0;
        let directionFailures = 0;
        let volumeFractionFailures = 0;
        let outcomeMathFailures = 0;
        let timeoutClassFailures = 0;
        const idSet = new Set<string>();

        for (let i = 0; i < events.length; i++) {
            const ev = events[i];

            // 1. Uniqueness
            if (idSet.has(ev.event_id)) duplicateFailures++;
            idSet.add(ev.event_id);

            // 2. Strict Chronology
            if (i > 0 && ev.confirmation_time_ms < events[i - 1].confirmation_time_ms) {
                timeFailures++;
            }

            // 3. Execution Causality (next_open strictly after confirmation)
            if (ev.entry_bar_index <= ev.confirmed_bar_index) indexFailures++;
            if (ev.entry_time <= ev.confirmation_time_ms) indexFailures++;

            // 4. Completed-Leg Mathematical Verification (Issue C)
            if (i > 0) {
                const prevPivotPrice = events[i - 1].pivot_price;
                const expectedDir = ev.pivot_price > prevPivotPrice ? 'up' : (ev.pivot_price < prevPivotPrice ? 'down' : 'flat');
                if (ev.completed_leg_direction !== expectedDir) directionFailures++;
            }

            // 5. Orientation Integrity
            if (ev.pivot_type === 'high' && ev.zigzag_next_leg_orientation !== 'down') directionFailures++;
            if (ev.pivot_type === 'low' && ev.zigzag_next_leg_orientation !== 'up') directionFailures++;

            // 6. Volume Valid Fraction [0.0, 1.0] and Sentinel Agreement
            if (ev.context_relative_volume_valid_fraction < 0 || ev.context_relative_volume_valid_fraction > 1.0) {
                volumeFractionFailures++;
            }
            if (ev.context_relative_volume_valid_fraction === 0 && ev.context_relative_volume !== -1.0) {
                volumeFractionFailures++;
            }

            // 7. Math Sanity on Input Features
            if (!Number.isFinite(ev.atr_at_confirmation) || ev.atr_at_confirmation <= 0) mathFailures++;
            if (!Number.isFinite(ev.leg_distance_atr)) mathFailures++;
            if (!Number.isFinite(ev.context_net_return_atr)) mathFailures++;
            if (!Number.isFinite(ev.context_max_favorable_atr) || ev.context_max_favorable_atr < 0) mathFailures++;
            if (!Number.isFinite(ev.context_max_adverse_atr) || ev.context_max_adverse_atr < 0) mathFailures++;

            // 8. Outcome Math Agreement (Issue E)
            const lRisk = ev.entry_price - ev.long_stop_price;
            const expectedLongNetR = Math.min(2.0, (ev.long_exit_price - ev.entry_price) / lRisk) - 0.05;
            if (Math.abs(expectedLongNetR - ev.long_net_r) > 0.01) outcomeMathFailures++;

            const sRisk = ev.short_stop_price - ev.entry_price;
            const expectedShortNetR = Math.min(2.0, (ev.entry_price - ev.short_exit_price) / sRisk) - 0.05;
            if (Math.abs(expectedShortNetR - ev.short_net_r) > 0.01) outcomeMathFailures++;

            // 9. Timeout Classification Check (Issue D)
            if (ev.long_outcome === 'timeout_net_gain' && ev.long_net_r <= 0) timeoutClassFailures++;
            if (ev.long_outcome === 'timeout_net_loss' && ev.long_net_r > 0) timeoutClassFailures++;
            if (ev.short_outcome === 'timeout_net_gain' && ev.short_net_r <= 0) timeoutClassFailures++;
            if (ev.short_outcome === 'timeout_net_loss' && ev.short_net_r > 0) timeoutClassFailures++;
        }

        console.log(`=======================================`);
        console.log(`📊 ML-R1 AUDIT PASS: ${events.length} Events Checked`);
        console.log(`   ↳ Chronology:          ${timeFailures === 0 ? '✅ PASSED' : '❌ FAILED'}`);
        console.log(`   ↳ Causality:           ${indexFailures === 0 ? '✅ PASSED' : '❌ FAILED'}`);
        console.log(`   ↳ Event Uniqueness:    ${duplicateFailures === 0 ? '✅ PASSED' : '❌ FAILED'}`);
        console.log(`   ↳ Direction Math:      ${directionFailures === 0 ? '✅ PASSED' : '❌ FAILED'}`);
        console.log(`   ↳ Volume Fractions:    ${volumeFractionFailures === 0 ? '✅ PASSED' : '❌ FAILED'}`);
        console.log(`   ↳ Feature Math Health: ${mathFailures === 0 ? '✅ PASSED' : '❌ FAILED'}`);
        console.log(`   ↳ Outcome Net R Math:  ${outcomeMathFailures === 0 ? '✅ PASSED' : '❌ FAILED'}`);
        console.log(`   ↳ Timeout Net Classes: ${timeoutClassFailures === 0 ? '✅ PASSED' : '❌ FAILED'}`);
        console.log(`=======================================`);

        if (timeFailures > 0 || indexFailures > 0 || mathFailures > 0 || duplicateFailures > 0 || 
            directionFailures > 0 || volumeFractionFailures > 0 || outcomeMathFailures > 0 || timeoutClassFailures > 0) {
            if (typeof alert !== 'undefined') alert(`⚠️ ML-R1 Audit Failed!\nCheck developer console.`);
            return false;
        }
        return true;
    }
}
