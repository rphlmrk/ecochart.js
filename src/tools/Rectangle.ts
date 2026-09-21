import { BaseDrawing } from './DrawingTool';
import type { ChartRenderer } from '../renderer/ChartRenderer';
import { Graphics } from 'pixi.js';

export class Rectangle extends BaseDrawing {
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
        const y1 = r.priceToY(this.points[0].price);
        const x2 = r.timeToX(this.points[1].time);
        const y2 = r.priceToY(this.points[1].price);

        const left = Math.min(x1, x2);
        const top = Math.min(y1, y2);
        const width = Math.abs(x2 - x1);
        const height = Math.abs(y2 - y1);

        g.rect(left, top, width, height)
         .fill({ color: this.color, alpha: 0.15 })
         .stroke({ color: this.color, width: this.width, alpha: 0.8 });

        if (this.state !== 'idle') {
            g.circle(x1, y1, 4).fill(0xffffff).stroke({ color: this.color, width: 2 });
            g.circle(x2, y2, 4).fill(0xffffff).stroke({ color: this.color, width: 2 });
        }
    }
}