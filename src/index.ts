import { DataStore } from './data/DataStore';
import { BinanceClient } from './network/BinanceClient';
import { ChartRenderer } from './renderer/ChartRenderer';
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
    ZigZag123Indicator
} from './indicators/plugins';

import { DrawingManager } from './tools/DrawingManager';
import { IndicatorRegistry, type SavedIndicatorState } from './indicators/IndicatorRegistry';
import { PriceAxisRenderer } from './renderer/PriceAxisRenderer';
import { TimeAxisRenderer } from './renderer/TimeAxisRenderer';

export interface SavedPaneState {
    symbol: string;
    timeframe: string;
    chartMode: string;
    isAutoScale: boolean;
    indicators: SavedIndicatorState[];
}

export interface SavedWorkspaceState {
    version: number;
    layout: string;
    activePaneIndex: number;
    targetFPS?: number;
    toolbarDockMode?: 'free' | 'top';
    topBarDisplayMode?: 'change' | 'none';
    isAutoHideNav?: boolean;
    isCrosshairSyncEnabled?: boolean;
    dataLimits?: Record<string, number>;
    sessionConfig?: any;
    clockConfig?: any;
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

    private lastThemeIsDark: boolean = true;
    private lastWatchdogRecovery = 0;

    // Per-Pane Controls & Legend
    public autoBtn: HTMLButtonElement | null = null;
    public resetBtn: HTMLElement | null = null;
    public navBar: HTMLDivElement | null = null;
    public legendContainer: HTMLDivElement | null = null;
    public paneDrawingToolbar: HTMLDivElement | null = null; // <-- PER-PANE TOOLBAR
    private legendValNodes = new Map<string, HTMLElement>(); // <-- CACHE FOR FAST CROSSHAIR

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

        // Zero-delay ResizeObserver: syncs Pixi & axis canvases safely once renderer is ready
        const ro = new ResizeObserver(() => {
            const chartRect = this.chartCanvas.getBoundingClientRect();
            if (chartRect.width > 0 && chartRect.height > 0) {
                if (this.renderer.app && this.renderer.app.renderer) {
                    this.renderer.resize(chartRect.width, chartRect.height);
                    this.isDirty = true;
                    this.priceAxisRenderer.render();
                    this.timeAxisRenderer.render();
                }
            }
        });
        ro.observe(this.container);

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

            // ---> 2. CHECK FOR LIGHT/DARK TRANSITION <---
            if (theme.isDark !== this.lastThemeIsDark) {
                this.lastThemeIsDark = theme.isDark;
                const drawingsChanged = this.drawingManager.adaptDrawingsToTheme(theme.isDark);
                if (drawingsChanged) {
                    WorkspaceManager.triggerAutoSave();
                }
            }

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
            opacity: 0.15; transition: opacity 0.2s cubic-bezier(0.4, 0, 0.2, 1);
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

                if (action === 'cursor') this.drawingManager.activeToolType = null;
                else if (['trendline', 'hray', 'vline', 'rect', 'fib', 'prange'].includes(action!)) {
                    this.drawingManager.startTool(action as any);
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
                if (distFromTop >= 0 && distFromTop <= 60 && distFromCenterX <= 220) this.paneDrawingToolbar.style.opacity = '1';
                else this.paneDrawingToolbar.style.opacity = '0.15';
            }
        });

        this.container.addEventListener('pointerleave', () => {
            if (WorkspaceManager.isAutoHideNav) this.hideNavBar();
            if (this.legendContainer) this.legendContainer.style.opacity = '0.15';
            if (this.paneDrawingToolbar) this.paneDrawingToolbar.style.opacity = '0.15';
        });
    }

    public destroy() {
        this.isRunning = false;

        if (this.themeUnsubscribe) {
            this.themeUnsubscribe();
            this.themeUnsubscribe = null;
        }

        this.network.disconnect();
        this.renderer.destroy();
        this.autoBtn?.remove();
        this.navBar?.remove();
        this.legendContainer?.remove();
        this.paneDrawingToolbar?.remove();
        this.cornerBox?.remove();
        this.overlayLayer?.remove();
        this.chartCanvas?.remove();
        this.priceCanvas?.remove();
        this.timeCanvas?.remove();
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

                    document.querySelectorAll('.dt-btn').forEach(b => b.classList.remove('active'));
                    document.getElementById('tool-cursor')?.classList.add('active');

                    if (this.paneDrawingToolbar) {
                        this.paneDrawingToolbar.querySelectorAll('.dt-btn[data-action]').forEach(b => b.classList.remove('active'));
                        this.paneDrawingToolbar.querySelector('[data-action="cursor"]')?.classList.add('active');
                    }
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
                return; // Stop chart from panning
            }

            // Broadcast time to other panes
            if (WorkspaceManager.isCrosshairSyncEnabled) {
                const actualSpacing = this.renderer.candleSpacing * this.renderer.zoom;
                const logicalIndex = Math.round((this.renderer.crosshairX + this.renderer.cameraX) / actualSpacing);
                const firstTime = this.dataStore.length > 0 ? this.dataStore.data[0] : 0;
                const intervalMs = this.renderer.parseIntervalMs(this.renderer.currentInterval);
                WorkspaceManager.broadcastCrosshair(firstTime + (logicalIndex * intervalMs), this);
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

                // ---> NEW: Mobile Drawing Support <---
                if (this.drawingManager.activeToolType) {
                    const finished = this.drawingManager.onPointerDown(this.renderer, x, y, e.shiftKey);
                    if (finished) {
                        const finishedDrawing = this.drawingManager.drawings[this.drawingManager.drawings.length - 1];

                        if (finishedDrawing) this.drawingManager.saveDrawing(finishedDrawing);

                        // If we just placed a Text tool, open the editor modal immediately!
                        if (finishedDrawing && finishedDrawing.constructor.name === 'TextDrawing') {
                            WorkspaceManager.openTextEditor(finishedDrawing as any);
                        }

                        document.querySelectorAll('.dt-btn').forEach(b => b.classList.remove('active'));
                        document.getElementById('tool-cursor')?.classList.add('active');

                        if (this.paneDrawingToolbar) {
                            this.paneDrawingToolbar.querySelectorAll('.dt-btn[data-action]').forEach(b => b.classList.remove('active'));
                            this.paneDrawingToolbar.querySelector('[data-action="cursor"]')?.classList.add('active');
                        }
                    }
                    this.isDirty = true;
                    return;
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

                // ---> NEW: Mobile Drawing Creation Support <---
                if (this.drawingManager.activeToolType) {
                    this.drawingManager.onPointerMove(this.renderer, x, y);
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

                    // Broadcast crosshair sync to other panes
                    if (WorkspaceManager.isCrosshairSyncEnabled) {
                        const actualSpacing = this.renderer.candleSpacing * this.renderer.zoom;
                        const logicalIndex = Math.round((x + this.renderer.cameraX) / actualSpacing);
                        const firstTime = this.dataStore.length > 0 ? this.dataStore.data[0] : 0;
                        const intervalMs = this.renderer.parseIntervalMs(this.renderer.currentInterval);
                        WorkspaceManager.broadcastCrosshair(firstTime + (logicalIndex * intervalMs), this);
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
                        if (this.autoBtn) this.autoBtn.style.color = 'var(--chart-text, #787B86)';
                        const chartHeight = this.renderer.app.screen.height - this.renderer.timeAxisHeight;
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
            // Mobile Double-Tap to Reset AutoScale
            const now = Date.now();
            const duration = now - this.touchStartTime;
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
            indicators: this.indicatorManager.activeIndicators.map(i => IndicatorRegistry.serialize(i))
        };
    }

    public async deserialize(state: SavedPaneState) {
        this.currentSymbol = state.symbol || 'BTCUSDT';
        this.currentInterval = state.timeframe || '1m';

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
    }

    public async switchTimeframe(newInterval: string) {
        this.currentInterval = newInterval;
        this.renderer.currentInterval = newInterval;
        this.network.disconnect();
        this.dataStore.clear();
        this.indicatorManager.resetAll();
        this.isDirty = true;

        await this.network.connect(this.currentSymbol, this.currentInterval, (prependedCount = 0, isClosed = true) => {
            if (prependedCount > 0 && !this.isLockedToEdge) {
                const actualSpacing = this.renderer.candleSpacing * this.renderer.zoom;
                this.renderer.cameraX += prependedCount * actualSpacing;
            }
            this.indicatorManager.update(this.dataStore, isClosed); // Run Math Engine
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
        WorkspaceManager.triggerAutoSave();
    }

    public async switchSymbol(newSymbol: string) {
        this.currentSymbol = newSymbol;
        this.drawingManager.loadDrawings(newSymbol); // Load DB drawings!
        this.network.disconnect();
        this.dataStore.clear();
        this.indicatorManager.resetAll();
        this.isDirty = true;

        await this.network.connect(this.currentSymbol, this.currentInterval, (prependedCount = 0, isClosed = true) => {
            if (prependedCount > 0 && !this.isLockedToEdge) {
                const actualSpacing = this.renderer.candleSpacing * this.renderer.zoom;
                this.renderer.cameraX += prependedCount * actualSpacing;
            }
            this.indicatorManager.update(this.dataStore, isClosed); // Run Math Engine
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
        WorkspaceManager.triggerAutoSave();
    }

    public async startLiveBinance(symbol: string, interval: string) {
        this.currentSymbol = symbol;
        this.currentInterval = interval;

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
            if (prependedCount > 0 && !this.isLockedToEdge) {
                const actualSpacing = this.renderer.candleSpacing * this.renderer.zoom;
                this.renderer.cameraX += prependedCount * actualSpacing;
            }
            // Propagate live unclosed tick state to indicator pipeline
            this.indicatorManager.update(this.dataStore, isClosed);
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

        setInterval(() => {
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
                    const remainingMs = (lastTime + intervalMs) - Date.now();

                    if (remainingMs <= -3000) {
                        const now = Date.now();
                        // 5s cooldown between recovery attempts
                        if (now - this.lastWatchdogRecovery > 5000) {
                            this.lastWatchdogRecovery = now;
                            this.network.handleWatchdogRecovery();
                        }
                    }
                }

                // Isolated partial update: Only repaints the countdown pill and clock badges
                this.priceAxisRenderer.updateCountdownOnly();
                this.timeAxisRenderer.updateClocksOnly();
            }
        }, 1000);

        let lastFrameTime = performance.now();

        const loop = (now: number) => {
            if (!this.isRunning) return;
            const frameInterval = 1000 / WorkspaceManager.targetFPS;
            const elapsed = now - lastFrameTime;

            if (elapsed >= frameInterval) {
                lastFrameTime = now - (elapsed % frameInterval);

                if (this.isDirty) {
                    // Update stacked oscillator height and dock AUTO button
                    const oscHeight = this.indicatorManager.getTotalOscillatorHeight();
                    this.renderer.oscHeight = oscHeight;
                    this.renderer.indicatorOscGraphics.visible = oscHeight > 0;
                    this.updateControlsLayout();

                    const activeOsc = this.indicatorManager.getActiveOscillator();
                    this.renderer.activeOscillatorScale = activeOsc?.oscillatorScale;

                    // 1. Evaluate dirty state and calculate positions
                    this.renderer.renderFrame();

                    // 2. Only submit GPU draw call if something visible actually changed
                    if (this.renderer.isRenderDirty) {
                        // Only rebuild indicators, drawings & time axis if camera moved or candle closed
                        if (this.renderer.isHistoricalDirty) {
                            this.renderer.indicatorMainGraphics.clear();
                            this.renderer.indicatorOscGraphics.clear();
                            this.renderer.hideAllIndicatorMeshes();
                            this.indicatorManager.render(this.renderer, this.renderer.indicatorMainGraphics, this.renderer.indicatorOscGraphics);

                            this.drawingManager.render(this.renderer, this.renderer.drawingGraphics);
                            this.timeAxisRenderer.render();
                        }

                        this.renderer.renderCrosshair();
                        this.priceAxisRenderer.render();

                        this.renderer.render(); // 🎯 Only refreshes main canvas when dragging or on-screen bar changes
                    } else {
                        // Main canvas is idle in history: update only the price axis badge without touching main canvas
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
                    this.renderer.render(); // 🎯 Submit frame for crosshair move only
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
    public static targetFPS = 60;
    public static showIndicatorSettingsFn: ((ind: any) => void) | null = null; // <-- Bridge to settings view

    public static currentLayout = '1';
    private static saveTimeout: any = null;
    public static toolbarDockMode: 'free' | 'top' = 'free';
    public static topBarDisplayMode: 'change' | 'none' = 'change';

    // Global Timeframe Download Limits (Stored in days, -1 = Infinity)
    public static dataLimits: Record<string, number> = {
        'limit_1m_3m': 21,
        'limit_4m_8m': 30,
        'limit_9m_12m': 90,
        'limit_15m': 180,
        'limit_30m_45m': 365,
        'limit_1h_3h': 730,
        'limit_4h_6h': 1460,
        'limit_7h_12h': 1825,
        'limit_13h_1d': 3650,
        'limit_1w_1M': -1
    };

    public static sessionConfig = {
        enabled: true,
        showOnAxis: true,
        showOnChart: false,
        asiaColor: '#FBC02D80',
        londonColor: '#2962FF80',
        nyColor: '#EF535080'
    };

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
        const parseSess = (hex: string) => {
            const clean = hex.replace('#', '');
            const color = parseInt(clean.slice(0, 6), 16) || 0;
            const alpha = clean.length >= 8 ? parseInt(clean.slice(6, 8), 16) / 255 : 0.5;
            return { color, alpha };
        };

        const asia = parseSess(this.sessionConfig.asiaColor);
        const london = parseSess(this.sessionConfig.londonColor);
        const ny = parseSess(this.sessionConfig.nyColor);

        this.charts.forEach(c => {
            c.renderer.sessionConfig = {
                enabled: this.sessionConfig.enabled,
                showOnAxis: this.sessionConfig.showOnAxis,
                showOnChart: this.sessionConfig.showOnChart,
                asiaColor: asia.color,
                asiaAlpha: asia.alpha,
                londonColor: london.color,
                londonAlpha: london.alpha,
                nyColor: ny.color,
                nyAlpha: ny.alpha
            };
            c.renderer.isSessionDirty = true; // <-- Flag GPU Mesh to rebuild
            c.isDirty = true;
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
            if (globalDt) globalDt.style.display = 'flex'; // Show global floating toolbar
            this.charts.forEach(c => {
                if (c.paneDrawingToolbar) c.paneDrawingToolbar.style.display = 'none'; // Hide per-pane toolbars
            });
        }
    }

    public static saveWorkspace() {
        if (this.charts.length === 0) return;
        const state: SavedWorkspaceState = {
            version: 1,
            layout: this.currentLayout,
            activePaneIndex: this.activeChart ? this.charts.indexOf(this.activeChart) : 0,
            targetFPS: this.targetFPS,
            toolbarDockMode: this.toolbarDockMode,
            topBarDisplayMode: this.topBarDisplayMode,
            isAutoHideNav: this.isAutoHideNav,
            isCrosshairSyncEnabled: this.isCrosshairSyncEnabled,
            dataLimits: this.dataLimits,
            sessionConfig: this.sessionConfig,
            clockConfig: this.clockConfig,
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
        this.setupGlobalControls();

        try {
            const raw = localStorage.getItem('ecochart_workspace_v1');
            if (raw) {
                const state = JSON.parse(raw) as SavedWorkspaceState;
                if (state.version === 1) {
                    // Restore global workspace preferences
                    if (state.targetFPS) this.targetFPS = state.targetFPS;
                    if (state.toolbarDockMode) this.toolbarDockMode = state.toolbarDockMode;
                    if (state.topBarDisplayMode) this.topBarDisplayMode = state.topBarDisplayMode;
                    if (state.isAutoHideNav !== undefined) this.isAutoHideNav = state.isAutoHideNav;
                    if (state.isCrosshairSyncEnabled !== undefined) this.isCrosshairSyncEnabled = state.isCrosshairSyncEnabled;
                    if (state.dataLimits) this.dataLimits = { ...this.dataLimits, ...state.dataLimits };

                    if (state.sessionConfig) this.sessionConfig = { ...this.sessionConfig, ...state.sessionConfig };
                    if (state.clockConfig) this.clockConfig = { ...this.clockConfig, ...state.clockConfig };

                    this.updateToolbarDock();

                    this.setLayout(state.layout, state.panes);
                    if (state.activePaneIndex >= 0 && state.activePaneIndex < this.charts.length) {
                        this.setActiveChart(this.charts[state.activePaneIndex]);
                    }
                    return;
                }
            }
        } catch (err) {
            console.warn('Failed to load workspace', err);
        }

        this.setLayout('1'); // Fallback if no save exists
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
            let dragTimer: any = null;

            // 1. Draggable Engine (Long-Press for Mobile, Instant for Desktop)
            dtHandle.addEventListener('pointerdown', (e) => {
                if (WorkspaceManager.toolbarDockMode === 'top') return;

                startX = e.clientX;
                startY = e.clientY;
                initialLeft = dt.offsetLeft;
                initialTop = dt.offsetTop;

                const startDragging = () => {
                    isDragging = true;
                    dtHandle.setPointerCapture(e.pointerId);
                    dtHandle.style.cursor = 'grabbing';
                    dt.style.opacity = '0.9'; // Visual feedback
                    if (navigator.vibrate) navigator.vibrate(40); // Haptic feedback on Android
                };

                if (e.pointerType === 'touch') {
                    // Mobile: Require 300ms hold to start dragging
                    dragTimer = setTimeout(startDragging, 300);
                } else {
                    // Desktop: Instant drag
                    startDragging();
                }
            });

            dtHandle.addEventListener('pointermove', (e) => {
                if (!isDragging) {
                    // If user moves finger before the timer pops, cancel the drag intent
                    if (dragTimer && Math.hypot(e.clientX - startX, e.clientY - startY) > 10) {
                        clearTimeout(dragTimer);
                        dragTimer = null;
                    }
                    return;
                }

                try { e.preventDefault(); } catch { } // Force Android to ignore native gestures

                const dx = e.clientX - startX;
                const dy = e.clientY - startY;

                // Keep within screen bounds
                const newLeft = Math.max(0, Math.min(window.innerWidth - dt.offsetWidth, initialLeft + dx));
                const newTop = Math.max(38, Math.min(window.innerHeight - dt.offsetHeight, initialTop + dy)); // 38px avoids top bar

                dt.style.left = `${newLeft}px`;
                dt.style.top = `${newTop}px`;
            });

            const stopDrag = (e: PointerEvent) => {
                if (dragTimer) {
                    clearTimeout(dragTimer);
                    dragTimer = null;
                }
                if (isDragging) {
                    isDragging = false;
                    dtHandle.releasePointerCapture(e.pointerId);
                    dtHandle.style.cursor = 'grab';
                    dt.style.opacity = '1';
                    WorkspaceManager.triggerAutoSave();
                }
            };

            dtHandle.addEventListener('pointerup', stopDrag);
            dtHandle.addEventListener('pointercancel', stopDrag);

            // 2. Proximity Fading (Global)
            document.addEventListener('pointermove', (e) => {
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
                        this.activeChart.drawingManager.startTool(tool as any);

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
                        if (tool === 'cursor') this.activeChart.drawingManager.activeToolType = null;
                        else this.activeChart.drawingManager.startTool(tool as any);
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

        // (Note: Per-pane Nav Bars and Auto buttons are bound directly inside each EcoChart instance)

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
                    (t as HTMLElement).style.background = 'transparent';
                    (t as HTMLElement).style.color = '#787B86';
                });
                (tab as HTMLElement).style.background = '#2A2E39';
                (tab as HTMLElement).style.color = '#2962FF';

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

            const selTopBar = document.getElementById('select-topbar-display') as HTMLSelectElement;
            if (selTopBar) selTopBar.value = WorkspaceManager.topBarDisplayMode;

            const selectFPS = document.getElementById('select-fps-limit') as HTMLSelectElement;
            if (selectFPS) selectFPS.value = WorkspaceManager.targetFPS.toString();

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
            const chkSessEnabled = document.getElementById('check-sessions-enabled') as HTMLInputElement;
            if (chkSessEnabled) chkSessEnabled.checked = WorkspaceManager.sessionConfig.enabled;
            const chkSessAxis = document.getElementById('check-sessions-axis') as HTMLInputElement;
            if (chkSessAxis) chkSessAxis.checked = WorkspaceManager.sessionConfig.showOnAxis;
            const chkSessChart = document.getElementById('check-sessions-chart') as HTMLInputElement;
            if (chkSessChart) chkSessChart.checked = WorkspaceManager.sessionConfig.showOnChart;

            setSwatch('input-sess-asia', WorkspaceManager.sessionConfig.asiaColor);
            setSwatch('input-sess-london', WorkspaceManager.sessionConfig.londonColor);
            setSwatch('input-sess-ny', WorkspaceManager.sessionConfig.nyColor);

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

        // Bind Session Checkboxes
        const bindSessCheck = (id: string, key: keyof typeof WorkspaceManager.sessionConfig) => {
            document.getElementById(id)?.addEventListener('change', (e) => {
                (WorkspaceManager.sessionConfig as any)[key] = (e.target as HTMLInputElement).checked;
                WorkspaceManager.syncSessions();
                WorkspaceManager.triggerAutoSave();
            });
        };
        bindSessCheck('check-sessions-enabled', 'enabled');
        bindSessCheck('check-sessions-axis', 'showOnAxis');
        bindSessCheck('check-sessions-chart', 'showOnChart');

        // Bind Session Swatches (with Opacity Enabled)
        const bindSessionSwatch = (btnId: string, configKey: keyof typeof WorkspaceManager.sessionConfig) => {
            const btn = document.getElementById(btnId);
            if (!btn) return;
            btn.addEventListener('click', () => {
                const currentHex = (WorkspaceManager.sessionConfig as any)[configKey] || '#FFFFFF';
                colorPicker.open({
                    anchorElement: btn,
                    initialColor: currentHex,
                    showOpacity: true, // <--- OPACITY SLIDER ENABLED
                    onChange: (res) => {
                        const aHex = Math.round(res.opacity * 255).toString(16).padStart(2, '0');
                        const fullHex = `${res.color.slice(0, 7)}${aHex}`.toUpperCase();
                        btn.dataset.color = fullHex;
                        btn.style.backgroundColor = fullHex;
                        (WorkspaceManager.sessionConfig as any)[configKey] = fullHex;
                        WorkspaceManager.syncSessions();
                        WorkspaceManager.triggerAutoSave();
                    }
                });
            });
        };
        bindSessionSwatch('input-sess-asia', 'asiaColor');
        bindSessionSwatch('input-sess-london', 'londonColor');
        bindSessionSwatch('input-sess-ny', 'nyColor');

        // Bind Clock Controls
        document.getElementById('check-clock-enabled')?.addEventListener('change', (e) => {
            WorkspaceManager.clockConfig.enabled = (e.target as HTMLInputElement).checked;
            WorkspaceManager.syncClock();
            WorkspaceManager.triggerAutoSave();
        });

        document.getElementById('select-clock-primary')?.addEventListener('change', (e) => {
            WorkspaceManager.clockConfig.primaryTz = (e.target as HTMLSelectElement).value;
            WorkspaceManager.syncClock();
            WorkspaceManager.triggerAutoSave();
        });

        document.getElementById('select-clock-secondary')?.addEventListener('change', (e) => {
            WorkspaceManager.clockConfig.secondaryTz = (e.target as HTMLSelectElement).value;
            WorkspaceManager.syncClock();
            WorkspaceManager.triggerAutoSave();
        });

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

        const selectTopBar = document.getElementById('select-topbar-display') as HTMLSelectElement;
        selectTopBar?.addEventListener('change', (e) => {
            WorkspaceManager.topBarDisplayMode = (e.target as HTMLSelectElement).value as 'change' | 'none';
            WorkspaceManager.syncTopBar();
            WorkspaceManager.triggerAutoSave();
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

        // Workspace Quick Access Icon (Top Toolbar)
        const btnWorkspaceModal = document.getElementById('btn-workspace-modal');
        btnWorkspaceModal?.addEventListener('click', () => {
            syncModalInputs();

            // Programmatically switch to the Workspace tab
            document.querySelectorAll('.modal-tab-btn').forEach(t => {
                (t as HTMLElement).style.background = 'transparent';
                (t as HTMLElement).style.color = '#787B86';
            });
            const wsTab = document.querySelector('.modal-tab-btn[data-tab="workspace"]') as HTMLElement;
            if (wsTab) {
                wsTab.style.background = '#2A2E39';
                wsTab.style.color = '#2962FF';
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

            colorPicker.close();
            modalSettings?.close();
            WorkspaceManager.triggerAutoSave(); // <-- Save all modal changes
        };
        btnCloseSettings?.addEventListener('click', closeSettings);
        btnModalCloseX?.addEventListener('click', closeSettings);

        // Symbol Search Modal
        const btnSymbol = document.getElementById('btn-symbol');
        const modalSymbol = document.getElementById('symbol-modal') as HTMLDialogElement;
        const inputSearch = document.getElementById('symbol-search-input') as HTMLInputElement;
        const listContainer = document.getElementById('symbol-list');
        const btnCloseSymbol = document.getElementById('btn-symbol-modal-close');

        let allSymbols: Array<{ symbol: string; baseAsset: string; quoteAsset: string }> = [];
        let filteredSymbols: Array<{ symbol: string; baseAsset: string; quoteAsset: string }> = [];
        let selectedIndex = 0;

        const renderSymbolList = () => {
            if (!listContainer) return;
            listContainer.innerHTML = '';
            if (filteredSymbols.length === 0) {
                listContainer.innerHTML = '<div style="padding: 18px; text-align: center; color: #787B86; font-size: 12px;">No matching USDT pairs found</div>';
                return;
            }
            const limit = Math.min(filteredSymbols.length, 50);
            for (let i = 0; i < limit; i++) {
                const item = filteredSymbols[i];
                const row = document.createElement('div');
                row.className = `symbol-item ${i === selectedIndex ? 'selected' : ''}`;
                row.innerHTML = `
                    <div style="display: flex; align-items: center; gap: 8px;">
                        <span style="font-weight: 700; color: var(--chart-text, #D1D4DC);">${item.symbol}</span>
                        <span style="font-size: 11px; color: var(--chart-text, #787B86); opacity: 0.65;">${item.baseAsset}</span>
                    </div>
                    <span style="font-size: 11px; background: var(--chart-grid, rgba(0,0,0,0.08)); padding: 2px 6px; border-radius: 4px; color: var(--chart-text, #787B86); font-weight: 600;">${item.quoteAsset}</span>
                `;
                row.addEventListener('click', () => {
                    WorkspaceManager.activeChart?.switchSymbol(item.symbol);
                    WorkspaceManager.syncTopBar();
                    modalSymbol?.close();
                });
                listContainer.appendChild(row);
            }
        };

        btnSymbol?.addEventListener('click', async () => {
            modalSymbol?.showModal();
            inputSearch.value = '';
            inputSearch.focus();
            if (allSymbols.length === 0 && WorkspaceManager.activeChart) {
                allSymbols = await WorkspaceManager.activeChart.network.fetchTradableSymbols();
            }
            filteredSymbols = allSymbols.slice(0, 50);
            selectedIndex = 0;
            renderSymbolList();
        });

        inputSearch?.addEventListener('input', (e) => {
            const clean = (e.target as HTMLInputElement).value.trim().toUpperCase();
            filteredSymbols = clean
                ? allSymbols.filter((s) => s.symbol.includes(clean) || s.baseAsset.includes(clean)).slice(0, 50)
                : allSymbols.slice(0, 50);
            selectedIndex = 0;
            renderSymbolList();
        });

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
            { type: 'VOL', name: 'Volume', factory: () => new VolumeIndicator() },
            { type: 'EXHAUST', name: 'Exhaustion (CCI)', factory: () => new ExhaustionIndicator() },
            { type: 'HTF_BOX', name: 'HTF Box', factory: () => new HTFBoxIndicator(60) },
            { type: 'HTF_BIAS', name: 'HTF Bias', factory: () => new HTFBiasIndicator(60) },
            { type: 'HTF_PROJ', name: 'HTF Projections', factory: () => new HTFProjectionsIndicator(240) },
            { type: 'ZZ123', name: 'ZigZag 1-2-3 Breakout', factory: () => new ZigZag123Indicator(4) }
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
                            this.activeChart!.renderer.forceNextRender = true; // Bypass Eco-Mode throttle
                            this.activeChart!.indicatorManager.update(this.activeChart!.dataStore);
                            this.activeChart!.updateLegend();
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
                        colorPicker.open({
                            anchorElement: swatch,
                            initialColor: String(param.value),
                            showOpacity: false,
                            onChange: (res) => {
                                swatch.style.backgroundColor = res.color;
                                indicator.updateParams({ [param.id]: res.color });
                                this.activeChart!.renderer.forceNextRender = true; // Bypass Eco-Mode throttle
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
                        this.activeChart!.renderer.forceNextRender = true; // Bypass Eco-Mode throttle
                        this.activeChart!.updateLegend();
                        this.activeChart!.isDirty = true;
                        WorkspaceManager.triggerAutoSave();
                    };
                    row.appendChild(check);

                    // Field Type 4: Select Dropdown
                } else if (param.type === 'select') {
                    const select = document.createElement('select');
                    select.style.cssText = 'background: var(--chart-panel-bg, #1e222d); color: var(--chart-text, #D1D4DC); border: 1px solid var(--chart-grid, #434651); border-radius: 4px; padding: 4px 8px; font-size: 12px; outline: none; cursor: pointer;';

                    (param.options || []).forEach((opt: string) => {
                        const optEl = document.createElement('option');
                        optEl.value = opt;
                        optEl.textContent = opt;
                        optEl.selected = String(param.value) === opt;
                        select.appendChild(optEl);
                    });

                    select.onchange = () => {
                        indicator.updateParams({ [param.id]: select.value });
                        this.activeChart!.renderer.forceNextRender = true; // Bypass Eco-Mode throttle
                        this.activeChart!.indicatorManager.update(this.activeChart!.dataStore);
                        this.activeChart!.updateLegend();
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
                const activeInstance = this.activeChart!.indicatorManager.activeIndicators.find(
                    i => i.id.startsWith(cat.type) || i.name.startsWith(cat.name)
                );
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

        // Tab Wakeup & Network Reconnect Listeners
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') {
                WorkspaceManager.charts.forEach(c => c.handleWakeup());
            }
        });

        window.addEventListener('offline', () => {
            WorkspaceManager.charts.forEach(c => c.network.handleOffline());
        });

        window.addEventListener('online', () => {
            // 600ms stabilization delay allows OS DNS and gateway routing to become ready
            setTimeout(() => {
                WorkspaceManager.charts.forEach(c => c.handleWakeup());
            }, 600);
        });
    }
}