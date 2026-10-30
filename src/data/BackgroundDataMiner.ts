export interface MiningProgress {
    currentBatch: number;
    totalBatches: number;
    percent: number;
    etaSeconds: number;
    candlesFetched: number;
    statusText: string;
}

export class BackgroundDataMiner {
    private static abortController: AbortController | null = null;

    public static abort(): void {
        if (this.abortController) {
            this.abortController.abort();
            this.abortController = null;
        }
    }

    /**
     * Converts common timeframe intervals to milliseconds
     */
    public static intervalToMs(interval: string): number {
        const match = interval.match(/^(\d+)?([smhdwM])$/);
        if (!match) return 60_000;
        const val = parseInt(match[1] || '1', 10);
        const unit = match[2];
        switch (unit) {
            case 's': return val * 1_000;
            case 'm': return val * 60_000;
            case 'h': return val * 3_600_000;
            case 'd': return val * 86_400_000;
            case 'w': return val * 604_800_000;
            case 'M': return val * 2_592_000_000;
            default: return 60_000;
        }
    }

    /**
     * Translates UI range options ('1w', '2w', '1m', '3m', 'custom') to millisecond spans
     */
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

    /**
     * Downloads deep Binance history forward from startTime up to now,
     * enforcing a strict 500ms delay between 1,000-candle batches.
     */
    public static async mineHistoricalCandles(
        symbol: string,
        interval: string,
        totalDurationMs: number,
        onProgress: (p: MiningProgress) => void
    ): Promise<Float64Array> {
        this.abort();
        this.abortController = new AbortController();
        const signal = this.abortController.signal;

        const intervalMs = this.intervalToMs(interval);
        const now = Date.now();
        const startTarget = now - totalDurationMs;

        const estimatedTotalCandles = Math.ceil(totalDurationMs / intervalMs);
        const totalBatches = Math.max(1, Math.ceil(estimatedTotalCandles / 1000));

        const collectedCandles: number[][] = [];
        let fetchStart = startTarget;
        let batchIndex = 0;

        while (fetchStart < now) {
            if (signal.aborted) {
                throw new Error('Mining cancelled by user.');
            }

            batchIndex++;
            const remainingBatches = Math.max(0, totalBatches - batchIndex);
            const etaSeconds = Math.ceil(remainingBatches * 0.55); // ~500ms delay + ~50ms network roundtrip
            const pct = Math.min(99, Math.round((batchIndex / totalBatches) * 100));

            onProgress({
                currentBatch: batchIndex,
                totalBatches,
                percent: pct,
                etaSeconds,
                candlesFetched: collectedCandles.length,
                statusText: `Fetching 1,000 ${interval} candles from Binance...`
            });

            const url = `https://api.binance.com/api/v3/klines?symbol=${symbol.toUpperCase()}&interval=${interval}&startTime=${fetchStart}&limit=1000`;

            const res = await fetch(url, { signal });
            if (res.status === 429 || res.status === 418) {
                throw new Error('Binance rate limit triggered. Cooldown required.');
            }
            if (!res.ok) {
                throw new Error(`Binance API error: ${res.statusText}`);
            }

            const rawKlines: any[] = await res.json();
            if (!Array.isArray(rawKlines) || rawKlines.length === 0) {
                break; // Reached end of historical data
            }

            for (let i = 0; i < rawKlines.length; i++) {
                const k = rawKlines[i];
                // Store format: [time, open, high, low, close, volume]
                collectedCandles.push([
                    k[0],
                    parseFloat(k[1]),
                    parseFloat(k[2]),
                    parseFloat(k[3]),
                    parseFloat(k[4]),
                    parseFloat(k[5])
                ]);
            }

            const lastCandleTime = rawKlines[rawKlines.length - 1][0];
            fetchStart = lastCandleTime + 1; // Advance start to avoid duplicate boundary candle

            // If Binance returned fewer than 1000 bars, we have caught up to the present
            if (rawKlines.length < 1000) {
                break;
            }

            // CRITICAL: 500ms Ban-Proof Pause between calls
            await new Promise(resolve => setTimeout(resolve, 500));
        }

        this.abortController = null;

        // Flatten to contiguous Float64Array [time, open, high, low, close, volume, ...]
        const len = collectedCandles.length;
        const flatBuffer = new Float64Array(len * 6);
        for (let i = 0; i < len; i++) {
            const c = collectedCandles[i];
            const base = i * 6;
            flatBuffer[base]     = c[0];
            flatBuffer[base + 1] = c[1];
            flatBuffer[base + 2] = c[2];
            flatBuffer[base + 3] = c[3];
            flatBuffer[base + 4] = c[4];
            flatBuffer[base + 5] = c[5];
        }

        return flatBuffer;
    }
}
