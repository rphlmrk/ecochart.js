import type { DataStore } from './DataStore';

export interface MLFeatureRow {
    timestamp: number;
    closePrice: number;
    atr: number;
    emaSmaSpreadPct: number;
    distToMacroTopAtr: number;
    distToMacroBotAtr: number;
    riskDistAtr: number;
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
 * AI Exporter for generating stationary ML feature vectors and datasets.
 */
export class AIExporter {
    public static readonly CSV_HEADERS = [
        'timestamp',
        'close',
        'atr',
        'ema_sma_spread_pct',
        'dist_to_macro_top_atr',
        'dist_to_macro_bot_atr',
        'risk_dist_atr'
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

            // 2. ATR-Normalized Structural Distances
            // Expresses distance to support/resistance in terms of current market volatility
            const macroTop = options.macroTop ?? null;
            const macroBot = options.macroBot ?? null;
            const distToMacroTopAtr = macroTop !== null ? ((macroTop - closePrice) / currentAtr) : 0;
            const distToMacroBotAtr = macroBot !== null ? ((closePrice - macroBot) / currentAtr) : 0;

            // 3. ATR-Normalized Risk Distance (For Stop Loss)
            // Tells the AI "This stop loss is 1.5 ATRs wide", preventing regime-scaling issues
            const entryPrice = options.entryPrice ?? closePrice;
            const stopLossPrice = options.stopLossPrice ?? closePrice;
            const riskDistAtr = Math.abs(entryPrice - stopLossPrice) / currentAtr;

            rows.push({
                timestamp,
                closePrice,
                atr: atrValues[i],
                emaSmaSpreadPct,
                distToMacroTopAtr,
                distToMacroBotAtr,
                riskDistAtr
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
                row.riskDistAtr.toFixed(6)
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
