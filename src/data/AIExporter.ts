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

    // Structural Features
    leg_direction: 'up' | 'down';
    bars_since_last_pivot: number;
    leg_distance_atr: number;

    // Causal Candle Context
    context_net_return_atr: number;
    context_max_favorable_atr: number; // Replaced single excursion
    context_max_adverse_atr: number;   // Replaced single excursion
    context_candle_count: number;
    context_relative_volume: number;   // Replaced raw SMA avg
    
    // Execution (Frozen next_open)
    entry_bar_index: number;
    entry_time: number;
    entry_price: number;
    atr_at_confirmation: number;
    
    // Counterfactual 1: LONG
    long_stop_price: number;
    long_target_price: number;
    long_exit_price: number;
    long_net_r: number;
    long_outcome: 'full_target' | 'hard_stop' | 'timeout_gain' | 'timeout_loss';
    
    // Counterfactual 2: SHORT
    short_stop_price: number;
    short_target_price: number;
    short_exit_price: number;
    short_net_r: number;
    short_outcome: 'full_target' | 'hard_stop' | 'timeout_gain' | 'timeout_loss';
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

        // NO BACKFILLING: Keep warm-up period as 0 to prevent lookahead bias.
        for (let i = 0; i < period - 1 && i < len; i++) {
            atr[i] = 0; 
        }
        return atr;
    }

    public static calculateVolumeSMAArray(dataStore: any, period: number = 20): Float64Array {
        const len = dataStore.length;
        const result = new Float64Array(len).fill(0);
        if (len < period) return result;

        let sum = 0;
        for (let i = 0; i < period; i++) {
            sum += dataStore.data[i * 6 + 5];
        }
        result[period - 1] = sum / period;

        for (let i = period; i < len; i++) {
            sum += dataStore.data[i * 6 + 5] - dataStore.data[(i - period) * 6 + 5];
            result[i] = sum / period;
        }
        return result;
    }
}

export class CandleContextAggregator {
    public static summarize(
        dataStore: any, 
        startBar: number, 
        endBar: number, 
        currentAtr: number,
        volSma: Float64Array
    ) {
        if (startBar > endBar || currentAtr <= 0) {
            return { netReturnAtr: 0, maxFavorableAtr: 0, maxAdverseAtr: 0, count: 0, relativeVolume: 1.0 };
        }

        const startOpen = dataStore.data[startBar * 6 + 1];
        const endClose = dataStore.data[endBar * 6 + 4];
        let maxH = -Infinity;
        let minL = Infinity;
        
        let validVolCount = 0;
        let volSum = 0;
        let volSmaSum = 0;
        
        for (let i = startBar; i <= endBar; i++) {
            const base = i * 6;
            if (dataStore.data[base + 2] > maxH) maxH = dataStore.data[base + 2];
            if (dataStore.data[base + 3] < minL) minL = dataStore.data[base + 3];
            
            if (volSma[i] > 0) {
                validVolCount++;
                volSum += dataStore.data[base + 5];
                volSmaSum += volSma[i];
            }
        }

        const count = endBar - startBar + 1;
        const netReturnAtr = (endClose - startOpen) / currentAtr;
        const maxFavorableAtr = (maxH - startOpen) / currentAtr;
        const maxAdverseAtr = (startOpen - minL) / currentAtr; // Kept as positive distance for adverse scale
        const relativeVolume = (validVolCount > 0 && volSmaSum > 0) ? (volSum / volSmaSum) : 1.0;

        return {
            netReturnAtr,
            maxFavorableAtr,
            maxAdverseAtr,
            count,
            relativeVolume
        };
    }
}

export class HybridTokenBuilder {
    public static build(
        event: any, 
        prevEvent: any, 
        dataStore: any, 
        atrRaw: Float64Array, 
        volSmaRaw: Float64Array
    ) {
        const confBar = event.confirmedBarIndex;
        const prevConfBar = prevEvent ? prevEvent.confirmedBarIndex : 0;
        const currentAtr = atrRaw[confBar] || 0.0001;
        
        const barsSinceLast = confBar - prevConfBar;
        const legDistAtr = prevEvent ? (event.price - prevEvent.price) / currentAtr : 0;

        const contextStart = prevEvent ? prevEvent.confirmedBarIndex + 1 : 0;
        const contextEnd = confBar; 
        
        const ctx = CandleContextAggregator.summarize(dataStore, contextStart, contextEnd, currentAtr, volSmaRaw);

        return {
            bars_since_last_pivot: barsSinceLast,
            leg_distance_atr: legDistAtr,
            context_net_return_atr: ctx.netReturnAtr,
            context_max_favorable_atr: ctx.maxFavorableAtr,
            context_max_adverse_atr: ctx.maxAdverseAtr,
            context_candle_count: ctx.count,
            context_relative_volume: ctx.relativeVolume
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
        const volSmaRaw = MarketFeatureEngine.calculateVolumeSMAArray(dataStore, 20);
        const events: MLR1EventRow[] = [];

        // Stable Indentity Prefix capturing the frozen config
        const indVersion = `v2_ATR${ATR_PERIOD}_SL${STOP_ATR_MULT}_TP${TARGET_R_MULT}_HZ${MAX_HORIZON_BARS}`;

        for (let i = 0; i < cachedPivots.length; i++) {
            const pivot = cachedPivots[i];
            const confBar = pivot.confirmedBarIndex;
            const entryBar = confBar + 1; // Strict rule: next_open

            // 🛑 EXCLUSION 1: Cannot evaluate if the entry candle doesn't exist yet
            if (entryBar >= len) continue;

            // 🛑 EXCLUSION 2: ATR Warm-up filter. 
            const currentAtr = atrRaw[confBar];
            if (confBar < ATR_PERIOD - 1 || !Number.isFinite(currentAtr) || currentAtr <= 0) {
                continue; // Exclude event completely; never fabricate features.
            }

            // 🛑 EXCLUSION 3: Incomplete Outcome Censorship
            const horizonEnd = entryBar + MAX_HORIZON_BARS;
            if (horizonEnd >= len) {
                // Dataset ends before the 60-bar horizon fully matures. Skip to prevent bias.
                continue; 
            }

            const entryTime = dataStore.data[entryBar * 6];
            const entryOpen = dataStore.data[entryBar * 6 + 1];

            // --- 1. HYBRID TOKEN BUILDING ---
            const prevPivot = i > 0 ? cachedPivots[i - 1] : null;
            const tokenFeatures = HybridTokenBuilder.build(pivot, prevPivot, dataStore, atrRaw, volSmaRaw);

            // --- 2. OUTCOME ENGINE (Frozen Counterfactuals) ---
            const lStop = entryOpen - (currentAtr * STOP_ATR_MULT);
            const lTarget = entryOpen + (currentAtr * STOP_ATR_MULT * TARGET_R_MULT);
            const lRisk = entryOpen - lStop;

            const sStop = entryOpen + (currentAtr * STOP_ATR_MULT);
            const sTarget = entryOpen - (currentAtr * STOP_ATR_MULT * TARGET_R_MULT);
            const sRisk = sStop - entryOpen;

            let lExitPrice = entryOpen, lOutcome: any = 'timeout_loss', lResolved = false;
            let sExitPrice = entryOpen, sOutcome: any = 'timeout_loss', sResolved = false;

            for (let f = entryBar; f <= horizonEnd; f++) {
                const base = f * 6;
                const fOpen = dataStore.data[base + 1];
                const fHigh = dataStore.data[base + 2];
                const fLow = dataStore.data[base + 3];
                const fClose = dataStore.data[base + 4];

                // LONG Counterfactual
                if (!lResolved) {
                    if (fOpen <= lStop) { lExitPrice = fOpen; lOutcome = 'hard_stop'; lResolved = true; }
                    else if (fOpen >= lTarget) { lExitPrice = fOpen; lOutcome = 'full_target'; lResolved = true; }
                    else {
                        const hitSL = fLow <= lStop;
                        const hitTP = fHigh >= lTarget;
                        if (hitSL && hitTP) { lExitPrice = lStop; lOutcome = 'hard_stop'; lResolved = true; } 
                        else if (hitSL) { lExitPrice = lStop; lOutcome = 'hard_stop'; lResolved = true; }
                        else if (hitTP) { lExitPrice = lTarget; lOutcome = 'full_target'; lResolved = true; }
                    }
                    if (!lResolved && f === horizonEnd) {
                        lExitPrice = fClose; 
                        lOutcome = lExitPrice > entryOpen ? 'timeout_gain' : 'timeout_loss';
                        lResolved = true;
                    }
                }

                // SHORT Counterfactual
                if (!sResolved) {
                    if (fOpen >= sStop) { sExitPrice = fOpen; sOutcome = 'hard_stop'; sResolved = true; }
                    else if (fOpen <= sTarget) { sExitPrice = fOpen; sOutcome = 'full_target'; sResolved = true; }
                    else {
                        const hitSL = fHigh >= sStop;
                        const hitTP = fLow <= sTarget;
                        if (hitSL && hitTP) { sExitPrice = sStop; sOutcome = 'hard_stop'; sResolved = true; } 
                        else if (hitSL) { sExitPrice = sStop; sOutcome = 'hard_stop'; sResolved = true; }
                        else if (hitTP) { sExitPrice = sTarget; sOutcome = 'full_target'; sResolved = true; }
                    }
                    if (!sResolved && f === horizonEnd) {
                        sExitPrice = fClose; 
                        sOutcome = sExitPrice < entryOpen ? 'timeout_gain' : 'timeout_loss';
                        sResolved = true;
                    }
                }
                if (lResolved && sResolved) break;
            }

            const lGrossR = (lExitPrice - entryOpen) / lRisk;
            const lNetR = Math.min(TARGET_R_MULT, lGrossR) - TRADE_COST_R;

            const sGrossR = (entryOpen - sExitPrice) / sRisk;
            const sNetR = Math.min(TARGET_R_MULT, sGrossR) - TRADE_COST_R;

            // --- 3. ROW ASSEMBLY ---
            events.push({
                event_id: `MLR1_${symbol}_${timeframe}_${indVersion}_${dataStore.data[confBar * 6]}_${pivot.time}_${pivot.type}`,
                symbol, timeframe,
                pivot_type: pivot.type,
                pivot_label: pivot.label,
                pivot_price: parseFloat(pivot.price.toFixed(4)),
                pivot_bar_index: pivot.barIndex,
                confirmed_bar_index: confBar,
                confirmation_time_ms: dataStore.data[confBar * 6],
                
                leg_direction: pivot.type === 'high' ? 'down' : 'up',
                bars_since_last_pivot: tokenFeatures.bars_since_last_pivot,
                leg_distance_atr: parseFloat(tokenFeatures.leg_distance_atr.toFixed(4)),
                
                context_net_return_atr: parseFloat(tokenFeatures.context_net_return_atr.toFixed(4)),
                context_max_favorable_atr: parseFloat(tokenFeatures.context_max_favorable_atr.toFixed(4)),
                context_max_adverse_atr: parseFloat(tokenFeatures.context_max_adverse_atr.toFixed(4)),
                context_candle_count: tokenFeatures.context_candle_count,
                context_relative_volume: parseFloat(tokenFeatures.context_relative_volume.toFixed(4)),

                entry_bar_index: entryBar,
                entry_time: entryTime,
                entry_price: entryOpen,
                atr_at_confirmation: parseFloat(currentAtr.toFixed(4)),
                
                long_stop_price: parseFloat(lStop.toFixed(4)),
                long_target_price: parseFloat(lTarget.toFixed(4)),
                long_exit_price: parseFloat(lExitPrice.toFixed(4)),
                long_net_r: parseFloat(lNetR.toFixed(4)),
                long_outcome: lOutcome,

                short_stop_price: parseFloat(sStop.toFixed(4)),
                short_target_price: parseFloat(sTarget.toFixed(4)),
                short_exit_price: parseFloat(sExitPrice.toFixed(4)),
                short_net_r: parseFloat(sNetR.toFixed(4)),
                short_outcome: sOutcome
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
        console.log('🛡️ Running ML-R1 Causality Audit...');
        let timeFailures = 0;
        let indexFailures = 0;
        let mathFailures = 0;
        let duplicateFailures = 0;
        let leakFailures = 0;
        const idSet = new Set<string>();

        for (let i = 0; i < events.length; i++) {
            const ev = events[i];

            // 1. Uniqueness Check
            if (idSet.has(ev.event_id)) duplicateFailures++;
            idSet.add(ev.event_id);

            // 2. Chronology Check
            if (i > 0 && ev.confirmation_time_ms < events[i - 1].confirmation_time_ms) {
                timeFailures++;
            }

            // 3. Causality Check (Entry MUST be strictly after confirmation)
            if (ev.entry_bar_index <= ev.confirmed_bar_index) indexFailures++;

            // 4. Leakage Check (No outcome metadata slipping into input features)
            // (Enforced implicitly via typing, but double checking entry dependencies)
            if (ev.entry_time <= ev.confirmation_time_ms) {
                leakFailures++;
                indexFailures++;
            }

            // 5. Math Health (No NaNs/Infinities from ATR bugs or div/0)
            if (!Number.isFinite(ev.atr_at_confirmation) || ev.atr_at_confirmation <= 0) mathFailures++;
            if (!Number.isFinite(ev.leg_distance_atr)) mathFailures++;
            if (!Number.isFinite(ev.context_relative_volume)) mathFailures++;
        }

        console.log(`=======================================`);
        console.log(`📊 PRE-FLIGHT AUDIT: ${events.length} Events Evaluated`);
        console.log(`   ↳ Timeline (Chronological):  ${timeFailures === 0 ? '✅ PASSED' : '❌ FAILED'}`);
        console.log(`   ↳ Causality (Next Open):     ${indexFailures === 0 ? '✅ PASSED' : '❌ FAILED'}`);
        console.log(`   ↳ Identity (No Duplicates):  ${duplicateFailures === 0 ? '✅ PASSED' : '❌ FAILED'}`);
        console.log(`   ↳ Math Health (Valid Feat.): ${mathFailures === 0 ? '✅ PASSED' : '❌ FAILED'}`);
        console.log(`=======================================`);

        if (timeFailures > 0 || indexFailures > 0 || mathFailures > 0 || duplicateFailures > 0 || leakFailures > 0) {
            if (typeof alert !== 'undefined') alert(`⚠️ ML-R1 Audit Failed!\nCheck developer console for causality/math errors.`);
            return false;
        }
        return true;
    }
}
