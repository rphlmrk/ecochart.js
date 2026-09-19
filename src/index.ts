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
    private timeAxisAnchorX = 0; // Fixed screen X anchor
    private timeAxisWorldX = 0;  // Fixed world coordinate
    private lastMouseX = 0;
    private lastMouseY = 0;
    private isLockedToEdge = true;

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
            // Parse Hex to PixiJS numeric color (e.g., "#131722" -> 0x131722)
            this.renderer.bgColor = parseInt(inputBg.value.replace('#', '0x'), 16);
            this.renderer.gridColor = parseInt(inputGrid.value.replace('#', '0x'), 16);
            this.isDirty = true;
            modalSettings?.close();
        });
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