import { DataStore } from './data/DataStore';
import { BinanceClient } from './network/BinanceClient';
import { ChartRenderer, type ResampledHtfBar } from './renderer/ChartRenderer';
import { themeManager } from './theme/ThemeManager';
import { THEME_PRESETS } from './theme/presets';
import { colorPicker } from './ui/ColorPicker';
import type { ChartTheme, LineStyle, AccentSource } from './theme/types';
import { IndicatorManager } from './indicators/IndicatorManager';
import {
    SMAIndicator,
    EMAIndicator,
    VolumeIndicator,
    ExhaustionIndicator,
    HTFBoxIndicator,
    HTFBiasIndicator,
    HTFProjectionsIndicator,
    ZigZag123Indicator,
    CBCFlipIndicator,
    PeriodSeparatorIndicator,
    MarketSessionsIndicator,
    MarketStructurePullbackZonesIndicator,
    PullbackDoubleTopBottomIndicator,
    StrictCBCPullbackZonesIndicator,
    StrictCBCZigZagIndicator,
    EmaSmaCrossIndicator
} from './indicators/plugins';

import { DrawingManager, type ToolType } from './tools/DrawingManager';
import { IndicatorRegistry, type SavedIndicatorState } from './indicators/IndicatorRegistry';
import { PriceAxisRenderer } from './renderer/PriceAxisRenderer';
import { TimeAxisRenderer } from './renderer/TimeAxisRenderer';
import { favoritesManager } from './data/FavoritesManager';
import { DataWorkerClient } from './workers/DataWorkerClient';
import { TimeframeResampler } from './data/TimeframeResampler';
export { alertManager } from './alerts/AlertManager';
import { AIExporter, DatasetAuditor, MarketFeatureEngine, CandleContextAggregator, HybridTokenBuilder, MLR1_REPRESENTATION_FEATURE_ALLOWLIST, MLR1_OUTCOME_LABEL_ALLOWLIST, buildRepresentationInput, type MLR1RepresentationFeature, type MLR1EventRow } from './data/AIExporter';
export { AIExporter, DatasetAuditor, MarketFeatureEngine, CandleContextAggregator, HybridTokenBuilder, MLR1_REPRESENTATION_FEATURE_ALLOWLIST, MLR1_OUTCOME_LABEL_ALLOWLIST, buildRepresentationInput, type MLR1RepresentationFeature, type MLR1EventRow };
import { BackgroundDataMiner } from './data/BackgroundDataMiner';
import { AlertUI } from './alerts/AlertUI';
import { runMilestone1AcceptanceSuite } from './test/milestone1-acceptance';
export { runMilestone1AcceptanceSuite };

export interface SavedPaneState {
    symbol: string;
    timeframe: string;
    chartMode: string;
    isAutoScale: boolean;
    candleHtfTimeframe?: string;
    candleHtfCustomMins?: number;
    autoPeekOnClose?: boolean;
    autoPeekCadence?: string;
    autoPeekCustomValue?: number;
    htfOverlayDurationSec?: number;
    showHtfWicks?: boolean;
    htfCandleOpacity?: number;
    showHtfOverlayHud?: boolean;
    indicators: SavedIndicatorState[];
}

export interface SavedWorkspaceState {
    version: number;
    layout: string;
    activePaneIndex: number;
    targetFPS?: number;
    toolbarDockMode?: 'free' | 'top';
    toolbarVisibility?: 'autohide' | 'always';
    toolbarCustomPos?: { left: number; top: number } | null;
    topBarDisplayMode?: 'change' | 'none';
    isAutoHideNav?: boolean;
    isCrosshairSyncEnabled?: boolean;
    showPaintFpsHud?: boolean;
    logPaintFps?: boolean;
    dataLimits?: Record<string, number>;
    sessionConfig?: any;
    clockConfig?: any;
    separatorConfig?: any;
    favoriteSymbols?: string[];
    onlySaveFavorites?: boolean;
    panes: SavedPaneState[];
}

export class EcoChart {
    public dataStore: DataStore;
    public renderer: ChartRenderer;
    public network: BinanceClient;
    public indicatorManager: IndicatorManager;
    public drawingManager: DrawingManager;
    public isDirty = true;
    public isCrosshairDirty = false;
    public canvas: HTMLCanvasElement; // Backward-compatible alias to chartCanvas
    public chartCanvas!: HTMLCanvasElement;
    public priceCanvas!: HTMLCanvasElement;
    public timeCanvas!: HTMLCanvasElement;
    public cornerBox!: HTMLDivElement;
    public overlayLayer!: HTMLDivElement;
    public priceAxisRenderer!: PriceAxisRenderer;
    public timeAxisRenderer!: TimeAxisRenderer;
    public container: HTMLElement;
    public isRunning = true;
    private themeUnsubscribe: (() => void) | null = null;
    private resizeObserver: ResizeObserver | null = null; // <-- ADDED
    private watchdogTimer: any = null;                   // <-- ADDED
    public requestRender: () => void = () => { };

    private lastThemeIsDark: boolean = true;
    private lastWatchdogRecovery = 0;

    // Per-Pane Controls & Legend
    public autoBtn: HTMLButtonElement | null = null;
    public resetBtn: HTMLElement | null = null;
    public navBar: HTMLDivElement | null = null;
    public legendContainer: HTMLDivElement | null = null;
    public paneDrawingToolbar: HTMLDivElement | null = null; // <-- PER-PANE TOOLBAR
    private legendValNodes = new Map<string, HTMLElement>(); // <-- CACHE FOR FAST CROSSHAIR

    // On-Canvas HTF Overlay State & Controls
    public htfOverlayControl: HTMLDivElement | null = null;
    public isHtfOverlayActive = false;
    private htfOverlayTimer: any = null;
    public htfOverlaySecondsRemaining = 0;
    public htfOverlayDurationSec = 30; // 5s to 120s (2m)
    public candleHtfTimeframe: string = 'Off';
    public candleHtfCustomMins: number = 60;
    public autoPeekOnClose: boolean = false;
    public autoPeekCadence: string = 'off'; // 'off' | '1m' | 'custom_m' | '1h' | 'custom_h' | 'htf_close'
    public autoPeekCustomValue: number = 5;
    public showHtfWicks: boolean = true;
    public htfCandleOpacity: number = 0.85;
    public showHtfOverlayHud: boolean = true;
    private lastClosedAutoPeekBucket: number = 0;
    private lastAutoPeekTriggeredBucket: number = 0;

    // Interaction State
    private isDraggingChart = false;
    private isDraggingPriceAxis = false;
    private isDraggingTimeAxis = false;
    private timeAxisAnchorX = 0;
    private timeAxisWorldX = 0;
    private lastMouseX = 0;
    private lastMouseY = 0;
    private isLockedToEdge = true;

    // Mobile Multi-Touch State
    private activeTouches = new Map<number, { x: number; y: number }>();
    private initialPinchDist = 0;
    private initialPinchZoom = 1;

    // Mobile Crosshair State
    private longPressTimeout: any = null;
    private isMobileCrosshairActive = false;
    private touchStartX = 0;
    private touchStartY = 0;
    private touchStartTime = 0;

    // Mobile Touch Drawing State
    public touchDrawingBar: HTMLDivElement | null = null;
    private isTouchDrawingMoved = false;
    private crosshairStartX = 0;
    private crosshairStartY = 0;

    // Active Symbol & Timeframe State
    public currentSymbol = 'BTCUSDT';
    public currentInterval = '1m';
    public currentChangePct = 0;

    constructor(target: string | HTMLElement) {
        const el = typeof target === 'string' ? document.getElementById(target) : target;
        if (!el) throw new Error("Container element not found");
        this.container = el;
        this.container.innerHTML = "";

        // 1. Cell (1, 1): Main Viewport Chart Canvas
        this.chartCanvas = document.createElement('canvas');
        this.chartCanvas.className = 'chart-canvas';
        this.canvas = this.chartCanvas; // Maintain backward compatibility for renderer
        this.container.appendChild(this.chartCanvas);

        // 2. Cell (1, 2): Right Price Axis Canvas (60px)
        this.priceCanvas = document.createElement('canvas');
        this.priceCanvas.className = 'price-axis-canvas';
        this.container.appendChild(this.priceCanvas);

        // 3. Cell (2, 1): Bottom Time Axis Canvas (24px)
        this.timeCanvas = document.createElement('canvas');
        this.timeCanvas.className = 'time-axis-canvas';
        this.container.appendChild(this.timeCanvas);

        // 4. Cell (2, 2): Bottom-Right Corner Box (Houses AUTO button)
        this.cornerBox = document.createElement('div');
        this.cornerBox.className = 'pane-corner-box';
        this.container.appendChild(this.cornerBox);

        // 5. Cell (1, 1): Overlay Container for Legend, Nav Bar, and Toolbar
        this.overlayLayer = document.createElement('div');
        this.overlayLayer.className = 'pane-overlay-layer';
        this.container.appendChild(this.overlayLayer);

        this.dataStore = new DataStore();
        this.renderer = new ChartRenderer(this.dataStore);
        this.network = new BinanceClient(this.dataStore);
        this.indicatorManager = new IndicatorManager();
        this.drawingManager = new DrawingManager();
        this.renderer.indicatorManager = this.indicatorManager; // Link reference

        // Initialize dedicated axis renderers
        this.priceAxisRenderer = new PriceAxisRenderer(this.priceCanvas, this.renderer);
        this.timeAxisRenderer = new TimeAxisRenderer(this.timeCanvas, this.renderer);

        // Build per-pane Auto button and Navigation Bar
        this.createPaneControls();

        // Store observer reference for cleanup
        let lastObservedW = 0;
        let lastObservedH = 0;

        this.resizeObserver = new ResizeObserver(() => {
            const chartRect = this.chartCanvas.getBoundingClientRect();
            const newW = Math.round(chartRect.width);
            const newH = Math.round(chartRect.height);

            // Ignore subpixel jitters on Android WebView (prevents infinite 30 FPS loop)
            if (Math.abs(newW - lastObservedW) < 1 && Math.abs(newH - lastObservedH) < 1) {
                return;
            }

            if (newW > 0 && newH > 0) {
                lastObservedW = newW;
                lastObservedH = newH;
                if (this.renderer.app && this.renderer.app.renderer) {
                    this.renderer.resize(newW, newH);
                    this.isDirty = true;
                    this.priceAxisRenderer.render();
                    this.timeAxisRenderer.render();
                }
            }
        });
        this.resizeObserver.observe(this.container);

        // Listen for Web Worker math completions
        window.addEventListener('ecochart-indicator-ready', () => {
            this.renderer.forceNextRender = true;
            this.isDirty = true;
        });

        // Initialize the tracking variable
        this.lastThemeIsDark = themeManager.getTheme().isDark;

        this.themeUnsubscribe = themeManager.subscribe((theme) => {
            this.renderer.applyTheme(theme);
            const accent = themeManager.getResolvedAccentColor();

            if (this.autoBtn) {
                this.autoBtn.style.color = this.renderer.isAutoScale ? accent : 'var(--chart-text, #787B86)';
            }
            if (this.resetBtn) {
                this.resetBtn.style.color = accent;
            }

            //// ---> 2. CHECK FOR LIGHT/DARK TRANSITION <---
            if (theme.isDark !== this.lastThemeIsDark) {
                this.lastThemeIsDark = theme.isDark;
                const drawingsChanged = this.drawingManager.adaptDrawingsToTheme(theme.isDark);
                if (drawingsChanged) {
                    WorkspaceManager.triggerAutoSave();
                }
            }

            this.updateLegend();
            this.renderer.forceNextRender = true;
            this.isDirty = true;
        });

        this.setupInteractions();
    }

    public showNavBar() {
        if (this.navBar) {
            this.navBar.style.opacity = '1';
            this.navBar.style.pointerEvents = 'auto';
            this.navBar.style.transform = 'translateX(-50%) translateY(0)';
        }
    }

    public hideNavBar() {
        if (this.navBar) {
            this.navBar.style.opacity = '0';
            this.navBar.style.pointerEvents = 'none';
            this.navBar.style.transform = 'translateX(-50%) translateY(6px)';
        }
    }

    public handleWakeup() {
        this.renderer.forceNextRender = true;
        this.isDirty = true;
        this.priceAxisRenderer.render();
        this.timeAxisRenderer.render();
        this.network.handleWakeup();
    }

    private createPaneControls() {
        const accent = themeManager.getResolvedAccentColor();

        // 1. Interactive On-Chart Legend (Top-Left of this pane)
        this.legendContainer = document.createElement('div');
        this.legendContainer.className = 'chart-legend';
        this.legendContainer.style.opacity = '0.15';
        this.legendContainer.style.transition = 'opacity 0.2s cubic-bezier(0.4, 0, 0.2, 1)';
        this.overlayLayer.appendChild(this.legendContainer);

        // 2. Auto-fit button permanently docked in the 60x24 corner box
        this.autoBtn = document.createElement('button');
        this.autoBtn.textContent = 'AUTO';
        this.autoBtn.title = 'Auto-fit scale';
        this.autoBtn.style.cssText = `
            background: transparent;
            color: ${this.renderer.isAutoScale ? accent : 'var(--chart-text, #787B86)'};
            border: none; border-radius: 3px;
            font-size: 11px; font-weight: 700; padding: 2px 6px; cursor: pointer;
            user-select: none; text-transform: uppercase; width: 100%; height: 100%;
            display: flex; align-items: center; justify-content: center;
        `;
        this.autoBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            WorkspaceManager.setActiveChart(this);
            this.toggleAutoScale();
        });
        this.cornerBox.appendChild(this.autoBtn);

        // 3. Floating navigation bar for this pane
        this.navBar = document.createElement('div');
        this.navBar.className = 'pane-nav-bar';
        this.navBar.style.cssText = `
            position: absolute; bottom: 12px; left: 50%; transform: translateX(-50%);
            display: flex; gap: 4px; z-index: 5; user-select: none;
            background: var(--chart-panel-bg, #1e222d);
            border: 1px solid var(--chart-grid, #2A2E39);
            border-radius: 6px; padding: 3px;
            box-shadow: 0 4px 12px rgba(0,0,0,0.4);
            transition: opacity 0.2s cubic-bezier(0.4, 0, 0.2, 1), transform 0.2s cubic-bezier(0.4, 0, 0.2, 1);
        `;

        this.navBar.innerHTML = `
            <button class="nav-btn nav-btn-out" title="Zoom Out">−</button>
            <button class="nav-btn nav-btn-in" title="Zoom In">+</button>
            <button class="nav-btn nav-btn-left" title="Scroll Left">‹</button>
            <button class="nav-btn nav-btn-right" title="Scroll Right">›</button>
            <button class="nav-btn nav-btn-reset" title="Reset / Jump to Live" style="color: ${accent};">↺</button>
        `;

        this.navBar.addEventListener('click', (e) => {
            e.stopPropagation();
            WorkspaceManager.setActiveChart(this);
        });

        this.navBar.querySelector('.nav-btn-out')?.addEventListener('click', () => this.zoomAtCenter(0.8));
        this.navBar.querySelector('.nav-btn-in')?.addEventListener('click', () => this.zoomAtCenter(1.25));
        this.navBar.querySelector('.nav-btn-left')?.addEventListener('click', () => this.scrollHorizontal(-250));
        this.navBar.querySelector('.nav-btn-right')?.addEventListener('click', () => this.scrollHorizontal(250));
        this.navBar.querySelector('.nav-btn-reset')?.addEventListener('click', () => this.jumpToLive());

        this.resetBtn = this.navBar.querySelector('.nav-btn-reset');
        this.overlayLayer.appendChild(this.navBar);

        // Hide initially if auto-hide is enabled
        // 4. Per-Pane Docked Drawing Toolbar (Top Center)
        this.paneDrawingToolbar = document.createElement('div');
        this.paneDrawingToolbar.className = 'pane-drawing-toolbar';
        this.paneDrawingToolbar.style.cssText = `
            position: absolute; top: 10px; left: 50%; transform: translateX(-50%);
            display: ${WorkspaceManager.toolbarDockMode === 'top' ? 'flex' : 'none'}; flex-direction: row; gap: 4px; z-index: 5; user-select: none;
            background: var(--chart-panel-bg, #1e222d); border: 1px solid var(--chart-grid, #363A45);
            border-radius: 6px; padding: 4px; box-shadow: 0 4px 12px rgba(0,0,0,0.4);
            opacity: ${WorkspaceManager.toolbarVisibility === 'always' ? '1' : '0.15'}; transition: opacity 0.2s cubic-bezier(0.4, 0, 0.2, 1);
        `;

        // Simplified robust flat UI for per-pane docks
        this.paneDrawingToolbar.innerHTML = `
            <button class="dt-btn active" data-action="cursor" title="Cursor">🖱️</button>
            <div style="width: 1px; background: var(--chart-grid, #2A2E39); margin: 2px 0;"></div>
            <button class="dt-btn" data-action="trendline" title="Trendline">📉</button>
            <button class="dt-btn" data-action="hray" title="Horizontal Ray">➖</button>
            <button class="dt-btn" data-action="vline" title="Vertical Line">⏸</button>
            <button class="dt-btn" data-action="rect" title="Rectangle">▭</button>
            <button class="dt-btn" data-action="fib" title="Fibonacci">📏</button>
            <button class="dt-btn" data-action="prange" title="Price Range">↕️</button>
            <button class="dt-btn" data-action="text" title="Text Tool" style="font-weight: bold; font-family: serif;">T</button>
            <div style="width: 1px; background: var(--chart-grid, #2A2E39); margin: 2px 0;"></div>
            <button class="dt-btn active" data-action="magnet" title="Magnet Mode">🧲</button>
            <button class="dt-btn" data-action="hide" title="Toggle Drawings">👁️</button>
            <button class="dt-btn" data-action="trash" title="Clear Drawings">🗑️</button>
        `;

        // Prevent canvas panning when clicking tools
        this.paneDrawingToolbar.addEventListener('pointerdown', (e) => e.stopPropagation());
        this.paneDrawingToolbar.addEventListener('touchstart', (e) => e.stopPropagation(), { passive: false });

        this.paneDrawingToolbar.querySelectorAll('.dt-btn').forEach((b) => {
            const btn = b as HTMLElement;
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                WorkspaceManager.setActiveChart(this);
                const action = btn.dataset.action;

                if (action === 'cursor') this.cancelDrawingTool();
                else if (['trendline', 'hray', 'vline', 'rect', 'fib', 'prange', 'text'].includes(action!)) {
                    this.startDrawingTool(action as any);
                } else if (action === 'magnet') {
                    this.drawingManager.isMagnetEnabled = !this.drawingManager.isMagnetEnabled;
                    this.renderer.isMagnetEnabled = this.drawingManager.isMagnetEnabled;
                    btn.classList.toggle('active', this.drawingManager.isMagnetEnabled);
                } else if (action === 'hide') {
                    this.drawingManager.isVisible = !this.drawingManager.isVisible;
                    this.isDirty = true;
                    btn.classList.toggle('active', !this.drawingManager.isVisible);
                } else if (action === 'trash') {
                    if (await WorkspaceManager.confirmAction('Clear Drawings', 'Are you sure you want to remove all drawings from this chart?')) {
                        this.drawingManager.drawings = [];
                        this.drawingManager.currentDrawing = null;
                        this.isDirty = true;
                        WorkspaceManager.triggerAutoSave();
                    }
                }

                // Visually toggle active drawing tool
                if (['cursor', 'trendline', 'hray', 'vline', 'rect', 'fib', 'prange', 'text'].includes(action!)) {
                    this.paneDrawingToolbar!.querySelectorAll('.dt-btn[data-action]').forEach(other => {
                        if (['cursor', 'trendline', 'hray', 'vline', 'rect', 'fib', 'prange', 'text'].includes((other as HTMLElement).dataset.action!)) {
                            other.classList.remove('active');
                        }
                    });
                    btn.classList.add('active');
                }
            });
        });

        this.overlayLayer.appendChild(this.paneDrawingToolbar);

        // 5. On-Canvas HTF Overlay Control (Top-Right of this pane)
        this.createHtfOverlayControl();

        if (WorkspaceManager.isAutoHideNav) this.hideNavBar();

        // Proximity detection: Show Nav Bar, Legend, and Per-Pane Dock
        this.container.addEventListener('pointermove', (e) => {
            const rect = this.container.getBoundingClientRect();
            const distFromBottom = rect.bottom - e.clientY;
            const distFromTop = e.clientY - rect.top;
            const distFromLeft = e.clientX - rect.left;
            const distFromCenterX = Math.abs(e.clientX - (rect.left + rect.width / 2));

            if (this.navBar && WorkspaceManager.isAutoHideNav) {
                if (distFromBottom >= 0 && distFromBottom <= 120 && distFromCenterX <= 180) this.showNavBar();
                else this.hideNavBar();
            }

            if (this.legendContainer) {
                if (distFromTop >= 0 && distFromTop <= 180 && distFromLeft >= 0 && distFromLeft <= 300) this.legendContainer.style.opacity = '1';
                else this.legendContainer.style.opacity = '0.15';
            }

            if (this.paneDrawingToolbar && WorkspaceManager.toolbarDockMode === 'top') {
                if (WorkspaceManager.toolbarVisibility === 'always') {
                    this.paneDrawingToolbar.style.opacity = '1';
                } else if (distFromTop >= 0 && distFromTop <= 60 && distFromCenterX <= 220) {
                    this.paneDrawingToolbar.style.opacity = '1';
                } else {
                    this.paneDrawingToolbar.style.opacity = '0.15';
                }
            }
        });

        this.container.addEventListener('pointerleave', () => {
            if (WorkspaceManager.isAutoHideNav) this.hideNavBar();
            if (this.legendContainer) this.legendContainer.style.opacity = '0.15';
            if (this.paneDrawingToolbar) {
                this.paneDrawingToolbar.style.opacity = WorkspaceManager.toolbarVisibility === 'always' ? '1' : '0.15';
            }
        });
    }

    public destroy() {
        this.isRunning = false;

        // Clean up intervals and observers to allow JS Garbage Collection
        if (this.watchdogTimer) {
            clearInterval(this.watchdogTimer);
            this.watchdogTimer = null;
        }
        if (this.resizeObserver) {
            this.resizeObserver.disconnect();
            this.resizeObserver = null;
        }

        if (this.themeUnsubscribe) {
            this.themeUnsubscribe();
            this.themeUnsubscribe = null;
        }

        try {
            this.network.disconnect();
        } catch (err) {
            console.warn('Network disconnect warning:', err);
        }

        // STOP HTF OVERLAY BEFORE DESTROYING THE RENDERER
        this.stopHtfOverlay(false);

        try {
            this.renderer.destroy();
        } catch (err) {
            console.warn('Renderer destroy warning:', err);
        }

        this.htfOverlayControl?.remove();
        this.autoBtn?.remove();
        this.navBar?.remove();
        this.legendContainer?.remove();
        this.paneDrawingToolbar?.remove();
        this.touchDrawingBar?.remove();
        this.cornerBox?.remove();
        this.overlayLayer?.remove();
        this.chartCanvas?.remove();
        this.priceCanvas?.remove();
        this.timeCanvas?.remove();
    }

    public startDrawingTool(tool: ToolType) {
        this.drawingManager.startTool(tool);
        this.renderer.isCrosshairVisible = true;
        if (this.renderer.crosshairX <= 0 || this.renderer.crosshairY <= 0) {
            this.renderer.crosshairX = Math.round((this.chartCanvas.clientWidth - this.renderer.priceAxisWidth) * 0.5);
            this.renderer.crosshairY = Math.round((this.chartCanvas.clientHeight - this.renderer.timeAxisHeight) * 0.5);
        }
        this.isCrosshairDirty = true;
        this.showTouchDrawingBar();
        this.renderer.forceNextRender = true;
        this.isDirty = true;
    }

    public cancelDrawingTool() {
        this.drawingManager.activeToolType = null;
        this.drawingManager.currentDrawing = null;
        this.hideTouchDrawingBar();
        document.querySelectorAll('.dt-btn').forEach(b => b.classList.remove('active'));
        document.getElementById('tool-cursor')?.classList.add('active');
        if (this.paneDrawingToolbar) {
            this.paneDrawingToolbar.querySelectorAll('.dt-btn[data-action]').forEach(b => b.classList.remove('active'));
            this.paneDrawingToolbar.querySelector('[data-action="cursor"]')?.classList.add('active');
        }
        this.renderer.forceNextRender = true;
        this.isDirty = true;
    }

    public showTouchDrawingBar() {
        if (!this.touchDrawingBar) {
            this.touchDrawingBar = document.createElement('div');
            this.touchDrawingBar.className = 'touch-drawing-bar';
            this.touchDrawingBar.style.cssText = `
                position: absolute; bottom: 20px; left: 50%; transform: translateX(-50%);
                display: flex; align-items: center; gap: 8px; z-index: 15; user-select: none;
                background: var(--chart-panel-bg, #1e222d); border: 1px solid var(--chart-accent, #2962FF);
                border-radius: 24px; padding: 6px 14px; box-shadow: 0 8px 24px rgba(0,0,0,0.6);
                font-family: inherit; font-size: 12px; color: var(--chart-text, #D1D4DC);
                white-space: nowrap; pointer-events: auto;
            `;
            this.touchDrawingBar.addEventListener('touchstart', (e) => e.stopPropagation(), { passive: false });
            this.touchDrawingBar.addEventListener('pointerdown', (e) => e.stopPropagation());
            this.overlayLayer.appendChild(this.touchDrawingBar);
        }

        const toolNames: Record<string, string> = {
            trendline: 'Trendline', rect: 'Rectangle', fib: 'Fibonacci', prange: 'Price Range',
            vline: 'Vertical Line', hray: 'Horizontal Ray', text: 'Text Tool'
        };
        const toolName = toolNames[this.drawingManager.activeToolType || ''] || 'Drawing';
        const isPoint1Placed = this.drawingManager.currentDrawing && this.drawingManager.currentDrawing.points.length > 0;

        this.touchDrawingBar.innerHTML = `
            <span style="font-weight: 600; color: var(--chart-accent, #2962FF); display: flex; align-items: center; gap: 4px;">
                <span>✛</span> ${toolName}
            </span>
            <span style="color: var(--chart-text, #787B86); font-size: 11px;">
                ${isPoint1Placed ? 'Move crosshair & tap Point 2' : 'Move crosshair & tap Point 1'}
            </span>
            <button class="tdb-set-btn" style="
                background: var(--chart-accent, #2962FF); color: #fff; border: none; border-radius: 14px;
                padding: 4px 12px; font-size: 11px; font-weight: 600; cursor: pointer; display: flex; align-items: center; gap: 4px;
            ">
                ${isPoint1Placed ? '✓ Confirm Point 2' : '📍 Set Point 1'}
            </button>
            <button class="tdb-cancel-btn" style="
                background: transparent; color: var(--chart-text, #787B86); border: none; border-radius: 50%;
                width: 22px; height: 22px; cursor: pointer; display: flex; align-items: center; justify-content: center; font-size: 13px;
            " title="Cancel">✕</button>
        `;

        this.touchDrawingBar.querySelector('.tdb-set-btn')?.addEventListener('click', (e) => {
            e.stopPropagation();
            this.confirmTouchDrawingPoint();
        });

        this.touchDrawingBar.querySelector('.tdb-cancel-btn')?.addEventListener('click', (e) => {
            e.stopPropagation();
            this.cancelDrawingTool();
        });

        this.touchDrawingBar.style.display = 'flex';
    }

    public updateTouchDrawingBar() {
        if (!this.drawingManager.activeToolType) return;
        this.showTouchDrawingBar();
    }

    public hideTouchDrawingBar() {
        if (this.touchDrawingBar) {
            this.touchDrawingBar.style.display = 'none';
        }
    }

    public confirmTouchDrawingPoint() {
        if (!this.drawingManager.activeToolType) return;

        // Use the current crosshair position (which is already magnet-snapped if magnet is active)
        const finished = this.drawingManager.onPointerDown(this.renderer, this.renderer.crosshairX, this.renderer.crosshairY, false);
        if (finished) {
            const finishedDrawing = this.drawingManager.drawings[this.drawingManager.drawings.length - 1];
            if (finishedDrawing) {
                this.drawingManager.saveDrawing(finishedDrawing);
                if (finishedDrawing.constructor.name === 'TextDrawing') {
                    WorkspaceManager.openTextEditor(finishedDrawing as any);
                }
            }
            this.hideTouchDrawingBar();

            document.querySelectorAll('.dt-btn').forEach(b => b.classList.remove('active'));
            document.getElementById('tool-cursor')?.classList.add('active');

            if (this.paneDrawingToolbar) {
                this.paneDrawingToolbar.querySelectorAll('.dt-btn[data-action]').forEach(b => b.classList.remove('active'));
                this.paneDrawingToolbar.querySelector('[data-action="cursor"]')?.classList.add('active');
            }
        } else {
            // First point placed, update hint and button for next point!
            this.updateTouchDrawingBar();
        }
        this.renderer.forceNextRender = true;
        this.isDirty = true;
        this.priceAxisRenderer.render();
        this.timeAxisRenderer.render();
    }

    public themeManager = themeManager;

    // Moves the AUTO button to always stay docked to the bottom of the main price axis
    public updateControlsLayout() {
        const oscHeight = this.indicatorManager.getTotalOscillatorHeight();
        const bottomOffset = this.renderer.timeAxisHeight + oscHeight + 4;
        if (this.autoBtn) {
            this.autoBtn.style.bottom = `${bottomOffset}px`;
        }
    }

    // Re-renders the on-chart top-left legend for this specific pane
    public updateLegend() {
        if (!this.legendContainer) return;
        this.legendContainer.innerHTML = '';

        this.indicatorManager.activeIndicators.forEach((ind) => {
            if (ind instanceof PeriodSeparatorIndicator || ind instanceof MarketSessionsIndicator) return;

            const item = document.createElement('div');
            item.className = `legend-item ${ind.visible ? '' : 'dimmed'}`;

            // Color dot (reads primary color param if available)
            const colorParam = ind.params.find(p => p.type === 'color');
            const dotColor = colorParam ? colorParam.value : 'var(--chart-accent, #2962FF)';

            const dot = document.createElement('span');
            dot.style.cssText = `width: 7px; height: 7px; border-radius: 50%; background: ${dotColor}; display: inline-block;`;
            item.appendChild(dot);

            // Title
            const title = document.createElement('span');
            title.textContent = ind.name;
            title.style.cssText = 'font-weight: 600;';
            item.appendChild(title);

            // Live / Historical Value
            const data = ind.getValueAt(this.renderer.getHoverIndex(), this.dataStore, this.renderer.isDarkTheme, this.renderer.axisTextColor);
            const valSpan = document.createElement('span');
            valSpan.className = 'legend-val';
            valSpan.textContent = data.valueStr;
            valSpan.style.color = '#' + data.valueColor.toString(16).padStart(6, '0');
            item.appendChild(valSpan);

            // Save to cache for instant access during crosshair movement
            this.legendValNodes.set(ind.id, valSpan);

            // 👁 / ⊘ Visibility Toggle Button
            const eyeBtn = document.createElement('button');
            eyeBtn.className = 'legend-btn';
            eyeBtn.innerHTML = ind.visible ? '👁' : '⊘';
            eyeBtn.title = ind.visible ? 'Hide' : 'Show';
            eyeBtn.onclick = (e) => {
                e.stopPropagation();
                ind.visible = !ind.visible;
                this.renderer.forceNextRender = true; // Bypass Eco-Mode throttle
                this.indicatorManager.update(this.dataStore);
                this.updateControlsLayout();
                this.updateLegend();
                this.isDirty = true;
                WorkspaceManager.triggerAutoSave();
            };
            item.appendChild(eyeBtn);

            // ⚙️ Settings Button (Opens modal directly into settings for this indicator)
            const settingsBtn = document.createElement('button');
            settingsBtn.className = 'legend-btn';
            settingsBtn.innerHTML = '⚙️';
            settingsBtn.title = 'Settings';
            settingsBtn.onclick = (e) => {
                e.stopPropagation();
                WorkspaceManager.openIndicatorSettings(this, ind);
            };
            item.appendChild(settingsBtn);

            // ✕ Remove Button
            const removeBtn = document.createElement('button');
            removeBtn.className = 'legend-btn btn-remove';
            removeBtn.innerHTML = '✕';
            removeBtn.title = 'Remove';
            removeBtn.onclick = (e) => {
                e.stopPropagation();
                this.renderer.removeIndicatorMesh(ind.id); // <-- Free GPU buffer
                this.indicatorManager.removeIndicator(ind.id);
                this.indicatorManager.update(this.dataStore);
                this.updateControlsLayout();
                this.updateLegend();
                this.isDirty = true;
                WorkspaceManager.triggerAutoSave();
            };
            item.appendChild(removeBtn);

            this.legendContainer!.appendChild(item);
        });

        // Synchronize on-canvas HTF overlay control with active indicators
        this.updateHtfOverlayControl();
    }

    /**
     * Fast-path: updates numbers in top-left legend on crosshair move without DOM rebuilds
     */
    public updateLegendValues() {
        if (!this.legendContainer) return;
        const targetIdx = this.renderer.getHoverIndex();

        this.indicatorManager.activeIndicators.forEach((ind) => {
            const valSpan = this.legendValNodes.get(ind.id);
            if (valSpan) {
                const data = ind.getValueAt(targetIdx, this.dataStore, this.renderer.isDarkTheme, this.renderer.axisTextColor);
                if (valSpan.textContent !== data.valueStr) { // Only update DOM if changed
                    valSpan.textContent = data.valueStr;
                    valSpan.style.color = '#' + data.valueColor.toString(16).padStart(6, '0');
                }
            }
        });
    }

    public createHtfOverlayControl() {
        if (this.htfOverlayControl) return;

        this.htfOverlayControl = document.createElement('div');
        this.htfOverlayControl.className = 'pane-htf-overlay-control';
        this.htfOverlayControl.style.cssText = `
            position: absolute; top: 10px; right: 10px;
            display: none; align-items: center; gap: 8px; z-index: 10; user-select: none;
            background: var(--chart-panel-bg, rgba(22, 26, 37, 0.92));
            backdrop-filter: blur(8px);
            border: 1px solid var(--chart-grid, #2A2E39);
            border-radius: 8px; padding: 5px 9px;
            box-shadow: 0 4px 16px rgba(0,0,0,0.45);
            font-family: inherit; font-size: 11px; color: var(--chart-text, #D1D4DC);
            pointer-events: auto; transition: all 0.2s ease;
        `;

        this.htfOverlayControl.addEventListener('pointerdown', (e) => e.stopPropagation());
        this.htfOverlayControl.addEventListener('touchstart', (e) => e.stopPropagation(), { passive: false });

        this.overlayLayer.appendChild(this.htfOverlayControl);
        this.updateHtfOverlayControl();
    }

    public getEffectiveHtfMs(): number {
        if (this.candleHtfTimeframe !== 'Off') {
            if (this.candleHtfTimeframe === 'Custom') {
                return Math.max(60000, this.candleHtfCustomMins * 60000);
            }
            return TimeframeResampler.parseMs(this.candleHtfTimeframe.toLowerCase());
        }
        return 0;
    }

    public getResampledHtfBars(): ResampledHtfBar[] {
        const effectiveMs = this.getEffectiveHtfMs();
        const chartTfMs = this.renderer.parseIntervalMs(this.currentInterval);
        if (effectiveMs <= chartTfMs || this.dataStore.length === 0) return [];

        const exactSpanBars = effectiveMs / chartTfMs;
        const expectedBarsPerBucket = Math.max(1, Math.round(exactSpanBars));
        const data = this.dataStore.data;
        const len = this.dataStore.length;
        const bars: ResampledHtfBar[] = [];

        let currBucketTime = -1;
        let currBar: ResampledHtfBar | null = null;

        for (let i = 0; i < len; i++) {
            const base = i * 6;
            const t = data[base];
            const o = data[base + 1];
            const h = data[base + 2];
            const l = data[base + 3];
            const c = data[base + 4];

            const bTime = TimeframeResampler.getBucketStart(t, effectiveMs);
            if (bTime !== currBucketTime) {
                currBucketTime = bTime;
                currBar = {
                    time: bTime,
                    open: o,
                    high: h,
                    low: l,
                    close: c,
                    firstChartBar: i,
                    lastChartBar: i,
                    expectedBars: expectedBarsPerBucket,
                    exactSpanBars: exactSpanBars,
                    durationMs: effectiveMs,
                    isForming: false
                };
                bars.push(currBar);
            } else if (currBar) {
                currBar.lastChartBar = i;
                currBar.close = c;
                if (h > currBar.high) currBar.high = h;
                if (l < currBar.low) currBar.low = l;
            }
        }

        if (bars.length > 0) {
            bars[bars.length - 1].isForming = true;
        }

        return bars;
    }

    public setCandleHtfTimeframe(tf: string, customMins?: number) {
        this.candleHtfTimeframe = tf;
        if (customMins !== undefined) this.candleHtfCustomMins = customMins;

        if (tf === 'Off') {
            if (this.isHtfOverlayActive) {
                this.stopHtfOverlay(false);
            }
            this.autoPeekCadence = 'off';
            this.autoPeekOnClose = false;
        } else {
            // Check if current autoPeekCadence is compatible with the new HTF
            const available = this.getAvailableAutoPeekOptions();
            const exists = available.some(o => o.value === this.autoPeekCadence);
            if (!exists && this.autoPeekCadence !== 'off') {
                this.autoPeekCadence = '1m';
            }
            this.autoPeekOnClose = this.autoPeekCadence !== 'off';
        }

        // Reset bucket tracking on timeframe change
        this.lastClosedAutoPeekBucket = 0;
        this.lastAutoPeekTriggeredBucket = 0;

        this.updateHtfOverlayControl();
        this.renderer.forceNextRender = true;
        this.renderer.isHistoricalDirty = true;
        this.isDirty = true;
    }

    public getAvailableAutoPeekOptions(): { value: string; label: string }[] {
        const htfMs = this.getEffectiveHtfMs();
        const chartTfMs = this.renderer.parseIntervalMs(this.currentInterval);
        const htfLabel = this.candleHtfTimeframe === 'Custom' ? `${this.candleHtfCustomMins}m` : this.candleHtfTimeframe;

        const options: { value: string; label: string }[] = [
            { value: 'off', label: 'Auto: Off' }
        ];

        if (htfMs <= chartTfMs || this.candleHtfTimeframe === 'Off') {
            return options;
        }

        // 1. Every 1 Minute close (unique requested feature)
        if (htfMs > 60000) {
            options.push({ value: '1m', label: 'Every 1m Close' });
        }

        // 2. Custom minutes
        options.push({ value: 'custom_m', label: 'Custom Minutes' });

        // 3. Intermediate standard intervals that make sense for this HTF
        if (htfMs >= 15 * 60000 && htfMs > 3 * 60000) {
            options.push({ value: '3m', label: 'Every 3m Close' });
        }
        if (htfMs >= 15 * 60000 && htfMs > 5 * 60000) {
            options.push({ value: '5m', label: 'Every 5m Close' });
        }
        if (htfMs >= 60 * 60000 && htfMs > 15 * 60000) {
            options.push({ value: '15m', label: 'Every 15m Close' });
        }
        if (htfMs >= 60 * 60000 && htfMs > 30 * 60000) {
            options.push({ value: '30m', label: 'Every 30m Close' });
        }

        // 4. Hourly options if HTF is >= 2 hours
        if (htfMs > 3600000) {
            options.push({ value: '1h', label: 'Every 1h Close' });
        }
        if (htfMs >= 4 * 3600000) {
            options.push({ value: 'custom_h', label: 'Custom Hours' });
        }

        // 5. On HTF close itself
        options.push({ value: 'htf_close', label: `On HTF Close (${htfLabel})` });

        return options;
    }

    public getAutoPeekCadenceMs(): number {
        if (this.autoPeekCadence === 'off') return 0;
        if (this.autoPeekCadence === '1m') return 60000;
        if (this.autoPeekCadence === '3m') return 3 * 60000;
        if (this.autoPeekCadence === '5m') return 5 * 60000;
        if (this.autoPeekCadence === '15m') return 15 * 60000;
        if (this.autoPeekCadence === '30m') return 30 * 60000;
        if (this.autoPeekCadence === '1h') return 3600000;
        if (this.autoPeekCadence === 'custom_m') return Math.max(1, this.autoPeekCustomValue) * 60000;
        if (this.autoPeekCadence === 'custom_h') return Math.max(1, this.autoPeekCustomValue) * 3600000;
        if (this.autoPeekCadence === 'htf_close') return this.getEffectiveHtfMs();
        return 60000;
    }

    public checkAutoPeekOnClose(timeMs: number): void {
        if (this.autoPeekCadence === 'off') return;

        const cadenceMs = this.getAutoPeekCadenceMs();
        if (cadenceMs <= 0 || this.dataStore.length === 0) return;

        const htfMs = this.getEffectiveHtfMs();
        const chartTfMs = this.renderer.parseIntervalMs(this.currentInterval);
        if (htfMs <= chartTfMs) return;

        const bucketStart = TimeframeResampler.getBucketStart(timeMs, cadenceMs);
        if (this.lastClosedAutoPeekBucket === 0) {
            this.lastClosedAutoPeekBucket = bucketStart;
            return;
        }

        if (bucketStart > this.lastClosedAutoPeekBucket) {
            const closedPeriod = this.lastClosedAutoPeekBucket;
            this.lastClosedAutoPeekBucket = bucketStart;

            if (this.lastAutoPeekTriggeredBucket !== closedPeriod) {
                this.lastAutoPeekTriggeredBucket = closedPeriod;
                console.log(`[EcoChart] Auto-peek triggered (${this.autoPeekCadence}, ${cadenceMs / 1000}s cadence) on close at ${new Date(closedPeriod).toISOString()}`);
                this.startHtfOverlay(this.htfOverlayDurationSec);
            }
        }
    }

    public updateHtfOverlayControl() {
        if (!this.htfOverlayControl) return;

        const chartTfMs = this.renderer.parseIntervalMs(this.currentInterval);
        const effectiveMs = this.getEffectiveHtfMs();

        // If on-canvas HUD is disabled in settings, or no HTF is selected, hide the control
        if (!this.showHtfOverlayHud || this.candleHtfTimeframe === 'Off' || effectiveMs <= chartTfMs) {
            if (this.candleHtfTimeframe === 'Off' || effectiveMs <= chartTfMs) {
                if (this.isHtfOverlayActive) {
                    this.stopHtfOverlay(false);
                }
            }
            this.htfOverlayControl.style.display = 'none';
            return;
        }

        // Build available timeframes for direct switching from the HUD
        const availableTfs = ['1m', '3m', '5m', '15m', '30m', '45m', '1h', '2h', '3h', '4h', '6h', '8h', '12h', '1d', '3d', '1w'];
        let tfOptionsHtml = '';
        for (const tf of availableTfs) {
            const tfMs = TimeframeResampler.parseMs(tf);
            if (tfMs > chartTfMs) {
                const isSel = this.candleHtfTimeframe === tf ? 'selected' : '';
                tfOptionsHtml += `<option value="${tf}" ${isSel}>${tf}</option>`;
            }
        }
        const customSel = this.candleHtfTimeframe === 'Custom' ? 'selected' : '';
        tfOptionsHtml += `<option value="Custom" ${customSel}>Custom (${this.candleHtfCustomMins}m)</option>`;

        this.htfOverlayControl.style.display = 'flex';

        if (this.isHtfOverlayActive) {
            // Active overlay state: show countdown & Exit button
            const mins = Math.floor(this.htfOverlaySecondsRemaining / 60);
            const secs = this.htfOverlaySecondsRemaining % 60;
            const timeStr = `${mins}:${secs.toString().padStart(2, '0')}`;

            this.htfOverlayControl.style.borderColor = 'var(--chart-accent, #2962FF)';
            this.htfOverlayControl.style.boxShadow = '0 0 14px rgba(41, 98, 255, 0.45)';

            this.htfOverlayControl.innerHTML = `
                <div style="display: flex; align-items: center; gap: 6px;">
                    <span style="display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: #00E676; box-shadow: 0 0 8px #00E676;"></span>
                    <span style="font-weight: 700; color: #fff;">HTF</span>
                    <select class="htf-hud-tf-select" style="
                        background: var(--chart-bg, #131722); color: #00E676;
                        border: 1px solid rgba(0, 230, 118, 0.4); border-radius: 4px;
                        padding: 1px 4px; font-size: 10px; font-weight: 700; cursor: pointer; outline: none;
                    " title="Switch Higher Timeframe">
                        ${tfOptionsHtml}
                    </select>
                    <span style="font-size: 11px; font-family: monospace; font-weight: 700; color: #00E676; background: rgba(0, 230, 118, 0.15); padding: 1px 6px; border-radius: 4px;">${timeStr}</span>
                </div>
                <span style="color: var(--chart-text, #787B86); font-size: 10px;">Candles Hidden</span>
                <button class="htf-btn-exit" style="
                    background: rgba(239, 83, 80, 0.15); color: #EF5350; border: 1px solid #EF5350;
                    border-radius: 4px; padding: 2px 8px; font-size: 11px; font-weight: 600; cursor: pointer;
                " title="Restore Current Candlesticks">Exit</button>
            `;

            this.htfOverlayControl.querySelector('.htf-btn-exit')?.addEventListener('click', (e) => {
                e.stopPropagation();
                this.stopHtfOverlay(false);
            });

            this.htfOverlayControl.querySelector('.htf-hud-tf-select')?.addEventListener('change', (e) => {
                e.stopPropagation();
                const newTf = (e.target as HTMLSelectElement).value;
                this.setCandleHtfTimeframe(newTf, this.candleHtfCustomMins);
                const settingsTfSel = document.getElementById('select-candle-htf-timeframe') as HTMLSelectElement | null;
                if (settingsTfSel) settingsTfSel.value = newTf;
                WorkspaceManager.triggerAutoSave();
            });
        } else {
            // Idle state: Clean Header + Timeframe Selector + Auto-Peek Option + Duration Selector + Peek Button
            this.htfOverlayControl.style.borderColor = 'var(--chart-grid, #2A2E39)';
            this.htfOverlayControl.style.boxShadow = '0 4px 16px rgba(0,0,0,0.45)';

            const durationOptions = [
                { sec: 5, label: '5s' },
                { sec: 10, label: '10s' },
                { sec: 15, label: '15s' },
                { sec: 20, label: '20s' },
                { sec: 30, label: '30s' },
                { sec: 45, label: '45s' },
                { sec: 60, label: '1m' },
                { sec: 90, label: '90s' },
                { sec: 120, label: '2m' }
            ];

            let durOptionsHtml = '';
            for (const opt of durationOptions) {
                const sel = opt.sec === this.htfOverlayDurationSec ? 'selected' : '';
                durOptionsHtml += `<option value="${opt.sec}" ${sel}>${opt.label}</option>`;
            }

            const autoPeekOptions = this.getAvailableAutoPeekOptions();
            let autoOptionsHtml = '';
            for (const opt of autoPeekOptions) {
                const sel = opt.value === this.autoPeekCadence ? 'selected' : '';
                autoOptionsHtml += `<option value="${opt.value}" ${sel}>${opt.label}</option>`;
            }

            const isAutoActive = this.autoPeekCadence !== 'off';
            const isCustomSelected = this.autoPeekCadence === 'custom_m' || this.autoPeekCadence === 'custom_h';
            const customUnit = this.autoPeekCadence === 'custom_h' ? 'h' : 'm';
            const customInputHtml = isCustomSelected
                ? `<input type="number" class="htf-hud-custom-val" value="${this.autoPeekCustomValue}" min="1" max="1440" style="width: 34px; background: var(--chart-bg, #131722); color: var(--chart-text, #D1D4DC); border: 1px solid var(--chart-grid, #363A45); border-radius: 3px; padding: 1px 2px; font-size: 10px; text-align: center; outline: none;" title="Custom interval in ${customUnit}"><span style="font-size: 10px; color: #787B86;">${customUnit}</span>`
                : '';

            this.htfOverlayControl.innerHTML = `
                <div style="display: flex; align-items: center; gap: 5px;">
                    <span style="font-weight: 700; color: var(--chart-accent, #2962FF); letter-spacing: 0.3px;">HTF</span>
                    <select class="htf-hud-tf-select" style="
                        background: var(--chart-bg, #131722); color: var(--chart-accent, #2962FF);
                        border: 1px solid var(--chart-grid, #363A45); border-radius: 4px;
                        padding: 1px 4px; font-size: 10px; font-weight: 700; cursor: pointer; outline: none;
                    " title="Switch Higher Timeframe">
                        ${tfOptionsHtml}
                    </select>
                </div>
                <div style="display: flex; align-items: center; gap: 4px; border-left: 1px solid var(--chart-grid, #2A2E39); padding-left: 6px;">
                    <span style="color: ${isAutoActive ? '#00E676' : 'var(--chart-text, #787B86)'}; font-size: 10px; font-weight: 600; display: flex; align-items: center; gap: 3px;">
                        ${isAutoActive ? '<span style="width: 6px; height: 6px; border-radius: 50%; background: #00E676; box-shadow: 0 0 5px #00E676;"></span>' : ''}
                        Auto:
                    </span>
                    <select class="htf-hud-autopeek-select" style="
                        background: var(--chart-bg, #131722); color: ${isAutoActive ? '#00E676' : 'var(--chart-text, #D1D4DC)'};
                        border: 1px solid ${isAutoActive ? 'rgba(0, 230, 118, 0.5)' : 'var(--chart-grid, #363A45)'}; border-radius: 4px;
                        padding: 1px 4px; font-size: 10px; cursor: pointer; outline: none;
                    " title="Auto-Peek cadence depending on selected HTF">
                        ${autoOptionsHtml}
                    </select>
                    ${customInputHtml}
                </div>
                <div style="display: flex; align-items: center; gap: 4px; border-left: 1px solid var(--chart-grid, #2A2E39); padding-left: 6px;">
                    <select class="htf-duration-select" style="
                        background: var(--chart-bg, #131722); color: var(--chart-text, #D1D4DC);
                        border: 1px solid var(--chart-grid, #363A45); border-radius: 4px;
                        padding: 1px 4px; font-size: 10px; cursor: pointer; outline: none;
                    " title="Select Overlay Duration (5s to 2m)">
                        ${durOptionsHtml}
                    </select>
                    <button class="htf-btn-overlay" style="
                        background: var(--chart-accent, #2962FF); color: #fff; border: none;
                        border-radius: 4px; padding: 2px 9px; font-size: 10px; font-weight: 600; cursor: pointer; display: flex; align-items: center; gap: 3px;
                    " title="Peek HTF overlay and hide current candlesticks"><span>⚡</span><span>Peek</span></button>
                </div>
            `;

            const tfSel = this.htfOverlayControl.querySelector('.htf-hud-tf-select') as HTMLSelectElement | null;
            const autoSel = this.htfOverlayControl.querySelector('.htf-hud-autopeek-select') as HTMLSelectElement | null;
            const customValInput = this.htfOverlayControl.querySelector('.htf-hud-custom-val') as HTMLInputElement | null;
            const sel = this.htfOverlayControl.querySelector('.htf-duration-select') as HTMLSelectElement | null;
            const btn = this.htfOverlayControl.querySelector('.htf-btn-overlay') as HTMLButtonElement | null;

            tfSel?.addEventListener('change', (e) => {
                e.stopPropagation();
                const newTf = (e.target as HTMLSelectElement).value;
                this.setCandleHtfTimeframe(newTf, this.candleHtfCustomMins);
                const settingsTfSel = document.getElementById('select-candle-htf-timeframe') as HTMLSelectElement | null;
                if (settingsTfSel) settingsTfSel.value = newTf;
                WorkspaceManager.triggerAutoSave();
            });

            autoSel?.addEventListener('change', (e) => {
                e.stopPropagation();
                const newCadence = (e.target as HTMLSelectElement).value;
                this.autoPeekCadence = newCadence;
                this.autoPeekOnClose = newCadence !== 'off';
                this.lastClosedAutoPeekBucket = 0;
                this.lastAutoPeekTriggeredBucket = 0;
                this.updateHtfOverlayControl();
                WorkspaceManager.syncModalInputs();
                WorkspaceManager.triggerAutoSave();
            });

            customValInput?.addEventListener('input', (e) => {
                e.stopPropagation();
                const val = parseInt((e.target as HTMLInputElement).value, 10) || 5;
                this.autoPeekCustomValue = Math.max(1, Math.min(1440, val));
                this.lastClosedAutoPeekBucket = 0;
                this.lastAutoPeekTriggeredBucket = 0;
                WorkspaceManager.syncModalInputs();
                WorkspaceManager.triggerAutoSave();
            });

            sel?.addEventListener('change', (e) => {
                e.stopPropagation();
                const newDur = parseInt((e.target as HTMLSelectElement).value, 10) || 30;
                this.htfOverlayDurationSec = Math.max(5, Math.min(120, newDur));
                const settingsDurSel = document.getElementById('select-candle-peek-duration') as HTMLSelectElement | null;
                if (settingsDurSel) settingsDurSel.value = String(this.htfOverlayDurationSec);
                WorkspaceManager.triggerAutoSave();
            });

            btn?.addEventListener('click', (e) => {
                e.stopPropagation();
                const dur = sel ? parseInt(sel.value, 10) : this.htfOverlayDurationSec;
                this.startHtfOverlay(dur);
            });
        }
    }

    public startHtfOverlay(durationSec?: number) {
        const dur = durationSec || this.htfOverlayDurationSec || 30;
        this.htfOverlayDurationSec = Math.max(5, Math.min(120, dur));
        this.htfOverlaySecondsRemaining = this.htfOverlayDurationSec;
        this.isHtfOverlayActive = true;

        // Synchronize HTF state with renderer for PriceAxisRenderer countdown display
        this.renderer.isHtfOverlayActive = true;
        this.renderer.htfOverlayTfLabel = this.candleHtfTimeframe === 'Custom' ? `${this.candleHtfCustomMins}m` : this.candleHtfTimeframe;
        this.renderer.htfEffectiveMs = this.getEffectiveHtfMs();

        // 1. Hide current candlesticks
        this.renderer.hideCandles = true;
        this.renderer.forceNextRender = true;
        this.renderer.isHistoricalDirty = true;
        this.isDirty = true;

        // 2. Clear existing timer if any
        if (this.htfOverlayTimer) clearInterval(this.htfOverlayTimer);

        // 3. Start countdown
        this.htfOverlayTimer = setInterval(() => {
            this.htfOverlaySecondsRemaining--;
            if (this.htfOverlaySecondsRemaining <= 0) {
                this.stopHtfOverlay(true);
            } else {
                this.updateHtfOverlayControl();
                this.priceAxisRenderer.updateCountdownOnly();
            }
        }, 1000);

        this.priceAxisRenderer.render();
        this.updateHtfOverlayControl();
    }

    public stopHtfOverlay(_showNotice = false) {
        if (this.htfOverlayTimer) {
            clearInterval(this.htfOverlayTimer);
            this.htfOverlayTimer = null;
        }

        this.isHtfOverlayActive = false;
        this.renderer.isHtfOverlayActive = false;
        this.renderer.htfEffectiveMs = 0;
        this.renderer.hideCandles = false;
        this.renderer.clearHtfOverlay();
        this.renderer.forceNextRender = true;
        this.renderer.isHistoricalDirty = true;
        this.isDirty = true;

        this.priceAxisRenderer.render();
        this.updateHtfOverlayControl();
    }

    private setupInteractions() {
        // --- AXIS DETECTION & PANNING (Desktop / Mouse Only) ---
        this.canvas.addEventListener('pointerdown', (e) => {
            if (e.pointerType === 'touch') return; // Let touch listeners handle mobile
            const rect = this.canvas.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const y = e.clientY - rect.top;

            if (this.drawingManager.activeToolType) {
                // Pass e.shiftKey so the final click snaps to straight lines
                const finished = this.drawingManager.onPointerDown(this.renderer, x, y, e.shiftKey);
                if (finished) {
                    const finishedDrawing = this.drawingManager.drawings[this.drawingManager.drawings.length - 1];

                    if (finishedDrawing) this.drawingManager.saveDrawing(finishedDrawing);

                    // If we just placed a Text tool, open the editor modal immediately!
                    if (finishedDrawing && finishedDrawing.constructor.name === 'TextDrawing') {
                        WorkspaceManager.openTextEditor(finishedDrawing as any);
                    }
                    this.hideTouchDrawingBar();

                    document.querySelectorAll('.dt-btn').forEach(b => b.classList.remove('active'));
                    document.getElementById('tool-cursor')?.classList.add('active');

                    if (this.paneDrawingToolbar) {
                        this.paneDrawingToolbar.querySelectorAll('.dt-btn[data-action]').forEach(b => b.classList.remove('active'));
                        this.paneDrawingToolbar.querySelector('[data-action="cursor"]')?.classList.add('active');
                    }
                } else {
                    this.updateTouchDrawingBar();
                }
                this.isDirty = true;
                return;
            }

            // Phase 3 & 4: Selection Hit Test (Desktop)
            const hitResult = this.drawingManager.trySelect(this.renderer, x, y);
            if (hitResult) {
                const hitDrawing = hitResult.drawing;
                this.drawingManager.drawings.forEach(d => d.state = 'idle');
                hitDrawing.state = 'selected';
                this.drawingManager.selectedDrawing = hitDrawing;

                // If they grabbed a circle handle, start dragging!
                if (hitResult.part === 'handle_0') { this.drawingManager.draggingHandle = 0; return; }
                if (hitResult.part === 'handle_1') { this.drawingManager.draggingHandle = 1; return; }
                this.isDirty = true;

                // If clicking a Text tool, open Text Modal instead of ColorPicker!
                if (hitDrawing.constructor.name === 'TextDrawing') {
                    WorkspaceManager.openTextEditor(hitDrawing as any);
                    return;
                }

                // Spawn a tiny invisible anchor for the ColorPicker at mouse coordinates
                const anchor = document.createElement('div');
                anchor.style.position = 'absolute';
                anchor.style.left = `${e.clientX}px`;
                anchor.style.top = `${e.clientY}px`;
                document.body.appendChild(anchor);

                colorPicker.open({
                    anchorElement: anchor,
                    initialColor: '#' + hitDrawing.color.toString(16).padStart(6, '0'),
                    initialOpacity: hitDrawing.alpha,
                    initialThickness: hitDrawing.width,
                    initialStyle: hitDrawing.style,
                    showOpacity: true,
                    showStrokeOptions: true,
                    onDelete: () => {
                        this.drawingManager.deleteDrawing(hitDrawing.id); // Delete from DB
                        this.drawingManager.drawings = this.drawingManager.drawings.filter(d => d !== hitDrawing);
                        this.drawingManager.selectedDrawing = null;
                        this.isDirty = true;
                        WorkspaceManager.triggerAutoSave();
                    },
                    onChange: (res) => {
                        hitDrawing.color = parseInt(res.color.replace('#', ''), 16);
                        hitDrawing.alpha = res.opacity;
                        hitDrawing.width = res.thickness || hitDrawing.width;
                        hitDrawing.style = res.style || hitDrawing.style;
                        this.isDirty = true;

                        this.drawingManager.saveDrawing(hitDrawing);

                        WorkspaceManager.triggerAutoSave();
                    }
                });

                setTimeout(() => anchor.remove(), 100); // cleanup DOM
                return; // Stop panning
            } else {
                // Missed! Clear selection and close color picker if open
                this.drawingManager.drawings.forEach(d => d.state = 'idle');
                this.drawingManager.selectedDrawing = null;
                colorPicker.close();
                this.isDirty = true;
            }

            this.isDraggingChart = true;
            this.lastMouseX = e.clientX;
            this.lastMouseY = e.clientY;
            this.canvas.setPointerCapture(e.pointerId);
        });

        // Dedicated Price Axis Drag Listener (Desktop)
        this.priceCanvas.addEventListener('pointerdown', (e) => {
            if (e.pointerType === 'touch') return;
            this.isDraggingPriceAxis = true;
            this.lastMouseX = e.clientX;
            this.lastMouseY = e.clientY;
            WorkspaceManager.setActiveChart(this);
            this.priceCanvas.setPointerCapture(e.pointerId);
        });

        // Mobile Touch Engine for Price Axis
        let priceTouchStartY = 0;
        this.priceCanvas.addEventListener('touchstart', (e) => {
            e.preventDefault();
            e.stopPropagation();
            WorkspaceManager.setActiveChart(this);
            if (e.touches.length === 1) {
                this.isDraggingPriceAxis = true;
                priceTouchStartY = e.touches[0].clientY;
            }
        }, { passive: false });

        this.priceCanvas.addEventListener('touchmove', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (!this.isDraggingPriceAxis || e.touches.length === 0) return;
            const clientY = e.touches[0].clientY;
            const deltaY = clientY - priceTouchStartY;
            priceTouchStartY = clientY;

            this.renderer.isAutoScale = false;
            if (this.autoBtn) this.autoBtn.style.color = 'var(--chart-text, #787B86)';

            const canvasHeight = this.chartCanvas.clientHeight || 600;
            const priceRange = this.renderer.currentMaxPrice - this.renderer.currentMinPrice;
            const stretchFactor = deltaY * (priceRange / canvasHeight) * 2;
            const nextMin = this.renderer.currentMinPrice - stretchFactor;
            const nextMax = this.renderer.currentMaxPrice + stretchFactor;
            if (nextMax - nextMin > 0.000001) {
                this.renderer.currentMinPrice = nextMin;
                this.renderer.currentMaxPrice = nextMax;
            }
            this.renderer.forceNextRender = true;
            this.isDirty = true;
            this.priceAxisRenderer.render();
        }, { passive: false });

        const endPriceTouch = (e: TouchEvent) => {
            e.preventDefault();
            this.isDraggingPriceAxis = false;
        };
        this.priceCanvas.addEventListener('touchend', endPriceTouch);
        this.priceCanvas.addEventListener('touchcancel', endPriceTouch);

        // Dedicated Time Axis Drag Listener (Desktop)
        this.timeCanvas.addEventListener('pointerdown', (e) => {
            if (e.pointerType === 'touch') return;
            this.isDraggingTimeAxis = true;
            const chartRect = this.chartCanvas.getBoundingClientRect();
            const localX = e.clientX - chartRect.left;
            this.timeAxisAnchorX = localX;
            this.timeAxisWorldX = (localX + this.renderer.cameraX) / this.renderer.zoom;
            this.lastMouseX = e.clientX;
            this.lastMouseY = e.clientY;
            WorkspaceManager.setActiveChart(this);
            this.timeCanvas.setPointerCapture(e.pointerId);
        });

        // Mobile Touch Engine for Time Axis
        let timeTouchStartX = 0;
        this.timeCanvas.addEventListener('touchstart', (e) => {
            e.preventDefault();
            e.stopPropagation();
            WorkspaceManager.setActiveChart(this);
            if (e.touches.length === 1) {
                this.isDraggingTimeAxis = true;
                const chartRect = this.chartCanvas.getBoundingClientRect();
                const localX = e.touches[0].clientX - chartRect.left;
                this.timeAxisAnchorX = localX;
                this.timeAxisWorldX = (localX + this.renderer.cameraX) / this.renderer.zoom;
                timeTouchStartX = e.touches[0].clientX;
            }
        }, { passive: false });

        this.timeCanvas.addEventListener('touchmove', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (!this.isDraggingTimeAxis || e.touches.length === 0) return;
            const clientX = e.touches[0].clientX;
            const deltaX = clientX - timeTouchStartX;
            timeTouchStartX = clientX;

            this.isLockedToEdge = false;
            const zoomMultiplier = 1 + (deltaX * 0.005);
            this.renderer.zoom = Math.max(0.1, Math.min(this.renderer.zoom * zoomMultiplier, 50));
            this.renderer.cameraX = (this.timeAxisWorldX * this.renderer.zoom) - this.timeAxisAnchorX;
            this.renderer.forceNextRender = true;
            this.isDirty = true;
            this.timeAxisRenderer.render();
        }, { passive: false });

        const endTimeTouch = (e: TouchEvent) => {
            e.preventDefault();
            this.isDraggingTimeAxis = false;
        };
        this.timeCanvas.addEventListener('touchend', endTimeTouch);
        this.timeCanvas.addEventListener('touchcancel', endTimeTouch);

        const handlePointerMove = (e: PointerEvent) => {
            if (e.pointerType === 'touch') return; // Prevent double-speed drag & thumb crosshair
            const rect = this.canvas.getBoundingClientRect();
            this.renderer.crosshairX = e.clientX - rect.left;
            this.renderer.crosshairY = e.clientY - rect.top;
            this.renderer.isCrosshairVisible = true;
            this.isCrosshairDirty = true; // Mark crosshair dirty only (does not redraw candles)
            this.updateLegendValues();

            if (this.drawingManager.activeToolType) {
                // 1. Pass e.shiftKey for New Drawings
                this.drawingManager.onPointerMove(this.renderer, this.renderer.crosshairX, this.renderer.crosshairY, e.shiftKey);
                this.isDirty = true;
                this.renderer.forceNextRender = true; // <-- FIX: Bypass Eco-Mode throttle for smooth drawing
            } else if (this.drawingManager.selectedDrawing && this.drawingManager.draggingHandle !== null) {
                // MODIFING EXISTING DRAWING
                let { time, price } = this.drawingManager.isMagnetEnabled
                    ? this.renderer.getMagnetPoint(this.renderer.crosshairX, this.renderer.crosshairY)
                    : { time: this.renderer.xToTime(this.renderer.crosshairX), price: this.renderer.yToPrice(this.renderer.crosshairY) };

                // 2. Add Shift-Key constraint for MODIFING existing drawings
                if (e.shiftKey && this.drawingManager.selectedDrawing.toolType === 'trendline') {
                    const anchorIdx = this.drawingManager.draggingHandle === 0 ? 1 : 0;
                    const anchorPt = this.drawingManager.selectedDrawing.points[anchorIdx];

                    const startX = this.renderer.timeToX(anchorPt.time);
                    const startY = this.renderer.priceToY(anchorPt.price);
                    let curX = this.renderer.timeToX(time);
                    let curY = this.renderer.priceToY(price);

                    const dx = curX - startX;
                    const dy = curY - startY;
                    const angle = Math.abs(Math.atan2(dy, dx) * 180 / Math.PI);

                    if (angle < 22.5 || angle > 157.5) curY = startY;
                    else if (angle > 67.5 && angle < 112.5) curX = startX;
                    else {
                        const dist = Math.max(Math.abs(dx), Math.abs(dy));
                        curX = startX + Math.sign(dx) * dist;
                        curY = startY + Math.sign(dy) * dist;
                    }

                    time = this.renderer.xToTime(curX);
                    price = this.renderer.yToPrice(curY);
                }

                this.drawingManager.selectedDrawing.points[this.drawingManager.draggingHandle] = { time, price };
                this.isDirty = true;
                this.renderer.forceNextRender = true; // <-- FIX: Bypass Eco-Mode throttle for smooth dragging
                return; // Stop chart from panning
            }

            // Broadcast exact timestamp to other panes
            if (WorkspaceManager.isCrosshairSyncEnabled) {
                const hoverTime = this.renderer.xToTime(this.renderer.crosshairX);
                WorkspaceManager.broadcastCrosshair(hoverTime, this);
            }

            const deltaX = e.clientX - this.lastMouseX;
            const deltaY = e.clientY - this.lastMouseY;

            this.canvas.style.cursor = 'crosshair';

            if (this.isDraggingChart) {
                if (deltaX !== 0) {
                    this.renderer.cameraX -= deltaX;
                    this.isLockedToEdge = false;
                }
                if (!this.renderer.isAutoScale && deltaY !== 0) {
                    this.renderer.cameraY += deltaY;
                }
            } else if (this.isDraggingPriceAxis) {
                this.renderer.isAutoScale = false;
                if (this.autoBtn) this.autoBtn.style.color = 'var(--chart-text, #787B86)';
                const canvasHeight = this.chartCanvas.clientHeight || 600;
                const priceRange = this.renderer.currentMaxPrice - this.renderer.currentMinPrice;
                const stretchFactor = deltaY * (priceRange / canvasHeight) * 2;
                const nextMin = this.renderer.currentMinPrice - stretchFactor;
                const nextMax = this.renderer.currentMaxPrice + stretchFactor;
                if (nextMax - nextMin > 0.000001) {
                    this.renderer.currentMinPrice = nextMin;
                    this.renderer.currentMaxPrice = nextMax;
                }
                this.renderer.forceNextRender = true;
            } else if (this.isDraggingTimeAxis) {
                this.isLockedToEdge = false; // Prevent WebSocket ticks from snapping back
                const zoomMultiplier = 1 + (deltaX * 0.005);
                this.renderer.zoom = Math.max(0.1, Math.min(this.renderer.zoom * zoomMultiplier, 50));
                this.renderer.cameraX = (this.timeAxisWorldX * this.renderer.zoom) - this.timeAxisAnchorX;
                this.renderer.forceNextRender = true;
            }

            if (this.isDraggingChart || this.isDraggingPriceAxis || this.isDraggingTimeAxis) {
                this.lastMouseX = e.clientX;
                this.lastMouseY = e.clientY;
                this.isDirty = true; // Only redraw full chart when actively panning/zooming
            }
        };

        this.canvas.addEventListener('pointermove', handlePointerMove);
        this.priceCanvas.addEventListener('pointermove', handlePointerMove);
        this.timeCanvas.addEventListener('pointermove', handlePointerMove);

        this.canvas.addEventListener('pointerleave', () => {
            this.renderer.isCrosshairVisible = false;
            this.isCrosshairDirty = true;
            this.updateLegendValues(); // Snaps numbers back to live values
            if (WorkspaceManager.isCrosshairSyncEnabled) {
                WorkspaceManager.broadcastCrosshair(null, this);
            }
        });

        const stopDragging = (e: PointerEvent) => {
            if (e.pointerType === 'touch') return;

            // Save modified drawing to DB and reset handle
            if (this.drawingManager.draggingHandle !== null && this.drawingManager.selectedDrawing) {
                this.drawingManager.saveDrawing(this.drawingManager.selectedDrawing);
                this.drawingManager.draggingHandle = null;
            }

            this.isDraggingChart = false;
            this.isDraggingPriceAxis = false;
            this.isDraggingTimeAxis = false;
            try { this.canvas.releasePointerCapture(e.pointerId); } catch { }
            try { this.priceCanvas.releasePointerCapture(e.pointerId); } catch { }
            try { this.timeCanvas.releasePointerCapture(e.pointerId); } catch { }
        };
        this.canvas.addEventListener('pointerup', stopDragging);
        this.canvas.addEventListener('pointercancel', stopDragging);
        this.priceCanvas.addEventListener('pointerup', stopDragging);
        this.priceCanvas.addEventListener('pointercancel', stopDragging);
        this.timeCanvas.addEventListener('pointerup', stopDragging);
        this.timeCanvas.addEventListener('pointercancel', stopDragging);

        this.canvas.addEventListener('dblclick', () => {
            // Re-enables auto-scaling without moving the timeline
            this.toggleAutoScale(true);
        });

        this.canvas.addEventListener('wheel', (e) => {
            e.preventDefault();
            const rect = this.canvas.getBoundingClientRect();
            const mouseX = e.clientX - rect.left;
            const mouseY = e.clientY - rect.top;

            // Define our hit zones
            const chartWidth = this.renderer.app.screen.width - this.renderer.priceAxisWidth;
            const chartHeight = this.renderer.app.screen.height - this.renderer.timeAxisHeight;

            const isHoveringPrice = mouseX > chartWidth;
            const isHoveringTime = mouseY > chartHeight;
            const isHoveringMain = !isHoveringPrice && !isHoveringTime;

            const zoomFactor = Math.pow(1.05, -Math.sign(e.deltaY));

            // 1. Time Axis (X) Zoom: Only if hovering Time Axis OR Main Chart
            if (isHoveringTime || isHoveringMain) {
                const worldBaseX = (mouseX + this.renderer.cameraX) / this.renderer.zoom;
                this.renderer.zoom *= zoomFactor;
                this.renderer.zoom = Math.max(0.1, Math.min(this.renderer.zoom, 50));
                this.renderer.cameraX = (worldBaseX * this.renderer.zoom) - mouseX;
                this.isLockedToEdge = false;
            }

            // 2. Price Axis (Y) Zoom: Only if hovering Price Axis OR (Main Chart + Manual Mode)
            if (isHoveringPrice || (isHoveringMain && !this.renderer.isAutoScale)) {
                // If scrolling specifically on the price axis, force manual mode
                if (isHoveringPrice) {
                    this.renderer.isAutoScale = false;
                    const btnAuto = document.getElementById('btn-auto-fit');
                    if (btnAuto) btnAuto.style.color = 'var(--chart-text, #787B86)';
                }

                const currentRange = this.renderer.currentMaxPrice - this.renderer.currentMinPrice;
                const localY = mouseY - this.renderer.cameraY;
                const normY = (chartHeight - localY) / chartHeight;
                const priceAtMouse = this.renderer.currentMinPrice + (normY * currentRange);

                const newRange = currentRange / zoomFactor;

                this.renderer.currentMinPrice = priceAtMouse - (normY * newRange);
                this.renderer.currentMaxPrice = priceAtMouse + ((1 - normY) * newRange);
            }

            this.isDirty = true;
        }, { passive: false });

        // Keyboard Delete for Drawings
        document.addEventListener('keydown', (e) => {
            if (WorkspaceManager.getActiveChart() !== this) return; // Only process on active pane
            if (e.key === 'Delete' || e.key === 'Backspace') {
                if (this.drawingManager.selectedDrawing) {
                    this.drawingManager.drawings = this.drawingManager.drawings.filter(d => d !== this.drawingManager.selectedDrawing);
                    this.drawingManager.selectedDrawing = null;
                    colorPicker.close();
                    this.isDirty = true;
                    WorkspaceManager.triggerAutoSave();
                }
            }
        });

        // ==========================================================
        // 📱 MOBILE MULTI-TOUCH ENGINE (Pinch-to-Zoom & Long-Press Crosshair)
        // ==========================================================
        this.canvas.addEventListener('touchstart', (e) => {
            e.preventDefault();
            WorkspaceManager.setActiveChart(this);
            const rect = this.canvas.getBoundingClientRect();

            for (let i = 0; i < e.changedTouches.length; i++) {
                const t = e.changedTouches[i];
                this.activeTouches.set(t.identifier, { x: t.clientX - rect.left, y: t.clientY - rect.top });
            }

            if (this.activeTouches.size === 2) {
                // Cancel crosshair & timers on pinch
                if (this.longPressTimeout) clearTimeout(this.longPressTimeout);
                this.isMobileCrosshairActive = false;
                this.renderer.isCrosshairVisible = false;
                this.isCrosshairDirty = true;

                this.isDraggingChart = false;
                this.isDraggingPriceAxis = false;
                this.isDraggingTimeAxis = false;

                const points = Array.from(this.activeTouches.values());
                const dist = Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
                if (dist > 5) {
                    this.initialPinchDist = dist;
                    this.initialPinchZoom = this.renderer.zoom;
                }
            } else if (this.activeTouches.size === 1) {
                const t = e.touches[0];
                const x = t.clientX - rect.left;
                const y = t.clientY - rect.top;

                this.touchStartX = x;
                this.touchStartY = y;
                this.touchStartTime = Date.now();

                // Mobile Touch Drawing: Do NOT jump to the touch location! Use and preserve crosshair location!
                if (this.drawingManager.activeToolType) {
                    this.isTouchDrawingMoved = false;
                    const chartWidth = this.canvas.clientWidth - this.renderer.priceAxisWidth;
                    const chartHeight = this.canvas.clientHeight - this.renderer.timeAxisHeight;
                    if (this.renderer.crosshairX <= 0 || this.renderer.crosshairX >= chartWidth) {
                        this.renderer.crosshairX = Math.round(chartWidth * 0.5);
                    }
                    if (this.renderer.crosshairY <= 0 || this.renderer.crosshairY >= chartHeight) {
                        this.renderer.crosshairY = Math.round(chartHeight * 0.5);
                    }
                    this.crosshairStartX = this.renderer.crosshairX;
                    this.crosshairStartY = this.renderer.crosshairY;
                    this.renderer.isCrosshairVisible = true;
                    this.isCrosshairDirty = true;
                    this.updateLegendValues();
                    this.priceAxisRenderer.render();
                    this.timeAxisRenderer.render();

                    // If Point 1 has already been entered, update preview from Point 1 to crosshair
                    if (this.drawingManager.currentDrawing && this.drawingManager.currentDrawing.points.length > 0) {
                        this.drawingManager.onPointerMove(this.renderer, this.renderer.crosshairX, this.renderer.crosshairY);
                    }
                    this.renderer.forceNextRender = true;
                    this.isDirty = true;
                    return; // Stop here, do not pan chart or jump crosshair
                }

                // Phase 3 & 4: Selection Hit Test (Mobile)
                const hitResult = this.drawingManager.trySelect(this.renderer, x, y);
                if (hitResult) {
                    const hitDrawing = hitResult.drawing;
                    this.drawingManager.drawings.forEach(d => d.state = 'idle');
                    hitDrawing.state = 'selected';
                    this.drawingManager.selectedDrawing = hitDrawing;

                    if (hitResult.part === 'handle_0') { this.drawingManager.draggingHandle = 0; return; }
                    if (hitResult.part === 'handle_1') { this.drawingManager.draggingHandle = 1; return; }
                    this.isDirty = true;

                    // If clicking a Text tool, open Text Modal instead of ColorPicker!
                    if (hitDrawing.constructor.name === 'TextDrawing') {
                        WorkspaceManager.openTextEditor(hitDrawing as any);
                        return;
                    }

                    const anchor = document.createElement('div');
                    anchor.style.position = 'absolute';
                    anchor.style.left = `${t.clientX}px`;
                    anchor.style.top = `${t.clientY}px`;
                    document.body.appendChild(anchor);

                    colorPicker.open({
                        anchorElement: anchor,
                        initialColor: '#' + hitDrawing.color.toString(16).padStart(6, '0'),
                        initialOpacity: hitDrawing.alpha,
                        initialThickness: hitDrawing.width,
                        initialStyle: hitDrawing.style,
                        showOpacity: true,
                        showStrokeOptions: true,
                        onDelete: () => {
                            this.drawingManager.deleteDrawing(hitDrawing.id);
                            this.drawingManager.drawings = this.drawingManager.drawings.filter(d => d !== hitDrawing);
                            this.drawingManager.selectedDrawing = null;
                            this.isDirty = true;
                            WorkspaceManager.triggerAutoSave();
                        },
                        onChange: (res) => {
                            hitDrawing.color = parseInt(res.color.replace('#', ''), 16);
                            hitDrawing.alpha = res.opacity;
                            hitDrawing.width = res.thickness || hitDrawing.width;
                            hitDrawing.style = res.style || hitDrawing.style;
                            this.isDirty = true;

                            this.drawingManager.saveDrawing(hitDrawing);

                            WorkspaceManager.triggerAutoSave();
                        }
                    });

                    setTimeout(() => anchor.remove(), 100);
                    return; // Stop chart interactions
                } else {
                    this.drawingManager.drawings.forEach(d => d.state = 'idle');
                    this.drawingManager.selectedDrawing = null;
                    colorPicker.close();
                    this.isDirty = true;
                }

                if (this.isMobileCrosshairActive) {
                    // Crosshair is already active. Snap it to new touch location immediately.
                    this.renderer.crosshairX = x;
                    this.renderer.crosshairY = y;
                    this.isCrosshairDirty = true;
                    this.isDraggingChart = false;
                } else {
                    this.isDraggingChart = true;

                    // Start Long-Press Timer (400ms) to activate mobile crosshair
                    this.longPressTimeout = setTimeout(() => {
                        this.isMobileCrosshairActive = true;
                        this.renderer.isCrosshairVisible = true;
                        this.renderer.crosshairX = this.touchStartX;
                        this.renderer.crosshairY = this.touchStartY;
                        this.isCrosshairDirty = true;
                        this.isDraggingChart = false; // Stop panning
                    }, 400);

                    this.renderer.isCrosshairVisible = false;
                    this.isCrosshairDirty = true;
                }

                this.lastMouseX = t.clientX;
                this.lastMouseY = t.clientY;
            }
        }, { passive: false });

        this.canvas.addEventListener('touchmove', (e) => {
            e.preventDefault();
            const rect = this.canvas.getBoundingClientRect();

            for (let i = 0; i < e.changedTouches.length; i++) {
                const t = e.changedTouches[i];
                this.activeTouches.set(t.identifier, { x: t.clientX - rect.left, y: t.clientY - rect.top });
            }

            // Case A: 2-Finger Pinch-to-Zoom
            if (this.activeTouches.size === 2) {
                const points = Array.from(this.activeTouches.values());
                const currentDist = Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);

                if (this.initialPinchDist > 5) {
                    const pinchCenterX = (points[0].x + points[1].x) / 2;
                    const worldBaseX = (pinchCenterX + this.renderer.cameraX) / this.renderer.zoom;
                    const scaleFactor = currentDist / this.initialPinchDist;
                    const newZoom = Math.max(0.1, Math.min(this.initialPinchZoom * scaleFactor, 50));

                    this.renderer.zoom = newZoom;
                    this.renderer.cameraX = (worldBaseX * this.renderer.zoom) - pinchCenterX;
                    this.isLockedToEdge = false;
                    this.isDirty = true;
                }

                // Case B: 1-Finger Interactions
            } else if (this.activeTouches.size === 1) {
                const t = e.touches[0];
                const x = t.clientX - rect.left;
                const y = t.clientY - rect.top;

                // Mobile Touch Drawing: Moving scrolls/positions the crosshair across the screen relative to crosshair location
                if (this.drawingManager.activeToolType) {
                    const deltaX = x - this.touchStartX;
                    const deltaY = y - this.touchStartY;
                    if (Math.hypot(deltaX, deltaY) > 8) {
                        this.isTouchDrawingMoved = true;
                    }
                    const chartWidth = this.canvas.clientWidth - this.renderer.priceAxisWidth;
                    const chartHeight = this.canvas.clientHeight - this.renderer.timeAxisHeight;
                    const targetX = Math.max(0, Math.min(chartWidth, this.crosshairStartX + deltaX));
                    const targetY = Math.max(0, Math.min(chartHeight, this.crosshairStartY + deltaY));

                    this.renderer.crosshairX = targetX;
                    this.renderer.crosshairY = targetY;
                    this.renderer.isCrosshairVisible = true;
                    this.isCrosshairDirty = true;
                    this.updateLegendValues();
                    this.priceAxisRenderer.render();
                    this.timeAxisRenderer.render();

                    // If Point 1 has already been entered, update preview line/box to follow crosshair
                    if (this.drawingManager.currentDrawing && this.drawingManager.currentDrawing.points.length > 0) {
                        this.drawingManager.onPointerMove(this.renderer, targetX, targetY);
                    }
                    this.renderer.forceNextRender = true;
                    this.isDirty = true;
                    return; // Stop here, do not pan chart
                }

                // ---> NEW: Mobile Drawing Handle Drag Support <---
                if (this.drawingManager.selectedDrawing && this.drawingManager.draggingHandle !== null) {
                    let { time, price } = this.drawingManager.isMagnetEnabled
                        ? this.renderer.getMagnetPoint(x, y)
                        : { time: this.renderer.xToTime(x), price: this.renderer.yToPrice(y) };

                    this.drawingManager.selectedDrawing.points[this.drawingManager.draggingHandle] = { time, price };
                    this.isDirty = true;
                    this.renderer.forceNextRender = true; // <-- FIX: Smooth mobile dragging
                    return; // Stop here, do not pan chart
                }

                // Cancel long-press if the user slides their finger (they want to pan, not crosshair)
                if (!this.isMobileCrosshairActive && this.longPressTimeout) {
                    if (Math.hypot(x - this.touchStartX, y - this.touchStartY) > 10) {
                        clearTimeout(this.longPressTimeout);
                        this.longPressTimeout = null;
                    }
                }

                if (this.isMobileCrosshairActive) {
                    // Update Crosshair instead of panning chart
                    this.renderer.crosshairX = x;
                    this.renderer.crosshairY = y;
                    this.isCrosshairDirty = true;
                    this.updateLegendValues();

                    // Broadcast exact timestamp to other panes
                    if (WorkspaceManager.isCrosshairSyncEnabled) {
                        const hoverTime = this.renderer.xToTime(x);
                        WorkspaceManager.broadcastCrosshair(hoverTime, this);
                    }
                } else {
                    // Normal Drag Panning
                    const deltaX = t.clientX - this.lastMouseX;
                    const deltaY = t.clientY - this.lastMouseY;

                    if (this.isDraggingChart) {
                        if (deltaX !== 0) {
                            this.renderer.cameraX -= deltaX;
                            this.isLockedToEdge = false;
                        }
                        if (!this.renderer.isAutoScale && deltaY !== 0) {
                            this.renderer.cameraY += deltaY;
                        }
                    } else if (this.isDraggingPriceAxis) {
                        this.renderer.isAutoScale = false;
                        const screenH = this.renderer.app?.screen?.height || this.canvas.clientHeight || 600;
                        const chartHeight = screenH - this.renderer.timeAxisHeight;
                        const priceRange = this.renderer.currentMaxPrice - this.renderer.currentMinPrice;
                        const stretchFactor = deltaY * (priceRange / chartHeight) * 2;
                        this.renderer.currentMaxPrice += stretchFactor;
                        this.renderer.currentMinPrice -= stretchFactor;
                    } else if (this.isDraggingTimeAxis) {
                        const zoomMultiplier = 1 + (deltaX * 0.005);
                        this.renderer.zoom = Math.max(0.1, Math.min(this.renderer.zoom * zoomMultiplier, 50));
                        this.renderer.cameraX = (this.timeAxisWorldX * this.renderer.zoom) - this.timeAxisAnchorX;
                        this.isLockedToEdge = false;
                    }
                    this.isDirty = true;
                }

                this.lastMouseX = t.clientX;
                this.lastMouseY = t.clientY;
            }
        }, { passive: false });

        let lastMobileTapTime = 0;
        const endTouch = (e: TouchEvent) => {
            const now = Date.now();
            const duration = now - this.touchStartTime;

            // Mobile Touch Drawing: Tap confirms point at current crosshair position
            if (this.drawingManager.activeToolType && this.activeTouches.size === 1) {
                const t = e.changedTouches[0];
                const rect = this.canvas.getBoundingClientRect();
                const x = t.clientX - rect.left;
                const y = t.clientY - rect.top;
                const dist = Math.hypot(x - this.touchStartX, y - this.touchStartY);

                if (!this.isTouchDrawingMoved && dist < 15 && duration < 500) {
                    this.confirmTouchDrawingPoint();
                } else {
                    // Finger moved and lifted: crosshair stays locked at this position for next action
                    this.crosshairStartX = this.renderer.crosshairX;
                    this.crosshairStartY = this.renderer.crosshairY;
                    this.renderer.isCrosshairVisible = true;
                    this.isCrosshairDirty = true;
                    this.renderer.forceNextRender = true;
                    this.isDirty = true;
                }

                for (let i = 0; i < e.changedTouches.length; i++) {
                    this.activeTouches.delete(e.changedTouches[i].identifier);
                }
                return;
            }

            // Mobile Double-Tap to Reset AutoScale
            if (this.activeTouches.size === 1 && duration < 250) {
                if (now - lastMobileTapTime < 300) {
                    this.toggleAutoScale(true);
                }
                lastMobileTapTime = now;
            }

            // Dismiss crosshair if the user does a quick tap anywhere while it's active
            if (this.activeTouches.size === 1 && this.isMobileCrosshairActive) {
                const t = e.changedTouches[0];
                const rect = this.canvas.getBoundingClientRect();
                const x = t.clientX - rect.left;
                const y = t.clientY - rect.top;
                const dist = Math.hypot(x - this.touchStartX, y - this.touchStartY);

                if (dist < 15 && duration < 300) {
                    this.isMobileCrosshairActive = false;
                    this.renderer.isCrosshairVisible = false;
                    this.isCrosshairDirty = true;
                    if (WorkspaceManager.isCrosshairSyncEnabled) {
                        WorkspaceManager.broadcastCrosshair(null, this);
                    }
                }
            }

            if (this.longPressTimeout) {
                clearTimeout(this.longPressTimeout);
                this.longPressTimeout = null;
            }

            // Save modified drawing to DB and reset handle
            if (this.drawingManager.draggingHandle !== null && this.drawingManager.selectedDrawing) {
                this.drawingManager.saveDrawing(this.drawingManager.selectedDrawing);
                this.drawingManager.draggingHandle = null;
            }

            for (let i = 0; i < e.changedTouches.length; i++) {
                this.activeTouches.delete(e.changedTouches[i].identifier);
            }

            if (this.activeTouches.size < 2) {
                this.initialPinchDist = 0;
            }

            if (this.activeTouches.size === 1 && e.touches.length > 0) {
                this.lastMouseX = e.touches[0].clientX;
                this.lastMouseY = e.touches[0].clientY;
                this.isDraggingChart = false;
                this.isDraggingPriceAxis = false;
                this.isDraggingTimeAxis = false;
            } else if (this.activeTouches.size === 0) {
                this.activeTouches.clear();
                this.isDraggingChart = false;
                this.isDraggingPriceAxis = false;
                this.isDraggingTimeAxis = false;
            }
        };

        this.canvas.addEventListener('touchend', endTouch);
        this.canvas.addEventListener('touchcancel', endTouch);

        // When clicking inside this chart, make it the focused pane
        this.canvas.addEventListener('pointerdown', () => {
            WorkspaceManager.setActiveChart(this);
        });
    }

    public toggleAutoScale(forceState?: boolean) {
        this.renderer.isAutoScale = forceState !== undefined ? forceState : !this.renderer.isAutoScale;
        if (this.renderer.isAutoScale) {
            this.renderer.cameraY = 0;
        }
        this.isDirty = true;
        if (this.autoBtn) {
            this.autoBtn.style.color = this.renderer.isAutoScale
                ? themeManager.getResolvedAccentColor()
                : 'var(--chart-text, #787B86)';
        }
        WorkspaceManager.syncTopBar();
        WorkspaceManager.triggerAutoSave();
    }

    public zoomAtCenter(factor: number) {
        const screenWidth = this.renderer.app?.screen?.width || this.canvas.clientWidth;
        const chartWidth = screenWidth - this.renderer.priceAxisWidth;
        const centerX = chartWidth / 2;
        const worldBaseX = (centerX + this.renderer.cameraX) / this.renderer.zoom;

        this.renderer.zoom = Math.max(0.1, Math.min(this.renderer.zoom * factor, 50));
        this.renderer.cameraX = (worldBaseX * this.renderer.zoom) - centerX;
        this.isLockedToEdge = false;
        this.isDirty = true;
    }

    public scrollHorizontal(pixels: number) {
        this.renderer.cameraX += pixels;
        this.isLockedToEdge = false;
        this.isDirty = true;
    }

    public jumpToLive() {
        this.renderer.isAutoScale = true;
        this.renderer.cameraY = 0;
        this.isLockedToEdge = true;

        const actualSpacing = this.renderer.candleSpacing * this.renderer.zoom;
        const maxScroll = (this.dataStore.length * actualSpacing) - this.canvas.clientWidth;
        this.renderer.cameraX = maxScroll + 150;
        this.isDirty = true;
        if (this.autoBtn) {
            this.autoBtn.style.color = themeManager.getResolvedAccentColor();
        }
        WorkspaceManager.syncTopBar();
    }

    public serialize(): SavedPaneState {
        return {
            symbol: this.currentSymbol,
            timeframe: this.currentInterval,
            chartMode: this.renderer.chartMode,
            isAutoScale: this.renderer.isAutoScale,
            candleHtfTimeframe: this.candleHtfTimeframe,
            candleHtfCustomMins: this.candleHtfCustomMins,
            autoPeekOnClose: this.autoPeekCadence !== 'off',
            autoPeekCadence: this.autoPeekCadence,
            autoPeekCustomValue: this.autoPeekCustomValue,
            htfOverlayDurationSec: this.htfOverlayDurationSec,
            showHtfWicks: this.showHtfWicks,
            htfCandleOpacity: this.htfCandleOpacity,
            showHtfOverlayHud: this.showHtfOverlayHud,
            indicators: this.indicatorManager.activeIndicators.map(i => IndicatorRegistry.serialize(i))
        };
    }

    public async deserialize(state: SavedPaneState) {
        this.currentSymbol = state.symbol || 'BTCUSDT';
        this.currentInterval = state.timeframe || '1m';

        if (state.candleHtfTimeframe !== undefined) this.candleHtfTimeframe = state.candleHtfTimeframe;
        if (state.candleHtfCustomMins !== undefined) this.candleHtfCustomMins = state.candleHtfCustomMins;
        if (state.autoPeekCadence !== undefined) {
            this.autoPeekCadence = state.autoPeekCadence;
        } else if (state.autoPeekOnClose !== undefined) {
            this.autoPeekCadence = state.autoPeekOnClose ? 'htf_close' : 'off';
        }
        if (state.autoPeekCustomValue !== undefined) this.autoPeekCustomValue = state.autoPeekCustomValue;
        this.autoPeekOnClose = this.autoPeekCadence !== 'off';
        if (state.htfOverlayDurationSec !== undefined) this.htfOverlayDurationSec = state.htfOverlayDurationSec;
        if (state.showHtfWicks !== undefined) this.showHtfWicks = state.showHtfWicks;
        if (state.htfCandleOpacity !== undefined) this.htfCandleOpacity = state.htfCandleOpacity;
        if (state.showHtfOverlayHud !== undefined) this.showHtfOverlayHud = state.showHtfOverlayHud;

        await this.drawingManager.loadDrawings(this.currentSymbol);

        this.renderer.chartMode = (state.chartMode as any) || 'candles';
        this.renderer.isAutoScale = state.isAutoScale ?? true;

        this.indicatorManager.activeIndicators = [];
        if (state.indicators) {
            state.indicators.forEach(indState => {
                const ind = IndicatorRegistry.deserialize(indState);
                if (ind) this.indicatorManager.addIndicator(ind);
            });
        }

        await this.startLiveBinance(this.currentSymbol, this.currentInterval);
        this.updateLegend();
        this.updateControlsLayout();
        this.updateHtfOverlayControl();
        WorkspaceManager.syncSessions();
        WorkspaceManager.syncSeparators();
        WorkspaceManager.syncClock();
    }

    public async switchTimeframe(newInterval: string) {
        this.currentInterval = newInterval;
        this.renderer.currentInterval = newInterval;
        this.renderer.currentSymbol = this.currentSymbol;
        this.network.disconnect();
        this.dataStore.clear();
        this.indicatorManager.resetAll();
        this.isDirty = true;
        this.priceAxisRenderer.render();

        await this.network.connect(this.currentSymbol, this.currentInterval, (prependedCount = 0, isClosed = true) => {
            if (prependedCount > 0) {
                if (!this.isLockedToEdge) {
                    const actualSpacing = this.renderer.candleSpacing * this.renderer.zoom;
                    this.renderer.cameraX += prependedCount * actualSpacing;
                }
                this.indicatorManager.resetAll();
                this.renderer.isHistoricalDirty = true;
                this.renderer.isSessionDirty = true;
            }
            this.indicatorManager.update(this.dataStore, isClosed); // Run Math Engine
            if (this.dataStore.length > 0) {
                const lastBase = (this.dataStore.length - 1) * 6;
                this.checkAutoPeekOnClose(this.dataStore.data[lastBase]);
            }
            this.renderer.forceNextRender = true;
            this.renderer.isSessionDirty = true;
            this.isDirty = true;
            if (this.isLockedToEdge) {
                const actualSpacing = this.renderer.candleSpacing * this.renderer.zoom;
                const maxScroll = (this.dataStore.length * actualSpacing) - this.canvas.clientWidth;
                this.renderer.cameraX = maxScroll + 150;
            }
        }, (pct: number) => {
            // ---> NEW ON TICKER CALLBACK <---
            this.currentChangePct = pct;
            if (WorkspaceManager.getActiveChart() === this) {
                WorkspaceManager.syncTopBar();
            }
        });
        this.jumpToLive();
        this.updateHtfOverlayControl();
        WorkspaceManager.triggerAutoSave();
    }

    public async switchSymbol(newSymbol: string) {
        this.currentSymbol = newSymbol;
        this.renderer.currentSymbol = newSymbol;
        this.indicatorManager.currentSymbol = newSymbol;
        this.drawingManager.loadDrawings(newSymbol); // Load DB drawings!
        this.network.disconnect();
        this.dataStore.clear();
        this.indicatorManager.resetAll();
        this.isDirty = true;
        this.priceAxisRenderer.render();

        await this.network.connect(this.currentSymbol, this.currentInterval, (prependedCount = 0, isClosed = true) => {
            if (prependedCount > 0 && !this.isLockedToEdge) {
                const actualSpacing = this.renderer.candleSpacing * this.renderer.zoom;
                this.renderer.cameraX += prependedCount * actualSpacing;
            }
            this.indicatorManager.update(this.dataStore, isClosed); // Run Math Engine
            this.isDirty = true;
            this.priceAxisRenderer.render();
            if (this.isLockedToEdge) {
                const actualSpacing = this.renderer.candleSpacing * this.renderer.zoom;
                const maxScroll = (this.dataStore.length * actualSpacing) - this.canvas.clientWidth;
                this.renderer.cameraX = maxScroll + 150;
            }
        }, (pct: number) => {
            // ---> NEW ON TICKER CALLBACK <---
            this.currentChangePct = pct;
            if (WorkspaceManager.getActiveChart() === this) {
                WorkspaceManager.syncTopBar();
            }
        });
        this.jumpToLive();
        this.updateHtfOverlayControl();
        WorkspaceManager.triggerAutoSave();
    }

    public async startLiveBinance(symbol: string, interval: string) {
        this.currentSymbol = symbol;
        this.renderer.currentSymbol = symbol;
        this.indicatorManager.currentSymbol = symbol;
        this.currentInterval = interval;
        this.renderer.currentInterval = interval;

        await this.drawingManager.loadDrawings(symbol);

        await this.renderer.init(this.canvas);

        // Immediate layout sync so axes render immediately on startup
        const initRect = this.chartCanvas.getBoundingClientRect();
        if (initRect.width > 0 && initRect.height > 0) {
            this.renderer.resize(initRect.width, initRect.height);
        }
        this.priceAxisRenderer.render();
        this.timeAxisRenderer.render();

        await this.network.connect(symbol, interval, (prependedCount = 0, isClosed = true) => {
            if (prependedCount > 0) {
                if (!this.isLockedToEdge) {
                    const actualSpacing = this.renderer.candleSpacing * this.renderer.zoom;
                    this.renderer.cameraX += prependedCount * actualSpacing;
                }
                this.indicatorManager.resetAll();
                this.renderer.isHistoricalDirty = true;
                this.renderer.isSessionDirty = true;
            }
            // Propagate live unclosed tick state to indicator pipeline
            this.indicatorManager.update(this.dataStore, isClosed);
            if (this.dataStore.length > 0) {
                const lastBase = (this.dataStore.length - 1) * 6;
                this.checkAutoPeekOnClose(this.dataStore.data[lastBase]);
            }
            this.renderer.forceNextRender = true;
            this.renderer.isSessionDirty = true;
            this.isDirty = true;
            if (this.isLockedToEdge) {
                const actualSpacing = this.renderer.candleSpacing * this.renderer.zoom;
                const maxScroll = (this.dataStore.length * actualSpacing) - this.canvas.clientWidth;
                this.renderer.cameraX = maxScroll + 150;
            }
        }, (pct: number) => {
            // ---> NEW ON TICKER CALLBACK <---
            this.currentChangePct = pct;
            if (WorkspaceManager.getActiveChart() === this) {
                WorkspaceManager.syncTopBar();
            }
        });

        this.renderer.currentInterval = this.currentInterval;
        const actualSpacing = this.renderer.candleSpacing * this.renderer.zoom;
        const initialMaxScroll = (this.dataStore.length * actualSpacing) - this.canvas.clientWidth;
        this.renderer.cameraX = initialMaxScroll + 150;

        this.watchdogTimer = setInterval(() => {
            if (this.isRunning) {
                // Only mark WebGL chart dirty if theme actually changed
                const themeChanged = themeManager.evaluateDynamicTheme();
                if (themeChanged) {
                    this.isDirty = true;
                }

                // 🕒 Watchdog: Detect 00:00 countdown hang (overdue by 3+ seconds)
                if (this.dataStore.length > 0) {
                    const lastBase = (this.dataStore.length - 1) * 6;
                    const lastTime = this.dataStore.data[lastBase];
                    const intervalMs = this.renderer.parseIntervalMs(this.currentInterval);
                    const remainingMs = (lastTime + intervalMs) - BinanceClient.getServerTime();

                    if (remainingMs <= -3000) {
                        const now = Date.now();
                        // 5s cooldown between recovery attempts
                        if (now - this.lastWatchdogRecovery > 5000) {
                            this.lastWatchdogRecovery = now;
                            this.network.handleWatchdogRecovery();
                        }
                    }

                    // Check if HTF candle boundary was crossed in real time
                    this.checkAutoPeekOnClose(BinanceClient.getServerTime());
                }

                // Isolated partial update: Only repaints the countdown pill and clock badges
                this.priceAxisRenderer.updateCountdownOnly();
                this.timeAxisRenderer.updateClocksOnly();
            }
        }, 1000);

        let lastFrameTime = performance.now();
        let actualDrawCount = 0;
        let lastFpsLog = performance.now();

        // On-screen HUD for mobile & desktop
        let hud = this.container.querySelector('#engine-hud') as HTMLElement;
        if (!hud) {
            hud = document.createElement('div');
            hud.id = 'engine-hud';
            hud.style.cssText = 'position: absolute; top: 42px; right: 70px; z-index: 999; background: rgba(0,0,0,0.7); color: #00F5D4; font-family: monospace; font-size: 11px; padding: 2px 6px; border-radius: 4px; pointer-events: none; border: 1px solid rgba(0,245,212,0.3);';
            hud.textContent = 'Paint: 0.0 FPS';
            this.container.appendChild(hud);
        }
        hud.style.display = WorkspaceManager.showPaintFpsHud ? 'block' : 'none';
        let lastSecTick = 0;

        const loop = (now: number) => {
            if (!this.isRunning) return;
            const frameInterval = 1000 / WorkspaceManager.targetFPS;
            const elapsed = now - lastFrameTime;

            if (elapsed >= frameInterval) {
                lastFrameTime = now - (elapsed % frameInterval);

                // Live 1-second tick to update session box countdown & world clocks
                if (now - lastSecTick >= 1000) {
                    lastSecTick = now;
                    this.renderer.isHistoricalDirty = true;
                    this.isDirty = true;
                }

                if (this.isDirty) {
                    // Update stacked oscillator height and dock AUTO button
                    const oscHeight = this.indicatorManager.getTotalOscillatorHeight();
                    this.renderer.oscHeight = oscHeight;
                    this.renderer.indicatorOscContainer.visible = oscHeight > 0;
                    this.updateControlsLayout();

                    const activeOsc = this.indicatorManager.getActiveOscillator();
                    this.renderer.activeOscillatorScale = activeOsc?.oscillatorScale;

                    // 1. Evaluate dirty state and calculate positions
                    this.renderer.renderFrame();

                    // 2. Only submit GPU draw call if something visible actually changed
                    if (this.renderer.isRenderDirty) {
                        // Only rebuild indicators, drawings & time axis if camera moved, candle closed, OR live price changed
                        if (this.renderer.isHistoricalDirty || this.renderer.isLivePriceDirty) {
                            this.renderer.sessionBoxGraphics?.clear();
                            this.renderer.strictCbcGraphics?.clear();
                            this.renderer.indicatorMainGraphics.clear();
                            this.renderer.indicatorOscGraphics.clear();
                            this.renderer.hideAllIndicatorMeshes();
                            this.indicatorManager.render(
                                this.renderer,
                                this.renderer.indicatorMainGraphics,
                                this.renderer.indicatorOscGraphics,
                                this.renderer.sessionBoxGraphics,
                                this.renderer.strictCbcGraphics
                            );

                            if (this.isHtfOverlayActive) {
                                const htfBars = this.getResampledHtfBars();
                                const effectiveMs = this.getEffectiveHtfMs();
                                const chartTfMs = this.renderer.parseIntervalMs(this.currentInterval);
                                this.renderer.renderHtfOverlayCandles(htfBars, this.showHtfWicks, this.htfCandleOpacity, effectiveMs, chartTfMs);
                            } else {
                                this.renderer.clearHtfOverlay();
                            }

                            this.drawingManager.render(this.renderer, this.renderer.drawingGraphics);
                            this.timeAxisRenderer.render();
                        }

                        this.renderer.renderCrosshair();
                        this.priceAxisRenderer.render();

                        this.renderer.render(); // 🎯 Refreshes WebGL canvas on pan/drag
                        actualDrawCount++;
                    } else {
                        // Main canvas is idle in history: update only the price axis badge
                        this.priceAxisRenderer.updateCountdownOnly();
                    }

                    this.isDirty = false;
                    this.isCrosshairDirty = false;
                }

                else if (this.isCrosshairDirty) {
                    this.renderer.renderCrosshair();
                    this.priceAxisRenderer.render();
                    this.timeAxisRenderer.render();

                    this.isCrosshairDirty = false;
                    this.renderer.render(); // 🎯 Submit frame for crosshair move
                }
                // Update live paint rate on-screen and in console every 1 second
                if (now - lastFpsLog >= 1000) {
                    const trueFps = (actualDrawCount / ((now - lastFpsLog) / 1000)).toFixed(1);
                    if (hud && WorkspaceManager.showPaintFpsHud) {
                        hud.textContent = `Paint: ${trueFps} FPS`;
                    }
                    if (WorkspaceManager.logPaintFps) {
                        console.log(`[Engine] True Canvas Paint Rate: ${trueFps} FPS`);
                    }
                    actualDrawCount = 0;
                    lastFpsLog = now;
                }
            }
            requestAnimationFrame(loop);
        };
        requestAnimationFrame(loop);
    }
}

// =========================================================================
// 🚀 WORKSPACE & MULTI-PANE MANAGER
// =========================================================================
export class WorkspaceManager {
    private static charts: EcoChart[] = [];
    private static activeChart: EcoChart | null = null;
    public static isAutoHideNav = true;
    public static isCrosshairSyncEnabled = true;
    public static showPaintFpsHud = true;
    public static logPaintFps = true;
    public static targetFPS = 60;
    public static showIndicatorSettingsFn: ((ind: any) => void) | null = null; // <-- Bridge to settings view

    public static updateHudVisibility() {
        document.querySelectorAll('#engine-hud').forEach(el => {
            (el as HTMLElement).style.display = this.showPaintFpsHud ? 'block' : 'none';
        });
    }

    public static currentLayout = '1';
    private static saveTimeout: any = null;
    public static toolbarDockMode: 'free' | 'top' = 'free';
    public static toolbarVisibility: 'autohide' | 'always' = 'autohide';
    public static toolbarCustomPos: { left: number; top: number } | null = null;
    public static topBarDisplayMode: 'change' | 'none' = 'change';
    public static syncModalInputs: () => void = () => {};

    // Global Timeframe Download Limits (Stored in days, -1 = Infinity)
    public static dataLimits: Record<string, number> = {
        'limit_1m_3m': 7,
        'limit_4m_8m': 7,
        'limit_9m_12m': 30,
        'limit_15m': 90,
        'limit_30m_45m': 180,
        'limit_1h_3h': 365,
        'limit_4h_6h': 730,
        'limit_7h_12h': 1460,
        'limit_13h_1d': 1825,
        'limit_1w_1M': 3650
    };

    public static sessionConfig = {
        enabled: true,
        showOnAxis: true,
        showOnChart: false,
        showRanges: true,
        axisOpacity: 40,
        // Timezone
        timezoneOffset: 0,
        exchangeTimezone: true,
        // Ranges Settings
        rangeTransparency: 80,
        rangeOutline: true,
        rangeLabel: true,
        showEndTime: true,
        showMean: false,
        // Opening & Session Transition
        highlightOpen: true,
        openWindowDuration: 15,
        showOpeningRange: true,
        showPreOpenZone: true,
        endOnNextOpen: true,
        showOpenBellLine: true,
        // Session A
        sessionA: {
            enabled: true,
            name: 'New York',
            hours: '1300-2200',
            range: true,
            color: '#EF5350'
        },
        // Session B
        sessionB: {
            enabled: true,
            name: 'London',
            hours: '0700-1600',
            range: true,
            color: '#2962FF'
        },
        // Session C
        sessionC: {
            enabled: true,
            name: 'Tokyo',
            hours: '0000-0900',
            range: true,
            color: '#FBC02D'
        },
        // Session D
        sessionD: {
            enabled: false,
            name: 'Sydney',
            hours: '2100-0600',
            range: true,
            color: '#AB47BC'
        },
        asiaColor: '#FBC02D80',
        londonColor: '#2962FF80',
        nyColor: '#EF535080'
    };

    public static ensureSessionConfig() {
        if (!this.sessionConfig) {
            this.sessionConfig = {} as any;
        }
        const sc = this.sessionConfig as any;
        if (sc.enabled === undefined) sc.enabled = true;
        if (sc.showOnAxis === undefined) sc.showOnAxis = true;
        if (sc.showOnChart === undefined) sc.showOnChart = false;
        if (sc.showRanges === undefined) sc.showRanges = true;
        if (sc.axisOpacity === undefined) sc.axisOpacity = 40;
        if (sc.timezoneOffset === undefined) sc.timezoneOffset = 0;
        if (sc.exchangeTimezone === undefined) sc.exchangeTimezone = true;
        if (sc.rangeTransparency === undefined) sc.rangeTransparency = 80;
        if (sc.rangeOutline === undefined) sc.rangeOutline = true;
        if (sc.rangeLabel === undefined) sc.rangeLabel = true;
        if (sc.showEndTime === undefined) sc.showEndTime = true;
        if (sc.showMean === undefined) sc.showMean = false;
        if (sc.highlightOpen === undefined) sc.highlightOpen = true;
        if (sc.openWindowDuration === undefined) sc.openWindowDuration = 15;
        if (sc.showOpeningRange === undefined) sc.showOpeningRange = true;
        if (sc.showPreOpenZone === undefined) sc.showPreOpenZone = true;
        if (sc.endOnNextOpen === undefined) sc.endOnNextOpen = true;
        if (sc.showOpenBellLine === undefined) sc.showOpenBellLine = true;

        if (!sc.sessionA) {
            sc.sessionA = {
                enabled: true,
                name: 'New York',
                hours: '1300-2200',
                range: true,
                color: sc.nyColor || '#EF5350'
            };
        } else {
            if (sc.sessionA.enabled === undefined) sc.sessionA.enabled = true;
            if (!sc.sessionA.name) sc.sessionA.name = 'New York';
            if (!sc.sessionA.hours) sc.sessionA.hours = '1300-2200';
            if (sc.sessionA.range === undefined) sc.sessionA.range = true;
            if (!sc.sessionA.color) sc.sessionA.color = '#EF5350';
        }

        if (!sc.sessionB) {
            sc.sessionB = {
                enabled: true,
                name: 'London',
                hours: '0700-1600',
                range: true,
                color: sc.londonColor || '#2962FF'
            };
        } else {
            if (sc.sessionB.enabled === undefined) sc.sessionB.enabled = true;
            if (!sc.sessionB.name) sc.sessionB.name = 'London';
            if (!sc.sessionB.hours) sc.sessionB.hours = '0700-1600';
            if (sc.sessionB.range === undefined) sc.sessionB.range = true;
            if (!sc.sessionB.color) sc.sessionB.color = '#2962FF';
        }

        if (!sc.sessionC) {
            sc.sessionC = {
                enabled: true,
                name: 'Tokyo',
                hours: '0000-0900',
                range: true,
                color: sc.asiaColor || '#FBC02D'
            };
        } else {
            if (sc.sessionC.enabled === undefined) sc.sessionC.enabled = true;
            if (!sc.sessionC.name) sc.sessionC.name = 'Tokyo';
            if (!sc.sessionC.hours) sc.sessionC.hours = '0000-0900';
            if (sc.sessionC.range === undefined) sc.sessionC.range = true;
            if (!sc.sessionC.color) sc.sessionC.color = '#FBC02D';
        }

        if (!sc.sessionD) {
            sc.sessionD = {
                enabled: false,
                name: 'Sydney',
                hours: '2100-0600',
                range: true,
                color: '#AB47BC'
            };
        } else {
            if (sc.sessionD.enabled === undefined) sc.sessionD.enabled = false;
            if (!sc.sessionD.name) sc.sessionD.name = 'Sydney';
            if (!sc.sessionD.hours) sc.sessionD.hours = '2100-0600';
            if (sc.sessionD.range === undefined) sc.sessionD.range = true;
            if (!sc.sessionD.color) sc.sessionD.color = '#AB47BC';
        }
    }

    public static clockConfig = {
        enabled: true,
        primaryTz: 'America/New_York',
        secondaryTz: 'Europe/London'
    };

    public static getTzLabel(tz: string): string {
        const map: Record<string, string> = {
            'America/New_York': 'NYC',
            'Europe/London': 'LON',
            'Asia/Tokyo': 'TYO',
            'Asia/Hong_Kong': 'HKG',
            'Europe/Frankfurt': 'FRA',
            'UTC': 'UTC',
            'local': 'LOC'
        };
        return map[tz] || 'UTC';
    }

    public static syncClock() {
        this.charts.forEach(c => {
            c.renderer.clockConfig = {
                enabled: this.clockConfig.enabled,
                primaryTz: this.clockConfig.primaryTz,
                primaryLabel: this.getTzLabel(this.clockConfig.primaryTz),
                secondaryTz: this.clockConfig.secondaryTz,
                secondaryLabel: this.getTzLabel(this.clockConfig.secondaryTz)
            };
            c.isDirty = true;
        });
    }

    public static syncSessions() {
        this.ensureSessionConfig();
        const sc = this.sessionConfig;

        const parseSess = (hex: string) => {
            const clean = (hex || '#FFFFFF').replace('#', '');
            const color = parseInt(clean.slice(0, 6), 16) || 0;
            const alpha = clean.length >= 8 ? parseInt(clean.slice(6, 8), 16) / 255 : 0.5;
            return { color, alpha };
        };

        const sessA = sc.sessionA;
        const sessB = sc.sessionB;
        const sessC = sc.sessionC;
        const sessD = sc.sessionD;

        // Separate subtle background colors for GPU mesh shading so changing the box range color ONLY changes the box!
        const bgA = (sessA as any).bgColor || sc.nyColor || '#EF535040';
        const bgB = (sessB as any).bgColor || sc.londonColor || '#2962FF40';
        const bgC = (sessC as any).bgColor || sc.asiaColor || '#FBC02D40';
        const bgD = (sessD as any).bgColor || '#AB47BC40';

        const sessionsForRenderer = [
            { enabled: sessA.enabled, hours: sessA.hours, ...parseSess(bgA) },
            { enabled: sessB.enabled, hours: sessB.hours, ...parseSess(bgB) },
            { enabled: sessC.enabled, hours: sessC.hours, ...parseSess(bgC) },
            { enabled: sessD.enabled, hours: sessD.hours, ...parseSess(bgD) }
        ];

        this.charts.forEach(c => {
            // 1. Sync GPU Session Mesh (Background Shading & Time Axis highlights)
            c.renderer.sessionConfig = {
                enabled: sc.enabled,
                showOnAxis: sc.showOnAxis,
                showOnChart: sc.showOnChart,
                axisOpacity: sc.axisOpacity ?? 40,
                timezoneOffset: sc.exchangeTimezone ? 0 : (sc.timezoneOffset || 0),
                sessions: sessionsForRenderer,
                endOnNextOpen: sc.endOnNextOpen ?? true
            };
            c.renderer.isSessionDirty = true;

            // 2. Sync Market Sessions Indicator (Range boxes, dotted outlines, labels, means, opening highlights)
            const indMgr = c.indicatorManager;
            let activeSessions = indMgr.activeIndicators.find(i => i instanceof MarketSessionsIndicator) as MarketSessionsIndicator | undefined;
            if (!sc.enabled || !sc.showRanges) {
                if (activeSessions) indMgr.removeIndicator(activeSessions.id);
                c.renderer.indicatorMainGraphics?.clear();
            } else {
                if (!activeSessions) {
                    activeSessions = new MarketSessionsIndicator();
                    indMgr.addIndicator(activeSessions);
                }
                activeSessions.setParam('showRanges', sc.showRanges ?? true);
                activeSessions.setParam('exchangeTimezone', sc.exchangeTimezone ?? true);
                activeSessions.setParam('timezoneOffset', sc.timezoneOffset ?? 0);
                activeSessions.setParam('rangeTransparency', sc.rangeTransparency ?? 80);
                activeSessions.setParam('rangeOutline', sc.rangeOutline ?? true);
                activeSessions.setParam('rangeLabel', sc.rangeLabel ?? true);
                activeSessions.setParam('showEndTime', sc.showEndTime ?? true);
                activeSessions.setParam('showMean', sc.showMean ?? false);
                activeSessions.setParam('axisOpacity', sc.axisOpacity ?? 40);

                activeSessions.setParam('highlightOpen', sc.highlightOpen ?? true);
                activeSessions.setParam('openWindowDuration', sc.openWindowDuration ?? 15);
                activeSessions.setParam('showOpeningRange', sc.showOpeningRange ?? true);
                activeSessions.setParam('showPreOpenZone', sc.showPreOpenZone ?? true);
                activeSessions.setParam('endOnNextOpen', sc.endOnNextOpen ?? true);
                activeSessions.setParam('showOpenBellLine', sc.showOpenBellLine ?? true);

                activeSessions.setParam('showSessionA', sessA.enabled);
                activeSessions.setParam('sessionAName', sessA.name);
                activeSessions.setParam('sessionATime', sessA.hours);
                activeSessions.setParam('sessionARange', sessA.range);
                activeSessions.setParam('sessionAColor', sessA.color);

                activeSessions.setParam('showSessionB', sessB.enabled);
                activeSessions.setParam('sessionBName', sessB.name);
                activeSessions.setParam('sessionBTime', sessB.hours);
                activeSessions.setParam('sessionBRange', sessB.range);
                activeSessions.setParam('sessionBColor', sessB.color);

                activeSessions.setParam('showSessionC', sessC.enabled);
                activeSessions.setParam('sessionCName', sessC.name);
                activeSessions.setParam('sessionCTime', sessC.hours);
                activeSessions.setParam('sessionCRange', sessC.range);
                activeSessions.setParam('sessionCColor', sessC.color);

                activeSessions.setParam('showSessionD', sessD.enabled);
                activeSessions.setParam('sessionDName', sessD.name);
                activeSessions.setParam('sessionDTime', sessD.hours);
                activeSessions.setParam('sessionDRange', sessD.range);
                activeSessions.setParam('sessionDColor', sessD.color);

                activeSessions.update(c.dataStore, true);
            }

            c.renderer.forceNextRender = true;
            c.renderer.isHistoricalDirty = true;
            c.isDirty = true;
            c.timeAxisRenderer.render();
        });
    }

    public static separatorConfig = {
        enabled: true,
        showDOW: true,
        dowPosition: 'Bottom',
        dowVerticalOffset: 28,
        dowColor: '#D1D4DC',
        showDay: true,
        lineColor: '#D2D2D380',
        lineStyle: 'Solid',
        show4H: true,
        lineColor4H: '#80808066',
        lineStyle4H: 'Dotted',
        show1H: false,
        lineColor1H: '#80808066',
        lineStyle1H: 'Dotted',
        showFuture: true
    };

    public static syncSeparators() {
        this.charts.forEach(c => {
            const ind = c.indicatorManager.activeIndicators.find(i => i instanceof PeriodSeparatorIndicator) as PeriodSeparatorIndicator | undefined;
            if (ind) {
                ind.visible = this.separatorConfig.enabled;
                ind.updateParams({
                    showDOW: this.separatorConfig.showDOW,
                    dowPosition: this.separatorConfig.dowPosition,
                    dowVerticalOffset: this.separatorConfig.dowVerticalOffset,
                    dowColor: this.separatorConfig.dowColor,
                    showDay: this.separatorConfig.showDay,
                    lineColor: this.separatorConfig.lineColor,
                    lineStyle: this.separatorConfig.lineStyle,
                    show4H: this.separatorConfig.show4H,
                    lineColor4H: this.separatorConfig.lineColor4H,
                    lineStyle4H: this.separatorConfig.lineStyle4H,
                    show1H: this.separatorConfig.show1H,
                    lineColor1H: this.separatorConfig.lineColor1H,
                    lineStyle1H: this.separatorConfig.lineStyle1H,
                    showFuture: this.separatorConfig.showFuture
                });
                c.renderer.forceNextRender = true;
                c.renderer.isHistoricalDirty = true;
                c.isDirty = true;
            } else if (this.separatorConfig.enabled) {
                const newInd = new PeriodSeparatorIndicator();
                newInd.updateParams({ ...this.separatorConfig });
                c.indicatorManager.addIndicator(newInd);
                newInd.update(c.dataStore, true);
                c.renderer.forceNextRender = true;
                c.renderer.isHistoricalDirty = true;
                c.isDirty = true;
            }
        });
    }

    // CUSTOM DIALOG PROMISE
    public static async confirmAction(title: string, message: string): Promise<boolean> {
        return new Promise((resolve) => {
            const modal = document.getElementById('custom-confirm') as HTMLDialogElement;
            if (!modal) return resolve(window.confirm(message));

            document.getElementById('confirm-title')!.textContent = title;
            document.getElementById('confirm-msg')!.textContent = message;

            const btnCancel = document.getElementById('btn-confirm-cancel');
            const btnOk = document.getElementById('btn-confirm-ok');

            const cleanup = () => {
                btnCancel?.removeEventListener('click', onCancel);
                btnOk?.removeEventListener('click', onOk);
                modal.close();
            };

            const onCancel = () => { cleanup(); resolve(false); };
            const onOk = () => { cleanup(); resolve(true); };

            btnCancel?.addEventListener('click', onCancel);
            btnOk?.addEventListener('click', onOk);

            modal.showModal();
        });
    }


    // Open Text Tool Editor Modal
    public static currentEditingText: any = null;

    public static openTextEditor(textDrawing: any) {
        this.currentEditingText = textDrawing;
        const modal = document.getElementById('text-tool-modal') as HTMLDialogElement;
        if (!modal) return;

        const input = document.getElementById('text-input') as HTMLTextAreaElement;
        const checkBg = document.getElementById('check-text-bg') as HTMLInputElement;
        const btnBgColor = document.getElementById('btn-text-bg-color') as HTMLElement;
        const checkBorder = document.getElementById('check-text-border') as HTMLInputElement;
        const btnBorderColor = document.getElementById('btn-text-border-color') as HTMLElement;
        const checkWrap = document.getElementById('check-text-wrap') as HTMLInputElement;
        const selectSize = document.getElementById('select-text-size') as HTMLSelectElement;
        const btnBold = document.getElementById('btn-text-bold');
        const btnItalic = document.getElementById('btn-text-italic');
        const btnLock = document.getElementById('btn-text-lock');
        const btnAnchor = document.getElementById('btn-text-anchor');

        if (input) input.value = textDrawing.textContent;
        if (checkBg) checkBg.checked = textDrawing.hasBackground;
        if (btnBgColor) btnBgColor.style.backgroundColor = '#' + textDrawing.bgColor.toString(16).padStart(6, '0');
        if (checkBorder) checkBorder.checked = textDrawing.hasBorder;
        if (btnBorderColor) btnBorderColor.style.backgroundColor = '#' + textDrawing.borderColor.toString(16).padStart(6, '0');
        if (checkWrap) checkWrap.checked = textDrawing.textWrap;
        if (selectSize) selectSize.value = String(textDrawing.fontSize);

        btnBold?.classList.toggle('active', textDrawing.isBold);
        btnItalic?.classList.toggle('active', textDrawing.isItalic);
        btnLock?.classList.toggle('active', textDrawing.isLocked);
        btnAnchor?.classList.toggle('active', textDrawing.isAnchored);

        modal.showModal();
        input?.focus();
    }

    public static updateToolbarDock() {
        const globalDt = document.getElementById('drawing-toolbar');
        if (this.toolbarDockMode === 'top') {
            if (globalDt) globalDt.style.display = 'none'; // Hide global floating toolbar
            this.charts.forEach(c => {
                if (c.paneDrawingToolbar) c.paneDrawingToolbar.style.display = 'flex'; // Show per-pane toolbars
            });
        } else {
            if (globalDt) {
                globalDt.style.display = 'flex'; // Show global floating toolbar
                this.autoCenterToolbar();
            }
            this.charts.forEach(c => {
                if (c.paneDrawingToolbar) c.paneDrawingToolbar.style.display = 'none'; // Hide per-pane toolbars
            });
        }
    }

    public static updateToolbarVisibility() {
        const globalDt = document.getElementById('drawing-toolbar');
        const targetOpacity = this.toolbarVisibility === 'always' ? '1' : '0.15';
        if (globalDt) {
            globalDt.style.opacity = targetOpacity;
        }
        this.charts.forEach(c => {
            if (c.paneDrawingToolbar) {
                c.paneDrawingToolbar.style.opacity = targetOpacity;
            }
        });
    }

    public static autoCenterToolbar(force = false) {
        const dt = document.getElementById('drawing-toolbar');
        if (!dt) return;
        if (this.toolbarDockMode === 'top') return;

        if (!force && this.toolbarCustomPos) {
            // Restore saved user position, bounded by current window
            const maxLeft = Math.max(0, window.innerWidth - (dt.offsetWidth || 40));
            const maxTop = Math.max(38, window.innerHeight - (dt.offsetHeight || 380));
            const left = Math.max(0, Math.min(maxLeft, this.toolbarCustomPos.left));
            const top = Math.max(38, Math.min(maxTop, this.toolbarCustomPos.top));
            dt.style.left = `${left}px`;
            dt.style.top = `${top}px`;
            dt.style.transform = 'none';
            return;
        }

        // Auto-center vertically on the vertical line (left edge)
        const topBarHeight = 38;
        const availableHeight = window.innerHeight - topBarHeight;
        const toolbarHeight = dt.offsetHeight || 380;
        const centeredTop = Math.max(topBarHeight + 8, Math.round(topBarHeight + (availableHeight - toolbarHeight) / 2));
        const leftPos = (this.toolbarCustomPos && !force) ? this.toolbarCustomPos.left : 16;

        dt.style.left = `${leftPos}px`;
        dt.style.top = `${centeredTop}px`;
        dt.style.transform = 'none';
    }

    public static saveWorkspace() {
        if (this.charts.length === 0) return;
        const state: SavedWorkspaceState = {
            version: 1,
            layout: this.currentLayout,
            activePaneIndex: this.activeChart ? this.charts.indexOf(this.activeChart) : 0,
            targetFPS: this.targetFPS,
            toolbarDockMode: this.toolbarDockMode,
            toolbarVisibility: this.toolbarVisibility,
            toolbarCustomPos: this.toolbarCustomPos,
            topBarDisplayMode: this.topBarDisplayMode,
            isAutoHideNav: this.isAutoHideNav,
            isCrosshairSyncEnabled: this.isCrosshairSyncEnabled,
            showPaintFpsHud: this.showPaintFpsHud,
            logPaintFps: this.logPaintFps,
            dataLimits: this.dataLimits,
            sessionConfig: this.sessionConfig,
            clockConfig: this.clockConfig,
            separatorConfig: this.separatorConfig,
            favoriteSymbols: favoritesManager.getFavorites(),
            onlySaveFavorites: favoritesManager.onlySaveFavorites,
            panes: this.charts.map(c => c.serialize())
        };
        try {
            localStorage.setItem('ecochart_workspace_v1', JSON.stringify(state));
        } catch (err) {
            console.warn('Failed to save workspace', err);
        }
    }

    public static triggerAutoSave() {
        if (this.saveTimeout) clearTimeout(this.saveTimeout);
        this.saveTimeout = setTimeout(() => this.saveWorkspace(), 500);
    }

    public static openIndicatorSettings(chart: EcoChart, indicator: any) {
        this.setActiveChart(chart);
        const modal = document.getElementById('indicators-modal') as HTMLDialogElement;
        if (modal && this.showIndicatorSettingsFn) {
            this.showIndicatorSettingsFn(indicator);
            modal.showModal();
        }
    }

    public static broadcastCrosshair(timeMs: number | null, source: EcoChart) {
        if (!this.isCrosshairSyncEnabled) return;
        for (const chart of this.charts) {
            if (chart !== source) {
                chart.renderer.syncHoverTimeMs = timeMs;
                chart.isCrosshairDirty = true;
            }
        }
    }

    public static init() {
        (window as any).WorkspaceManager = WorkspaceManager;
        this.setupGlobalControls();
        AlertUI.init();

        window.addEventListener('ecochart-alerts-updated', () => {
            this.charts.forEach(c => {
                c.renderer.forceNextRender = true;
                c.isDirty = true;
                c.priceAxisRenderer.render();
            });
        });

        window.addEventListener('ecochart-switch-symbol', (e: any) => {
            const sym = e.detail;
            if (sym && this.activeChart) {
                this.activeChart.switchSymbol(sym);
                this.syncTopBar();
            }
        });

        try {
            const raw = localStorage.getItem('ecochart_workspace_v1');
            if (raw) {
                const state = JSON.parse(raw) as SavedWorkspaceState;
                if (state.version === 1) {
                    // Restore global workspace preferences
                    if (state.targetFPS) this.targetFPS = state.targetFPS;
                    if (state.toolbarDockMode) this.toolbarDockMode = state.toolbarDockMode;
                    if (state.toolbarVisibility) this.toolbarVisibility = state.toolbarVisibility;
                    if (state.toolbarCustomPos !== undefined) this.toolbarCustomPos = state.toolbarCustomPos;
                    if (state.topBarDisplayMode) this.topBarDisplayMode = state.topBarDisplayMode;
                    if (state.isAutoHideNav !== undefined) this.isAutoHideNav = state.isAutoHideNav;
                    if (state.isCrosshairSyncEnabled !== undefined) this.isCrosshairSyncEnabled = state.isCrosshairSyncEnabled;
                    if (state.showPaintFpsHud !== undefined) this.showPaintFpsHud = state.showPaintFpsHud;
                    if (state.logPaintFps !== undefined) this.logPaintFps = state.logPaintFps;
                    if (state.sessionConfig) {
                        this.sessionConfig = {
                            ...this.sessionConfig,
                            ...state.sessionConfig,
                            sessionA: { ...this.sessionConfig.sessionA, ...(state.sessionConfig.sessionA || {}) },
                            sessionB: { ...this.sessionConfig.sessionB, ...(state.sessionConfig.sessionB || {}) },
                            sessionC: { ...this.sessionConfig.sessionC, ...(state.sessionConfig.sessionC || {}) },
                            sessionD: { ...this.sessionConfig.sessionD, ...(state.sessionConfig.sessionD || {}) }
                        };
                    }
                    this.ensureSessionConfig();
                    if (state.clockConfig) this.clockConfig = { ...this.clockConfig, ...state.clockConfig };
                    if (state.separatorConfig) this.separatorConfig = { ...this.separatorConfig, ...state.separatorConfig };

                    // Restore favorites from saved workspace
                    if (Array.isArray(state.favoriteSymbols)) {
                        favoritesManager.setFavorites(state.favoriteSymbols);
                    }
                    if (state.onlySaveFavorites !== undefined) {
                        favoritesManager.setOnlySaveFavorites(state.onlySaveFavorites);
                    }

                    this.updateToolbarDock();
                    this.updateToolbarVisibility();
                    this.autoCenterToolbar();

                    this.setLayout(state.layout, state.panes);
                    if (state.activePaneIndex >= 0 && state.activePaneIndex < this.charts.length) {
                        this.setActiveChart(this.charts[state.activePaneIndex]);
                    }
                    this.syncModalInputs();
                    return;
                }
            }
        } catch (err) {
            console.warn('Failed to load workspace', err);
        }

        // Multi-Pane Safe Storage Cleanup on startup
        if (favoritesManager.onlySaveFavorites) {
            DataWorkerClient.pruneNonFavorites(
                favoritesManager.getFavorites(),
                this.charts.map(c => c.currentSymbol)
            );
        }

        this.setLayout('1'); // Fallback if no save exists
        this.autoCenterToolbar();
    }

    public static getActiveChart(): EcoChart | null {
        return this.activeChart;
    }

    public static setActiveChart(chart: EcoChart) {
        if (this.activeChart === chart) return;
        this.activeChart = chart;

        document.querySelectorAll('.chart-pane').forEach((p) => p.classList.remove('active-pane'));
        chart.container.classList.add('active-pane');
        this.syncTopBar();
    }

    public static syncTopBar() {
        const chart = this.activeChart;
        if (!chart) return;

        const accent = themeManager.getResolvedAccentColor();

        // 0. Sync Top Bar Quick-Star Button
        const btnQuickStar = document.getElementById('btn-quick-star');
        if (btnQuickStar) {
            const isFav = favoritesManager.isFavorite(chart.currentSymbol);
            btnQuickStar.textContent = isFav ? '★' : '☆';
            btnQuickStar.style.color = isFav ? '#FFB703' : '#787B86';
        }

        // 1. Symbol Button Label & Browser Title (Telemetry)
        const symLabel = document.getElementById('btn-symbol')?.querySelector('span');
        if (symLabel) {
            if (this.topBarDisplayMode === 'change') {
                const sign = chart.currentChangePct >= 0 ? '+' : '';
                const color = chart.currentChangePct >= 0 ? 'var(--chart-bull, #26A69A)' : 'var(--chart-bear, #EF5350)';
                symLabel.innerHTML = `${chart.currentSymbol} <span style="color: ${color}; margin-left: 6px; font-size: 11px;">${sign}${chart.currentChangePct.toFixed(2)}%</span>`;
                document.title = `${chart.currentSymbol} ${sign}${chart.currentChangePct.toFixed(2)}% | EcoChart`;
            } else {
                symLabel.textContent = chart.currentSymbol;
                document.title = `EcoChart - ${chart.currentSymbol}`;
            }
        }

        // 2. Timeframe Active Button (Syncs both Desktop Pills and Mobile Dropdown Items)
        document.querySelectorAll('.tf-btn').forEach((b) => {
            const btn = b as HTMLElement;
            const isMatch = btn.dataset.tf === chart.currentInterval;
            btn.style.background = isMatch ? 'var(--chart-grid, #2A2E39)' : 'transparent';
            btn.style.color = isMatch ? accent : '#787B86';
        });

        // 2b. Sync Mobile Timeframe Dropdown Label
        const mobileTfLabel = document.getElementById('mobile-tf-label');
        if (mobileTfLabel) {
            mobileTfLabel.textContent = chart.currentInterval;
        }

        // 3. Chart Mode Active Button (Syncs both Desktop and Mobile Dropdown Items)
        document.querySelectorAll('.mode-btn').forEach((b) => {
            const btn = b as HTMLElement;
            const isMatch = btn.dataset.mode === chart.renderer.chartMode;
            btn.style.background = isMatch ? 'var(--chart-grid, #2A2E39)' : 'transparent';
            btn.style.color = isMatch ? accent : '#787B86';
        });

        // 3b. Sync Mobile Mode Dropdown Label
        const mobileModeLabel = document.getElementById('mobile-mode-label');
        if (mobileModeLabel) {
            const modeIcons: Record<string, string> = {
                candles: '🕯️',
                bars: '📊',
                line: '📈',
                area: '🏔️',
                heikinAshi: 'HA'
            };
            mobileModeLabel.textContent = modeIcons[chart.renderer.chartMode] || '🕯️';
        }

        // 4. Auto-Fit Button
        if (chart.autoBtn) {
            chart.autoBtn.style.color = chart.renderer.isAutoScale ? accent : 'var(--chart-text, #787B86)';
        }
    }

    public static setLayout(layout: string, savedPanes?: SavedPaneState[]) {
        this.currentLayout = layout;
        const grid = document.getElementById('charts-grid');
        if (!grid) return;

        this.charts.forEach((c) => c.destroy());
        this.charts = [];
        grid.innerHTML = '';
        grid.className = `layout-${layout}`;

        const defaultConfigs = [
            { symbol: 'BTCUSDT', tf: '1m' },
            { symbol: 'ETHUSDT', tf: '5m' },
            { symbol: 'SOLUSDT', tf: '15m' },
            { symbol: 'BNBUSDT', tf: '1h' },
        ];

        let count = 1;
        if (layout === '2v' || layout === '2h') count = 2;
        if (layout === '3l' || layout === '3r') count = 3;
        if (layout === '4' || layout === '4v' || layout === '4h') count = 4;

        for (let i = 0; i < count; i++) {
            const pane = document.createElement('div');
            pane.className = 'chart-pane';
            pane.id = `chart-pane-${i}`;
            grid.appendChild(pane);

            const chart = new EcoChart(pane);

            if (savedPanes && savedPanes[i]) {
                chart.deserialize(savedPanes[i]);
            } else {
                const cfg = defaultConfigs[i] || defaultConfigs[0];
                chart.startLiveBinance(cfg.symbol, cfg.tf);
            }

            this.charts.push(chart);
            if (i === 0) this.setActiveChart(chart);
        }

        this.syncSessions();
        this.syncClock();
        this.syncSeparators();
        this.triggerAutoSave();
    }

    private static setupGlobalControls() {

        const dt = document.getElementById('drawing-toolbar');
        const dtHandle = document.getElementById('dt-drag-handle');

        if (dt && dtHandle) {
            // Prevent canvas from stealing touch events from the toolbar on mobile
            dt.addEventListener('touchstart', (e) => e.stopPropagation(), { passive: false });
            dt.addEventListener('pointerdown', (e) => e.stopPropagation());

            let isDragging = false;
            let startX = 0, startY = 0;
            let initialLeft = 0, initialTop = 0;
            let lastGripTapTime = 0;

            // 1. Draggable Engine (Smooth Dragging on Touch and Desktop)
            dtHandle.addEventListener('pointerdown', (e) => {
                if (WorkspaceManager.toolbarDockMode === 'top') return;

                startX = e.clientX;
                startY = e.clientY;
                initialLeft = dt.offsetLeft;
                initialTop = dt.offsetTop;
                isDragging = true;
                try { dtHandle.setPointerCapture(e.pointerId); } catch { }
                dtHandle.style.cursor = 'grabbing';
                dt.style.opacity = '1';
                if (navigator.vibrate) navigator.vibrate(25);
            });

            dtHandle.addEventListener('pointermove', (e) => {
                if (!isDragging) return;

                try { e.preventDefault(); } catch { } // Force touch devices to ignore native scroll gestures

                const dx = e.clientX - startX;
                const dy = e.clientY - startY;

                // Keep within screen bounds
                const newLeft = Math.max(0, Math.min(window.innerWidth - dt.offsetWidth, initialLeft + dx));
                const newTop = Math.max(38, Math.min(window.innerHeight - dt.offsetHeight, initialTop + dy)); // 38px avoids top bar

                dt.style.left = `${newLeft}px`;
                dt.style.top = `${newTop}px`;
                dt.style.transform = 'none';
            });

            const stopDrag = (e: PointerEvent) => {
                if (isDragging) {
                    isDragging = false;
                    try { dtHandle.releasePointerCapture(e.pointerId); } catch { }
                    dtHandle.style.cursor = 'grab';
                    dt.style.opacity = WorkspaceManager.toolbarVisibility === 'always' ? '1' : '1';

                    const movedDist = Math.hypot(dt.offsetLeft - initialLeft, dt.offsetTop - initialTop);
                    if (movedDist > 4) {
                        // User moved the toolbar: record and save their custom position
                        WorkspaceManager.toolbarCustomPos = {
                            left: dt.offsetLeft,
                            top: dt.offsetTop
                        };
                        WorkspaceManager.triggerAutoSave();
                    } else {
                        // Grip handle was tapped without dragging: detect double-tap to auto-center vertically
                        const now = Date.now();
                        if (now - lastGripTapTime < 350) {
                            WorkspaceManager.toolbarCustomPos = null;
                            WorkspaceManager.autoCenterToolbar(true);
                            WorkspaceManager.triggerAutoSave();
                            if (navigator.vibrate) navigator.vibrate(40);
                        }
                        lastGripTapTime = now;
                    }
                }
            };

            dtHandle.addEventListener('pointerup', stopDrag);
            dtHandle.addEventListener('pointercancel', stopDrag);

            // Double click explicitly on desktop
            dtHandle.addEventListener('dblclick', (e) => {
                e.stopPropagation();
                WorkspaceManager.toolbarCustomPos = null;
                WorkspaceManager.autoCenterToolbar(true);
                WorkspaceManager.triggerAutoSave();
            });

            // 2. Proximity Fading (Global)
            document.addEventListener('pointermove', (e) => {
                if (WorkspaceManager.toolbarVisibility === 'always') {
                    dt.style.opacity = '1';
                    return;
                }
                const rect = dt.getBoundingClientRect();
                // Calculate distance from mouse to the bounding box of the toolbar
                const dist = Math.max(
                    0,
                    rect.left - e.clientX,
                    e.clientX - rect.right,
                    rect.top - e.clientY,
                    e.clientY - rect.bottom
                );

                // If mouse is within 60px of the toolbar, fully visible
                if (dist < 60) {
                    dt.style.opacity = '1';
                } else {
                    dt.style.opacity = '0.15';
                }
            });

            document.addEventListener('mouseleave', () => {
                if (WorkspaceManager.toolbarVisibility !== 'always') {
                    dt.style.opacity = '0.15';
                }
            });

            // 3. Tool Click Dispatcher & Menus
            const btnLinesMain = document.getElementById('tool-lines-main');
            const linesMenu = document.getElementById('lines-menu');
            const btnHide = document.getElementById('tool-hide');
            const hideMenu = document.getElementById('hide-menu');
            const btnTrash = document.getElementById('tool-trash');
            const trashMenu = document.getElementById('trash-menu');

            // Helper to close all floating menus on the toolbar
            const closeAllDTMenus = () => {
                if (linesMenu) linesMenu.style.display = 'none';
                if (hideMenu) hideMenu.style.display = 'none';
                if (trashMenu) trashMenu.style.display = 'none';
            };

            // Main Lines Button - Opens dropdown
            btnLinesMain?.addEventListener('click', (e) => {
                e.stopPropagation();
                const isOp = linesMenu?.style.display === 'flex';
                closeAllDTMenus();
                if (linesMenu) linesMenu.style.display = isOp ? 'none' : 'flex';
            });

            // Handle Sub-Tools (Trendline, V-Line, H-Ray) inside the dropdown
            document.querySelectorAll('.sub-tool-btn').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const tool = (btn as HTMLElement).dataset.tool;
                    const icon = (btn as HTMLElement).dataset.icon;
                    if (this.activeChart && tool) {
                        this.activeChart.startDrawingTool(tool as any);

                        // Update Main Icon & Active State
                        if (btnLinesMain && icon) btnLinesMain.innerHTML = icon;
                        document.querySelectorAll('.dt-btn').forEach(b => b.classList.remove('active'));
                        btnLinesMain?.classList.add('active');
                    }
                    closeAllDTMenus();
                });
            });

            // Handle Top-Level Tools (Cursor, Rect, Fib, PRange)
            const topLevelTools = ['tool-cursor', 'tool-rect', 'tool-fib', 'tool-prange'];
            topLevelTools.forEach(id => {
                const el = document.getElementById(id);
                el?.addEventListener('click', (e) => {
                    e.stopPropagation();
                    closeAllDTMenus();
                    const tool = el.dataset.tool;
                    if (this.activeChart) {
                        if (tool === 'cursor') this.activeChart.cancelDrawingTool();
                        else this.activeChart.startDrawingTool(tool as any);
                    }
                    document.querySelectorAll('.dt-btn').forEach(b => b.classList.remove('active'));
                    el.classList.add('active');
                });
            });

            // Dynamic Hide Menu
            btnHide?.addEventListener('click', (e) => {
                e.stopPropagation();
                const isOp = hideMenu?.style.display === 'flex';
                closeAllDTMenus();
                if (hideMenu && !isOp && this.activeChart) {
                    hideMenu.style.display = 'flex';

                    // Update Text Dynamically based on state
                    const drawBtn = hideMenu.querySelector('[data-action="drawings"]');
                    const indBtn = hideMenu.querySelector('[data-action="indicators"]');

                    const drwVisible = this.activeChart.drawingManager.isVisible;
                    const anyIndVisible = this.activeChart.indicatorManager.activeIndicators.some(i => i.visible);

                    if (drawBtn) drawBtn.textContent = drwVisible ? "Hide Drawings" : "Show Drawings";
                    if (indBtn) indBtn.textContent = anyIndVisible ? "Hide Indicators" : "Show Indicators";
                }
            });

            // Trash Menu
            btnTrash?.addEventListener('click', (e) => {
                e.stopPropagation();
                const isOp = trashMenu?.style.display === 'flex';
                closeAllDTMenus();
                if (trashMenu && !isOp) trashMenu.style.display = 'flex';
            });

            // Close menus when clicking outside
            document.addEventListener('click', closeAllDTMenus);

            // Magnet Toggle Sync
            const btnMagnet = document.getElementById('tool-magnet');
            btnMagnet?.addEventListener('click', (e) => {
                e.stopPropagation();
                closeAllDTMenus();
                if (this.activeChart) {
                    const manager = this.activeChart.drawingManager;
                    manager.isMagnetEnabled = !manager.isMagnetEnabled;

                    // Sync state across all active panes
                    this.charts.forEach(chart => {
                        chart.drawingManager.isMagnetEnabled = manager.isMagnetEnabled;
                        chart.renderer.isMagnetEnabled = manager.isMagnetEnabled;
                    });

                    btnMagnet.classList.toggle('active', manager.isMagnetEnabled);
                }
            });

            document.querySelectorAll('.hide-opt-btn').forEach(btn => {
                btn.addEventListener('click', () => {
                    const action = (btn as HTMLElement).dataset.action;
                    if (this.activeChart) {
                        const cm = this.activeChart;
                        if (action === 'drawings' || action === 'all') {
                            cm.drawingManager.isVisible = !cm.drawingManager.isVisible;
                        }
                        if (action === 'indicators' || action === 'all') {
                            const anyVisible = cm.indicatorManager.activeIndicators.some(i => i.visible);
                            cm.indicatorManager.activeIndicators.forEach(i => i.visible = !anyVisible);
                            cm.updateLegend();
                            cm.updateControlsLayout();
                        }
                        cm.isDirty = true;
                        if (hideMenu) hideMenu.style.display = 'none';
                    }
                });
            });

            document.querySelectorAll('.trash-opt-btn').forEach(btn => {
                btn.addEventListener('click', async () => { // <-- MAKE ASYNC
                    const action = (btn as HTMLElement).dataset.action;
                    if (this.activeChart) {
                        const cm = this.activeChart;
                        if (action === 'drawings' || action === 'all') {
                            if (await WorkspaceManager.confirmAction('Remove Drawings', 'Delete all drawings from the active chart?')) {
                                cm.drawingManager.drawings = [];
                                cm.drawingManager.currentDrawing = null;
                            }
                        }
                        if (action === 'indicators' || action === 'all') {
                            if (await WorkspaceManager.confirmAction('Remove Indicators', 'Delete all indicators from the active chart?')) {
                                cm.indicatorManager.activeIndicators.forEach(i => cm.renderer.removeIndicatorMesh(i.id));
                                cm.indicatorManager.clearAll();
                                cm.updateLegend();
                                cm.updateControlsLayout();
                            }
                        }
                        cm.isDirty = true;
                        WorkspaceManager.triggerAutoSave();
                        if (trashMenu) trashMenu.style.display = 'none';
                    }
                });
            });
        }

        // Layout Menu Toggle
        const btnLayout = document.getElementById('btn-layout');
        const layoutMenu = document.getElementById('layout-menu');

        btnLayout?.addEventListener('click', (e) => {
            e.stopPropagation();
            if (layoutMenu) {
                const isOpen = layoutMenu.style.display === 'flex';
                layoutMenu.style.display = isOpen ? 'none' : 'flex';
                if (mobileTfMenu) mobileTfMenu.style.display = 'none';
                if (mobileModeMenu) mobileModeMenu.style.display = 'none';
            }
        });

        layoutMenu?.addEventListener('click', (e) => {
            e.stopPropagation();
        });

        document.addEventListener('click', () => {
            if (layoutMenu) layoutMenu.style.display = 'none';
            if (mobileTfMenu) mobileTfMenu.style.display = 'none';
            if (mobileModeMenu) mobileModeMenu.style.display = 'none';
        });

        document.querySelectorAll('.layout-opt-btn').forEach((btn) => {
            btn.addEventListener('click', () => {
                const lay = (btn as HTMLElement).dataset.layout || '1';
                this.setLayout(lay);
                if (layoutMenu) layoutMenu.style.display = 'none';
            });
        });

        // Timeframe Buttons
        document.querySelectorAll('.tf-btn').forEach((btn) => {
            btn.addEventListener('click', () => {
                const tf = (btn as HTMLElement).dataset.tf;
                if (tf && this.activeChart && tf !== this.activeChart.currentInterval) {
                    this.activeChart.switchTimeframe(tf);
                    this.syncTopBar();
                }
            });
        });

        // Mode Buttons
        document.querySelectorAll('.mode-btn').forEach((btn) => {
            btn.addEventListener('click', () => {
                const mode = (btn as HTMLElement).dataset.mode as any;
                if (mode && this.activeChart) {
                    this.activeChart.renderer.chartMode = mode;
                    this.activeChart.isDirty = true;
                    this.syncTopBar();
                    this.triggerAutoSave();
                }
            });
        });

        // Mobile Timeframe Dropdown
        const btnMobileTf = document.getElementById('btn-mobile-tf');
        const mobileTfMenu = document.getElementById('mobile-tf-menu');
        const btnMobileMode = document.getElementById('btn-mobile-mode');
        const mobileModeMenu = document.getElementById('mobile-mode-menu');

        btnMobileTf?.addEventListener('click', (e) => {
            e.stopPropagation();
            if (mobileTfMenu) {
                const isOpen = mobileTfMenu.style.display === 'flex';
                mobileTfMenu.style.display = isOpen ? 'none' : 'flex';
                if (mobileModeMenu) mobileModeMenu.style.display = 'none';
                if (layoutMenu) layoutMenu.style.display = 'none';
            }
        });

        // Mobile Mode Dropdown
        btnMobileMode?.addEventListener('click', (e) => {
            e.stopPropagation();
            if (mobileModeMenu) {
                const isOpen = mobileModeMenu.style.display === 'flex';
                mobileModeMenu.style.display = isOpen ? 'none' : 'flex';
                if (mobileTfMenu) mobileTfMenu.style.display = 'none';
                if (layoutMenu) layoutMenu.style.display = 'none';
            }
        });

        // Close dropdowns when clicking outside (already handled above, but extend here)

        // Close menus when an item is clicked
        mobileTfMenu?.querySelectorAll('.tf-btn').forEach((btn) => {
            btn.addEventListener('click', () => {
                if (mobileTfMenu) mobileTfMenu.style.display = 'none';
            });
        });

        mobileModeMenu?.querySelectorAll('.mode-btn').forEach((btn) => {
            btn.addEventListener('click', () => {
                if (mobileModeMenu) mobileModeMenu.style.display = 'none';
            });
        });


        // --- Settings Modal & Theme Customization ---
        const btnSettings = document.getElementById('btn-settings');
        const modalSettings = document.getElementById('settings-modal') as HTMLDialogElement;
        const btnCloseSettings = document.getElementById('btn-close-settings');
        const btnModalCloseX = document.getElementById('btn-modal-close-x');

        // Modal Tabs
        const modalTabs = document.querySelectorAll('.modal-tab-btn');
        modalTabs.forEach((tab) => {
            tab.addEventListener('click', () => {
                const target = (tab as HTMLElement).dataset.tab;
                modalTabs.forEach((t) => {
                    t.classList.remove('active-tab');
                    (t as HTMLElement).style.background = 'transparent';
                    (t as HTMLElement).style.color = 'var(--chart-text, #787B86)';
                });
                tab.classList.add('active-tab');
                (tab as HTMLElement).style.background = 'var(--chart-grid, #2A2E39)';
                (tab as HTMLElement).style.color = 'var(--chart-accent, #2962FF)';

                document.querySelectorAll('.modal-tab-content').forEach((c) => {
                    (c as HTMLElement).style.display = 'none';
                });
                const activeContent = document.getElementById(`tab-content-${target}`);
                if (activeContent) activeContent.style.display = 'block';
            });
        });

        // Theme Presets Grid
        const presetGrid = document.getElementById('preset-grid');
        if (presetGrid) {
            presetGrid.innerHTML = '';
            Object.values(THEME_PRESETS).forEach((p) => {
                const card = document.createElement('button');
                card.type = 'button';
                card.style.cssText = 'background:#1e222d;border:1px solid #363a45;border-radius:4px;padding:6px 10px;display:flex;align-items:center;gap:8px;cursor:pointer;color:#D1D4DC;font-size:12px;text-align:left;';
                card.innerHTML = `
                    <span style="width:12px;height:12px;border-radius:2px;background:${p.bullBody};display:inline-block;"></span>
                    <span style="width:12px;height:12px;border-radius:2px;background:${p.bearBody};display:inline-block;"></span>
                    <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${p.name}</span>
                `;
                card.onclick = () => {
                    // Clicking a preset manually switches mode back to manual
                    themeManager.setDynamicConfig({ mode: 'manual' });
                    themeManager.setThemeById(p.id);
                    syncModalInputs();
                };
                presetGrid.appendChild(card);
            });
        }

        // Symbol Cache Clear & Status
        const btnClearSymbolCache = document.getElementById('btn-clear-symbol-cache');
        const labelSymbolCache = document.getElementById('label-symbol-cache-status');

        const updateSymbolCacheLabel = () => {
            if (!labelSymbolCache) return;
            const cached = localStorage.getItem('ecochart_binance_symbols_v1');
            if (cached) {
                try {
                    const parsed = JSON.parse(cached);
                    const count = Array.isArray(parsed.symbols) ? parsed.symbols.length : 0;
                    labelSymbolCache.textContent = `${count} pairs cached`;
                    labelSymbolCache.style.color = 'var(--chart-bull, #26A69A)';
                } catch {
                    labelSymbolCache.textContent = 'Invalid cache';
                }
            } else {
                labelSymbolCache.textContent = 'Not cached (Fetches live)';
                labelSymbolCache.style.color = '#787B86';
            }
        };

        btnClearSymbolCache?.addEventListener('click', async () => {
            if (await WorkspaceManager.confirmAction('Clear Symbol Cache', 'Remove stored USDT trading pairs? They will be freshly downloaded on next search.')) {
                localStorage.removeItem('ecochart_binance_symbols_v1');
                updateSymbolCacheLabel();
            }
        });

        const syncModalInputs = () => {
            updateSymbolCacheLabel();

            // Sync Dynamic Theme Controls (Options A - D)
            const dynCfg = themeManager.getDynamicConfig();
            const selDynMode = document.getElementById('select-dynamic-theme-mode') as HTMLSelectElement;
            const boxDynOpts = document.getElementById('dynamic-theme-options');
            const rowDayTheme = document.getElementById('row-day-theme');
            const rowNightTheme = document.getElementById('row-night-theme');
            const rowHours = document.getElementById('row-schedule-hours');
            const selDayTheme = document.getElementById('select-day-theme') as HTMLSelectElement;
            const selNightTheme = document.getElementById('select-night-theme') as HTMLSelectElement;
            const inputDayHour = document.getElementById('input-day-start-hour') as HTMLInputElement;
            const inputNightHour = document.getElementById('input-night-start-hour') as HTMLInputElement;

            if (selDynMode) selDynMode.value = dynCfg.mode;
            if (selDayTheme) selDayTheme.value = dynCfg.dayThemeId;
            if (selNightTheme) selNightTheme.value = dynCfg.nightThemeId;
            if (inputDayHour) inputDayHour.value = String(dynCfg.dayStartHour);
            if (inputNightHour) inputNightHour.value = String(dynCfg.nightStartHour);

            // Contextual Visibility based on Mode
            if (boxDynOpts) {
                if (dynCfg.mode === 'manual' || dynCfg.mode === 'session') {
                    boxDynOpts.style.display = 'none';
                } else {
                    boxDynOpts.style.display = 'flex';
                    if (rowDayTheme) rowDayTheme.style.display = 'flex';
                    if (rowNightTheme) rowNightTheme.style.display = 'flex';
                    if (rowHours) rowHours.style.display = (dynCfg.mode === 'schedule' || dynCfg.mode === 'solar-session') ? 'flex' : 'none';
                }
            }



            // Sync Data Limit Dropdowns
            Object.keys(WorkspaceManager.dataLimits).forEach(key => {
                const el = document.getElementById(key) as HTMLSelectElement;
                if (el) el.value = String(WorkspaceManager.dataLimits[key]);
            });

            const selDock = document.getElementById('select-toolbar-dock') as HTMLSelectElement;
            if (selDock) selDock.value = WorkspaceManager.toolbarDockMode;

            const selVisibility = document.getElementById('select-toolbar-visibility') as HTMLSelectElement;
            if (selVisibility) selVisibility.value = WorkspaceManager.toolbarVisibility;

            const checkAutoToolbar = document.getElementById('check-autohide-toolbar') as HTMLInputElement;
            if (checkAutoToolbar) checkAutoToolbar.checked = (WorkspaceManager.toolbarVisibility === 'autohide');

            const selTopBar = document.getElementById('select-topbar-display') as HTMLSelectElement;
            if (selTopBar) selTopBar.value = WorkspaceManager.topBarDisplayMode;

            const selectFPS = document.getElementById('select-fps-limit') as HTMLSelectElement;
            if (selectFPS) selectFPS.value = WorkspaceManager.targetFPS.toString();

            // Sync Selective Persistence Checkbox
            const checkOnlyFavs = document.getElementById('check-only-save-favorites') as HTMLInputElement;
            if (checkOnlyFavs) checkOnlyFavs.checked = favoritesManager.onlySaveFavorites;

            const checkAutoHide = document.getElementById('check-autohide-nav') as HTMLInputElement;
            if (checkAutoHide) checkAutoHide.checked = WorkspaceManager.isAutoHideNav;

            const checkSync = document.getElementById('check-sync-crosshair') as HTMLInputElement;
            if (checkSync) checkSync.checked = WorkspaceManager.isCrosshairSyncEnabled;

            const current = themeManager.getTheme();
            const setSwatch = (id: string, color: string) => {
                const el = document.getElementById(id);
                if (el) {
                    el.dataset.color = color;
                    el.style.backgroundColor = color;
                }
            };

            // Sync Session Toggles & Swatches
            WorkspaceManager.ensureSessionConfig();
            const sc = WorkspaceManager.sessionConfig;
            const syncCheck = (id: string, val: boolean) => {
                const el = document.getElementById(id) as HTMLInputElement;
                if (el) el.checked = !!val;
            };
            const syncVal = (id: string, val: any) => {
                const el = document.getElementById(id) as HTMLInputElement | HTMLSelectElement;
                if (el) el.value = String(val ?? '');
            };

            syncCheck('check-sessions-enabled', sc.enabled);
            syncCheck('check-sessions-ranges', sc.showRanges ?? true);
            syncCheck('check-sessions-axis', sc.showOnAxis);

            const rangeAxisOp = document.getElementById('input-sess-axis-opacity') as HTMLInputElement | null;
            const labelAxisOp = document.getElementById('label-sess-axis-opacity');
            if (rangeAxisOp) rangeAxisOp.value = String(sc.axisOpacity ?? 40);
            if (labelAxisOp) labelAxisOp.textContent = `${sc.axisOpacity ?? 40}%`;

            // Sessions A, B, C, D
            syncCheck('check-sess-a-enabled', sc.sessionA.enabled);
            syncCheck('check-sess-a-range', sc.sessionA.range);
            syncVal('input-sess-a-name', sc.sessionA.name);
            syncVal('input-sess-a-hours', sc.sessionA.hours);
            setSwatch('input-sess-a-color', sc.sessionA.color);

            syncCheck('check-sess-b-enabled', sc.sessionB.enabled);
            syncCheck('check-sess-b-range', sc.sessionB.range);
            syncVal('input-sess-b-name', sc.sessionB.name);
            syncVal('input-sess-b-hours', sc.sessionB.hours);
            setSwatch('input-sess-b-color', sc.sessionB.color);

            syncCheck('check-sess-c-enabled', sc.sessionC.enabled);
            syncCheck('check-sess-c-range', sc.sessionC.range);
            syncVal('input-sess-c-name', sc.sessionC.name);
            syncVal('input-sess-c-hours', sc.sessionC.hours);
            setSwatch('input-sess-c-color', sc.sessionC.color);

            syncCheck('check-sess-d-enabled', sc.sessionD.enabled);
            syncCheck('check-sess-d-range', sc.sessionD.range);
            syncVal('input-sess-d-name', sc.sessionD.name);
            syncVal('input-sess-d-hours', sc.sessionD.hours);
            setSwatch('input-sess-d-color', sc.sessionD.color);

            // Timezone
            syncCheck('check-sess-exchange-tz', sc.exchangeTimezone ?? true);
            syncVal('select-sess-tz-offset', sc.timezoneOffset ?? 0);

            // Ranges Settings
            syncVal('input-sess-range-transparency', sc.rangeTransparency ?? 80);
            syncCheck('check-sess-range-outline', sc.rangeOutline ?? true);
            syncCheck('check-sess-range-label', sc.rangeLabel ?? true);
            syncCheck('check-sess-end-time', sc.showEndTime ?? true);
            syncCheck('check-sess-range-mean', sc.showMean ?? false);

            // Opening & Breakout (ORB) Settings
            syncCheck('check-sess-highlight-open', sc.highlightOpen ?? true);
            syncVal('select-sess-open-window', sc.openWindowDuration ?? 15);
            syncCheck('check-sess-orb-lines', sc.showOpeningRange ?? true);
            syncCheck('check-sess-pre-open', sc.showPreOpenZone ?? true);
            syncCheck('check-sess-end-on-next-open', sc.endOnNextOpen ?? true);
            syncCheck('check-sess-open-bell-line', sc.showOpenBellLine ?? true);

            setSwatch('input-bull-body', current.bullBody);
            setSwatch('input-bear-body', current.bearBody);
            setSwatch('input-bull-wick', current.bullWick);
            setSwatch('input-bear-wick', current.bearWick);
            setSwatch('input-bg-color', current.background);
            setSwatch('input-grid-color', current.gridLines);
            setSwatch('input-custom-accent', current.accentColor);

            const radioBull = document.getElementById('accent-src-bull') as HTMLInputElement;
            const radioCustom = document.getElementById('accent-src-custom') as HTMLInputElement;
            if (radioBull && radioCustom) {
                radioBull.checked = current.accentSource === 'bull';
                radioCustom.checked = current.accentSource === 'custom';
            }

            const selCrosshair = document.getElementById('select-crosshair-style') as HTMLSelectElement;
            const selPrice = document.getElementById('select-live-price-style') as HTMLSelectElement;
            const selLineWidth = document.getElementById('select-main-line-width') as HTMLSelectElement;
            if (this.activeChart) {
                if (selCrosshair) selCrosshair.value = this.activeChart.renderer.crosshairStyle;
                if (selPrice) selPrice.value = this.activeChart.renderer.livePriceStyle;
                if (selLineWidth) selLineWidth.value = this.activeChart.renderer.mainLineWidth.toString();
            }

            // Sync Clock Controls (now properly inside syncModalInputs)
            const chkClock = document.getElementById('check-clock-enabled') as HTMLInputElement;
            if (chkClock) chkClock.checked = WorkspaceManager.clockConfig.enabled;
            const selClock1 = document.getElementById('select-clock-primary') as HTMLSelectElement;
            if (selClock1) selClock1.value = WorkspaceManager.clockConfig.primaryTz;
            const selClock2 = document.getElementById('select-clock-secondary') as HTMLSelectElement;
            if (selClock2) selClock2.value = WorkspaceManager.clockConfig.secondaryTz;

            // Sync Period & Day of Week Separator Controls
            const chkSepEnabled = document.getElementById('check-separator-enabled') as HTMLInputElement;
            if (chkSepEnabled) chkSepEnabled.checked = WorkspaceManager.separatorConfig.enabled;
            const chkSepDow = document.getElementById('check-separator-dow') as HTMLInputElement;
            if (chkSepDow) chkSepDow.checked = WorkspaceManager.separatorConfig.showDOW;
            const selSepDowPos = document.getElementById('select-separator-dow-position') as HTMLSelectElement;
            if (selSepDowPos) selSepDowPos.value = WorkspaceManager.separatorConfig.dowPosition || 'Bottom';
            const inpSepDowOffset = document.getElementById('input-separator-dow-offset') as HTMLInputElement;
            if (inpSepDowOffset) inpSepDowOffset.value = String(WorkspaceManager.separatorConfig.dowVerticalOffset);
            setSwatch('input-separator-dow-color', WorkspaceManager.separatorConfig.dowColor);

            const chkSepDay = document.getElementById('check-separator-day') as HTMLInputElement;
            if (chkSepDay) chkSepDay.checked = WorkspaceManager.separatorConfig.showDay;
            const selSepDayStyle = document.getElementById('select-separator-day-style') as HTMLSelectElement;
            if (selSepDayStyle) selSepDayStyle.value = WorkspaceManager.separatorConfig.lineStyle;
            setSwatch('input-separator-day-color', WorkspaceManager.separatorConfig.lineColor);

            const chkSep4H = document.getElementById('check-separator-4h') as HTMLInputElement;
            if (chkSep4H) chkSep4H.checked = WorkspaceManager.separatorConfig.show4H;
            const selSep4HStyle = document.getElementById('select-separator-4h-style') as HTMLSelectElement;
            if (selSep4HStyle) selSep4HStyle.value = WorkspaceManager.separatorConfig.lineStyle4H;
            setSwatch('input-separator-4h-color', WorkspaceManager.separatorConfig.lineColor4H);

            const chkSep1H = document.getElementById('check-separator-1h') as HTMLInputElement;
            if (chkSep1H) chkSep1H.checked = WorkspaceManager.separatorConfig.show1H;
            const selSep1HStyle = document.getElementById('select-separator-1h-style') as HTMLSelectElement;
            if (selSep1HStyle) selSep1HStyle.value = WorkspaceManager.separatorConfig.lineStyle1H;
            setSwatch('input-separator-1h-color', WorkspaceManager.separatorConfig.lineColor1H);

            const chkSepFuture = document.getElementById('check-separator-future') as HTMLInputElement;
            if (chkSepFuture) chkSepFuture.checked = WorkspaceManager.separatorConfig.showFuture;

            // Sync Candle Tab HTF & Auto-Peek Controls
            if (this.activeChart) {
                const c = this.activeChart;
                const activeTf = c.candleHtfTimeframe;
                const activeCustomMins = c.candleHtfCustomMins;
                const peekDur = c.htfOverlayDurationSec;
                const showWicks = c.showHtfWicks;
                const opacity = Math.round(c.htfCandleOpacity * 100);
                const showHud = c.showHtfOverlayHud;

                syncVal('select-candle-htf-timeframe', activeTf);
                const rowCustom = document.getElementById('row-candle-htf-custom');
                if (rowCustom) rowCustom.style.display = activeTf === 'Custom' ? 'flex' : 'none';
                syncVal('input-candle-htf-custom-mins', activeCustomMins);

                // Populate dynamic options for select-candle-auto-peek-cadence based on activeChart's HTF:
                const selAutoPeekCadence = document.getElementById('select-candle-auto-peek-cadence') as HTMLSelectElement | null;
                if (selAutoPeekCadence) {
                    const availableOpts = c.getAvailableAutoPeekOptions();
                    selAutoPeekCadence.innerHTML = availableOpts.map(o => `<option value="${o.value}">${o.label}</option>`).join('');
                    selAutoPeekCadence.value = c.autoPeekCadence;
                }
                const rowAutoPeekCustom = document.getElementById('row-candle-autopeek-custom');
                if (rowAutoPeekCustom) {
                    const isCust = c.autoPeekCadence === 'custom_m' || c.autoPeekCadence === 'custom_h';
                    rowAutoPeekCustom.style.display = isCust ? 'flex' : 'none';
                    const unitLbl = document.getElementById('label-candle-autopeek-unit');
                    if (unitLbl) unitLbl.textContent = c.autoPeekCadence === 'custom_h' ? 'hours' : 'mins';
                }
                syncVal('input-candle-autopeek-custom-val', c.autoPeekCustomValue);
                syncVal('select-candle-peek-duration', peekDur);
                syncCheck('check-candle-htf-wicks', showWicks);
                syncCheck('check-candle-show-htf-hud', showHud);
                syncVal('range-candle-htf-opacity', opacity);
                const lblOp = document.getElementById('label-candle-htf-opacity');
                if (lblOp) lblOp.textContent = `${opacity}%`;
            }
        };


        const bindSwatch = (btnId: string, themeKey: keyof ChartTheme, showOpacity = true) => {
            const btn = document.getElementById(btnId);
            if (!btn) return;
            btn.addEventListener('click', () => {
                const currentColor = btn.dataset.color || '#26A69A';
                colorPicker.open({
                    anchorElement: btn,
                    initialColor: currentColor,
                    showOpacity,
                    showStrokeOptions: false,
                    onChange: (res) => {
                        const aHex = Math.round(res.opacity * 255).toString(16).padStart(2, '0');
                        const fullHex = `${res.color.slice(0, 7)}${aHex}`.toUpperCase();
                        btn.dataset.color = fullHex;
                        btn.style.backgroundColor = fullHex;
                        themeManager.updateColor(themeKey, fullHex);
                    }
                });
            });
        };

        bindSwatch('input-bg-color', 'background', false);
        bindSwatch('input-bull-body', 'bullBody', true);
        bindSwatch('input-bear-body', 'bearBody', true);
        bindSwatch('input-bull-wick', 'bullWick', true);
        bindSwatch('input-bear-wick', 'bearWick', true);
        bindSwatch('input-custom-accent', 'accentColor', false);

        // Bind Session Controls
        const bindSessBool = (id: string, setter: (val: boolean) => void) => {
            const el = document.getElementById(id) as HTMLInputElement | null;
            if (!el) return;
            el.addEventListener('change', () => {
                WorkspaceManager.ensureSessionConfig();
                setter(el.checked);
                WorkspaceManager.syncSessions();
                WorkspaceManager.saveWorkspace();
            });
        };

        const bindSessText = (id: string, setter: (val: string) => void) => {
            const el = document.getElementById(id) as HTMLInputElement | null;
            if (!el) return;
            el.addEventListener('input', () => {
                WorkspaceManager.ensureSessionConfig();
                setter(el.value);
                WorkspaceManager.syncSessions();
                WorkspaceManager.saveWorkspace();
            });
        };

        const bindSessNum = (id: string, setter: (val: number) => void) => {
            const el = document.getElementById(id) as HTMLInputElement | null;
            if (!el) return;
            const handler = () => {
                WorkspaceManager.ensureSessionConfig();
                setter(parseFloat(el.value) || 0);
                WorkspaceManager.syncSessions();
                WorkspaceManager.saveWorkspace();
            };
            el.addEventListener('input', handler);
            el.addEventListener('change', handler);
        };

        const bindSessSwatch = (btnId: string, getter: () => string, setter: (hex: string) => void) => {
            const btn = document.getElementById(btnId);
            if (!btn) return;
            btn.addEventListener('click', () => {
                WorkspaceManager.ensureSessionConfig();
                const currentHex = btn.dataset.color || getter() || '#FFFFFF';
                colorPicker.open({
                    anchorElement: btn,
                    initialColor: currentHex,
                    showOpacity: true,
                    showStrokeOptions: false,
                    onChange: (res) => {
                        const aHex = Math.round(res.opacity * 255).toString(16).padStart(2, '0');
                        const fullHex = `${res.color.slice(0, 7)}${aHex}`.toUpperCase();
                        btn.dataset.color = fullHex;
                        btn.style.backgroundColor = fullHex;
                        WorkspaceManager.ensureSessionConfig();
                        setter(fullHex);
                        WorkspaceManager.syncSessions();
                        WorkspaceManager.saveWorkspace();
                    }
                });
            });
        };

        bindSessBool('check-sessions-enabled', (v) => WorkspaceManager.sessionConfig.enabled = v);
        bindSessBool('check-sessions-ranges', (v) => WorkspaceManager.sessionConfig.showRanges = v);
        bindSessBool('check-sessions-axis', (v) => WorkspaceManager.sessionConfig.showOnAxis = v);

        // Axis Highlight Opacity slider
        const rangeAxisOp = document.getElementById('input-sess-axis-opacity') as HTMLInputElement | null;
        const labelAxisOp = document.getElementById('label-sess-axis-opacity');
        if (rangeAxisOp) {
            rangeAxisOp.addEventListener('input', (e) => {
                const val = parseInt((e.target as HTMLInputElement).value, 10) || 0;
                WorkspaceManager.ensureSessionConfig();
                WorkspaceManager.sessionConfig.axisOpacity = val;
                if (labelAxisOp) labelAxisOp.textContent = `${val}%`;
                WorkspaceManager.syncSessions();
                WorkspaceManager.saveWorkspace();
            });
        }

        // Session A: Swatch changes ONLY the box range color!
        bindSessBool('check-sess-a-enabled', (v) => WorkspaceManager.sessionConfig.sessionA.enabled = v);
        bindSessBool('check-sess-a-range', (v) => WorkspaceManager.sessionConfig.sessionA.range = v);
        bindSessText('input-sess-a-name', (v) => WorkspaceManager.sessionConfig.sessionA.name = v);
        bindSessText('input-sess-a-hours', (v) => WorkspaceManager.sessionConfig.sessionA.hours = v);
        bindSessSwatch('input-sess-a-color', () => WorkspaceManager.sessionConfig.sessionA.color, (c) => {
            WorkspaceManager.sessionConfig.sessionA.color = c;
        });

        // Session B: Swatch changes ONLY the box range color!
        bindSessBool('check-sess-b-enabled', (v) => WorkspaceManager.sessionConfig.sessionB.enabled = v);
        bindSessBool('check-sess-b-range', (v) => WorkspaceManager.sessionConfig.sessionB.range = v);
        bindSessText('input-sess-b-name', (v) => WorkspaceManager.sessionConfig.sessionB.name = v);
        bindSessText('input-sess-b-hours', (v) => WorkspaceManager.sessionConfig.sessionB.hours = v);
        bindSessSwatch('input-sess-b-color', () => WorkspaceManager.sessionConfig.sessionB.color, (c) => {
            WorkspaceManager.sessionConfig.sessionB.color = c;
        });

        // Session C: Swatch changes ONLY the box range color!
        bindSessBool('check-sess-c-enabled', (v) => WorkspaceManager.sessionConfig.sessionC.enabled = v);
        bindSessBool('check-sess-c-range', (v) => WorkspaceManager.sessionConfig.sessionC.range = v);
        bindSessText('input-sess-c-name', (v) => WorkspaceManager.sessionConfig.sessionC.name = v);
        bindSessText('input-sess-c-hours', (v) => WorkspaceManager.sessionConfig.sessionC.hours = v);
        bindSessSwatch('input-sess-c-color', () => WorkspaceManager.sessionConfig.sessionC.color, (c) => {
            WorkspaceManager.sessionConfig.sessionC.color = c;
        });

        // Session D: Swatch changes ONLY the box range color!
        bindSessBool('check-sess-d-enabled', (v) => WorkspaceManager.sessionConfig.sessionD.enabled = v);
        bindSessBool('check-sess-d-range', (v) => WorkspaceManager.sessionConfig.sessionD.range = v);
        bindSessText('input-sess-d-name', (v) => WorkspaceManager.sessionConfig.sessionD.name = v);
        bindSessText('input-sess-d-hours', (v) => WorkspaceManager.sessionConfig.sessionD.hours = v);
        bindSessSwatch('input-sess-d-color', () => WorkspaceManager.sessionConfig.sessionD.color, (c) => {
            WorkspaceManager.sessionConfig.sessionD.color = c;
        });

        // Timezone
        bindSessBool('check-sess-exchange-tz', (v) => {
            WorkspaceManager.sessionConfig.exchangeTimezone = v;
            const selOffset = document.getElementById('select-sess-tz-offset') as HTMLSelectElement | null;
            if (selOffset) selOffset.style.opacity = v ? '0.6' : '1.0';
        });
        document.getElementById('select-sess-tz-offset')?.addEventListener('change', (e) => {
            WorkspaceManager.ensureSessionConfig();
            WorkspaceManager.sessionConfig.timezoneOffset = parseInt((e.target as HTMLSelectElement).value, 10) || 0;
            // Explicit offset selection turns off exchange timezone
            const chkExchange = document.getElementById('check-sess-exchange-tz') as HTMLInputElement | null;
            if (chkExchange && chkExchange.checked) {
                chkExchange.checked = false;
                WorkspaceManager.sessionConfig.exchangeTimezone = false;
            }
            const selOffset = document.getElementById('select-sess-tz-offset') as HTMLSelectElement | null;
            if (selOffset) selOffset.style.opacity = '1.0';
            WorkspaceManager.syncSessions();
            WorkspaceManager.saveWorkspace();
        });

        // Ranges Settings
        bindSessNum('input-sess-range-transparency', (v) => WorkspaceManager.sessionConfig.rangeTransparency = v);
        bindSessBool('check-sess-range-outline', (v) => WorkspaceManager.sessionConfig.rangeOutline = v);
        bindSessBool('check-sess-range-label', (v) => WorkspaceManager.sessionConfig.rangeLabel = v);
        bindSessBool('check-sess-end-time', (v) => WorkspaceManager.sessionConfig.showEndTime = v);
        bindSessBool('check-sess-range-mean', (v) => WorkspaceManager.sessionConfig.showMean = v);

        // Opening & Breakout (ORB) Controls
        bindSessBool('check-sess-highlight-open', (v) => WorkspaceManager.sessionConfig.highlightOpen = v);
        document.getElementById('select-sess-open-window')?.addEventListener('change', (e) => {
            WorkspaceManager.ensureSessionConfig();
            WorkspaceManager.sessionConfig.openWindowDuration = parseInt((e.target as HTMLSelectElement).value, 10) || 15;
            WorkspaceManager.syncSessions();
            WorkspaceManager.saveWorkspace();
        });
        bindSessBool('check-sess-orb-lines', (v) => WorkspaceManager.sessionConfig.showOpeningRange = v);
        bindSessBool('check-sess-pre-open', (v) => WorkspaceManager.sessionConfig.showPreOpenZone = v);
        bindSessBool('check-sess-end-on-next-open', (v) => WorkspaceManager.sessionConfig.endOnNextOpen = v);
        bindSessBool('check-sess-open-bell-line', (v) => WorkspaceManager.sessionConfig.showOpenBellLine = v);

        // Bind Clock Controls
        document.getElementById('check-clock-enabled')?.addEventListener('change', (e) => {
            WorkspaceManager.clockConfig.enabled = (e.target as HTMLInputElement).checked;
            WorkspaceManager.syncClock();
            WorkspaceManager.saveWorkspace();
        });

        document.getElementById('select-clock-primary')?.addEventListener('change', (e) => {
            WorkspaceManager.clockConfig.primaryTz = (e.target as HTMLSelectElement).value;
            WorkspaceManager.syncClock();
            WorkspaceManager.saveWorkspace();
        });

        document.getElementById('select-clock-secondary')?.addEventListener('change', (e) => {
            WorkspaceManager.clockConfig.secondaryTz = (e.target as HTMLSelectElement).value;
            WorkspaceManager.syncClock();
            WorkspaceManager.saveWorkspace();
        });

        // Bind Period & Day of Week Separator Controls
        const bindSepCheck = (id: string, key: keyof typeof WorkspaceManager.separatorConfig) => {
            document.getElementById(id)?.addEventListener('change', (e) => {
                (WorkspaceManager.separatorConfig as any)[key] = (e.target as HTMLInputElement).checked;
                WorkspaceManager.syncSeparators();
                WorkspaceManager.saveWorkspace();
            });
        };
        bindSepCheck('check-separator-enabled', 'enabled');
        bindSepCheck('check-separator-dow', 'showDOW');
        bindSepCheck('check-separator-day', 'showDay');
        bindSepCheck('check-separator-4h', 'show4H');
        bindSepCheck('check-separator-1h', 'show1H');
        bindSepCheck('check-separator-future', 'showFuture');

        const bindSepNumber = (id: string, key: keyof typeof WorkspaceManager.separatorConfig, minVal = 0) => {
            document.getElementById(id)?.addEventListener('input', (e) => {
                const val = parseFloat((e.target as HTMLInputElement).value);
                if (!isNaN(val)) {
                    (WorkspaceManager.separatorConfig as any)[key] = Math.max(minVal, val);
                    WorkspaceManager.syncSeparators();
                    WorkspaceManager.saveWorkspace();
                }
            });
        };
        bindSepNumber('input-separator-dow-offset', 'dowVerticalOffset', 0);

        const bindSepSelect = (id: string, key: keyof typeof WorkspaceManager.separatorConfig) => {
            document.getElementById(id)?.addEventListener('change', (e) => {
                (WorkspaceManager.separatorConfig as any)[key] = (e.target as HTMLSelectElement).value;
                WorkspaceManager.syncSeparators();
                WorkspaceManager.saveWorkspace();
            });
        };
        bindSepSelect('select-separator-dow-position', 'dowPosition');
        bindSepSelect('select-separator-day-style', 'lineStyle');
        bindSepSelect('select-separator-4h-style', 'lineStyle4H');
        bindSepSelect('select-separator-1h-style', 'lineStyle1H');

        const bindSepSwatch = (btnId: string, configKey: keyof typeof WorkspaceManager.separatorConfig) => {
            const btn = document.getElementById(btnId);
            if (!btn) return;
            btn.addEventListener('click', () => {
                const currentHex = (WorkspaceManager.separatorConfig as any)[configKey] || '#FFFFFF';
                colorPicker.open({
                    anchorElement: btn,
                    initialColor: currentHex,
                    showOpacity: true,
                    onChange: (res) => {
                        const aHex = Math.round(res.opacity * 255).toString(16).padStart(2, '0');
                        const fullHex = `${res.color.slice(0, 7)}${aHex}`.toUpperCase();
                        btn.dataset.color = fullHex;
                        btn.style.backgroundColor = fullHex;
                        (WorkspaceManager.separatorConfig as any)[configKey] = fullHex;
                        WorkspaceManager.syncSeparators();
                        WorkspaceManager.saveWorkspace();
                    }
                });
            });
        };
        bindSepSwatch('input-separator-dow-color', 'dowColor');
        bindSepSwatch('input-separator-day-color', 'lineColor');
        bindSepSwatch('input-separator-4h-color', 'lineColor4H');
        bindSepSwatch('input-separator-1h-color', 'lineColor1H');

        // Bind Data Limit Dropdowns
        document.querySelectorAll('.data-limit-select').forEach(select => {
            select.addEventListener('change', (e) => {
                const el = e.target as HTMLSelectElement;
                WorkspaceManager.dataLimits[el.id] = parseInt(el.value, 10);
                WorkspaceManager.triggerAutoSave();
            });
        });

        // Advanced Grid Swatch
        const btnGrid = document.getElementById('input-grid-color');
        if (btnGrid) {
            btnGrid.addEventListener('click', () => {
                const current = themeManager.getTheme();
                colorPicker.open({
                    anchorElement: btnGrid,
                    initialColor: btnGrid.dataset.color || current.gridLines,
                    initialThickness: current.gridThickness || 1,
                    initialStyle: current.gridStyle || 'solid',
                    showOpacity: true,
                    showStrokeOptions: true,
                    onChange: (res) => {
                        const aHex = Math.round(res.opacity * 255).toString(16).padStart(2, '0');
                        const fullHex = `${res.color.slice(0, 7)}${aHex}`.toUpperCase();
                        btnGrid.dataset.color = fullHex;
                        btnGrid.style.backgroundColor = fullHex;
                        themeManager.updateColor('gridLines', fullHex);
                        if (res.thickness) themeManager.updateColor('gridThickness' as any, res.thickness as any);
                        if (res.style) themeManager.updateColor('gridStyle' as any, res.style as any);
                        this.charts.forEach((c) => { c.isDirty = true; });
                    }
                });
            });
        }

        const selectCrosshair = document.getElementById('select-crosshair-style') as HTMLSelectElement;
        selectCrosshair?.addEventListener('change', (e) => {
            const style = (e.target as HTMLSelectElement).value as LineStyle;
            this.charts.forEach((c) => {
                c.renderer.crosshairStyle = style;
                c.isDirty = true;
            });
            themeManager.updateColor('crosshairLineStyle', style as any);
        });

        const selectLivePrice = document.getElementById('select-live-price-style') as HTMLSelectElement;
        selectLivePrice?.addEventListener('change', (e) => {
            const style = (e.target as HTMLSelectElement).value as LineStyle;
            this.charts.forEach((c) => {
                c.renderer.livePriceStyle = style;
                c.isDirty = true;
            });
            themeManager.updateColor('livePriceLineStyle', style as any);
        });

        const selectMainLineWidth = document.getElementById('select-main-line-width') as HTMLSelectElement;
        selectMainLineWidth?.addEventListener('change', (e) => {
            const width = parseInt((e.target as HTMLSelectElement).value, 10);
            this.charts.forEach((c) => {
                c.renderer.mainLineWidth = width;
                c.isDirty = true;
            });
        });

        // Dynamic Theme Mode Listeners (Options A - D)
        document.getElementById('select-dynamic-theme-mode')?.addEventListener('change', (e) => {
            const mode = (e.target as HTMLSelectElement).value as any;
            themeManager.setDynamicConfig({ mode });
            syncModalInputs();
        });

        document.getElementById('select-day-theme')?.addEventListener('change', (e) => {
            const dayThemeId = (e.target as HTMLSelectElement).value;
            themeManager.setDynamicConfig({ dayThemeId });
        });

        document.getElementById('select-night-theme')?.addEventListener('change', (e) => {
            const nightThemeId = (e.target as HTMLSelectElement).value;
            themeManager.setDynamicConfig({ nightThemeId });
        });

        document.getElementById('input-day-start-hour')?.addEventListener('change', (e) => {
            const val = parseInt((e.target as HTMLInputElement).value, 10);
            if (!isNaN(val) && val >= 0 && val <= 23) {
                themeManager.setDynamicConfig({ dayStartHour: val });
            }
        });

        document.getElementById('input-night-start-hour')?.addEventListener('change', (e) => {
            const val = parseInt((e.target as HTMLInputElement).value, 10);
            if (!isNaN(val) && val >= 0 && val <= 23) {
                themeManager.setDynamicConfig({ nightStartHour: val });
            }
        });

        document.querySelectorAll('input[name="accent-source"]').forEach((radio) => {
            radio.addEventListener('change', (e) => {
                const src = (e.target as HTMLInputElement).value as AccentSource;
                themeManager.setAccentSource(src);
            });
        });

        btnSettings?.addEventListener('click', () => {
            syncModalInputs();
            const selectFPS = document.getElementById('select-fps-limit') as HTMLSelectElement;
            if (selectFPS) selectFPS.value = WorkspaceManager.targetFPS.toString();
            const checkSync = document.getElementById('check-sync-crosshair') as HTMLInputElement;
            if (checkSync) checkSync.checked = WorkspaceManager.isCrosshairSyncEnabled;

            const checkPaintHud = document.getElementById('check-paint-hud') as HTMLInputElement;
            if (checkPaintHud) checkPaintHud.checked = WorkspaceManager.showPaintFpsHud;

            const checkPaintLog = document.getElementById('check-paint-log') as HTMLInputElement;
            if (checkPaintLog) checkPaintLog.checked = WorkspaceManager.logPaintFps;
            modalSettings?.showModal();
        });

        // FPS Limit Listener
        const selectFPS = document.getElementById('select-fps-limit') as HTMLSelectElement;
        selectFPS?.addEventListener('change', (e) => {
            const newFps = parseInt((e.target as HTMLSelectElement).value, 10);
            if (newFps > 0) {
                WorkspaceManager.targetFPS = newFps;
                WorkspaceManager.triggerAutoSave(); // <-- Save immediately
            }
        });

        // NEW: Toolbar Dock Selector
        const selectDock = document.getElementById('select-toolbar-dock') as HTMLSelectElement;
        selectDock?.addEventListener('change', (e) => {
            WorkspaceManager.toolbarDockMode = (e.target as HTMLSelectElement).value as 'free' | 'top';
            WorkspaceManager.updateToolbarDock();
            WorkspaceManager.triggerAutoSave();
        });

        // Auto Center Toolbar button
        const btnCenterToolbar = document.getElementById('btn-center-toolbar');
        btnCenterToolbar?.addEventListener('click', () => {
            WorkspaceManager.toolbarCustomPos = null;
            WorkspaceManager.autoCenterToolbar(true);
            WorkspaceManager.triggerAutoSave();
            const originalText = btnCenterToolbar.textContent;
            btnCenterToolbar.textContent = '✓ Centered!';
            setTimeout(() => { btnCenterToolbar.textContent = originalText; }, 1200);
        });

        // Toolbar Visibility (Auto Hide vs Always Visible)
        const selectVis = document.getElementById('select-toolbar-visibility') as HTMLSelectElement;
        const checkAutoToolbar = document.getElementById('check-autohide-toolbar') as HTMLInputElement;

        const setToolbarVisibilityMode = (mode: 'autohide' | 'always') => {
            WorkspaceManager.toolbarVisibility = mode;
            if (selectVis) selectVis.value = mode;
            if (checkAutoToolbar) checkAutoToolbar.checked = (mode === 'autohide');
            WorkspaceManager.updateToolbarVisibility();
            WorkspaceManager.triggerAutoSave();
        };

        selectVis?.addEventListener('change', (e) => {
            setToolbarVisibilityMode((e.target as HTMLSelectElement).value as 'autohide' | 'always');
        });

        checkAutoToolbar?.addEventListener('change', (e) => {
            setToolbarVisibilityMode((e.target as HTMLInputElement).checked ? 'autohide' : 'always');
        });

        const selectTopBar = document.getElementById('select-topbar-display') as HTMLSelectElement;
        selectTopBar?.addEventListener('change', (e) => {
            WorkspaceManager.topBarDisplayMode = (e.target as HTMLSelectElement).value as 'change' | 'none';
            WorkspaceManager.syncTopBar();
            WorkspaceManager.triggerAutoSave();
        });

        document.getElementById('check-paint-hud')?.addEventListener('change', (e) => {
            WorkspaceManager.showPaintFpsHud = (e.target as HTMLInputElement).checked;
            WorkspaceManager.updateHudVisibility();
            WorkspaceManager.triggerAutoSave();
        });

        document.getElementById('check-paint-log')?.addEventListener('change', (e) => {
            WorkspaceManager.logPaintFps = (e.target as HTMLInputElement).checked;
            WorkspaceManager.triggerAutoSave();
        });

        // Bind Candle Tab HTF & Auto-Peek Controls
        const selCandleHtf = document.getElementById('select-candle-htf-timeframe') as HTMLSelectElement | null;
        const rowCandleHtfCustom = document.getElementById('row-candle-htf-custom');
        const inpCandleCustomMins = document.getElementById('input-candle-htf-custom-mins') as HTMLInputElement | null;
        const selCandleAutoPeekCadence = document.getElementById('select-candle-auto-peek-cadence') as HTMLSelectElement | null;
        const rowCandleAutoPeekCustom = document.getElementById('row-candle-autopeek-custom');
        const inpCandleAutoPeekCustomVal = document.getElementById('input-candle-autopeek-custom-val') as HTMLInputElement | null;
        const lblCandleAutoPeekUnit = document.getElementById('label-candle-autopeek-unit');
        const selCandlePeekDur = document.getElementById('select-candle-peek-duration') as HTMLSelectElement | null;
        const chkCandleWicks = document.getElementById('check-candle-htf-wicks') as HTMLInputElement | null;
        const chkCandleShowHtfHud = document.getElementById('check-candle-show-htf-hud') as HTMLInputElement | null;
        const rangeCandleOpacity = document.getElementById('range-candle-htf-opacity') as HTMLInputElement | null;
        const lblCandleOpacity = document.getElementById('label-candle-htf-opacity');
        const btnCandlePeekNow = document.getElementById('btn-candle-peek-now');

        selCandleHtf?.addEventListener('change', () => {
            const chart = WorkspaceManager.getActiveChart();
            if (!chart) return;
            const val = selCandleHtf.value;
            if (rowCandleHtfCustom) rowCandleHtfCustom.style.display = val === 'Custom' ? 'flex' : 'none';
            const customMins = inpCandleCustomMins ? parseInt(inpCandleCustomMins.value, 10) || 60 : 60;
            chart.setCandleHtfTimeframe(val, customMins);
            WorkspaceManager.syncModalInputs();
            WorkspaceManager.triggerAutoSave();
        });

        inpCandleCustomMins?.addEventListener('input', () => {
            const chart = WorkspaceManager.getActiveChart();
            if (!chart) return;
            const mins = parseInt(inpCandleCustomMins.value, 10) || 60;
            chart.candleHtfCustomMins = mins;
            if (chart.candleHtfTimeframe === 'Custom') {
                chart.setCandleHtfTimeframe('Custom', mins);
            }
            WorkspaceManager.syncModalInputs();
            WorkspaceManager.triggerAutoSave();
        });

        selCandleAutoPeekCadence?.addEventListener('change', () => {
            const chart = WorkspaceManager.getActiveChart();
            if (!chart) return;
            const cadence = selCandleAutoPeekCadence.value;
            chart.autoPeekCadence = cadence;
            chart.autoPeekOnClose = cadence !== 'off';
            if (rowCandleAutoPeekCustom) {
                const isCust = cadence === 'custom_m' || cadence === 'custom_h';
                rowCandleAutoPeekCustom.style.display = isCust ? 'flex' : 'none';
                if (lblCandleAutoPeekUnit) lblCandleAutoPeekUnit.textContent = cadence === 'custom_h' ? 'hours' : 'mins';
            }
            chart.updateHtfOverlayControl();
            WorkspaceManager.triggerAutoSave();
        });

        inpCandleAutoPeekCustomVal?.addEventListener('input', () => {
            const chart = WorkspaceManager.getActiveChart();
            if (!chart) return;
            const val = parseInt(inpCandleAutoPeekCustomVal.value, 10) || 5;
            chart.autoPeekCustomValue = Math.max(1, Math.min(1440, val));
            chart.updateHtfOverlayControl();
            WorkspaceManager.triggerAutoSave();
        });

        selCandlePeekDur?.addEventListener('change', () => {
            const chart = WorkspaceManager.getActiveChart();
            if (!chart) return;
            const dur = parseInt(selCandlePeekDur.value, 10) || 30;
            chart.htfOverlayDurationSec = Math.max(5, Math.min(120, dur));
            chart.updateHtfOverlayControl();
            WorkspaceManager.triggerAutoSave();
        });

        chkCandleWicks?.addEventListener('change', () => {
            const chart = WorkspaceManager.getActiveChart();
            if (!chart) return;
            chart.showHtfWicks = chkCandleWicks.checked;
            chart.renderer.forceNextRender = true;
            chart.renderer.isHistoricalDirty = true;
            chart.isDirty = true;
            WorkspaceManager.triggerAutoSave();
        });

        chkCandleShowHtfHud?.addEventListener('change', () => {
            const chart = WorkspaceManager.getActiveChart();
            if (!chart) return;
            chart.showHtfOverlayHud = chkCandleShowHtfHud.checked;
            chart.updateHtfOverlayControl();
            WorkspaceManager.triggerAutoSave();
        });

        rangeCandleOpacity?.addEventListener('input', () => {
            const chart = WorkspaceManager.getActiveChart();
            if (!chart) return;
            const val = parseInt(rangeCandleOpacity.value, 10) || 85;
            if (lblCandleOpacity) lblCandleOpacity.textContent = `${val}%`;
            chart.htfCandleOpacity = val / 100;
            chart.renderer.forceNextRender = true;
            chart.renderer.isHistoricalDirty = true;
            chart.isDirty = true;
            WorkspaceManager.triggerAutoSave();
        });

        btnCandlePeekNow?.addEventListener('click', () => {
            const chart = WorkspaceManager.getActiveChart();
            if (!chart) return;
            const modal = document.getElementById('settings-modal') as HTMLDialogElement | null;
            if (modal) modal.close();
            chart.startHtfOverlay(chart.htfOverlayDurationSec);
        });

        // Workspace Reset
        const btnResetWorkspace = document.getElementById('btn-reset-workspace');
        btnResetWorkspace?.addEventListener('click', async () => {
            if (await WorkspaceManager.confirmAction('Reset Workspace', 'Are you sure you want to reset your workspace? All custom layouts and indicators will be lost forever.')) {
                localStorage.removeItem('ecochart_workspace_v1');
                window.location.reload();
            }
        });

        // Workspace Export
        const btnExportWorkspace = document.getElementById('btn-export-workspace');
        btnExportWorkspace?.addEventListener('click', () => {
            WorkspaceManager.saveWorkspace(); // Force save latest state
            const raw = localStorage.getItem('ecochart_workspace_v1');
            if (raw) {
                const blob = new Blob([raw], { type: 'application/json' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `ecochart_workspace_${new Date().toISOString().slice(0, 10)}.json`;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
            } else {
                alert("No workspace data found to export.");
            }
        });

        // Workspace Import
        const btnImportWorkspace = document.getElementById('btn-import-workspace');
        const inputImportWorkspace = document.getElementById('input-import-workspace') as HTMLInputElement;

        btnImportWorkspace?.addEventListener('click', () => {
            inputImportWorkspace?.click();
        });

        inputImportWorkspace?.addEventListener('change', (e) => {
            const file = (e.target as HTMLInputElement).files?.[0];
            if (!file) return;

            const reader = new FileReader();
            reader.onload = (event) => {
                try {
                    const content = event.target?.result as string;
                    const json = JSON.parse(content);
                    if (json && json.version && json.panes) {
                        localStorage.setItem('ecochart_workspace_v1', content);
                        window.location.reload(); // Reload to apply newly imported state
                    } else {
                        alert("Invalid workspace file format.");
                    }
                } catch (err) {
                    alert("Failed to parse JSON file.");
                }
                inputImportWorkspace.value = ''; // Reset input
            };
            reader.readAsText(file);
        });

        // ==========================================================
        // 🧠 COMPREHENSIVE AI EXPORTER MODAL INTEGRATION
        // ==========================================================
        const btnOpenAiExportModal = document.getElementById('btn-open-ai-export-modal');
        const btnTopbarAiExport = document.getElementById('btn-topbar-ai-export'); 
        const modalAiExport = document.getElementById('ai-export-modal') as HTMLDialogElement | null;
        const btnAiExportClose = document.getElementById('btn-ai-export-close');
        const btnAiExportCancel = document.getElementById('btn-ai-export-cancel');
        const btnAiExportStart = document.getElementById('btn-ai-export-start');
        
        const loadingOverlay = document.getElementById('ai-export-loading-overlay') as HTMLElement | null;
        const aiSubtitle = document.getElementById('ai-export-subtitle');

        const openModalAndSync = () => {
            if (aiSubtitle && WorkspaceManager.activeChart) {
                const c = WorkspaceManager.activeChart;
                aiSubtitle.textContent = `${c.currentSymbol} • ${c.currentInterval} • Ground truth signal outcomes & range detection`;
            }
            modalAiExport?.showModal();
        };

        btnOpenAiExportModal?.addEventListener('click', openModalAndSync);
        btnTopbarAiExport?.addEventListener('click', openModalAndSync);

        btnAiExportClose?.addEventListener('click', () => modalAiExport?.close());
        btnAiExportCancel?.addEventListener('click', () => modalAiExport?.close());

        // UI: Custom Date Inputs Setup
        const customDateBox = document.getElementById('ai-custom-date-container');
        const customStartDate = document.getElementById('ai-custom-start-date') as HTMLInputElement | null;
        const customEndDate = document.getElementById('ai-custom-end-date') as HTMLInputElement | null;

        // Initialize default dates (today & 30 days prior)
        const nowIso = new Date().toISOString().split('T')[0];
        const monthAgoIso = new Date(Date.now() - 30 * 86_400_000).toISOString().split('T')[0];
        if (customEndDate && !customEndDate.value) customEndDate.value = nowIso;
        if (customStartDate && !customStartDate.value) customStartDate.value = monthAgoIso;

        // UI: Handle Range Tabs with Custom Date Toggle
        document.querySelectorAll('.ai-range-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                document.querySelectorAll('.ai-range-btn').forEach(b => {
                    (b as HTMLElement).style.background = 'transparent';
                    (b as HTMLElement).style.color = '#787B86';
                    b.classList.remove('active');
                });
                const target = e.currentTarget as HTMLElement;
                target.classList.add('active');
                target.style.background = 'var(--chart-bg, #131722)';
                target.style.color = '#EF5350';

                // Toggle Custom Date inputs
                const isCustom = target.dataset.val === 'custom';
                if (customDateBox) customDateBox.style.display = isCustom ? 'grid' : 'none';
            });
        });

        // UI: Handle Packaging Format Cards
        document.querySelectorAll('.ai-pack-card').forEach(card => {
            card.addEventListener('click', (e) => {
                document.querySelectorAll('.ai-pack-card').forEach(c => {
                    (c as HTMLElement).style.borderColor = 'transparent';
                    c.classList.remove('active');
                });
                const target = e.currentTarget as HTMLElement;
                target.classList.add('active');
                target.style.borderColor = '#EF5350';
            });
        });

        // Top-Bar Button State Management for Background Mining
        let isMiningActive = false;
        const resetTopbarButton = () => {
            isMiningActive = false;
            if (btnTopbarAiExport) {
                btnTopbarAiExport.innerHTML = `<span>🧠</span><span class="desktop-only">AI Export</span>`;
                btnTopbarAiExport.title = "Export AI Training Data (.csv)";
                btnTopbarAiExport.style.borderColor = "var(--chart-accent, #2962FF)";
                btnTopbarAiExport.style.color = "var(--chart-accent, #2962FF)";
            }
        };

        const setTopbarMiningState = (pct: number) => {
            isMiningActive = true;
            if (btnTopbarAiExport) {
                btnTopbarAiExport.innerHTML = `
                  <span style="display:inline-block;width:12px;height:12px;border:2px solid rgba(239,83,80,0.3);border-top-color:#EF5350;border-radius:50%;animation:spin 0.8s linear infinite;"></span>
                  <span style="font-size:11px;font-family:monospace;font-weight:800;color:#EF5350;margin-left:2px;">${pct}%</span>
                `;
                btnTopbarAiExport.title = `Mining Binance data in background (${pct}%)... Click to view details / cancel`;
                btnTopbarAiExport.style.borderColor = "#EF5350";
                btnTopbarAiExport.style.color = "#EF5350";
            }
        };

        // If user clicks the top-bar button while mining, show the detailed status overlay
        btnTopbarAiExport?.addEventListener('click', () => {
            if (isMiningActive && modalAiExport && loadingOverlay) {
                loadingOverlay.style.display = 'flex';
            }
        });

        const btnAiExportAbort = document.getElementById('btn-ai-export-abort');
        const progressFill = document.getElementById('ai-export-progress-fill');
        const progressPct = document.getElementById('ai-export-progress-pct');
        const progressCount = document.getElementById('ai-export-progress-count');
        const progressEta = document.getElementById('ai-export-progress-eta');
        const loadingTitle = document.getElementById('ai-export-loading-title');
        const loadingDetail = document.getElementById('ai-export-loading-detail');

        btnAiExportAbort?.addEventListener('click', () => {
            BackgroundDataMiner.abort();
            resetTopbarButton();
            if (loadingOverlay) loadingOverlay.style.display = 'none';
        });

        btnAiExportStart?.addEventListener('click', async () => {
            const chart = WorkspaceManager.activeChart || WorkspaceManager.charts[0];
            if (!chart) return;

            const activeRange = document.querySelector('.ai-range-btn.active') as HTMLElement;
            const rangeKey = activeRange?.dataset.val || '1m';

            let durationMs = BackgroundDataMiner.rangeToMs(rangeKey);
            let customStartMs: number | undefined;
            let customEndMs: number | undefined;

            if (rangeKey === 'custom') {
                if (!customStartDate?.value || !customEndDate?.value) {
                    alert('Please select both a Start Date and an End Date.');
                    return;
                }
                customStartMs = new Date(`${customStartDate.value}T00:00:00Z`).getTime();
                customEndMs = new Date(`${customEndDate.value}T23:59:59Z`).getTime();

                if (isNaN(customStartMs) || isNaN(customEndMs) || customStartMs >= customEndMs) {
                    alert('Invalid custom date range. The start date must precede the end date.');
                    return;
                }
                durationMs = customEndMs - customStartMs;
            }

            const activePack = document.querySelector('.ai-pack-card.active') as HTMLElement;
            const _packFormat = (activePack?.dataset.pack || 'csv').toUpperCase();
            void _packFormat;
            const targetRR = (document.getElementById('ai-export-rr') as HTMLSelectElement)?.value || "2.0";
            const forwardHorizon = (document.getElementById('ai-export-horizon') as HTMLInputElement)?.value || "30";
            void targetRR;
            void forwardHorizon;

            // 1. NON-BLOCKING: Close modal immediately so the chart is 100% usable!
            modalAiExport?.close();
            setTopbarMiningState(0);

            // Also keep overlay ready in case they open it
            if (loadingOverlay) loadingOverlay.style.display = 'flex';
            if (loadingTitle) loadingTitle.textContent = `Mining Binance History (${rangeKey.toUpperCase()})...`;
            if (progressFill) progressFill.style.width = '0%';
            if (progressPct) progressPct.textContent = '0%';
            if (progressCount) progressCount.textContent = 'Batch 0 / 0';
            if (progressEta) progressEta.textContent = 'ETA: --s';

            try {
                // Step 1: Execute 500ms Paged Background Download from Binance
                const rawCandleBuffer = await BackgroundDataMiner.mineHistoricalCandles(
                    chart.currentSymbol,
                    chart.currentInterval,
                    durationMs,
                    (p) => {
                        setTopbarMiningState(p.percent);
                        if (progressFill) progressFill.style.width = `${p.percent}%`;
                        if (progressPct) progressPct.textContent = `${p.percent}%`;
                        if (progressCount) progressCount.textContent = `Batch ${p.currentBatch} / ${p.totalBatches}`;
                        if (progressEta) progressEta.textContent = `ETA: ${p.etaSeconds}s`;
                        if (loadingDetail) loadingDetail.textContent = `${p.candlesFetched.toLocaleString()} candles fetched (${p.statusText})`;
                    },
                    customStartMs,
                    customEndMs
                );

                if (rawCandleBuffer.length === 0) {
                    alert("No candle history found on Binance for this range.");
                    if (loadingOverlay) loadingOverlay.style.display = 'none';
                    return;
                }

                // =========================================================================
                // --- START CHUNK B: HEADLESS MATH & DATASET GENERATION ---
                // =========================================================================
                const candleCount = Math.floor(rawCandleBuffer.length / 6);

                // 1. Wrap mined buffer in a lightweight Headless DataStore
                const headlessDs = {
                    data: rawCandleBuffer,
                    length: candleCount,
                    clear: () => {}
                } as unknown as DataStore;

                // 2. Instantiate Headless Strict CBC ZigZag Indicator with user's chart settings
                const headlessZigZag = new StrictCBCZigZagIndicator();
                headlessZigZag.currentSymbol = chart.currentSymbol;
                const chartZigZag = chart.indicatorManager.activeIndicators.find(i => i instanceof StrictCBCZigZagIndicator) as StrictCBCZigZagIndicator | undefined;
                if (chartZigZag) {
                    headlessZigZag.params.forEach(p => {
                        const val = chartZigZag.getParam(p.id);
                        if (val !== undefined) p.value = val;
                    });
                }

                // Step A: Calculate Strict CBC ZigZag Structure & Cached Pivots
                if (loadingTitle) loadingTitle.textContent = "Processing Structural Events...";
                if (loadingDetail) loadingDetail.textContent = `Computing Strict CBC ZigZag pivots on ${candleCount.toLocaleString()} candles...`;
                if (progressFill) progressFill.style.width = "85%";
                if (progressPct) progressPct.textContent = "85%";
                await new Promise(r => setTimeout(r, 25)); // Allow UI repaint

                headlessZigZag.calculate(headlessDs);

                // Step B: Build ML-R1 Dataset (Features, Context, and Frozen Outcome Engine)
                if (loadingTitle) loadingTitle.textContent = "Building ML-R1 Dataset...";
                if (loadingDetail) loadingDetail.textContent = `Generating causal features and counterfactual outcomes for ${headlessZigZag.cachedPivots.length} pivots...`;
                if (progressFill) progressFill.style.width = "95%";
                if (progressPct) progressPct.textContent = "95%";
                await new Promise(r => setTimeout(r, 25));

                const events = AIExporter.buildMLR1Dataset(
                    headlessDs,
                    headlessZigZag.cachedPivots,
                    chart.currentSymbol,
                    chart.currentInterval
                );

                if (events.length === 0) {
                    alert("No valid confirmed structural events were detected in this historical window.");
                    if (loadingOverlay) loadingOverlay.style.display = 'none';
                    resetTopbarButton();
                    return;
                }

                // Step C: Run Pre-Flight Master Audit with Candle-Level Execution Replay
                const auditPassed = DatasetAuditor.runCausalityAudit(events, headlessDs);
                if (!auditPassed) {
                    if (loadingOverlay) loadingOverlay.style.display = 'none';
                    resetTopbarButton();
                    return;
                }

                // Step D: Export ML-R1 Events CSV
                if (loadingTitle) loadingTitle.textContent = "Exporting ML-R1 CSV...";
                if (loadingDetail) loadingDetail.textContent = `Generated ${events.length.toLocaleString()} ML-R1 structural event records.`;
                if (progressFill) progressFill.style.width = "100%";
                if (progressPct) progressPct.textContent = "100%";
                await new Promise(r => setTimeout(r, 25));

                const exported = AIExporter.exportMLR1CSV(events, chart.currentSymbol, chart.currentInterval);

                if (exported) {
                    resetTopbarButton();
                    setTimeout(() => {
                        if (loadingOverlay) loadingOverlay.style.display = 'none';
                        modalAiExport?.close();
                    }, 1400);
                }
                // =========================================================================
                // --- END CHUNK B ---
                // =========================================================================

            } catch (err: any) {
                console.error("Mining error:", err);
                resetTopbarButton();
                if (err.message !== 'Mining cancelled by user.') {
                    alert(`Mining stopped: ${err.message}`);
                }
                if (loadingOverlay) loadingOverlay.style.display = 'none';
            }
        });
        // --- END PHASE 5: CHUNK A ---

        // Workspace Quick Access Icon (Top Toolbar)
        const btnWorkspaceModal = document.getElementById('btn-workspace-modal');
        btnWorkspaceModal?.addEventListener('click', () => {
            syncModalInputs();

            // Programmatically switch to the Workspace tab
            document.querySelectorAll('.modal-tab-btn').forEach(t => {
                t.classList.remove('active-tab');
                (t as HTMLElement).style.background = 'transparent';
                (t as HTMLElement).style.color = 'var(--chart-text, #787B86)';
            });
            const wsTab = document.querySelector('.modal-tab-btn[data-tab="workspace"]') as HTMLElement;
            if (wsTab) {
                wsTab.classList.add('active-tab');
                wsTab.style.background = 'var(--chart-grid, #2A2E39)';
                wsTab.style.color = 'var(--chart-accent, #2962FF)';
            }

            document.querySelectorAll('.modal-tab-content').forEach(c => {
                (c as HTMLElement).style.display = 'none';
            });
            const wsContent = document.getElementById('tab-content-workspace');
            if (wsContent) wsContent.style.display = 'block';

            modalSettings?.showModal();
        });

        const closeSettings = () => {
            const checkNav = document.getElementById('check-show-nav') as HTMLInputElement;
            const checkAutoHide = document.getElementById('check-autohide-nav') as HTMLInputElement;

            if (checkAutoHide) {
                WorkspaceManager.isAutoHideNav = checkAutoHide.checked;
                this.charts.forEach((c) => {
                    if (!WorkspaceManager.isAutoHideNav) {
                        c.showNavBar();
                    } else {
                        c.hideNavBar();
                    }
                });
            }

            if (checkNav) {
                document.querySelectorAll('.pane-nav-bar').forEach((bar) => {
                    (bar as HTMLElement).style.display = checkNav.checked ? 'flex' : 'none';
                });
            }

            const checkSync = document.getElementById('check-sync-crosshair') as HTMLInputElement;
            if (checkSync) {
                WorkspaceManager.isCrosshairSyncEnabled = checkSync.checked;
                if (!WorkspaceManager.isCrosshairSyncEnabled) {
                    WorkspaceManager.broadcastCrosshair(null, null as any);
                }
            }

            const selVis = document.getElementById('select-toolbar-visibility') as HTMLSelectElement;
            if (selVis) {
                WorkspaceManager.toolbarVisibility = selVis.value as 'autohide' | 'always';
                WorkspaceManager.updateToolbarVisibility();
            }

            colorPicker.close();
            modalSettings?.close();
            WorkspaceManager.saveWorkspace(); // <-- Immediately save all modal changes
        };
        btnCloseSettings?.addEventListener('click', closeSettings);
        btnModalCloseX?.addEventListener('click', closeSettings);

        window.addEventListener('beforeunload', () => {
            WorkspaceManager.saveWorkspace();
        });

        window.addEventListener('resize', () => {
            WorkspaceManager.autoCenterToolbar(false);
        });

        // ==========================================================
        // 🔍 MODERNIZED SYMBOL SEARCH CONTROLLER (Virtual Slice & Tabs)
        // ==========================================================
        const btnSymbol = document.getElementById('btn-symbol');
        const modalSymbol = document.getElementById('symbol-modal') as HTMLDialogElement;
        const inputSearch = document.getElementById('symbol-search-input') as HTMLInputElement;
        const btnClearSearch = document.getElementById('btn-search-clear') as HTMLButtonElement;
        const listContainer = document.getElementById('symbol-list');
        const btnCloseSymbol = document.getElementById('btn-symbol-modal-close');
        const matchCountLabel = document.getElementById('symbol-match-count');
        const tabButtons = document.querySelectorAll('.symbol-tab-btn');

        let allSymbols: Array<{ symbol: string; baseAsset: string; quoteAsset: string }> = [];
        let tickerMap: Record<string, { lastPrice: number; changePct: number; quoteVolume: number }> = {};
        let filteredSymbols: Array<{ symbol: string; baseAsset: string; quoteAsset: string }> = [];
        let activeTab: 'all' | 'favorites' | 'volume' = 'all';
        let selectedIndex = 0;
        let renderedBatchCount = 50;

        // 1. Sort State Variables
        let sortField: 'symbol' | 'change' | 'volume' = 'volume';
        let sortDirection: 'asc' | 'desc' = 'desc';

        // Column Header Elements
        const colSortSymbol = document.getElementById('col-sort-symbol');
        const colSortChange = document.getElementById('col-sort-change');
        const colSortVolume = document.getElementById('col-sort-volume');
        const arrowSortSymbol = document.getElementById('arrow-sort-symbol');
        const arrowSortChange = document.getElementById('arrow-sort-change');
        const arrowSortVolume = document.getElementById('arrow-sort-volume');

        // Number Formatter: $1.24B, $45.2M, $850K
        const formatVolume = (vol: number): string => {
            if (vol >= 1_000_000_000) return `$${(vol / 1_000_000_000).toFixed(2)}B`;
            if (vol >= 1_000_000) return `$${(vol / 1_000_000).toFixed(2)}M`;
            if (vol >= 1_000) return `$${(vol / 1_000).toFixed(1)}K`;
            return `$${vol.toFixed(0)}`;
        };

        // 2. Header State UI Updater
        const updateHeaderIndicators = () => {
            colSortSymbol?.classList.remove('active');
            colSortChange?.classList.remove('active');
            colSortVolume?.classList.remove('active');
            if (arrowSortSymbol) arrowSortSymbol.textContent = '↕';
            if (arrowSortChange) arrowSortChange.textContent = '↕';
            if (arrowSortVolume) arrowSortVolume.textContent = '↕';

            const arrowChar = sortDirection === 'asc' ? '▲' : '▼';
            if (sortField === 'symbol') {
                colSortSymbol?.classList.add('active');
                if (arrowSortSymbol) arrowSortSymbol.textContent = arrowChar;
            } else if (sortField === 'change') {
                colSortChange?.classList.add('active');
                if (arrowSortChange) arrowSortChange.textContent = arrowChar;
            } else if (sortField === 'volume') {
                colSortVolume?.classList.add('active');
                if (arrowSortVolume) arrowSortVolume.textContent = arrowChar;
            }
        };

        // 3. Unified Sorting Engine
        const filterAndSortList = () => {
            const query = (inputSearch?.value || '').trim().toUpperCase();

            // A. Filter by Search Query
            let list = allSymbols;
            if (query) {
                list = list.filter(s => s.symbol.includes(query) || s.baseAsset.toUpperCase().includes(query));
            }

            // B. Filter by Favorites Tab
            if (activeTab === 'favorites') {
                list = list.filter(s => favoritesManager.isFavorite(s.symbol));
            }

            // C. Apply Unified Sort Direction
            list = [...list].sort((a, b) => {
                let comparison = 0;
                if (sortField === 'symbol') {
                    comparison = a.symbol.localeCompare(b.symbol);
                } else if (sortField === 'change') {
                    const valA = tickerMap[a.symbol]?.changePct ?? -Infinity;
                    const valB = tickerMap[b.symbol]?.changePct ?? -Infinity;
                    comparison = valA - valB;
                } else if (sortField === 'volume') {
                    const valA = tickerMap[a.symbol]?.quoteVolume ?? 0;
                    const valB = tickerMap[b.symbol]?.quoteVolume ?? 0;
                    comparison = valA - valB;
                }
                return sortDirection === 'asc' ? comparison : -comparison;
            });

            filteredSymbols = list;
            selectedIndex = 0;
            renderedBatchCount = 50;
            renderSymbolList();
        };

        // 4. Bind Header Column Clicks
        const handleSortClick = (field: 'symbol' | 'change' | 'volume') => {
            if (sortField === field) {
                // Same column: Toggle direction
                sortDirection = sortDirection === 'asc' ? 'desc' : 'asc';
            } else {
                // New column: Default to A-Z for Symbol, High-to-Low for Metrics
                sortField = field;
                sortDirection = field === 'symbol' ? 'asc' : 'desc';
            }
            updateHeaderIndicators();
            filterAndSortList();
        };

        colSortSymbol?.addEventListener('click', () => handleSortClick('symbol'));
        colSortChange?.addEventListener('click', () => handleSortClick('change'));
        colSortVolume?.addEventListener('click', () => handleSortClick('volume'));

        const renderSymbolList = () => {
            if (!listContainer) return;
            listContainer.innerHTML = '';

            if (filteredSymbols.length === 0) {
                const emptyMsg = activeTab === 'favorites' && !inputSearch.value.trim()
                    ? 'No starred symbols yet.<br><span style="font-size: 11px; opacity: 0.7;">Click ☆ to pin favorite pairs here.</span>'
                    : 'No matching USDT pairs found';
                listContainer.innerHTML = `<div style="padding: 32px 16px; text-align: center; color: #787B86; font-size: 13px; line-height: 1.6;">${emptyMsg}</div>`;
                if (matchCountLabel) matchCountLabel.textContent = 'Showing 0 results';
                return;
            }

            const activeSymbol = WorkspaceManager.activeChart?.currentSymbol || '';
            const countToRender = Math.min(filteredSymbols.length, renderedBatchCount);

            for (let i = 0; i < countToRender; i++) {
                const item = filteredSymbols[i];
                const isFav = favoritesManager.isFavorite(item.symbol);
                const isCurrent = item.symbol === activeSymbol;
                const ticker = tickerMap[item.symbol];

                const row = document.createElement('div');
                row.className = `symbol-item ${i === selectedIndex ? 'selected' : ''}`;
                row.dataset.index = String(i);
                row.style.cssText = 'display: grid; grid-template-columns: 1fr 100px 90px; align-items: center; gap: 8px; padding: 7px 16px; cursor: pointer; user-select: none; border-left: 3px solid transparent;';
                if (isCurrent) {
                    row.style.background = 'rgba(41, 98, 255, 0.08)';
                    row.style.borderLeftColor = 'var(--chart-accent, #2962FF)';
                }

                // Left cell: Star + Coin Badge + Ticker + Asset Name
                const leftDiv = document.createElement('div');
                leftDiv.style.cssText = 'display: flex; align-items: center; gap: 8px; min-width: 0;';

                const starBtn = document.createElement('button');
                starBtn.className = `symbol-star-btn ${isFav ? 'starred' : ''}`;
                starBtn.textContent = isFav ? '★' : '☆';
                starBtn.title = isFav ? 'Unstar' : 'Star';
                starBtn.onclick = (e) => {
                    e.stopPropagation();
                    const nowFav = favoritesManager.toggleFavorite(item.symbol);
                    starBtn.textContent = nowFav ? '★' : '☆';
                    starBtn.classList.toggle('starred', nowFav);
                    WorkspaceManager.syncTopBar();
                    WorkspaceManager.triggerAutoSave();
                    if (activeTab === 'favorites') {
                        filterAndSortList();
                    }
                };
                leftDiv.appendChild(starBtn);

                const avatar = document.createElement('div');
                avatar.className = 'coin-badge';
                avatar.textContent = item.baseAsset.slice(0, 3);
                leftDiv.appendChild(avatar);

                const nameDiv = document.createElement('div');
                nameDiv.style.cssText = 'display: flex; flex-direction: column; min-width: 0;';
                nameDiv.innerHTML = `
                    <div style="display: flex; align-items: center; gap: 6px;">
                        <span style="font-weight: 700; color: var(--chart-text, #D1D4DC); font-size: 13px;">${item.symbol}</span>
                        <span class="badge-spot">SPOT</span>
                    </div>
                    <span style="font-size: 11px; color: #787B86; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${item.baseAsset}</span>
                `;
                leftDiv.appendChild(nameDiv);
                row.appendChild(leftDiv);

                // Middle cell: 24h Change %
                const changeDiv = document.createElement('div');
                changeDiv.style.cssText = 'text-align: right; font-variant-numeric: tabular-nums; font-size: 12px; font-weight: 600;';
                if (ticker) {
                    const sign = ticker.changePct >= 0 ? '+' : '';
                    const color = ticker.changePct >= 0 ? 'var(--chart-bull, #26A69A)' : 'var(--chart-bear, #EF5350)';
                    changeDiv.style.color = color;
                    changeDiv.textContent = `${sign}${ticker.changePct.toFixed(2)}%`;
                } else {
                    changeDiv.style.color = '#787B86';
                    changeDiv.textContent = '—';
                }
                row.appendChild(changeDiv);

                // Right cell: 24h Volume in USDT
                const volDiv = document.createElement('div');
                volDiv.style.cssText = 'text-align: right; font-variant-numeric: tabular-nums; font-size: 11px; color: var(--chart-text, #D1D4DC); opacity: 0.85;';
                volDiv.textContent = ticker ? formatVolume(ticker.quoteVolume) : '—';
                row.appendChild(volDiv);

                // Row selection event
                row.addEventListener('click', () => {
                    WorkspaceManager.activeChart?.switchSymbol(item.symbol);
                    WorkspaceManager.syncTopBar();
                    modalSymbol?.close();
                });

                listContainer.appendChild(row);
            }

            if (matchCountLabel) {
                matchCountLabel.textContent = `Showing ${countToRender} of ${filteredSymbols.length} pairs`;
            }
        };

        // Virtualized Infinite Scroll: Render next 30 items when reaching bottom
        listContainer?.addEventListener('scroll', () => {
            if (!listContainer) return;
            const scrollBottom = listContainer.scrollHeight - listContainer.scrollTop - listContainer.clientHeight;
            if (scrollBottom < 80 && renderedBatchCount < filteredSymbols.length) {
                renderedBatchCount += 30;
                renderSymbolList();
            }
        });

        // Tab Switching
        tabButtons.forEach(btn => {
            btn.addEventListener('click', () => {
                tabButtons.forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                activeTab = (btn as HTMLElement).dataset.tab as any;

                // If entering Top Volume tab, enforce volume descending sort naturally
                if (activeTab === 'volume') {
                    sortField = 'volume';
                    sortDirection = 'desc';
                    updateHeaderIndicators();
                }

                filterAndSortList();
            });
        });

        // Open Dialog
        btnSymbol?.addEventListener('click', async () => {
            modalSymbol?.showModal();
            if (inputSearch) {
                inputSearch.value = '';
                inputSearch.focus();
            }
            if (btnClearSearch) btnClearSearch.style.display = 'none';

            // Parallel background fetch: Tradable symbols + 24h Mini-Tickers
            if (WorkspaceManager.activeChart) {
                const [symbols, tickers] = await Promise.all([
                    allSymbols.length === 0 ? WorkspaceManager.activeChart.network.fetchTradableSymbols() : Promise.resolve(allSymbols),
                    WorkspaceManager.activeChart.network.fetch24hTickers()
                ]);
                allSymbols = symbols;
                tickerMap = tickers;
            }

            updateHeaderIndicators();
            filterAndSortList();
        });

        // Search Input Filtering & Clear Button Toggle
        inputSearch?.addEventListener('input', (e) => {
            const val = (e.target as HTMLInputElement).value;
            if (btnClearSearch) {
                btnClearSearch.style.display = val.length > 0 ? 'inline-block' : 'none';
            }
            filterAndSortList();
        });

        btnClearSearch?.addEventListener('click', () => {
            if (inputSearch) {
                inputSearch.value = '';
                inputSearch.focus();
            }
            btnClearSearch.style.display = 'none';
            filterAndSortList();
        });

        // Keyboard Navigation (ArrowUp, ArrowDown, Enter, Esc)
        modalSymbol?.addEventListener('keydown', (e) => {
            if (filteredSymbols.length === 0) return;

            if (e.key === 'ArrowDown') {
                e.preventDefault();
                selectedIndex = Math.min(filteredSymbols.length - 1, selectedIndex + 1);
                updateActiveSelection();
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                selectedIndex = Math.max(0, selectedIndex - 1);
                updateActiveSelection();
            } else if (e.key === 'Enter') {
                e.preventDefault();
                const chosen = filteredSymbols[selectedIndex];
                if (chosen) {
                    WorkspaceManager.activeChart?.switchSymbol(chosen.symbol);
                    WorkspaceManager.syncTopBar();
                    modalSymbol?.close();
                }
            }
        });

        const updateActiveSelection = () => {
            const rows = listContainer?.querySelectorAll('.symbol-item');
            if (!rows) return;
            rows.forEach((r, idx) => {
                if (idx === selectedIndex) {
                    r.classList.add('selected');
                    r.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
                } else {
                    r.classList.remove('selected');
                }
            });
        };

        btnCloseSymbol?.addEventListener('click', () => modalSymbol?.close());

        // ==========================================================
        // 📊 UNIVERSAL INDICATOR & DYNAMIC SETTINGS ENGINE
        // ==========================================================
        const btnIndicators = document.getElementById('btn-indicators');
        const modalIndicators = document.getElementById('indicators-modal') as HTMLDialogElement;
        const btnCloseIndicators = document.getElementById('btn-close-indicators');
        const btnIndBack = document.getElementById('btn-ind-back');
        const indModalTitle = document.getElementById('ind-modal-title');
        const indicatorsList = document.getElementById('indicators-list');
        const indSettingsView = document.getElementById('indicators-settings-view');
        const indSettingsFields = document.getElementById('indicators-settings-fields');
        const btnIndSettingsApply = document.getElementById('btn-ind-settings-apply');

        const availableIndicators = [
            { type: 'SMA', name: 'SMA', factory: () => new SMAIndicator(20) },
            { type: 'EMA', name: 'EMA', factory: () => new EMAIndicator(20) },
            { type: 'EMA_SMA_CROSS', name: 'EMA 10 & SMA 30 Cross (Alerts & Shapes)', factory: () => new EmaSmaCrossIndicator(10, 30) },
            { type: 'VOL', name: 'Volume', factory: () => new VolumeIndicator() },
            { type: 'EXHAUST', name: 'Exhaustion (CCI)', factory: () => new ExhaustionIndicator() },
            { type: 'HTF_BOX', name: 'HTF Box', factory: () => new HTFBoxIndicator(60) },
            { type: 'HTF_BIAS', name: 'HTF Bias', factory: () => new HTFBiasIndicator(60) },
            { type: 'HTF_PROJ', name: 'HTF Projections', factory: () => new HTFProjectionsIndicator('Custom', 21) },
            { type: 'ZZ123', name: 'ZigZag 1-2-3 Breakout', factory: () => new ZigZag123Indicator(4) },
            { type: 'CBC_FLIP', name: 'CBC Flip (Exact Wick Alignment)', factory: () => new CBCFlipIndicator() },
            { type: 'PULLBACK_ZONES', name: 'Market Structure Pullback Zones', factory: () => new MarketStructurePullbackZonesIndicator() },
            { type: 'MS_PULLBACK_DTDB', name: 'Market Structure Double Top & Bottom', factory: () => new PullbackDoubleTopBottomIndicator() },
            { type: 'STRICT_CBC_PULLBACK', name: 'Strict CBC Pullback Zones', factory: () => new StrictCBCPullbackZonesIndicator() },
            { type: 'STRICT_CBC_ZIGZAG', name: 'Strict CBC ZigZag', factory: () => new StrictCBCZigZagIndicator() }
        ];

        const showListView = () => {
            if (btnIndBack) btnIndBack.style.display = 'none';
            if (indModalTitle) indModalTitle.textContent = 'Indicators';
            if (indicatorsList) indicatorsList.style.display = 'block';
            if (indSettingsView) indSettingsView.style.display = 'none';
            renderCatalogList();
        };

        const showSettingsView = (indicator: any) => {
            if (!this.activeChart || !indSettingsFields) return;
            if (btnIndBack) btnIndBack.style.display = 'inline-block';
            if (indModalTitle) indModalTitle.textContent = `${indicator.name} Settings`;
            if (indicatorsList) indicatorsList.style.display = 'none';
            if (indSettingsView) indSettingsView.style.display = 'flex';

            indSettingsFields.innerHTML = '';

            // Dynamically generate form controls for each param
            indicator.params.forEach((param: any) => {
                const row = document.createElement('div');
                row.style.cssText = 'display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 12px;';

                const label = document.createElement('label');
                label.textContent = param.name;
                label.style.color = 'var(--chart-text, #D1D4DC)';
                row.appendChild(label);

                // Field Type 1: Number
                if (param.type === 'number') {
                    const input = document.createElement('input');
                    input.type = 'number';
                    input.value = String(param.value);
                    if (param.min !== undefined) input.min = String(param.min);
                    if (param.max !== undefined) input.max = String(param.max);
                    if (param.step !== undefined) input.step = String(param.step);
                    input.style.cssText = 'background: var(--chart-panel-bg, #1e222d); color: var(--chart-text, #D1D4DC); border: 1px solid var(--chart-grid, #434651); border-radius: 4px; padding: 4px 8px; width: 75px; font-size: 12px; outline: none; text-align: right;';

                    input.oninput = () => {
                        const num = parseFloat(input.value);
                        if (!isNaN(num)) {
                            indicator.updateParams({ [param.id]: num });
                            if (param.id === 'htfOverlayDurationSec' && this.activeChart) {
                                this.activeChart.htfOverlayDurationSec = Math.max(20, Math.min(120, num));
                                this.activeChart.updateHtfOverlayControl();
                            }
                            this.activeChart!.renderer.forceNextRender = true; // Bypass Eco-Mode throttle
                            this.activeChart!.indicatorManager.update(this.activeChart!.dataStore);
                            this.activeChart!.updateLegend();
                            this.activeChart!.updateHtfOverlayControl();
                            this.activeChart!.isDirty = true;
                            if (indModalTitle) indModalTitle.textContent = `${indicator.name} Settings`;
                            WorkspaceManager.triggerAutoSave();
                        }
                    };
                    row.appendChild(input);

                    // Field Type 2: Color (Integrated with ColorPicker)
                } else if (param.type === 'color') {
                    const swatch = document.createElement('button');
                    swatch.type = 'button';
                    swatch.style.cssText = `width: 26px; height: 26px; border-radius: 4px; border: 1px solid var(--chart-grid, #434651); background: ${param.value}; cursor: pointer; padding: 0;`;

                    swatch.onclick = (e) => {
                        e.stopPropagation();
                        // Extract current alpha if it exists in the saved hex
                        let initColor = String(param.value);
                        let initOpacity = 1;
                        if (initColor.length >= 9) {
                            initOpacity = parseInt(initColor.slice(7, 9), 16) / 255;
                            initColor = initColor.slice(0, 7);
                        }

                        colorPicker.open({
                            anchorElement: swatch,
                            initialColor: initColor,
                            initialOpacity: initOpacity,
                            showOpacity: true, // <-- FIX: Enable the opacity slider
                            onChange: (res) => {
                                // Convert opacity (0-1) to Hex (00-FF) and append it to the color string
                                const aHex = Math.round(res.opacity * 255).toString(16).padStart(2, '0');
                                const fullHex = `${res.color.slice(0, 7)}${aHex}`.toUpperCase();

                                swatch.style.backgroundColor = fullHex;
                                indicator.updateParams({ [param.id]: fullHex });

                                this.activeChart!.indicatorManager.update(this.activeChart!.dataStore);
                                this.activeChart!.renderer.forceNextRender = true;
                                this.activeChart!.updateLegend();
                                this.activeChart!.isDirty = true;
                                WorkspaceManager.triggerAutoSave();
                            }
                        });
                    };
                    row.appendChild(swatch);

                    // Field Type 3: Boolean Checkbox
                } else if (param.type === 'boolean') {
                    const check = document.createElement('input');
                    check.type = 'checkbox';
                    check.checked = Boolean(param.value);
                    check.style.cssText = 'cursor: pointer; width: 16px; height: 16px; accent-color: var(--chart-accent, #2962FF);';

                    check.onchange = () => {
                        indicator.updateParams({ [param.id]: check.checked });
                        if (param.id === 'checkHtfBox') {
                            if (check.checked) {
                                const dur = typeof (indicator as any).getParam === 'function' ? (indicator as any).getParam('htfOverlayDurationSec', 30) : 30;
                                this.activeChart?.startHtfOverlay(dur);
                            } else {
                                this.activeChart?.stopHtfOverlay(false);
                            }
                        }
                        if (param.id === 'autoPeekOnClose' && this.activeChart) {
                            this.activeChart.autoPeekOnClose = check.checked;
                        }
                        if (param.id === 'showHtfWicks' && this.activeChart) {
                            this.activeChart.showHtfWicks = check.checked;
                        }
                        this.activeChart!.renderer.forceNextRender = true; // Bypass Eco-Mode throttle
                        this.activeChart!.renderer.isHistoricalDirty = true;
                        this.activeChart!.indicatorManager.update(this.activeChart!.dataStore);
                        this.activeChart!.updateLegend();
                        this.activeChart!.updateHtfOverlayControl();
                        this.activeChart!.isDirty = true;
                        WorkspaceManager.triggerAutoSave();
                    };
                    row.appendChild(check);

                    // Field Type 4: Select Dropdown
                } else if (param.type === 'select') {
                    const select = document.createElement('select');
                    select.style.cssText = 'background: var(--chart-panel-bg, #1e222d); color: var(--chart-text, #D1D4DC); border: 1px solid var(--chart-grid, #434651); border-radius: 4px; padding: 4px 8px; font-size: 12px; outline: none; cursor: pointer;';

                    let options: string[] = param.options || [];
                    if (param.id === 'timeframe' && typeof (indicator as any).getTimeframeOptions === 'function') {
                        const currentInterval = this.activeChart?.currentInterval || '1m';
                        options = (indicator as any).getTimeframeOptions(currentInterval);
                    }

                    // Fallback to 'Current' if previous value is no longer valid for the current chart timeframe
                    if (param.id === 'timeframe' && !options.includes(String(param.value))) {
                        param.value = 'Current';
                        indicator.updateParams({ [param.id]: 'Current' });
                    }

                    options.forEach((opt: string) => {
                        const optEl = document.createElement('option');
                        optEl.value = opt;
                        optEl.textContent = opt === 'Current' ? 'Current (Chart Timeframe)' : opt;
                        optEl.selected = String(param.value) === opt;
                        select.appendChild(optEl);
                    });

                    select.onchange = () => {
                        indicator.updateParams({ [param.id]: select.value });
                        if (param.id === 'timeframe' && this.activeChart) {
                            this.activeChart.candleHtfTimeframe = select.value === 'Current' ? 'Off' : (select.value === 'Custom HTF' ? 'Custom' : select.value);
                        }
                        this.activeChart!.renderer.forceNextRender = true; // Bypass Eco-Mode throttle
                        this.activeChart!.indicatorManager.update(this.activeChart!.dataStore);
                        this.activeChart!.updateLegend();
                        this.activeChart!.updateHtfOverlayControl();
                        this.activeChart!.isDirty = true;
                        if (indModalTitle) indModalTitle.textContent = `${indicator.name} Settings`;
                        WorkspaceManager.triggerAutoSave();
                    };
                    row.appendChild(select);
                }

                indSettingsFields.appendChild(row);
            });
        };

        // Register function bridge so on-chart ⚙️ buttons can open it directly
        WorkspaceManager.showIndicatorSettingsFn = showSettingsView;

        const renderCatalogList = () => {
            if (!indicatorsList || !this.activeChart) return;
            indicatorsList.innerHTML = '';

            availableIndicators.forEach(cat => {
                const activeInstance = this.activeChart!.indicatorManager.activeIndicators.find(i => {
                    if (cat.type === 'EMA_SMA_CROSS') {
                        return i instanceof EmaSmaCrossIndicator || i.id === 'EMA_SMA_CROSS' || i.id.includes('CROSS');
                    }
                    if (cat.type === 'EMA') {
                        return (i instanceof EMAIndicator) && !(i instanceof EmaSmaCrossIndicator);
                    }
                    if (cat.type === 'SMA') {
                        return (i instanceof SMAIndicator) && !(i instanceof EmaSmaCrossIndicator);
                    }
                    if (cat.type === 'STRICT_CBC_PULLBACK') {
                        return i instanceof StrictCBCPullbackZonesIndicator || i.id === 'STRICT_CBC_PULLBACK' || i.id.startsWith('STRICT_CBC_PULLBACK');
                    }
                    if (cat.type === 'PULLBACK_ZONES') {
                        return (i instanceof MarketStructurePullbackZonesIndicator) && !(i instanceof StrictCBCPullbackZonesIndicator);
                    }
                    if (cat.type === 'MS_PULLBACK_DTDB') {
                        return i instanceof PullbackDoubleTopBottomIndicator || i.id === 'MS_PULLBACK_DTDB';
                    }
                    return i.id === cat.type || i.id.startsWith(cat.type);
                });
                const isActive = activeInstance !== undefined;

                const row = document.createElement('div');
                row.className = 'symbol-item';
                row.style.cssText = 'display: flex; align-items: center; justify-content: space-between; padding: 8px 16px; cursor: pointer;';

                const nameSpan = document.createElement('span');
                nameSpan.style.cssText = `font-weight: 600; color: ${isActive ? 'var(--chart-accent, #2962FF)' : 'var(--chart-text, #D1D4DC)'};`;
                nameSpan.textContent = isActive ? activeInstance.name : cat.name;
                row.appendChild(nameSpan);

                const actions = document.createElement('div');
                actions.style.cssText = 'display: flex; align-items: center; gap: 8px;';

                // Settings Gear Button (Only for active indicators)
                if (isActive) {
                    const gearBtn = document.createElement('button');
                    gearBtn.innerHTML = '⚙️';
                    gearBtn.title = 'Settings';
                    gearBtn.style.cssText = 'background: transparent; border: none; font-size: 13px; cursor: pointer; padding: 2px 4px; border-radius: 3px;';
                    gearBtn.onclick = (e) => {
                        e.stopPropagation();
                        showSettingsView(activeInstance);
                    };
                    actions.appendChild(gearBtn);
                }

                // Add / Remove Button
                const toggleBtn = document.createElement('button');
                toggleBtn.textContent = isActive ? 'Remove' : 'Add';
                toggleBtn.style.cssText = `background: ${isActive ? 'rgba(239, 83, 80, 0.15)' : 'rgba(41, 98, 255, 0.15)'}; color: ${isActive ? '#EF5350' : 'var(--chart-accent, #2962FF)'}; border: 1px solid ${isActive ? '#EF5350' : 'var(--chart-accent, #2962FF)'}; border-radius: 4px; padding: 3px 8px; font-size: 11px; font-weight: 600; cursor: pointer;`;

                toggleBtn.onclick = (e) => {
                    e.stopPropagation();
                    this.activeChart!.renderer.forceNextRender = true; // Bypass Eco-Mode throttle
                    if (isActive) {
                        this.activeChart!.renderer.removeIndicatorMesh(activeInstance.id);
                        this.activeChart!.indicatorManager.removeIndicator(activeInstance.id);
                        this.activeChart!.renderer.indicatorMainGraphics.clear(); // Force buffer clear
                        this.activeChart!.renderer.indicatorOscGraphics.clear();
                    } else {
                        const newInd = cat.factory();
                        newInd.updateParams({}); // Force lastCalculatedIdx invalidation
                        this.activeChart!.indicatorManager.addIndicator(newInd);
                    }
                    this.activeChart!.indicatorManager.update(this.activeChart!.dataStore);
                    this.activeChart!.updateLegend();
                    this.activeChart!.updateControlsLayout();
                    this.activeChart!.isDirty = true;
                    renderCatalogList();
                    WorkspaceManager.triggerAutoSave();
                };

                actions.appendChild(toggleBtn);
                row.appendChild(actions);
                indicatorsList.appendChild(row);
            });
        };

        btnIndicators?.addEventListener('click', () => {
            showListView();
            modalIndicators?.showModal();
        });

        btnIndBack?.addEventListener('click', () => {
            colorPicker.close();
            showListView();
        });

        btnIndSettingsApply?.addEventListener('click', () => {
            colorPicker.close();
            showListView();
        });

        btnCloseIndicators?.addEventListener('click', () => {
            colorPicker.close();
            modalIndicators?.close();
        });

        // Custom Timeframe Modal
        const btnCustomTf = document.getElementById('btn-custom-tf');
        const modalCustomTf = document.getElementById('custom-tf-modal') as HTMLDialogElement;
        const btnCloseCustomTf = document.getElementById('btn-close-custom-tf');
        const btnApplyCustomTf = document.getElementById('btn-apply-custom-tf');
        const inputTfVal = document.getElementById('input-custom-tf-val') as HTMLInputElement;
        const selectTfUnit = document.getElementById('select-custom-tf-unit') as HTMLSelectElement;

        btnCustomTf?.addEventListener('click', () => modalCustomTf?.showModal());
        btnCloseCustomTf?.addEventListener('click', () => modalCustomTf?.close());

        btnApplyCustomTf?.addEventListener('click', () => {
            const val = parseInt(inputTfVal?.value || '1', 10);
            const unit = selectTfUnit?.value || 'm';
            if (val > 0 && WorkspaceManager.activeChart) {
                const newTf = `${val}${unit}`;
                WorkspaceManager.activeChart.switchTimeframe(newTf);
                modalCustomTf?.close();
                WorkspaceManager.syncTopBar();
            }
        });

        // Custom Timeframe from Mobile Dropdown
        const btnMobileCustomTf = document.getElementById('btn-mobile-custom-tf');
        btnMobileCustomTf?.addEventListener('click', () => {
            if (mobileTfMenu) mobileTfMenu.style.display = 'none';
            modalCustomTf?.showModal();
        });

        // ---> NEW: Text Tool Modal Actions & Toolbar Binding <---
        const modalText = document.getElementById('text-tool-modal') as HTMLDialogElement;
        const btnTextClose = document.getElementById('btn-text-close');
        const btnTextCancel = document.getElementById('btn-text-cancel');
        const btnTextOk = document.getElementById('btn-text-ok');

        const closeTextModal = () => {
            modalText?.close();
            WorkspaceManager.currentEditingText = null;
        };

        btnTextClose?.addEventListener('click', closeTextModal);
        btnTextCancel?.addEventListener('click', closeTextModal);

        btnTextOk?.addEventListener('click', () => {
            const td = WorkspaceManager.currentEditingText;
            if (td && WorkspaceManager.getActiveChart()) {
                const input = document.getElementById('text-input') as HTMLTextAreaElement;
                const checkBg = document.getElementById('check-text-bg') as HTMLInputElement;
                const checkBorder = document.getElementById('check-text-border') as HTMLInputElement;
                const checkWrap = document.getElementById('check-text-wrap') as HTMLInputElement;
                const selectSize = document.getElementById('select-text-size') as HTMLSelectElement;

                td.textContent = input.value;
                td.hasBackground = checkBg.checked;
                td.hasBorder = checkBorder.checked;
                td.textWrap = checkWrap.checked;
                td.fontSize = parseInt(selectSize.value, 10) || 16;

                WorkspaceManager.getActiveChart()!.drawingManager.saveDrawing(td);

                WorkspaceManager.getActiveChart()!.isDirty = true;
                WorkspaceManager.triggerAutoSave();
            }
            closeTextModal();
        });

        // Bold
        document.getElementById('btn-text-bold')?.addEventListener('click', (e) => {
            const td = WorkspaceManager.currentEditingText;
            if (td) {
                td.isBold = !td.isBold;
                (e.currentTarget as HTMLElement).classList.toggle('active', td.isBold);
                WorkspaceManager.getActiveChart()!.isDirty = true;
            }
        });

        // Italic
        document.getElementById('btn-text-italic')?.addEventListener('click', (e) => {
            const td = WorkspaceManager.currentEditingText;
            if (td) {
                td.isItalic = !td.isItalic;
                (e.currentTarget as HTMLElement).classList.toggle('active', td.isItalic);
                WorkspaceManager.getActiveChart()!.isDirty = true;
            }
        });

        // Anchor
        document.getElementById('btn-text-anchor')?.addEventListener('click', (e) => {
            const td = WorkspaceManager.currentEditingText;
            const chart = WorkspaceManager.getActiveChart();
            if (td && chart) {
                td.isAnchored = !td.isAnchored;
                if (td.isAnchored) {
                    td.anchorX = chart.renderer.timeToX(td.points[0].time);
                    td.anchorY = chart.renderer.priceToY(td.points[0].price);
                }
                (e.currentTarget as HTMLElement).classList.toggle('active', td.isAnchored);
                chart.isDirty = true;
            }
        });

        // Lock
        document.getElementById('btn-text-lock')?.addEventListener('click', (e) => {
            const td = WorkspaceManager.currentEditingText;
            if (td) {
                td.isLocked = !td.isLocked;
                (e.currentTarget as HTMLElement).classList.toggle('active', td.isLocked);
            }
        });

        // Delete
        document.getElementById('btn-text-delete')?.addEventListener('click', () => {
            const td = WorkspaceManager.currentEditingText;
            const chart = WorkspaceManager.getActiveChart();
            if (td && chart) {
                chart.drawingManager.drawings = chart.drawingManager.drawings.filter(d => d !== td);
                chart.drawingManager.selectedDrawing = null;
                chart.isDirty = true;
                WorkspaceManager.triggerAutoSave();
            }
            closeTextModal();
        });

        // Text Color picker trigger
        document.getElementById('btn-text-color')?.addEventListener('click', (e) => {
            const td = WorkspaceManager.currentEditingText;
            if (!td) return;
            colorPicker.open({
                anchorElement: e.currentTarget as HTMLElement,
                initialColor: '#' + td.color.toString(16).padStart(6, '0'),
                showOpacity: false,
                onChange: (res) => {
                    td.color = parseInt(res.color.replace('#', ''), 16);
                    WorkspaceManager.getActiveChart()!.isDirty = true;
                }
            });
        });

        // Background Color picker trigger
        document.getElementById('btn-text-bg-color')?.addEventListener('click', (e) => {
            const td = WorkspaceManager.currentEditingText;
            const btn = e.currentTarget as HTMLElement;
            if (!td) return;
            colorPicker.open({
                anchorElement: btn,
                initialColor: '#' + td.bgColor.toString(16).padStart(6, '0'),
                showOpacity: true,
                onChange: (res) => {
                    td.bgColor = parseInt(res.color.replace('#', ''), 16);
                    td.bgAlpha = res.opacity;
                    btn.style.backgroundColor = res.color;
                    WorkspaceManager.getActiveChart()!.isDirty = true;
                }
            });
        });

        // Border Color picker trigger
        document.getElementById('btn-text-border-color')?.addEventListener('click', (e) => {
            const td = WorkspaceManager.currentEditingText;
            const btn = e.currentTarget as HTMLElement;
            if (!td) return;
            colorPicker.open({
                anchorElement: btn,
                initialColor: '#' + td.borderColor.toString(16).padStart(6, '0'),
                showOpacity: false,
                onChange: (res) => {
                    td.borderColor = parseInt(res.color.replace('#', ''), 16);
                    btn.style.backgroundColor = res.color;
                    WorkspaceManager.getActiveChart()!.isDirty = true;
                }
            });
        });

        // Global Toolbar 'tool-text' Click Listener
        document.getElementById('tool-text')?.addEventListener('click', (e) => {
            e.stopPropagation();
            if (WorkspaceManager.getActiveChart()) {
                WorkspaceManager.getActiveChart()!.drawingManager.startTool('text');
                document.querySelectorAll('.dt-btn').forEach(b => b.classList.remove('active'));
                (e.currentTarget as HTMLElement).classList.add('active');
            }
        });

        // Clean Mobile Sleep & Wakeup Detection (Single non-competing reconnect)
        let lastWakeupTrigger = 0;
        const triggerAggressiveWakeup = () => {
            const now = Date.now();
            if (now - lastWakeupTrigger < 2000) return; // Prevent duplicate rapid firings
            lastWakeupTrigger = now;

            WorkspaceManager.charts.forEach(c => c.handleWakeup());
        };

        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') {
                triggerAggressiveWakeup();
            }
        });

        window.addEventListener('pageshow', triggerAggressiveWakeup);
        window.addEventListener('focus', triggerAggressiveWakeup);

        window.addEventListener('offline', () => {
            WorkspaceManager.charts.forEach(c => c.network.handleOffline());
        });

        window.addEventListener('online', triggerAggressiveWakeup);
        (window as any).runMilestone1AcceptanceSuite = runMilestone1AcceptanceSuite;
    }
}