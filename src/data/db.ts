import Dexie, { type Table } from 'dexie';

export interface CandleRecord {
    id: string; // symbol_interval_time
    symbol: string;
    interval: string;
    time: number;
    o: number; h: number; l: number; c: number; v: number;
}

export interface DrawingRecord {
    id: string;
    symbol: string;
    toolType: string;
    points: {time: number, price: number}[];
    color: number;
    width: number;
    alpha: number;
    style: string;
    [key: string]: any; // For extra text/fib properties
}

export class EcoChartDB extends Dexie {
    candles!: Table<CandleRecord, string>;
    drawings!: Table<DrawingRecord, string>;

    constructor() {
        super('EcoChartDB');
        this.version(1).stores({
            candles: 'id, symbol, [symbol+interval], time',
            drawings: 'id, symbol' // Index drawings by symbol so we can load them fast
        });
    }
}

export const db = new EcoChartDB();