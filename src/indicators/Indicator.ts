import { Graphics } from 'pixi.js';
import type { ChartRenderer } from '../renderer/ChartRenderer';
import type { DataStore } from '../data/DataStore';

export interface IndicatorLayout {
    mainChartHeight: number;
    oscY: number;
    oscHeight: number;
    chartWidth: number;
}

export abstract class BaseIndicator {
    public id: string;
    public name: string;
    public isOscillator: boolean;
    public values: Float64Array;
    protected lastCalculatedIdx = -1;

    constructor(id: string, name: string, isOscillator = false) {
        this.id = id;
        this.name = name;
        this.isOscillator = isOscillator;
        this.values = new Float64Array(20000); // Pre-allocate to prevent GC spikes
    }

    public update(dataStore: DataStore) {
        if (dataStore.length === 0) {
            this.lastCalculatedIdx = -1;
            return;
        }
        if (dataStore.length > this.values.length) {
            const newArr = new Float64Array(this.values.length * 2);
            newArr.set(this.values);
            this.values = newArr;
        }
        this.calculate(dataStore);
    }

    protected abstract calculate(dataStore: DataStore): void;
    public abstract render(renderer: ChartRenderer, layout: IndicatorLayout, graphics: Graphics): void;
}

// --- CORE MATH ENGINE UTILS ---

export class SMAEngine {
    public static calculate(dataStore: DataStore, period: number, output: Float64Array, lastIdx: number): number {
        const start = Math.max(period - 1, lastIdx === -1 ? 0 : lastIdx);
        for (let i = start; i < dataStore.length; i++) {
            let sum = 0;
            for (let j = 0; j < period; j++) {
                sum += dataStore.data[(i - j) * 6 + 4]; // Close Price
            }
            output[i] = sum / period;
        }
        return dataStore.length - 1;
    }
}

export class EMAEngine {
    public static calculate(dataStore: DataStore, period: number, output: Float64Array, lastIdx: number): number {
        const k = 2 / (period + 1);
        const start = Math.max(1, lastIdx === -1 ? 1 : lastIdx);
        
        if (lastIdx <= 0 && dataStore.length > 0) {
            output[0] = dataStore.data[4]; // Initialize first EMA with first Close
        }
        
        for (let i = start; i < dataStore.length; i++) {
            const close = dataStore.data[i * 6 + 4];
            output[i] = (close - output[i - 1]) * k + output[i - 1];
        }
        return dataStore.length - 1;
    }
}