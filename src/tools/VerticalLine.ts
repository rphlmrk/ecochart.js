import { BaseDrawing } from './DrawingTool';
import type { ChartRenderer } from '../renderer/ChartRenderer';
import { StrokeEngine } from '../renderer/StrokeEngine';
import { Graphics } from 'pixi.js';

export class VerticalLine extends BaseDrawing {
    public onPointerDown(time: number, price: number): boolean {
        this.points[0] = { time, price };
        this.state = 'selected';
        return true; // 1-click drawing
    }

    public onPointerMove(): void {}

    public render(r: ChartRenderer, g: Graphics): void {
        if (this.points.length < 1) return;
        const x = r.timeToX(this.points[0].time);
        const chartH = r.app.screen.height - r.timeAxisHeight;
        
        StrokeEngine.drawLine(g, x, 0, x, chartH, { color: this.color, width: this.width, alpha: 0.8 });

        if (this.state !== 'idle') {
            g.circle(x, r.priceToY(this.points[0].price), 4).fill(0xffffff).stroke({ color: this.color, width: 2 });
        }
    }
}