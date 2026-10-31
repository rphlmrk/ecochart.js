import JSZip from 'jszip';
import { DataStore } from './DataStore';
import { BinanceClient } from '../network/BinanceClient';
import { db } from './db';

export interface AiExportConfig {
    symbol: string;
    interval: string;
    rangeDays: number; // 7, 14, 30, 90 or custom
    customStartTime?: number;
    customEndTime?: number;
    packageMode: 'single_csv' | 'daily_zip';
    targetRR: number; // e.g. 1.5, 2.0
    horizonBars: number; // e.g. 30 bars
    includeAllCandles: boolean; // true = every candle, false = only bars with signals
}

export interface ExportProgress {
    phase: 'fetching' | 'calculating' | 'packaging' | 'complete' | 'error';
    percent: number;
    message: string;
    totalBars?: number;
    signalCount?: number;
    positiveCount?: number;
    negativeCount?: number;
}

export class AiExportService {
    /**
     * Executes the complete historical fetch, indicator computation, forward signal
     * outcome tracking, range clustering analysis, and browser download.
     */
    public static async runExport(
        config: AiExportConfig,
        currentDataStore: DataStore,
        onProgress: (p: ExportProgress) => void
    ): Promise<{ rowCount: number; signalCount: number; winRatePct: number }> {
        const symbol = config.symbol.toUpperCase();
        const interval = config.interval;
        const now = Date.now();

        const endTime = config.customEndTime || now;
        const startTime = config.customStartTime || (endTime - (config.rangeDays * 24 * 60 * 60 * 1000));

        onProgress({
            phase: 'fetching',
            percent: 10,
            message: `Hydrating historical data for ${symbol} (${interval}) from ${new Date(startTime).toLocaleDateString()} to ${new Date(endTime).toLocaleDateString()}...`
        });

        // 1. Gather all available historical bars
        const candles = await this.hydrateHistoricalData(symbol, interval, startTime, endTime, currentDataStore, (pct, msg) => {
            onProgress({
                phase: 'fetching',
                percent: 10 + Math.round(pct * 0.35),
                message: msg
            });
        });

        if (candles.length < 50) {
            throw new Error(`Insufficient historical candles found for ${symbol} in selected range (Found ${candles.length} bars. Minimum required: 50).`);
        }

        onProgress({
            phase: 'calculating',
            percent: 50,
            message: `Calculating EMA 10/SMA 30, Pullback Zones, and Forward Outcomes across ${candles.length.toLocaleString()} candles...`,
            totalBars: candles.length
        });

        // 2. Compute Indicator Feature Vectors & Forward Signal Outcomes
        const exportRows = this.computeIndicatorAndSignalFeatures(candles, config);

        let signalCount = 0;
        let positiveCount = 0;
        let negativeCount = 0;

        for (const row of exportRows) {
            if (row.signalType !== 'NONE') {
                signalCount++;
                if (row.outcome === 1) positiveCount++;
                else if (row.outcome === 0) negativeCount++;
            }
        }

        const winRatePct = (positiveCount + negativeCount) > 0
            ? Math.round((positiveCount / (positiveCount + negativeCount)) * 1000) / 10
            : 0;

        onProgress({
            phase: 'packaging',
            percent: 85,
            message: `Packaging ${exportRows.length.toLocaleString()} rows (${signalCount} signals, ${winRatePct}% historical win rate) into ${config.packageMode === 'single_csv' ? 'CSV file' : 'Daily ZIP archive'}...`,
            totalBars: exportRows.length,
            signalCount,
            positiveCount,
            negativeCount
        });

        // 3. Serialize and trigger download
        if (config.packageMode === 'single_csv') {
            const csvText = this.buildCsvString(exportRows);
            const filename = `${symbol}_${interval}_${Math.round((endTime - startTime) / 86400000)}D_ai_dataset.csv`;
            this.downloadBlob(new Blob([csvText], { type: 'text/csv;charset=utf-8;' }), filename);
        } else {
            // Daily ZIP
            await this.buildAndDownloadDailyZip(symbol, interval, exportRows);
        }

        onProgress({
            phase: 'complete',
            percent: 100,
            message: `Successfully exported ${exportRows.length.toLocaleString()} bars with ${signalCount} labeled signals.`,
            totalBars: exportRows.length,
            signalCount,
            positiveCount,
            negativeCount
        });

        return { rowCount: exportRows.length, signalCount, winRatePct };
    }

    /**
     * Hydrates continuous candles from IndexedDB and/or Binance API for the requested time range.
     */
    private static async hydrateHistoricalData(
        symbol: string,
        interval: string,
        startTime: number,
        endTime: number,
        currentDataStore: DataStore,
        onFetchProgress: (pct: number, msg: string) => void
    ): Promise<Array<[number, number, number, number, number, number]>> {
        const candleMap = new Map<number, [number, number, number, number, number, number]>();

        // Step A: Load whatever is currently in memory in DataStore
        if (currentDataStore && currentDataStore.length > 0) {
            const data = currentDataStore.data;
            const len = currentDataStore.length;
            for (let i = 0; i < len; i++) {
                const base = i * 6;
                const t = data[base];
                if (t >= startTime && t <= endTime) {
                    candleMap.set(t, [t, data[base + 1], data[base + 2], data[base + 3], data[base + 4], data[base + 5]]);
                }
            }
        }

        // Step B: Query Dexie IndexedDB cache
        try {
            const cachedCandles = await db.candles
                .where('[symbol+interval]')
                .equals([symbol, interval])
                .filter(c => c.time >= startTime && c.time <= endTime)
                .toArray();

            for (const c of cachedCandles) {
                if (!candleMap.has(c.time)) {
                    candleMap.set(c.time, [c.time, c.o, c.h, c.l, c.c, c.v]);
                }
            }
        } catch (err) {
            console.warn('[AiExportService] IndexedDB query fallback:', err);
        }

        // Step C: Check if we need to fetch missing chunks from Binance REST API
        let sorted = Array.from(candleMap.values()).sort((a, b) => a[0] - b[0]);
        let oldestPresent = sorted.length > 0 ? sorted[0][0] : endTime;

        // If oldestPresent is noticeably after startTime, fetch backwards in chunks
        let attempts = 0;
        const maxAttempts = 25; // Protect from endless loops (each chunk is 1000 candles)

        while (oldestPresent > startTime && attempts < maxAttempts) {
            attempts++;
            const chunkEnd = oldestPresent - 1;
            onFetchProgress(
                Math.min(1, attempts / 15),
                `Fetching historical chunk from Binance (${new Date(chunkEnd).toLocaleDateString()})...`
            );

            try {
                const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&endTime=${chunkEnd}&limit=1000`;
                const res = await BinanceClient.safeFetch(url);
                if (!res.ok) break;

                const raw: any[] = await res.json();
                if (!Array.isArray(raw) || raw.length === 0) break;

                let oldestInChunk = oldestPresent;
                for (const k of raw) {
                    const t = Number(k[0]);
                    const o = parseFloat(k[1]);
                    const h = parseFloat(k[2]);
                    const l = parseFloat(k[3]);
                    const c = parseFloat(k[4]);
                    const v = parseFloat(k[5]);

                    if (t >= startTime && t <= endTime) {
                        candleMap.set(t, [t, o, h, l, c, v]);
                    }
                    if (t < oldestInChunk) oldestInChunk = t;
                }

                if (oldestInChunk >= oldestPresent) {
                    // No further older candles available on Binance
                    break;
                }
                oldestPresent = oldestInChunk;
            } catch (fetchErr) {
                console.warn('[AiExportService] Chunk fetch encountered error:', fetchErr);
                break;
            }
        }

        sorted = Array.from(candleMap.values()).sort((a, b) => a[0] - b[0]);
        return sorted;
    }

    /**
     * Mathematical feature extraction across all candles with full indicator state and forward outcome labeling.
     */
    private static computeIndicatorAndSignalFeatures(
        candles: Array<[number, number, number, number, number, number]>,
        config: AiExportConfig
    ): ExportRow[] {
        const len = candles.length;
        const rows: ExportRow[] = [];

        // 1. Compute EMA 10 & SMA 30
        const ema10 = new Float64Array(len);
        const sma30 = new Float64Array(len);
        const kEma = 2 / (10 + 1);

        let smaSum = 0;
        for (let i = 0; i < len; i++) {
            const c = candles[i][4];
            // EMA 10
            if (i === 0) ema10[0] = c;
            else ema10[i] = (c - ema10[i - 1]) * kEma + ema10[i - 1];

            // SMA 30
            smaSum += c;
            if (i >= 30) smaSum -= candles[i - 30][4];
            sma30[i] = i >= 29 ? (smaSum / 30) : (smaSum / (i + 1));
        }

        // Cross Signals (+1 Bull, -1 Bear, 0 None)
        const emaSmaCross = new Int8Array(len);
        for (let i = 1; i < len; i++) {
            const prevSpread = ema10[i - 1] - sma30[i - 1];
            const currSpread = ema10[i] - sma30[i];
            if (prevSpread <= 0 && currSpread > 0) emaSmaCross[i] = 1;
            else if (prevSpread >= 0 && currSpread < 0) emaSmaCross[i] = -1;
        }

        // 2. Compute Market Structure Pullback Zones (Macro Swing Period = 11)
        const macroPrd = 11;
        const inMacroZone = new Uint8Array(len);
        const macroZoneTop = new Float64Array(len);
        const macroZoneBottom = new Float64Array(len);

        let curMacroTop: number | null = null;
        let curMacroBot: number | null = null;
        let inMacro = false;

        const isPivotHigh = (p: number): boolean => {
            if (p < macroPrd || p + macroPrd >= len) return false;
            const candH = candles[p][2];
            for (let k = 1; k <= macroPrd; k++) {
                if (candles[p - k][2] > candH || candles[p + k][2] >= candH) return false;
            }
            return true;
        };

        const isPivotLow = (p: number): boolean => {
            if (p < macroPrd || p + macroPrd >= len) return false;
            const candL = candles[p][3];
            for (let k = 1; k <= macroPrd; k++) {
                if (candles[p - k][3] < candL || candles[p + k][3] <= candL) return false;
            }
            return true;
        };

        for (let i = 0; i < len; i++) {
            const h = candles[i][2];
            const l = candles[i][3];
            const c = candles[i][4];

            if (inMacro && curMacroTop !== null && curMacroBot !== null) {
                if (c > curMacroTop || c < curMacroBot) {
                    // Breakout occurred
                    inMacro = false;
                    curMacroTop = null;
                    curMacroBot = null;
                } else {
                    if (h > curMacroTop) curMacroTop = h;
                    if (l < curMacroBot) curMacroBot = l;
                }
            }

            if (!inMacro) {
                const evalBar = i - macroPrd;
                if (evalBar >= 0) {
                    if (isPivotHigh(evalBar)) {
                        inMacro = true;
                        curMacroTop = candles[evalBar][2];
                        curMacroBot = l;
                    } else if (isPivotLow(evalBar)) {
                        inMacro = true;
                        curMacroBot = candles[evalBar][3];
                        curMacroTop = h;
                    }
                }
            }

            if (inMacro && curMacroTop !== null && curMacroBot !== null) {
                inMacroZone[i] = 1;
                macroZoneTop[i] = curMacroTop;
                macroZoneBottom[i] = curMacroBot;
            }
        }

        // 3. Compute Strict CBC Pullback Zones & Anchors
        const cbcTrend = new Int8Array(len);
        const cbcFlip = new Int8Array(len);
        const cbcAnchorHigh = new Float64Array(len);
        const cbcAnchorLow = new Float64Array(len);

        let activeAnchorHigh = candles[0][2];
        let activeAnchorLow = candles[0][3];
        let activeTrend = 1;

        for (let i = 0; i < len; i++) {
            const h = candles[i][2];
            const l = candles[i][3];
            const c = candles[i][4];

            if (c > activeAnchorHigh) {
                if (activeTrend !== 1) {
                    cbcFlip[i] = 1; // Bullish structure flip
                    activeTrend = 1;
                }
                activeAnchorHigh = h;
                activeAnchorLow = l;
            } else if (c < activeAnchorLow) {
                if (activeTrend !== -1) {
                    cbcFlip[i] = -1; // Bearish structure flip
                    activeTrend = -1;
                }
                activeAnchorHigh = h;
                activeAnchorLow = l;
            }

            cbcTrend[i] = activeTrend;
            cbcAnchorHigh[i] = activeAnchorHigh;
            cbcAnchorLow[i] = activeAnchorLow;
        }

        // 4. Signal Density & Range Clustering (signals in last 10 bars)
        const signalClusterCount10 = new Int16Array(len);
        for (let i = 0; i < len; i++) {
            let count = 0;
            const startWindow = Math.max(0, i - 9);
            for (let w = startWindow; w <= i; w++) {
                if (emaSmaCross[w] !== 0) count++;
                if (cbcFlip[w] !== 0) count++;
            }
            signalClusterCount10[i] = count;
        }

        // 5. Build Rows and Forward Outcome Tracking (Positive/Negative/Timeout)
        const targetRR = config.targetRR || 2.0;
        const horizon = config.horizonBars || 30;

        for (let i = 0; i < len; i++) {
            const [t, o, h, l, c, v] = candles[i];

            // Determine if a trade signal fired on this candle
            let signalType: 'BULL_CROSS' | 'BEAR_CROSS' | 'CBC_BULL_FLIP' | 'CBC_BEAR_FLIP' | 'NONE' = 'NONE';
            if (emaSmaCross[i] === 1) signalType = 'BULL_CROSS';
            else if (emaSmaCross[i] === -1) signalType = 'BEAR_CROSS';
            else if (cbcFlip[i] === 1) signalType = 'CBC_BULL_FLIP';
            else if (cbcFlip[i] === -1) signalType = 'CBC_BEAR_FLIP';

            let entryPrice = 0;
            let stopLossPrice = 0;
            let targetPrice = 0;
            let outcome: number | null = null; // 1 = Win, 0 = Loss, -1 = Timeout / End
            let barsToResolution = 0;
            let maxAdversePct = 0;
            let maxFavorablePct = 0;

            if (signalType !== 'NONE') {
                entryPrice = c;
                const isBull = signalType === 'BULL_CROSS' || signalType === 'CBC_BULL_FLIP';

                if (isBull) {
                    // Stop loss placed below recent anchor low or recent swing low
                    let stopCandle = cbcAnchorLow[i];
                    if (stopCandle <= 0 || stopCandle >= entryPrice) {
                        // Fallback: lowest of last 5 bars
                        let min5 = l;
                        for (let k = Math.max(0, i - 5); k <= i; k++) {
                            if (candles[k][3] < min5) min5 = candles[k][3];
                        }
                        stopCandle = min5;
                    }

                    // Guard against zero risk
                    if (stopCandle >= entryPrice) {
                        stopCandle = entryPrice * 0.995;
                    }

                    const risk = entryPrice - stopCandle;
                    stopLossPrice = stopCandle;
                    targetPrice = entryPrice + (risk * targetRR);

                    // Forward walk to determine outcome
                    let peakGain = 0;
                    let worstDrop = 0;
                    const maxForward = Math.min(len - 1, i + horizon);

                    for (let f = i + 1; f <= maxForward; f++) {
                        const fHigh = candles[f][2];
                        const fLow = candles[f][3];

                        const drop = ((fLow - entryPrice) / entryPrice) * 100;
                        const gain = ((fHigh - entryPrice) / entryPrice) * 100;
                        if (drop < worstDrop) worstDrop = drop;
                        if (gain > peakGain) peakGain = gain;

                        // Check Stop Loss hit first
                        if (fLow <= stopLossPrice) {
                            outcome = 0; // NEGATIVE / LOSS
                            barsToResolution = f - i;
                            break;
                        }

                        // Check Target hit
                        if (fHigh >= targetPrice) {
                            outcome = 1; // POSITIVE / WIN
                            barsToResolution = f - i;
                            break;
                        }
                    }

                    if (outcome === null) {
                        outcome = -1; // TIMEOUT (Did not resolve within horizon)
                        barsToResolution = maxForward - i;
                    }

                    maxAdversePct = Math.round(worstDrop * 100) / 100;
                    maxFavorablePct = Math.round(peakGain * 100) / 100;
                } else {
                    // Bearish Signal
                    let stopCandle = cbcAnchorHigh[i];
                    if (stopCandle <= 0 || stopCandle <= entryPrice) {
                        // Fallback: highest of last 5 bars
                        let max5 = h;
                        for (let k = Math.max(0, i - 5); k <= i; k++) {
                            if (candles[k][2] > max5) max5 = candles[k][2];
                        }
                        stopCandle = max5;
                    }

                    if (stopCandle <= entryPrice) {
                        stopCandle = entryPrice * 1.005;
                    }

                    const risk = stopCandle - entryPrice;
                    stopLossPrice = stopCandle;
                    targetPrice = entryPrice - (risk * targetRR);

                    let peakGain = 0;
                    let worstDrop = 0;
                    const maxForward = Math.min(len - 1, i + horizon);

                    for (let f = i + 1; f <= maxForward; f++) {
                        const fHigh = candles[f][2];
                        const fLow = candles[f][3];

                        // In a short trade, price drop is favorable
                        const gain = ((entryPrice - fLow) / entryPrice) * 100;
                        const loss = ((entryPrice - fHigh) / entryPrice) * 100; // negative number
                        if (loss < worstDrop) worstDrop = loss;
                        if (gain > peakGain) peakGain = gain;

                        // Check Stop Loss hit first
                        if (fHigh >= stopLossPrice) {
                            outcome = 0; // NEGATIVE / LOSS
                            barsToResolution = f - i;
                            break;
                        }

                        // Check Target hit
                        if (fLow <= targetPrice) {
                            outcome = 1; // POSITIVE / WIN
                            barsToResolution = f - i;
                            break;
                        }
                    }

                    if (outcome === null) {
                        outcome = -1; // TIMEOUT
                        barsToResolution = maxForward - i;
                    }

                    maxAdversePct = Math.round(worstDrop * 100) / 100;
                    maxFavorablePct = Math.round(peakGain * 100) / 100;
                }
            }

            rows.push({
                timestamp: t,
                datetimeUtc: new Date(t).toISOString().replace('T', ' ').replace('Z', ''),
                open: o,
                high: h,
                low: l,
                close: c,
                volume: v,
                ema10: Math.round(ema10[i] * 100) / 100,
                sma30: Math.round(sma30[i] * 100) / 100,
                emaSmaSpread: Math.round((ema10[i] - sma30[i]) * 100) / 100,
                emaSmaCross: emaSmaCross[i],
                inMacroZone: inMacroZone[i] === 1,
                macroZoneTop: macroZoneTop[i] > 0 ? Math.round(macroZoneTop[i] * 100) / 100 : 0,
                macroZoneBottom: macroZoneBottom[i] > 0 ? Math.round(macroZoneBottom[i] * 100) / 100 : 0,
                cbcTrend: cbcTrend[i],
                cbcFlip: cbcFlip[i],
                cbcAnchorHigh: Math.round(cbcAnchorHigh[i] * 100) / 100,
                cbcAnchorLow: Math.round(cbcAnchorLow[i] * 100) / 100,
                signalClusterCount10: signalClusterCount10[i],
                signalType,
                entryPrice: entryPrice > 0 ? Math.round(entryPrice * 100) / 100 : '',
                stopLossPrice: stopLossPrice > 0 ? Math.round(stopLossPrice * 100) / 100 : '',
                targetPrice: targetPrice > 0 ? Math.round(targetPrice * 100) / 100 : '',
                outcome: outcome !== null ? outcome : '',
                barsToResolution: barsToResolution > 0 ? barsToResolution : '',
                maxAdversePct: signalType !== 'NONE' ? maxAdversePct : '',
                maxFavorablePct: signalType !== 'NONE' ? maxFavorablePct : ''
            });
        }

        return rows;
    }

    /**
     * Converts raw row objects to standard CSV string with headers.
     */
    private static buildCsvString(rows: ExportRow[]): string {
        const headers = [
            'timestamp',
            'datetime_utc',
            'open',
            'high',
            'low',
            'close',
            'volume',
            'ema_10',
            'sma_30',
            'ema_sma_spread',
            'ema_sma_cross',
            'in_macro_zone',
            'macro_zone_top',
            'macro_zone_bottom',
            'cbc_trend',
            'cbc_flip',
            'cbc_anchor_high',
            'cbc_anchor_low',
            'signal_cluster_count_10',
            'signal_type',
            'entry_price',
            'stop_loss_price',
            'target_price',
            'outcome',
            'bars_to_resolution',
            'max_adverse_excursion_pct',
            'max_favorable_excursion_pct'
        ];

        const lines: string[] = [headers.join(',')];

        for (const r of rows) {
            lines.push([
                r.timestamp,
                `"${r.datetimeUtc}"`,
                r.open,
                r.high,
                r.low,
                r.close,
                r.volume,
                r.ema10,
                r.sma30,
                r.emaSmaSpread,
                r.emaSmaCross,
                r.inMacroZone ? 1 : 0,
                r.macroZoneTop,
                r.macroZoneBottom,
                r.cbcTrend,
                r.cbcFlip,
                r.cbcAnchorHigh,
                r.cbcAnchorLow,
                r.signalClusterCount10,
                r.signalType,
                r.entryPrice,
                r.stopLossPrice,
                r.targetPrice,
                r.outcome,
                r.barsToResolution,
                r.maxAdversePct,
                r.maxFavorablePct
            ].join(','));
        }

        return lines.join('\n');
    }

    /**
     * Partitions rows by calendar day and generates a packaged ZIP download.
     */
    private static async buildAndDownloadDailyZip(
        symbol: string,
        interval: string,
        rows: ExportRow[]
    ): Promise<void> {
        const zip = new JSZip();
        const dailyGroups = new Map<string, ExportRow[]>();

        for (const row of rows) {
            const dateKey = row.datetimeUtc.split(' ')[0]; // YYYY-MM-DD
            if (!dailyGroups.has(dateKey)) {
                dailyGroups.set(dateKey, []);
            }
            dailyGroups.get(dateKey)!.push(row);
        }

        for (const [dateStr, dayRows] of dailyGroups.entries()) {
            const csvData = this.buildCsvString(dayRows);
            zip.file(`${symbol}_${interval}_${dateStr}.csv`, csvData);
        }

        const zipBlob = await zip.generateAsync({ type: 'blob' });
        const zipFilename = `${symbol}_${interval}_${dailyGroups.size}Days_daily_dataset.zip`;
        this.downloadBlob(zipBlob, zipFilename);
    }

    /**
     * Triggers a browser download of a generated Blob.
     */
    private static downloadBlob(blob: Blob, filename: string): void {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
}

export interface ExportRow {
    timestamp: number;
    datetimeUtc: string;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
    ema10: number;
    sma30: number;
    emaSmaSpread: number;
    emaSmaCross: number;
    inMacroZone: boolean;
    macroZoneTop: number;
    macroZoneBottom: number;
    cbcTrend: number;
    cbcFlip: number;
    cbcAnchorHigh: number;
    cbcAnchorLow: number;
    signalClusterCount10: number;
    signalType: string;
    entryPrice: number | string;
    stopLossPrice: number | string;
    targetPrice: number | string;
    outcome: number | string; // 1 = Win, 0 = Loss, -1 = Timeout
    barsToResolution: number | string;
    maxAdversePct: number | string;
    maxFavorablePct: number | string;
}
