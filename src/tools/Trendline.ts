import { BaseDrawing } from './DrawingTool';
import type { ChartRenderer } from '../renderer/ChartRenderer';
import { StrokeEngine } from '../renderer/StrokeEngine';
import { Graphics } from 'pixi.js';

export class Trendline extends BaseDrawing {
    public onPointerDown(time: number, price: number): boolean {
        if (this.state === 'drawing_start') {
            this.points[0] = { time, price };
            this.points[1] = { time, price };
            this.state = 'drawing_end';
            return false; // Still drawing
        } else if (this.state === 'drawing_end') {
            this.points[1] = { time, price };
            this.state = 'selected';
            return true; // Finished drawing
        }
        return true;
    }

    public onPointerMove(time: number, price: number): void {
        if (this.state === 'drawing_end' && this.points.length === 2) {
            this.points[1] = { time, price };
        }
    }

    public render(r: ChartRenderer, g: Graphics): void {
        if (this.points.length < 2) return;

        const x1 = r.timeToX(this.points[0].time);
        const y1 = r.priceToY(this.points[0].price);
        const x2 = r.timeToX(this.points[1].time);
        const y2 = r.priceToY(this.points[1].price);

        // Frustum Culling
        const screenW = r.app.screen.width - r.priceAxisWidth;
        if ((x1 < 0 && x2 < 0) || (x1 > screenW && x2 > screenW)) return;

        StrokeEngine.drawLine(g, x1, y1, x2, y2, { color: this.color, width: this.width, alpha: 1.0, style: 'solid' });

        if (this.state !== 'idle') {
            g.circle(x1, y1, 4).fill(0xffffff).stroke({ color: this.color, width: 2 });
            g.circle(x2, y2, 4).fill(0xffffff).stroke({ color: this.color, width: 2 });
        }
    }
}