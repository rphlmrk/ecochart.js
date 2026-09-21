import { Graphics } from 'pixi.js';
import type { ChartRenderer } from '../renderer/ChartRenderer';

export type DrawingState = 'idle' | 'drawing_start' | 'drawing_end' | 'selected';

export interface Point {
    time: number;
    price: number;
}

export abstract class BaseDrawing {
    public id = Math.random().toString(36).substr(2, 9);
    public state: DrawingState = 'drawing_start';
    public points: Point[] = [];
    public color = 0x2962FF;
    public width = 2;

    public abstract onPointerDown(time: number, price: number): boolean;
    public abstract onPointerMove(time: number, price: number): void;
    public abstract render(r: ChartRenderer, g: Graphics): void;
}