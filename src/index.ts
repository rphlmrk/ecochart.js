import { DataStore } from './data/DataStore';
import { BinanceClient } from './network/BinanceClient';
import { ChartRenderer } from './renderer/ChartRenderer';
import { themeManager } from './theme/ThemeManager';
import { THEME_PRESETS } from './theme/presets';
import { colorPicker } from './ui/ColorPicker';
import type { ChartTheme, LineStyle, AccentSource } from './theme/types';

export class EcoChart {
    private dataStore: DataStore;
    public renderer: ChartRenderer;
    private network: BinanceClient;
    private isDirty = true;
    private canvas: HTMLCanvasElement;

    // Interaction State
    private isDraggingChart = false;
    private isDraggingPriceAxis = false;
    private isDraggingTimeAxis = false;
    private timeAxisAnchorX = 0;
    private timeAxisWorldX = 0;
    private lastMouseX = 0;
    private lastMouseY = 0;
    private isLockedToEdge = true;

    // Active Symbol & Timeframe State
    public currentSymbol = 'BTCUSDT';
    public currentInterval = '1m';

    constructor(containerId: string) {
        const container = document.getElementById(containerId);
        if (!container) throw new Error("Container not found");

        container.innerHTML = "";

        this.canvas = document.createElement('canvas');
        this.canvas.style.width = '100%';
        this.canvas.style.height = '100%';
        this.canvas.style.display = 'block';
        this.canvas.style.touchAction = 'none';
        container.appendChild(this.canvas);

        this.dataStore = new DataStore();
        this.renderer = new ChartRenderer(this.dataStore);
        this.network = new BinanceClient(this.dataStore);

        // Reactive theme listener: updates renderer, canvas, and active top-bar UI buttons
        themeManager.subscribe((theme) => {
            this.renderer.applyTheme(theme);
            const accent = themeManager.getResolvedAccentColor();

            // 1. Update Auto Button & Reset Icon with active accent
            const btnAuto = document.getElementById('btn-auto-fit');
            if (btnAuto) {
                btnAuto.style.color = this.renderer.isAutoScale ? accent : 'var(--chart-text, #787B86)';
            }
            const btnReset = document.getElementById('btn-nav-reset');
            if (btnReset) {
                btnReset.style.color = accent;
            }

            // 2. Update Active Timeframe Button
            const activeTfBtn = document.querySelector(`.tf-btn[data-tf="${this.currentInterval}"]`) as HTMLElement;
            if (activeTfBtn) {
                activeTfBtn.style.color = accent;
            }

            // 3. Update Active Chart Mode Button
            const activeModeBtn = document.getElementById(this.renderer.chartMode === 'candles' ? 'btn-mode-candles' : 'btn-mode-line');
            if (activeModeBtn) {
                activeModeBtn.style.color = accent;
            }

            this.isDirty = true;
        });

        this.setupInteractions();
    }

    public themeManager = themeManager;

    private setupInteractions() {
        // --- AXIS DETECTION & PANNING ---
        this.canvas.addEventListener('pointerdown', (e) => {
            const rect = this.canvas.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const y = e.clientY - rect.top;

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
            const rect = this.canvas.getBoundingClientRect();
            this.renderer.crosshairX = e.clientX - rect.left;
            this.renderer.crosshairY = e.clientY - rect.top;
            this.renderer.isCrosshairVisible = true;

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
                // Only pan vertically on the chart body if auto-scale was manually turned off
                if (!this.renderer.isAutoScale && deltaY !== 0) {
                    this.renderer.cameraY += deltaY;
                }
            } else if (this.isDraggingPriceAxis) {
                // Dragging the price scale explicitly breaks auto-scale
                this.renderer.isAutoScale = false;
                const btnAuto = document.getElementById('btn-auto-fit');
                if (btnAuto) btnAuto.style.color = 'var(--chart-text, #787B86)';

                const priceRange = this.renderer.currentMaxPrice - this.renderer.currentMinPrice;
                const stretchFactor = deltaY * (priceRange / chartHeight) * 2;

                this.renderer.currentMaxPrice += stretchFactor;
                this.renderer.currentMinPrice -= stretchFactor;
            } else if (this.isDraggingTimeAxis) {
                // Smooth, proportional zoom anchored to the grab point
                const zoomMultiplier = 1 + (deltaX * 0.005);
                this.renderer.zoom = Math.max(0.1, Math.min(this.renderer.zoom * zoomMultiplier, 50));

                // Recalculate cameraX so the candle under your click never moves on screen
                this.renderer.cameraX = (this.timeAxisWorldX * this.renderer.zoom) - this.timeAxisAnchorX;
            }

            if (this.isDraggingChart || this.isDraggingPriceAxis || this.isDraggingTimeAxis) {
                this.lastMouseX = e.clientX;
                this.lastMouseY = e.clientY;
            }

            this.isDirty = true;
        });

        this.canvas.addEventListener('pointerleave', () => {
            this.renderer.isCrosshairVisible = false;
            this.isDirty = true;
        });

        const stopDragging = (e: PointerEvent) => {
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

            const zoomFactor = Math.pow(1.05, -Math.sign(e.deltaY));

            // 1. X-Axis Time Zoom (Always happens)
            const worldBaseX = (mouseX + this.renderer.cameraX) / this.renderer.zoom;
            this.renderer.zoom *= zoomFactor;
            this.renderer.zoom = Math.max(0.1, Math.min(this.renderer.zoom, 50));
            this.renderer.cameraX = (worldBaseX * this.renderer.zoom) - mouseX;

            // 2. Y-Axis Price Zoom (Only happens in Manual Mode)
            if (!this.renderer.isAutoScale) {
                const chartHeight = this.renderer.app.screen.height - this.renderer.timeAxisHeight;
                
                // Find the exact price under the mouse cursor right now
                const currentRange = this.renderer.currentMaxPrice - this.renderer.currentMinPrice;
                const localY = mouseY - this.renderer.cameraY;
                const normY = (chartHeight - localY) / chartHeight;
                const priceAtMouse = this.renderer.currentMinPrice + (normY * currentRange);

                // Shrink/Expand the price scale
                const newRange = currentRange / zoomFactor;

                // Adjust min and max so the price under the mouse doesn't move
                this.renderer.currentMinPrice = priceAtMouse - (normY * newRange);
                this.renderer.currentMaxPrice = priceAtMouse + ((1 - normY) * newRange);
            }

            this.isLockedToEdge = false;
            this.isDirty = true;
        }, { passive: false });

        // --- HTML UI BINDINGS & SETTINGS MODAL ---
        const btnSettings = document.getElementById('btn-settings');
        const modalSettings = document.getElementById('settings-modal') as HTMLDialogElement;
        const btnCloseSettings = document.getElementById('btn-close-settings');
        const btnModalCloseX = document.getElementById('btn-modal-close-x');

        // Modal Tab Switching
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

        // Populate Preset Theme Cards in Settings
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

        // Synchronize Swatches & Inputs with the current theme
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
            if (selCrosshair) selCrosshair.value = this.renderer.crosshairStyle;
            if (selPrice) selPrice.value = this.renderer.livePriceStyle;
        };

        btnSettings?.addEventListener('click', () => {
            syncModalInputs();
            modalSettings?.showModal();
        });

        // Helper to bind contextual color picker to any swatch trigger button
        const bindSwatch = (btnId: string, themeKey: keyof ChartTheme, showOpacity = true) => {
            const btn = document.getElementById(btnId);
            if (!btn) return;

            btn.addEventListener('click', () => {
                const currentColor = btn.dataset.color || '#26A69A';
                colorPicker.open({
                    anchorElement: btn,
                    initialColor: currentColor,
                    showOpacity: showOpacity,
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

        // Bind all Settings Swatches
        bindSwatch('input-bg-color', 'background', false);
        bindSwatch('input-grid-color', 'gridLines', true);
        bindSwatch('input-bull-body', 'bullBody', true);
        bindSwatch('input-bear-body', 'bearBody', true);
        bindSwatch('input-bull-wick', 'bullWick', true);
        bindSwatch('input-bear-wick', 'bearWick', true);
        bindSwatch('input-bull-border', 'bullBorder', true);
        bindSwatch('input-bear-border', 'bearBorder', true);
        bindSwatch('input-custom-accent', 'accentColor', false);

        // Line Style Selectors
        const selectCrosshair = document.getElementById('select-crosshair-style') as HTMLSelectElement;
        selectCrosshair?.addEventListener('change', (e) => {
            const style = (e.target as HTMLSelectElement).value as LineStyle;
            this.renderer.crosshairStyle = style;
            themeManager.updateColor('crosshairLineStyle', style as any);
            this.isDirty = true;
        });

        const selectLivePrice = document.getElementById('select-live-price-style') as HTMLSelectElement;
        selectLivePrice?.addEventListener('change', (e) => {
            const style = (e.target as HTMLSelectElement).value as LineStyle;
            this.renderer.livePriceStyle = style;
            themeManager.updateColor('livePriceLineStyle', style as any);
            this.isDirty = true;
        });

        // Accent Source Radio Group
        document.querySelectorAll('input[name="accent-source"]').forEach((radio) => {
            radio.addEventListener('change', (e) => {
                const src = (e.target as HTMLInputElement).value as AccentSource;
                themeManager.setAccentSource(src);
            });
        });

        const closeModal = () => {
            const checkNav = document.getElementById('check-show-nav') as HTMLInputElement;
            const navBar = document.getElementById('nav-bar');
            if (navBar && checkNav) {
                navBar.style.display = checkNav.checked ? 'flex' : 'none';
            }
            colorPicker.close();
            modalSettings?.close();
        };

        btnCloseSettings?.addEventListener('click', closeModal);
        btnModalCloseX?.addEventListener('click', closeModal);

        // --- BOTTOM NAVIGATION BAR CONTROLS ---
        const zoomAtScreenCenter = (factor: number) => {
            const chartWidth = this.renderer.app.screen.width - this.renderer.priceAxisWidth;
            const centerX = chartWidth / 2;
            const worldBaseX = (centerX + this.renderer.cameraX) / this.renderer.zoom;

            this.renderer.zoom = Math.max(0.1, Math.min(this.renderer.zoom * factor, 50));
            this.renderer.cameraX = (worldBaseX * this.renderer.zoom) - centerX;
            this.isLockedToEdge = false;
            this.isDirty = true;
        };

        document.getElementById('btn-nav-zoom-in')?.addEventListener('click', () => zoomAtScreenCenter(1.25));
        document.getElementById('btn-nav-zoom-out')?.addEventListener('click', () => zoomAtScreenCenter(0.8));

        document.getElementById('btn-nav-scroll-left')?.addEventListener('click', () => {
            this.renderer.cameraX -= 250;
            this.isLockedToEdge = false;
            this.isDirty = true;
        });

        document.getElementById('btn-nav-scroll-right')?.addEventListener('click', () => {
            this.renderer.cameraX += 250;
            this.isDirty = true;
        });

        document.getElementById('btn-nav-reset')?.addEventListener('click', () => {
            this.jumpToLive();
        });

        // 1. Timeframe Switchers
        const tfButtons = document.querySelectorAll('.tf-btn');
        tfButtons.forEach((btn) => {
            btn.addEventListener('click', () => {
                const tf = (btn as HTMLElement).dataset.tf;
                if (!tf || tf === this.currentInterval) return;

                tfButtons.forEach((b) => {
                    (b as HTMLElement).style.background = 'transparent';
                    (b as HTMLElement).style.color = '#787B86';
                });
                (btn as HTMLElement).style.background = 'var(--chart-grid)';
                (btn as HTMLElement).style.color = themeManager.getResolvedAccentColor();

                this.switchTimeframe(tf);
            });
        });

        // 2. Symbol Switcher (Quick Prompt)
        const btnSymbol = document.getElementById('btn-symbol');
        btnSymbol?.addEventListener('click', () => {
            const sym = prompt('Enter Binance Symbol:', this.currentSymbol);
            if (sym && sym.toUpperCase() !== this.currentSymbol) {
                this.switchSymbol(sym.toUpperCase());
                const symLabel = btnSymbol.querySelector('span');
                if (symLabel) symLabel.textContent = this.currentSymbol;
            }
        });

        // 3. Chart Mode Toggle (Candles vs Line)
        const btnCandles = document.getElementById('btn-mode-candles');
        const btnLine = document.getElementById('btn-mode-line');

        btnCandles?.addEventListener('click', () => {
            this.renderer.chartMode = 'candles';
            btnCandles.style.background = 'var(--chart-grid)';
            btnCandles.style.color = themeManager.getResolvedAccentColor();
            if (btnLine) {
                btnLine.style.background = 'transparent';
                btnLine.style.color = '#787B86';
            }
            this.isDirty = true;
        });

        btnLine?.addEventListener('click', () => {
            this.renderer.chartMode = 'line';
            btnLine.style.background = 'var(--chart-grid)';
            btnLine.style.color = themeManager.getResolvedAccentColor();
            if (btnCandles) {
                btnCandles.style.background = 'transparent';
                btnCandles.style.color = '#787B86';
            }
            this.isDirty = true;
        });

        // 4. Auto-Fit Button: Toggles vertical scaling without moving cameraX
        const btnAuto = document.getElementById('btn-auto-fit');
        btnAuto?.addEventListener('click', () => {
            this.toggleAutoScale();
        });
    }

    public toggleAutoScale(forceState?: boolean) {
        this.renderer.isAutoScale = forceState !== undefined ? forceState : !this.renderer.isAutoScale;
        if (this.renderer.isAutoScale) {
            this.renderer.cameraY = 0;
        }
        this.isDirty = true;

        const btnAuto = document.getElementById('btn-auto-fit');
        if (btnAuto) {
            btnAuto.style.color = this.renderer.isAutoScale ? themeManager.getResolvedAccentColor() : 'var(--chart-text, #787B86)';
        }
    }

    public jumpToLive() {
        this.renderer.isAutoScale = true;
        this.renderer.cameraY = 0;
        this.isLockedToEdge = true;

        const actualSpacing = this.renderer.candleSpacing * this.renderer.zoom;
        const maxScroll = (this.dataStore.length * actualSpacing) - window.innerWidth;
        this.renderer.cameraX = maxScroll + 150;
        this.isDirty = true;

        const btnAuto = document.getElementById('btn-auto-fit');
        if (btnAuto) btnAuto.style.color = themeManager.getResolvedAccentColor();
    }

    public async switchTimeframe(newInterval: string) {
        this.currentInterval = newInterval;
        this.renderer.currentInterval = newInterval;
        this.network.disconnect();
        this.dataStore.clear();
        this.isDirty = true;

        await this.network.connect(this.currentSymbol, this.currentInterval, () => {
            this.isDirty = true;
            if (this.isLockedToEdge) {
                const actualSpacing = this.renderer.candleSpacing * this.renderer.zoom;
                const maxScroll = (this.dataStore.length * actualSpacing) - window.innerWidth;
                this.renderer.cameraX = maxScroll + 150;
            }
        });
        this.jumpToLive();
    }

    public async switchSymbol(newSymbol: string) {
        this.currentSymbol = newSymbol;
        this.network.disconnect();
        this.dataStore.clear();
        this.isDirty = true;

        await this.network.connect(this.currentSymbol, this.currentInterval, () => {
            this.isDirty = true;
            if (this.isLockedToEdge) {
                const actualSpacing = this.renderer.candleSpacing * this.renderer.zoom;
                const maxScroll = (this.dataStore.length * actualSpacing) - window.innerWidth;
                this.renderer.cameraX = maxScroll + 150;
            }
        });
        this.jumpToLive();
    }

    public async startLiveBinance(symbol: string, interval: string) {
        await this.renderer.init(this.canvas);

        await this.network.connect(symbol, interval, () => {
            this.isDirty = true;

            // Only force camera forward if we haven't broken the lock
            if (this.isLockedToEdge) {
                const actualSpacing = this.renderer.candleSpacing * this.renderer.zoom;
                const maxScroll = (this.dataStore.length * actualSpacing) - window.innerWidth;
                this.renderer.cameraX = maxScroll + 150;
            }
        });

        // Sync timeframe to renderer
        this.renderer.currentInterval = this.currentInterval;

        // Initial Snap on load
        const actualSpacing = this.renderer.candleSpacing * this.renderer.zoom;
        const initialMaxScroll = (this.dataStore.length * actualSpacing) - window.innerWidth;
        this.renderer.cameraX = initialMaxScroll + 150;

        // 1-Second heartbeat to update candle countdown timer smoothly
        setInterval(() => {
            this.isDirty = true;
        }, 1000);

        const loop = () => {
            if (this.isDirty) {
                this.renderer.renderFrame();
                this.isDirty = false;
            }
            requestAnimationFrame(loop);
        };
        requestAnimationFrame(loop);
    }
}