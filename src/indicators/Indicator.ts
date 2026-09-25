import { Graphics } from 'pixi.js';
import type { ChartRenderer } from '../renderer/ChartRenderer';
import type { DataStore } from '../data/DataStore';
import { ThemeManager } from '../theme/ThemeManager';

export function parseColor(val: string | number): number {
    if (typeof val === 'number') return val;
    if (typeof val === 'string') return ThemeManager.hexToInt(val);
    return 0xffffff;
}

export type ParamType = 'number' | 'color' | 'boolean' | 'select';

export interface OscillatorScale {
    min: number;              // Lower bound (e.g. -150)
    max: number;              // Upper bound (e.g. +150)
    steps: number[];          // Target ticks to draw (e.g. [80, 0, -80])
    format?: (val: number) => string;
}

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
    public visible = true;                     // <-- NEW: Toggle visibility without clearing calculations
    public oscillatorScale?: OscillatorScale;  // <-- NEW: Custom scale definition for sub-panels
    public values: Float64Array;
    public params: ParamDef[] = [];
    protected lastCalculatedIdx = -1;

    // Core State Machine variables
    public isCalculating = false;
    protected state: any = {};
    protected confirmedState: any = {};

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
    protected onParamsUpdated(): void { }

    /**
     * Retrieves the formatted title and numerical value at a specific candle index.
     */
    public getValueAt(idx: number, ds: DataStore, _isDark: boolean, defaultTextClr: number): { label: string; valueStr: string; valueColor: number } {
        const val = (idx >= 0 && idx < ds.length) ? this.values[idx] : 0;
        return {
            label: this.name,
            valueStr: val.toFixed(2),
            valueColor: defaultTextClr
        };
    }

    public reset() {
        this.lastCalculatedIdx = -1;
        this.values.fill(0);
        this.state = {};
        this.confirmedState = {};
        this.setup();
    }

    protected cloneState(state: any): any {
        if (!state) return {};
        if (typeof structuredClone === 'function') {
            return structuredClone(state);
        }
        return JSON.parse(JSON.stringify(state));
    }

    public update(ds: DataStore, isClosedTick: boolean) {
        if (ds.length === 0) {
            this.lastCalculatedIdx = -1;
            return;
        }

        if (ds.length > this.values.length) {
            const newArr = new Float64Array(this.values.length * 2);
            newArr.set(this.values);
            this.values = newArr;
        }

        if (this.calculate !== BaseIndicator.prototype.calculate) {
            this.calculate(ds);
            return;
        }

        // 1. Initial historical load
        if (this.lastCalculatedIdx === -1) {
            this.setup();
            for (let i = 0; i < ds.length; i++) {
                this.next(i, true, ds);
            }
            this.lastCalculatedIdx = ds.length - 1;
            this.confirmedState = this.cloneState(this.state);
            return;
        }

        // 2. Live Tick Updates: restore isolated confirmed state
        const liveIdx = ds.length - 1;
        this.state = this.cloneState(this.confirmedState);

        this.next(liveIdx, isClosedTick, ds);

        // 3. Lock in state only if candle officially closed
        if (isClosedTick) {
            this.confirmedState = this.cloneState(this.state);
            this.lastCalculatedIdx = liveIdx;
        }
    }

    // New Architecture Methods
    protected setup(): void { }
    protected next(_index: number, _isClosed: boolean, _ds: DataStore): void { }

    // Legacy fallback
    protected calculate(_ds: DataStore): void { }
    public abstract render(renderer: ChartRenderer, layout: IndicatorLayout, graphics: Graphics): void;
}
