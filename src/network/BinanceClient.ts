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
    public async connect(symbol: string, interval: string, onUpdate: () => void, onTicker: (changePct: number) => void) {
        const isNative = TimeframeResampler.isNative(interval);
        const baseInterval = TimeframeResampler.getBaseNativeInterval(interval);
        const targetIntervalMs = TimeframeResampler.parseMs(interval);

        try {
            const res = await fetch(`https://api.binance.com/api/v3/klines?symbol=${symbol.toUpperCase()}&interval=${baseInterval}&limit=1000`);
            const data = await res.json();

            if (isNative) {
                for (const k of data) {
                    this.dataStore.appendOrUpdate(k[0], parseFloat(k[1]), parseFloat(k[2]), parseFloat(k[3]), parseFloat(k[4]), parseFloat(k[5]));
                }
            } else {
                const resampled = TimeframeResampler.resampleHistory(data, interval);
                for (const bar of resampled) {
                    this.dataStore.appendOrUpdate(bar[0], bar[1], bar[2], bar[3], bar[4], bar[5]);
                }
            }
            onUpdate(); 
        } catch (err) {}

        // Use Combined Streams to get Klines AND 24h Ticker Data
        const klineStream = `${symbol.toLowerCase()}@kline_${baseInterval}`;
        const tickerStream = `${symbol.toLowerCase()}@ticker`;
        const url = `wss://stream.binance.com:9443/stream?streams=${klineStream}/${tickerStream}`;

        this.ws = new WebSocket(url);

        this.ws.onopen = () => {
            this.isReconnecting = false;
        };

        this.ws.onmessage = (event) => {
            const raw = JSON.parse(event.data);
            const data = raw.data; // Combined streams wrap the payload in a 'data' object

            if (!data) return;

            // Handle Kline Updates
            if (data.e === 'kline') {
                const k = data.k;
                const o = parseFloat(k.o), h = parseFloat(k.h), l = parseFloat(k.l), c = parseFloat(k.c), v = parseFloat(k.v);

                if (isNative) {
                    this.dataStore.appendOrUpdate(k.t, o, h, l, c, v);
                } else {
                    const bucketTime = TimeframeResampler.getBucketStart(k.t, targetIntervalMs);
                    this.dataStore.appendOrUpdate(bucketTime, o, h, l, c, v);
                }
                onUpdate(); 
            } 
            // Handle 24h Ticker Updates (For % Change)
            else if (data.e === '24hrTicker') {
                const changePct = parseFloat(data.P);
                if (!isNaN(changePct)) onTicker(changePct);
            }
        };

        this.ws.onclose = () => {
            if (!this.isReconnecting) {
                this.isReconnecting = true;
                setTimeout(() => this.connect(symbol, interval, onUpdate, onTicker), 2000);
            }
        };
    }

    public disconnect() {
        this.isReconnecting = true; 
        if (this.ws) {
            this.ws.onclose = null; 
            this.ws.close();
            this.ws = null;
        }
        this.isReconnecting = false;
    }
}