// src/workers/DataWorkerClient.ts
export class DataWorkerClient {
    private static worker: Worker;
    private static callbacks = new Map<number, Function>();
    private static msgId = 0;

    public static init() {
        if (!this.worker) {
            this.worker = new Worker(new URL('./data.worker.ts', import.meta.url), { type: 'module' });
            this.worker.onmessage = (e) => {
                const { id, result, error } = e.data;
                const cb = this.callbacks.get(id);
                if (cb) {
                    cb(error ? null : result);
                    this.callbacks.delete(id);
                }
            };
        }
    }

    public static async loadHistory(symbol: string, baseInterval: string, interval: string, cutoffTime: number): Promise<Float64Array> {
        this.init();
        return new Promise(resolve => {
            const id = this.msgId++;
            this.callbacks.set(id, resolve);
            this.worker.postMessage({ id, type: 'LOAD_HISTORY', payload: { symbol, baseInterval, interval, cutoffTime } });
        });
    }

    public static async fetchAndSaveChunk(symbol: string, baseInterval: string, startTime: number | undefined, endTime: number, persist = true): Promise<number> {
        this.init();
        return new Promise(resolve => {
            const id = this.msgId++;
            this.callbacks.set(id, resolve);
            this.worker.postMessage({ id, type: 'FETCH_CHUNK', payload: { symbol, baseInterval, startTime, endTime, persist } });
        });
    }

    public static async fetchGap(symbol: string, baseInterval: string, interval: string, startTime: number, endTime: number, persist = true): Promise<Float64Array> {
        this.init();
        return new Promise(resolve => {
            const id = this.msgId++;
            this.callbacks.set(id, resolve);
            this.worker.postMessage({ id, type: 'FETCH_GAP', payload: { symbol, baseInterval, interval, startTime, endTime, persist } });
        });
    }

    public static saveCandle(record: any, persist = true) {
        this.init();
        this.worker.postMessage({ id: this.msgId++, type: 'SAVE_CANDLE', payload: { record, persist } });
    }

    /**
     * Multi-Pane Safe Prune:
     * Deletes from storage ONLY symbols that are neither favorites nor in an active pane.
     */
    public static async pruneNonFavorites(favorites: string[], activeSymbols: string[]): Promise<boolean> {
        this.init();
        return new Promise(resolve => {
            const id = this.msgId++;
            this.callbacks.set(id, resolve);
            this.worker.postMessage({ id, type: 'PRUNE_NON_FAVORITES', payload: { favorites, activeSymbols } });
        });
    }
}