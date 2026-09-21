import { BaseDrawing } from './DrawingTool';
import type { ChartRenderer } from '../renderer/ChartRenderer';
import { StrokeEngine } from '../renderer/StrokeEngine';
import { Graphics } from 'pixi.js';

export class HorizontalRay extends BaseDrawing {
    public onPointerDown(time: number, price: number): boolean {
        this.points[0] = { time, price };
        this.state = 'selected';
        return true; 
    }

    public onPointerMove(): void {}

    public hitTest(r: ChartRenderer, screenX: number, screenY: number): boolean {
        if (this.points.length < 1) return false;
        const x = r.timeToX(this.points[0].time);
        const y = r.priceToY(this.points[0].price);
        
        // Ray goes from x to infinity right. Hitbox is y ± 10px, starting from x - 10px
        return screenX >= (x - 10) && Math.abs(screenY - y) < 10;
    }

    public render(r: ChartRenderer, g: Graphics): void {
        if (this.points.length < 1) return;
        const x = r.timeToX(this.points[0].time);
        const y = r.priceToY(this.points[0].price);
        const screenW = r.app.screen.width;
        
        StrokeEngine.drawLine(g, x, y, screenW, y, { color: this.color, width: this.width, alpha: this.alpha, style: this.style });

        if (this.state !== 'idle') {
            g.circle(x, y, 4).fill(0xffffff).stroke({ color: this.color, width: 2 });
        }
    }
}