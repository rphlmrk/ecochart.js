import { Application, Graphics, Text, Container } from 'pixi.js';
import { DataStore } from '../data/DataStore';
import type { ChartTheme, LineStyle } from '../theme/types';
import { ThemeManager } from '../theme/ThemeManager';
import { StrokeEngine } from './StrokeEngine';

export class ChartRenderer {
    public app: Application;
    public dataStore: DataStore;

    // Pixi Layers (Z-Index order)
    private gridGraphics!: Graphics;
    private candlesGraphics!: Graphics;
    private uiGraphics!: Graphics; // Axes & Crosshair lines
    private textContainer!: Container; // Axis labels
    private liveBadgeGraphics!: Graphics;
    private liveBadgeText!: Container;
    private crosshairBadgeGraphics!: Graphics; // Sits on top of live badge
    private crosshairBadgeText!: Container;     // Topmost layer

    //indicator
    public indicatorMainGraphics!: Graphics;
    public indicatorOscGraphics!: Graphics;

    // Dedicated Crosshair Graphics & Sync State
    private crosshairGraphics!: Graphics;
    private syncCrosshairGraphics!: Graphics;
    public syncHoverTimeMs: number | null = null;

    // Persistent Crosshair Text (Zero GC allocations on mouse move)
    private persistentPriceBadgeText!: Text;
    private persistentTimeBadgeText!: Text;

    // Axis Label Object Pools (Prevents VRAM Memory Leaks during panning)
    private priceLabelPool: Text[] = [];
    private activePriceLabels = 0;
    private timeLabelPool: Text[] = [];
    private activeTimeLabels = 0;

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

        // Update existing pooled labels when theme changes
        this.priceLabelPool.forEach(l => l.style.fill = this.axisTextColor);
        this.timeLabelPool.forEach(l => l.style.fill = this.axisTextColor);
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

    // Multi-Mode Chart Styles
    public chartMode: 'candles' | 'bars' | 'line' | 'area' | 'heikinAshi' = 'candles';
    public accentColor = 0x2962FF;
    public mainLineWidth = 2;

    // Current Timeframe for countdown & extrapolation
    public currentInterval: string = '1m';

    public parseIntervalMs(tf: string): number {
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
        this.indicatorMainGraphics = new Graphics();
        this.indicatorOscGraphics = new Graphics();
        this.uiGraphics = new Graphics();
        this.textContainer = new Container();

        this.liveBadgeGraphics = new Graphics();
        this.liveBadgeText = new Container();
        this.crosshairBadgeGraphics = new Graphics();
        this.crosshairBadgeText = new Container();

        this.crosshairGraphics = new Graphics();
        this.syncCrosshairGraphics = new Graphics();

        this.app.stage.addChild(this.gridGraphics);
        this.app.stage.addChild(this.candlesGraphics);
        this.app.stage.addChild(this.indicatorMainGraphics); // Indicators behind crosshair
        this.app.stage.addChild(this.indicatorOscGraphics);
        this.app.stage.addChild(this.uiGraphics);
        this.app.stage.addChild(this.textContainer);

        // Crosshairs sit above grid/candles and beneath badges
        this.app.stage.addChild(this.syncCrosshairGraphics);
        this.app.stage.addChild(this.crosshairGraphics);

        this.app.stage.addChild(this.liveBadgeGraphics);
        this.app.stage.addChild(this.liveBadgeText);
        this.app.stage.addChild(this.crosshairBadgeGraphics);
        this.app.stage.addChild(this.crosshairBadgeText);

        // Pre-allocate persistent crosshair labels once
        this.persistentPriceBadgeText = new Text({
            text: '',
            style: { fontFamily: 'sans-serif', fontSize: 11, fontWeight: 'bold', fill: 0xffffff }
        });
        this.persistentTimeBadgeText = new Text({
            text: '',
            style: { fontFamily: 'sans-serif', fontSize: 11, fill: 0xffffff }
        });
        this.persistentPriceBadgeText.visible = false;
        this.persistentTimeBadgeText.visible = false;

        this.crosshairBadgeText.addChild(this.persistentPriceBadgeText);
        this.crosshairBadgeText.addChild(this.persistentTimeBadgeText);
    }

    public renderFrame() {
        if (!this.candlesGraphics || this.dataStore.length === 0) return;

        // Update Theme Background dynamically
        this.app.renderer.background.color = this.bgColor;

        this.candlesGraphics.clear();
        this.gridGraphics.clear();
        this.uiGraphics.clear();
        this.liveBadgeGraphics.clear();
        this.liveBadgeText.removeChildren();

        // Reset pooled axis label counters without tearing down the reused WebGL textures
        this.activePriceLabels = 0;
        this.activeTimeLabels = 0;

        // Layout Constants
        const width = this.app.screen.width;
        const height = this.app.screen.height;
        const chartWidth = width - this.priceAxisWidth;
        const timeAxisY = height - this.timeAxisHeight; // The strict Y-coordinate where the time axis starts
        
        let oscHeight = 0;
        if (this.indicatorOscGraphics && this.indicatorOscGraphics.visible) oscHeight = 80;
        
        const mainChartHeight = timeAxisY - oscHeight; // Chart squishes to fit oscillator above time axis

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
            return mainChartHeight - (norm * mainChartHeight) + this.cameraY;
        };

        const yToPrice = (y: number) => {
            const range = this.currentMaxPrice - this.currentMinPrice;
            const localY = y - this.cameraY;
            const norm = (mainChartHeight - localY) / mainChartHeight;
            return this.currentMinPrice + (norm * range);
        };

        // --- 1. DRAW BACKGROUND GRID & Y-AXIS ---
        const visibleMax = yToPrice(0);
        const visibleMin = yToPrice(mainChartHeight);
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

            let textLabel: Text;
            if (this.activePriceLabels < this.priceLabelPool.length) {
                textLabel = this.priceLabelPool[this.activePriceLabels];
                textLabel.text = p.toFixed(2);
            } else {
                textLabel = new Text({ text: p.toFixed(2), style: { fontFamily: 'sans-serif', fontSize: 11, fill: this.axisTextColor } });
                this.priceLabelPool.push(textLabel);
                this.textContainer.addChild(textLabel);
            }
            
            textLabel.x = chartWidth + 5;
            textLabel.y = y - 6;
            textLabel.visible = true;
            this.activePriceLabels++;
        }

        // --- 1.5 DRAW VERTICAL GRID & X-AXIS ---
        const minPixelsBetweenLabels = 100;
        let candleStep = Math.max(1, Math.ceil(minPixelsBetweenLabels / actualSpacing));

        if (candleStep > 1 && candleStep < 5) candleStep = 5;
        else if (candleStep > 5 && candleStep < 10) candleStep = 10;
        else if (candleStep > 10 && candleStep < 30) candleStep = 30;

        const startIdx = visStart - (visStart % candleStep);

        for (let i = startIdx; i < visEnd; i += candleStep) {
            if (i < 0) continue;
            const x = (i * actualSpacing) - this.cameraX;

            // Vertical grid lines go all the way down to the Time Axis (covers oscillators)
            StrokeEngine.drawLine(this.gridGraphics, x, 0, x, timeAxisY, { color: this.gridColor, width: this.gridThickness, alpha: this.gridAlpha, style: this.gridStyle });

            const ts = this.dataStore.data[i * 6];
            if (ts) {
                const date = new Date(ts);
                const timeStr = `${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}:${date.getSeconds().toString().padStart(2, '0')}`;

                let textLabel: Text;
                if (this.activeTimeLabels < this.timeLabelPool.length) {
                    textLabel = this.timeLabelPool[this.activeTimeLabels];
                    textLabel.text = timeStr;
                } else {
                    textLabel = new Text({ text: timeStr, style: { fontFamily: 'sans-serif', fontSize: 11, fill: this.axisTextColor } });
                    textLabel.anchor.x = 0.5;
                    this.timeLabelPool.push(textLabel);
                    this.textContainer.addChild(textLabel);
                }
                
                textLabel.x = x;          
                textLabel.y = timeAxisY + 5;
                textLabel.visible = true;
                this.activeTimeLabels++;
            }
        }

        for (let i = this.activePriceLabels; i < this.priceLabelPool.length; i++) {
            this.priceLabelPool[i].visible = false;
        }
        for (let i = this.activeTimeLabels; i < this.timeLabelPool.length; i++) {
            this.timeLabelPool[i].visible = false;
        }

        // --- 2. MULTI-MODE CHART DRAWING ---
        const candleWidth = Math.max(1, actualSpacing * 0.8);

        if (this.chartMode === 'line') {
            for (let i = visStart; i < visEnd; i++) {
                const c = this.dataStore.data[i * 6 + 4];
                const x = (i * actualSpacing) - this.cameraX + (candleWidth / 2);
                const y = priceToY(c);
                if (i === visStart) this.candlesGraphics.moveTo(x, y);
                else this.candlesGraphics.lineTo(x, y);
            }
            this.candlesGraphics.stroke({ color: this.accentColor, width: this.mainLineWidth });

        } else if (this.chartMode === 'area') {
            if (visEnd > visStart) {
                const firstX = (visStart * actualSpacing) - this.cameraX + (candleWidth / 2);
                const lastX = ((visEnd - 1) * actualSpacing) - this.cameraX + (candleWidth / 2);

                this.candlesGraphics.moveTo(firstX, mainChartHeight);
                for (let i = visStart; i < visEnd; i++) {
                    const c = this.dataStore.data[i * 6 + 4];
                    const x = (i * actualSpacing) - this.cameraX + (candleWidth / 2);
                    const y = priceToY(c);
                    this.candlesGraphics.lineTo(x, y);
                }
                this.candlesGraphics.lineTo(lastX, mainChartHeight);
                this.candlesGraphics.closePath();
                this.candlesGraphics.fill({ color: this.accentColor, alpha: 0.2 });

                for (let i = visStart; i < visEnd; i++) {
                    const c = this.dataStore.data[i * 6 + 4];
                    const x = (i * actualSpacing) - this.cameraX + (candleWidth / 2);
                    const y = priceToY(c);
                    if (i === visStart) this.candlesGraphics.moveTo(x, y);
                    else this.candlesGraphics.lineTo(x, y);
                }
                this.candlesGraphics.stroke({ color: this.accentColor, width: this.mainLineWidth });
            }
        } else if (this.chartMode === 'bars') {
            const spineWidth = Math.max(1, Math.min(2, Math.floor(candleWidth * 0.2)));
            const tickWidth = Math.max(2, candleWidth / 2);

            for (let i = visStart; i < visEnd; i++) {
                const base = i * 6;
                const o = this.dataStore.data[base + 1], h = this.dataStore.data[base + 2], l = this.dataStore.data[base + 3], c = this.dataStore.data[base + 4];
                const x = (i * actualSpacing) - this.cameraX;
                const xMid = x + (candleWidth / 2);
                const yH = priceToY(h), yL = priceToY(l), yO = priceToY(o), yC = priceToY(c);
                const isBull = c >= o;
                const clr = isBull ? this.bullColor : this.bearColor;
                const alpha = isBull ? this.bullAlpha : this.bearAlpha;

                this.candlesGraphics.rect(xMid - (spineWidth / 2), yH, spineWidth, Math.max(1, yL - yH)).fill({ color: clr, alpha });
                this.candlesGraphics.rect(x, yO - (spineWidth / 2), tickWidth, spineWidth).fill({ color: clr, alpha });
                this.candlesGraphics.rect(xMid, yC - (spineWidth / 2), tickWidth, spineWidth).fill({ color: clr, alpha });
            }
        } else if (this.chartMode === 'heikinAshi') {
            let prevHaOpen = (this.dataStore.data[1] + this.dataStore.data[4]) / 2;
            let prevHaClose = (this.dataStore.data[1] + this.dataStore.data[2] + this.dataStore.data[3] + this.dataStore.data[4]) / 4;

            for (let i = 0; i < visEnd; i++) {
                const base = i * 6;
                const o = this.dataStore.data[base + 1], h = this.dataStore.data[base + 2], l = this.dataStore.data[base + 3], c = this.dataStore.data[base + 4];
                const haClose = (o + h + l + c) / 4;
                const haOpen = i === 0 ? prevHaOpen : (prevHaOpen + prevHaClose) / 2;
                const haHigh = Math.max(h, haOpen, haClose);
                const haLow = Math.min(l, haOpen, haClose);

                prevHaOpen = haOpen;
                prevHaClose = haClose;

                if (i >= visStart) {
                    const x = (i * actualSpacing) - this.cameraX;
                    const yH = priceToY(haHigh), yL = priceToY(haLow), yO = priceToY(haOpen), yC = priceToY(haClose);
                    const isBull = haClose >= haOpen;
                    const bodyColor = isBull ? this.bullColor : this.bearColor;
                    const bodyAlpha = isBull ? this.bullAlpha : this.bearAlpha;
                    const wickColor = isBull ? this.bullWickColor : this.bearWickColor;
                    const wickAlpha = isBull ? this.bullWickAlpha : this.bearWickAlpha;
                    const borderColor = isBull ? this.bullBorderColor : this.bearBorderColor;
                    const borderAlpha = isBull ? this.bullBorderAlpha : this.bearBorderAlpha;

                    this.candlesGraphics.rect(x + (candleWidth / 2) - 0.5, yH, 1, Math.max(1, yL - yH)).fill({ color: wickColor, alpha: wickAlpha });
                    const bodyTop = Math.min(yO, yC);
                    const bodyHeight = Math.max(1, Math.abs(yO - yC));
                    this.candlesGraphics.rect(x, bodyTop, candleWidth, bodyHeight).fill({ color: bodyColor, alpha: bodyAlpha }).stroke({ color: borderColor, width: 1, alpha: borderAlpha });
                }
            }
        } else {
            for (let i = visStart; i < visEnd; i++) {
                const base = i * 6;
                const o = this.dataStore.data[base + 1], h = this.dataStore.data[base + 2], l = this.dataStore.data[base + 3], c = this.dataStore.data[base + 4];
                const x = (i * actualSpacing) - this.cameraX;
                const yH = priceToY(h), yL = priceToY(l), yO = priceToY(o), yC = priceToY(c);
                const isBull = c >= o;
                const bodyColor = isBull ? this.bullColor : this.bearColor;
                const bodyAlpha = isBull ? this.bullAlpha : this.bearAlpha;
                const wickColor = isBull ? this.bullWickColor : this.bearWickColor;
                const wickAlpha = isBull ? this.bullWickAlpha : this.bearWickAlpha;
                const borderColor = isBull ? this.bullBorderColor : this.bearBorderColor;
                const borderAlpha = isBull ? this.bullBorderAlpha : this.bearBorderAlpha;

                this.candlesGraphics.rect(x + (candleWidth / 2) - 0.5, yH, 1, Math.max(1, yL - yH)).fill({ color: wickColor, alpha: wickAlpha });
                const bodyTop = Math.min(yO, yC);
                const bodyHeight = Math.max(1, Math.abs(yO - yC));
                this.candlesGraphics.rect(x, bodyTop, candleWidth, bodyHeight).fill({ color: bodyColor, alpha: bodyAlpha }).stroke({ color: borderColor, width: 1, alpha: borderAlpha });
            }
        }

        // --- 3. DRAW AXIS BACKGROUNDS ---
        this.uiGraphics.rect(chartWidth, 0, this.priceAxisWidth, height).fill(this.axisBgColor);
        this.uiGraphics.moveTo(chartWidth, 0).lineTo(chartWidth, height).stroke({ color: this.gridColor, width: 1 });

        // Draw Time Axis EXACTLY at the bottom of the screen (below oscillators)
        this.uiGraphics.rect(0, timeAxisY, width, this.timeAxisHeight).fill(this.axisBgColor);
        this.uiGraphics.moveTo(0, timeAxisY).lineTo(width, timeAxisY).stroke({ color: this.gridColor, width: 1 });

        // --- 4. DRAW LIVE PRICE LINE & COUNTDOWN BADGE ---
        const lastIdx = this.dataStore.length - 1;
        const lastBase = lastIdx * 6;
        const lastOpen = this.dataStore.data[lastBase + 1];
        const lastClose = this.dataStore.data[lastBase + 4];
        const lastTime = this.dataStore.data[lastBase];

        const liveY = priceToY(lastClose);
        const isBullish = lastClose >= lastOpen;
        const liveColor = isBullish ? this.bullColor : this.bearColor;

        if (liveY >= 0 && liveY <= mainChartHeight) {
            StrokeEngine.drawLine(this.uiGraphics, 0, liveY, chartWidth, liveY, {
                color: liveColor, width: 1, alpha: 0.75, style: this.livePriceStyle, dashLength: 5, gapLength: 3
            });

            const intervalMs = this.parseIntervalMs(this.currentInterval);
            const remainingMs = Math.max(0, (lastTime + intervalMs) - Date.now());
            const totalSeconds = Math.floor(remainingMs / 1000);
            const hours = Math.floor(totalSeconds / 3600);
            const mins = Math.floor((totalSeconds % 3600) / 60);
            const secs = totalSeconds % 60;

            let countdownStr = `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
            if (hours > 0) countdownStr = `${hours}:${countdownStr}`;

            const badgeH = 36;
            const badgeY = Math.max(0, Math.min(mainChartHeight - badgeH, liveY - 18));
            this.liveBadgeGraphics.rect(chartWidth, badgeY, this.priceAxisWidth, badgeH).fill(liveColor);

            const badgeTextColor = this.getContrastTextColor(liveColor);

            const livePriceText = new Text({ text: lastClose.toFixed(2), style: { fontFamily: 'sans-serif', fontSize: 11, fontWeight: 'bold', fill: badgeTextColor }});
            livePriceText.x = chartWidth + 5;
            livePriceText.y = badgeY + 3;
            this.liveBadgeText.addChild(livePriceText);

            const countdownText = new Text({ text: countdownStr, style: { fontFamily: 'sans-serif', fontSize: 11, fontWeight: '500', fill: badgeTextColor }});
            countdownText.alpha = 0.9;
            countdownText.x = chartWidth + 5;
            countdownText.y = badgeY + 18;
            this.liveBadgeText.addChild(countdownText);
        }
    }

    public renderCrosshair() {
        if (!this.crosshairGraphics || !this.syncCrosshairGraphics) return;

        this.crosshairGraphics.clear();
        this.syncCrosshairGraphics.clear();
        this.crosshairBadgeGraphics.clear();

        this.persistentPriceBadgeText.visible = false;
        this.persistentTimeBadgeText.visible = false;

        const width = this.app.screen.width;
        const height = this.app.screen.height;
        const chartWidth = width - this.priceAxisWidth;
        const timeAxisY = height - this.timeAxisHeight;
        
        let oscHeight = 0;
        if (this.indicatorOscGraphics && this.indicatorOscGraphics.visible) oscHeight = 80;
        const mainChartHeight = timeAxisY - oscHeight;

        const actualSpacing = this.candleSpacing * this.zoom;
        const intervalMs = this.parseIntervalMs(this.currentInterval);

        // 1. Draw Local Crosshair & Badges
        if (this.isCrosshairVisible && this.crosshairX >= 0 && this.crosshairX < chartWidth && this.crosshairY >= 0 && this.crosshairY < timeAxisY) {
            
            // Horizontal crosshair across entire width
            StrokeEngine.drawLine(this.crosshairGraphics, 0, this.crosshairY, chartWidth, this.crosshairY, {
                color: this.crosshairColor, width: 1, alpha: 0.6, style: this.crosshairStyle, dashLength: 4, gapLength: 3
            });
            // Vertical crosshair down to the time axis
            StrokeEngine.drawLine(this.crosshairGraphics, this.crosshairX, 0, this.crosshairX, timeAxisY, {
                color: this.crosshairColor, width: 1, alpha: 0.6, style: this.crosshairStyle, dashLength: 4, gapLength: 3
            });

            // Y-Axis Price Badge (Only show if hovering the main chart)
            if (this.crosshairY <= mainChartHeight) {
                const range = this.currentMaxPrice - this.currentMinPrice;
                const localY = this.crosshairY - this.cameraY;
                const norm = (mainChartHeight - localY) / mainChartHeight;
                const hoverPrice = this.currentMinPrice + (norm * range);

                const hoverPriceY = Math.max(0, Math.min(mainChartHeight - 20, this.crosshairY - 10));
                this.crosshairBadgeGraphics.rect(chartWidth, hoverPriceY, this.priceAxisWidth, 20).fill(0x363A45);

                this.persistentPriceBadgeText.text = hoverPrice.toFixed(2);
                this.persistentPriceBadgeText.x = chartWidth + 5;
                this.persistentPriceBadgeText.y = hoverPriceY + 3;
                this.persistentPriceBadgeText.visible = true;
            }

            // X-Axis Time Badge
            const logicalIndex = Math.round((this.crosshairX + this.cameraX) / actualSpacing);
            const lastIdx = this.dataStore.length - 1;
            const lastTime = lastIdx >= 0 ? this.dataStore.data[lastIdx * 6] : 0;

            let hoverTimeMs = 0;
            if (logicalIndex >= 0 && logicalIndex < this.dataStore.length) {
                hoverTimeMs = this.dataStore.data[logicalIndex * 6];
            } else if (logicalIndex >= this.dataStore.length && lastIdx >= 0) {
                hoverTimeMs = lastTime + (logicalIndex - lastIdx) * intervalMs;
            } else if (this.dataStore.length > 0) {
                const firstTime = this.dataStore.data[0];
                hoverTimeMs = firstTime + logicalIndex * intervalMs;
            }

            if (hoverTimeMs > 0) {
                const d = new Date(hoverTimeMs);
                const dateBadgeStr = `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;

                this.persistentTimeBadgeText.text = dateBadgeStr;
                const badgeW = this.persistentTimeBadgeText.width + 16;
                const badgeX = Math.max(0, Math.min(chartWidth - badgeW, this.crosshairX - (badgeW / 2)));

                this.crosshairBadgeGraphics.rect(badgeX, timeAxisY, badgeW, this.timeAxisHeight).fill(0x363A45);

                this.persistentTimeBadgeText.anchor.set(0.5);
                this.persistentTimeBadgeText.x = badgeX + (badgeW / 2);
                this.persistentTimeBadgeText.y = timeAxisY + (this.timeAxisHeight / 2);
                this.persistentTimeBadgeText.visible = true;
            }
        }

        // 2. Draw Synchronized Crosshair from other panes
        if (this.syncHoverTimeMs !== null && this.dataStore.length > 0) {
            const firstTime = this.dataStore.data[0];
            const logicalIndex = Math.round((this.syncHoverTimeMs - firstTime) / intervalMs);
            const syncX = (logicalIndex * actualSpacing) - this.cameraX;

            if (syncX >= 0 && syncX < chartWidth) {
                StrokeEngine.drawLine(this.syncCrosshairGraphics, syncX, 0, syncX, timeAxisY, {
                    color: this.crosshairColor, width: 1, alpha: 0.45, style: this.crosshairStyle, dashLength: 4, gapLength: 3
                });
            }
        }
    }

    public destroy() {
        if (this.app) {
            this.app.destroy(true, { children: true, texture: true });
        }
    }
}