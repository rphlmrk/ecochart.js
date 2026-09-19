import { Application, Graphics } from 'pixi.js';
import { DataStore } from '../data/DataStore';

export class ChartRenderer {
    public app: Application;
    private dataStore: DataStore;
    private candlesGraphics!: Graphics;

    // Viewport Math
    public cameraX = 0;
    public cameraY = 0;       // NEW: Vertical Panning
    public zoom = 1.0;
    public candleSpacing = 8.0;

    // Auto-Scaling State
    public isAutoScale = true;
    public currentMinPrice = 0;
    public currentMaxPrice = 1;

    constructor(dataStore: DataStore) {
        this.dataStore = dataStore;
        this.app = new Application();
    }

    public async init(canvas: HTMLCanvasElement) {
        await this.app.init({
            canvas: canvas,
            resizeTo: canvas.parentElement!,
            backgroundColor: 0x131722,
            antialias: false,
            resolution: window.devicePixelRatio || 1,
        });

        this.candlesGraphics = new Graphics();
        this.app.stage.addChild(this.candlesGraphics);
    }

    public renderFrame() {
        if (!this.candlesGraphics || this.dataStore.length === 0) return;

        const g = this.candlesGraphics;
        g.clear();

        const width = this.app.screen.width;
        const height = this.app.screen.height;

        const actualSpacing = this.candleSpacing * this.zoom;
        const visStart = Math.max(0, Math.floor(this.cameraX / actualSpacing));
        const visEnd = Math.min(this.dataStore.length, Math.floor((this.cameraX + width) / actualSpacing) + 1);

        // 1. Calculate Bounds ONLY if Auto-Scale is active
        if (this.isAutoScale) {
            let minPrice = Infinity;
            let maxPrice = -Infinity;
            for (let i = visStart; i < visEnd; i++) {
                const h = this.dataStore.data[i * 6 + 2];
                const l = this.dataStore.data[i * 6 + 3];
                if (h > maxPrice) maxPrice = h;
                if (l < minPrice) minPrice = l;
            }

            const priceRange = maxPrice - minPrice || 1;
            const padding = priceRange * 0.1;

            this.currentMaxPrice = maxPrice + padding;
            this.currentMinPrice = minPrice - padding;
            this.cameraY = 0; // Force Y camera to 0 when auto-scaling
        }

        // 2. Price to Y Math (Now accounts for vertical panning!)
        const priceToY = (price: number) => {
            const range = this.currentMaxPrice - this.currentMinPrice;
            const normalized = (price - this.currentMinPrice) / range;
            return height - (normalized * height) + this.cameraY;
        };

        const candleWidth = Math.max(1, actualSpacing * 0.8);

        // 3. Batch Draw
        for (let i = visStart; i < visEnd; i++) {
            const base = i * 6;
            const o = this.dataStore.data[base + 1];
            const h = this.dataStore.data[base + 2];
            const l = this.dataStore.data[base + 3];
            const c = this.dataStore.data[base + 4];

            const x = (i * actualSpacing) - this.cameraX;
            const yHigh = priceToY(h);
            const yLow = priceToY(l);
            const yOpen = priceToY(o);
            const yClose = priceToY(c);

            const isBull = c >= o;
            const color = isBull ? 0x26A69A : 0xEF5350;

            // Wick
            g.rect(x + (candleWidth / 2) - 0.5, yHigh, 1, yLow - yHigh).fill(color);

            // Body
            const bodyTop = Math.min(yOpen, yClose);
            const bodyHeight = Math.max(1, Math.abs(yOpen - yClose));
            g.rect(x, bodyTop, candleWidth, bodyHeight).fill(color);
        }
    }
}