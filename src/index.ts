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
    private isDragging = false;
    private lastMouseX = 0;
    private lastMouseY = 0; // NEW: Track Y for vertical pan
    private isLockedToEdge = true; // NEW: Free tracking flag

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
        // 1. Panning (X and Y Axis)
        this.canvas.addEventListener('pointerdown', (e) => {
            this.isDragging = true;
            this.lastMouseX = e.clientX;
            this.lastMouseY = e.clientY;
            this.canvas.setPointerCapture(e.pointerId);
        });

        this.canvas.addEventListener('pointermove', (e) => {
            if (this.isDragging) {
                const deltaX = e.clientX - this.lastMouseX;
                const deltaY = e.clientY - this.lastMouseY;

                // Move Camera X
                if (deltaX !== 0) {
                    this.renderer.cameraX -= deltaX;
                    this.isLockedToEdge = false; // Break live tracking lock!
                }

                // Move Camera Y (Vertical Pan)
                if (deltaY !== 0) {
                    this.renderer.cameraY += deltaY;
                    this.renderer.isAutoScale = false; // Break auto-scale lock!
                }

                this.lastMouseX = e.clientX;
                this.lastMouseY = e.clientY;
                this.isDirty = true;
            }
        });

        const stopDragging = (e: PointerEvent) => {
            this.isDragging = false;
            this.canvas.releasePointerCapture(e.pointerId);
        };

        this.canvas.addEventListener('pointerup', stopDragging);
        this.canvas.addEventListener('pointercancel', stopDragging);

        // 2. Double-Click to Reset Auto-Scale & Live Lock
        this.canvas.addEventListener('dblclick', () => {
            this.renderer.isAutoScale = true;
            this.renderer.cameraY = 0;
            this.isLockedToEdge = true; // Snap back to live

            // Instantly snap camera to newest candle
            const actualSpacing = this.renderer.candleSpacing * this.renderer.zoom;
            const maxScroll = (this.dataStore.length * actualSpacing) - window.innerWidth;
            this.renderer.cameraX = maxScroll + 150;

            this.isDirty = true;
        });

        // 3. Zooming (Scroll Wheel)
        this.canvas.addEventListener('wheel', (e) => {
            e.preventDefault();

            const mouseX = e.clientX - this.canvas.getBoundingClientRect().left;
            const worldBaseX = (mouseX + this.renderer.cameraX) / this.renderer.zoom;

            const zoomFactor = Math.pow(1.05, -Math.sign(e.deltaY));
            this.renderer.zoom *= zoomFactor;
            this.renderer.zoom = Math.max(0.1, Math.min(this.renderer.zoom, 50));
            this.renderer.cameraX = (worldBaseX * this.renderer.zoom) - mouseX;

            // Optional: Break live tracking if zooming
            this.isLockedToEdge = false;

            this.isDirty = true;
        }, { passive: false });
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