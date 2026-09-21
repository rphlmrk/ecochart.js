import { BaseDrawing } from './DrawingTool';
import type { ChartRenderer } from '../renderer/ChartRenderer';
import { Graphics, Text } from 'pixi.js';

export class TextDrawing extends BaseDrawing {
    public textContent = 'Text';
    public fontSize = 16;
    public isBold = false;
    public isItalic = false;
    public hasBackground = false;
    public bgColor = 0x1e222d;
    public bgAlpha = 0.85;
    public hasBorder = false;
    public borderColor = 0x2962ff;
    public textWrap = false;
    public isAnchored = false;
    public isLocked = false;

    public anchorX = 0; // Screen X when anchored
    public anchorY = 0; // Screen Y when anchored

    private pixiText: Text | null = null;
    private lastBounds = { x: 0, y: 0, w: 50, h: 20 };

    public onPointerDown(time: number, price: number): boolean {
        this.points[0] = { time, price };
        this.state = 'selected';
        return true; // 1-click placement
    }

    public onPointerMove(): void {}

    public hitTest(r: ChartRenderer, screenX: number, screenY: number): boolean {
        if (this.points.length < 1) return false;
        const x = this.isAnchored ? this.anchorX : r.timeToX(this.points[0].time);
        const y = this.isAnchored ? this.anchorY : r.priceToY(this.points[0].price);
        const w = this.lastBounds.w;
        const h = this.lastBounds.h;
        return screenX >= x - 8 && screenX <= x + w + 8 && screenY >= y - 8 && screenY <= y + h + 8;
    }

    public render(r: ChartRenderer, g: Graphics): void {
        if (this.points.length < 1) return;

        const x = this.isAnchored ? this.anchorX : r.timeToX(this.points[0].time);
        const y = this.isAnchored ? this.anchorY : r.priceToY(this.points[0].price);

        if (!this.pixiText) {
            this.pixiText = new Text({ text: '', style: { fontFamily: 'sans-serif' } });
        }

        this.pixiText.text = this.textContent || ' ';
        this.pixiText.style.fontSize = this.fontSize;
        this.pixiText.style.fontWeight = this.isBold ? 'bold' : 'normal';
        this.pixiText.style.fontStyle = this.isItalic ? 'italic' : 'normal';
        this.pixiText.style.fill = this.color;
        this.pixiText.style.wordWrap = this.textWrap;
        this.pixiText.style.wordWrapWidth = 220;

        const w = Math.max(24, this.pixiText.width);
        const h = Math.max(16, this.pixiText.height);
        this.lastBounds = { x, y, w, h };

        // Background
        if (this.hasBackground) {
            g.roundRect(x - 6, y - 4, w + 12, h + 8, 4)
             .fill({ color: this.bgColor, alpha: this.bgAlpha });
        }

        // Border
        if (this.hasBorder) {
            g.roundRect(x - 6, y - 4, w + 12, h + 8, 4)
             .stroke({ color: this.borderColor, width: 1.5, alpha: 0.9 });
        }

        // Selection handles
        if (this.state !== 'idle') {
            g.roundRect(x - 8, y - 6, w + 16, h + 12, 4)
             .stroke({ color: 0x2962FF, width: 1.5, alpha: 0.8 });
            g.circle(x - 8, y - 6, 3).fill(0xffffff).stroke({ color: 0x2962FF, width: 1.5 });
            g.circle(x + w + 8, y + h + 6, 3).fill(0xffffff).stroke({ color: 0x2962FF, width: 1.5 });
        }

        this.pixiText.x = x;
        this.pixiText.y = y;
        g.addChild(this.pixiText);
    }
}