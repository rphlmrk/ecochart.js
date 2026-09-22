import { Application, Graphics, Text, Container } from 'pixi.js';
import { DataStore } from '../data/DataStore';
import type { ChartTheme, LineStyle } from '../theme/types';
import { ThemeManager } from '../theme/ThemeManager';
import { StrokeEngine } from './StrokeEngine';
import type { OscillatorScale } from '../indicators/Indicator';

export class ChartRenderer {
    public app: Application;
    public dataStore: DataStore;
    // Theme state
    public isDarkTheme = true;

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
    public drawingGraphics!: Graphics; 

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

    // Dedicated Sub-Panel Scale
    public oscHeight = 0; // <-- Dynamic stacked oscillator height
    public activeOscillatorScale?: OscillatorScale;
    private oscLabelPool: Text[] = [];
    private activeOscLabels = 0;

    // Oscillator Panel Header Telemetry (Zero GC Pool)
    public indicatorManager?: any;
    private oscHeaderContainer!: Container;
    private oscHeaderPairPool: { title: Text; val: Text }[] = [];

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
    public isMagnetEnabled = true;

    public applyTheme(theme: ChartTheme) {
        this.isDarkTheme = theme.isDark; // <-- Store dark/light state
        this.bgColor = ThemeManager.hexToInt(theme.background);
        

        if (this.app && this.app.renderer) {
            this.app.renderer.background.color = this.bgColor;
        }

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
        this.oscLabelPool.forEach(l => l.style.fill = this.axisTextColor);
        this.oscHeaderPairPool.forEach(p => p.title.style.fill = this.axisTextColor);
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

        this.oscHeaderContainer = new Container();

        this.app.stage.addChild(this.gridGraphics);
        this.app.stage.addChild(this.candlesGraphics);
        this.app.stage.addChild(this.indicatorMainGraphics); // Indicators behind crosshair
        this.app.stage.addChild(this.indicatorOscGraphics);
        this.drawingGraphics = new Graphics();
        this.app.stage.addChild(this.drawingGraphics);
        this.app.stage.addChild(this.oscHeaderContainer); // Bottom panel header text
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

        this.candlesGraphics.clear();
        this.gridGraphics.clear();
        this.gridGraphics.clear();
        this.uiGraphics.clear();
        this.liveBadgeGraphics.clear();
        this.liveBadgeText.removeChildren();

        // Reset pooled axis label counters without tearing down the reused WebGL textures
        this.activePriceLabels = 0;
        this.activeTimeLabels = 0;
        this.activeOscLabels = 0;

        // Layout Constants
        const width = this.app.screen.width;
        const height = this.app.screen.height;
        const chartWidth = width - this.priceAxisWidth;
        const timeAxisY = height - this.timeAxisHeight; // The strict Y-coordinate where the time axis starts
        
        const oscHeight = this.oscHeight;
        const mainChartHeight = timeAxisY - oscHeight; // Chart squishes to fit oscillator above time axis

        const actualSpacing = this.candleSpacing * this.zoom;
        
        // Sliding window with a 15-candle buffer on each side for smooth scrolling
        const buffer = 15;
        const rawVisStart = Math.floor(this.cameraX / actualSpacing);
        const rawVisEnd = Math.floor((this.cameraX + chartWidth) / actualSpacing) + 1;

        const visStart = Math.max(0, rawVisStart - buffer);
        const visEnd = Math.min(this.dataStore.length, rawVisEnd + buffer);

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

        // --- 3. DRAW AXIS BACKGROUNDS & DIVIDERS ---
        this.uiGraphics.rect(chartWidth, 0, this.priceAxisWidth, height).fill(this.axisBgColor);
        this.uiGraphics.moveTo(chartWidth, 0).lineTo(chartWidth, height).stroke({ color: this.gridColor, width: 1 });

        // Draw Time Axis at bottom
        this.uiGraphics.rect(0, timeAxisY, width, this.timeAxisHeight).fill(this.axisBgColor);
        this.uiGraphics.moveTo(0, timeAxisY).lineTo(width, timeAxisY).stroke({ color: this.gridColor, width: 1 });

        // Draw Divider Line across chart AND right axis column
        if (oscHeight > 0) {
            StrokeEngine.drawLine(this.uiGraphics, 0, mainChartHeight, width, mainChartHeight, {
                color: this.gridColor,
                width: 1,
                alpha: 1.0
            });

            // Draw Independent Oscillator Scale on the right axis
            if (this.activeOscillatorScale && this.activeOscillatorScale.steps) {
                const { min, max, steps } = this.activeOscillatorScale;
                const range = max - min || 1;

                for (const step of steps) {
                    const norm = (step - min) / range;
                    const y = timeAxisY - (norm * oscHeight);

                    // Draw tick mark on the axis
                    StrokeEngine.drawLine(this.gridGraphics, chartWidth, y, chartWidth + 4, y, {
                        color: this.gridColor,
                        width: 1,
                        alpha: 0.8
                    });

                    // Format string
                    const labelText = this.activeOscillatorScale.format 
                        ? this.activeOscillatorScale.format(step) 
                        : (step > 0 ? `+${step}` : `${step}`);

                    // Fetch from Object Pool (Zero VRAM allocations)
                    let textLabel: Text;
                    if (this.activeOscLabels < this.oscLabelPool.length) {
                        textLabel = this.oscLabelPool[this.activeOscLabels];
                        textLabel.text = labelText;
                    } else {
                        textLabel = new Text({
                            text: labelText,
                            style: { fontFamily: 'sans-serif', fontSize: 10, fill: this.axisTextColor }
                        });
                        this.oscLabelPool.push(textLabel);
                        this.textContainer.addChild(textLabel);
                    }

                    textLabel.x = chartWidth + 6;
                    textLabel.y = y - 5;
                    textLabel.visible = true;
                    this.activeOscLabels++;
                }
            }
        }

        // Hide unused oscillator labels in the pool
        for (let i = this.activeOscLabels; i < this.oscLabelPool.length; i++) {
            this.oscLabelPool[i].visible = false;
        }

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

        // Render Title & Live/Historical Telemetry for Bottom Panels
        this.updateOscillatorHeaders();
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
        
        const oscHeight = this.oscHeight;
        const mainChartHeight = timeAxisY - oscHeight;

        const actualSpacing = this.candleSpacing * this.zoom;
        const intervalMs = this.parseIntervalMs(this.currentInterval);

        // 1. Draw Local Crosshair & Badges
        if (this.isCrosshairVisible && this.crosshairX >= 0 && this.crosshairX < chartWidth && this.crosshairY >= 0 && this.crosshairY < timeAxisY) {
            
            // Magnet Snap Logic
            let drawX = this.crosshairX;
            let drawY = this.crosshairY;
            
            // Only snap if magnet is on AND we are hovering the main chart (not oscillators)
            if (this.isMagnetEnabled && this.crosshairY <= mainChartHeight) {
                const mag = this.getMagnetPoint(this.crosshairX, this.crosshairY, 30);
                drawX = this.timeToX(mag.time);
                drawY = this.priceToY(mag.price);
            }

            // Horizontal crosshair across entire width
            StrokeEngine.drawLine(this.crosshairGraphics, 0, drawY, chartWidth, drawY, {
                color: this.crosshairColor, width: 1, alpha: 0.6, style: this.crosshairStyle, dashLength: 4, gapLength: 3
            });
            // Vertical crosshair down to the time axis
            StrokeEngine.drawLine(this.crosshairGraphics, drawX, 0, drawX, timeAxisY, {
                color: this.crosshairColor, width: 1, alpha: 0.6, style: this.crosshairStyle, dashLength: 4, gapLength: 3
            });

            // Update crosshair tracking variables for the badges to use the snapped coords
            this.crosshairX = drawX;
            this.crosshairY = drawY;

            // Y-Axis Badge (Dynamic switching between Main Price and Oscillator Scale)
            if (this.crosshairY <= mainChartHeight) {
                // CASE A: Hovering Main Chart -> Asset Price
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

            } else if (this.crosshairY > mainChartHeight && this.crosshairY < timeAxisY && this.activeOscillatorScale) {
                // CASE B: Hovering Sub-Panel -> Oscillator Reading
                const localY = this.crosshairY - mainChartHeight;
                const norm = (oscHeight - localY) / oscHeight;
                const { min, max } = this.activeOscillatorScale;
                const oscVal = min + (norm * (max - min));

                const hoverPriceY = Math.max(mainChartHeight, Math.min(timeAxisY - 20, this.crosshairY - 10));
                this.crosshairBadgeGraphics.rect(chartWidth, hoverPriceY, this.priceAxisWidth, 20).fill(0x363A45);

                this.persistentPriceBadgeText.text = (oscVal > 0 ? `+` : ``) + oscVal.toFixed(1);
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

        // Update Bottom Panel Telemetry on crosshair movement
        this.updateOscillatorHeaders();
    }

    /**
     * Resolves candle index under the cursor:
     * - Over historical candles: returns candle index.
     * - Beyond live candle to the right: returns live index (lastIdx).
     * - Crosshair hidden: returns live index (lastIdx).
     */
    public getHoverIndex(): number {
        const lastIdx = this.dataStore.length - 1;
        if (lastIdx < 0) return 0;

        const chartWidth = this.app.screen.width - this.priceAxisWidth;
        const actualSpacing = this.candleSpacing * this.zoom;
        const logicalIndex = Math.round((this.crosshairX + this.cameraX) / actualSpacing);

        if (this.isCrosshairVisible && this.crosshairX >= 0 && this.crosshairX < chartWidth) {
            if (logicalIndex >= 0 && logicalIndex <= lastIdx) {
                return logicalIndex;
            }
            if (logicalIndex > lastIdx) {
                return lastIdx;
            }
        }
        return Math.max(0, lastIdx);
    }

    /**
     * Draws the Title and Telemetry value for each active bottom panel.
     */
    public updateOscillatorHeaders() {
        if (!this.oscHeaderContainer || !this.indicatorManager) return;

        const targetIdx = this.getHoverIndex();
        const activeOscs = this.indicatorManager.activeIndicators.filter((i: any) => i.isOscillator && i.visible);

        const timeAxisY = this.app.screen.height - this.timeAxisHeight;
        let currentOscY = timeAxisY - this.oscHeight;
        let pairIdx = 0;

        for (const osc of activeOscs) {
            const data = osc.getValueAt(targetIdx, this.dataStore, this.isDarkTheme, this.axisTextColor);

            let pair: { title: Text; val: Text };
            if (pairIdx < this.oscHeaderPairPool.length) {
                pair = this.oscHeaderPairPool[pairIdx];
            } else {
                pair = {
                    title: new Text({ text: '', style: { fontFamily: 'sans-serif', fontSize: 11, fontWeight: 'bold' } }),
                    val: new Text({ text: '', style: { fontFamily: 'sans-serif', fontSize: 11, fontWeight: '600' } })
                };
                this.oscHeaderPairPool.push(pair);
                this.oscHeaderContainer.addChild(pair.title);
                this.oscHeaderContainer.addChild(pair.val);
            }

            pair.title.text = data.label + '  ';
            pair.title.style.fill = this.axisTextColor;
            pair.title.alpha = 0.8;
            pair.title.x = 10;
            pair.title.y = currentOscY + 6;
            pair.title.visible = true;

            pair.val.text = data.valueStr;
            pair.val.style.fill = data.valueColor;
            pair.val.x = 10 + pair.title.width;
            pair.val.y = currentOscY + 6;
            pair.val.visible = true;

            pairIdx++;
            currentOscY += 80;
        }

        for (let i = pairIdx; i < this.oscHeaderPairPool.length; i++) {
            this.oscHeaderPairPool[i].title.visible = false;
            this.oscHeaderPairPool[i].val.visible = false;
        }
    }

    public timeToLogicalIndex(time: number): number {
        if (this.dataStore.length === 0) return 0;
        const firstTime = this.dataStore.data[0];
        const lastIdx = this.dataStore.length - 1;
        const lastTime = this.dataStore.data[lastIdx * 6];
        const interval = this.parseIntervalMs(this.currentInterval);

        if (time <= firstTime) return (time - firstTime) / interval;
        if (time >= lastTime) return lastIdx + (time - lastTime) / interval;

        let low = 0, high = lastIdx;
        while (low <= high) {
            const mid = Math.floor((low + high) / 2);
            const t = this.dataStore.data[mid * 6];
            if (t === time) return mid;
            if (t < time) low = mid + 1;
            else high = mid - 1;
        }
        return low;
    }

    public logicalIndexToTime(idx: number): number {
        if (this.dataStore.length === 0) return 0;
        const lastIdx = this.dataStore.length - 1;
        const interval = this.parseIntervalMs(this.currentInterval);
        if (idx < 0) return this.dataStore.data[0] + (idx * interval);
        if (idx > lastIdx) return this.dataStore.data[lastIdx * 6] + ((idx - lastIdx) * interval);
        return this.dataStore.data[Math.floor(idx) * 6];
    }

    public xToTime(x: number): number {
        const actualSpacing = this.candleSpacing * this.zoom;
        return this.logicalIndexToTime((x + this.cameraX) / actualSpacing);
    }

    public timeToX(time: number): number {
        const actualSpacing = this.candleSpacing * this.zoom;
        return (this.timeToLogicalIndex(time) * actualSpacing) - this.cameraX;
    }

    public yToPrice(y: number): number {
        const mainChartHeight = this.app.screen.height - this.timeAxisHeight - this.oscHeight;
        const norm = (mainChartHeight - (y - this.cameraY)) / mainChartHeight;
        return this.currentMinPrice + (norm * (this.currentMaxPrice - this.currentMinPrice));
    }

    public priceToY(price: number): number {
        const mainChartHeight = this.app.screen.height - this.timeAxisHeight - this.oscHeight;
        const norm = (price - this.currentMinPrice) / (this.currentMaxPrice - this.currentMinPrice);
        return mainChartHeight - (norm * mainChartHeight) + this.cameraY;
    }

    public getMagnetPoint(screenX: number, screenY: number, thresholdPx = 15): { time: number; price: number } {
        const time = this.xToTime(screenX);
        const rawPrice = this.yToPrice(screenY);
        const actualSpacing = this.candleSpacing * this.zoom;
        const logicalIdx = Math.round((screenX + this.cameraX) / actualSpacing);
        
        if (logicalIdx >= 0 && logicalIdx < this.dataStore.length) {
            const base = logicalIdx * 6;
            const prices = [this.dataStore.data[base + 1], this.dataStore.data[base + 2], this.dataStore.data[base + 3], this.dataStore.data[base + 4]];
            let closestPrice = rawPrice, minPixelDist = Infinity;

            for (const p of prices) {
                const dist = Math.abs(this.priceToY(p) - screenY);
                if (dist < minPixelDist) { minPixelDist = dist; closestPrice = p; }
            }
            if (minPixelDist <= thresholdPx) return { time: this.dataStore.data[base], price: closestPrice };
        }
        return { time, price: rawPrice };
    }

    public destroy() {
        if (this.app) {
            this.app.destroy(true, { children: true, texture: true });
        }
    }
}