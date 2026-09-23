import { DataStore } from '../data/DataStore';
import { TimeframeResampler } from '../data/TimeframeResampler';
import { db, type CandleRecord } from '../data/db';

export class BinanceClient {
    private ws: WebSocket | null = null;
    private dataStore: DataStore;
    private isReconnecting = false;

    // Rate Limiter & Queue State
    private static requestQueue: Array<() => Promise<void>> = [];
    private static isProcessingQueue = false;
    private static rateLimitUntil = 0;
    private static readonly MIN_REQUEST_INTERVAL_MS = 120; // Max ~8 req/sec safely under 1200 weight/min

    constructor(dataStore: DataStore) {
        this.dataStore = dataStore;
    }

    private currentSyncKey = '';

    private getLimitMs(interval: string): number {
        let limits: Record<string, number> = {
            'limit_1m_3m': 21, 'limit_4m_8m': 30, 'limit_9m_12m': 90, 'limit_15m': 180,
            'limit_30m_45m': 365, 'limit_1h_3h': 730, 'limit_4h_6h': 1460, 'limit_7h_12h': 1825,
            'limit_13h_1d': 3650, 'limit_1w_1M': -1
        };
        try {
            const raw = localStorage.getItem('ecochart_workspace_v1');
            if (raw) {
                const state = JSON.parse(raw);
                if (state.dataLimits) limits = { ...limits, ...state.dataLimits };
            }
        } catch {}

        const mins = TimeframeResampler.parseMs(interval) / 60000;
        let limitKey = 'limit_1w_1M';
        if (mins <= 3) limitKey = 'limit_1m_3m';
        else if (mins <= 8) limitKey = 'limit_4m_8m';
        else if (mins <= 12) limitKey = 'limit_9m_12m';
        else if (mins <= 15) limitKey = 'limit_15m';
        else if (mins <= 45) limitKey = 'limit_30m_45m';
        else if (mins <= 180) limitKey = 'limit_1h_3h';
        else if (mins <= 360) limitKey = 'limit_4h_6h';
        else if (mins <= 720) limitKey = 'limit_7h_12h';
        else if (mins <= 1440) limitKey = 'limit_13h_1d';

        const days = limits[limitKey];
        return days === -1 ? Infinity : days * 24 * 60 * 60 * 1000;
    }

    private async reloadFromDB(symbol: string, baseInterval: string, interval: string, cutoffTime: number): Promise<number> {
        const records = await db.candles.where('[symbol+interval]').equals([symbol.toUpperCase(), baseInterval])
            .filter(r => r.time >= cutoffTime).sortBy('time');

        const isNative = TimeframeResampler.isNative(interval);
        const candles: Array<[number, number, number, number, number, number]> = [];

        if (isNative) {
            for (const r of records) candles.push([r.time, r.o, r.h, r.l, r.c, r.v]);
        } else {
            const rawFormat = records.map(r => [r.time, r.o, r.h, r.l, r.c, r.v]);
            const resampled = TimeframeResampler.resampleHistory(rawFormat, interval);
            candles.push(...resampled);
        }
        return this.dataStore.setAll(candles);
    }

    private async fetchAndSaveChunk(symbol: string, baseInterval: string, startTime: number | undefined, endTime: number) {
        let url = `https://api.binance.com/api/v3/klines?symbol=${symbol.toUpperCase()}&interval=${baseInterval}&limit=1000`;
        if (startTime) url += `&startTime=${startTime}`;
        if (endTime) url += `&endTime=${endTime}`;

        try {
            const res = await BinanceClient.safeFetch(url);
            const data = await res.json();
            if (!Array.isArray(data) || data.length === 0) return 0;

            const records: CandleRecord[] = data.map((k: any) => ({
                id: `${symbol.toUpperCase()}_${baseInterval}_${k[0]}`,
                symbol: symbol.toUpperCase(),
                interval: baseInterval,
                time: k[0],
                o: parseFloat(k[1]), h: parseFloat(k[2]), l: parseFloat(k[3]), c: parseFloat(k[4]), v: parseFloat(k[5])
            }));

            await db.candles.bulkPut(records);
            return data[0][0]; // Return oldest fetched time
        } catch(e) { return 0; }
    }

    private async startBackgroundSync(symbol: string, baseInterval: string, oldestLocal: number, cutoffTime: number, interval: string, onUpdate: (prependedCount?: number) => void) {
        let currentEnd = oldestLocal - 1;
        while (currentEnd > cutoffTime && this.currentSyncKey === `${symbol}_${interval}`) {
            const oldestFetched = await this.fetchAndSaveChunk(symbol, baseInterval, undefined, currentEnd);
            if (oldestFetched === 0) break; // End of market data reached
            currentEnd = oldestFetched - 1;
            
            const prepended = await this.reloadFromDB(symbol, baseInterval, interval, cutoffTime);
            onUpdate(prepended);
        }
    }

    /**
     * Queues and throttles REST API requests to respect Binance rate limits (IP 429/418 protection)
     */
    public static async safeFetch(url: string, options?: RequestInit): Promise<Response> {
        return new Promise((resolve, reject) => {
            const execute = async () => {
                const now = Date.now();
                if (now < BinanceClient.rateLimitUntil) {
                    const waitMs = BinanceClient.rateLimitUntil - now;
                    console.warn(`[Binance] In cooldown. Waiting ${waitMs}ms before next request...`);
                    await new Promise((r) => setTimeout(r, waitMs));
                }

                try {
                    const res = await fetch(url, options);

                    // Check for Binance Rate-Limit Warning Headers
                    const usedWeight = res.headers.get('x-mbx-used-weight-1m');
                    if (usedWeight && parseInt(usedWeight, 10) > 1000) {
                        console.warn(`[Binance] High IP Weight Used: ${usedWeight}/1200`);
                    }

                    // Handle 429 (Rate Limited) or 418 (IP Auto-Ban Protection)
                    if (res.status === 429 || res.status === 418) {
                        const retryAfter = res.headers.get('Retry-After');
                        const cooldownSec = retryAfter ? parseInt(retryAfter, 10) : 60;
                        BinanceClient.rateLimitUntil = Date.now() + (cooldownSec * 1000);
                        throw new Error(`Rate limited by Binance (HTTP ${res.status}). Retry after ${cooldownSec}s.`);
                    }

                    resolve(res);
                } catch (err) {
                    reject(err);
                } finally {
                    await new Promise((r) => setTimeout(r, BinanceClient.MIN_REQUEST_INTERVAL_MS));
                    BinanceClient.isProcessingQueue = false;
                    BinanceClient.processQueue();
                }
            };

            BinanceClient.requestQueue.push(execute);
            if (!BinanceClient.isProcessingQueue) {
                BinanceClient.processQueue();
            }
        });
    }

    private static processQueue() {
        if (this.isProcessingQueue || this.requestQueue.length === 0) return;
        this.isProcessingQueue = true;
        const nextTask = this.requestQueue.shift();
        if (nextTask) nextTask();
    }

    public async fetchTradableSymbols(): Promise<Array<{ symbol: string; baseAsset: string; quoteAsset: string }>> {
        const CACHE_KEY = 'ecochart_binance_symbols_v1';
        const ONE_DAY_MS = 24 * 60 * 60 * 1000;

        try {
            const cached = localStorage.getItem(CACHE_KEY);
            if (cached) {
                const parsed = JSON.parse(cached);
                if (Date.now() - parsed.timestamp < ONE_DAY_MS && Array.isArray(parsed.symbols) && parsed.symbols.length > 0) {
                    return parsed.symbols;
                }
            }
        } catch {}

        try {
            const res = await BinanceClient.safeFetch('https://api.binance.com/api/v3/exchangeInfo');
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();

            const symbols = data.symbols
                .filter((s: any) => s.quoteAsset === 'USDT' && s.status === 'TRADING')
                .map((s: any) => ({
                    symbol: s.symbol,
                    baseAsset: s.baseAsset,
                    quoteAsset: s.quoteAsset
                }));

            if (symbols.length > 0) {
                try { localStorage.setItem(CACHE_KEY, JSON.stringify({ timestamp: Date.now(), symbols })); } catch {}
                return symbols;
            }
        } catch (err) {}

        return [
            { symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT' },
            { symbol: 'ETHUSDT', baseAsset: 'ETH', quoteAsset: 'USDT' },
            { symbol: 'SOLUSDT', baseAsset: 'SOL', quoteAsset: 'USDT' },
            { symbol: 'BNBUSDT', baseAsset: 'BNB', quoteAsset: 'USDT' },
            { symbol: 'XRPUSDT', baseAsset: 'XRP', quoteAsset: 'USDT' },
            { symbol: 'DOGEUSDT', baseAsset: 'DOGE', quoteAsset: 'USDT' }
        ];
    }

    // UPDATED: Added onTicker callback and Combined Streams
    public async connect(symbol: string, interval: string, onUpdate: (prependedCount?: number, isClosed?: boolean) => void, onTicker: (changePct: number) => void) {
        this.disconnect();
        this.currentSyncKey = `${symbol}_${interval}`;

        const isNative = TimeframeResampler.isNative(interval);
        const baseInterval = TimeframeResampler.getBaseNativeInterval(interval);
        const targetIntervalMs = TimeframeResampler.parseMs(interval);
        
        const limitMs = this.getLimitMs(interval);
        const cutoffTime = limitMs === Infinity ? 0 : Date.now() - limitMs;

        // --- 1. LOCAL FIRST DATA LOAD & SYNC ---
        try {
            const prepended = await this.reloadFromDB(symbol, baseInterval, interval, cutoffTime);
            if (this.dataStore.length > 0) onUpdate(prepended);

            let oldestLocal = Date.now();
            let newestLocal = 0;

            const localRecords = await db.candles.where('[symbol+interval]').equals([symbol.toUpperCase(), baseInterval]).filter(r => r.time >= cutoffTime).sortBy('time');
            if (localRecords.length > 0) {
                oldestLocal = localRecords[0].time;
                newestLocal = localRecords[localRecords.length - 1].time;
            }

            if (newestLocal > 0) {
                // Sync Forward (Missing gap up to live)
                await this.fetchAndSaveChunk(symbol, baseInterval, newestLocal + 1, Date.now());
            } else {
                // Initial Fetch
                await this.fetchAndSaveChunk(symbol, baseInterval, undefined, Date.now());
                const freshRecords = await db.candles.where('[symbol+interval]').equals([symbol.toUpperCase(), baseInterval]).filter(r => r.time >= cutoffTime).sortBy('time');
                if (freshRecords.length > 0) oldestLocal = freshRecords[0].time;
            }

            // Reload unified state from DB & start paginating backwards infinitely
            const prepended2 = await this.reloadFromDB(symbol, baseInterval, interval, cutoffTime);
            onUpdate(prepended2, true);
            this.startBackgroundSync(symbol, baseInterval, oldestLocal, cutoffTime, interval, (prep) => onUpdate(prep, true));
        } catch (err) {
            console.error('[Binance] Sync error', err);
        }

        // --- 2. WEBSOCKET FOR LIVE DATA ---
        const klineStream = `${symbol.toLowerCase()}@kline_${baseInterval}`;
        const tickerStream = `${symbol.toLowerCase()}@ticker`;
        const url = `wss://stream.binance.com:9443/stream?streams=${klineStream}/${tickerStream}`;

        this.ws = new WebSocket(url);

        this.ws.onopen = () => { this.isReconnecting = false; };

        this.ws.onmessage = (event) => {
            if (this.currentSyncKey !== `${symbol}_${interval}`) return; // Abort if switched
            
            const raw = JSON.parse(event.data);
            const data = raw.data;
            if (!data) return;

            if (data.e === 'kline') {
                const k = data.k;
                const o = parseFloat(k.o), h = parseFloat(k.h), l = parseFloat(k.l), c = parseFloat(k.c), v = parseFloat(k.v);

                // Update RAM immediately for smooth UI
                if (isNative) {
                    this.dataStore.appendOrUpdate(k.t, o, h, l, c, v);
                } else {
                    const bucketTime = TimeframeResampler.getBucketStart(k.t, targetIntervalMs);
                    this.dataStore.appendOrUpdate(bucketTime, o, h, l, c, v);
                }

                // If candle closes, persist to IndexedDB
                if (k.x) {
                    db.candles.put({
                        id: `${symbol.toUpperCase()}_${baseInterval}_${k.t}`,
                        symbol: symbol.toUpperCase(),
                        interval: baseInterval,
                        time: k.t, o, h, l, c, v
                    }).catch(() => {});
                }
                onUpdate(0, k.x); 
            } 
            else if (data.e === '24hrTicker') {
                const changePct = parseFloat(data.P);
                if (!isNaN(changePct)) onTicker(changePct);
            }
        };

        this.ws.onclose = () => {
            if (!this.isReconnecting && this.currentSyncKey === `${symbol}_${interval}`) {
                this.isReconnecting = true;
                setTimeout(() => this.connect(symbol, interval, onUpdate, onTicker), 2000);
            }
        };
    }

    public disconnect() {
        this.currentSyncKey = ''; // Stops active background sync loop
        this.isReconnecting = true; 
        if (this.ws) {
            this.ws.onclose = null; 
            this.ws.close();
            this.ws = null;
        }
        this.isReconnecting = false;
    }
}