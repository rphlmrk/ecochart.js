import { Graphics } from 'pixi.js';
import type { ChartRenderer } from '../renderer/ChartRenderer';
import type { LineStyle } from '../theme/types';

export type DrawingState = 'idle' | 'drawing_start' | 'drawing_end' | 'selected';

export interface Point {
    time: number;
    price: number;
}

export abstract class BaseDrawing {
    public id = Math.random().toString(36).substr(2, 9);
    public state: DrawingState = 'drawing_start';
    public points: Point[] = [];
    public color = 0x2962FF;
    public width = 2;
    public alpha = 1.0;
    public style: LineStyle = 'solid';

    public abstract toolType: string; // Identifies tool for the DB

    public abstract onPointerDown(time: number, price: number): boolean;
    public abstract onPointerMove(time: number, price: number): void;
    public abstract render(r: ChartRenderer, g: Graphics): void;
    
    // Upgraded: Returns EXACTLY what was clicked (handle or body)
    public abstract hitTest(r: ChartRenderer, screenX: number, screenY: number): 'none' | 'handle_0' | 'handle_1' | 'body';

    // Shared helper for all tools to check if a resize handle was grabbed
    protected checkHandleHit(r: ChartRenderer, screenX: number, screenY: number): 'none' | 'handle_0' | 'handle_1' {
        if (this.points.length > 0) {
            const x1 = this['isAnchored'] ? this['anchorX'] : r.timeToX(this.points[0].time);
            const y1 = this['isAnchored'] ? this['anchorY'] : r.priceToY(this.points[0].price);
            if (Math.hypot(screenX - x1, screenY - y1) < 15) return 'handle_0';
        }
        if (this.points.length > 1) {
            const x2 = r.timeToX(this.points[1].time);
            const y2 = r.priceToY(this.points[1].price);
            if (Math.hypot(screenX - x2, screenY - y2) < 15) return 'handle_1';
        }
        return 'none';
    }

    // Database Serialization
    public serialize(): any {
        return {
            id: this.id, toolType: this.toolType, points: [...this.points],
            color: this.color, width: this.width, alpha: this.alpha, style: this.style,
            ...this.getExtraState() // Hooks for Text/Fib extra fields
        };
    }

    public deserialize(data: any) {
        this.id = data.id; this.points = data.points || [];
        this.color = data.color; this.width = data.width; this.alpha = data.alpha; this.style = data.style;
        this.state = 'idle';
        this.restoreExtraState(data);
    }

    protected getExtraState(): any { return {}; }
    protected restoreExtraState(_data: any): void {}
}