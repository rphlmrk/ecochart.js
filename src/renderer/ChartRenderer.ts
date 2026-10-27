import { Application, Graphics, BitmapText, BitmapFont, Container, Buffer, BufferUsage, Geometry, Mesh, Shader, UniformGroup } from 'pixi.js';
import { DataStore } from '../data/DataStore';
import type { ChartTheme, LineStyle } from '../theme/types';
import { ThemeManager } from '../theme/ThemeManager';
import { StrokeEngine } from './StrokeEngine';
import type { OscillatorScale } from '../indicators/Indicator';
import { alertManager } from '../alerts/AlertManager';

export interface ResampledHtfBar {
    time?: number;
    open: number;
    high: number;
    low: number;
    close: number;
    firstChartBar: number;
    lastChartBar: number;
    expectedBars?: number;
    exactSpanBars?: number;
    durationMs?: number;
    isForming?: boolean;
}

export class ChartRenderer {
    public app: Application;
    public dataStore: DataStore;
    // Theme state
    public isDarkTheme = true;

    // Session Config (Color + Alpha)
    public sessionConfig: any = {
        enabled: true,
        showOnAxis: true,
        showOnChart: false,
        timezoneOffset: 0,
        sessions: [] as any[],
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

    // Pixi Layers (Z-Index order - Milestone 2 Layer Separation)
    private gridGraphics!: Graphics;
    private gridMesh!: Mesh<Geometry, Shader>;
    private gridGeometry!: Geometry;
    private gridUniforms!: UniformGroup;
    private historicalCandlesGraphics!: Graphics; // Cached bars 0 to N-2
    private liveCandlesGraphics!: Graphics;       // Forming bar N-1 only


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
    private lastSyncedLiveTime = 0;
    private lastSyncedLiveClose = 0;
    private lastSyncedLiveHigh = 0;
    private lastSyncedLiveLow = 0;
    private lastSyncedMode = ''; // <-- ADDED

    // Caches for GPU modes
    public mainClosePrices = new Float64Array(0);
    private haPrevO = 0;
    private haPrevC = 0;

    public canvas?: HTMLCanvasElement;
    private uiGraphics: Graphics = new Graphics(); // Dividers & live price line
    public sessionBoxContainer: Container = new Container(); // Session Box background layer
    public sessionBoxGraphics: Graphics = new Graphics();
    public strictCbcContainer: Container = new Container(); // Strict CBC Pullback Zone layer (behind candles, above sessions)
    public strictCbcGraphics: Graphics = new Graphics();
    public indicatorMainContainer: Container = new Container(); 
    public indicatorOscContainer: Container = new Container();  
    public indicatorMainGraphics: Graphics = new Graphics();
    public indicatorOscGraphics: Graphics = new Graphics();
    public drawingGraphics: Graphics = new Graphics();
    public htfOverlayGraphics: Graphics = new Graphics();
    public isHtfOverlayActive: boolean = false;
    public htfOverlayTfLabel: string = '';
    public htfEffectiveMs: number = 0;

    // Dedicated Crosshair Graphics & Sync State
    private crosshairGraphics: Graphics = new Graphics();
    private syncCrosshairGraphics: Graphics = new Graphics();
    public syncHoverTimeMs: number | null = null;

    // Dedicated Sub-Panel Scale
    public oscHeight = 0; // <-- Dynamic stacked oscillator height
    public activeOscillatorScale?: OscillatorScale;

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
    public isHistoricalDirty = true;
    public isLivePriceDirty = false;
    public forceNextRender = true;
    private lastRenderState = { camX: 0, camY: 0, zoom: 0, minP: 0, maxP: 0, len: 0, close: 0, high: 0, low: 0, mode: '', w: 0, h: 0, oscH: 0, interval: '' };
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

        // Synchronize main line chart accent color on theme switch
        const resolvedAccent = theme.accentSource === 'bull' ? theme.bullBody : theme.accentColor;
        this.accentColor = ThemeManager.hexToInt(resolvedAccent);

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
        this.oscHeaderPairPool.forEach(p => p.title.tint = this.axisTextColor);

        this.updateInstancedThemeUniforms(); // <-- Synchronize GPU Colors
    }

    // Theming & Line Styles
    public bgColor = 0x131722;
    public axisBgColor = 0x161a25; // Distinct shade for axes
    public gridColor = 0x2A2E39;
    public axisTextColor = 0xD1D4DC;

    // Luminance check: Inverts text to dark if badge background is bright
    public getContrastTextColor(hexColor: number): number {
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
    // Candle suppression for HTF Canvas Overlay mode
    public hideCandles = false;

    // Current Timeframe & Symbol for countdown & alert triggers
    public currentInterval: string = '1m';
    public currentSymbol: string = 'BTCUSDT';

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

    // Dedicated canvases now handle axes outside the main viewport
    public priceAxisWidth = 0;
    public timeAxisHeight = 0;
    public isDestroyed = false;
    public isInitialized = false;

    constructor(dataStore: DataStore) {
        this.dataStore = dataStore;
        this.app = new Application();
    }

    public async init(canvas: HTMLCanvasElement) {
        if (this.isDestroyed) return;
        this.canvas = canvas;
        const rect = canvas.getBoundingClientRect();
        try {
            await this.app.init({
                canvas: canvas,
                width: rect.width || canvas.clientWidth || 800,
                height: rect.height || canvas.clientHeight || 600,
                backgroundColor: this.bgColor,
                antialias: false,
                autoStart: false, // 🛑 Kill Pixi's continuous 60 FPS auto-loop
                resolution: Math.min(window.devicePixelRatio || 1, 2),
                autoDensity: false // Prevent Pixi from writing fixed px styles
            });
        } catch (err) {
            console.warn('Pixi app.init warning:', err);
        }
        if (this.isDestroyed) {
            this.destroy();
            return;
        }
        this.isInitialized = true;
        if (this.app?.ticker) {
            this.app.ticker.stop();
        }

        // GPU BITMAP FONT
        BitmapFont.install({
            name: 'ChartFont',
            style: { fontFamily: 'sans-serif', fontSize: 32, fill: 0xffffff, fontWeight: 'bold' },
            chars: [['a', 'z'], ['A', 'Z'], ['0', '9'], ' .:,;-_=+()!@#$%^&*~`|/\\']
        });

        // Initialize Layers in order (Background -> Foreground)
        if (!this.gridGraphics) this.gridGraphics = new Graphics();
        if (!this.historicalCandlesGraphics) this.historicalCandlesGraphics = new Graphics();
        if (!this.liveCandlesGraphics) this.liveCandlesGraphics = new Graphics();

        // Setup new containers for Pixi v8 compatibility
        if (!this.sessionBoxContainer) this.sessionBoxContainer = new Container();
        if (!this.sessionBoxGraphics) this.sessionBoxGraphics = new Graphics();
        if (!this.strictCbcContainer) this.strictCbcContainer = new Container();
        if (!this.strictCbcGraphics) this.strictCbcGraphics = new Graphics();

        if (!this.indicatorMainContainer) this.indicatorMainContainer = new Container();
        if (!this.indicatorOscContainer) this.indicatorOscContainer = new Container();
        if (!this.indicatorMainGraphics) this.indicatorMainGraphics = new Graphics();
        if (!this.indicatorOscGraphics) this.indicatorOscGraphics = new Graphics();

        // Put CPU graphics inside the new containers
        this.sessionBoxContainer.removeChildren();
        this.sessionBoxContainer.addChild(this.sessionBoxGraphics);

        this.strictCbcContainer.removeChildren();
        this.strictCbcContainer.addChild(this.strictCbcGraphics);

        this.indicatorMainContainer.removeChildren();
        this.indicatorOscContainer.removeChildren();
        this.indicatorMainContainer.addChild(this.indicatorMainGraphics);
        this.indicatorOscContainer.addChild(this.indicatorOscGraphics);

        if (!this.drawingGraphics) this.drawingGraphics = new Graphics();
        if (!this.htfOverlayGraphics) this.htfOverlayGraphics = new Graphics();
        if (!this.uiGraphics) this.uiGraphics = new Graphics();
        if (!this.crosshairGraphics) this.crosshairGraphics = new Graphics();
        if (!this.syncCrosshairGraphics) this.syncCrosshairGraphics = new Graphics();
        if (!this.oscHeaderContainer) this.oscHeaderContainer = new Container();

        this.initSessionMesh();
        this.initGridMesh();
        this.initInstancedCandleMesh();

        // Layer Stacking (Bottom to Top):
        // 1. Grid
        this.app.stage.addChild(this.gridMesh);
        this.app.stage.addChild(this.gridGraphics); // Opaque axis background drawn here

        // 2. Market Session Box layer (Lowest chart content)
        this.app.stage.addChild(this.sessionMesh);  // GPU Instanced Session Shade
        this.app.stage.addChild(this.sessionBoxContainer); // Market Sessions range boxes, outlines, pre-open

        // 3. Strict CBC Pullback Zone layer (ABOVE session box, but BEHIND candlesticks)
        this.app.stage.addChild(this.strictCbcContainer); // Strict CBC pullback zones

        // 4. Candlesticks (ABOVE Strict CBC pullback zones!)
        this.app.stage.addChild(this.historicalCandlesGraphics); // Static layer
        this.app.stage.addChild(this.liveCandlesGraphics);       // Dynamic live layer
        this.app.stage.addChild(this.candleMesh);                // Candlesticks / Bars / HA mesh
        this.app.stage.addChild(this.htfOverlayGraphics);        // Dedicated Higher Timeframe Overlay layer

        // 5. Main Foreground Indicators (Above candlesticks)
        this.app.stage.addChild(this.indicatorMainContainer); // Moving averages, signals, etc.
        this.app.stage.addChild(this.indicatorOscContainer);  // Oscillators
        this.app.stage.addChild(this.drawingGraphics);
        this.app.stage.addChild(this.oscHeaderContainer);
        this.app.stage.addChild(this.uiGraphics);

        // Crosshairs sit above chart elements
        this.app.stage.addChild(this.syncCrosshairGraphics);
        this.app.stage.addChild(this.crosshairGraphics);
    }

    public renderFrame() {
        if (!this.historicalCandlesGraphics || this.dataStore.length === 0 || !this.app?.screen) return;

        // --- ECO-MODE: Thermal Throttling (Prevents device heating) ---
        const len = this.dataStore.length;
        const lastBase = (len - 1) * 6;
        const liveO = this.dataStore.data[lastBase + 1];
        const liveH = this.dataStore.data[lastBase + 2];
        const liveL = this.dataStore.data[lastBase + 3];
        const liveC = this.dataStore.data[lastBase + 4];
        const width = this.app.screen.width;
        const height = this.app.screen.height;

        // Snapshot previous frame state BEFORE auto-scale or updates
        const prevCamX = this.lastRenderState.camX;
        const prevCamY = this.lastRenderState.camY;
        const prevZoom = this.lastRenderState.zoom;
        const prevMinP = this.lastRenderState.minP;
        const prevMaxP = this.lastRenderState.maxP;
        const prevLen = this.lastRenderState.len;
        const prevMode = this.lastRenderState.mode;
        const prevW = this.lastRenderState.w;
        const prevH = this.lastRenderState.h;
        const prevOscH = this.lastRenderState.oscH;
        const prevInterval = this.lastRenderState.interval;
        const forced = this.forceNextRender;
        this.forceNextRender = false;

        // Layout Constants
        this.timeAxisHeight = 24; // Explicitly reserve bottom 24px
        const chartWidth = width;
        const timeAxisY = height - this.timeAxisHeight; // Offset for 2-row span
        const oscHeight = this.oscHeight;
        const mainChartHeight = timeAxisY - oscHeight;
        const actualSpacing = this.candleSpacing * this.zoom;

        // Visible index range calculation
        const buffer = 15;
        const rawVisStart = Math.floor(this.cameraX / actualSpacing);
        const rawVisEnd = Math.floor((this.cameraX + chartWidth) / actualSpacing) + 1;
        const visStart = Math.max(0, rawVisStart - buffer);
        const visEnd = Math.min(this.dataStore.length, rawVisEnd + buffer);

        // Auto-scale calculation runs first to determine if currentMinPrice/currentMaxPrice changed
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

        // Check if the live forming candle is visible on screen
        const liveBarInView = (visEnd >= len && len > 0);

        // Live price ticks ONLY refresh the main canvas when the live printing candle is on screen
        const livePriceChanged = liveBarInView && (
            this.lastRenderState.close !== liveC ||
            this.lastRenderState.high !== liveH ||
            this.lastRenderState.low !== liveL ||
            (this.lastRenderState as any).open !== liveO
        );

        this.isLivePriceDirty = livePriceChanged;

        // Eco-Mode: If scrolled in history and nothing visible changed, stop immediately!
        if (
            !forced &&
            prevCamX === this.cameraX &&
            prevCamY === this.cameraY &&
            prevZoom === this.zoom &&
            prevMinP === this.currentMinPrice &&
            prevMaxP === this.currentMaxPrice &&
            prevLen === len &&
            !livePriceChanged &&
            prevMode === this.chartMode &&
            prevW === width &&
            prevH === height &&
            prevOscH === oscHeight &&
            prevInterval === this.currentInterval
        ) {
            this.isRenderDirty = false;
            return;
        }

        this.isRenderDirty = true;

        // Determine if historical layer must re-render (camera, scale, or candle count changed)
        this.isHistoricalDirty = (
            forced ||
            prevCamX !== this.cameraX ||
            prevCamY !== this.cameraY ||
            prevZoom !== this.zoom ||
            prevMinP !== this.currentMinPrice ||
            prevMaxP !== this.currentMaxPrice ||
            prevLen !== len ||
            prevMode !== this.chartMode ||
            prevW !== width ||
            prevH !== height ||
            prevOscH !== oscHeight ||
            prevInterval !== this.currentInterval
        );
        const isHistoricalDirty = this.isHistoricalDirty;

        if (isHistoricalDirty) {
            this.historicalCandlesGraphics.clear();
            this.gridGraphics.clear();
            // Draw opaque background for the Time Axis so GPU candles don't bleed under it, but the Session Mesh sits ON TOP
            this.gridGraphics.rect(0, timeAxisY, width, this.timeAxisHeight).fill(this.axisBgColor);
        }
        this.liveCandlesGraphics.clear();
        this.uiGraphics.clear();

        // Update render state cache for next cycle
        this.lastRenderState = {
            camX: this.cameraX, camY: this.cameraY, zoom: this.zoom,
            minP: this.currentMinPrice, maxP: this.currentMaxPrice,
            len: len, close: liveC, high: liveH, low: liveL, open: liveO,
            mode: this.chartMode, w: width, h: height,
            oscH: oscHeight, interval: this.currentInterval
        } as any;

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

        // Grid calculation for GPU quad
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

        const minPixelsBetweenLabels = 100;
        let candleStep = Math.max(1, Math.ceil(minPixelsBetweenLabels / actualSpacing));
        if (candleStep > 1 && candleStep < 5) candleStep = 5;
        else if (candleStep > 5 && candleStep < 10) candleStep = 10;
        else if (candleStep > 10 && candleStep < 30) candleStep = 30;

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

        // --- 2. MULTI-MODE CHART DRAWING (HARDWARE ACCELERATED) ---
        if (this.hideCandles) {
            this.candleMesh.visible = false;
            const lineEntry = this.indicatorMeshes.get('MAIN_CHART_LINE');
            if (lineEntry) lineEntry.mesh.visible = false;
        } else if (this.chartMode === 'line' || this.chartMode === 'area') {
            // Mode 1: Vector Splines (Line / Area)
            this.candleMesh.visible = false;
            this.syncInstancedData(); // Ensures mainClosePrices is up to date

            const isArea = this.chartMode === 'area';
            const layout = { mainChartHeight, oscY: 0, oscHeight: 0, chartWidth };

            this.drawGPUIndicatorLine(
                'MAIN_CHART_LINE', this.mainClosePrices,
                this.accentColor, this.mainLineWidth, false, layout, undefined, isArea
            );
        } else {
            // Mode 2: Instanced Rects (Candles, Bars, Heikin-Ashi)
            this.candleMesh.visible = true;
            this.candleUniforms.uniforms.uChartMode = this.chartMode === 'bars' ? 1.0 : 0.0;
            this.renderInstancedCandles(mainChartHeight, visStart, visEnd);

            // Hide the Line/Area mesh if we switched back to candles
            const lineEntry = this.indicatorMeshes.get('MAIN_CHART_LINE');
            if (lineEntry) lineEntry.mesh.visible = false;
        }

        // --- 3. DRAW AXIS BACKGROUNDS & DIVIDERS ---
        // (Cleaned: Handled completely by dedicated Price and Time Axis Canvases)

        // --- 3.5 DRAW MARKET SESSION HIGHLIGHTS (GPU) ---
        this.renderInstancedSessions(mainChartHeight, timeAxisY, width, height, visStart, visEnd);

        // Draw Divider Line across chart
        if (oscHeight > 0) {
            StrokeEngine.drawLine(this.uiGraphics, 0, mainChartHeight, width, mainChartHeight, {
                color: this.gridColor,
                width: 1,
                alpha: 1.0
            });
        }

        // --- 4. DRAW LIVE PRICE LINE ---
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

            // (Live Price & Countdown Pill is now drawn on the dedicated PriceAxisCanvas)
        }

        // --- 4.5 DRAW ACTIVE ON-CHART ALERT LINES ---
        const activeAlerts = alertManager.getActiveAlertsForSymbol(this.currentSymbol);
        for (const alert of activeAlerts) {
            const alertY = priceToY(alert.targetPrice);
            if (alertY >= 0 && alertY <= mainChartHeight) {
                const alertColor = ThemeManager.hexToInt(alert.color || '#FF9800');
                StrokeEngine.drawLine(this.uiGraphics, 0, alertY, chartWidth, alertY, {
                    color: alertColor,
                    width: 1.5,
                    alpha: 0.85,
                    style: 'dashed',
                    dashLength: 8,
                    gapLength: 5
                });
            }
        }

        // Render Title & Live/Historical Telemetry for Bottom Panels
        this.updateOscillatorHeaders();
    }



    public renderCrosshair() {
        if (!this.crosshairGraphics || !this.syncCrosshairGraphics || !this.app?.screen) return;

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

        const chartWidth = width;
        const timeAxisY = height;
        const oscHeight = this.oscHeight;
        const mainChartHeight = timeAxisY - oscHeight;

        // 1. Draw Local Crosshair Lines
        if (this.isCrosshairVisible && this.crosshairX >= 0 && this.crosshairX <= chartWidth && this.crosshairY >= 0 && this.crosshairY <= timeAxisY) {

            let drawX = this.crosshairX;
            let drawY = this.crosshairY;

            if (this.isMagnetEnabled && this.crosshairY <= mainChartHeight) {
                const mag = this.getMagnetPoint(this.crosshairX, this.crosshairY, 30);
                drawX = this.timeToX(mag.time);
                drawY = this.priceToY(mag.price);
            }

            // Horizontal crosshair line to edge of chart
            StrokeEngine.drawLine(this.crosshairGraphics, 0, drawY, chartWidth, drawY, {
                color: this.crosshairColor, width: 1, alpha: 0.6, style: this.crosshairStyle, dashLength: 4, gapLength: 3
            });
            // Vertical crosshair line down to time axis
            StrokeEngine.drawLine(this.crosshairGraphics, drawX, 0, drawX, timeAxisY, {
                color: this.crosshairColor, width: 1, alpha: 0.6, style: this.crosshairStyle, dashLength: 4, gapLength: 3
            });

            // Precision targeting reticle for touch & mouse aiming
            this.crosshairGraphics.circle(drawX, drawY, 8).stroke({ color: this.accentColor, width: 1.5, alpha: 0.85 });
            this.crosshairGraphics.circle(drawX, drawY, 2).fill({ color: this.accentColor, alpha: 0.95 });

            this.crosshairX = drawX;
            this.crosshairY = drawY;
        }

        // 2. Draw Synchronized Crosshair from other panes (Multi-Timeframe Aware)
        if (this.syncHoverTimeMs !== null && this.dataStore.length > 0) {
            const syncX = this.timeToX(this.syncHoverTimeMs);

            if (syncX >= 0 && syncX <= chartWidth) {
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

        const screenWidth = this.app?.screen?.width ?? (this.canvas?.clientWidth || 800);
        const chartWidth = screenWidth - this.priceAxisWidth;
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
        if (!this.oscHeaderContainer || !this.indicatorManager || !this.app?.screen) return;

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
        if (low > 0 && low <= lastIdx) {
            const tPrev = this.dataStore.data[(low - 1) * 6];
            const tNext = this.dataStore.data[low * 6];
            if (tNext > tPrev) {
                return (low - 1) + (time - tPrev) / (tNext - tPrev);
            }
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

    public getCandleCenterX(barIndex: number): number {
        const actualSpacing = this.candleSpacing * this.zoom;
        const candleWidth = Math.max(1.0, actualSpacing * 0.8);
        return (barIndex * actualSpacing) - this.cameraX + (candleWidth * 0.5);
    }

    public yToPrice(y: number): number {
        const screenHeight = (this.app && this.app.renderer) ? this.app.screen.height : 600;
        const mainChartHeight = Math.max(1, screenHeight - this.timeAxisHeight - this.oscHeight);
        const norm = (mainChartHeight - (y - this.cameraY)) / mainChartHeight;
        return this.currentMinPrice + (norm * (this.currentMaxPrice - this.currentMinPrice));
    }

    public priceToY(price: number): number {
        const screenHeight = (this.app && this.app.renderer) ? this.app.screen.height : 600;
        const mainChartHeight = Math.max(1, screenHeight - this.timeAxisHeight - this.oscHeight);
        const priceRange = this.currentMaxPrice - this.currentMinPrice || 1;
        const norm = (price - this.currentMinPrice) / priceRange;
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
     * Resizes Pixi's internal viewport to match chartCanvas exactly.
     */
    public resize(width: number, height: number) {
        if (this.app && this.app.renderer && width > 0 && height > 0) {
            this.app.renderer.resize(width, height);
            if (this.app.canvas) {
                this.app.canvas.style.width = '100%';
                this.app.canvas.style.height = '100%';
            }
            this.forceNextRender = true;
        }
    }

    /**
     * Dispatches an explicit on-demand draw call to the GPU.
     */
    public render() {
        if (this.app && this.app.renderer) {
            this.app.render();
        }
    }

    /**
     * Explicitly frees GPU buffers and geometry when an individual indicator is deleted
     */
    public removeIndicatorMesh(id: string) {
        for (const [meshId, entry] of this.indicatorMeshes.entries()) {
            if (meshId === id || meshId.startsWith(id + '_') || meshId.startsWith(id)) {
                if (entry.mesh && entry.mesh.geometry) entry.mesh.geometry.destroy();
                if (entry.buffer) entry.buffer.destroy();
                if (entry.mesh) {
                    if (entry.mesh.parent) entry.mesh.parent.removeChild(entry.mesh);
                    entry.mesh.destroy({ children: true });
                }
                this.indicatorMeshes.delete(meshId);
            }
        }
    }

    public destroy() {
        if (this.isDestroyed) return;
        this.isDestroyed = true;

        // 1. Destroy all custom GPU Buffers and Geometries to free VRAM instantly
        try { if (this.gridGeometry) this.gridGeometry.destroy(); } catch {}
        try { if (this.candleGeometry) this.candleGeometry.destroy(); } catch {}
        try { if (this.candleIndexBuffer) this.candleIndexBuffer.destroy(); } catch {}
        try { if (this.candleOHLCBuffer) this.candleOHLCBuffer.destroy(); } catch {}
        try { if (this.sessionGeometry) this.sessionGeometry.destroy(); } catch {}
        try { if (this.sessionBuffer) this.sessionBuffer.destroy(); } catch {}
        try { if (this.sessionBoxGraphics) this.sessionBoxGraphics.destroy(); } catch {}
        try { if (this.strictCbcGraphics) this.strictCbcGraphics.destroy(); } catch {}
        try { if (this.sessionBoxContainer) this.sessionBoxContainer.destroy({ children: true }); } catch {}
        try { if (this.strictCbcContainer) this.strictCbcContainer.destroy({ children: true }); } catch {}

        // 2. Destroy dynamically generated Indicator Meshes
        for (const entry of this.indicatorMeshes.values()) {
            try { if (entry.mesh && entry.mesh.geometry) entry.mesh.geometry.destroy(); } catch {}
            try { if (entry.buffer) entry.buffer.destroy(); } catch {}
            try { if (entry.mesh) entry.mesh.destroy(); } catch {}
        }
        this.indicatorMeshes.clear();

        // 3. Clear CPU memory arrays
        this.candleIndexArray = new Float32Array(0);
        this.candleOHLCArray = new Float32Array(0);
        this.mainClosePrices = new Float64Array(0);
        this.sessionArray = new Float32Array(0);

        // 4. Destroy Pixi Application and Canvas references safely
        if (this.app) {
            try {
                // In PixiJS v8 ResizePlugin, destroying an app requires this._cancelResize to be a function
                if (typeof (this.app as any)._cancelResize !== 'function') {
                    (this.app as any)._cancelResize = () => {};
                }
                if (this.app.renderer) {
                    this.app.destroy(true, { children: true, texture: true });
                }
            } catch (err) {
                console.warn('Pixi app cleanup warning:', err);
            }
            this.app = null as any;
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
        // 1. Base Geometry: 12 vertices forming 3 quads (Spine, Open Tick, Close Tick)
        const baseVertices = new Float32Array([
            -0.5, 0.0, 0.0, 0.5, 0.0, 0.0, 0.5, 1.0, 0.0, -0.5, 1.0, 0.0, // Quad 0
            -0.5, 0.0, 1.0, 0.5, 0.0, 1.0, 0.5, 1.0, 1.0, -0.5, 1.0, 1.0, // Quad 1
            -0.5, 0.0, 2.0, 0.5, 0.0, 2.0, 0.5, 1.0, 2.0, -0.5, 1.0, 2.0  // Quad 2
        ]);
        const baseIndices = new Uint32Array([
            0, 1, 2, 0, 2, 3,
            4, 5, 6, 4, 6, 7,
            8, 9, 10, 8, 10, 11
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
                aVertexPosition: { buffer: new Buffer({ data: baseVertices, usage: BufferUsage.VERTEX }), format: 'float32x3' },
                aCandleIndex: { buffer: this.candleIndexBuffer, format: 'float32', instance: true },
                aCandleOHLC: { buffer: this.candleOHLCBuffer, format: 'float32x4', instance: true }
            },
            indexBuffer: baseIndices,
            instanceCount: 0
        });

        this.candleUniforms = new UniformGroup({
            uCameraX: { value: 0, type: 'f32' }, uCameraY: { value: 0, type: 'f32' },
            uZoom: { value: 1, type: 'f32' }, uCandleSpacing: { value: 8, type: 'f32' },
            uMinPrice: { value: 0, type: 'f32' }, uMaxPrice: { value: 1, type: 'f32' },
            uChartHeight: { value: 500, type: 'f32' }, uVisStart: { value: 0, type: 'f32' }, uVisEnd: { value: 10000, type: 'f32' },
            uChartMode: { value: 0, type: 'f32' }, // <-- 0 = Candle/HA, 1 = Bars
            uBullBodyColor: { value: [0.15, 0.65, 0.60, 1.0], type: 'vec4<f32>' },
            uBearBodyColor: { value: [0.94, 0.33, 0.31, 1.0], type: 'vec4<f32>' },
            uBullWickColor: { value: [0.15, 0.65, 0.60, 1.0], type: 'vec4<f32>' },
            uBearWickColor: { value: [0.94, 0.33, 0.31, 1.0], type: 'vec4<f32>' }
        });

        const vertexSrc = `
            precision highp float;
            attribute vec3 aVertexPosition;
            attribute float aCandleIndex;
            attribute vec4 aCandleOHLC; 

            uniform mat3 uProjectionMatrix; uniform mat3 uWorldTransformMatrix;
            uniform float uCameraX; uniform float uCameraY; uniform float uZoom;
            uniform float uCandleSpacing; uniform float uMinPrice; uniform float uMaxPrice;
            uniform float uChartHeight; uniform float uVisStart; uniform float uVisEnd;
            uniform float uChartMode;

            uniform vec4 uBullBodyColor; uniform vec4 uBearBodyColor;
            uniform vec4 uBullWickColor; uniform vec4 uBearWickColor;

            varying vec4 vColor; varying float vY;

            void main() {
                if (aCandleIndex < uVisStart || aCandleIndex > uVisEnd) {
                    gl_Position = vec4(0.0); return;
                }

                float openP = aCandleOHLC.x; float highP = aCandleOHLC.y;
                float lowP = aCandleOHLC.z; float closeP = aCandleOHLC.w;
                bool isBull = closeP >= openP;
                
                float actualSpacing = uCandleSpacing * uZoom;
                float candleWidth = max(1.0, actualSpacing * 0.8);
                float centerX = (aCandleIndex * actualSpacing) - uCameraX + (candleWidth * 0.5);
                float yRatio = uChartHeight / max(0.000001, uMaxPrice - uMinPrice);
                float yOffset = uChartHeight + uCameraY;
                
                float topY = 0.0; float bottomY = 0.0;
                float w = 1.0; float shiftX = 0.0;
                
                if (uChartMode < 0.5) { 
                    // CANDLES
                    if (aVertexPosition.z < 0.5) { // Wick
                        topY = yOffset - ((highP - uMinPrice) * yRatio);
                        bottomY = yOffset - ((lowP - uMinPrice) * yRatio);
                        w = 1.0; vColor = isBull ? uBullWickColor : uBearWickColor;
                    } else if (aVertexPosition.z < 1.5) { // Body
                        topY = yOffset - ((max(openP, closeP) - uMinPrice) * yRatio);
                        bottomY = yOffset - ((min(openP, closeP) - uMinPrice) * yRatio);
                        if (bottomY - topY < 1.0) bottomY = topY + 1.0;
                        w = candleWidth; vColor = isBull ? uBullBodyColor : uBearBodyColor;
                    } else { gl_Position = vec4(0.0); return; } // Quad 2 Unused
                } else {
                    // BARS (OHLC)
                    float spineW = max(1.0, candleWidth * 0.2);
                    float tickW = max(2.0, candleWidth * 0.5);
                    if (aVertexPosition.z < 0.5) { // Spine
                        topY = yOffset - ((highP - uMinPrice) * yRatio);
                        bottomY = yOffset - ((lowP - uMinPrice) * yRatio);
                        w = spineW; vColor = isBull ? uBullBodyColor : uBearBodyColor;
                    } else if (aVertexPosition.z < 1.5) { // Open Tick
                        topY = yOffset - ((openP - uMinPrice) * yRatio) - (spineW * 0.5);
                        bottomY = topY + spineW;
                        shiftX = -tickW * 0.5; w = tickW;
                        vColor = isBull ? uBullBodyColor : uBearBodyColor;
                    } else { // Close Tick
                        topY = yOffset - ((closeP - uMinPrice) * yRatio) - (spineW * 0.5);
                        bottomY = topY + spineW;
                        shiftX = tickW * 0.5; w = tickW;
                        vColor = isBull ? uBullBodyColor : uBearBodyColor;
                    }
                }
                
                float posX = centerX + shiftX + (aVertexPosition.x * w);
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
        const toVec4 = (hex: number, alpha: number) => new Float32Array([
            ((hex >> 16) & 0xff) / 255,
            ((hex >> 8) & 0xff) / 255,
            (hex & 0xff) / 255,
            alpha
        ]);
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
        const liveT = this.dataStore.data[lastBase];
        const liveO = this.dataStore.data[lastBase + 1];
        const liveH = this.dataStore.data[lastBase + 2];
        const liveL = this.dataStore.data[lastBase + 3];
        const liveC = this.dataStore.data[lastBase + 4];

        const isHA = this.chartMode === 'heikinAshi';

        // Check if the previous bar's time matches what we had cached.
        const prevBarTimeMatches = (lastIdx > 0) && (this.dataStore.data[(lastIdx - 1) * 6] === this.lastSyncedLiveTime);
        const isNewBarAppended = !this.isHistoricalDirty
            && (len === this.lastSyncedLength + 1)
            && (this.lastSyncedMode === this.chartMode)
            && (this.candleOHLCArray.length >= len * 4)
            && (liveT > this.lastSyncedLiveTime)
            && prevBarTimeMatches;

        // If returning from another tab (isHistoricalDirty) or multiple candles were added, force full sync
        const needsFullSync = this.isHistoricalDirty
            || (this.candleOHLCArray.length < len * 4)
            || (this.lastSyncedMode !== this.chartMode)
            || (!isNewBarAppended && this.lastSyncedLength !== len);

        if (needsFullSync) {
            const newCap = Math.max(10000, len * 2);
            if (this.candleOHLCArray.length < newCap * 4) {
                this.candleOHLCArray = new Float32Array(newCap * 4);
                this.candleIndexArray = new Float32Array(newCap);
                this.mainClosePrices = new Float64Array(newCap);
            }

            for (let i = 0; i < len; i++) {
                const b = i * 6;
                const d = i * 4;
                const o = this.dataStore.data[b + 1], h = this.dataStore.data[b + 2], l = this.dataStore.data[b + 3], c = this.dataStore.data[b + 4];

                this.mainClosePrices[i] = c;
                this.candleIndexArray[i] = i;

                if (isHA) {
                    const haC = (o + h + l + c) / 4;
                    const haO = i === 0 ? (o + c) / 2 : (this.haPrevO + this.haPrevC) / 2;
                    this.candleOHLCArray[d] = haO;
                    this.candleOHLCArray[d + 1] = Math.max(h, haO, haC);
                    this.candleOHLCArray[d + 2] = Math.min(l, haO, haC);
                    this.candleOHLCArray[d + 3] = haC;
                    this.haPrevO = haO; this.haPrevC = haC;
                } else {
                    this.candleOHLCArray[d] = o; this.candleOHLCArray[d + 1] = h;
                    this.candleOHLCArray[d + 2] = l; this.candleOHLCArray[d + 3] = c;
                }
            }

            this.candleOHLCBuffer.data = this.candleOHLCArray;
            this.candleIndexBuffer.data = this.candleIndexArray;
            this.candleOHLCBuffer.update();
            this.candleIndexBuffer.update();

            this.lastSyncedLength = len;
            this.lastSyncedMode = this.chartMode;
            this.lastSyncedLiveTime = liveT;
            this.lastSyncedLiveClose = liveC;
            this.lastSyncedLiveHigh = liveH;
            this.lastSyncedLiveLow = liveL;
            return;
        }

        // Fast Append: Sync BOTH the finalized previous candle (lastIdx - 1) AND the new live candle (lastIdx)
        if (isNewBarAppended) {
            // 1. Finalize the candle that just closed
            if (lastIdx > 0) {
                const pb = (lastIdx - 1) * 6;
                const pd = (lastIdx - 1) * 4;
                const pO = this.dataStore.data[pb + 1];
                const pH = this.dataStore.data[pb + 2];
                const pL = this.dataStore.data[pb + 3];
                const pC = this.dataStore.data[pb + 4];

                this.mainClosePrices[lastIdx - 1] = pC;
                if (!isHA) {
                    this.candleOHLCArray[pd] = pO;
                    this.candleOHLCArray[pd + 1] = pH;
                    this.candleOHLCArray[pd + 2] = pL;
                    this.candleOHLCArray[pd + 3] = pC;
                }
            }

            // 2. Add the new forming candle
            const d = lastIdx * 4;
            this.mainClosePrices[lastIdx] = liveC;
            this.candleIndexArray[lastIdx] = lastIdx;

            if (isHA) {
                const haC = (liveO + liveH + liveL + liveC) / 4;
                const haO = (this.haPrevO + this.haPrevC) / 2;
                this.candleOHLCArray[d] = haO;
                this.candleOHLCArray[d + 1] = Math.max(liveH, haO, haC);
                this.candleOHLCArray[d + 2] = Math.min(liveL, haO, haC);
                this.candleOHLCArray[d + 3] = haC;
                this.haPrevO = haO; this.haPrevC = haC;
            } else {
                this.candleOHLCArray[d] = liveO;
                this.candleOHLCArray[d + 1] = liveH;
                this.candleOHLCArray[d + 2] = liveL;
                this.candleOHLCArray[d + 3] = liveC;
            }

            this.candleOHLCBuffer.update();
            this.candleIndexBuffer.update();

            this.lastSyncedLength = len;
            this.lastSyncedLiveTime = liveT;
            this.lastSyncedLiveClose = liveC;
            this.lastSyncedLiveHigh = liveH;
            this.lastSyncedLiveLow = liveL;
            return;
        }

        // Fast Live-Tick: Update Open, High, Low, and Close for the active forming bar
        if (this.lastSyncedLiveClose !== liveC || this.lastSyncedLiveHigh !== liveH || this.lastSyncedLiveLow !== liveL || this.candleOHLCArray[lastIdx * 4] !== liveO) {
            const d = lastIdx * 4;
            this.mainClosePrices[lastIdx] = liveC;

            if (isHA) {
                const haC = (liveO + liveH + liveL + liveC) / 4;
                this.candleOHLCArray[d + 1] = Math.max(liveH, this.haPrevO, haC);
                this.candleOHLCArray[d + 2] = Math.min(liveL, this.haPrevO, haC);
                this.candleOHLCArray[d + 3] = haC;
            } else {
                this.candleOHLCArray[d] = liveO;
                this.candleOHLCArray[d + 1] = liveH;
                this.candleOHLCArray[d + 2] = liveL;
                this.candleOHLCArray[d + 3] = liveC;
            }

            this.candleOHLCBuffer.update();
            this.lastSyncedLiveTime = liveT;
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
        for (const [id, entry] of this.indicatorMeshes.entries()) {
            // Keep the main chart line/area visible; only hide custom indicators before re-render
            if (id !== 'MAIN_CHART_LINE') {
                entry.mesh.visible = false;
            }
        }
    }

    public drawGPUIndicatorLine(
        id: string, values: Float64Array, color: number, width: number,
        isOscillator: boolean, layout: any, oscScale?: OscillatorScale, isArea: boolean = false, alpha: number = 1.0
    ) {
        let entry = this.indicatorMeshes.get(id);

        if (!entry) {
            // 1x1 Base Quad
            const baseVertices = new Float32Array([0, -0.5, 1, -0.5, 1, 0.5, 0, 0.5]);
            const baseIndices = new Uint32Array([0, 1, 2, 0, 2, 3]);
            const instBuffer = new Buffer({ data: new Float32Array(0), usage: BufferUsage.VERTEX | BufferUsage.COPY_DST });

            const geom = new Geometry({
                attributes: {
                    aVertexPosition: { buffer: new Buffer({ data: baseVertices, usage: BufferUsage.VERTEX }), format: 'float32x2' },
                    aLineData: { buffer: instBuffer, format: 'float32x3', instance: true }
                },
                indexBuffer: baseIndices
            });

            const uniforms = new UniformGroup({
                uCameraX: { value: 0, type: 'f32' }, uCameraY: { value: 0, type: 'f32' },
                uZoom: { value: 1, type: 'f32' }, uCandleSpacing: { value: 8, type: 'f32' },
                uMinPrice: { value: 0, type: 'f32' }, uMaxPrice: { value: 1, type: 'f32' },
                uChartHeight: { value: 500, type: 'f32' }, uLineColor: { value: new Float32Array([1.0, 1.0, 1.0, 1.0]), type: 'vec4<f32>' },
                uWidth: { value: 2, type: 'f32' }, uVisStart: { value: 0, type: 'f32' },
                uVisEnd: { value: 10000, type: 'f32' }, uIsOscillator: { value: 0, type: 'f32' },
                uOscY: { value: 0, type: 'f32' }, uOscHeight: { value: 100, type: 'f32' },
                uOscMin: { value: 0, type: 'f32' }, uOscMax: { value: 100, type: 'f32' },
                uIsArea: { value: 0, type: 'f32' }
            });

            const vertexSrc = `
                precision highp float;
                attribute vec2 aVertexPosition;
                attribute vec3 aLineData;

                uniform mat3 uProjectionMatrix; uniform mat3 uWorldTransformMatrix;
                uniform float uCameraX; uniform float uCameraY; uniform float uZoom;
                uniform float uCandleSpacing; uniform float uMinPrice; uniform float uMaxPrice;
                uniform float uChartHeight; uniform float uWidth; uniform float uVisStart; uniform float uVisEnd;
                uniform float uIsOscillator; uniform float uOscY; uniform float uOscHeight;
                uniform float uOscMin; uniform float uOscMax; uniform float uIsArea;

                varying vec2 vPos;

                float getScreenY(float val) {
                    if (uIsOscillator > 0.5) {
                        float norm = clamp((val - uOscMin) / max(0.0001, uOscMax - uOscMin), 0.0, 1.0);
                        float usableH = uOscHeight - 4.0;
                        return uOscY + 2.0 + usableH - (norm * usableH);
                    } else {
                        float priceRange = max(0.000001, uMaxPrice - uMinPrice);
                        float yRatio = uChartHeight / priceRange;
                        float yOffset = uChartHeight + uCameraY;
                        return yOffset - ((val - uMinPrice) * yRatio);
                    }
                }

                void main() {
                    float index = aLineData.x;
                    if (index < uVisStart || index > uVisEnd) { gl_Position = vec4(0.0); return; }
                    float valThis = aLineData.y; float valNext = aLineData.z;
                    if (uIsOscillator < 0.5) {
                        if (valThis <= 0.0 || valNext <= 0.0) { gl_Position = vec4(0.0); return; }
                    } else {
                        if (valThis == 0.0 && valNext == 0.0) { gl_Position = vec4(0.0); return; }
                    }

                    float actualSpacing = uCandleSpacing * uZoom;
                    float topY_A = getScreenY(valThis);
                    float topY_B = getScreenY(valNext);
                    vec2 A = vec2((index * actualSpacing) - uCameraX + (actualSpacing * 0.5), topY_A);
                    vec2 B = vec2(((index + 1.0) * actualSpacing) - uCameraX + (actualSpacing * 0.5), topY_B);

                    vec2 pos = vec2(0.0);
                    if (uIsArea > 0.5) {
                        float isTop = aVertexPosition.y < 0.0 ? 1.0 : 0.0;
                        pos.x = mix(A.x, B.x, aVertexPosition.x);
                        pos.y = mix(uChartHeight, mix(A.y, B.y, aVertexPosition.x), isTop);
                    } else {
                        vec2 dir = B - A;
                        if (length(dir) < 0.0001) { gl_Position = vec4(0.0); return; }
                        vec2 normal = normalize(vec2(-dir.y, dir.x));
                        pos = A + (dir * aVertexPosition.x) + (normal * aVertexPosition.y * uWidth);
                    }

                    vPos = pos;
                    mat3 mvp = uProjectionMatrix * uWorldTransformMatrix;
                    gl_Position = vec4((mvp * vec3(pos, 1.0)).xy, 0.0, 1.0);
                }
            `;

            const fragmentSrc = `
                precision highp float;
                uniform vec4 uLineColor; uniform float uIsOscillator; uniform float uOscY;
                uniform float uOscHeight; uniform float uChartHeight; uniform float uIsArea;
                varying vec2 vPos;

                void main() {
                    if (uIsOscillator > 0.5) {
                        if (vPos.y < uOscY || vPos.y > (uOscY + uOscHeight)) discard;
                    } else {
                        if (vPos.y > uChartHeight || vPos.y < 0.0) discard;
                    }
                    float alpha = uLineColor.a;
                    if (uIsArea > 0.5) alpha *= 0.2;
                    gl_FragColor = vec4(uLineColor.rgb * alpha, alpha);
                }
            `;

            const shader = Shader.from({
                gl: { vertex: vertexSrc, fragment: fragmentSrc },
                resources: { lineUniforms: uniforms }
            });

            const mesh = new Mesh({ geometry: geom, shader });
            entry = { mesh, uniforms, buffer: instBuffer, array: new Float32Array(0), lastSyncedLength: 0, lastSyncedLiveValue: 0, lastSyncedRevision: -1 };
            this.indicatorMeshes.set(id, entry);
        }

        const parent = isOscillator ? this.indicatorOscContainer : this.indicatorMainContainer;
        if (entry.mesh.parent !== parent) {
            parent.addChild(entry.mesh);
        }
        entry.mesh.visible = true;

        const len = this.dataStore.length - 1;
        if (len <= 0) {
            entry.mesh.geometry.instanceCount = 0;
            return;
        }

        const activeInd = this.indicatorManager?.activeIndicators?.find((ind: any) => ind.id === id);
        const currentRevision = activeInd ? activeInd.revision : 0;

        const liveVal = values[len];
        const isRevisionDirty = entry.lastSyncedRevision !== currentRevision;
        const needsCapacityGrowth = entry.array.length < len * 3;
        const isNewBarAppended = (len === entry.lastSyncedLength + 1) && !isRevisionDirty;
        const needsFullSync = isRevisionDirty || needsCapacityGrowth || entry.lastSyncedLength === 0 || (entry.lastSyncedLength !== len && !isNewBarAppended);

        if (needsFullSync) {
            if (entry.array.length < len * 3) {
                entry.array = new Float32Array(Math.max(10000, len * 2) * 3);
            }

            for (let i = 0; i < len; i++) {
                entry.array[i * 3] = i;
                entry.array[i * 3 + 1] = values[i];
                entry.array[i * 3 + 2] = values[i + 1];
            }
            entry.buffer.data = entry.array;
            entry.buffer.update();

            entry.lastSyncedLength = len;
            entry.lastSyncedRevision = currentRevision;
            entry.lastSyncedLiveValue = liveVal;
        } else if (isNewBarAppended) {
            const startIdx = Math.max(0, entry.lastSyncedLength - 1);
            for (let i = startIdx; i < len; i++) {
                entry.array[i * 3] = i;
                entry.array[i * 3 + 1] = values[i];
                entry.array[i * 3 + 2] = values[i + 1];
            }
            const count = len - startIdx;
            entry.buffer.update(count * 12, startIdx * 12);

            entry.lastSyncedLength = len;
            entry.lastSyncedLiveValue = liveVal;
        } else if (entry.lastSyncedLiveValue !== liveVal) {
            const d = (len - 1) * 3;
            entry.array[d + 2] = liveVal;
            entry.buffer.update(12, d * 4);
            entry.lastSyncedLiveValue = liveVal;
        }

        // Uniforms Update
        const u = entry.uniforms.uniforms;
        u.uCameraX = this.cameraX;
        u.uCameraY = this.cameraY;
        u.uZoom = this.zoom;
        u.uCandleSpacing = this.candleSpacing;
        u.uMinPrice = this.currentMinPrice;
        u.uMaxPrice = this.currentMaxPrice;
        u.uChartHeight = layout.mainChartHeight;

        const rC = ((color >> 16) & 0xff) / 255;
        const gC = ((color >> 8) & 0xff) / 255;
        const bC = (color & 0xff) / 255;

        // Safest approach: ensure stable reference, then mutate to bypass PixiJS v8 quirks
        if (!(u.uLineColor instanceof Float32Array) || u.uLineColor.length < 4) {
            u.uLineColor = new Float32Array(4);
        }
        u.uLineColor[0] = rC;
        u.uLineColor[1] = gC;
        u.uLineColor[2] = bC;
        u.uLineColor[3] = alpha; // <-- FIX: Inject dynamic indicator opacity into WebGL Shader

        u.uWidth = width;
        u.uVisStart = Math.floor(this.cameraX / (this.candleSpacing * this.zoom)) - 2;
        u.uVisEnd = Math.floor((this.cameraX + layout.chartWidth) / (this.candleSpacing * this.zoom)) + 2;

        u.uIsOscillator = isOscillator ? 1.0 : 0.0;
        u.uIsArea = isArea ? 1.0 : 0.0;
        if (isOscillator && oscScale) {
            u.uOscY = layout.oscY;
            u.uOscHeight = layout.oscHeight;
            u.uOscMin = oscScale.min;
            u.uOscMax = oscScale.max;
        }

        entry.uniforms.update();
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

        const htf = ['2h', '3h', '4h', '6h', '8h', '12h', '1d', '3d', '1w', '1M'];
        if (htf.includes(this.currentInterval)) {
            this.sessionGeometry.instanceCount = 0;
            return;
        }

        if (this.lastSessionSyncedLength === len && !this.isSessionDirty) return;

        const toRGBA = (hex: number, alpha: number) => [
            ((hex >> 16) & 0xff) / 255, ((hex >> 8) & 0xff) / 255, (hex & 0xff) / 255, alpha
        ];

        const tzOffsetMs = (this.sessionConfig.timezoneOffset || 0) * 3600000;

        // Parse up to 4 sessions
        const sessList: Array<{ enabled: boolean; startMin: number; endMin: number; rgba: number[] }> = [];

        const parseHours = (hStr: string) => {
            if (!hStr) return { start: 0, end: 0 };
            const clean = hStr.replace(/\s+/g, '');
            const parts = clean.split('-');
            if (parts.length !== 2) return { start: 0, end: 0 };
            const parsePart = (p: string) => {
                if (p.includes(':')) {
                    const [h, m] = p.split(':');
                    return (parseInt(h, 10) || 0) * 60 + (parseInt(m, 10) || 0);
                }
                if (p.length === 4) {
                    return (parseInt(p.slice(0, 2), 10) || 0) * 60 + (parseInt(p.slice(2, 4), 10) || 0);
                }
                return (parseInt(p, 10) || 0) * 60;
            };
            return { start: parsePart(parts[0]), end: parsePart(parts[1]) };
        };

        if (this.sessionConfig.sessions && Array.isArray(this.sessionConfig.sessions)) {
            for (const s of this.sessionConfig.sessions) {
                if (s.enabled) {
                    const times = parseHours(s.hours);
                    if (times.start !== times.end) {
                        sessList.push({
                            enabled: true,
                            startMin: times.start,
                            endMin: times.end,
                            rgba: toRGBA(s.color, s.alpha ?? 0.5)
                        });
                    }
                }
            }
        } else {
            // Default 3 sessions (New York, London, Asia)
            const nyColor = toRGBA(this.sessionConfig.nyColor, this.sessionConfig.nyAlpha ?? 0.5);
            const lonColor = toRGBA(this.sessionConfig.londonColor, this.sessionConfig.londonAlpha ?? 0.5);
            const asiaColor = toRGBA(this.sessionConfig.asiaColor, this.sessionConfig.asiaAlpha ?? 0.5);
            sessList.push(
                { enabled: true, startMin: 13 * 60 + 30, endMin: 20 * 60, rgba: nyColor },
                { enabled: true, startMin: 8 * 60, endMin: 16 * 60 + 30, rgba: lonColor },
                { enabled: true, startMin: 0, endMin: 9 * 60, rgba: asiaColor }
            );
        }

        const isMinInSess = (m: number, s: number, e: number) => {
            if (s === e) return false;
            return s < e ? (m >= s && m < e) : (m >= s || m < e);
        };

        const blocks: number[] = [];
        const starts = new Array(sessList.length).fill(-1);

        for (let i = 0; i < len; i++) {
            const ts = this.dataStore.data[i * 6] + tzOffsetMs;
            const minuteOfDay = Math.floor((((ts % 86400000) + 86400000) % 86400000) / 60000);

            for (let sIdx = 0; sIdx < sessList.length; sIdx++) {
                const sess = sessList[sIdx];
                const inSession = isMinInSess(minuteOfDay, sess.startMin, sess.endMin);

                if (inSession && starts[sIdx] === -1) {
                    starts[sIdx] = i;
                } else if (!inSession && starts[sIdx] !== -1) {
                    blocks.push(starts[sIdx], i - 1, ...sess.rgba);
                    starts[sIdx] = -1;
                }
            }
        }

        for (let sIdx = 0; sIdx < sessList.length; sIdx++) {
            if (starts[sIdx] !== -1) {
                blocks.push(starts[sIdx], len - 1, ...sessList[sIdx].rgba);
            }
        }

        // Extend sessions to next opening if enabled
        if (this.sessionConfig.endOnNextOpen && blocks.length > 0) {
            interface RawBlock {
                start: number;
                end: number;
                rgba: number[];
            }
            const rawList: RawBlock[] = [];
            for (let b = 0; b < blocks.length; b += 6) {
                rawList.push({
                    start: blocks[b],
                    end: blocks[b + 1],
                    rgba: [blocks[b + 2], blocks[b + 3], blocks[b + 4], blocks[b + 5]]
                });
            }
            rawList.sort((a, b) => a.start - b.start);

            const getNextPreMarket = (fromTime: number) => {
                let minNext = Infinity;
                const fromLocal = fromTime + tzOffsetMs;
                const fromDayBase = Math.floor(fromLocal / 86400000) * 86400000;
                for (let d = 0; d <= 4; d++) {
                    const dayBase = fromDayBase + (d * 86400000);
                    for (const s of sessList) {
                        const preOpenLocal = dayBase + (s.startMin * 60000) - (15 * 60000);
                        const preOpenUtc = preOpenLocal - tzOffsetMs;
                        if (preOpenUtc > fromTime && preOpenUtc < minNext) {
                            minNext = preOpenUtc;
                        }
                    }
                }
                return minNext === Infinity ? fromTime + (24 * 3600000) : minNext;
            };

            for (let k = 0; k < rawList.length; k++) {
                let nextBoundary = -1;
                for (let j = k + 1; j < rawList.length; j++) {
                    if (rawList[j].start > rawList[k].start) {
                        const nStart = rawList[j].start;
                        const openTime = this.dataStore.data[nStart * 6];
                        let preStart = nStart;
                        for (let p = nStart - 1; p >= Math.max(0, nStart - 60); p--) {
                            const pt = this.dataStore.data[p * 6];
                            if (pt >= openTime - 15 * 60000 && pt < openTime) {
                                preStart = p;
                            } else if (pt < openTime - 15 * 60000) {
                                break;
                            }
                        }
                        nextBoundary = preStart;
                        break;
                    }
                }
                if (nextBoundary !== -1) {
                    rawList[k].end = Math.max(rawList[k].start, nextBoundary - 1);
                } else {
                    // For current/latest session: extend to the time the next pre-market starts
                    const lastBarIdx = len - 1;
                    const lastBarTime = this.dataStore.data[lastBarIdx * 6];
                    const intervalMs = (len >= 2) ? (this.dataStore.data[6] - this.dataStore.data[0]) : 60000;
                    const kOpenTime = this.dataStore.data[rawList[k].start * 6];
                    const checkTime = Math.max(kOpenTime, lastBarTime);
                    const nextPreTime = getNextPreMarket(checkTime);

                    if (nextPreTime > lastBarTime) {
                        const barsAhead = (nextPreTime - lastBarTime) / intervalMs;
                        rawList[k].end = Math.max(rawList[k].end, lastBarIdx + barsAhead);
                    } else {
                        let target = lastBarIdx;
                        for (let p = rawList[k].start; p < len; p++) {
                            if (this.dataStore.data[p * 6] >= nextPreTime) {
                                target = Math.max(rawList[k].start, p - 1);
                                break;
                            }
                        }
                        rawList[k].end = Math.max(rawList[k].end, target);
                    }
                }
            }

            blocks.length = 0;
            for (let k = 0; k < rawList.length; k++) {
                blocks.push(rawList[k].start, rawList[k].end, ...rawList[k].rgba);
            }
        }

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

    private renderInstancedSessions(_mainChartHeight: number, _timeAxisY: number, _width: number, _height: number, _visStart: number, _visEnd: number) {
        this.syncSessionData();

        if (this.sessionGeometry.instanceCount === 0) {
            this.sessionMesh.visible = false;
            return;
        }

        // Chart background shading is completely disabled and removed
        this.sessionMesh.visible = false;
        const u = this.sessionUniforms.uniforms;
        u.uShowOnChart = 0.0;
        u.uShowOnAxis = 0.0;
    }

    /**
     * Standalone Higher Timeframe Overlay Candlestick Renderer
     * - Flat rectangular geometry (zero bubbles / rounded corners)
     * - Pixel-snapped coordinates for razor-sharp edges
     * - Batched GPU draw calls (bull wicks, bear wicks, bull bodies, bear bodies)
     * - Clean proportional candlestick spacing with proper whitespace gap
     * - Strictly uniform candlestick width even when base timeframe does not divide cleanly into HTF
     * - Full-width and perfectly centered current forming candle
     */
    public renderHtfOverlayCandles(
        bars: ResampledHtfBar[],
        showWicks: boolean = true,
        opacity: number = 0.85,
        htfMs?: number,
        chartTfMs?: number
    ): void {
        this.htfOverlayGraphics.clear();
        if (!bars || bars.length === 0) return;

        const sp = this.candleSpacing * this.zoom;
        const chartW = (this.app?.screen?.width || 800) - this.priceAxisWidth;
        const boundedOpacity = Math.max(0.1, Math.min(1.0, opacity));

        const effectiveChartTfMs = chartTfMs || this.parseIntervalMs(this.currentInterval);
        const effectiveHtfMs = htfMs || (bars[0]?.durationMs) || (bars[0]?.expectedBars ? bars[0].expectedBars * effectiveChartTfMs : effectiveChartTfMs);

        // Exact floating-point ratio of HTF duration to chart timeframe.
        // Ensures identical uniform slot & body width for EVERY candle, even when the custom timeframe is not divisible by HTF.
        const exactRatio = (effectiveHtfMs > 0 && effectiveChartTfMs > 0)
            ? (effectiveHtfMs / effectiveChartTfMs)
            : (bars[0]?.exactSpanBars || bars[0]?.expectedBars || 1);

        const uniformSlotW = Math.max(3, exactRatio * sp);

        // Proportional candlestick spacing: keep 28% whitespace gap between bodies.
        // Uniform body width ensures every candle has the exact same thickness.
        const gap = Math.max(2, Math.min(32, Math.round(uniformSlotW * 0.28)));
        const uniformBodyW = Math.max(2, Math.min(Math.round(uniformSlotW - gap), 180));

        interface StraightCandleGeom {
            left: number;
            top: number;
            width: number;
            height: number;
            midX: number;
            highY: number;
            lowY: number;
            isForming: boolean;
        }

        const bullBars: StraightCandleGeom[] = [];
        const bearBars: StraightCandleGeom[] = [];

        for (let i = 0; i < bars.length; i++) {
            const bar = bars[i];
            const isLastBar = (i === bars.length - 1);

            // Center candle precisely at the HTF time bucket midpoint using continuous timeToX:
            let xMid: number;
            if (bar.time !== undefined && effectiveHtfMs > 0) {
                const midTime = bar.time + (effectiveHtfMs * 0.5);
                xMid = Math.round(this.timeToX(midTime));
            } else {
                const startX = (bar.firstChartBar * sp) - this.cameraX;
                xMid = Math.round(startX + (uniformSlotW * 0.5));
            }

            const bodyW = uniformBodyW;
            const bodyLeft = Math.round(xMid - (bodyW * 0.5));

            // Frustum culling: skip bars completely outside visible screen
            if (bodyLeft + bodyW < -40 || bodyLeft > chartW + 40) continue;

            const yOpen = Math.round(this.priceToY(bar.open));
            const yClose = Math.round(this.priceToY(bar.close));
            const yHigh = Math.round(this.priceToY(bar.high));
            const yLow = Math.round(this.priceToY(bar.low));

            const yTop = Math.min(yOpen, yClose);
            const yBot = Math.max(yOpen, yClose);
            const bodyH = Math.max(2, yBot - yTop);

            const isBull = bar.close >= bar.open;
            const geom: StraightCandleGeom = {
                left: bodyLeft,
                top: yTop,
                width: bodyW,
                height: bodyH,
                midX: xMid,
                highY: yHigh,
                lowY: yLow,
                isForming: Boolean(bar.isForming || isLastBar)
            };

            if (isBull) {
                bullBars.push(geom);
            } else {
                bearBars.push(geom);
            }
        }

        const g = this.htfOverlayGraphics;

        // --- BATCH 1: Bull Wicks (Single Draw Call) ---
        if (showWicks && bullBars.length > 0) {
            g.beginPath();
            for (let i = 0; i < bullBars.length; i++) {
                const b = bullBars[i];
                if (b.highY < b.top) {
                    g.moveTo(b.midX, b.highY).lineTo(b.midX, b.top);
                }
                const bot = b.top + b.height;
                if (b.lowY > bot) {
                    g.moveTo(b.midX, bot).lineTo(b.midX, b.lowY);
                }
            }
            g.stroke({ color: this.bullWickColor, width: 1, alpha: 0.95 });
        }

        // --- BATCH 2: Bear Wicks (Single Draw Call) ---
        if (showWicks && bearBars.length > 0) {
            g.beginPath();
            for (let i = 0; i < bearBars.length; i++) {
                const b = bearBars[i];
                if (b.highY < b.top) {
                    g.moveTo(b.midX, b.highY).lineTo(b.midX, b.top);
                }
                const bot = b.top + b.height;
                if (b.lowY > bot) {
                    g.moveTo(b.midX, bot).lineTo(b.midX, b.lowY);
                }
            }
            g.stroke({ color: this.bearWickColor, width: 1, alpha: 0.95 });
        }

        // --- BATCH 3: Bull Bodies (Pure Straight Rectangles, Single Fill & Stroke) ---
        if (bullBars.length > 0) {
            g.beginPath();
            for (let i = 0; i < bullBars.length; i++) {
                const b = bullBars[i];
                g.rect(b.left, b.top, b.width, b.height);
            }
            g.fill({ color: this.bullColor, alpha: boundedOpacity });
            g.stroke({ color: this.bullBorderColor, width: 1, alpha: 1.0 });
        }

        // --- BATCH 4: Bear Bodies (Pure Straight Rectangles, Single Fill & Stroke) ---
        if (bearBars.length > 0) {
            g.beginPath();
            for (let i = 0; i < bearBars.length; i++) {
                const b = bearBars[i];
                g.rect(b.left, b.top, b.width, b.height);
            }
            g.fill({ color: this.bearColor, alpha: boundedOpacity });
            g.stroke({ color: this.bearBorderColor, width: 1, alpha: 1.0 });
        }

        // --- BATCH 5: Subtle Horizontal Equilibrium Midlines for Wide Blocks ---
        g.beginPath();
        let hasMidlines = false;
        const allBars = bullBars.concat(bearBars);
        for (let i = 0; i < allBars.length; i++) {
            const b = allBars[i];
            if (b.width > 40) {
                const yMidline = Math.round((b.highY + b.lowY) * 0.5);
                g.moveTo(b.left + 2, yMidline).lineTo(b.left + b.width - 2, yMidline);
                hasMidlines = true;
            }
        }
        if (hasMidlines) {
            g.stroke({ color: 0xffffff, width: 1, alpha: 0.2 });
        }
    }

    public clearHtfOverlay(): void {
        this.htfOverlayGraphics.clear();
    }
}