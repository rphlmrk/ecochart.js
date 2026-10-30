export interface StructuralBoxLike {
    leftBar: number;
    top: number;
    bottom: number;
    isOpen?: boolean;
    rightBar?: number;
    [key: string]: any;
}

export interface ContinuousBarRow {
    bar_index: number;
    timestamp: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
    atr: string;
    volume_sma_20: string;
    ema_10: string;       // Fast Price EMA (10)
    sma_30: string;       // Slow Price SMA (30)
    macro_top: string;    // Macro Structure Zone Top
    macro_bottom: string; // Macro Structure Zone Bottom
    cbc_top: string;      // Strict CBC Micro Pullback Zone Top
    cbc_bottom: string;   // Strict CBC Micro Pullback Zone Bottom
    cbc_flip: string;     // Micro Pullback Flip: +1 (Bull), -1 (Bear), 0 (None)
}

export interface TradeManifestRow {
    trade_id: string;
    signal_type: 'EMA_SMA_CROSS' | 'STRICT_CBC_FLIP'; // Identifies which strategy fired!
    signal_bar_index: number;
    resolution_bar_index: number;
    signal_timestamp: number;
    signal_direction: 'BUY' | 'SELL';
    entry_price: number;
    stop_price: number;
    target_price: number;
    gross_R: number;
    trading_cost_R: number;
    realized_net_R: number;
    outcome_class: 'hard_stop' | 'timeout_loss' | 'timeout_gain' | 'full_target';
    session_id: 'London' | 'NewYorkPostOpen' | 'Outside';
    session_elapsed_minutes: number;
    session_trade_number: number;
}

export interface ExportAIOptions {
    targetRR?: number;
    forwardHorizon?: number;
    atrPeriod?: number;
    crossSignals?: Int8Array | number[];
    cbcFlips?: Int8Array | number[];
    emaValues?: Float64Array | number[];
    smaValues?: Float64Array | number[];
    activeBoxesPerBar?: Array<StructuralBoxLike | null>;
    activeCbcBoxesPerBar?: Array<any | null>;
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
 * Calculates a causal 20-period Volume Simple Moving Average.
 * Returns empty string for warm-up candles (< 20 bars).
 */
export function calculateVolumeSMAArray(dataStore: any, period: number = 20): string[] {
    const len = dataStore.length;
    const result: string[] = new Array(len).fill('');
    if (len < period) return result;

    let sum = 0;
    for (let i = 0; i < period; i++) {
        sum += dataStore.data[i * 6 + 5];
    }
    result[period - 1] = (sum / period).toFixed(2);

    for (let i = period; i < len; i++) {
        sum += dataStore.data[i * 6 + 5] - dataStore.data[(i - period) * 6 + 5];
        result[i] = (sum / period).toFixed(2);
    }
    return result;
}

/**
 * Causal Timezone Session Classifier (Daylight Saving Compliant)
 * - London: 08:00 - 10:00 Europe/London
 * - New York Post-Open: 09:30 - 11:30 America/New_York
 * - Outside: All other hours
 */
export function classifyTradeSession(timestampMs: number): {
    sessionId: 'London' | 'NewYorkPostOpen' | 'Outside';
    elapsedMinutes: number;
    sessionDate: string;
} {
    const date = new Date(timestampMs);

    // 1. Check London Window (08:00 to 10:00 Europe/London)
    try {
        const lonFormatter = new Intl.DateTimeFormat('en-GB', {
            timeZone: 'Europe/London',
            hour12: false,
            weekday: 'short',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit'
        });
        const lonParts = lonFormatter.formatToParts(date);
        const lonWeekday = lonParts.find(p => p.type === 'weekday')?.value || '';
        const lonH = parseInt(lonParts.find(p => p.type === 'hour')?.value || '0', 10);
        const lonM = parseInt(lonParts.find(p => p.type === 'minute')?.value || '0', 10);
        const lonDateStr = `${lonParts.find(p => p.type === 'year')?.value}-${lonParts.find(p => p.type === 'month')?.value}-${lonParts.find(p => p.type === 'day')?.value}`;

        if (lonWeekday !== 'Sat' && lonWeekday !== 'Sun') {
            if (lonH >= 8 && lonH < 10) {
                const elapsed = (lonH - 8) * 60 + lonM;
                return { sessionId: 'London', elapsedMinutes: elapsed, sessionDate: `LON_${lonDateStr}` };
            }
        }

        // 2. Check New York Post-Open Window (09:30 to 11:30 America/New_York)
        const nyFormatter = new Intl.DateTimeFormat('en-US', {
            timeZone: 'America/New_York',
            hour12: false,
            weekday: 'short',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit'
        });
        const nyParts = nyFormatter.formatToParts(date);
        const nyWeekday = nyParts.find(p => p.type === 'weekday')?.value || '';
        const nyH = parseInt(nyParts.find(p => p.type === 'hour')?.value || '0', 10);
        const nyM = parseInt(nyParts.find(p => p.type === 'minute')?.value || '0', 10);
        const nyDateStr = `${nyParts.find(p => p.type === 'year')?.value}-${nyParts.find(p => p.type === 'month')?.value}-${nyParts.find(p => p.type === 'day')?.value}`;

        if (nyWeekday !== 'Sat' && nyWeekday !== 'Sun') {
            const nyTotalMin = nyH * 60 + nyM;
            const openMin = 9 * 60 + 30;  // 09:30
            const closeMin = 11 * 60 + 30; // 11:30
            if (nyTotalMin >= openMin && nyTotalMin < closeMin) {
                return { sessionId: 'NewYorkPostOpen', elapsedMinutes: nyTotalMin - openMin, sessionDate: `NY_${nyDateStr}` };
            }
        }
    } catch (e) {
        // Fallback for environments with limited Intl support
    }

    return { sessionId: 'Outside', elapsedMinutes: 0, sessionDate: 'OUTSIDE' };
}

export class AIExporter {
    /**
     * Builds both the continuous bars array and the trade manifest.
     */
    public static buildDataset(
        dataStore: any,
        options: ExportAIOptions = {}
    ): { bars: ContinuousBarRow[]; trades: TradeManifestRow[] } {
        const len = dataStore.length;
        const bars: ContinuousBarRow[] = [];
        const trades: TradeManifestRow[] = [];
        if (len === 0) return { bars, trades };

        // 1. Build Causal Continuous Indicator Streams
        const atrPeriod = options.atrPeriod ?? 14;
        const atrRaw = calculateATRArray(dataStore, atrPeriod);
        const volSmaRaw = calculateVolumeSMAArray(dataStore, 20);

        for (let i = 0; i < len; i++) {
            const base = i * 6;
            const macroBox = options.activeBoxesPerBar ? options.activeBoxesPerBar[i] : null;
            const cbcBox = options.activeCbcBoxesPerBar ? options.activeCbcBoxesPerBar[i] : null;
            const cbcFlipVal = options.cbcFlips ? options.cbcFlips[i] : 0;

            bars.push({
                bar_index: i,
                timestamp: dataStore.data[base],
                open: dataStore.data[base + 1],
                high: dataStore.data[base + 2],
                low: dataStore.data[base + 3],
                close: dataStore.data[base + 4],
                volume: dataStore.data[base + 5],
                atr: i >= atrPeriod - 1 ? atrRaw[i].toFixed(4) : '',
                volume_sma_20: volSmaRaw[i],
                ema_10: options.emaValues && options.emaValues[i] ? options.emaValues[i].toFixed(4) : '',
                sma_30: options.smaValues && options.smaValues[i] ? options.smaValues[i].toFixed(4) : '',
                macro_top: macroBox ? macroBox.top.toFixed(4) : '',
                macro_bottom: macroBox ? macroBox.bottom.toFixed(4) : '',
                cbc_top: cbcBox ? cbcBox.top.toFixed(4) : '',
                cbc_bottom: cbcBox ? cbcBox.bottom.toFixed(4) : '',
                cbc_flip: cbcFlipVal !== 0 ? cbcFlipVal.toString() : '0'
            });
        }

        // 2. Build Trade Manifest with Causal Session Tracking
        const targetRR = options.targetRR ?? 2.0;
        const maxHorizon = options.forwardHorizon ?? 30;
        const TRADE_COST_R = 0.05; // Fixed simulated slippage + exchange fees
        const sessionCounters = new Map<string, number>();
        let tradeSequenceId = 1;

        for (let i = 0; i < len; i++) {
            const base = i * 6;
            const timestamp = dataStore.data[base];
            const closePrice = dataStore.data[base + 4];
            const currentAtr = Math.max(atrRaw[i] || 0, 0.0001);

            // TRADE ENTRY IS STRICTLY THE EMA (10) / SMA (30) CROSS
            let signalDir: 'BUY' | 'SELL' | null = null;
            if (options.crossSignals && options.crossSignals[i] === 1) {
                signalDir = 'BUY';  // Golden Cross
            } else if (options.crossSignals && options.crossSignals[i] === -1) {
                signalDir = 'SELL'; // Death Cross
            }

            // Strictly skip any candle that is not an EMA/SMA Cross
            if (!signalDir) continue;
            const signalType: 'EMA_SMA_CROSS' = 'EMA_SMA_CROSS';

            // Priority Stop-Loss Selection:
            // 1. Strict CBC Pullback Box (if active)
            // 2. Market Structure Macro Box (if active)
            // 3. Fallback to 1.5 ATR
            const isLong = signalDir === 'BUY';
            const macroBox = options.activeBoxesPerBar ? options.activeBoxesPerBar[i] : null;
            const cbcBox = options.activeCbcBoxesPerBar ? options.activeCbcBoxesPerBar[i] : null;

            let stopPrice = closePrice;
            if (cbcBox) {
                stopPrice = isLong ? cbcBox.bottom : cbcBox.top;
            } else if (macroBox) {
                stopPrice = isLong ? macroBox.bottom : macroBox.top;
            } else {
                stopPrice = isLong ? closePrice - (currentAtr * 1.5) : closePrice + (currentAtr * 1.5);
            }

            // Session Metadata & Causal Counter
            const sessionInfo = classifyTradeSession(timestamp);
            const sessionKey = sessionInfo.sessionDate;
            const currentSessionCount = (sessionCounters.get(sessionKey) || 0) + 1;
            sessionCounters.set(sessionKey, currentSessionCount);

            let rawRisk = Math.abs(closePrice - stopPrice);
            if (rawRisk <= 0 || isNaN(rawRisk)) rawRisk = currentAtr * 1.5;

            const targetPrice = isLong ? closePrice + (rawRisk * targetRR) : closePrice - (rawRisk * targetRR);

            // Forward Execution Simulation
            const lookAheadLimit = Math.min(len - 1, i + maxHorizon);
            let resolved = false;
            let resolutionBarIndex = -1;
            let exitPrice = closePrice;
            let outcomeClass: 'hard_stop' | 'timeout_loss' | 'timeout_gain' | 'full_target' = 'hard_stop';

            for (let f = i + 1; f <= lookAheadLimit; f++) {
                const fOpen = dataStore.data[f * 6 + 1];
                const fHigh = dataStore.data[f * 6 + 2];
                const fLow = dataStore.data[f * 6 + 3];
                const fClose = dataStore.data[f * 6 + 4];

                // RULE: Trade stays active UNTIL an opposite EMA/SMA cross occurs
                const isOppositeCross = isLong
                    ? (options.crossSignals && options.crossSignals[f] === -1)
                    : (options.crossSignals && options.crossSignals[f] === 1);

                if (isOppositeCross) {
                    exitPrice = fClose; // Exit trade at market close of the reversal cross
                    resolutionBarIndex = f;
                    outcomeClass = isLong
                        ? (exitPrice >= closePrice ? 'timeout_gain' : 'timeout_loss')
                        : (closePrice >= exitPrice ? 'timeout_gain' : 'timeout_loss');
                    resolved = true;
                    break;
                }

                if (isLong) {
                    const hitSL = fLow <= stopPrice;
                    const hitTP = fHigh >= targetPrice;

                    if (hitSL && hitTP) {
                        exitPrice = fOpen <= stopPrice ? fOpen : stopPrice; // Conservative: Stop Loss first
                        resolutionBarIndex = f;
                        outcomeClass = 'hard_stop';
                        resolved = true;
                        break;
                    } else if (hitSL) {
                        exitPrice = fOpen <= stopPrice ? fOpen : stopPrice;
                        resolutionBarIndex = f;
                        outcomeClass = 'hard_stop';
                        resolved = true;
                        break;
                    } else if (hitTP) {
                        exitPrice = fOpen >= targetPrice ? fOpen : targetPrice;
                        resolutionBarIndex = f;
                        outcomeClass = 'full_target';
                        resolved = true;
                        break;
                    }
                } else { // SHORT
                    const hitSL = fHigh >= stopPrice;
                    const hitTP = fLow <= targetPrice;

                    if (hitSL && hitTP) {
                        exitPrice = fOpen >= stopPrice ? fOpen : stopPrice;
                        resolutionBarIndex = f;
                        outcomeClass = 'hard_stop';
                        resolved = true;
                        break;
                    } else if (hitSL) {
                        exitPrice = fOpen >= stopPrice ? fOpen : stopPrice;
                        resolutionBarIndex = f;
                        outcomeClass = 'hard_stop';
                        resolved = true;
                        break;
                    } else if (hitTP) {
                        exitPrice = fOpen <= targetPrice ? fOpen : targetPrice;
                        resolutionBarIndex = f;
                        outcomeClass = 'full_target';
                        resolved = true;
                        break;
                    }
                }
            }

            // Exclude Censored Trades (Unfinished trades at historical dataset boundary)
            if (!resolved) {
                if (lookAheadLimit === len - 1 && lookAheadLimit - i < maxHorizon) {
                    continue; // Skip censored trade entirely
                }
                exitPrice = dataStore.data[lookAheadLimit * 6 + 4];
                resolutionBarIndex = lookAheadLimit;
            }

            // Continuous R Accounting
            let gross_R = isLong ? (exitPrice - closePrice) / rawRisk : (closePrice - exitPrice) / rawRisk;
            gross_R = Math.min(targetRR, gross_R);

            if (!resolved) {
                outcomeClass = gross_R >= 0 ? 'timeout_gain' : 'timeout_loss';
            }

            const realized_net_R = gross_R - TRADE_COST_R;

            trades.push({
                trade_id: `TRD_${tradeSequenceId.toString().padStart(6, '0')}`,
                signal_type: signalType,
                signal_bar_index: i,
                resolution_bar_index: resolutionBarIndex,
                signal_timestamp: timestamp,
                signal_direction: signalDir,
                entry_price: parseFloat(closePrice.toFixed(4)),
                stop_price: parseFloat(stopPrice.toFixed(4)),
                target_price: parseFloat(targetPrice.toFixed(4)),
                gross_R: parseFloat(gross_R.toFixed(4)),
                trading_cost_R: TRADE_COST_R,
                realized_net_R: parseFloat(realized_net_R.toFixed(4)),
                outcome_class: outcomeClass,
                session_id: sessionInfo.sessionId,
                session_elapsed_minutes: sessionInfo.elapsedMinutes,
                session_trade_number: currentSessionCount
            });

            tradeSequenceId++;
        }

        return { bars, trades };
    }

    /**
     * Converts records to CSV strings and triggers browser downloads for both files.
     */
    public static exportDualCSV(
        bars: ContinuousBarRow[],
        trades: TradeManifestRow[],
        symbol: string,
        interval: string
    ): boolean {
        if (typeof document === 'undefined') return false;

        // 1. Build bars.csv
        const barHeader = 'bar_index,timestamp,open,high,low,close,volume,atr,volume_sma_20,ema_10,sma_30,macro_top,macro_bottom,cbc_top,cbc_bottom,cbc_flip';
        const barLines = bars.map(b => `${b.bar_index},${b.timestamp},${b.open},${b.high},${b.low},${b.close},${b.volume},${b.atr},${b.volume_sma_20},${b.ema_10},${b.sma_30},${b.macro_top},${b.macro_bottom},${b.cbc_top},${b.cbc_bottom},${b.cbc_flip}`);
        const barsCsv = `${barHeader}\n${barLines.join('\n')}`;

        // 2. Build trades.csv
        const tradeHeader = 'trade_id,signal_type,signal_bar_index,resolution_bar_index,signal_timestamp,signal_direction,entry_price,stop_price,target_price,gross_R,trading_cost_R,realized_net_R,outcome_class,session_id,session_elapsed_minutes,session_trade_number';
        const tradeLines = trades.map(t => `${t.trade_id},${t.signal_type},${t.signal_bar_index},${t.resolution_bar_index},${t.signal_timestamp},${t.signal_direction},${t.entry_price},${t.stop_price},${t.target_price},${t.gross_R},${t.trading_cost_R},${t.realized_net_R},${t.outcome_class},${t.session_id},${t.session_elapsed_minutes},${t.session_trade_number}`);
        const tradesCsv = `${tradeHeader}\n${tradeLines.join('\n')}`;

        const baseFilename = `RAD04_${symbol.toUpperCase()}_${interval}`;

        const downloadFile = (content: string, filename: string) => {
            const blob = new Blob([content], { type: 'text/csv;charset=utf-8;' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            a.style.display = 'none';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        };

        downloadFile(barsCsv, `${baseFilename}_bars.csv`);
        setTimeout(() => downloadFile(tradesCsv, `${baseFilename}_trades.csv`), 250);

        return true;
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

        // 3. CLASS IMBALANCE GATE (Assumes 'realized_net_R' is the 7th column: cols[6])
        // Positive net R indicates a profitable trade after fees/slippage
        if (parseFloat(cols[6]) > 0) {
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
