import { DataStore } from '../data/DataStore';
import { TimeframeResampler } from '../data/TimeframeResampler';
import { DataWorkerClient } from '../workers/DataWorkerClient';
import { favoritesManager } from '../data/FavoritesManager';

export interface TickerData {
    lastPrice: number;
    changePct: number;
    quoteVolume: number; // 24h Volume in USDT
}

export class BinanceClient {
    private ws: WebSocket | null = null;
    private dataStore: DataStore;
    private isReconnecting = false;
    private isConnecting = false;

    // Wakeup & Health State
    private lastMessageTime = Date.now();
    private savedSymbol = '';
    private savedInterval = '';
    private savedOnUpdate: ((prependedCount?: number, isClosed?: boolean) => void) | null = null;
    private savedOnTicker: ((changePct: number) => void) | null = null;
    private isSyncingGap = false;

    // Rate Limiter & Queue State
    private static requestQueue: Array<() => Promise<void>> = [];
    private static isProcessingQueue = false;
    private static rateLimitUntil = 0;
    private static readonly MIN_REQUEST_INTERVAL_MS = 120; // Max ~8 req/sec safely under 1200 weight/min

    // 24h Mini-Ticker Cache (120s TTL to prevent rate limits)
    public static tickerCache: Record<string, TickerData> = {};
    private static tickerCacheTime = 0;
    private static readonly TICKER_CACHE_TTL = 120_000; // 2 minutes

    // Binance Server Clock Drift Calibration
    public static serverTimeOffset = 0;
    public static getServerTime(): number {
        return Date.now() + BinanceClient.serverTimeOffset;
    }

    constructor(dataStore: DataStore) {
        this.dataStore = dataStore;
    }

    private currentSyncKey = '';

    private getLimitMs(interval: string): number {
        let limits: Record<string, number> = {
            'limit_1m_3m': 7, 'limit_4m_8m': 7, 'limit_9m_12m': 30, 'limit_15m': 90,
            'limit_30m_45m': 180, 'limit_1h_3h': 365, 'limit_4h_6h': 730, 'limit_7h_12h': 1460,
            'limit_13h_1d': 1825, 'limit_1w_1M': 3650
        };
        try {
            const raw = localStorage.getItem('ecochart_workspace_v1');
            if (raw) {
                const state = JSON.parse(raw);
                if (state.dataLimits) limits = { ...limits, ...state.dataLimits };
            }
        } catch { }

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

    private async reloadFromDB(symbol: string, baseInterval: string, interval: string, cutoffTime: number): Promise<{ prepended: number, oldest: number }> {
        const buffer = await DataWorkerClient.loadHistory(symbol, baseInterval, interval, cutoffTime);
        if (buffer && buffer.length > 0) {
            const prepended = this.dataStore.setFromBuffer(buffer);
            return { prepended, oldest: buffer[0] };
        }
        return { prepended: 0, oldest: Date.now() };
    }

    private async fetchAndSaveChunk(symbol: string, baseInterval: string, startTime: number | undefined, endTime: number) {
        return await DataWorkerClient.fetchAndSaveChunk(symbol, baseInterval, startTime, endTime);
    }

    private async startBackgroundSync(symbol: string, baseInterval: string, oldestLocal: number, cutoffTime: number, interval: string, onUpdate: (prependedCount?: number) => void) {
        let currentEnd = oldestLocal - 1;
        while (currentEnd > cutoffTime && this.currentSyncKey === `${symbol}_${interval}`) {
            const oldestFetched = await this.fetchAndSaveChunk(symbol, baseInterval, undefined, currentEnd);
            if (oldestFetched === 0) break;
            currentEnd = oldestFetched - 1;

            const { prepended } = await this.reloadFromDB(symbol, baseInterval, interval, cutoffTime);
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
        } catch { }

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
                try { localStorage.setItem(CACHE_KEY, JSON.stringify({ timestamp: Date.now(), symbols })); } catch { }
                return symbols;
            }
        } catch (err) { }

        return [
            { symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT' },
            { symbol: 'ETHUSDT', baseAsset: 'ETH', quoteAsset: 'USDT' },
            { symbol: 'SOLUSDT', baseAsset: 'SOL', quoteAsset: 'USDT' },
            { symbol: 'BNBUSDT', baseAsset: 'BNB', quoteAsset: 'USDT' },
            { symbol: 'XRPUSDT', baseAsset: 'XRP', quoteAsset: 'USDT' },
            { symbol: 'DOGEUSDT', baseAsset: 'DOGE', quoteAsset: 'USDT' }
        ];
    }

    /**
     * Fetches lightweight 24h mini-tickers in a single bulk request.
     * Cached in RAM for 120 seconds to prevent eating API rate limits.
     */
    public async fetch24hTickers(): Promise<Record<string, TickerData>> {
        const now = Date.now();
        // Return cached data if still within the 120s TTL window
        if (
            now - BinanceClient.tickerCacheTime < BinanceClient.TICKER_CACHE_TTL &&
            Object.keys(BinanceClient.tickerCache).length > 0
        ) {
            return BinanceClient.tickerCache;
        }

        try {
            // Uses lightweight MINI endpoint (only ~40 weight vs 80 full)
            const res = await BinanceClient.safeFetch('https://api.binance.com/api/v3/ticker/24hr?type=MINI');
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();

            if (Array.isArray(data)) {
                const map: Record<string, TickerData> = {};
                for (let i = 0; i < data.length; i++) {
                    const item = data[i];
                    const lastPrice = parseFloat(item.lastPrice) || 0;
                    const openPrice = parseFloat(item.openPrice) || 0;
                    const quoteVolume = parseFloat(item.quoteVolume) || 0;
                    const changePct = openPrice > 0 ? ((lastPrice - openPrice) / openPrice) * 100 : 0;

                    map[item.symbol] = {
                        lastPrice,
                        changePct,
                        quoteVolume
                    };
                }

                BinanceClient.tickerCache = map;
                BinanceClient.tickerCacheTime = now;
                return map;
            }
        } catch (err) {
            console.warn('[Binance] Failed to fetch 24h mini tickers, returning cached data:', err);
        }

        return BinanceClient.tickerCache;
    }

    // UPDATED: Added onTicker callback and Combined Streams
    public async connect(symbol: string, interval: string, onUpdate: (prependedCount?: number, isClosed?: boolean) => void, onTicker: (changePct: number) => void) {
        if (this.isConnecting) return; // Prevent duplicate overlapping connections
        this.isConnecting = true;

        this.disconnect();
        this.currentSyncKey = `${symbol}_${interval}`;
        this.savedSymbol = symbol;
        this.savedInterval = interval;
        this.savedOnUpdate = onUpdate;
        this.savedOnTicker = onTicker;
        this.lastMessageTime = Date.now();

        const isNative = TimeframeResampler.isNative(interval);
        const baseInterval = TimeframeResampler.getBaseNativeInterval(interval);
        const targetIntervalMs = TimeframeResampler.parseMs(interval);

        const limitMs = this.getLimitMs(interval);
        const rawCutoffTime = limitMs === Infinity ? 0 : Date.now() - limitMs;

        // Snap the cutoff time to the exact timeframe boundary to prevent partial/broken historical candles
        const cutoffTime = rawCutoffTime === 0 ? 0 : TimeframeResampler.getBucketStart(rawCutoffTime, targetIntervalMs);

        // Check if this symbol should be written to IndexedDB
        const shouldPersist = !favoritesManager.onlySaveFavorites || favoritesManager.isFavorite(symbol);

        // --- 1. ONLINE-FIRST: FETCH LATEST 1,000 BARS DIRECT FROM BINANCE ---
        try {
            const liveBuffer = await DataWorkerClient.fetchGap(symbol, baseInterval, interval, 0, Date.now(), shouldPersist);
            if (liveBuffer && liveBuffer.length > 0 && this.currentSyncKey === `${symbol}_${interval}`) {
                this.dataStore.setFromBuffer(liveBuffer);
                onUpdate(0, true);
            }
        } catch (e) {
            console.warn('[Binance] Online-first fetch failed, falling back to local DB', e);
        }

        // Offline fallback: Only query IndexedDB if this symbol is persisted
        if (this.dataStore.length === 0 && shouldPersist) {
            try {
                const resDB = await this.reloadFromDB(symbol, baseInterval, interval, cutoffTime);
                if (this.dataStore.length > 0) onUpdate(resDB.prepended, true);
            } catch { }
        }

        // --- 2. CONNECT WEBSOCKET IMMEDIATELY (LIVE CANDLES NEVER STALL) ---
        const klineStream = `${symbol.toLowerCase()}@kline_${baseInterval}`;
        const tickerStream = `${symbol.toLowerCase()}@ticker`;
        const url = `wss://stream.binance.com:9443/stream?streams=${klineStream}/${tickerStream}`;

        this.ws = new WebSocket(url);

        // --- 3. BACKGROUND STITCH: ONLY FOR PERSISTED SYMBOLS ---
        if (shouldPersist) {
            (async () => {
                try {
                    if (this.currentSyncKey !== `${symbol}_${interval}`) return;

                    const resDB = await this.reloadFromDB(symbol, baseInterval, interval, cutoffTime);
                    if (resDB.prepended > 0 && this.currentSyncKey === `${symbol}_${interval}`) {
                        onUpdate(resDB.prepended, true);
                    }

                    if (this.currentSyncKey === `${symbol}_${interval}`) {
                        this.startBackgroundSync(symbol, baseInterval, resDB.oldest, cutoffTime, interval, (prep) => onUpdate(prep, true));
                    }
                } catch (err) {
                    console.error('[Binance] Background history stitch error', err);
                }
            })();
        }

        this.ws.onopen = () => {
            this.isConnecting = false;
            this.isReconnecting = false;
            this.lastMessageTime = Date.now();
        };

        // --- PHASE 2 FIX: Prevent Reconnection Deadlock if internet drops ---
        this.ws.onerror = (err) => {
            console.error('[Binance] WebSocket error:', err);
            this.isConnecting = false;
        };

        this.ws.onmessage = async (event) => {
            if (this.currentSyncKey !== `${symbol}_${interval}`) return; // Abort if switched
            this.lastMessageTime = Date.now();

            const raw = JSON.parse(event.data);
            const data = raw.data;
            if (!data) return;

            // Zero-cost clock synchronization using Binance's exact server event timestamp (E)
            if (data.E) {
                BinanceClient.serverTimeOffset = data.E - Date.now();
            }

            if (data.e === 'kline') {
                const k = data.k;
                const o = parseFloat(k.o), h = parseFloat(k.h), l = parseFloat(k.l), c = parseFloat(k.c), v = parseFloat(k.v);

                // Gap Check: Backfill missing history in the background using the exact missing time window
                if (this.dataStore.length > 0 && !this.isSyncingGap) {
                    const lastCandleTime = this.dataStore.data[(this.dataStore.length - 1) * 6];
                    if (k.t - lastCandleTime > targetIntervalMs) {
                        this.syncMissingGap(symbol, interval, true, lastCandleTime, k.t);
                    }
                }

                // --- PHASE 3 FIX: True HTF Shape Locking & Live Forming ---
                const isBaseClosed = k.x;
                let isHTFClosed = isBaseClosed;
                let bucketTime = k.t;

                if (isNative) {
                    this.dataStore.appendOrUpdate(k.t, o, h, l, c, v);
                } else {
                    bucketTime = TimeframeResampler.getBucketStart(k.t, targetIntervalMs);
                    this.dataStore.appendOrUpdate(bucketTime, o, h, l, c, v);

                    const baseMs = TimeframeResampler.parseMs(baseInterval);
                    // HTF candle ONLY closes if the base candle closes AND it pushes against the HTF boundary
                    isHTFClosed = isBaseClosed && ((k.t + baseMs) >= (bucketTime + targetIntervalMs));
                }

                // IMPORTANT: We STILL save the base candle to IndexedDB so we don't lose granular history
                if (isBaseClosed && shouldPersist) {
                    DataWorkerClient.saveCandle({
                        id: `${symbol.toUpperCase()}_${baseInterval}_${k.t}`,
                        symbol: symbol.toUpperCase(),
                        interval: baseInterval,
                        time: k.t, o, h, l, c, v
                    }, shouldPersist);
                }

                // BUT we ONLY tell the indicator math engine that the candle closed if the HTF is completely finished
                onUpdate(0, isHTFClosed);
            }
            else if (data.e === '24hrTicker') {
                const changePct = parseFloat(data.P);
                if (!isNaN(changePct)) onTicker(changePct);
            }
        };

        this.ws.onclose = () => {
            this.isConnecting = false; // <-- PHASE 2 FIX: Clear lock so reconnects work
            if (!this.isReconnecting && this.currentSyncKey === `${symbol}_${interval}`) {
                this.isReconnecting = true;
                setTimeout(() => this.connect(symbol, interval, onUpdate, onTicker), 2000);
            }
        };
    }

    public disconnect() {
        this.currentSyncKey = ''; // Stops active background sync loop
        this.isSyncingGap = false; // Reset lock to prevent deadlocking new connections
        this.isReconnecting = true;
        if (this.ws) {
            this.ws.onclose = null;
            this.ws.close();
            this.ws = null;
        }
        this.isReconnecting = false;
    }

    /**
     * Backfills missing historical candles between the specified gap range or from the last bar in RAM to now.
     */
    public async syncMissingGap(
        symbol = this.savedSymbol,
        interval = this.savedInterval,
        force = false,
        fromTime?: number,
        toTime?: number
    ): Promise<boolean> {
        const sym = symbol.toUpperCase();
        if (!sym || !interval || this.dataStore.length === 0 || this.isSyncingGap) return false;

        const lastIdx = this.dataStore.length - 1;
        const lastCandleTime = this.dataStore.data[lastIdx * 6];
        const targetIntervalMs = TimeframeResampler.parseMs(interval);
        const now = Date.now();

        // Use the exact missing window if provided; otherwise fallback to lastCandleTime -> now
        const startFetchTime = fromTime !== undefined ? fromTime : lastCandleTime;
        const endFetchTime = toTime !== undefined ? toTime : now;

        // Only fetch if at least 1 full bar is missing (or if watchdog forced recovery)
        if (!force && (endFetchTime - startFetchTime) < (targetIntervalMs * 1.5)) return false;

        this.isSyncingGap = true;
        try {
            const baseInterval = TimeframeResampler.getBaseNativeInterval(interval);

            // Strict 4-second timeout to prevent mobile network lag from hanging the engine
            const fetchPromise = DataWorkerClient.fetchGap(sym, baseInterval, interval, startFetchTime, endFetchTime);
            const timeoutPromise = new Promise<Float64Array>((_, reject) =>
                setTimeout(() => reject(new Error('Gap sync timed out (4s)')), 4000)
            );

            const buffer = await Promise.race([fetchPromise, timeoutPromise]);

            if (buffer && buffer.length > 0) {
                for (let i = 0; i < buffer.length; i += 6) {
                    this.dataStore.appendOrUpdate(buffer[i], buffer[i + 1], buffer[i + 2], buffer[i + 3], buffer[i + 4], buffer[i + 5]);
                }
                if (this.savedOnUpdate) {
                    this.savedOnUpdate(0, true);
                }
                return true;
            }
            return false;
        } catch (err) {
            console.warn('[Binance] Gap backfill skipped or timed out:', err);
            return false;
        } finally {
            this.isSyncingGap = false;
        }
    }

    public handleOffline() {
        if (this.ws) {
            this.ws.onclose = null;
            this.ws.close();
            this.ws = null;
        }
    }

    public async handleWakeup() {
        if (!this.currentSyncKey || this.isConnecting) return;

        // If the socket is currently opening (CONNECTING), do NOT kill it!
        if (this.ws && this.ws.readyState === WebSocket.CONNECTING) return;

        const now = Date.now();
        const isClosed = !this.ws || this.ws.readyState === WebSocket.CLOSED || this.ws.readyState === WebSocket.CLOSING;
        const isStalled = (now - this.lastMessageTime) > 15000;

        if (isClosed || isStalled) {
            this.disconnect();
            if (this.savedOnUpdate && this.savedOnTicker) {
                await this.connect(this.savedSymbol, this.savedInterval, this.savedOnUpdate, this.savedOnTicker);
            }
        } else if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            // Socket is healthy: smoothly backfill any gaps without restarting
            await this.syncMissingGap(this.savedSymbol, this.savedInterval, true);
        }
    }

    /**
     * Watchdog Recovery: Triggered when countdown timer hangs at 00:00 for 3+ seconds.
     */
    public async handleWatchdogRecovery() {
        if (!this.currentSyncKey) return;

        // 1. Immediately backfill missing candle(s) via REST
        const backfilled = await this.syncMissingGap(this.savedSymbol, this.savedInterval, true);

        // 2. If socket is dead or hasn't received messages in 3+ seconds, reset it
        const isClosed = !this.ws || this.ws.readyState !== WebSocket.OPEN;
        const isStalled = (Date.now() - this.lastMessageTime) > 3000;

        if (isClosed || isStalled) {
            this.disconnect();
            if (this.savedOnUpdate && this.savedOnTicker) {
                await this.connect(this.savedSymbol, this.savedInterval, this.savedOnUpdate, this.savedOnTicker);
            }
        } else if (backfilled && this.savedOnUpdate) {
            this.savedOnUpdate(0, true);
        }
    }
}
