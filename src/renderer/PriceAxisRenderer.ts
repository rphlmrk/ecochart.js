import type { ChartRenderer } from './ChartRenderer';

export class PriceAxisRenderer {
    private canvas: HTMLCanvasElement;
    private ctx: CanvasRenderingContext2D;
    private renderer: ChartRenderer;

    constructor(canvas: HTMLCanvasElement, renderer: ChartRenderer) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d')!;
        this.renderer = renderer;
    }

    private hexToCSS(hex: number): string {
        return '#' + (hex & 0xFFFFFF).toString(16).padStart(6, '0');
    }

    public render() {
        if (!this.renderer.app || !this.renderer.app.renderer) return;

        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const rect = this.canvas.getBoundingClientRect();
        const w = rect.width;
        const h = rect.height;

        if (w === 0 || h === 0) return;

        if (this.canvas.width !== Math.floor(w * dpr) || this.canvas.height !== Math.floor(h * dpr)) {
            this.canvas.width = Math.floor(w * dpr);
            this.canvas.height = Math.floor(h * dpr);
        }

        this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

        // 1. Background Fill
        this.ctx.fillStyle = this.hexToCSS(this.renderer.axisBgColor);
        this.ctx.fillRect(0, 0, w, h);

        // 2. Left Border Line
        this.ctx.strokeStyle = this.hexToCSS(this.renderer.gridColor);
        this.ctx.lineWidth = 1;
        this.ctx.beginPath();
        this.ctx.moveTo(0.5, 0);
        this.ctx.lineTo(0.5, h);
        this.ctx.stroke();

        const oscHeight = this.renderer.oscHeight;
        const mainChartHeight = h - oscHeight;

        // 3. Price Scale Ticks & Numbers
        const range = this.renderer.currentMaxPrice - this.renderer.currentMinPrice || 1;
        let step = range / 8;
        const mag = Math.pow(10, Math.floor(Math.log10(step)));
        const norm = step / mag;
        if (norm < 1.5) step = 1 * mag;
        else if (norm < 3.5) step = 2.5 * mag;
        else if (norm < 7.5) step = 5 * mag;
        else step = 10 * mag;

        const visibleMax = this.renderer.yToPrice(0);
        const visibleMin = this.renderer.yToPrice(mainChartHeight);
        const firstPrice = Math.ceil(Math.min(visibleMin, visibleMax) / step) * step;

        this.ctx.font = '11px sans-serif';
        this.ctx.textAlign = 'center'; // Center text horizontally
        this.ctx.textBaseline = 'middle';
        this.ctx.fillStyle = this.hexToCSS(this.renderer.axisTextColor);
        this.ctx.strokeStyle = this.hexToCSS(this.renderer.gridColor);

        for (let p = firstPrice; p <= Math.max(visibleMin, visibleMax); p += step) {
            const y = Math.round(this.renderer.priceToY(p)) + 0.5;
            if (y < 0 || y > mainChartHeight) continue;

            this.ctx.beginPath();
            this.ctx.moveTo(0, y);
            this.ctx.lineTo(4, y);
            this.ctx.stroke();

            this.ctx.fillText(p.toFixed(2), w / 2, y);
        }

        // 4. Oscillator Scale (Sub-panel ticks)
        if (oscHeight > 0) {
            this.ctx.beginPath();
            this.ctx.moveTo(0, mainChartHeight + 0.5);
            this.ctx.lineTo(w, mainChartHeight + 0.5);
            this.ctx.stroke();

            if (this.renderer.activeOscillatorScale?.steps) {
                const { min, max, steps } = this.renderer.activeOscillatorScale;
                const oscRange = max - min || 1;

                for (const st of steps) {
                    const normVal = (st - min) / oscRange;
                    const y = Math.round(h - (normVal * oscHeight)) + 0.5;

                    this.ctx.beginPath();
                    this.ctx.moveTo(0, y);
                    this.ctx.lineTo(4, y);
                    this.ctx.stroke();

                    const lbl = this.renderer.activeOscillatorScale.format
                        ? this.renderer.activeOscillatorScale.format(st)
                        : (st > 0 ? `+${st}` : `${st}`);
                    this.ctx.fillText(lbl, w / 2, y);
                }
            }
        }

        // 5. Live Price Pill (Centered)
        const len = this.renderer.dataStore.length;
        if (len > 0) {
            const lastBase = (len - 1) * 6;
            const lastOpen = this.renderer.dataStore.data[lastBase + 1];
            const lastClose = this.renderer.dataStore.data[lastBase + 4];
            const lastTime = this.renderer.dataStore.data[lastBase];
            const liveY = this.renderer.priceToY(lastClose);

            if (liveY >= 0 && liveY <= mainChartHeight) {
                const isBull = lastClose >= lastOpen;
                const liveColor = isBull ? this.renderer.bullColor : this.renderer.bearColor;
                const badgeH = 34;
                const badgeY = Math.max(0, Math.min(mainChartHeight - badgeH, liveY - 17));

                this.ctx.fillStyle = this.hexToCSS(liveColor);
                this.ctx.fillRect(0, badgeY, w, badgeH);

                this.ctx.fillStyle = '#ffffff';
                this.ctx.font = 'bold 11px sans-serif';
                this.ctx.fillText(lastClose.toFixed(2), w / 2, badgeY + 11);

                const intervalMs = this.renderer.parseIntervalMs(this.renderer.currentInterval);
                const remainingMs = Math.max(0, (lastTime + intervalMs) - Date.now());
                const totalSecs = Math.floor(remainingMs / 1000);
                const hours = Math.floor(totalSecs / 3600);
                const mins = Math.floor((totalSecs % 3600) / 60);
                const secs = totalSecs % 60;
                let countdownStr = `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
                if (hours > 0) countdownStr = `${hours}:${countdownStr}`;

                this.ctx.font = '10px sans-serif';
                this.ctx.fillText(countdownStr, w / 2, badgeY + 24);
            }
        }

        // 6. Crosshair Price Pill (Centered)
        if (this.renderer.isCrosshairVisible && this.renderer.crosshairY >= 0 && this.renderer.crosshairY <= h) {
            const cy = this.renderer.crosshairY;
            let text = '';
            if (cy <= mainChartHeight) {
                text = this.renderer.yToPrice(cy).toFixed(2);
            } else if (this.renderer.activeOscillatorScale) {
                const localY = cy - mainChartHeight;
                const normVal = (oscHeight - localY) / oscHeight;
                const { min, max } = this.renderer.activeOscillatorScale;
                const val = min + normVal * (max - min);
                text = (val > 0 ? '+' : '') + val.toFixed(1);
            }

            if (text) {
                const pillH = 18;
                const pillY = Math.max(0, Math.min(h - pillH, cy - 9));
                this.ctx.fillStyle = '#363A45';
                this.ctx.fillRect(0, pillY, w, pillH);

                this.ctx.fillStyle = '#ffffff';
                this.ctx.font = '11px sans-serif';
                this.ctx.fillText(text, w / 2, pillY + 10);
            }
        }
    }
}