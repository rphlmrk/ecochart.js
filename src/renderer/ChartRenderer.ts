import { Application, Graphics, BitmapText, BitmapFont, Container, Buffer, BufferUsage, Geometry, Mesh, Shader, UniformGroup } from 'pixi.js';
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

    // Session Config (Color + Alpha)
    public sessionConfig = {
        enabled: true,
        showOnAxis: true,
        showOnChart: false,
        asiaColor: 0xFBC02D,
        asiaAlpha: 0.5,
        londonColor: 0x2962FF,
        londonAlpha: 0.5,
        nyColor: 0xEF5350,
        nyAlpha: 0.5
    };

    // Timezone Clock Config
    public clockConfig = {
        enabled: true,
        primaryTz: 'America/New_York',
        primaryLabel: 'NYC',
        secondaryTz: 'Europe/London',
        secondaryLabel: 'LON'
    };
    private clock1BadgeText!: BitmapText;
    private clock2BadgeText!: BitmapText;

    // Pixi Layers (Z-Index order)
    private gridGraphics!: Graphics;
    private gridMesh!: Mesh<Geometry, Shader>;
    private gridGeometry!: Geometry;
    private gridUniforms!: UniformGroup;
    private candlesGraphics!: Graphics;
    private clockGraphics!: Graphics; // Dedicated layer for world clock badges

    // GPU Session Instancing Engine
    private sessionMesh!: Mesh<Geometry, Shader>;
    private sessionGeometry!: Geometry;
    private sessionUniforms!: UniformGroup;
    private sessionBuffer!: Buffer;
    private sessionArray = new Float32Array(0);
    private lastSessionSyncedLength = 0;
    public isSessionDirty = true;

    // GPU Instancing Engine (Single Vector Stamping)
    private candleMesh!: Mesh<Geometry, Shader>;
    private candleGeometry!: Geometry;
    private candleUniforms!: UniformGroup;
    private candleIndexBuffer!: Buffer;
    private candleOHLCBuffer!: Buffer;
    private candleIndexArray = new Float32Array(0);
    private candleOHLCArray = new Float32Array(0);
    private lastSyncedLength = 0;
    private lastSyncedLiveClose = 0;
    private lastSyncedLiveHigh = 0;
    private lastSyncedLiveLow = 0;

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
    private persistentPriceBadgeText!: BitmapText;
    private persistentTimeBadgeText!: BitmapText;
    private livePriceBadgeText!: BitmapText;     // <-- ADDED to fix GC leak
    private liveCountdownBadgeText!: BitmapText; // <-- ADDED to fix GC leak

    // Axis Label Object Pools (Prevents VRAM Memory Leaks during panning)
    private priceLabelPool: BitmapText[] = [];
    private activePriceLabels = 0;
    private timeLabelPool: BitmapText[] = [];
    private activeTimeLabels = 0;

    // Dedicated Sub-Panel Scale
    public oscHeight = 0; // <-- Dynamic stacked oscillator height
    public activeOscillatorScale?: OscillatorScale;
    private oscLabelPool: BitmapText[] = [];
    private activeOscLabels = 0;

    // Oscillator Panel Header Telemetry (Zero GC Pool)
    public indicatorManager?: any;
    private oscHeaderContainer!: Container;
    private oscHeaderPairPool: { title: BitmapText; val: BitmapText }[] = [];

    // GPU Indicator Line Engine
    private indicatorMeshes = new Map<string, any>();

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

    // --- ECO-MODE STATE ---
    public isRenderDirty = true;
    public forceNextRender = true;
    private lastRenderState = { camX: 0, camY: 0, zoom: 0, len: 0, close: 0, high: 0, low: 0, mode: '', w: 0, h: 0, oscH: 0, interval: '' };
    private lastCrosshairState = { x: -100, y: -100, visible: false, w: 0, h: 0, syncTime: null as number | null };

    public applyTheme(theme: ChartTheme) {
        this.forceNextRender = true; // Force redraw on theme change
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
        this.priceLabelPool.forEach(l => l.tint = this.axisTextColor);
        this.timeLabelPool.forEach(l => l.tint = this.axisTextColor);
        this.oscLabelPool.forEach(l => l.tint = this.axisTextColor);
        this.oscHeaderPairPool.forEach(p => p.title.tint = this.axisTextColor);

        this.updateInstancedThemeUniforms(); // <-- Synchronize GPU Colors
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
            autoStart: false, // 🛑 Kill Pixi's continuous 60 FPS auto-loop
            // Optimization: Cap resolution at 2. High-DPI Androids (3x+) choke on heavy Canvas fills
            resolution: Math.min(window.devicePixelRatio || 1, 2),
        });
        this.app.ticker.stop(); // 🛑 Ensure the internal ticker is completely halted

        // GPU BITMAP FONT
        BitmapFont.install({
            name: 'ChartFont',
            style: { fontFamily: 'sans-serif', fontSize: 32, fill: 0xffffff, fontWeight: 'bold' },
            chars: [['a', 'z'], ['A', 'Z'], ['0', '9'], ' .:,;-_=+()!@#$%^&*~`|/\\']
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

        this.initSessionMesh();         // <-- Create GPU Sessions
        this.initGridMesh();            // <-- Create GPU Grid
        this.initInstancedCandleMesh(); // <-- Create GPU Mesh & Shaders

        this.app.stage.addChild(this.gridMesh);     // <-- Add GPU Grid Background
        this.app.stage.addChild(this.sessionMesh);  // <-- Add GPU Sessions
        this.app.stage.addChild(this.gridGraphics);
        this.app.stage.addChild(this.candlesGraphics);
        this.app.stage.addChild(this.candleMesh); // <-- Instanced candles sit here
        this.app.stage.addChild(this.indicatorMainGraphics); // Indicators behind crosshair
        this.app.stage.addChild(this.indicatorOscGraphics);
        this.drawingGraphics = new Graphics();
        this.clockGraphics = new Graphics();
        this.app.stage.addChild(this.drawingGraphics);
        this.app.stage.addChild(this.oscHeaderContainer); // Bottom panel header text
        this.app.stage.addChild(this.uiGraphics);
        this.app.stage.addChild(this.clockGraphics); // Sits on top of time axis without redrawing it
        this.app.stage.addChild(this.textContainer);

        // Crosshairs sit above grid/candles and beneath badges
        this.app.stage.addChild(this.syncCrosshairGraphics);
        this.app.stage.addChild(this.crosshairGraphics);

        this.app.stage.addChild(this.liveBadgeGraphics);
        this.app.stage.addChild(this.liveBadgeText);
        this.app.stage.addChild(this.crosshairBadgeGraphics);
        this.app.stage.addChild(this.crosshairBadgeText);

        // Pre-allocate persistent crosshair labels once using GPU Font
        this.persistentPriceBadgeText = new BitmapText({ text: '', style: { fontFamily: 'ChartFont', fontSize: 11 } });
        this.persistentTimeBadgeText = new BitmapText({ text: '', style: { fontFamily: 'ChartFont', fontSize: 11 } });

        this.clock1BadgeText = new BitmapText({ text: '', style: { fontFamily: 'ChartFont', fontSize: 10 } });
        this.clock2BadgeText = new BitmapText({ text: '', style: { fontFamily: 'ChartFont', fontSize: 10 } });

        this.livePriceBadgeText = new BitmapText({ text: '', style: { fontFamily: 'ChartFont', fontSize: 11 } });
        this.liveCountdownBadgeText = new BitmapText({ text: '', style: { fontFamily: 'ChartFont', fontSize: 11 } });

        this.liveBadgeText.addChild(this.livePriceBadgeText);
        this.liveBadgeText.addChild(this.liveCountdownBadgeText);
        this.clock1BadgeText.visible = false;
        this.clock2BadgeText.visible = false;
        this.textContainer.addChild(this.clock1BadgeText);
        this.textContainer.addChild(this.clock2BadgeText);

        this.persistentPriceBadgeText.visible = false;
        this.persistentTimeBadgeText.visible = false;

        this.crosshairBadgeText.addChild(this.persistentPriceBadgeText);
        this.crosshairBadgeText.addChild(this.persistentTimeBadgeText);
    }

    public renderFrame() {
        if (!this.candlesGraphics || this.dataStore.length === 0) return;

        // --- ECO-MODE: Thermal Throttling (Prevents device heating) ---
        const len = this.dataStore.length;
        const lastBase = (len - 1) * 6;
        const liveC = this.dataStore.data[lastBase + 4];
        const liveH = this.dataStore.data[lastBase + 2];
        const liveL = this.dataStore.data[lastBase + 3];
        const width = this.app.screen.width;
        const height = this.app.screen.height;

        if (
            !this.forceNextRender &&
            this.lastRenderState.camX === this.cameraX &&
            this.lastRenderState.camY === this.cameraY &&
            this.lastRenderState.zoom === this.zoom &&
            this.lastRenderState.len === len &&
            this.lastRenderState.close === liveC &&
            this.lastRenderState.high === liveH &&
            this.lastRenderState.low === liveL &&
            this.lastRenderState.mode === this.chartMode &&
            this.lastRenderState.w === width &&
            this.lastRenderState.h === height &&
            this.lastRenderState.oscH === this.oscHeight &&
            this.lastRenderState.interval === this.currentInterval
        ) {
            this.isRenderDirty = false;
            return; // 🛑 ABORT: Nothing changed on screen. Skip heavy CPU math!
        }

        this.isRenderDirty = true;
        this.forceNextRender = false;
        this.lastRenderState = {
            camX: this.cameraX, camY: this.cameraY, zoom: this.zoom,
            len: len, close: liveC, high: liveH, low: liveL,
            mode: this.chartMode, w: width, h: height,
            oscH: this.oscHeight, interval: this.currentInterval
        };
        // --- END ECO-MODE ---

        this.candlesGraphics.clear();
        this.gridGraphics.clear();
        this.uiGraphics.clear();
        this.liveBadgeGraphics.clear();
        this.indicatorMainGraphics.clear();
        this.indicatorOscGraphics.clear();

        // Reset pooled axis label counters without tearing down the reused WebGL textures
        this.activePriceLabels = 0;
        this.activeTimeLabels = 0;
        this.activeOscLabels = 0;

        // Layout Constants
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

        // CPU Optimization: Pre-calculate Y-axis ratio to avoid division in hot loops
        const priceRange = this.currentMaxPrice - this.currentMinPrice || 1;
        const yRatio = mainChartHeight / priceRange;
        const yOffset = mainChartHeight + this.cameraY;

        const priceToY = (price: number) => {
            return yOffset - ((price - this.currentMinPrice) * yRatio);
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

            let textLabel: BitmapText;
            if (this.activePriceLabels < this.priceLabelPool.length) {
                textLabel = this.priceLabelPool[this.activePriceLabels];
                const newText = p.toFixed(2);
                if (textLabel.text !== newText) textLabel.text = newText;
            } else {
                textLabel = new BitmapText({ text: p.toFixed(2), style: { fontFamily: 'ChartFont', fontSize: 11 } });
                this.priceLabelPool.push(textLabel);
                this.textContainer.addChild(textLabel);
            }
            textLabel.tint = this.axisTextColor;

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

            const ts = this.dataStore.data[i * 6];
            if (ts) {
                const date = new Date(ts);
                const timeStr = `${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}:${date.getSeconds().toString().padStart(2, '0')}`;

                let textLabel: BitmapText;
                if (this.activeTimeLabels < this.timeLabelPool.length) {
                    textLabel = this.timeLabelPool[this.activeTimeLabels];
                    if (textLabel.text !== timeStr) textLabel.text = timeStr;
                } else {
                    textLabel = new BitmapText({ text: timeStr, style: { fontFamily: 'ChartFont', fontSize: 11 } });
                    textLabel.anchor.x = 0.5;
                    this.timeLabelPool.push(textLabel);
                    this.textContainer.addChild(textLabel);
                }
                textLabel.tint = this.axisTextColor;

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

        // --- 1.8 UPDATE GPU GRID ---
        const gu = this.gridUniforms.uniforms;
        gu.uChartSize = [chartWidth, timeAxisY];
        gu.uMainChartHeight = mainChartHeight;
        gu.uCameraX = this.cameraX;
        gu.uCameraY = this.cameraY;
        gu.uZoom = this.zoom;
        gu.uCandleSpacing = this.candleSpacing;
        gu.uMinPrice = this.currentMinPrice;
        gu.uMaxPrice = this.currentMaxPrice;
        gu.uPriceStep = step;
        gu.uCandleStep = candleStep;
        gu.uGridThickness = this.gridThickness;
        gu.uGridStyle = this.gridStyle === 'solid' ? 0.0 : 1.0;
        this.gridUniforms.update(); // <-- FLUSH TO GPU

        // --- 2. MULTI-MODE CHART DRAWING (OPTIMIZED BATCHING) ---
        const candleWidth = Math.max(1, actualSpacing * 0.8);

        this.candleMesh.visible = (this.chartMode === 'candles');

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

            this.candlesGraphics.beginPath();
            for (let i = visStart; i < visEnd; i++) {
                const base = i * 6;
                const o = this.dataStore.data[base + 1], h = this.dataStore.data[base + 2], l = this.dataStore.data[base + 3], c = this.dataStore.data[base + 4];
                if (c >= o) {
                    const x = (i * actualSpacing) - this.cameraX, xMid = x + (candleWidth / 2);
                    const yH = priceToY(h), yL = priceToY(l), yO = priceToY(o), yC = priceToY(c);
                    this.candlesGraphics.rect(xMid - (spineWidth / 2), yH, spineWidth, Math.max(1, yL - yH));
                    this.candlesGraphics.rect(x, yO - (spineWidth / 2), tickWidth, spineWidth);
                    this.candlesGraphics.rect(xMid, yC - (spineWidth / 2), tickWidth, spineWidth);
                }
            }
            this.candlesGraphics.fill({ color: this.bullColor, alpha: this.bullAlpha });

            this.candlesGraphics.beginPath();
            for (let i = visStart; i < visEnd; i++) {
                const base = i * 6;
                const o = this.dataStore.data[base + 1], h = this.dataStore.data[base + 2], l = this.dataStore.data[base + 3], c = this.dataStore.data[base + 4];
                if (c < o) {
                    const x = (i * actualSpacing) - this.cameraX, xMid = x + (candleWidth / 2);
                    const yH = priceToY(h), yL = priceToY(l), yO = priceToY(o), yC = priceToY(c);
                    this.candlesGraphics.rect(xMid - (spineWidth / 2), yH, spineWidth, Math.max(1, yL - yH));
                    this.candlesGraphics.rect(x, yO - (spineWidth / 2), tickWidth, spineWidth);
                    this.candlesGraphics.rect(xMid, yC - (spineWidth / 2), tickWidth, spineWidth);
                }
            }
            this.candlesGraphics.fill({ color: this.bearColor, alpha: this.bearAlpha });

        } else if (this.chartMode === 'heikinAshi') {
            // Pre-calculate HA values
            const haData: { haO: number, haH: number, haL: number, haC: number }[] = new Array(visEnd);
            let prevHaOpen = (this.dataStore.data[1] + this.dataStore.data[4]) / 2;
            let prevHaClose = (this.dataStore.data[1] + this.dataStore.data[2] + this.dataStore.data[3] + this.dataStore.data[4]) / 4;

            for (let i = 0; i < visEnd; i++) {
                const base = i * 6;
                const o = this.dataStore.data[base + 1], h = this.dataStore.data[base + 2], l = this.dataStore.data[base + 3], c = this.dataStore.data[base + 4];
                const haClose = (o + h + l + c) / 4;
                const haOpen = i === 0 ? prevHaOpen : (prevHaOpen + prevHaClose) / 2;
                if (i >= visStart) haData[i] = { haO: haOpen, haH: Math.max(h, haOpen, haClose), haL: Math.min(l, haOpen, haClose), haC: haClose };
                prevHaOpen = haOpen; prevHaClose = haClose;
            }

            // Draw Bull
            this.candlesGraphics.beginPath();
            for (let i = visStart; i < visEnd; i++) {
                const d = haData[i];
                if (d.haC >= d.haO) {
                    const x = (i * actualSpacing) - this.cameraX, yH = priceToY(d.haH), yL = priceToY(d.haL);
                    this.candlesGraphics.rect(x + (candleWidth / 2) - 0.5, yH, 1, Math.max(1, yL - yH));
                }
            }
            this.candlesGraphics.fill({ color: this.bullWickColor, alpha: this.bullWickAlpha });

            this.candlesGraphics.beginPath();
            for (let i = visStart; i < visEnd; i++) {
                const d = haData[i];
                if (d.haC >= d.haO) {
                    const x = (i * actualSpacing) - this.cameraX, yO = priceToY(d.haO), yC = priceToY(d.haC);
                    this.candlesGraphics.rect(x, Math.min(yO, yC), candleWidth, Math.max(1, Math.abs(yO - yC)));
                }
            }
            this.candlesGraphics.fill({ color: this.bullColor, alpha: this.bullAlpha }).stroke({ color: this.bullBorderColor, width: 1, alpha: this.bullBorderAlpha });

            // Draw Bear
            this.candlesGraphics.beginPath();
            for (let i = visStart; i < visEnd; i++) {
                const d = haData[i];
                if (d.haC < d.haO) {
                    const x = (i * actualSpacing) - this.cameraX, yH = priceToY(d.haH), yL = priceToY(d.haL);
                    this.candlesGraphics.rect(x + (candleWidth / 2) - 0.5, yH, 1, Math.max(1, yL - yH));
                }
            }
            this.candlesGraphics.fill({ color: this.bearWickColor, alpha: this.bearWickAlpha });

            this.candlesGraphics.beginPath();
            for (let i = visStart; i < visEnd; i++) {
                const d = haData[i];
                if (d.haC < d.haO) {
                    const x = (i * actualSpacing) - this.cameraX, yO = priceToY(d.haO), yC = priceToY(d.haC);
                    this.candlesGraphics.rect(x, Math.min(yO, yC), candleWidth, Math.max(1, Math.abs(yO - yC)));
                }
            }
            this.candlesGraphics.fill({ color: this.bearColor, alpha: this.bearAlpha }).stroke({ color: this.bearBorderColor, width: 1, alpha: this.bearBorderAlpha });

        } else {
            // GPU INSTANCED CANDLES (Approach 2)
            this.renderInstancedCandles(mainChartHeight, visStart, visEnd);
        }

        // --- 3. DRAW AXIS BACKGROUNDS & DIVIDERS ---
        this.uiGraphics.rect(chartWidth, 0, this.priceAxisWidth, height).fill(this.axisBgColor);
        this.uiGraphics.moveTo(chartWidth, 0).lineTo(chartWidth, height).stroke({ color: this.gridColor, width: 1 });

        // Draw Time Axis at bottom
        this.uiGraphics.rect(0, timeAxisY, width, this.timeAxisHeight).fill(this.axisBgColor);
        this.uiGraphics.moveTo(0, timeAxisY).lineTo(width, timeAxisY).stroke({ color: this.gridColor, width: 1 });

        // --- 3.5 DRAW MARKET SESSION HIGHLIGHTS (GPU) ---
        this.renderInstancedSessions(mainChartHeight, timeAxisY, width, height, visStart, visEnd);

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
                    let textLabel: BitmapText;
                    if (this.activeOscLabels < this.oscLabelPool.length) {
                        textLabel = this.oscLabelPool[this.activeOscLabels];
                        if (textLabel.text !== labelText) textLabel.text = labelText;
                    } else {
                        textLabel = new BitmapText({
                            text: labelText,
                            style: { fontFamily: 'ChartFont', fontSize: 10 }
                        });
                        this.oscLabelPool.push(textLabel);
                        this.textContainer.addChild(textLabel);
                    }
                    textLabel.tint = this.axisTextColor;

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

        // --- 3.8 UPDATE WORLD TIMEZONE CLOCKS & COUNTDOWN ---
        this.updateTimeAndCountdown();

        // --- 4. DRAW LIVE PRICE LINE & COUNTDOWN BADGE ---
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

            this.livePriceBadgeText.text = lastClose.toFixed(2);
            this.livePriceBadgeText.tint = badgeTextColor;
            this.livePriceBadgeText.x = chartWidth + 5;
            this.livePriceBadgeText.y = badgeY + 3;

            this.liveCountdownBadgeText.text = countdownStr;
            this.liveCountdownBadgeText.tint = badgeTextColor;
            this.liveCountdownBadgeText.alpha = 0.9;
            this.liveCountdownBadgeText.x = chartWidth + 5;
            this.liveCountdownBadgeText.y = badgeY + 18;
        }

        // Render Title & Live/Historical Telemetry for Bottom Panels
        this.updateOscillatorHeaders();
    }

    /**
     * Isolated sub-renderer: updates only the world clocks and countdown timer
     * without redrawing the chart, grid, sessions, or indicator math.
     */
    public updateTimeAndCountdown() {
        if (!this.clockGraphics || this.dataStore.length === 0) return;

        const width = this.app.screen.width;
        const height = this.app.screen.height;
        const chartWidth = width - this.priceAxisWidth;
        const timeAxisY = height - this.timeAxisHeight;
        const actualSpacing = this.candleSpacing * this.zoom;

        const lastIdx = this.dataStore.length - 1;
        const lastBase = lastIdx * 6;
        const lastTime = this.dataStore.data[lastBase];

        // 1. Update Candle Countdown Text
        if (this.liveCountdownBadgeText && this.liveCountdownBadgeText.visible) {
            const intervalMs = this.parseIntervalMs(this.currentInterval);
            const remainingMs = Math.max(0, (lastTime + intervalMs) - Date.now());
            const totalSeconds = Math.floor(remainingMs / 1000);
            const hours = Math.floor(totalSeconds / 3600);
            const mins = Math.floor((totalSeconds % 3600) / 60);
            const secs = totalSeconds % 60;

            let countdownStr = `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
            if (hours > 0) countdownStr = `${hours}:${countdownStr}`;
            if (this.liveCountdownBadgeText.text !== countdownStr) {
                this.liveCountdownBadgeText.text = countdownStr;
            }
        }

        // 2. Update World Clocks on Time Axis
        this.clockGraphics.clear();
        if (this.clock1BadgeText) this.clock1BadgeText.visible = false;
        if (this.clock2BadgeText) this.clock2BadgeText.visible = false;

        if (this.clockConfig.enabled && this.dataStore.length > 0) {
            const lastCandleX = (lastIdx * actualSpacing) - this.cameraX + actualSpacing;
            const availableSpace = chartWidth - lastCandleX;

            if (availableSpace >= 100) {
                const now = new Date();
                const isMobile = width < 768 || availableSpace < 220;

                const formatTime = (tz: string) => {
                    try {
                        const opt: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false };
                        if (tz !== 'local') opt.timeZone = tz;
                        return new Intl.DateTimeFormat([], opt).format(now);
                    } catch {
                        return '--:--:--';
                    }
                };

                const getSessionStatus = (tz: string) => {
                    try {
                        const parts = new Intl.DateTimeFormat('en-US', {
                            timeZone: tz === 'local' ? undefined : tz,
                            hour: 'numeric', minute: 'numeric', hour12: false
                        }).formatToParts(now);

                        const h = parseInt(parts.find(p => p.type === 'hour')?.value || '0', 10);
                        const m = parseInt(parts.find(p => p.type === 'minute')?.value || '0', 10);
                        const t = h + (m / 60);

                        let isOpening = false;
                        let isOpen = false;

                        if (tz === 'America/New_York') {
                            isOpening = (t >= 9.5 && t < 10.5);
                            isOpen = (t >= 9.5 && t < 16.0);
                        } else if (tz === 'Europe/London') {
                            isOpening = (t >= 8.0 && t < 9.0);
                            isOpen = (t >= 8.0 && t < 16.5);
                        } else if (tz === 'Asia/Tokyo') {
                            isOpening = (t >= 9.0 && t < 10.0);
                            isOpen = (t >= 9.0 && t < 15.0);
                        } else if (tz === 'Asia/Hong_Kong') {
                            isOpening = (t >= 9.5 && t < 10.5);
                            isOpen = (t >= 9.5 && t < 16.0);
                        } else if (tz === 'Europe/Frankfurt') {
                            isOpening = (t >= 8.0 && t < 9.0);
                            isOpen = (t >= 8.0 && t < 16.5);
                        } else {
                            isOpening = (t >= 8.0 && t < 9.5);
                            isOpen = (t >= 8.0 && t < 17.0);
                        }

                        if (isOpening) {
                            return { icon: '🔔', textColor: 0xFFD600, borderColor: 0xFFD600, borderWidth: 1.5 };
                        } else if (isOpen) {
                            return { icon: '🟢', textColor: 0x26A69A, borderColor: 0x26A69A, borderWidth: 1.5 };
                        } else {
                            return { icon: '🌙', textColor: this.axisTextColor, borderColor: this.gridColor, borderWidth: 1 };
                        }
                    } catch {
                        return { icon: '', textColor: this.axisTextColor, borderColor: this.gridColor, borderWidth: 1 };
                    }
                };

                const badgeH = 18;
                const badgeY = timeAxisY + Math.floor((this.timeAxisHeight - badgeH) / 2);
                let rightAnchor = chartWidth - 8;

                // Clock 1 (Primary)
                const st1 = getSessionStatus(this.clockConfig.primaryTz);
                const timeStr1 = `${st1.icon} ${this.clockConfig.primaryLabel} ${formatTime(this.clockConfig.primaryTz)}`;
                this.clock1BadgeText.text = timeStr1;
                this.clock1BadgeText.tint = st1.textColor;
                const badgeW1 = Math.ceil(this.clock1BadgeText.width) + 12;
                const badgeX1 = rightAnchor - badgeW1;

                if (badgeX1 > lastCandleX + 8) {
                    this.clockGraphics.roundRect(badgeX1, badgeY, badgeW1, badgeH, 3)
                        .fill({ color: this.axisBgColor, alpha: 0.95 })
                        .stroke({ color: st1.borderColor, width: st1.borderWidth, alpha: 0.9 });

                    this.clock1BadgeText.x = badgeX1 + 6;
                    this.clock1BadgeText.y = badgeY + 2;
                    this.clock1BadgeText.visible = true;
                    rightAnchor = badgeX1 - 6;

                    // Clock 2 (Secondary)
                    if (!isMobile && this.clockConfig.secondaryTz) {
                        const st2 = getSessionStatus(this.clockConfig.secondaryTz);
                        const timeStr2 = `${st2.icon} ${this.clockConfig.secondaryLabel} ${formatTime(this.clockConfig.secondaryTz)}`;
                        this.clock2BadgeText.text = timeStr2;
                        this.clock2BadgeText.tint = st2.textColor;
                        const badgeW2 = Math.ceil(this.clock2BadgeText.width) + 12;
                        const badgeX2 = rightAnchor - badgeW2;

                        if (badgeX2 > lastCandleX + 8) {
                            this.clockGraphics.roundRect(badgeX2, badgeY, badgeW2, badgeH, 3)
                                .fill({ color: this.axisBgColor, alpha: 0.95 })
                                .stroke({ color: st2.borderColor, width: st2.borderWidth, alpha: 0.9 });

                            this.clock2BadgeText.x = badgeX2 + 6;
                            this.clock2BadgeText.y = badgeY + 2;
                            this.clock2BadgeText.visible = true;
                        }
                    }
                }
            }
        }
        this.render(); // Submit 1 isolated frame to display the new second
    }

    public renderCrosshair() {
        if (!this.crosshairGraphics || !this.syncCrosshairGraphics) return;

        const width = this.app.screen.width;
        const height = this.app.screen.height;

        // --- ECO-MODE: Crosshair Throttling ---
        if (
            !this.isRenderDirty && // Force sync if main chart moved
            this.lastCrosshairState.x === this.crosshairX &&
            this.lastCrosshairState.y === this.crosshairY &&
            this.lastCrosshairState.visible === this.isCrosshairVisible &&
            this.lastCrosshairState.w === width &&
            this.lastCrosshairState.h === height &&
            this.lastCrosshairState.syncTime === this.syncHoverTimeMs
        ) {
            return; // 🛑 ABORT: Crosshair hasn't moved!
        }

        this.lastCrosshairState = {
            x: this.crosshairX, y: this.crosshairY,
            visible: this.isCrosshairVisible,
            w: width, h: height, syncTime: this.syncHoverTimeMs
        };
        // --- END ECO-MODE ---

        this.crosshairGraphics.clear();
        this.syncCrosshairGraphics.clear();
        this.crosshairBadgeGraphics.clear();

        this.persistentPriceBadgeText.visible = false;
        this.persistentTimeBadgeText.visible = false;
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

            let pair: { title: BitmapText; val: BitmapText };
            if (pairIdx < this.oscHeaderPairPool.length) {
                pair = this.oscHeaderPairPool[pairIdx];
            } else {
                pair = {
                    title: new BitmapText({ text: '', style: { fontFamily: 'ChartFont', fontSize: 11 } }),
                    val: new BitmapText({ text: '', style: { fontFamily: 'ChartFont', fontSize: 11 } })
                };
                this.oscHeaderPairPool.push(pair);
                this.oscHeaderContainer.addChild(pair.title);
                this.oscHeaderContainer.addChild(pair.val);
            }

            pair.title.text = data.label + '  ';
            pair.title.tint = this.axisTextColor;
            pair.title.alpha = 0.8;
            pair.title.x = 10;
            pair.title.y = currentOscY + 6;
            pair.title.visible = true;

            pair.val.text = data.valueStr;
            pair.val.tint = data.valueColor;
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

    /**
     * Dispatches an explicit on-demand draw call to the GPU.
     */
    public render() {
        if (this.app && this.app.renderer) {
            this.app.render();
        }
    }

    public destroy() {
        if (this.app) {
            this.app.destroy(true, { children: true, texture: true });
        }
    }

    private initGridMesh() {
        const gridVertices = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]);
        const gridIndices = new Uint32Array([0, 1, 2, 0, 2, 3]);

        this.gridGeometry = new Geometry({
            attributes: {
                aVertexPosition: {
                    buffer: new Buffer({ data: gridVertices, usage: BufferUsage.VERTEX }),
                    format: 'float32x2'
                }
            },
            indexBuffer: gridIndices
        });

        this.gridUniforms = new UniformGroup({
            uChartSize: { value: [0, 0], type: 'vec2<f32>' },
            uMainChartHeight: { value: 0, type: 'f32' },
            uCameraX: { value: 0, type: 'f32' },
            uCameraY: { value: 0, type: 'f32' },
            uZoom: { value: 1, type: 'f32' },
            uCandleSpacing: { value: 8, type: 'f32' },
            uMinPrice: { value: 0, type: 'f32' },
            uMaxPrice: { value: 1, type: 'f32' },
            uPriceStep: { value: 1, type: 'f32' },
            uCandleStep: { value: 1, type: 'f32' },
            uGridColor: { value: [0.16, 0.18, 0.22, 1.0], type: 'vec4<f32>' },
            uGridThickness: { value: 1.0, type: 'f32' },
            uGridStyle: { value: 0.0, type: 'f32' } // 0.0 = solid, 1.0 = dashed
        });

        const vertexSrc = `
            precision highp float;
            attribute vec2 aVertexPosition;
            uniform vec2 uChartSize;
            uniform mat3 uProjectionMatrix;
            uniform mat3 uWorldTransformMatrix;
            varying vec2 vUv;
            void main() {
                vUv = aVertexPosition;
                vec2 pos = aVertexPosition * uChartSize;
                mat3 mvp = uProjectionMatrix * uWorldTransformMatrix;
                gl_Position = vec4((mvp * vec3(pos, 1.0)).xy, 0.0, 1.0);
            }
        `;

        const fragmentSrc = `
            precision highp float;
            varying vec2 vUv;
            
            uniform vec2 uChartSize;
            uniform float uMainChartHeight;
            uniform float uCameraX;
            uniform float uCameraY;
            uniform float uZoom;
            uniform float uCandleSpacing;
            uniform float uMinPrice;
            uniform float uMaxPrice;
            uniform float uPriceStep;
            uniform float uCandleStep;
            uniform vec4 uGridColor;
            uniform float uGridThickness;
            uniform float uGridStyle;

            void main() {
                vec2 pixel = vUv * uChartSize;
                float px = pixel.x;
                float py = pixel.y;

                float alpha = 0.0;
                float halfThick = max(0.5, uGridThickness * 0.5);

                // --- 1. Vertical Lines (Time Axis) ---
                float actualSpacing = uCandleSpacing * uZoom;
                float xWorld = px + uCameraX;
                float closestI = floor(xWorld / actualSpacing + 0.5);
                if (mod(closestI, uCandleStep) == 0.0) {
                    float lineX = (closestI * actualSpacing) - uCameraX;
                    if (abs(px - lineX) <= halfThick) {
                        if (uGridStyle < 0.5 || mod(py, 8.0) < 4.0) alpha = 1.0;
                    }
                }

                // --- 2. Horizontal Lines (Price Axis) ---
                if (py <= uMainChartHeight) {
                    float priceRange = max(0.000001, uMaxPrice - uMinPrice);
                    float yRatio = uMainChartHeight / priceRange;
                    float yWorld = uMainChartHeight + uCameraY - py;
                    float price = uMinPrice + (yWorld / yRatio);
                    
                    float closestP = floor(price / uPriceStep + 0.5) * uPriceStep;
                    float lineY = uMainChartHeight + uCameraY - ((closestP - uMinPrice) * yRatio);
                    
                    if (abs(py - lineY) <= halfThick) {
                        if (uGridStyle < 0.5 || mod(px, 8.0) < 4.0) alpha = 1.0;
                    }
                }

                if (alpha == 0.0) discard; // Zero-cost empty pixels
                gl_FragColor = uGridColor * alpha;
            }
        `;

        const shader = Shader.from({
            gl: { vertex: vertexSrc, fragment: fragmentSrc },
            resources: { gridUniforms: this.gridUniforms }
        });

        this.gridMesh = new Mesh({ geometry: this.gridGeometry, shader });
    }

    private initInstancedCandleMesh() {
        // 1. Base Geometry: 8 vertices forming 2 quads (Wick + Body)
        const baseVertices = new Float32Array([
            -0.5, 0.0, 0.0, 0.5, 0.0, 0.0, 0.5, 1.0, 0.0, -0.5, 1.0, 0.0, // Wick Quad
            -0.5, 0.0, 1.0, 0.5, 0.0, 1.0, 0.5, 1.0, 1.0, -0.5, 1.0, 1.0  // Body Quad
        ]);
        const baseIndices = new Uint32Array([
            0, 1, 2, 0, 2, 3, // Wick Triangles
            4, 5, 6, 4, 6, 7  // Body Triangles
        ]);

        this.candleIndexBuffer = new Buffer({
            data: new Float32Array(0),
            usage: BufferUsage.VERTEX | BufferUsage.COPY_DST
        });
        this.candleOHLCBuffer = new Buffer({
            data: new Float32Array(0),
            usage: BufferUsage.VERTEX | BufferUsage.COPY_DST
        });

        this.candleGeometry = new Geometry({
            attributes: {
                aVertexPosition: {
                    buffer: new Buffer({
                        data: baseVertices,
                        usage: BufferUsage.VERTEX
                    }),
                    format: 'float32x3'
                },
                aCandleIndex: {
                    buffer: this.candleIndexBuffer,
                    format: 'float32',
                    instance: true
                },
                aCandleOHLC: {
                    buffer: this.candleOHLCBuffer,
                    format: 'float32x4', // Open, High, Low, Close
                    instance: true
                }
            },
            indexBuffer: baseIndices,
            instanceCount: 0
        });

        // 2. Uniforms Group
        this.candleUniforms = new UniformGroup({
            uCameraX: { value: 0, type: 'f32' },
            uCameraY: { value: 0, type: 'f32' },
            uZoom: { value: 1, type: 'f32' },
            uCandleSpacing: { value: 8, type: 'f32' },
            uMinPrice: { value: 0, type: 'f32' },
            uMaxPrice: { value: 1, type: 'f32' },
            uChartHeight: { value: 500, type: 'f32' },
            uVisStart: { value: 0, type: 'f32' },
            uVisEnd: { value: 10000, type: 'f32' },
            uBullBodyColor: { value: [0.15, 0.65, 0.60, 1.0], type: 'vec4<f32>' },
            uBearBodyColor: { value: [0.94, 0.33, 0.31, 1.0], type: 'vec4<f32>' },
            uBullWickColor: { value: [0.15, 0.65, 0.60, 1.0], type: 'vec4<f32>' },
            uBearWickColor: { value: [0.94, 0.33, 0.31, 1.0], type: 'vec4<f32>' }
        });

        // 3. GLSL Vertex & Fragment Shaders
        const vertexSrc = `
            precision highp float;
            attribute vec3 aVertexPosition;
            attribute float aCandleIndex;
            attribute vec4 aCandleOHLC; // Open, High, Low, Close

            uniform mat3 uProjectionMatrix;
            uniform mat3 uWorldTransformMatrix;

            uniform float uCameraX;
            uniform float uCameraY;
            uniform float uZoom;
            uniform float uCandleSpacing;
            uniform float uMinPrice;
            uniform float uMaxPrice;
            uniform float uChartHeight;
            uniform float uVisStart;
            uniform float uVisEnd;

            uniform vec4 uBullBodyColor;
            uniform vec4 uBearBodyColor;
            uniform vec4 uBullWickColor;
            uniform vec4 uBearWickColor;

            varying vec4 vColor;
            varying float vY; // Removed strict highp requirement

            void main() {
                // Instantly discard geometry outside the visible camera view
                if (aCandleIndex < uVisStart || aCandleIndex > uVisEnd) {
                    gl_Position = vec4(0.0);
                    return;
                }

                float openP  = aCandleOHLC.x;
                float highP  = aCandleOHLC.y;
                float lowP   = aCandleOHLC.z;
                float closeP = aCandleOHLC.w;
                
                bool isBull = closeP >= openP;
                
                float actualSpacing = uCandleSpacing * uZoom;
                float candleWidth = max(1.0, actualSpacing * 0.8);
                float centerX = (aCandleIndex * actualSpacing) - uCameraX + (candleWidth * 0.5);
                
                float priceRange = max(0.000001, uMaxPrice - uMinPrice);
                float yRatio = uChartHeight / priceRange;
                float yOffset = uChartHeight + uCameraY;
                
                float topY = 0.0;
                float bottomY = 0.0;
                float w = 1.0;
                
                if (aVertexPosition.z < 0.5) {
                    // Wick Quad
                    topY = yOffset - ((highP - uMinPrice) * yRatio);
                    bottomY = yOffset - ((lowP - uMinPrice) * yRatio);
                    w = 1.0;
                    vColor = isBull ? uBullWickColor : uBearWickColor;
                } else {
                    // Body Quad
                    float maxOC = max(openP, closeP);
                    float minOC = min(openP, closeP);
                    topY = yOffset - ((maxOC - uMinPrice) * yRatio);
                    bottomY = yOffset - ((minOC - uMinPrice) * yRatio);
                    if (bottomY - topY < 1.0) bottomY = topY + 1.0;
                    w = candleWidth;
                    vColor = isBull ? uBullBodyColor : uBearBodyColor;
                }
                
                float posX = centerX + (aVertexPosition.x * w);
                float posY = mix(bottomY, topY, aVertexPosition.y);
                
                vY = posY;

                mat3 mvp = uProjectionMatrix * uWorldTransformMatrix;
                gl_Position = vec4((mvp * vec3(posX, posY, 1.0)).xy, 0.0, 1.0);
            }
        `;

        const fragmentSrc = `
            #ifdef GL_FRAGMENT_PRECISION_HIGH
                precision highp float;
            #else
                precision mediump float;
            #endif

            varying vec4 vColor;
            varying float vY;
            uniform float uChartHeight;

            void main() {
                if (vY > uChartHeight || vY < 0.0) {
                    discard;
                }
                gl_FragColor = vColor;
            }
        `;

        const shader = Shader.from({
            gl: { vertex: vertexSrc, fragment: fragmentSrc },
            resources: { candleUniforms: this.candleUniforms }
        });

        this.candleMesh = new Mesh({ geometry: this.candleGeometry, shader });
        this.updateInstancedThemeUniforms();
    }

    private updateInstancedThemeUniforms() {
        if (!this.candleUniforms) return;
        const toVec4 = (hex: number, alpha: number) => [
            ((hex >> 16) & 0xff) / 255,
            ((hex >> 8) & 0xff) / 255,
            (hex & 0xff) / 255,
            alpha
        ];
        const u = this.candleUniforms.uniforms;
        u.uBullBodyColor = toVec4(this.bullColor, this.bullAlpha);
        u.uBearBodyColor = toVec4(this.bearColor, this.bearAlpha);
        u.uBullWickColor = toVec4(this.bullWickColor, this.bullWickAlpha);
        u.uBearWickColor = toVec4(this.bearWickColor, this.bearWickAlpha);
        this.candleUniforms.update(); // <-- FLUSH TO GPU

        if (this.gridUniforms) {
            this.gridUniforms.uniforms.uGridColor = toVec4(this.gridColor, this.gridAlpha);
            this.gridUniforms.update(); // <-- FLUSH TO GPU
        }
    }

    private syncInstancedData() {
        const len = this.dataStore.length;
        if (len === 0) return;

        const lastIdx = len - 1;
        const lastBase = lastIdx * 6;
        const liveC = this.dataStore.data[lastBase + 4];
        const liveH = this.dataStore.data[lastBase + 2];
        const liveL = this.dataStore.data[lastBase + 3];

        // 1. Capacity Resize
        if (this.candleOHLCArray.length < len * 4) {
            const newCap = Math.max(10000, len * 2);
            this.candleOHLCArray = new Float32Array(newCap * 4);
            this.candleIndexArray = new Float32Array(newCap);

            for (let i = 0; i < len; i++) {
                const b = i * 6;
                const d = i * 4;
                this.candleOHLCArray[d] = this.dataStore.data[b + 1];
                this.candleOHLCArray[d + 1] = this.dataStore.data[b + 2];
                this.candleOHLCArray[d + 2] = this.dataStore.data[b + 3];
                this.candleOHLCArray[d + 3] = this.dataStore.data[b + 4];
                this.candleIndexArray[i] = i;
            }
            this.candleOHLCBuffer.data = this.candleOHLCArray;
            this.candleIndexBuffer.data = this.candleIndexArray;
            this.candleOHLCBuffer.update();
            this.candleIndexBuffer.update();
            this.lastSyncedLength = len;
            this.lastSyncedLiveClose = liveC;
            this.lastSyncedLiveHigh = liveH;
            this.lastSyncedLiveLow = liveL;
            return;
        }

        // 2. Full History Loaded or Prepended
        if (this.lastSyncedLength !== len) {
            for (let i = 0; i < len; i++) {
                const b = i * 6;
                const d = i * 4;
                this.candleOHLCArray[d] = this.dataStore.data[b + 1];
                this.candleOHLCArray[d + 1] = this.dataStore.data[b + 2];
                this.candleOHLCArray[d + 2] = this.dataStore.data[b + 3];
                this.candleOHLCArray[d + 3] = this.dataStore.data[b + 4];
                this.candleIndexArray[i] = i;
            }
            this.candleOHLCBuffer.update();
            this.candleIndexBuffer.update();
            this.lastSyncedLength = len;
            this.lastSyncedLiveClose = liveC;
            this.lastSyncedLiveHigh = liveH;
            this.lastSyncedLiveLow = liveL;
            return;
        }

        // 3. Fast Tick (Only live forming candle changed)
        if (this.lastSyncedLiveClose !== liveC || this.lastSyncedLiveHigh !== liveH || this.lastSyncedLiveLow !== liveL) {
            const d = lastIdx * 4;
            this.candleOHLCArray[d] = this.dataStore.data[lastBase + 1];
            this.candleOHLCArray[d + 1] = liveH;
            this.candleOHLCArray[d + 2] = liveL;
            this.candleOHLCArray[d + 3] = liveC;
            this.candleOHLCBuffer.update();
            this.lastSyncedLiveClose = liveC;
            this.lastSyncedLiveHigh = liveH;
            this.lastSyncedLiveLow = liveL;
        }
    }

    private renderInstancedCandles(mainChartHeight: number, visStart: number, visEnd: number) {
        if (this.dataStore.length === 0) {
            this.candleGeometry.instanceCount = 0;
            return;
        }

        this.syncInstancedData();

        const u = this.candleUniforms.uniforms;
        u.uCameraX = this.cameraX;
        u.uCameraY = this.cameraY;
        u.uZoom = this.zoom;
        u.uCandleSpacing = this.candleSpacing;
        u.uMinPrice = this.currentMinPrice;
        u.uMaxPrice = this.currentMaxPrice;
        u.uChartHeight = mainChartHeight;
        u.uVisStart = visStart;
        u.uVisEnd = visEnd;

        this.candleGeometry.instanceCount = this.dataStore.length;
    }

    public hideAllIndicatorMeshes() {
        for (const entry of this.indicatorMeshes.values()) {
            entry.mesh.visible = false;
        }
    }

    public drawGPUIndicatorLine(
        id: string,
        values: Float64Array,
        color: number,
        width: number,
        isOscillator: boolean,
        layout: any,
        oscScale?: OscillatorScale
    ) {
        let entry = this.indicatorMeshes.get(id);

        // 1. Initialize GPU Mesh exactly once per indicator
        if (!entry) {
            // A simple 1x1 Vector Quad
            const baseVertices = new Float32Array([0, -0.5, 1, -0.5, 1, 0.5, 0, 0.5]);
            const baseIndices = new Uint32Array([0, 1, 2, 0, 2, 3]);
            const instBuffer = new Buffer({ data: new Float32Array(0), usage: BufferUsage.VERTEX | BufferUsage.COPY_DST });

            const geom = new Geometry({
                attributes: {
                    aVertexPosition: { buffer: new Buffer({ data: baseVertices, usage: BufferUsage.VERTEX }), format: 'float32x2' },
                    aLineData: { buffer: instBuffer, format: 'float32x3', instance: true } // [index, valThis, valNext]
                },
                indexBuffer: baseIndices
            });

            const uniforms = new UniformGroup({
                uCameraX: { value: 0, type: 'f32' },
                uCameraY: { value: 0, type: 'f32' },
                uZoom: { value: 1, type: 'f32' },
                uCandleSpacing: { value: 8, type: 'f32' },
                uMinPrice: { value: 0, type: 'f32' },
                uMaxPrice: { value: 1, type: 'f32' },
                uChartHeight: { value: 500, type: 'f32' },
                uColor: { value: [1, 1, 1, 1], type: 'vec4<f32>' },
                uWidth: { value: 2, type: 'f32' },
                uVisStart: { value: 0, type: 'f32' },
                uVisEnd: { value: 10000, type: 'f32' },
                uIsOscillator: { value: 0, type: 'f32' },
                uOscY: { value: 0, type: 'f32' },
                uOscHeight: { value: 100, type: 'f32' },
                uOscMin: { value: 0, type: 'f32' },
                uOscMax: { value: 100, type: 'f32' }
            });

            const vertexSrc = `
                precision highp float;
                attribute vec2 aVertexPosition;
                attribute vec3 aLineData;

                uniform mat3 uProjectionMatrix;
                uniform mat3 uWorldTransformMatrix;

                uniform float uCameraX;
                uniform float uCameraY;
                uniform float uZoom;
                uniform float uCandleSpacing;
                uniform float uMinPrice;
                uniform float uMaxPrice;
                uniform float uChartHeight;
                uniform float uWidth;
                uniform float uVisStart;
                uniform float uVisEnd;

                uniform float uIsOscillator;
                uniform float uOscY;
                uniform float uOscHeight;
                uniform float uOscMin;
                uniform float uOscMax;

                varying float vY; // Removed strict highp requirement

                float getScreenY(float val) {
                    if (uIsOscillator > 0.5) {
                        float norm = (val - uOscMin) / max(0.0001, uOscMax - uOscMin);
                        return uOscY + uOscHeight - (norm * uOscHeight);
                    } else {
                        float priceRange = max(0.000001, uMaxPrice - uMinPrice);
                        float yRatio = uChartHeight / priceRange;
                        float yOffset = uChartHeight + uCameraY;
                        return yOffset - ((val - uMinPrice) * yRatio);
                    }
                }

                void main() {
                    float index = aLineData.x;
                    if (index < uVisStart || index > uVisEnd) {
                        gl_Position = vec4(0.0);
                        return;
                    }

                    float valThis = aLineData.y;
                    float valNext = aLineData.z;
                    
                    if (uIsOscillator < 0.5 && valThis == 0.0 && valNext == 0.0) {
                        gl_Position = vec4(0.0);
                        return;
                    }

                    float actualSpacing = uCandleSpacing * uZoom;
                    
                    vec2 A = vec2((index * actualSpacing) - uCameraX + (actualSpacing * 0.4), getScreenY(valThis));
                    vec2 B = vec2(((index + 1.0) * actualSpacing) - uCameraX + (actualSpacing * 0.4), getScreenY(valNext));

                    vec2 dir = B - A;
                    if (length(dir) < 0.0001) {
                        gl_Position = vec4(0.0);
                        return;
                    }

                    // Dynamically calculate thickness normal
                    vec2 normal = normalize(vec2(-dir.y, dir.x));
                    vec2 pos = A + (dir * aVertexPosition.x) + (normal * aVertexPosition.y * uWidth);

                    vY = pos.y; // <-- ADDED: Assign exact screen Y

                    mat3 mvp = uProjectionMatrix * uWorldTransformMatrix;
                    gl_Position = vec4((mvp * vec3(pos, 1.0)).xy, 0.0, 1.0);
                }
            `;

            const fragmentSrc = `
                #ifdef GL_FRAGMENT_PRECISION_HIGH
                    precision highp float;
                #else
                    precision mediump float;
                #endif

                uniform vec4 uColor;
                uniform float uIsOscillator;
                uniform float uOscY;
                uniform float uOscHeight;
                uniform float uChartHeight;
                varying float vY;

                void main() {
                    if (uIsOscillator > 0.5) {
                        if (vY < uOscY || vY > (uOscY + uOscHeight)) {
                            discard;
                        }
                    } else {
                        if (vY > uChartHeight || vY < 0.0) {
                            discard;
                        }
                    }
                    gl_FragColor = uColor;
                }
            `;

            const shader = Shader.from({
                gl: { vertex: vertexSrc, fragment: fragmentSrc },
                resources: { lineUniforms: uniforms }
            });

            const mesh = new Mesh({ geometry: geom, shader });
            entry = { mesh, uniforms, buffer: instBuffer, array: new Float32Array(0), lastSyncedLength: 0, lastSyncedLiveValue: 0 };
            this.indicatorMeshes.set(id, entry);
        }

        // Add to the correct parent layer so they sit perfectly behind the crosshair
        const parent = isOscillator ? this.indicatorOscGraphics : this.indicatorMainGraphics;
        if (entry.mesh.parent !== parent) {
            parent.addChild(entry.mesh);
        }
        entry.mesh.visible = true;

        // 2. Synchronize Data (Only when new candles form!)
        const len = this.dataStore.length - 1;
        if (len <= 0) {
            entry.mesh.geometry.instanceCount = 0;
            return;
        }

        const liveVal = values[len];
        if (entry.array.length < len * 3 || entry.lastSyncedLength !== len || entry.lastSyncedLiveValue !== liveVal) {
            if (entry.array.length < len * 3) {
                entry.array = new Float32Array(Math.max(10000, len * 2) * 3);
            }
            // Fast loop to pack lines segments
            for (let i = 0; i < len; i++) {
                entry.array[i * 3] = i;
                entry.array[i * 3 + 1] = values[i];
                entry.array[i * 3 + 2] = values[i + 1];
            }
            entry.buffer.data = entry.array;
            entry.buffer.update();
            entry.lastSyncedLength = len;
            entry.lastSyncedLiveValue = liveVal;
        }

        // 3. Update GPU Uniforms
        const u = entry.uniforms.uniforms;
        u.uCameraX = this.cameraX;
        u.uCameraY = this.cameraY;
        u.uZoom = this.zoom;
        u.uCandleSpacing = this.candleSpacing;
        u.uMinPrice = this.currentMinPrice;
        u.uMaxPrice = this.currentMaxPrice;
        u.uChartHeight = layout.mainChartHeight;
        u.uColor = [((color >> 16) & 0xff) / 255, ((color >> 8) & 0xff) / 255, (color & 0xff) / 255, 1.0];
        u.uWidth = width;

        // Frustum Culling bounds
        u.uVisStart = Math.floor(this.cameraX / (this.candleSpacing * this.zoom)) - 2;
        u.uVisEnd = Math.floor((this.cameraX + layout.chartWidth) / (this.candleSpacing * this.zoom)) + 2;

        u.uIsOscillator = isOscillator ? 1.0 : 0.0;
        if (isOscillator && oscScale) {
            u.uOscY = layout.oscY;
            u.uOscHeight = layout.oscHeight;
            u.uOscMin = oscScale.min;
            u.uOscMax = oscScale.max;
        }

        entry.uniforms.update(); // <-- FLUSH TO GPU: Immediately applies new line colors & scale bounds
        entry.mesh.geometry.instanceCount = len;
    }

    private initSessionMesh() {
        const baseVertices = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]);
        const baseIndices = new Uint32Array([0, 1, 2, 0, 2, 3]);

        this.sessionBuffer = new Buffer({ data: new Float32Array(0), usage: BufferUsage.VERTEX | BufferUsage.COPY_DST });

        this.sessionGeometry = new Geometry({
            attributes: {
                aVertexPosition: {
                    buffer: new Buffer({ data: baseVertices, usage: BufferUsage.VERTEX }),
                    format: 'float32x2'
                },
                aSessionBlock: {
                    buffer: this.sessionBuffer,
                    format: 'float32x2',
                    stride: 24, // 6 floats * 4 bytes
                    offset: 0,
                    instance: true
                },
                aSessionColor: {
                    buffer: this.sessionBuffer,
                    format: 'float32x4',
                    stride: 24,
                    offset: 8, // Skip 2 floats
                    instance: true
                }
            },
            indexBuffer: baseIndices,
            instanceCount: 0
        });

        this.sessionUniforms = new UniformGroup({
            uCameraX: { value: 0, type: 'f32' },
            uZoom: { value: 1, type: 'f32' },
            uCandleSpacing: { value: 8, type: 'f32' },
            uMainChartHeight: { value: 0, type: 'f32' },
            uTimeAxisY: { value: 0, type: 'f32' },
            uTimeAxisHeight: { value: 0, type: 'f32' },
            uTotalHeight: { value: 0, type: 'f32' },
            uShowOnChart: { value: 0, type: 'f32' },
            uShowOnAxis: { value: 0, type: 'f32' },
            uChartAlphaMult: { value: 1, type: 'f32' },
            uVisStart: { value: 0, type: 'f32' },
            uVisEnd: { value: 10000, type: 'f32' }
        });

        const vertexSrc = `
            precision highp float;
            attribute vec2 aVertexPosition;
            attribute vec2 aSessionBlock;
            attribute vec4 aSessionColor;

            uniform mat3 uProjectionMatrix;
            uniform mat3 uWorldTransformMatrix;

            uniform float uCameraX;
            uniform float uZoom;
            uniform float uCandleSpacing;
            uniform float uTotalHeight;
            uniform float uVisStart;
            uniform float uVisEnd;

            varying vec4 vColor;
            varying float vY;

            void main() {
                float startIdx = aSessionBlock.x;
                float endIdx = aSessionBlock.y;

                if (endIdx < uVisStart || startIdx > uVisEnd) {
                    gl_Position = vec4(0.0);
                    return;
                }

                float actualSpacing = uCandleSpacing * uZoom;
                float xLeft = (startIdx * actualSpacing) - uCameraX;
                float xRight = (endIdx * actualSpacing) - uCameraX + actualSpacing;
                
                float w = xRight - xLeft;
                float posX = xLeft + (aVertexPosition.x * w);
                float posY = aVertexPosition.y * uTotalHeight;

                vColor = aSessionColor;
                vY = posY;

                mat3 mvp = uProjectionMatrix * uWorldTransformMatrix;
                gl_Position = vec4((mvp * vec3(posX, posY, 1.0)).xy, 0.0, 1.0);
            }
        `;

        const fragmentSrc = `
            precision mediump float;
            varying vec4 vColor;
            varying float vY;

            uniform float uMainChartHeight;
            uniform float uTimeAxisY;
            uniform float uTimeAxisHeight;
            uniform float uShowOnChart;
            uniform float uShowOnAxis;
            uniform float uChartAlphaMult;

            void main() {
                bool inChart = vY <= uMainChartHeight;
                bool inAxis = vY >= uTimeAxisY && vY <= uTimeAxisY + uTimeAxisHeight;

                if (inChart && uShowOnChart < 0.5) discard;
                if (inAxis && uShowOnAxis < 0.5) discard;
                if (!inChart && !inAxis) discard;

                float finalAlpha = vColor.a;

                if (inChart) {
                    finalAlpha *= uChartAlphaMult;
                } else if (inAxis) {
                    if (vY <= uTimeAxisY + 3.0) {
                        finalAlpha = min(1.0, finalAlpha * 1.5);
                    }
                }

                gl_FragColor = vec4(vColor.rgb * finalAlpha, finalAlpha);
            }
        `;

        const shader = Shader.from({ gl: { vertex: vertexSrc, fragment: fragmentSrc }, resources: { sessionUniforms: this.sessionUniforms } });
        this.sessionMesh = new Mesh({ geometry: this.sessionGeometry, shader });
    }

    private syncSessionData() {
        const len = this.dataStore.length;
        if (len === 0 || !this.sessionConfig.enabled) {
            this.sessionGeometry.instanceCount = 0;
            return;
        }

        const htf = ['1h', '2h', '3h', '4h', '6h', '8h', '12h', '1d', '3d', '1w', '1M'];
        if (htf.includes(this.currentInterval)) {
            this.sessionGeometry.instanceCount = 0;
            return;
        }

        if (this.lastSessionSyncedLength === len && !this.isSessionDirty) return;

        const toRGBA = (hex: number, alpha: number) => [
            ((hex >> 16) & 0xff) / 255, ((hex >> 8) & 0xff) / 255, (hex & 0xff) / 255, alpha
        ];

        const asiaColor = toRGBA(this.sessionConfig.asiaColor, this.sessionConfig.asiaAlpha);
        const lonColor = toRGBA(this.sessionConfig.londonColor, this.sessionConfig.londonAlpha);
        const nyColor = toRGBA(this.sessionConfig.nyColor, this.sessionConfig.nyAlpha);

        const blocks: number[] = [];
        let currentAsiaStart = -1, currentLonStart = -1, currentNyStart = -1;

        for (let i = 0; i < len; i++) {
            const ts = this.dataStore.data[i * 6];
            // Ultra-fast zero-GC math to get UTC hour (bypasses 'new Date()')
            const floatHour = (ts % 86400000) / 3600000;

            const inNy = floatHour >= 13.5 && floatHour < 20.0;
            const inLon = floatHour >= 8.0 && floatHour < 16.5;
            const inAsia = floatHour >= 0.0 && floatHour < 9.0;

            if (inNy && currentNyStart === -1) currentNyStart = i;
            else if (!inNy && currentNyStart !== -1) { blocks.push(currentNyStart, i - 1, ...nyColor); currentNyStart = -1; }

            if (inLon && currentLonStart === -1) currentLonStart = i;
            else if (!inLon && currentLonStart !== -1) { blocks.push(currentLonStart, i - 1, ...lonColor); currentLonStart = -1; }

            if (inAsia && currentAsiaStart === -1) currentAsiaStart = i;
            else if (!inAsia && currentAsiaStart !== -1) { blocks.push(currentAsiaStart, i - 1, ...asiaColor); currentAsiaStart = -1; }
        }

        if (currentNyStart !== -1) blocks.push(currentNyStart, len - 1, ...nyColor);
        if (currentLonStart !== -1) blocks.push(currentLonStart, len - 1, ...lonColor);
        if (currentAsiaStart !== -1) blocks.push(currentAsiaStart, len - 1, ...asiaColor);

        const instanceCount = blocks.length / 6;
        if (this.sessionArray.length < blocks.length) {
            this.sessionArray = new Float32Array(Math.max(blocks.length * 2, 1000));
        }

        for (let i = 0; i < blocks.length; i++) this.sessionArray[i] = blocks[i];

        this.sessionBuffer.data = this.sessionArray;
        this.sessionBuffer.update();

        this.sessionGeometry.instanceCount = instanceCount;
        this.lastSessionSyncedLength = len;
        this.isSessionDirty = false;
    }

    private renderInstancedSessions(mainChartHeight: number, timeAxisY: number, _width: number, height: number, visStart: number, visEnd: number) {
        this.syncSessionData();

        if (this.sessionGeometry.instanceCount === 0) {
            this.sessionMesh.visible = false;
            return;
        }

        this.sessionMesh.visible = true;

        const u = this.sessionUniforms.uniforms;
        u.uCameraX = this.cameraX;
        u.uZoom = this.zoom;
        u.uCandleSpacing = this.candleSpacing;
        u.uMainChartHeight = mainChartHeight;
        u.uTimeAxisY = timeAxisY;
        u.uTimeAxisHeight = this.timeAxisHeight;
        u.uTotalHeight = height;
        u.uShowOnChart = this.sessionConfig.showOnChart ? 1.0 : 0.0;
        u.uShowOnAxis = this.sessionConfig.showOnAxis ? 1.0 : 0.0;
        u.uChartAlphaMult = this.isDarkTheme ? 0.35 : 0.45;
        u.uVisStart = visStart;
        u.uVisEnd = visEnd;
    }
}