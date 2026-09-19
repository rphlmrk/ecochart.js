import { Application, Graphics, Text, Container } from 'pixi.js';
import { DataStore } from '../data/DataStore';
import type { ChartTheme } from '../theme/types';
import { ThemeManager } from '../theme/ThemeManager';

export class ChartRenderer {
    public app: Application;
    private dataStore: DataStore;

    // Pixi Layers (Z-Index order)
    private gridGraphics!: Graphics;
    private candlesGraphics!: Graphics;
    private uiGraphics!: Graphics; // Axes & Crosshair lines
    private textContainer!: Container; // Axis labels
    private liveBadgeGraphics!: Graphics;
    private liveBadgeText!: Container;
    private crosshairBadgeGraphics!: Graphics; // Sits on top of live badge
    private crosshairBadgeText!: Container;     // Topmost layer

    // Viewport Math
    public cameraX = 0;
    public cameraY = 0;
    public zoom = 1.0;
    public candleSpacing = 8.0;

    // Crosshair State
    public crosshairX = -100;
    public crosshairY = -100;
    public isCrosshairVisible = false;
    public crosshairColor = 0x9598A1;

    public applyTheme(theme: ChartTheme) {
        this.bgColor = ThemeManager.hexToInt(theme.background);
        this.gridColor = ThemeManager.hexToInt(theme.gridLines);
        this.axisTextColor = ThemeManager.hexToInt(theme.axisText);
        this.crosshairColor = ThemeManager.hexToInt(theme.crosshair);
        this.bullColor = ThemeManager.hexToInt(theme.bullBody);
        this.bearColor = ThemeManager.hexToInt(theme.bearBody);
        this.bullWickColor = ThemeManager.hexToInt(theme.bullWick);
        this.bearWickColor = ThemeManager.hexToInt(theme.bearWick);
        this.bullBorderColor = ThemeManager.hexToInt(theme.bullBorder);
        this.bearBorderColor = ThemeManager.hexToInt(theme.bearBorder);
    }

    // Theming (Controlled by HTML UI)
    public bgColor = 0x131722;
    public gridColor = 0x2A2E39;
    public axisTextColor = 0xD1D4DC;

    // Symbol / Candlestick Styling
    public bullColor = 0x26A69A;
    public bearColor = 0xEF5350;
    public bullWickColor = 0x26A69A;
    public bearWickColor = 0xEF5350;
    public bullBorderColor = 0x26A69A;
    public bearBorderColor = 0xEF5350;

    // Chart Render Style ('candles' | 'line')
    public chartMode: 'candles' | 'line' = 'candles';

    // Current Timeframe for countdown & extrapolation
    public currentInterval: string = '1m';

    private parseIntervalMs(tf: string): number {
        const unit = tf.slice(-1).toLowerCase();
        const val = parseInt(tf.slice(0, -1), 10) || 1;
        if (unit === 's') return val * 1000;
        if (unit === 'm') return val * 60 * 1000;
        if (unit === 'h') return val * 60 * 60 * 1000;
        if (unit === 'd') return val * 24 * 60 * 60 * 1000;
        if (unit === 'w') return val * 7 * 24 * 60 * 60 * 1000;
        return 60 * 1000;
    }

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

        this.liveBadgeGraphics = new Graphics();
        this.liveBadgeText = new Container();
        this.crosshairBadgeGraphics = new Graphics();
        this.crosshairBadgeText = new Container();

        this.app.stage.addChild(this.gridGraphics);
        this.app.stage.addChild(this.candlesGraphics);
        this.app.stage.addChild(this.uiGraphics);
        this.app.stage.addChild(this.textContainer);
        this.app.stage.addChild(this.liveBadgeGraphics);      // 1. Live Badge Background
        this.app.stage.addChild(this.liveBadgeText);          // 2. Live Badge Text
        this.app.stage.addChild(this.crosshairBadgeGraphics); // 3. Crosshair Background (Covers Live Badge & Text!)
        this.app.stage.addChild(this.crosshairBadgeText);     // 4. Crosshair Text (On the very top)
    }

    public renderFrame() {
        if (!this.candlesGraphics || this.dataStore.length === 0) return;

        // Update Theme Background dynamically
        this.app.renderer.background.color = this.bgColor;

        this.candlesGraphics.clear();
        this.gridGraphics.clear();
        this.uiGraphics.clear();
        this.liveBadgeGraphics.clear();
        this.crosshairBadgeGraphics.clear();
        this.textContainer.removeChildren();
        this.liveBadgeText.removeChildren();
        this.crosshairBadgeText.removeChildren();

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

        // --- 2. DRAW CANDLES OR LINE ---
        if (this.chartMode === 'line') {
            for (let i = visStart; i < visEnd; i++) {
                const c = this.dataStore.data[i * 6 + 4];
                const x = (i * actualSpacing) - this.cameraX;
                const y = priceToY(c);

                if (i === visStart) {
                    this.candlesGraphics.moveTo(x, y);
                } else {
                    this.candlesGraphics.lineTo(x, y);
                }
            }
            this.candlesGraphics.stroke({ color: 0x2962FF, width: 2 });
        } else {
            const candleWidth = Math.max(1, actualSpacing * 0.8);
            for (let i = visStart; i < visEnd; i++) {
                const base = i * 6;
                const o = this.dataStore.data[base + 1];
                const h = this.dataStore.data[base + 2];
                const l = this.dataStore.data[base + 3];
                const c = this.dataStore.data[base + 4];

                const x = (i * actualSpacing) - this.cameraX;
                const yH = priceToY(h), yL = priceToY(l), yO = priceToY(o), yC = priceToY(c);

                const isBull = c >= o;
                const bodyColor = isBull ? this.bullColor : this.bearColor;
                const wickColor = isBull ? this.bullWickColor : this.bearWickColor;
                const borderColor = isBull ? this.bullBorderColor : this.bearBorderColor;

                // Wick
                this.candlesGraphics.rect(x + (candleWidth / 2) - 0.5, yH, 1, yL - yH).fill(wickColor);

                // Body & Border
                const bodyTop = Math.min(yO, yC);
                const bodyHeight = Math.max(1, Math.abs(yO - yC));
                this.candlesGraphics.rect(x, bodyTop, candleWidth, bodyHeight)
                    .fill(bodyColor)
                    .stroke({ color: borderColor, width: 1 });
            }
        }

        // --- 3. DRAW AXIS BACKGROUNDS (Covers overflowing candles) ---
        this.uiGraphics.rect(chartWidth, 0, this.priceAxisWidth, height).fill(this.bgColor);
        this.uiGraphics.moveTo(chartWidth, 0).lineTo(chartWidth, height).stroke({ color: this.gridColor, width: 1 });

        this.uiGraphics.rect(0, chartHeight, width, this.timeAxisHeight).fill(this.bgColor);
        this.uiGraphics.moveTo(0, chartHeight).lineTo(width, chartHeight).stroke({ color: this.gridColor, width: 1 });

        // --- 4. DRAW LIVE PRICE LINE & COUNTDOWN BADGE ---
        const lastIdx = this.dataStore.length - 1;
        const lastBase = lastIdx * 6;
        const lastOpen = this.dataStore.data[lastBase + 1];
        const lastClose = this.dataStore.data[lastBase + 4];
        const lastTime = this.dataStore.data[lastBase];

        const liveY = priceToY(lastClose);
        const isBullish = lastClose >= lastOpen;
        const liveColor = isBullish ? this.bullColor : this.bearColor;

        // A. Horizontal Live Price Line across chart
        if (liveY >= 0 && liveY <= chartHeight) {
            this.uiGraphics.moveTo(0, liveY).lineTo(chartWidth, liveY).stroke({ color: liveColor, width: 1, alpha: 0.75 });

            // B. Calculate Candle Remaining Time
            const intervalMs = this.parseIntervalMs(this.currentInterval);
            const nextCloseMs = lastTime + intervalMs;
            const remainingMs = Math.max(0, nextCloseMs - Date.now());

            const totalSeconds = Math.floor(remainingMs / 1000);
            const hours = Math.floor(totalSeconds / 3600);
            const mins = Math.floor((totalSeconds % 3600) / 60);
            const secs = totalSeconds % 60;

            let countdownStr = `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
            if (hours > 0) {
                countdownStr = `${hours}:${countdownStr}`;
            }

            // C. Stacked Live Badge (Expanded to 36px height for clearer numbers)
            const badgeH = 36;
            const badgeY = Math.max(0, Math.min(chartHeight - badgeH, liveY - 18));
            this.liveBadgeGraphics.rect(chartWidth, badgeY, this.priceAxisWidth, badgeH).fill(liveColor);

            const livePriceText = new Text({
                text: lastClose.toFixed(2),
                style: { fontFamily: 'sans-serif', fontSize: 11, fontWeight: 'bold', fill: 0xffffff }
            });
            livePriceText.x = chartWidth + 5;
            livePriceText.y = badgeY + 3;
            this.liveBadgeText.addChild(livePriceText);

            // Larger countdown text (increased from 9px to 11px)
            const countdownText = new Text({
                text: countdownStr,
                style: { fontFamily: 'sans-serif', fontSize: 11, fontWeight: '500', fill: 0xffffff }
            });
            countdownText.alpha = 0.9;
            countdownText.x = chartWidth + 5;
            countdownText.y = badgeY + 18;
            this.liveBadgeText.addChild(countdownText);
        }

        // --- 5. DRAW CROSSHAIR & POSITIONED BADGES ---
        if (this.isCrosshairVisible && this.crosshairX >= 0 && this.crosshairX < chartWidth && this.crosshairY >= 0 && this.crosshairY < chartHeight) {
            // Crosshair lines rendered using active theme color
            this.uiGraphics.moveTo(0, this.crosshairY).lineTo(chartWidth, this.crosshairY).stroke({ color: this.crosshairColor, width: 1, alpha: 0.6 });
            this.uiGraphics.moveTo(this.crosshairX, 0).lineTo(this.crosshairX, chartHeight).stroke({ color: this.crosshairColor, width: 1, alpha: 0.6 });

            // Y-Axis Price Badge (Draws on crosshair layer: occludes live price AND countdown)
            const hoverPrice = yToPrice(this.crosshairY);
            const hoverPriceY = Math.max(0, Math.min(chartHeight - 20, this.crosshairY - 10));
            this.crosshairBadgeGraphics.rect(chartWidth, hoverPriceY, this.priceAxisWidth, 20).fill(0x363A45);

            const priceText = new Text({
                text: hoverPrice.toFixed(2),
                style: { fontFamily: 'sans-serif', fontSize: 11, fontWeight: 'bold', fill: 0xffffff }
            });
            priceText.x = chartWidth + 5;
            priceText.y = hoverPriceY + 3;
            this.crosshairBadgeText.addChild(priceText);

            // X-Axis Time Badge
            const logicalIndex = Math.round((this.crosshairX + this.cameraX) / actualSpacing);
            const intervalMs = this.parseIntervalMs(this.currentInterval);

            let hoverTimeMs = 0;
            if (logicalIndex >= 0 && logicalIndex < this.dataStore.length) {
                hoverTimeMs = this.dataStore.data[logicalIndex * 6];
            } else if (logicalIndex >= this.dataStore.length) {
                hoverTimeMs = lastTime + (logicalIndex - lastIdx) * intervalMs;
            } else {
                const firstTime = this.dataStore.data[0];
                hoverTimeMs = firstTime + logicalIndex * intervalMs;
            }

            const d = new Date(hoverTimeMs);
            const dateBadgeStr = `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;

            const badgeW = 105;
            const badgeX = Math.max(0, Math.min(chartWidth - badgeW, this.crosshairX - (badgeW / 2)));
            this.crosshairBadgeGraphics.rect(badgeX, chartHeight, badgeW, this.timeAxisHeight).fill(0x363A45);

            const timeText = new Text({
                text: dateBadgeStr,
                style: { fontFamily: 'sans-serif', fontSize: 11, fill: 0xffffff }
            });
            timeText.x = badgeX + 6;
            timeText.y = chartHeight + 5;
            this.crosshairBadgeText.addChild(timeText);
        }
    }
}