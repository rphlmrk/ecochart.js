import type { DataStore } from './DataStore';

export interface StructuralBoxLike {
    leftBar: number;
    top: number;
    bottom: number;
    isOpen?: boolean;
    rightBar?: number;
    [key: string]: any;
}

export interface GhostHorizons {
    mfe_5: number;
    mae_5: number;
    mfe_15: number;
    mae_15: number;
    mfe_30: number;
    mae_30: number;
}

export interface MLFeatureRow {
    timestamp: number;
    signal: string;
    outcome?: number;
    bars_to_resolution?: number;
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
    // Phase 3: The Ghost Engine (Continuous Future Targets)
    mfe_5_bars: number;
    mae_5_bars: number;
    mfe_15_bars: number;
    mae_15_bars: number;
    mfe_30_bars: number;
    mae_30_bars: number;
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
    signalsOnly?: boolean; // When true (default), exports rows where signal !== 'NONE'
    outcomesPerBar?: number[];
    barsToResolutionPerBar?: number[];
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
 * Phase 3: The Ghost Engine Look-Ahead Function
 * Evaluates future candles up to 30 bars to compute Maximum Favorable Excursion (MFE)
 * and Maximum Adverse Excursion (MAE) normalized by current ATR.
 */
export function calculateGhostHorizons(
    dataStore: any,
    currentIndex: number,
    entryPrice: number,
    direction: 'LONG' | 'SHORT',
    currentAtr: number
): GhostHorizons {
    const len = dataStore.length;

    // Initialize tracking variables with the entry price
    let maxHigh5 = entryPrice, minLow5 = entryPrice;
    let maxHigh15 = entryPrice, minLow15 = entryPrice;
    let maxHigh30 = entryPrice, minLow30 = entryPrice;

    // Ensure we don't look past the end of the available historical data
    const end5 = Math.min(currentIndex + 5, len - 1);
    const end15 = Math.min(currentIndex + 15, len - 1);
    const end30 = Math.min(currentIndex + 30, len - 1);

    // Loop forward in time up to 30 bars
    for (let i = currentIndex + 1; i <= end30; i++) {
        const high = dataStore.data[i * 6 + 2];
        const low = dataStore.data[i * 6 + 3];

        // Track extremes for the 5-bar horizon
        if (i <= end5) {
            if (high > maxHigh5) maxHigh5 = high;
            if (low < minLow5) minLow5 = low;
        }
        // Track extremes for the 15-bar horizon
        if (i <= end15) {
            if (high > maxHigh15) maxHigh15 = high;
            if (low < minLow15) minLow15 = low;
        }
        // Track extremes for the 30-bar horizon
        if (i <= end30) {
            if (high > maxHigh30) maxHigh30 = high;
            if (low < minLow30) minLow30 = low;
        }
    }

    // Calculate MFE (Favorable) and MAE (Adverse) as positive ATR-multiples
    let mfe5: number, mae5: number, mfe15: number, mae15: number, mfe30: number, mae30: number;

    // Normalize distances by ATR so AI targets are stationary (e.g., "Moved +1.5 ATRs")
    const safeAtr = Math.max(currentAtr, 0.000001);

    if (direction === 'LONG') {
        mfe5 = (maxHigh5 - entryPrice) / safeAtr;
        mae5 = (entryPrice - minLow5) / safeAtr;
        mfe15 = (maxHigh15 - entryPrice) / safeAtr;
        mae15 = (entryPrice - minLow15) / safeAtr;
        mfe30 = (maxHigh30 - entryPrice) / safeAtr;
        mae30 = (entryPrice - minLow30) / safeAtr;
    } else {
        // SHORT logic is inverted
        mfe5 = (entryPrice - minLow5) / safeAtr;
        mae5 = (maxHigh5 - entryPrice) / safeAtr;
        mfe15 = (entryPrice - minLow15) / safeAtr;
        mae15 = (maxHigh15 - entryPrice) / safeAtr;
        mfe30 = (entryPrice - minLow30) / safeAtr;
        mae30 = (maxHigh30 - entryPrice) / safeAtr;
    }

    return {
        mfe_5: mfe5, mae_5: mae5,
        mfe_15: mfe15, mae_15: mae15,
        mfe_30: mfe30, mae_30: mae30
    };
}

/**
 * AI Exporter for generating stationary ML feature vectors, sequence memory, kinematics,
 * and Ghost Engine look-ahead excursion targets.
 */
export class AIExporter {
    public static readonly CSV_HEADERS = [
        'timestamp',
        'signal',
        'outcome',
        'bars_to_resolution',
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
        'swing_velocity_atr',
        'mfe_5_bars',
        'mae_5_bars',
        'mfe_15_bars',
        'mae_15_bars',
        'mfe_30_bars',
        'mae_30_bars'
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
        const signalsOnly = options.signalsOnly ?? false;

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

            // If filtering to signals only and current candle has no signal, skip forward
            if (signalsOnly && currentSignal === 'NONE') {
                continue;
            }

            // 2. Extract N-Gram features for the current row
            // Note: These represent the last 3 signals that happened UP TO and INCLUDING this bar.
            const event_t_minus_1 = eventLatch[0];
            const event_t_minus_2 = eventLatch[1];
            const event_t_minus_3 = eventLatch[2];

            // Phase 3: The Ghost Engine Look-Ahead
            let ghosts: GhostHorizons = {
                mfe_5: 0, mae_5: 0,
                mfe_15: 0, mae_15: 0,
                mfe_30: 0, mae_30: 0
            };

            if (currentSignal !== 'NONE') {
                // Determine the intended direction of the trade based on signal
                const tradeDirection = (currentSignal === 'BULL_CROSS' || currentSignal.includes('UP') || currentSignal.includes('BULL'))
                    ? 'LONG'
                    : 'SHORT';

                ghosts = calculateGhostHorizons(
                    dataStore,
                    i,
                    closePrice,
                    tradeDirection,
                    currentAtr
                );
            }

            const outcome = options.outcomesPerBar ? options.outcomesPerBar[i] : 0;
            const barsToResolution = options.barsToResolutionPerBar ? options.barsToResolutionPerBar[i] : 0;

            rows.push({
                timestamp,
                signal: currentSignal,
                outcome,
                bars_to_resolution: barsToResolution,
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
                swing_velocity_atr: swingVelocityAtr,
                mfe_5_bars: ghosts.mfe_5,
                mae_5_bars: ghosts.mae_5,
                mfe_15_bars: ghosts.mfe_15,
                mae_15_bars: ghosts.mae_15,
                mfe_30_bars: ghosts.mfe_30,
                mae_30_bars: ghosts.mae_30
            });
        }

        return rows;
    }

    /**
     * Converts dataset rows to CSV format string.
     */
    /**
     * Converts dataset rows to an array of CSV row strings (without headers).
     */
    public static toCSVRows(rows: MLFeatureRow[]): string[] {
        return rows.map(row => [
            row.timestamp,
            row.signal,
            row.outcome !== undefined ? row.outcome : 0,
            row.bars_to_resolution !== undefined ? row.bars_to_resolution : 0,
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
            row.swing_velocity_atr.toFixed(4),
            row.mfe_5_bars.toFixed(4),
            row.mae_5_bars.toFixed(4),
            row.mfe_15_bars.toFixed(4),
            row.mae_15_bars.toFixed(4),
            row.mfe_30_bars.toFixed(4),
            row.mae_30_bars.toFixed(4)
        ].join(','));
    }

    /**
     * Converts dataset rows to CSV format string.
     */
    public static toCSV(rows: MLFeatureRow[], includeHeader: boolean = true): string {
        const lines: string[] = [];
        if (includeHeader) {
            lines.push(this.CSV_HEADERS.join(','));
        }
        lines.push(...this.toCSVRows(rows));
        return lines.join('\n');
    }

    /**
     * Phase 4: Triggers a browser download of the exported CSV file after passing Pre-Flight Audit.
     * Can accept either raw csvRows array (without header) or complete csvContent string.
     */
    public static downloadCSV(
        csvInput: string | string[],
        filename: string = `training_data_${Date.now()}.csv`,
        csvHeaders: string = this.CSV_HEADERS.join(',')
    ): boolean {
        let rowsToAudit: string[];
        let fullCsvContent: string;

        if (Array.isArray(csvInput)) {
            rowsToAudit = csvInput;
            fullCsvContent = csvHeaders + '\n' + csvInput.join('\n');
        } else {
            const allLines = csvInput.split(/\r?\n/).filter(line => line.trim().length > 0);
            if (allLines.length > 0 && allLines[0].includes('timestamp')) {
                rowsToAudit = allLines.slice(1);
                fullCsvContent = csvInput;
            } else {
                rowsToAudit = allLines;
                fullCsvContent = csvHeaders + '\n' + csvInput;
            }
        }

        // Run Pre-Flight Audit check
        const isDatasetPure = runPreFlightAudit(rowsToAudit);

        // ONLY DOWNLOAD IF AUDIT PASSES
        if (isDatasetPure) {
            if (typeof document !== 'undefined') {
                const blob = new Blob([fullCsvContent], { type: 'text/csv;charset=utf-8;' });
                const url = URL.createObjectURL(blob);

                const a = document.createElement('a');
                a.href = url;
                a.download = filename;
                a.style.visibility = 'hidden';
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
            }

            console.log('✅ Dataset exported successfully.');
            return true;
        } else {
            console.error('❌ Dataset export blocked by Pre-Flight Audit to prevent corrupt AI training.');
            return false;
        }
    }
}

/**
 * Phase 4: Pre-Flight Audit Function
 * Scans generated dataset in memory before download to verify chronological timeline,
 * math health (detecting NaNs, Infinities), and class balance.
 */
export function runPreFlightAudit(csvRows: string[]): boolean {
    console.log('🛡️ Running Pre-Flight Data Audit...');

    let timeFailures = 0;
    let mathFailures = 0;
    let winCount = 0;
    let totalSignals = csvRows.length;
    let lastTimestamp = -1;

    for (let i = 0; i < csvRows.length; i++) {
        const cols = csvRows[i].split(',');

        // 1. TIMELINE GATE (Assumes Timestamp is the 1st column: cols[0])
        const ts = parseFloat(cols[0]);
        if (lastTimestamp !== -1 && ts <= lastTimestamp) {
            timeFailures++;
        }
        lastTimestamp = ts;

        // 2. MATH GATE: Catch NaN, Infinity, -Infinity
        for (let j = 0; j < cols.length; j++) {
            const strVal = cols[j].trim();
            // Skip non-numeric string columns (like 'BULL_CROSS')
            if (strVal !== '' && !isNaN(Number(strVal))) {
                const numVal = parseFloat(strVal);
                if (!isFinite(numVal)) {
                    mathFailures++;
                }
            }
        }

        // 3. CLASS IMBALANCE GATE (Assumes 'outcome' is the 3rd column: cols[2])
        // Adjust the index [2] if your outcome column is located elsewhere!
        if (cols[2] === '1') {
            winCount++;
        }
    }

    const winRate = totalSignals > 0 ? (winCount / totalSignals) * 100 : 0;

    // Print Report to Console
    console.log(`=======================================`);
    console.log(`📊 PRE-FLIGHT AUDIT: ${totalSignals} Signals Processed`);
    console.log(`   ↳ Timeline (Lookahead Bias): ${timeFailures === 0 ? '✅ PASSED' : `❌ FAILED (${timeFailures} errors)`}`);
    console.log(`   ↳ Math Health (NaN/Inf):     ${mathFailures === 0 ? '✅ PASSED' : `❌ FAILED (${mathFailures} errors)`}`);
    console.log(`   ↳ Class Balance (Win Rate):  ${winRate.toFixed(2)}% ${winRate < 5 ? '⚠️ WARNING: Severe Imbalance' : '✅ PASSED'}`);
    console.log(`=======================================`);

    // If critical errors exist, trigger browser alert and block download
    if (timeFailures > 0 || mathFailures > 0) {
        if (typeof alert !== 'undefined') {
            alert(`⚠️ Dataset Audit Failed!\n\nTimeline Errors: ${timeFailures}\nMath Errors (NaN/Inf): ${mathFailures}\n\nCheck console for details. Download aborted.`);
        }
        return false;
    }

    return true; // Dataset is pure, allow download
}
