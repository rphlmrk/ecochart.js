// src/workers/MathWorkerClient.ts

export class MathWorkerClient {
    private static worker: Worker;
    private static callbacks = new Map<number, Function>();
    private static msgId = 0;

    public static init() {
        if (!this.worker) {
            // Vite native web worker import
            this.worker = new Worker(new URL('./math.worker.ts', import.meta.url), { type: 'module' });
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

    public static async calculate(type: string, activeData: Float64Array, params: any): Promise<any> {
        this.init();
        return new Promise(resolve => {
            const id = this.msgId++;
            this.callbacks.set(id, resolve);

            try {
                // Zero-Copy Check: If the buffer is a SharedArrayBuffer, pass it directly without transferring
                if (typeof SharedArrayBuffer !== 'undefined' && activeData.buffer instanceof SharedArrayBuffer) {
                    this.worker.postMessage({ id, type, data: activeData, params });
                    return;
                }
            } catch (e) { }

            // Standard Memory Fallback: Tightly pack the active slice into a new buffer and transfer ownership
            const dataCopy = new Float64Array(activeData);
            this.worker.postMessage({ id, type, data: dataCopy, params }, [dataCopy.buffer]);
        });
    }
}