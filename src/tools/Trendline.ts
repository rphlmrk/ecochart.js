import { BaseDrawing } from './DrawingTool';
import type { ChartRenderer } from '../renderer/ChartRenderer';
import { StrokeEngine } from '../renderer/StrokeEngine';
import { Graphics } from 'pixi.js';

export class Trendline extends BaseDrawing {
    public toolType = 'trendline';
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

    public hitTest(r: ChartRenderer, screenX: number, screenY: number): 'none' | 'handle_0' | 'handle_1' | 'body' {
        const handleHit = this.checkHandleHit(r, screenX, screenY);
        if (handleHit !== 'none') return handleHit;
        if (this.points.length < 2) return 'none';
        const x1 = r.timeToX(this.points[0].time);
        const y1 = r.priceToY(this.points[0].price);
        const x2 = r.timeToX(this.points[1].time);
        const y2 = r.priceToY(this.points[1].price);

        const l2 = (x2 - x1) ** 2 + (y2 - y1) ** 2;
        if (l2 === 0) return Math.hypot(screenX - x1, screenY - y1) < 10 ? 'body' : 'none';
        
        let t = ((screenX - x1) * (x2 - x1) + (screenY - y1) * (y2 - y1)) / l2;
        t = Math.max(0, Math.min(1, t));
        const projX = x1 + t * (x2 - x1);
        const projY = y1 + t * (y2 - y1);
        
        return Math.hypot(screenX - projX, screenY - projY) < 10 ? 'body' : 'none';
    }

    public render(r: ChartRenderer, g: Graphics): void {
        if (this.points.length < 2) return;
        const x1 = r.timeToX(this.points[0].time);
        const y1 = r.priceToY(this.points[0].price);
        const x2 = r.timeToX(this.points[1].time);
        const y2 = r.priceToY(this.points[1].price);

        const screenW = r.app.screen.width - r.priceAxisWidth;
        if ((x1 < 0 && x2 < 0) || (x1 > screenW && x2 > screenW)) return;

        StrokeEngine.drawLine(g, x1, y1, x2, y2, { color: this.color, width: this.width, alpha: this.alpha, style: this.style });

        if (this.state !== 'idle') {
            g.circle(x1, y1, 4).fill(0xffffff).stroke({ color: this.color, width: 2 });
            g.circle(x2, y2, 4).fill(0xffffff).stroke({ color: this.color, width: 2 });
        }
    }
}