import { Graphics } from 'pixi.js';
import type { LineStyle } from '../theme/types';

export interface StrokeOptions {
    width?: number;
    color?: number;
    alpha?: number;
    style?: LineStyle;
    dashLength?: number;
    gapLength?: number;
}

export class StrokeEngine {
    /**
     * Draws a line with the specified style (solid, dashed, dotted) on a PixiJS Graphics object.
     * Batches all calculated segments into a single WebGL draw call.
     */
    public static drawLine(
        g: Graphics,
        x1: number,
        y1: number,
        x2: number,
        y2: number,
        options: StrokeOptions = {}
    ): void {
        const width = options.width ?? 1;
        const color = options.color ?? 0xffffff;
        const alpha = options.alpha ?? 1;
        const style = options.style ?? 'solid';

        if (style === 'solid') {
            g.moveTo(x1, y1).lineTo(x2, y2).stroke({ color, width, alpha });
            return;
        }

        const dx = x2 - x1;
        const dy = y2 - y1;
        const length = Math.hypot(dx, dy);
        if (length <= 0) return;

        const ux = dx / length;
        const uy = dy / length;

        let dashLen = options.dashLength ?? 6;
        let gapLen = options.gapLength ?? 4;

        if (style === 'dotted') {
            dashLen = Math.max(1, width);
            gapLen = Math.max(2, width * 2);
        }

        const cycle = dashLen + gapLen;
        let current = 0;

        // Batch all segments in one continuous path before stroking
        while (current < length) {
            const segStart = current;
            const segEnd = Math.min(current + dashLen, length);

            const sx = x1 + ux * segStart;
            const sy = y1 + uy * segStart;
            const ex = x1 + ux * segEnd;
            const ey = y1 + uy * segEnd;

            g.moveTo(sx, sy).lineTo(ex, ey);
            current += cycle;
        }

        g.stroke({
            color,
            width,
            alpha,
            cap: style === 'dotted' ? 'round' : 'butt'
        });
    }
}