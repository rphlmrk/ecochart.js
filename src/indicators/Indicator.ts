import { Graphics } from 'pixi.js';
import type { ChartRenderer } from '../renderer/ChartRenderer';
import type { DataStore } from '../data/DataStore';

export type ParamType = 'number' | 'color' | 'boolean' | 'select';

export interface ParamDef {
    id: string;
    name: string;
    type: ParamType;
    value: any;
    options?: string[]; // Used when type === 'select'
    min?: number;
    max?: number;
    step?: number;
}

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
    public params: ParamDef[] = [];
    protected lastCalculatedIdx = -1;

    constructor(id: string, name: string, isOscillator = false) {
        this.id = id;
        this.name = name;
        this.isOscillator = isOscillator;
        this.values = new Float64Array(20000); // Pre-allocated buffer to eliminate GC spikes
    }

    /**
     * Safely reads a parameter value by ID with optional fallback
     */
    public getParam<T = any>(id: string, fallback?: T): T {
        const param = this.params.find(p => p.id === id);
        return param !== undefined ? param.value : (fallback as T);
    }

    /**
     * Applies new parameter values from the UI, triggers onParamsUpdated,
     * and resets calculation indices so the math engine recalculates fresh.
     */
    public updateParams(newValues: Record<string, any>) {
        let hasChanges = false;
        for (const param of this.params) {
            if (newValues[param.id] !== undefined && newValues[param.id] !== param.value) {
                param.value = newValues[param.id];
                hasChanges = true;
            }
        }

        if (hasChanges) {
            this.onParamsUpdated();
            this.lastCalculatedIdx = -1; // Invalidate cache to force math recalculation
        }
    }

    /**
     * Optional hook for subclasses to update titles or IDs when params change
     */
    protected onParamsUpdated(): void {}

    public update(dataStore: DataStore) {
        if (dataStore.length === 0) {
            this.lastCalculatedIdx = -1;
            return;
        }

        // Auto-expand buffer if DataStore exceeds capacity
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

// --- CORE MATH ENGINES ---

export class SMAEngine {
    public static calculate(dataStore: DataStore, period: number, output: Float64Array, lastIdx: number): number {
        const start = Math.max(period - 1, lastIdx === -1 ? 0 : lastIdx);
        for (let i = start; i < dataStore.length; i++) {
            let sum = 0;
            for (let j = 0; j < period; j++) {
                sum += dataStore.data[(i - j) * 6 + 4]; // Close price
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
            output[0] = dataStore.data[4]; // Initialize first point with first Close
        }
        
        for (let i = start; i < dataStore.length; i++) {
            const close = dataStore.data[i * 6 + 4];
            output[i] = (close - output[i - 1]) * k + output[i - 1];
        }
        return dataStore.length - 1;
    }
}