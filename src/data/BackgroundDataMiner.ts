export interface MiningProgress {
    currentBatch: number;
    totalBatches: number;
    percent: number;
    etaSeconds: number;
    candlesFetched: number;
    statusText: string;
}

export class BackgroundDataMiner {
    // Legacy global abort controller for UI (non-ML) tasks. 
    // ML jobs pass their own specific AbortSignal.
    private static globalAbortController: AbortController | null = null;

    public static abort(): void {
        if (this.globalAbortController) {
            this.globalAbortController.abort();
            this.globalAbortController = null;
        }
    }

    public static intervalToMs(interval: string): number {
        // 🔒 Explicitly validate supported intervals instead of silently defaulting
        switch (interval) {
            case '1s': return 1_000;
            case '1m': return 60_000;
            case '3m': return 180_000;
            case '5m': return 300_000;
            case '15m': return 900_000;
            case '30m': return 1_800_000;
            case '1h': return 3_600_000;
            case '2h': return 7_200_000;
            case '4h': return 14_400_000;
            case '1d': return 86_400_000;
            case '1w': return 604_800_000;
            default:
                throw new Error(`Unsupported interval format: '${interval}'. Strict deterministic intervals required.`);
        }
    }

    public static rangeToMs(rangeKey: string): number {
        switch (rangeKey) {
            case '1w': return 7 * 86_400_000;
            case '2w': return 14 * 86_400_000;
            case '1m': return 30 * 86_400_000;
            case '3m': return 90 * 86_400_000;
            case '6m': return 180 * 86_400_000;
            case '1y': return 365 * 86_400_000;
            default: return 30 * 86_400_000;
        }
    }

    public static async mineHistoricalCandles(
        symbol: string,
        interval: string,
        totalDurationMs: number,
        onProgress: (p: MiningProgress) => void,
        customStartMs?: number,
        customEndMs?: number,
        jobSignal?: AbortSignal
    ): Promise<Float64Array> {

        // 🔒 Validate totalDurationMs before performing any calculations
        if (!Number.isSafeInteger(totalDurationMs) || totalDurationMs <= 0) {
            throw new Error('totalDurationMs must be a positive safe integer.');
        }

        const intervalMs = this.intervalToMs(interval);
        const now = Date.now();

        // 🔒 1. Validate custom start/end boundary alignment
        if (customStartMs !== undefined && customStartMs % intervalMs !== 0) {
            throw new Error('Start timestamp must be aligned to the requested interval.');
        }
        if (customEndMs !== undefined && customEndMs % intervalMs !== 0) {
            throw new Error('End timestamp must be aligned to the requested interval.');
        }

        // 🔒 2. Calculate and clamp boundaries
        const requestedEndTarget = customEndMs !== undefined ? customEndMs : now;
        const lastRequestedCandleOpenTime = requestedEndTarget - intervalMs; // Shift for exclusive end boundary
        const lastCompletedCandleOpenTime = Math.floor(now / intervalMs) * intervalMs - intervalMs;

        const endTarget = Math.min(lastRequestedCandleOpenTime, lastCompletedCandleOpenTime);
        const requestedCandleCount = Math.max(1, Math.ceil(totalDurationMs / intervalMs));
        const startTarget = customStartMs !== undefined
            ? customStartMs
            : endTarget - (requestedCandleCount - 1) * intervalMs;

        // 🔒 3. Validate calculated boundaries BEFORE allocating any abort controller
        if (!Number.isSafeInteger(startTarget) || !Number.isSafeInteger(endTarget) || startTarget < 0 || endTarget < startTarget) {
            throw new Error('Historical fetch requires ordered non-negative integer time boundaries.');
        }

        const effectiveDuration = Math.max(intervalMs, endTarget - startTarget);
        const estimatedTotalCandles = Math.ceil(effectiveDuration / intervalMs) + 1;
        const totalBatches = Math.max(1, Math.ceil(estimatedTotalCandles / 1000));

        // 🔒 4. Allocate controller only AFTER all boundary validations pass
        let signal = jobSignal;
        let localController: AbortController | null = null;
        if (!signal) {
            this.abort();
            localController = new AbortController();
            this.globalAbortController = localController;
            signal = localController.signal;
        }

        const collectedCandles: number[][] = [];
        let fetchStart = startTarget;
        let batchIndex = 0;
        let lastCandleTime = -1;

        try {
            // 🔒 Reject immediately if cancelled before execution begins
            if (signal.aborted) {
                throw new Error('Mining cancelled by user.');
            }

            while (fetchStart <= endTarget) {
                if (signal.aborted) {
                    throw new Error('Mining cancelled by user.');
                }

                batchIndex++;
                const remainingBatches = Math.max(0, totalBatches - batchIndex);
                const etaSeconds = Math.ceil(remainingBatches * 0.55);
                const pct = Math.min(99, Math.round((batchIndex / totalBatches) * 100));

                onProgress({
                    currentBatch: batchIndex,
                    totalBatches,
                    percent: pct,
                    etaSeconds,
                    candlesFetched: collectedCandles.length,
                    statusText: `Fetching 1,000 ${interval} candles from Binance...`
                });

                const query = new URLSearchParams({
                    symbol: symbol.toUpperCase(),
                    interval,
                    startTime: String(fetchStart),
                    endTime: String(endTarget),
                    limit: '1000'
                });
                const url = `https://api.binance.com/api/v3/klines?${query.toString()}`;

                const res = await fetch(url, { signal });
                if (res.status === 429 || res.status === 418) {
                    throw new Error('Binance rate limit triggered. Cooldown required.');
                }
                if (!res.ok) {
                    throw new Error(`Binance API error: ${res.statusText}`);
                }

                const rawKlines: unknown = await res.json();
                if (!Array.isArray(rawKlines) || rawKlines.length === 0) {
                    break;
                }

                for (let i = 0; i < rawKlines.length; i++) {
                    const k = rawKlines[i];
                    if (!Array.isArray(k) || k.length < 7) {
                        throw new Error(`Binance returned a malformed kline at response index ${i}.`);
                    }
                    const candleTime = Number(k[0]);
                    const closeTime = Number(k[6]);

                    if (!Number.isSafeInteger(candleTime) || !Number.isSafeInteger(closeTime)) {
                        throw new Error(`Binance returned an invalid kline timestamp at response index ${i}.`);
                    }
                    if (candleTime < startTarget || candleTime > endTarget) {
                        throw new Error(`Binance returned candle ${candleTime} outside requested open-time bounds [${startTarget}, ${endTarget}].`);
                    }
                    if (candleTime % intervalMs !== 0) {
                        throw new Error(`Binance returned unaligned candle timestamp ${candleTime}.`);
                    }
                    if (lastCandleTime !== -1 && candleTime <= lastCandleTime) {
                        throw new Error(`Binance returned non-increasing timestamp ${candleTime} after ${lastCandleTime}.`);
                    }

                    if (closeTime >= now) {
                        continue;
                    }

                    const o = parseFloat(k[1]);
                    const h = parseFloat(k[2]);
                    const l = parseFloat(k[3]);
                    const c = parseFloat(k[4]);
                    const v = parseFloat(k[5]);

                    // 🔒 Strict Pre-Ingestion Integrity Check
                    if (!Number.isFinite(o) || !Number.isFinite(h) || !Number.isFinite(l) || !Number.isFinite(c) || !Number.isFinite(v)) {
                        throw new Error(`Binance returned non-finite OHLCV values at timestamp ${candleTime}.`);
                    }
                    if (o <= 0 || h <= 0 || l <= 0 || c <= 0 || v < 0) {
                        throw new Error(`Binance returned non-positive OHLC prices or negative volume at timestamp ${candleTime}.`);
                    }
                    if (h < l || h < Math.max(o, c) || l > Math.min(o, c)) {
                        throw new Error(`Binance returned structurally invalid OHLC geometry at timestamp ${candleTime}.`);
                    }

                    collectedCandles.push([candleTime, o, h, l, c, v]);
                    lastCandleTime = candleTime;
                }

                const pageLastCandleTime = Number(rawKlines[rawKlines.length - 1][0]);
                if (!Number.isSafeInteger(pageLastCandleTime) || pageLastCandleTime + 1 <= fetchStart) {
                    throw new Error('Binance pagination did not advance beyond the previous candle boundary.');
                }
                fetchStart = pageLastCandleTime + 1;

                if (rawKlines.length < 1000) {
                    break;
                }

                await new Promise(resolve => setTimeout(resolve, 500));
            }
        } finally {
            // 🔒 Safe race-condition cleanup: Only clear the global controller if it STILL belongs to us
            if (localController && this.globalAbortController === localController) {
                this.globalAbortController = null;
            }
        }

        const len = collectedCandles.length;
        const flatBuffer = new Float64Array(len * 6);
        for (let i = 0; i < len; i++) {
            const c = collectedCandles[i];
            const base = i * 6;
            flatBuffer[base] = c[0];
            flatBuffer[base + 1] = c[1];
            flatBuffer[base + 2] = c[2];
            flatBuffer[base + 3] = c[3];
            flatBuffer[base + 4] = c[4];
            flatBuffer[base + 5] = c[5];
        }

        return flatBuffer;
    }
}
