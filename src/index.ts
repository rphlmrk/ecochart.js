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
    public canvas: HTMLCanvasElement;
    public container: HTMLElement;
    public isRunning = true;
    private themeUnsubscribe: (() => void) | null = null; // <--- ADD THIS

    // Per-Pane Controls & Legend
    public autoBtn: HTMLButtonElement | null = null;
    public resetBtn: HTMLElement | null = null;
    public navBar: HTMLDivElement | null = null;
    public legendContainer: HTMLDivElement | null = null; // <-- NEW

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

    constructor(target: string | HTMLElement) {
        const el = typeof target === 'string' ? document.getElementById(target) : target;
        if (!el) throw new Error("Container element not found");
        this.container = el;
        this.container.innerHTML = "";

        this.canvas = document.createElement('canvas');
        this.canvas.style.width = '100%';
        this.canvas.style.height = '100%';
        this.canvas.style.display = 'block';
        this.canvas.style.touchAction = 'none';
        this.container.appendChild(this.canvas);

        this.dataStore = new DataStore();
        this.renderer = new ChartRenderer(this.dataStore);
        this.network = new BinanceClient(this.dataStore);
        this.indicatorManager = new IndicatorManager();
        this.drawingManager = new DrawingManager();
        this.renderer.indicatorManager = this.indicatorManager; // Link reference

        // Build per-pane Auto button and Navigation Bar
        this.createPaneControls();

        this.themeUnsubscribe = themeManager.subscribe((theme) => { 
            this.renderer.applyTheme(theme);
            const accent = themeManager.getResolvedAccentColor();
            if (this.autoBtn) {
                this.autoBtn.style.color = this.renderer.isAutoScale ? accent : 'var(--chart-text, #787B86)';
            }
            if (this.resetBtn) {
                this.resetBtn.style.color = accent;
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

    private createPaneControls() {
        const accent = themeManager.getResolvedAccentColor();

        // 1. Interactive On-Chart Legend (Top-Left of this pane)
        this.legendContainer = document.createElement('div');
        this.legendContainer.className = 'chart-legend';
        this.container.appendChild(this.legendContainer);

        // 2. Auto-fit button for this pane (Positioned dynamically at bottom of main price axis)
        this.autoBtn = document.createElement('button');
        this.autoBtn.textContent = 'AUTO';
        this.autoBtn.title = 'Auto-fit scale';
        this.autoBtn.style.cssText = `
            position: absolute; right: 6px; bottom: 28px; z-index: 5;
            background: var(--chart-panel-bg, #1E222D);
            color: ${this.renderer.isAutoScale ? accent : 'var(--chart-text, #787B86)'};
            border: 1px solid var(--chart-grid, #2A2E39); border-radius: 3px;
            font-size: 11px; font-weight: 700; padding: 2px 6px; cursor: pointer;
            user-select: none; text-transform: uppercase;
        `;
        this.autoBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            WorkspaceManager.setActiveChart(this);
            this.toggleAutoScale();
        });
        this.container.appendChild(this.autoBtn);

        // 3. Floating navigation bar for this pane
        this.navBar = document.createElement('div');
        this.navBar.className = 'pane-nav-bar';
        this.navBar.style.cssText = `
            position: absolute; bottom: 32px; left: 50%; transform: translateX(-50%);
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
        this.container.appendChild(this.navBar);

        // Hide initially if auto-hide is enabled
        if (WorkspaceManager.isAutoHideNav) {
            this.hideNavBar();
        }

        // Proximity detection: show when mouse moves near the bottom center of this pane
        this.container.addEventListener('pointermove', (e) => {
            if (!this.navBar || !WorkspaceManager.isAutoHideNav) return;
            const rect = this.container.getBoundingClientRect();
            const distFromBottom = rect.bottom - e.clientY;
            const distFromCenterX = Math.abs(e.clientX - (rect.left + rect.width / 2));

            // Within 120px vertically from bottom, and within 180px horizontally of the nav bar
            if (distFromBottom >= 0 && distFromBottom <= 120 && distFromCenterX <= 180) {
                this.showNavBar();
            } else {
                this.hideNavBar();
            }
        });

        this.container.addEventListener('pointerleave', () => {
            if (WorkspaceManager.isAutoHideNav) {
                this.hideNavBar();
            }
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
        this.legendContainer?.remove(); // <-- Clean up legend
        this.canvas.remove();
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

            // 👁 / ⊘ Visibility Toggle Button
            const eyeBtn = document.createElement('button');
            eyeBtn.className = 'legend-btn';
            eyeBtn.innerHTML = ind.visible ? '👁' : '⊘';
            eyeBtn.title = ind.visible ? 'Hide' : 'Show';
            eyeBtn.onclick = (e) => {
                e.stopPropagation();
                ind.visible = !ind.visible;
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
            const item = this.legendContainer!.querySelector(`[data-ind-id="${ind.id}"]`);
            if (item) {
                const valSpan = item.querySelector('.legend-val') as HTMLElement;
                if (valSpan) {
                    const data = ind.getValueAt(targetIdx, this.dataStore, this.renderer.isDarkTheme, this.renderer.axisTextColor);
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
                this.drawingManager.onPointerDown(this.renderer, x, y);
                this.isDirty = true;
                return; // Stop here so we don't trigger panning
            }

            const chartWidth = this.renderer.app.screen.width - this.renderer.priceAxisWidth;
            const chartHeight = this.renderer.app.screen.height - this.renderer.timeAxisHeight;

            // Detect which zone was clicked
            if (x > chartWidth) {
                this.isDraggingPriceAxis = true;
            } else if (y > chartHeight) {
                this.isDraggingTimeAxis = true;
                // Lock the point on the timeline directly beneath your cursor
                this.timeAxisAnchorX = x;
                this.timeAxisWorldX = (x + this.renderer.cameraX) / this.renderer.zoom;
            } else {
                this.isDraggingChart = true;
            }

            this.lastMouseX = e.clientX;
            this.lastMouseY = e.clientY;
            this.canvas.setPointerCapture(e.pointerId);
        });

        this.canvas.addEventListener('pointermove', (e) => {
            if (e.pointerType === 'touch') return; // Prevent double-speed drag & thumb crosshair
            const rect = this.canvas.getBoundingClientRect();
            this.renderer.crosshairX = e.clientX - rect.left;
            this.renderer.crosshairY = e.clientY - rect.top;
            this.renderer.isCrosshairVisible = true;
            this.isCrosshairDirty = true; // Mark crosshair dirty only (does not redraw candles)
            this.updateLegendValues();

              if (this.drawingManager.activeToolType) {
                this.drawingManager.onPointerMove(this.renderer, this.renderer.crosshairX, this.renderer.crosshairY);
                this.isDirty = true;
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

            // Change cursor based on hover zone
            const chartWidth = this.renderer.app.screen.width - this.renderer.priceAxisWidth;
            const chartHeight = this.renderer.app.screen.height - this.renderer.timeAxisHeight;
            if (this.renderer.crosshairX > chartWidth) this.canvas.style.cursor = 'ns-resize';
            else if (this.renderer.crosshairY > chartHeight) this.canvas.style.cursor = 'ew-resize';
            else this.canvas.style.cursor = 'crosshair';

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
                const priceRange = this.renderer.currentMaxPrice - this.renderer.currentMinPrice;
                const stretchFactor = deltaY * (priceRange / chartHeight) * 2;
                this.renderer.currentMaxPrice += stretchFactor;
                this.renderer.currentMinPrice -= stretchFactor;
            } else if (this.isDraggingTimeAxis) {
                const zoomMultiplier = 1 + (deltaX * 0.005);
                this.renderer.zoom = Math.max(0.1, Math.min(this.renderer.zoom * zoomMultiplier, 50));
                this.renderer.cameraX = (this.timeAxisWorldX * this.renderer.zoom) - this.timeAxisAnchorX;
            }

            if (this.isDraggingChart || this.isDraggingPriceAxis || this.isDraggingTimeAxis) {
                this.lastMouseX = e.clientX;
                this.lastMouseY = e.clientY;
                this.isDirty = true; // Only redraw full chart when actively panning/zooming
            }
        });

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
            this.isDraggingChart = false;
            this.isDraggingPriceAxis = false;
            this.isDraggingTimeAxis = false;
            this.canvas.releasePointerCapture(e.pointerId);
        };
        this.canvas.addEventListener('pointerup', stopDragging);
        this.canvas.addEventListener('pointercancel', stopDragging);

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

                const chartWidth = this.renderer.app.screen.width - this.renderer.priceAxisWidth;
                const chartHeight = this.renderer.app.screen.height - this.renderer.timeAxisHeight;

                if (this.isMobileCrosshairActive) {
                    // Crosshair is already active. Snap it to new touch location immediately.
                    this.renderer.crosshairX = x;
                    this.renderer.crosshairY = y;
                    this.isCrosshairDirty = true;
                    this.isDraggingChart = false;
                    this.isDraggingPriceAxis = false;
                    this.isDraggingTimeAxis = false;
                } else {
                    // Detect Touch Hit Zones
                    if (x > chartWidth) {
                        this.isDraggingPriceAxis = true;
                        this.isDraggingChart = false;
                        this.isDraggingTimeAxis = false;
                    } else if (y > chartHeight) {
                        this.isDraggingTimeAxis = true;
                        this.isDraggingChart = false;
                        this.isDraggingPriceAxis = false;
                        this.timeAxisAnchorX = x;
                        this.timeAxisWorldX = (x + this.renderer.cameraX) / this.renderer.zoom;
                    } else {
                        this.isDraggingChart = true;
                        this.isDraggingPriceAxis = false;
                        this.isDraggingTimeAxis = false;

                        // Start Long-Press Timer (400ms) to activate mobile crosshair
                        this.longPressTimeout = setTimeout(() => {
                            this.isMobileCrosshairActive = true;
                            this.renderer.isCrosshairVisible = true;
                            this.renderer.crosshairX = this.touchStartX;
                            this.renderer.crosshairY = this.touchStartY;
                            this.isCrosshairDirty = true;
                            this.isDraggingChart = false; // Stop panning
                        }, 400);
                    }
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

        const endTouch = (e: TouchEvent) => {
            // Dismiss crosshair if the user does a quick tap anywhere while it's active
            if (this.activeTouches.size === 1 && this.isMobileCrosshairActive) {
                const t = e.changedTouches[0];
                const rect = this.canvas.getBoundingClientRect();
                const x = t.clientX - rect.left;
                const y = t.clientY - rect.top;
                const dist = Math.hypot(x - this.touchStartX, y - this.touchStartY);
                const duration = Date.now() - this.touchStartTime;

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
        this.isDirty = true;

        await this.network.connect(this.currentSymbol, this.currentInterval, () => {
            this.indicatorManager.update(this.dataStore); // Run Math Engine
            this.isDirty = true;
            if (this.isLockedToEdge) {
                const actualSpacing = this.renderer.candleSpacing * this.renderer.zoom;
                const maxScroll = (this.dataStore.length * actualSpacing) - this.canvas.clientWidth;
                this.renderer.cameraX = maxScroll + 150;
            }
        });
        this.jumpToLive();
        WorkspaceManager.triggerAutoSave();
    }

    public async switchSymbol(newSymbol: string) {
        this.currentSymbol = newSymbol;
        this.network.disconnect();
        this.dataStore.clear();
        this.isDirty = true;

        await this.network.connect(this.currentSymbol, this.currentInterval, () => {
            this.indicatorManager.update(this.dataStore); // Run Math Engine
            this.isDirty = true;
            if (this.isLockedToEdge) {
                const actualSpacing = this.renderer.candleSpacing * this.renderer.zoom;
                const maxScroll = (this.dataStore.length * actualSpacing) - this.canvas.clientWidth;
                this.renderer.cameraX = maxScroll + 150;
            }
       });
        this.jumpToLive();
        WorkspaceManager.triggerAutoSave();
    }

    public async startLiveBinance(symbol: string, interval: string) {
        this.currentSymbol = symbol;
        this.currentInterval = interval;
        await this.renderer.init(this.canvas);

        await this.network.connect(symbol, interval, () => {
            this.indicatorManager.update(this.dataStore); // Run Math Engine
            this.isDirty = true;
            if (this.isLockedToEdge) {
                const actualSpacing = this.renderer.candleSpacing * this.renderer.zoom;
                const maxScroll = (this.dataStore.length * actualSpacing) - this.canvas.clientWidth;
                this.renderer.cameraX = maxScroll + 150;
            }
        });

        this.renderer.currentInterval = this.currentInterval;
        const actualSpacing = this.renderer.candleSpacing * this.renderer.zoom;
        const initialMaxScroll = (this.dataStore.length * actualSpacing) - this.canvas.clientWidth;
        this.renderer.cameraX = initialMaxScroll + 150;

        setInterval(() => {
            if (this.isRunning) this.isDirty = true;
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

                    this.renderer.renderFrame();

                    // Render Indicators
                    this.renderer.indicatorMainGraphics.clear();
                    this.renderer.indicatorOscGraphics.clear();
                    this.indicatorManager.render(this.renderer, this.renderer.indicatorMainGraphics, this.renderer.indicatorOscGraphics);

                    this.drawingManager.render(this.renderer, this.renderer.drawingGraphics);

                    this.renderer.renderCrosshair();
                    this.isDirty = false;
                    this.isCrosshairDirty = false;
                } else if (this.isCrosshairDirty) {
                    this.renderer.renderCrosshair();
                    this.isCrosshairDirty = false;
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

    public static saveWorkspace() {
        if (this.charts.length === 0) return;
        const state: SavedWorkspaceState = {
            version: 1,
            layout: this.currentLayout,
            activePaneIndex: this.activeChart ? this.charts.indexOf(this.activeChart) : 0,
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

        // 1. Symbol Button Label
        const symLabel = document.getElementById('btn-symbol')?.querySelector('span');
        if (symLabel) symLabel.textContent = chart.currentSymbol;

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
        
        this.triggerAutoSave();
    }

    private static setupGlobalControls() {
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
                    themeManager.setThemeById(p.id);
                    syncModalInputs();
                };
                presetGrid.appendChild(card);
            });
        }

        const syncModalInputs = () => {
            const current = themeManager.getTheme();
            const setSwatch = (id: string, color: string) => {
                const el = document.getElementById(id);
                if (el) {
                    el.dataset.color = color;
                    el.style.backgroundColor = color;
                }
            };
            setSwatch('input-bull-body', current.bullBody);
            setSwatch('input-bear-body', current.bearBody);
            setSwatch('input-bull-wick', current.bullWick);
            setSwatch('input-bear-wick', current.bearWick);
            setSwatch('input-bull-border', current.bullBorder);
            setSwatch('input-bear-border', current.bearBorder);
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
        bindSwatch('input-bull-border', 'bullBorder', true);
        bindSwatch('input-bear-border', 'bearBorder', true);
        bindSwatch('input-custom-accent', 'accentColor', false);

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
            if (newFps > 0) WorkspaceManager.targetFPS = newFps;
        });

        // Workspace Reset
        const btnResetWorkspace = document.getElementById('btn-reset-workspace');
        btnResetWorkspace?.addEventListener('click', () => {
            if (confirm("Are you sure you want to reset your workspace? All custom layouts and indicators will be lost.")) {
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
                a.download = `ecochart_workspace_${new Date().toISOString().slice(0,10)}.json`;
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
                    if (isActive) {
                        this.activeChart!.indicatorManager.removeIndicator(activeInstance.id);
                    } else {
                        const newInd = cat.factory();
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
    }
}