import type { ChartRenderer } from '../renderer/ChartRenderer';
import { db } from '../data/db'; 
import { BaseDrawing } from './DrawingTool';
import { Trendline } from './Trendline';
import { Rectangle } from './Rectangle';
import { FibRetracement } from './FibRetracement';
import { PriceRange } from './PriceRange';
import { VerticalLine } from './VerticalLine';
import { HorizontalRay } from './HorizontalRay';
import { TextDrawing } from './TextDrawing';
import { Graphics } from 'pixi.js';

export type ToolType = 'trendline' | 'rect' | 'fib' | 'prange' | 'vline' | 'hray' | 'text';

export class DrawingManager {
    public drawings: BaseDrawing[] = [];
    public activeToolType: ToolType | null = null;
    public currentDrawing: BaseDrawing | null = null;
    public isMagnetEnabled = true;
    public isVisible = true;
    public selectedDrawing: BaseDrawing | null = null;
    public draggingHandle: 0 | 1 | null = null; // Tracks which handle is moving
    public currentSymbol = '';

    // Phase 3: Hit Testing logic to see if a user clicked on a drawing
    public trySelect(r: ChartRenderer, screenX: number, screenY: number): { drawing: BaseDrawing, part: string } | null {
        if (!this.isVisible) return null;
        for (let i = this.drawings.length - 1; i >= 0; i--) {
            const d = this.drawings[i];
            const hit = d.hitTest(r, screenX, screenY);
            if (hit !== 'none') return { drawing: d, part: hit };
        }
        return null;
    }

    // --- DB SYNC METHODS ---
    public async loadDrawings(symbol: string) {
        this.currentSymbol = symbol;
        const records = await db.drawings.where('symbol').equals(symbol).toArray();
        this.drawings = records.map(record => {
            let d: BaseDrawing;
            switch(record.toolType) {
                case 'trendline': d = new Trendline(); break;
                case 'rect': d = new Rectangle(); break;
                case 'fib': d = new FibRetracement(); break;
                case 'prange': d = new PriceRange(); break;
                case 'vline': d = new VerticalLine(); break;
                case 'hray': d = new HorizontalRay(); break;
                case 'text': d = new TextDrawing(); break;
                default: d = new Trendline();
            }
            d.deserialize(record);
            return d;
        });
    }

    public async saveDrawing(d: BaseDrawing) {
        if (!this.currentSymbol || (d.state !== 'idle' && d.state !== 'selected')) return;
        const record = d.serialize();
        record.symbol = this.currentSymbol;
        await db.drawings.put(record);
    }

    public async deleteDrawing(id: string) {
        await db.drawings.delete(id);
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
            case 'text': this.currentDrawing = new TextDrawing(); break;
        }
    }

    public onPointerDown(r: ChartRenderer, screenX: number, screenY: number, shiftKey = false): boolean {
        if (!this.currentDrawing) return false;
        
        // Use a slightly larger snap threshold for better drawing UX
        let { time, price } = this.isMagnetEnabled 
            ? r.getMagnetPoint(screenX, screenY, 30) 
            : { time: r.xToTime(screenX), price: r.yToPrice(screenY) };

        // Apply Shift Constraint (0, 45, 90 degrees) for final click
        if (shiftKey && this.currentDrawing.toolType === 'trendline' && this.currentDrawing.points.length > 0) {
            const startX = r.timeToX(this.currentDrawing.points[0].time);
            const startY = r.priceToY(this.currentDrawing.points[0].price);
            let curX = r.timeToX(time);
            let curY = r.priceToY(price);

            const dx = curX - startX;
            const dy = curY - startY;
            const angle = Math.abs(Math.atan2(dy, dx) * 180 / Math.PI);

            if (angle < 22.5 || angle > 157.5) {
                curY = startY; // Snap Horizontal
            } else if (angle > 67.5 && angle < 112.5) {
                curX = startX; // Snap Vertical
            } else {
                const dist = Math.max(Math.abs(dx), Math.abs(dy)); // Snap 45 degrees
                curX = startX + Math.sign(dx) * dist;
                curY = startY + Math.sign(dy) * dist;
            }

            time = r.xToTime(curX);
            price = r.yToPrice(curY);
        }

        if (this.currentDrawing.onPointerDown(time, price)) {
            this.currentDrawing.state = 'idle'; // Hide handles immediately
            this.drawings.push(this.currentDrawing);
            this.currentDrawing = null;
            this.activeToolType = null;
            return true; // Signal that drawing is complete
        }
        return false; // Still drawing
    }

    public onPointerMove(r: ChartRenderer, screenX: number, screenY: number, shiftKey = false) {
        if (!this.currentDrawing) return;
        
        let { time, price } = this.isMagnetEnabled 
            ? r.getMagnetPoint(screenX, screenY) 
            : { time: r.xToTime(screenX), price: r.yToPrice(screenY) };

        // Apply Shift Constraint (0, 45, 90 degrees) for Trendlines
        if (shiftKey && this.currentDrawing.toolType === 'trendline' && this.currentDrawing.points.length > 0) {
            const startX = r.timeToX(this.currentDrawing.points[0].time);
            const startY = r.priceToY(this.currentDrawing.points[0].price);
            let curX = r.timeToX(time);
            let curY = r.priceToY(price);

            const dx = curX - startX;
            const dy = curY - startY;
            const angle = Math.abs(Math.atan2(dy, dx) * 180 / Math.PI);

            if (angle < 22.5 || angle > 157.5) {
                curY = startY; // Snap Horizontal
            } else if (angle > 67.5 && angle < 112.5) {
                curX = startX; // Snap Vertical
            } else {
                const dist = Math.max(Math.abs(dx), Math.abs(dy)); // Snap 45 degrees
                curX = startX + Math.sign(dx) * dist;
                curY = startY + Math.sign(dy) * dist;
            }

            time = r.xToTime(curX);
            price = r.yToPrice(curY);
        }

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