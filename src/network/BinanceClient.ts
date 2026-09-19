import { DataStore } from '../data/DataStore';
import { TimeframeResampler } from '../data/TimeframeResampler';

export class BinanceClient {
    private ws: WebSocket | null = null;
    private dataStore: DataStore;
    private isReconnecting = false;

    constructor(dataStore: DataStore) {
        this.dataStore = dataStore;
    }

    public async fetchTradableSymbols(): Promise<Array<{ symbol: string; baseAsset: string; quoteAsset: string }>> {
        const CACHE_KEY = 'ecochart_binance_symbols_v1';
        const ONE_DAY_MS = 24 * 60 * 60 * 1000;

        // 1. Check local cache first so it loads instantly without network lag
        try {
            const cached = localStorage.getItem(CACHE_KEY);
            if (cached) {
                const parsed = JSON.parse(cached);
                if (Date.now() - parsed.timestamp < ONE_DAY_MS && Array.isArray(parsed.symbols) && parsed.symbols.length > 0) {
                    return parsed.symbols;
                }
            }
        } catch {
            // Ignore parse errors and fetch fresh
        }

        // 2. Fetch live directory from Binance public REST API
        try {
            console.log('[Binance] Fetching full exchange directory...');
            const res = await fetch('https://api.binance.com/api/v3/exchangeInfo');
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
                try {
                    localStorage.setItem(CACHE_KEY, JSON.stringify({ timestamp: Date.now(), symbols }));
                } catch {
                    // Storage quota fallback
                }
                return symbols;
            }
        } catch (err) {
            console.warn('[Binance] Failed to fetch live exchange directory, using fallback presets:', err);
        }

        // 3. Fallback popular pairs if offline or rate-limited
        return [
            { symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT' },
            { symbol: 'ETHUSDT', baseAsset: 'ETH', quoteAsset: 'USDT' },
            { symbol: 'SOLUSDT', baseAsset: 'SOL', quoteAsset: 'USDT' },
            { symbol: 'BNBUSDT', baseAsset: 'BNB', quoteAsset: 'USDT' },
            { symbol: 'XRPUSDT', baseAsset: 'XRP', quoteAsset: 'USDT' },
            { symbol: 'DOGEUSDT', baseAsset: 'DOGE', quoteAsset: 'USDT' },
            { symbol: 'ADAUSDT', baseAsset: 'ADA', quoteAsset: 'USDT' },
            { symbol: 'AVAXUSDT', baseAsset: 'AVAX', quoteAsset: 'USDT' },
            { symbol: 'SUIUSDT', baseAsset: 'SUI', quoteAsset: 'USDT' },
            { symbol: 'LINKUSDT', baseAsset: 'LINK', quoteAsset: 'USDT' },
            { symbol: 'NEARUSDT', baseAsset: 'NEAR', quoteAsset: 'USDT' }
        ];
    }

    public async connect(symbol: string, interval: string, onUpdate: () => void) {
        const isNative = TimeframeResampler.isNative(interval);
        const baseInterval = TimeframeResampler.getBaseNativeInterval(interval);
        const targetIntervalMs = TimeframeResampler.parseMs(interval);

        // 1. Fetch historical candles (using the base native interval)
        try {
            console.log(`[Binance] Fetching history for ${symbol} @ ${baseInterval} (Target: ${interval})...`);
            const res = await fetch(`https://api.binance.com/api/v3/klines?symbol=${symbol.toUpperCase()}&interval=${baseInterval}&limit=1000`);
            const data = await res.json();

            if (isNative) {
                for (const k of data) {
                    this.dataStore.appendOrUpdate(
                        k[0],
                        parseFloat(k[1]), parseFloat(k[2]),
                        parseFloat(k[3]), parseFloat(k[4]), parseFloat(k[5])
                    );
                }
            } else {
                // Resample raw history into the requested custom timeframe
                const resampled = TimeframeResampler.resampleHistory(data, interval);
                for (const bar of resampled) {
                    this.dataStore.appendOrUpdate(bar[0], bar[1], bar[2], bar[3], bar[4], bar[5]);
                }
            }
            onUpdate(); // Draw history instantly
        } catch (err) {
            console.error("[Binance] Failed to fetch history", err);
        }

        // 2. Connect WebSocket for live ticks (subscribes to the base stream)
        const streamName = `${symbol.toLowerCase()}@kline_${baseInterval}`;
        const url = `wss://stream.binance.com:9443/ws/${streamName}`;

        this.ws = new WebSocket(url);

        this.ws.onopen = () => {
            console.log(`[Binance] Connected to Live Stream: ${streamName}`);
            this.isReconnecting = false;
        };

        this.ws.onmessage = (event) => {
            const raw = JSON.parse(event.data);
            if (raw.e === 'kline') {
                const k = raw.k;
                const o = parseFloat(k.o);
                const h = parseFloat(k.h);
                const l = parseFloat(k.l);
                const c = parseFloat(k.c);
                const v = parseFloat(k.v);

                if (isNative) {
                    this.dataStore.appendOrUpdate(k.t, o, h, l, c, v);
                } else {
                    // Resample live tick into the active custom bucket
                    const bucketTime = TimeframeResampler.getBucketStart(k.t, targetIntervalMs);
                    this.dataStore.appendOrUpdate(bucketTime, o, h, l, c, v);
                }
                onUpdate(); // Trigger UI redraw
            }
        };

        this.ws.onclose = () => {
            console.warn('[Binance] Disconnected. Reconnecting in 2s...');
            if (!this.isReconnecting) {
                this.isReconnecting = true;
                setTimeout(() => this.connect(symbol, interval, onUpdate), 2000);
            }
        };
    }

    public disconnect() {
        this.isReconnecting = true; // Prevent automatic reconnect loops during manual switches
        if (this.ws) {
            this.ws.onclose = null; // Suppress reconnect callbacks
            this.ws.close();
            this.ws = null;
        }
        this.isReconnecting = false;
    }
}