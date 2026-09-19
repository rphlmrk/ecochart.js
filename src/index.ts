import { DataStore } from './data/DataStore';
import { BinanceClient } from './network/BinanceClient';
import { ChartRenderer } from './renderer/ChartRenderer';

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

        this.setupInteractions();
    }

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

            // Change cursor based on hover zone (like TradingView)
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
                if (deltaY !== 0) {
                    this.renderer.cameraY += deltaY;
                    this.renderer.isAutoScale = false;
                    const btnAuto = document.getElementById('btn-auto-fit');
                    if (btnAuto) btnAuto.style.color = '#787B86';
                }
            } else if (this.isDraggingPriceAxis) {
                // Compress/Expand Price Scale
                this.renderer.isAutoScale = false;
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
            this.renderer.isAutoScale = true;
            this.renderer.cameraY = 0;
            this.isLockedToEdge = true;

            const actualSpacing = this.renderer.candleSpacing * this.renderer.zoom;
            const maxScroll = (this.dataStore.length * actualSpacing) - window.innerWidth;
            this.renderer.cameraX = maxScroll + 150;
            this.isDirty = true;
        });

        this.canvas.addEventListener('wheel', (e) => {
            e.preventDefault();
            const mouseX = e.clientX - this.canvas.getBoundingClientRect().left;
            const worldBaseX = (mouseX + this.renderer.cameraX) / this.renderer.zoom;

            const zoomFactor = Math.pow(1.05, -Math.sign(e.deltaY));
            this.renderer.zoom *= zoomFactor;
            this.renderer.zoom = Math.max(0.1, Math.min(this.renderer.zoom, 50));
            this.renderer.cameraX = (worldBaseX * this.renderer.zoom) - mouseX;

            this.isLockedToEdge = false;
            this.isDirty = true;
        }, { passive: false });

        // --- HTML UI BINDINGS ---
        const btnSettings = document.getElementById('btn-settings');
        const modalSettings = document.getElementById('settings-modal') as HTMLDialogElement;
        const btnCloseSettings = document.getElementById('btn-close-settings');
        const inputBg = document.getElementById('input-bg-color') as HTMLInputElement;
        const inputGrid = document.getElementById('input-grid-color') as HTMLInputElement;

        btnSettings?.addEventListener('click', () => modalSettings?.showModal());

        btnCloseSettings?.addEventListener('click', () => {
            this.renderer.bgColor = parseInt(inputBg.value.replace('#', '0x'), 16);
            this.renderer.gridColor = parseInt(inputGrid.value.replace('#', '0x'), 16);
            this.isDirty = true;
            modalSettings?.close();
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
                (btn as HTMLElement).style.background = '#2A2E39';
                (btn as HTMLElement).style.color = '#2962FF';

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
            btnCandles.style.background = '#2A2E39';
            btnCandles.style.color = '#2962FF';
            if (btnLine) {
                btnLine.style.background = 'transparent';
                btnLine.style.color = '#787B86';
            }
            this.isDirty = true;
        });

        btnLine?.addEventListener('click', () => {
            this.renderer.chartMode = 'line';
            btnLine.style.background = '#2A2E39';
            btnLine.style.color = '#2962FF';
            if (btnCandles) {
                btnCandles.style.background = 'transparent';
                btnCandles.style.color = '#787B86';
            }
            this.isDirty = true;
        });

        // 4. Auto-Fit Button
        const btnAuto = document.getElementById('btn-auto-fit');
        btnAuto?.addEventListener('click', () => {
            this.resetView();
        });
    }

    public resetView() {
        this.renderer.isAutoScale = true;
        this.renderer.cameraY = 0;
        this.isLockedToEdge = true;

        const actualSpacing = this.renderer.candleSpacing * this.renderer.zoom;
        const maxScroll = (this.dataStore.length * actualSpacing) - window.innerWidth;
        this.renderer.cameraX = maxScroll + 150;
        this.isDirty = true;

        const btnAuto = document.getElementById('btn-auto-fit');
        if (btnAuto) btnAuto.style.color = '#2962FF';
    }

    public async switchTimeframe(newInterval: string) {
        this.currentInterval = newInterval;
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
        this.resetView();
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
        this.resetView();
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

        // Initial Snap on load
        const actualSpacing = this.renderer.candleSpacing * this.renderer.zoom;
        const initialMaxScroll = (this.dataStore.length * actualSpacing) - window.innerWidth;
        this.renderer.cameraX = initialMaxScroll + 150;

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