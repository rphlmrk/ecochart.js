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
     * Adds dashed or dotted line segments to an existing Pixi Graphics path without calling stroke().
     * This allows batching tens or hundreds of lines into a single GPU stroke draw call.
     */
    public static addDashedLinePath(
        g: Graphics,
        x1: number,
        y1: number,
        x2: number,
        y2: number,
        style: LineStyle = 'solid',
        dashLength?: number,
        gapLength?: number
    ): void {
        if (style === 'solid') {
            g.moveTo(x1, y1).lineTo(x2, y2);
            return;
        }

        const dx = x2 - x1;
        const dy = y2 - y1;
        const length = Math.hypot(dx, dy);
        if (length <= 0) return;

        const ux = dx / length;
        const uy = dy / length;

        const dashLen = dashLength ?? (style === 'dotted' ? 2 : 6);
        const gapLen = gapLength ?? (style === 'dotted' ? 3 : 4);

        const cycle = dashLen + gapLen;
        let current = 0;

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
    }

    /**
     * Draws multiple vertical lines with the specified style in a SINGLE batched WebGL stroke.
     * Eliminates dozens of redundant draw calls for grid and period separator lines.
     */
    public static drawVerticalLines(
        g: Graphics,
        xList: number[],
        y1: number,
        y2: number,
        options: StrokeOptions = {}
    ): void {
        if (xList.length === 0) return;

        const width = options.width ?? 1;
        const color = options.color ?? 0xffffff;
        const alpha = options.alpha ?? 1;
        const style = options.style ?? 'solid';
        const dashLen = options.dashLength ?? (style === 'dotted' ? 2 : 6);
        const gapLen = options.gapLength ?? (style === 'dotted' ? 3 : 4);

        const minY = Math.min(y1, y2);
        const maxY = Math.max(y1, y2);

        if (style === 'solid') {
            for (let i = 0; i < xList.length; i++) {
                const x = xList[i];
                g.moveTo(x, minY).lineTo(x, maxY);
            }
        } else {
            const cycle = dashLen + gapLen;
            for (let i = 0; i < xList.length; i++) {
                const x = xList[i];
                let curY = minY;
                while (curY < maxY) {
                    const segEnd = Math.min(curY + dashLen, maxY);
                    g.moveTo(x, curY).lineTo(x, segEnd);
                    curY += cycle;
                }
            }
        }

        g.stroke({
            color,
            width,
            alpha,
            cap: 'butt'
        });
    }

    /**
     * Draws multiple horizontal lines with the specified style in a SINGLE batched WebGL stroke.
     */
    public static drawHorizontalLines(
        g: Graphics,
        yList: number[],
        x1: number,
        x2: number,
        options: StrokeOptions = {}
    ): void {
        if (yList.length === 0) return;

        const width = options.width ?? 1;
        const color = options.color ?? 0xffffff;
        const alpha = options.alpha ?? 1;
        const style = options.style ?? 'solid';
        const dashLen = options.dashLength ?? (style === 'dotted' ? 2 : 6);
        const gapLen = options.gapLength ?? (style === 'dotted' ? 3 : 4);

        const minX = Math.min(x1, x2);
        const maxX = Math.max(x1, x2);

        if (style === 'solid') {
            for (let i = 0; i < yList.length; i++) {
                const y = yList[i];
                g.moveTo(minX, y).lineTo(maxX, y);
            }
        } else {
            const cycle = dashLen + gapLen;
            for (let i = 0; i < yList.length; i++) {
                const y = yList[i];
                let curX = minX;
                while (curX < maxX) {
                    const segEnd = Math.min(curX + dashLen, maxX);
                    g.moveTo(curX, y).lineTo(segEnd, y);
                    curX += cycle;
                }
            }
        }

        g.stroke({
            color,
            width,
            alpha,
            cap: 'butt'
        });
    }

    /**
     * Draws a line with the specified style (solid, dashed, dotted) on a PixiJS Graphics object.
     * Uses crisp butt caps and batched paths for high performance.
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

        const dashLen = options.dashLength ?? (style === 'dotted' ? 2 : 6);
        const gapLen = options.gapLength ?? (style === 'dotted' ? 3 : 4);

        StrokeEngine.addDashedLinePath(g, x1, y1, x2, y2, style, dashLen, gapLen);

        g.stroke({
            color,
            width,
            alpha,
            cap: 'butt'
        });
    }
}