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

    public setAll(candles: Array<[number, number, number, number, number, number]>): number {
        let prependedCount = 0;
        if (this.length > 0 && candles.length > 0) {
            const oldOldest = this.data[0];
            for (let i = 0; i < candles.length; i++) {
                if (candles[i][0] === oldOldest) {
                    prependedCount = i;
                    break;
                }
            }
        }

        // Protect the actively forming live candle from being overwritten by a background sync
        let formingCandle: number[] | null = null;
        if (this.length > 0) {
            const base = (this.length - 1) * 6;
            formingCandle = [this.data[base], this.data[base + 1], this.data[base + 2], this.data[base + 3], this.data[base + 4], this.data[base + 5]];
        }

        this.clear();
        while (this.capacity < candles.length + 1) {
            this.capacity *= 2;
        }
        if (this.data.length < this.capacity * 6) {
            this.data = new Float64Array(this.capacity * 6);
        }

        for (let i = 0; i < candles.length; i++) {
            const base = i * 6;
            const c = candles[i];
            this.data[base] = c[0]; this.data[base + 1] = c[1]; this.data[base + 2] = c[2];
            this.data[base + 3] = c[3]; this.data[base + 4] = c[4]; this.data[base + 5] = c[5];
        }
        this.length = candles.length;

        // Restore the live forming candle if it belongs at the end
        if (formingCandle && this.length > 0) {
            const lastTime = this.data[(this.length - 1) * 6];
            if (formingCandle[0] >= lastTime) {
                this.appendOrUpdate(formingCandle[0], formingCandle[1], formingCandle[2], formingCandle[3], formingCandle[4], formingCandle[5]);
            }
        }
        return prependedCount;
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
            } else {
                // Out-of-order or gap-filling candle: insert chronologically instead of dropping
                this.insertOrUpdateCandle(time, o, h, l, c, v);
                isNewCandle = true;
            }
        }
        return isNewCandle; // Tell the renderer if it needs to shift the camera
    }

    private insertOrUpdateCandle(time: number, o: number, h: number, l: number, c: number, v: number) {
        let low = 0;
        let high = this.length - 1;
        while (low <= high) {
            const mid = Math.floor((low + high) / 2);
            const t = this.data[mid * ITEMS_PER_CANDLE];
            if (t === time) {
                this.updateCandle(mid, h, l, c, v);
                return;
            }
            if (t < time) low = mid + 1;
            else high = mid - 1;
        }

        if (this.length >= this.capacity) this.resize();
        const insertIdx = low;
        const srcStart = insertIdx * ITEMS_PER_CANDLE;
        const copyLength = (this.length - insertIdx) * ITEMS_PER_CANDLE;

        this.data.copyWithin(srcStart + ITEMS_PER_CANDLE, srcStart, srcStart + copyLength);
        this.setCandle(insertIdx, time, o, h, l, c, v);
        this.length++;
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