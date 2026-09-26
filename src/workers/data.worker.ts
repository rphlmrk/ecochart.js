// src/workers/data.worker.ts
import { db } from '../data/db';
import { TimeframeResampler } from '../data/TimeframeResampler';

// Isolated Background Rate Limiter
let rateLimitUntil = 0;
const MIN_REQUEST_INTERVAL_MS = 120;
const requestQueue: Array<() => Promise<void>> = [];
let isProcessingQueue = false;

async function safeFetch(url: string): Promise<any> {
    return new Promise((resolve, reject) => {
        const execute = async () => {
            const now = Date.now();
            if (now < rateLimitUntil) {
                await new Promise(r => setTimeout(r, rateLimitUntil - now));
            }
            try {
                const res = await fetch(url);
                if (res.status === 429 || res.status === 418) {
                    const retryAfter = res.headers.get('Retry-After');
                    const cooldownSec = retryAfter ? parseInt(retryAfter, 10) : 60;
                    rateLimitUntil = Date.now() + (cooldownSec * 1000);
                    throw new Error(`Rate limited. Retry after ${cooldownSec}s.`);
                }
                const data = await res.json();
                resolve(data);
            } catch (err) {
                reject(err);
            } finally {
                await new Promise(r => setTimeout(r, MIN_REQUEST_INTERVAL_MS));
                isProcessingQueue = false;
                processQueue();
            }
        };
        requestQueue.push(execute);
        if (!isProcessingQueue) processQueue();
    });
}

function processQueue() {
    if (isProcessingQueue || requestQueue.length === 0) return;
    isProcessingQueue = true;
    const nextTask = requestQueue.shift();
    if (nextTask) nextTask();
}

self.onmessage = async (e) => {
    const { id, type, payload } = e.data;

    // Add this line to prove where it's running!
    console.log(`[Background Worker] Handling: ${type}`);

    try {
        if (type === 'LOAD_HISTORY') {
            const { symbol, baseInterval, interval, cutoffTime } = payload;

            // Auto-Prune: Silently purge expired candles older than the cutoff threshold in the background
            if (cutoffTime > 0) {
                db.candles.where('[symbol+interval]')
                    .equals([symbol.toUpperCase(), baseInterval])
                    .filter(r => r.time < cutoffTime)
                    .delete()
                    .catch(() => { });
            }

            const records = await db.candles.where('[symbol+interval]')
                .equals([symbol.toUpperCase(), baseInterval])
                .filter(r => r.time >= cutoffTime).sortBy('time');

            const isNative = TimeframeResampler.isNative(interval);
            let rawFormat = records.map(r => [r.time, r.o, r.h, r.l, r.c, r.v] as [number, number, number, number, number, number]);

            let finalCandles = isNative ? rawFormat : TimeframeResampler.resampleHistory(rawFormat, interval);

            const flatArray = new Float64Array(finalCandles.length * 6);
            for (let i = 0; i < finalCandles.length; i++) {
                flatArray[i * 6] = finalCandles[i][0];
                flatArray[i * 6 + 1] = finalCandles[i][1];
                flatArray[i * 6 + 2] = finalCandles[i][2];
                flatArray[i * 6 + 3] = finalCandles[i][3];
                flatArray[i * 6 + 4] = finalCandles[i][4];
                flatArray[i * 6 + 5] = finalCandles[i][5];
            }

            (self as any).postMessage({ id, result: flatArray }, [flatArray.buffer]);
        }
        else if (type === 'FETCH_CHUNK') {
            const { symbol, baseInterval, startTime, endTime, persist = true } = payload;
            let url = `https://api.binance.com/api/v3/klines?symbol=${symbol.toUpperCase()}&interval=${baseInterval}&limit=1000`;
            if (startTime) url += `&startTime=${startTime}`;
            if (endTime) url += `&endTime=${endTime}`;

            const data = await safeFetch(url);
            if (!Array.isArray(data) || data.length === 0) {
                self.postMessage({ id, result: 0 });
                return;
            }

            // Only write to IndexedDB if persistence is enabled for this symbol
            if (persist) {
                const records = data.map((k: any) => ({
                    id: `${symbol.toUpperCase()}_${baseInterval}_${k[0]}`,
                    symbol: symbol.toUpperCase(),
                    interval: baseInterval,
                    time: k[0], o: parseFloat(k[1]), h: parseFloat(k[2]), l: parseFloat(k[3]), c: parseFloat(k[4]), v: parseFloat(k[5])
                }));
                await db.candles.bulkPut(records);
            }
            self.postMessage({ id, result: data[0][0] });
        }
        else if (type === 'FETCH_GAP') {
            const { symbol, baseInterval, interval, startTime, endTime, persist = true } = payload;
            const isNative = TimeframeResampler.isNative(interval);
            let url = `https://api.binance.com/api/v3/klines?symbol=${symbol.toUpperCase()}&interval=${baseInterval}&limit=1000`;
            if (startTime) url += `&startTime=${startTime}`;
            if (endTime) url += `&endTime=${endTime}`;

            const data = await safeFetch(url);
            if (!Array.isArray(data) || data.length === 0) {
                self.postMessage({ id, result: new Float64Array(0) });
                return;
            }

            // Only write to IndexedDB if persistence is enabled for this symbol
            if (persist) {
                const records = data.map((k: any) => ({
                    id: `${symbol.toUpperCase()}_${baseInterval}_${k[0]}`,
                    symbol: symbol.toUpperCase(),
                    interval: baseInterval,
                    time: k[0], o: parseFloat(k[1]), h: parseFloat(k[2]), l: parseFloat(k[3]), c: parseFloat(k[4]), v: parseFloat(k[5])
                }));
                await db.candles.bulkPut(records);
            }

            let rawFormat = data.map((k: any) => [
                k[0], parseFloat(k[1]), parseFloat(k[2]), parseFloat(k[3]), parseFloat(k[4]), parseFloat(k[5])
            ] as [number, number, number, number, number, number]);

            let finalCandles = isNative ? rawFormat : TimeframeResampler.resampleHistory(rawFormat, interval);

            const flatArray = new Float64Array(finalCandles.length * 6);
            for (let i = 0; i < finalCandles.length; i++) {
                flatArray[i * 6] = finalCandles[i][0];
                flatArray[i * 6 + 1] = finalCandles[i][1];
                flatArray[i * 6 + 2] = finalCandles[i][2];
                flatArray[i * 6 + 3] = finalCandles[i][3];
                flatArray[i * 6 + 4] = finalCandles[i][4];
                flatArray[i * 6 + 5] = finalCandles[i][5];
            }

            // Always returns data into RAM so charts render seamlessly
            (self as any).postMessage({ id, result: flatArray }, [flatArray.buffer]);
        }
        else if (type === 'SAVE_CANDLE') {
            const persist = payload.persist ?? true;
            const record = payload.record || payload;
            if (persist && record && record.id) {
                await db.candles.put(record);
            }
        }
        else if (type === 'PRUNE_NON_FAVORITES') {
            // Multi-Pane Safe: Purge only candles not in favorites AND not in any open pane
            const { favorites = [], activeSymbols = [] } = payload;
            const protectedSet = new Set([...favorites, ...activeSymbols].map((s: string) => s.toUpperCase()));
            await db.candles.filter(r => !protectedSet.has(r.symbol.toUpperCase())).delete();
            // Note: db.drawings is never touched!
            self.postMessage({ id, result: true });
        }
    } catch (err: any) {
        self.postMessage({ id, error: err.message });
    }
};