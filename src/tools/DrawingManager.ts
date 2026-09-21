import type { ChartRenderer } from '../renderer/ChartRenderer';
import { BaseDrawing } from './DrawingTool';
import { Trendline } from './Trendline';
import { Graphics } from 'pixi.js';

export class DrawingManager {
    public drawings: BaseDrawing[] = [];
    public activeToolType: 'trendline' | 'rect' | 'fib' | null = null;
    public currentDrawing: BaseDrawing | null = null;
    public isMagnetEnabled = true;

    public startTool(type: 'trendline' | 'rect' | 'fib') {
        this.activeToolType = type;
        if (type === 'trendline') {
            this.currentDrawing = new Trendline();
        }
    }

    public onPointerDown(r: ChartRenderer, screenX: number, screenY: number) {
        if (!this.currentDrawing) return;
        const { time, price } = this.isMagnetEnabled 
            ? r.getMagnetPoint(screenX, screenY) 
            : { time: r.xToTime(screenX), price: r.yToPrice(screenY) };

        if (this.currentDrawing.onPointerDown(time, price)) {
            this.drawings.push(this.currentDrawing);
            this.currentDrawing = null;
            this.activeToolType = null;
        }
    }

    public onPointerMove(r: ChartRenderer, screenX: number, screenY: number) {
        if (!this.currentDrawing) return;
        const { time, price } = this.isMagnetEnabled 
            ? r.getMagnetPoint(screenX, screenY) 
            : { time: r.xToTime(screenX), price: r.yToPrice(screenY) };
        this.currentDrawing.onPointerMove(time, price);
    }

    public render(r: ChartRenderer, g: Graphics) {
        g.clear();
        for (const d of this.drawings) d.render(r, g);
        if (this.currentDrawing) this.currentDrawing.render(r, g);
    }
}