import type { DataStore } from './DataStore';

export interface StructuralBoxLike {
    leftBar: number;
    top: number;
    bottom: number;
    isOpen?: boolean;
    rightBar?: number;
    [key: string]: any;
}

export interface MLFeatureRow {
    timestamp: number;
    closePrice: number;
    atr: number;
    emaSmaSpreadPct: number;
    distToMacroTopAtr: number;
    distToMacroBotAtr: number;
    riskDistAtr: number;
    // Phase 2: Sequence Memory (N-Grams)
    event_t_minus_1: string;
    event_t_minus_2: string;
    event_t_minus_3: string;
    // Phase 2: Kinematics (Time & Speed)
    swing_duration_bars: number;
    swing_velocity_atr: number;
    [key: string]: any;
}

export interface ExportAIOptions {
    atrPeriod?: number;
    emaPeriod?: number;
    smaPeriod?: number;
    entryPrice?: number;
    stopLossPrice?: number;
    macroTop?: number | null;
    macroBot?: number | null;
    includeHeader?: boolean;
    // Phase 2: Box Kinematics & Signal series options
    activeMacroBox?: StructuralBoxLike | null;
    activeBoxesPerBar?: Array<StructuralBoxLike | null>;
    crossSignals?: Int8Array | number[];
    macroBreakUps?: boolean[] | Uint8Array;
    macroBreakDowns?: boolean[] | Uint8Array;
    cbcFlips?: Int8Array | number[]; // +1 = Bull flip, -1 = Bear flip
    signalsPerBar?: string[];
}

/**
 * Calculates a 14-period Average True Range using Wilder's Smoothing (RMA)
 * to match standard trading logic.
 */
export function calculateATRArray(dataStore: any, period: number = 14): Float64Array {
    const len = dataStore.length;
    const atr = new Float64Array(len);
    const tr = new Float64Array(len);
    if (len === 0) return atr;

    // 1. Calculate True Range (TR)
    tr[0] = dataStore.data[2] - dataStore.data[3]; // High - Low for first bar
    for (let i = 1; i < len; i++) {
        const base = i * 6;
        const prevC = dataStore.data[(i - 1) * 6 + 4]; // Previous Close
        const h = dataStore.data[base + 2];
        const l = dataStore.data[base + 3];

        tr[i] = Math.max(h - l, Math.abs(h - prevC), Math.abs(l - prevC));
    }

    // 2. Initial SMA for the first ATR value
    let sum = 0;
    for (let i = 0; i < period && i < len; i++) {
        sum += tr[i];
    }
    atr[period - 1] = sum / period;

    // 3. Wilder's Smoothing (RMA) for the rest
    for (let i = period; i < len; i++) {
        atr[i] = (atr[i - 1] * (period - 1) + tr[i]) / period;
    }

    // 4. Backfill warmup period to prevent NaNs/Zeros
    for (let i = 0; i < period - 1 && i < len; i++) {
        atr[i] = atr[period - 1] || tr[i] || 0.0001;
    }

    return atr;
}

/**
 * AI Exporter for generating stationary ML feature vectors, sequence memory, and kinematic datasets.
 */
export class AIExporter {
    public static readonly CSV_HEADERS = [
        'timestamp',
        'close',
        'atr',
        'ema_sma_spread_pct',
        'dist_to_macro_top_atr',
        'dist_to_macro_bot_atr',
        'risk_dist_atr',
        'event_t_minus_1',
        'event_t_minus_2',
        'event_t_minus_3',
        'swing_duration_bars',
        'swing_velocity_atr'
    ];

    /**
     * Extracts stationary ML feature records from dataStore and indicators.
     */
    public static extractFeatures(
        dataStore: DataStore,
        emaValues: Float64Array | number[],
        smaValues: Float64Array | number[],
        options: ExportAIOptions = {}
    ): MLFeatureRow[] {
        const len = dataStore.length;
        const rows: MLFeatureRow[] = [];
        if (len === 0) return rows;

        const period = options.atrPeriod ?? 14;
        const atrValues = calculateATRArray(dataStore, period);

        // Phase 2 Step 1: Rolling memory of the last 3 distinct signals (N-Grams)
        const eventLatch = ['NONE', 'NONE', 'NONE'];

        for (let i = 0; i < len; i++) {
            const base = i * 6;
            const timestamp = dataStore.data[base];
            const closePrice = dataStore.data[base + 4];

            // Extract current ATR (with fallback safety to prevent division by zero)
            const currentAtr = Math.max(atrValues[i] || 0, 0.000001);

            // 1. Percentage-based Moving Average Spread
            // Positive = EMA above SMA. Normalized by price so $100 and $0.15 assets scale identically.
            const emaVal = emaValues[i] !== undefined ? emaValues[i] : closePrice;
            const smaVal = smaValues[i] !== undefined ? smaValues[i] : closePrice;
            const emaSmaSpreadPct = closePrice !== 0 ? (emaVal - smaVal) / closePrice : 0;

            // Phase 2 Step 3: Structural box and kinematics calculation
            const activeMacroBox = options.activeBoxesPerBar ? options.activeBoxesPerBar[i] : (options.activeMacroBox ?? null);
            const macroTop = activeMacroBox ? activeMacroBox.top : (options.macroTop ?? 0);
            const macroBot = activeMacroBox ? activeMacroBox.bottom : (options.macroBot ?? 0);

            // Default kinematic values if no zone is active
            let swingDurationBars = 0;
            let swingVelocityAtr = 0;

            if (activeMacroBox) {
                // 1. DURATION: How many bars has this structure been forming/active?
                swingDurationBars = Math.max(1, i - activeMacroBox.leftBar);

                // 2. EXCURSION: The height of the box, normalized by ATR (Stationarity)
                const boxHeightAtr = Math.abs(macroTop - macroBot) / currentAtr;

                // 3. VELOCITY: Excursion / Time
                // We use Math.log1p (log(1 + x)) on duration to smooth out massive time horizons 
                // so a 500-bar chop zone doesn't mathematically crush the velocity to 0.
                const logDuration = Math.log1p(swingDurationBars);
                swingVelocityAtr = boxHeightAtr / logDuration;
            }

            // 2. ATR-Normalized Structural Distances
            // Expresses distance to support/resistance in terms of current market volatility
            const distToMacroTopAtr = macroTop ? ((macroTop - closePrice) / currentAtr) : 0;
            const distToMacroBotAtr = macroBot ? ((closePrice - macroBot) / currentAtr) : 0;

            // 3. ATR-Normalized Risk Distance (For Stop Loss)
            // Tells the AI "This stop loss is 1.5 ATRs wide", preventing regime-scaling issues
            const entryPrice = options.entryPrice ?? closePrice;
            const stopLossPrice = options.stopLossPrice ?? closePrice;
            const riskDistAtr = Math.abs(entryPrice - stopLossPrice) / currentAtr;

            // Phase 2 Step 2: Signal Detection & N-Gram Event Latch Update
            let currentSignal = 'NONE';
            if (options.signalsPerBar && options.signalsPerBar[i]) {
                currentSignal = options.signalsPerBar[i];
            } else {
                const crossSignal = options.crossSignals ? options.crossSignals[i] : 0;
                const isEmaSmaBullCross = crossSignal === 1;
                const isEmaSmaBearCross = crossSignal === -1;
                const isMacroBreakUp = options.macroBreakUps ? Boolean(options.macroBreakUps[i]) : false;
                const isMacroBreakDown = options.macroBreakDowns ? Boolean(options.macroBreakDowns[i]) : false;
                const cbcFlip = options.cbcFlips ? options.cbcFlips[i] : 0;
                const isStrictCbcBullFlip = cbcFlip === 1;
                const isStrictCbcBearFlip = cbcFlip === -1;

                if (isEmaSmaBullCross) currentSignal = 'BULL_CROSS';
                else if (isEmaSmaBearCross) currentSignal = 'BEAR_CROSS';
                else if (isMacroBreakUp) currentSignal = 'MACRO_BRK_UP';
                else if (isMacroBreakDown) currentSignal = 'MACRO_BRK_DN';
                else if (isStrictCbcBullFlip) currentSignal = 'CBC_BULL_FLIP';
                else if (isStrictCbcBearFlip) currentSignal = 'CBC_BEAR_FLIP';
            }

            // 1. SEQUENCE MEMORY: Update the latch if a valid signal occurred on THIS bar
            if (currentSignal !== 'NONE') {
                eventLatch.unshift(currentSignal); // Add new signal to the front
                eventLatch.pop();                  // Remove the oldest signal
            }

            // 2. Extract N-Gram features for the current row
            // Note: These represent the last 3 signals that happened UP TO and INCLUDING this bar.
            const event_t_minus_1 = eventLatch[0];
            const event_t_minus_2 = eventLatch[1];
            const event_t_minus_3 = eventLatch[2];

            rows.push({
                timestamp,
                closePrice,
                atr: atrValues[i],
                emaSmaSpreadPct,
                distToMacroTopAtr,
                distToMacroBotAtr,
                riskDistAtr,
                event_t_minus_1,
                event_t_minus_2,
                event_t_minus_3,
                swing_duration_bars: swingDurationBars,
                swing_velocity_atr: swingVelocityAtr
            });
        }

        return rows;
    }

    /**
     * Converts dataset rows to CSV format string.
     */
    public static toCSV(rows: MLFeatureRow[], includeHeader: boolean = true): string {
        const lines: string[] = [];
        if (includeHeader) {
            lines.push(this.CSV_HEADERS.join(','));
        }

        for (const row of rows) {
            lines.push([
                row.timestamp,
                row.closePrice.toFixed(6),
                row.atr.toFixed(6),
                row.emaSmaSpreadPct.toFixed(8),
                row.distToMacroTopAtr.toFixed(6),
                row.distToMacroBotAtr.toFixed(6),
                row.riskDistAtr.toFixed(6),
                row.event_t_minus_1,
                row.event_t_minus_2,
                row.event_t_minus_3,
                row.swing_duration_bars,
                row.swing_velocity_atr.toFixed(4)
            ].join(','));
        }

        return lines.join('\n');
    }

    /**
     * Triggers a browser download of the exported CSV file.
     */
    public static downloadCSV(csvContent: string, filename: string = 'ai_features_dataset.csv'): void {
        const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
        const link = document.createElement('a');
        const url = URL.createObjectURL(blob);
        link.setAttribute('href', url);
        link.setAttribute('download', filename);
        link.style.visibility = 'hidden';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
    }
}
