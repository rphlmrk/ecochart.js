import { DataStore } from '../data/DataStore';

export class BinanceClient {
    private ws: WebSocket | null = null;
    private dataStore: DataStore;
    private isReconnecting = false;

    constructor(dataStore: DataStore) {
        this.dataStore = dataStore;
    }

    public async connect(symbol: string, interval: string, onUpdate: () => void) {
        // 1. Fetch 1000 historical candles first so the screen isn't blank
        try {
            console.log(`[Binance] Fetching history for ${symbol}...`);
            const res = await fetch(`https://api.binance.com/api/v3/klines?symbol=${symbol.toUpperCase()}&interval=${interval}&limit=1000`);
            const data = await res.json();

            for (const k of data) {
                this.dataStore.appendOrUpdate(
                    k[0], // Time
                    parseFloat(k[1]), parseFloat(k[2]),
                    parseFloat(k[3]), parseFloat(k[4]), parseFloat(k[5])
                );
            }
            onUpdate(); // Draw the history instantly
        } catch (err) {
            console.error("[Binance] Failed to fetch history", err);
        }

        // 2. Connect WebSocket for live ticks
        const streamName = `${symbol.toLowerCase()}@kline_${interval}`;
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
                this.dataStore.appendOrUpdate(
                    k.t,
                    parseFloat(k.o), parseFloat(k.h),
                    parseFloat(k.l), parseFloat(k.c),
                    parseFloat(k.v)
                );
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