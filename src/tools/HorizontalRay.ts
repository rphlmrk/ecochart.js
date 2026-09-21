import { BaseDrawing } from './DrawingTool';
import type { ChartRenderer } from '../renderer/ChartRenderer';
import { StrokeEngine } from '../renderer/StrokeEngine';
import { Graphics } from 'pixi.js';

export class HorizontalRay extends BaseDrawing {
    public onPointerDown(time: number, price: number): boolean {
        this.points[0] = { time, price };
        this.state = 'selected';
        return true; // 1-click drawing
    }

    public onPointerMove(): void {}

    public render(r: ChartRenderer, g: Graphics): void {
        if (this.points.length < 1) return;
        const x = r.timeToX(this.points[0].time);
        const y = r.priceToY(this.points[0].price);
        const screenW = r.app.screen.width;
        
        StrokeEngine.drawLine(g, x, y, screenW, y, { color: this.color, width: this.width, alpha: 0.8 });

        if (this.state !== 'idle') {
            g.circle(x, y, 4).fill(0xffffff).stroke({ color: this.color, width: 2 });
        }
    }
}