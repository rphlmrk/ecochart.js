import { BaseDrawing } from './DrawingTool';
import type { ChartRenderer } from '../renderer/ChartRenderer';
import { StrokeEngine } from '../renderer/StrokeEngine';
import { Graphics, Text } from 'pixi.js';

export class PriceRange extends BaseDrawing {
    private labelText: Text | null = null;
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

        const xMid = x1 + (x2 - x1) / 2;
        const color = this.points[1].price >= this.points[0].price ? r.bullColor : r.bearColor;

        // Draw vertical spine and horizontal caps
        StrokeEngine.drawLine(g, xMid, y1, xMid, y2, { color, width: this.width, alpha: 0.8 });
        StrokeEngine.drawLine(g, xMid - 10, y1, xMid + 10, y1, { color, width: this.width, alpha: 0.8 });
        StrokeEngine.drawLine(g, xMid - 10, y2, xMid + 10, y2, { color, width: this.width, alpha: 0.8 });

        // Shade the background area
        g.rect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1)).fill({ color, alpha: 0.1 });

        // Render PIXI Text for numbers
        if (!this.labelText) {
            this.labelText = new Text({ text: '', style: { fontFamily: 'sans-serif', fontSize: 11, fontWeight: 'bold', fill: 0xffffff, align: 'left' }});
            this.labelText.anchor.set(0, 0.5);
        }
        g.addChild(this.labelText);
        
        const priceDiff = this.points[1].price - this.points[0].price;
        const pctDiff = (priceDiff / this.points[0].price) * 100;
        const sign = priceDiff > 0 ? '+' : '';
        
        this.labelText.text = `${sign}${priceDiff.toFixed(2)}\n(${sign}${pctDiff.toFixed(2)}%)`;
        this.labelText.style.fill = color;
        this.labelText.x = xMid + 14;
        this.labelText.y = y1 + (y2 - y1) / 2;

        if (this.state !== 'idle') {
            g.circle(x1, y1, 4).fill(0xffffff).stroke({ color, width: 2 });
            g.circle(x2, y2, 4).fill(0xffffff).stroke({ color, width: 2 });
        }
    }
}