import { BaseDrawing } from './DrawingTool';
import type { ChartRenderer } from '../renderer/ChartRenderer';
import { StrokeEngine } from '../renderer/StrokeEngine';
import { Graphics } from 'pixi.js';

export class FibRetracement extends BaseDrawing {
    private readonly levels = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
    
    public onPointerDown(time: number, price: number): boolean {
        if (this.state === 'drawing_start') {
            this.points[0] = { time, price };
            this.points[1] = { time, price };
            this.state = 'drawing_end';
            return false;
        } else if (this.state === 'drawing_end') {
            this.points[1] = { time, price };
            this.state = 'selected';
            return true;
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
        const p1 = this.points[0].price;
        const x2 = r.timeToX(this.points[1].time);
        const p2 = this.points[1].price;
        
        const startX = Math.min(x1, x2);
        const endX = Math.max(x1, x2) + 100; // Extend rays slightly to the right
        const diff = p1 - p2;

        StrokeEngine.drawLine(g, x1, r.priceToY(p1), x2, r.priceToY(p2), { color: this.color, width: 1, style: 'dashed', alpha: 0.5 });

        this.levels.forEach(level => {
            const lvlPrice = p1 - (diff * level);
            const y = r.priceToY(lvlPrice);
            StrokeEngine.drawLine(g, startX, y, endX, y, { color: this.color, width: this.width, alpha: 0.8 });
        });

        if (this.state !== 'idle') {
            g.circle(x1, r.priceToY(p1), 4).fill(0xffffff).stroke({ color: this.color, width: 2 });
            g.circle(x2, r.priceToY(p2), 4).fill(0xffffff).stroke({ color: this.color, width: 2 });
        }
    }
}