import { Application, Graphics, Text, Container } from 'pixi.js';
import { DataStore } from '../data/DataStore';

export class ChartRenderer {
    public app: Application;
    private dataStore: DataStore;

    // Pixi Layers (Z-Index order)
    private gridGraphics!: Graphics;
    private candlesGraphics!: Graphics;
    private uiGraphics!: Graphics; // Axes & Crosshair lines
    private textContainer!: Container; // Axis labels

    // Viewport Math
    public cameraX = 0;
    public cameraY = 0;
    public zoom = 1.0;
    public candleSpacing = 8.0;

    // Crosshair State
    public crosshairX = -100;
    public crosshairY = -100;
    public isCrosshairVisible = false;

    // Theming (Controlled by HTML UI)
    public bgColor = 0x131722;
    public gridColor = 0x2A2E39;
    public axisTextColor = 0xD1D4DC;

    public isAutoScale = true;
    public currentMinPrice = 0;
    public currentMaxPrice = 1;

    // Axis Dimensions (Exposed for index.ts hit detection)
    public priceAxisWidth = 60;
    public timeAxisHeight = 24;
    constructor(dataStore: DataStore) {
        this.dataStore = dataStore;
        this.app = new Application();
    }

    public async init(canvas: HTMLCanvasElement) {
        await this.app.init({
            canvas: canvas,
            resizeTo: canvas.parentElement!,
            backgroundColor: this.bgColor,
            antialias: false,
            resolution: window.devicePixelRatio || 1,
        });

        // Initialize Layers in order (Background -> Foreground)
        this.gridGraphics = new Graphics();
        this.candlesGraphics = new Graphics();
        this.uiGraphics = new Graphics();
        this.textContainer = new Container();

        this.app.stage.addChild(this.gridGraphics);
        this.app.stage.addChild(this.candlesGraphics);
        this.app.stage.addChild(this.uiGraphics);
        this.app.stage.addChild(this.textContainer);
    }

    public renderFrame() {
        if (!this.candlesGraphics || this.dataStore.length === 0) return;

        // Update Theme Background dynamically
        this.app.renderer.background.color = this.bgColor;

        this.candlesGraphics.clear();
        this.gridGraphics.clear();
        this.uiGraphics.clear();
        this.textContainer.removeChildren(); // Clear old text

        // Layout Constants
        const width = this.app.screen.width;
        const height = this.app.screen.height;
        const chartWidth = width - this.priceAxisWidth;
        const chartHeight = height - this.timeAxisHeight;

        const actualSpacing = this.candleSpacing * this.zoom;
        const visStart = Math.max(0, Math.floor(this.cameraX / actualSpacing));
        const visEnd = Math.min(this.dataStore.length, Math.floor((this.cameraX + chartWidth) / actualSpacing) + 1);

        if (this.isAutoScale) {
            let minP = Infinity; let maxP = -Infinity;
            for (let i = visStart; i < visEnd; i++) {
                const h = this.dataStore.data[i * 6 + 2];
                const l = this.dataStore.data[i * 6 + 3];
                if (h > maxP) maxP = h;
                if (l < minP) minP = l;
            }
            const range = maxP - minP || 1;
            this.currentMaxPrice = maxP + (range * 0.1);
            this.currentMinPrice = minP - (range * 0.1);
            this.cameraY = 0;
        }

        const priceToY = (price: number) => {
            const range = this.currentMaxPrice - this.currentMinPrice;
            const norm = (price - this.currentMinPrice) / range;
            return chartHeight - (norm * chartHeight) + this.cameraY;
        };

        const yToPrice = (y: number) => {
            const range = this.currentMaxPrice - this.currentMinPrice;
            const localY = y - this.cameraY;
            const norm = (chartHeight - localY) / chartHeight;
            return this.currentMinPrice + (norm * range);
        };

        // --- 1. DRAW BACKGROUND GRID & Y-AXIS ---
        // Calculate dynamic price step
        const visibleMax = yToPrice(0);
        const visibleMin = yToPrice(chartHeight);
        const range = visibleMax - visibleMin;

        let step = range / 8;
        const mag = Math.pow(10, Math.floor(Math.log10(step)));
        const norm = step / mag;
        if (norm < 1.5) step = 1 * mag;
        else if (norm < 3.5) step = 2.5 * mag;
        else if (norm < 7.5) step = 5 * mag;
        else step = 10 * mag;

        const firstPrice = Math.ceil(visibleMin / step) * step;

        for (let p = firstPrice; p <= visibleMax; p += step) {
            const y = priceToY(p);
            this.gridGraphics.moveTo(0, y).lineTo(chartWidth, y).stroke({ color: this.gridColor, width: 1 });

            const text = new Text({ text: p.toFixed(2), style: { fontFamily: 'sans-serif', fontSize: 11, fill: this.axisTextColor } });
            text.x = chartWidth + 5;
            text.y = y - 6;
            this.textContainer.addChild(text);
        }

        // --- 1.5 DRAW VERTICAL GRID & X-AXIS ---
        // Dynamically space vertical lines so they don't overlap
        const minPixelsBetweenLabels = 100;
        let candleStep = Math.max(1, Math.ceil(minPixelsBetweenLabels / actualSpacing));

        // Snap to nice round numbers (e.g., every 5, 10, 30 candles)
        if (candleStep > 1 && candleStep < 5) candleStep = 5;
        else if (candleStep > 5 && candleStep < 10) candleStep = 10;
        else if (candleStep > 10 && candleStep < 30) candleStep = 30;

        const startIdx = visStart - (visStart % candleStep);

        for (let i = startIdx; i < visEnd; i += candleStep) {
            if (i < 0) continue;
            const x = (i * actualSpacing) - this.cameraX;

            this.gridGraphics.moveTo(x, 0).lineTo(x, chartHeight).stroke({ color: this.gridColor, width: 1 });

            const ts = this.dataStore.data[i * 6];
            if (ts) {
                const date = new Date(ts);
                const timeStr = `${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}:${date.getSeconds().toString().padStart(2, '0')}`;

                const text = new Text({ text: timeStr, style: { fontFamily: 'sans-serif', fontSize: 11, fill: this.axisTextColor } });
                text.x = x - (text.width / 2); // Center text over the line
                text.y = chartHeight + 5;
                this.textContainer.addChild(text);
            }
        }

        // --- 2. DRAW CANDLES ---
        const candleWidth = Math.max(1, actualSpacing * 0.8);
        for (let i = visStart; i < visEnd; i++) {
            const base = i * 6;
            const o = this.dataStore.data[base + 1];
            const h = this.dataStore.data[base + 2];
            const l = this.dataStore.data[base + 3];
            const c = this.dataStore.data[base + 4];

            const x = (i * actualSpacing) - this.cameraX;
            const yH = priceToY(h), yL = priceToY(l), yO = priceToY(o), yC = priceToY(c);

            const color = c >= o ? 0x26A69A : 0xEF5350;

            this.candlesGraphics.rect(x + (candleWidth / 2) - 0.5, yH, 1, yL - yH).fill(color);
            this.candlesGraphics.rect(x, Math.min(yO, yC), candleWidth, Math.max(1, Math.abs(yO - yC))).fill(color);
        }

        // --- 3. DRAW AXIS BACKGROUNDS (Covers overflowing candles) ---
        this.uiGraphics.rect(chartWidth, 0, this.priceAxisWidth, height).fill(this.bgColor);
        this.uiGraphics.moveTo(chartWidth, 0).lineTo(chartWidth, height).stroke({ color: this.gridColor, width: 1 });

        this.uiGraphics.rect(0, chartHeight, width, this.timeAxisHeight).fill(this.bgColor);
        this.uiGraphics.moveTo(0, chartHeight).lineTo(width, chartHeight).stroke({ color: this.gridColor, width: 1 });

        // --- 4. DRAW CROSSHAIR ---
        if (this.isCrosshairVisible && this.crosshairX < chartWidth && this.crosshairY < chartHeight) {
            // Lines
            this.uiGraphics.moveTo(0, this.crosshairY).lineTo(chartWidth, this.crosshairY).stroke({ color: 0x787B86, width: 1 });
            this.uiGraphics.moveTo(this.crosshairX, 0).lineTo(this.crosshairX, chartHeight).stroke({ color: 0x787B86, width: 1 });

            // Y-Axis Price Badge
            const hoverPrice = yToPrice(this.crosshairY);
            this.uiGraphics.rect(chartWidth, this.crosshairY - 10, this.priceAxisWidth, 20).fill(0x2A2E39);
            const priceText = new Text({
                text: hoverPrice.toFixed(2),
                style: { fontFamily: 'sans-serif', fontSize: 11, fill: 0xffffff }
            });
            priceText.x = chartWidth + 5;
            priceText.y = this.crosshairY - 6;
            this.textContainer.addChild(priceText);

            // X-Axis Time Badge
            const logicalIndex = Math.round((this.crosshairX + this.cameraX) / actualSpacing);
            if (logicalIndex >= 0 && logicalIndex < this.dataStore.length) {
                const ts = this.dataStore.data[logicalIndex * 6]; // Timestamp
                const dateStr = new Date(ts).toLocaleTimeString(); // Basic format for now

                this.uiGraphics.rect(this.crosshairX - 35, chartHeight, 70, this.timeAxisHeight).fill(0x2A2E39);
                const timeText = new Text({
                    text: dateStr,
                    style: { fontFamily: 'sans-serif', fontSize: 11, fill: 0xffffff }
                });
                timeText.x = this.crosshairX - 30;
                timeText.y = chartHeight + 5;
                this.textContainer.addChild(timeText);
            }
        }
    }
}