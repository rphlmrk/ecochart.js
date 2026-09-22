import { BaseDrawing } from './DrawingTool';
import type { ChartRenderer } from '../renderer/ChartRenderer';
import { StrokeEngine } from '../renderer/StrokeEngine';
import { Graphics } from 'pixi.js';

export class VerticalLine extends BaseDrawing {
    public toolType = 'vline';
    public onPointerDown(time: number, price: number): boolean {
        this.points[0] = { time, price };
        this.state = 'selected';
        return true; 
    }

    public onPointerMove(): void {}

    // Fixed: Prefixed screenY with an underscore to satisfy TypeScript
    public hitTest(r: ChartRenderer, screenX: number, _screenY: number): 'none' | 'handle_0' | 'handle_1' | 'body' {
        const handleHit = this.checkHandleHit(r, screenX, _screenY);
        if (handleHit !== 'none') return handleHit;
        if (this.points.length < 1) return 'none';
        
        const x = r.timeToX(this.points[0].time);
        return Math.abs(screenX - x) < 10 ? 'body' : 'none';
    }

    public render(r: ChartRenderer, g: Graphics): void {
        if (this.points.length < 1) return;
        const x = r.timeToX(this.points[0].time);
        const chartH = r.app.screen.height - r.timeAxisHeight;
        
        StrokeEngine.drawLine(g, x, 0, x, chartH, { color: this.color, width: this.width, alpha: this.alpha, style: this.style });

        if (this.state !== 'idle') {
            g.circle(x, r.priceToY(this.points[0].price), 4).fill(0xffffff).stroke({ color: this.color, width: 2 });
        }
    }
}