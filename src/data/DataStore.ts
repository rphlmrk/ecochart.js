const ITEMS_PER_CANDLE = 6; // Time, Open, High, Low, Close, Volume

export class DataStore {
    public data: Float64Array;
    public length: number = 0;
    private capacity: number;

    constructor(initialCapacity = 10000) {
        this.capacity = initialCapacity;
        this.data = new Float64Array(this.capacity * ITEMS_PER_CANDLE);
    }

    public clear() {
        this.length = 0;
    }

    // Mirrors your Go `mergeCandles` logic
    public appendOrUpdate(time: number, o: number, h: number, l: number, c: number, v: number): boolean {
        let isNewCandle = false;

        if (this.length === 0) {
            this.setCandle(0, time, o, h, l, c, v);
            this.length++;
            isNewCandle = true;
        } else {
            const lastIdx = this.length - 1;
            const lastTime = this.data[lastIdx * ITEMS_PER_CANDLE];

            if (time === lastTime) {
                // Update forming candle
                this.updateCandle(lastIdx, h, l, c, v);
            } else if (time > lastTime) {
                // Resize array if we hit capacity
                if (this.length >= this.capacity) this.resize();

                // Append new candle
                this.setCandle(this.length, time, o, h, l, c, v);
                this.length++;
                isNewCandle = true;
            }
        }
        return isNewCandle; // Tell the renderer if it needs to shift the camera
    }

    private updateCandle(idx: number, h: number, l: number, c: number, v: number) {
        const base = idx * ITEMS_PER_CANDLE;
        if (h > this.data[base + 2]) this.data[base + 2] = h; // High
        if (l < this.data[base + 3]) this.data[base + 3] = l; // Low
        this.data[base + 4] = c; // Close
        this.data[base + 5] = Math.max(this.data[base + 5], v); // Volume
    }

    private setCandle(idx: number, t: number, o: number, h: number, l: number, c: number, v: number) {
        const base = idx * ITEMS_PER_CANDLE;
        this.data[base] = t;
        this.data[base + 1] = o;
        this.data[base + 2] = h;
        this.data[base + 3] = l;
        this.data[base + 4] = c;
        this.data[base + 5] = v;
    }

    private resize() {
        this.capacity *= 2;
        const newData = new Float64Array(this.capacity * ITEMS_PER_CANDLE);
        newData.set(this.data);
        this.data = newData;
    }
}