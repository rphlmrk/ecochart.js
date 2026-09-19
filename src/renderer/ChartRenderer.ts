import { Application, Graphics, Text, Container } from 'pixi.js';
import { DataStore } from '../data/DataStore';
import type { ChartTheme, LineStyle } from '../theme/types';
import { ThemeManager } from '../theme/ThemeManager';
import { StrokeEngine } from './StrokeEngine';

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
        this.axisBgColor = ThemeManager.hexToInt(theme.panelBackground);
        this.axisTextColor = ThemeManager.hexToInt(theme.axisText);
        this.crosshairColor = ThemeManager.hexToInt(theme.crosshair);

        const grid = ThemeManager.hexToColorAndAlpha(theme.gridLines);
        this.gridColor = grid.color;
        this.gridAlpha = grid.alpha;

        const bull = ThemeManager.hexToColorAndAlpha(theme.bullBody);
        this.bullColor = bull.color;
        this.bullAlpha = bull.alpha;

        const bear = ThemeManager.hexToColorAndAlpha(theme.bearBody);
        this.bearColor = bear.color;
        this.bearAlpha = bear.alpha;

        const bWick = ThemeManager.hexToColorAndAlpha(theme.bullWick);
        this.bullWickColor = bWick.color;
        this.bullWickAlpha = bWick.alpha;

        const rWick = ThemeManager.hexToColorAndAlpha(theme.bearWick);
        this.bearWickColor = rWick.color;
        this.bearWickAlpha = rWick.alpha;

        const bBorder = ThemeManager.hexToColorAndAlpha(theme.bullBorder);
        this.bullBorderColor = bBorder.color;
        this.bullBorderAlpha = bBorder.alpha;

        const rBorder = ThemeManager.hexToColorAndAlpha(theme.bearBorder);
        this.bearBorderColor = rBorder.color;
        this.bearBorderAlpha = rBorder.alpha;

        if (theme.crosshairLineStyle) this.crosshairStyle = theme.crosshairLineStyle;
        if (theme.livePriceLineStyle) this.livePriceStyle = theme.livePriceLineStyle;

        this.gridThickness = theme.gridThickness || 1;
        this.gridStyle = theme.gridStyle || 'solid';
    }

    // Theming & Line Styles
    public bgColor = 0x131722;
    public axisBgColor = 0x161a25; // Distinct shade for axes
    public gridColor = 0x2A2E39;
    public axisTextColor = 0xD1D4DC;

    // Luminance check: Inverts text to dark if badge background is bright
    private getContrastTextColor(hexColor: number): number {
        const r = (hexColor >> 16) & 0xff;
        const g = (hexColor >> 8) & 0xff;
        const b = hexColor & 0xff;
        const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
        return luminance > 0.6 ? 0x131722 : 0xffffff;
    }
    public crosshairStyle: LineStyle = 'dashed';
    public livePriceStyle: LineStyle = 'dashed';

    // Symbol / Candlestick Styling & Alphas
    public bullColor = 0x26A69A;
    public bullAlpha = 1;
    public bearColor = 0xEF5350;
    public bearAlpha = 1;
    public bullWickColor = 0x26A69A;
    public bullWickAlpha = 1;
    public bearWickColor = 0xEF5350;
    public bearWickAlpha = 1;
    public bullBorderColor = 0x26A69A;
    public bullBorderAlpha = 1;
    public bearBorderColor = 0xEF5350;
    public bearBorderAlpha = 1;
    public gridAlpha = 1;
    public gridThickness = 1;
    public gridStyle: LineStyle = 'solid';

    // Chart Render Style ('candles' | 'line')
    public chartMode: 'candles' | 'line' = 'candles';
    public mainLineWidth = 2;

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
            StrokeEngine.drawLine(this.gridGraphics, 0, y, chartWidth, y, { color: this.gridColor, width: this.gridThickness, alpha: this.gridAlpha, style: this.gridStyle });

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

            StrokeEngine.drawLine(this.gridGraphics, x, 0, x, chartHeight, { color: this.gridColor, width: this.gridThickness, alpha: this.gridAlpha, style: this.gridStyle });

            const ts = this.dataStore.data[i * 6];
            if (ts) {
                const date = new Date(ts);
                const timeStr = `${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}:${date.getSeconds().toString().padStart(2, '0')}`;

                const text = new Text({ text: timeStr, style: { fontFamily: 'sans-serif', fontSize: 11, fill: this.axisTextColor } });
                text.anchor.x = 0.5; // Tells PixiJS to permanently center the text itself
                text.x = x;          // Places the exact center on your vertical line
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
            this.candlesGraphics.stroke({ color: 0x2962FF, width: this.mainLineWidth });
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
                const bodyAlpha = isBull ? this.bullAlpha : this.bearAlpha;
                const wickColor = isBull ? this.bullWickColor : this.bearWickColor;
                const wickAlpha = isBull ? this.bullWickAlpha : this.bearWickAlpha;
                const borderColor = isBull ? this.bullBorderColor : this.bearBorderColor;
                const borderAlpha = isBull ? this.bullBorderAlpha : this.bearBorderAlpha;

                // Wick with Alpha
                this.candlesGraphics.rect(x + (candleWidth / 2) - 0.5, yH, 1, yL - yH)
                    .fill({ color: wickColor, alpha: wickAlpha });

                // Body & Border with Alphas
                const bodyTop = Math.min(yO, yC);
                const bodyHeight = Math.max(1, Math.abs(yO - yC));
                this.candlesGraphics.rect(x, bodyTop, candleWidth, bodyHeight)
                    .fill({ color: bodyColor, alpha: bodyAlpha })
                    .stroke({ color: borderColor, width: 1, alpha: borderAlpha });
            }
        }

        // --- 3. DRAW AXIS BACKGROUNDS (Distinct shade to separate from chart) ---
        this.uiGraphics.rect(chartWidth, 0, this.priceAxisWidth, height).fill(this.axisBgColor);
        this.uiGraphics.moveTo(chartWidth, 0).lineTo(chartWidth, height).stroke({ color: this.gridColor, width: 1 });

        this.uiGraphics.rect(0, chartHeight, width, this.timeAxisHeight).fill(this.axisBgColor);
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
            StrokeEngine.drawLine(this.uiGraphics, 0, liveY, chartWidth, liveY, {
                color: liveColor,
                width: 1,
                alpha: 0.75,
                style: this.livePriceStyle,
                dashLength: 5,
                gapLength: 3
            });

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

            // Check badge background luminance and select high-contrast text color
            const badgeTextColor = this.getContrastTextColor(liveColor);

            const livePriceText = new Text({
                text: lastClose.toFixed(2),
                style: { fontFamily: 'sans-serif', fontSize: 11, fontWeight: 'bold', fill: badgeTextColor }
            });
            livePriceText.x = chartWidth + 5;
            livePriceText.y = badgeY + 3;
            this.liveBadgeText.addChild(livePriceText);

            const countdownText = new Text({
                text: countdownStr,
                style: { fontFamily: 'sans-serif', fontSize: 11, fontWeight: '500', fill: badgeTextColor }
            });
            countdownText.alpha = 0.9;
            countdownText.x = chartWidth + 5;
            countdownText.y = badgeY + 18;
            this.liveBadgeText.addChild(countdownText);
        }

        // --- 5. DRAW CROSSHAIR & POSITIONED BADGES ---
        if (this.isCrosshairVisible && this.crosshairX >= 0 && this.crosshairX < chartWidth && this.crosshairY >= 0 && this.crosshairY < chartHeight) {
            StrokeEngine.drawLine(this.uiGraphics, 0, this.crosshairY, chartWidth, this.crosshairY, {
                color: this.crosshairColor,
                width: 1,
                alpha: 0.6,
                style: this.crosshairStyle,
                dashLength: 4,
                gapLength: 3
            });
            StrokeEngine.drawLine(this.uiGraphics, this.crosshairX, 0, this.crosshairX, chartHeight, {
                color: this.crosshairColor,
                width: 1,
                alpha: 0.6,
                style: this.crosshairStyle,
                dashLength: 4,
                gapLength: 3
            });

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