export class TimeframeResampler {
    // Native intervals supported directly by Binance
    private static readonly NATIVE_INTERVALS = new Set([
        '1s', '1m', '3m', '5m', '15m', '30m',
        '1h', '2h', '4h', '6h', '8h', '12h',
        '1d', '3d', '1w', '1M'
    ]);

    public static isNative(interval: string): boolean {
        return this.NATIVE_INTERVALS.has(interval);
    }

    public static parseMs(interval: string): number {
        const unit = interval.slice(-1);
        const val = parseInt(interval.slice(0, -1), 10) || 1;
        if (unit === 's') return val * 1000;
        if (unit === 'm') return val * 60 * 1000;
        if (unit === 'h') return val * 60 * 60 * 1000;
        if (unit === 'd') return val * 24 * 60 * 60 * 1000;
        if (unit === 'w') return val * 7 * 24 * 60 * 60 * 1000;
        if (unit === 'M') return val * 30 * 24 * 60 * 60 * 1000;
        return 60 * 1000;
    }

    // Finds the largest native Binance interval that divides cleanly into the custom interval
    public static getBaseNativeInterval(targetInterval: string): string {
        if (this.isNative(targetInterval)) return targetInterval;

        const totalMinutes = this.parseMs(targetInterval) / (60 * 1000);

        if (totalMinutes < 60) {
            if (totalMinutes % 30 === 0) return '30m';
            if (totalMinutes % 15 === 0) return '15m';
            if (totalMinutes % 5 === 0) return '5m';
            if (totalMinutes % 3 === 0) return '3m';
            return '1m';
        } else if (totalMinutes < 1440) {
            const hours = totalMinutes / 60;
            if (hours % 12 === 0) return '12h';
            if (hours % 8 === 0) return '8h';
            if (hours % 6 === 0) return '6h';
            if (hours % 4 === 0) return '4h';
            if (hours % 2 === 0) return '2h';
            return '1h';
        } else {
            return '1d';
        }
    }

    public static getBucketStart(timestamp: number, intervalMs: number): number {
        return Math.floor(timestamp / intervalMs) * intervalMs;
    }

    // Resamples an array of raw Binance klines into target custom candles
    public static resampleHistory(rawKlines: any[], targetInterval: string): Array<[number, number, number, number, number, number]> {
        const targetMs = this.parseMs(targetInterval);
        const buckets = new Map<number, [number, number, number, number, number, number]>();

        for (const k of rawKlines) {
            const time = typeof k[0] === 'number' ? k[0] : parseFloat(k[0]);
            const o = parseFloat(k[1]);
            const h = parseFloat(k[2]);
            const l = parseFloat(k[3]);
            const c = parseFloat(k[4]);
            const v = parseFloat(k[5]);

            const bucketTime = this.getBucketStart(time, targetMs);
            const existing = buckets.get(bucketTime);

            if (!existing) {
                buckets.set(bucketTime, [bucketTime, o, h, l, c, v]);
            } else {
                existing[2] = Math.max(existing[2], h); // High
                existing[3] = Math.min(existing[3], l); // Low
                existing[4] = c;                        // Close
                existing[5] += v;                       // Volume
            }
        }

        return Array.from(buckets.values());
    }
}