import type { ChartRenderer } from '../renderer/ChartRenderer';
import { BaseDrawing } from './DrawingTool';
import { Trendline } from './Trendline';
import { Rectangle } from './Rectangle';
import { FibRetracement } from './FibRetracement';
import { PriceRange } from './PriceRange';
import { VerticalLine } from './VerticalLine';
import { HorizontalRay } from './HorizontalRay';
import { Graphics } from 'pixi.js';

export type ToolType = 'trendline' | 'rect' | 'fib' | 'prange' | 'vline' | 'hray';

export class DrawingManager {
    public drawings: BaseDrawing[] = [];
    public activeToolType: ToolType | null = null;
    public currentDrawing: BaseDrawing | null = null;
    public isMagnetEnabled = true;
    public isVisible = true;
    public selectedDrawing: BaseDrawing | null = null;

    // Phase 3: Hit Testing logic to see if a user clicked on a drawing
    public trySelect(r: ChartRenderer, screenX: number, screenY: number): BaseDrawing | null {
        if (!this.isVisible) return null;
        
        for (let i = this.drawings.length - 1; i >= 0; i--) {
            const d = this.drawings[i];
            if (d.points.length === 0) continue;

            const x1 = r.timeToX(d.points[0].time);
            const y1 = r.priceToY(d.points[0].price);
            let x2 = x1, y2 = y1;
            
            if (d.points.length > 1) {
                x2 = r.timeToX(d.points[1].time);
                y2 = r.priceToY(d.points[1].price);
            }

            const margin = 12; // Hitbox padding (pixels)
            let hit = false;
            
            // Generic Bounding Box (Handles Rects, Price Ranges, Fibs)
            const left = Math.min(x1, x2) - margin;
            const right = Math.max(x1, x2) + margin;
            const top = Math.min(y1, y2) - margin;
            const bottom = Math.max(y1, y2) + margin;

            // If it has 2 points and significant height, use Bounding Box
            if (d.points.length > 1 && Math.abs(y1 - y2) > margin) {
                hit = screenX >= left && screenX <= right && screenY >= top && screenY <= bottom;
            } 
            // Otherwise treat as a line (Trendline, H-Ray, V-Line approximation)
            else {
                 const l2 = (x2 - x1) ** 2 + (y2 - y1) ** 2;
                 if (l2 === 0) {
                     hit = Math.hypot(screenX - x1, screenY - y1) < margin;
                 } else {
                     let t = ((screenX - x1) * (x2 - x1) + (screenY - y1) * (y2 - y1)) / l2;
                     t = Math.max(0, Math.min(1, t));
                     const projX = x1 + t * (x2 - x1);
                     const projY = y1 + t * (y2 - y1);
                     hit = Math.hypot(screenX - projX, screenY - projY) < margin;
                 }
            }

            if (hit) return d;
        }
        return null;
    }

    public startTool(type: ToolType) {
        this.activeToolType = type;
        switch(type) {
            case 'trendline': this.currentDrawing = new Trendline(); break;
            case 'rect': this.currentDrawing = new Rectangle(); break;
            case 'fib': this.currentDrawing = new FibRetracement(); break;
            case 'prange': this.currentDrawing = new PriceRange(); break;
            case 'vline': this.currentDrawing = new VerticalLine(); break;
            case 'hray': this.currentDrawing = new HorizontalRay(); break;
        }
    }

    public onPointerDown(r: ChartRenderer, screenX: number, screenY: number): boolean {
        if (!this.currentDrawing) return false;
        
        // Use a slightly larger snap threshold for better drawing UX
        const { time, price } = this.isMagnetEnabled 
            ? r.getMagnetPoint(screenX, screenY, 30) 
            : { time: r.xToTime(screenX), price: r.yToPrice(screenY) };

        if (this.currentDrawing.onPointerDown(time, price)) {
            this.currentDrawing.state = 'idle'; // Hide handles immediately
            this.drawings.push(this.currentDrawing);
            this.currentDrawing = null;
            this.activeToolType = null;
            return true; // Signal that drawing is complete
        }
        return false; // Still drawing
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
        g.removeChildren(); // Clean up texts from previous frame
        if (!this.isVisible) return;
        for (const d of this.drawings) d.render(r, g);
        if (this.currentDrawing) this.currentDrawing.render(r, g);
    }
}