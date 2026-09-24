import type { ChartRenderer } from './ChartRenderer';

export class TimeAxisRenderer {
    private canvas: HTMLCanvasElement;
    private ctx: CanvasRenderingContext2D;
    private renderer: ChartRenderer;

    constructor(canvas: HTMLCanvasElement, renderer: ChartRenderer) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d')!;
        this.renderer = renderer;
    }

    private hexToCSS(hex: number | string): string {
        if (typeof hex === 'string') return hex.startsWith('#') ? hex : '#' + hex;
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

        // 2. Top Border Line
        this.ctx.strokeStyle = this.hexToCSS(this.renderer.gridColor);
        this.ctx.lineWidth = 1;
        this.ctx.beginPath();
        this.ctx.moveTo(0, 0.5);
        this.ctx.lineTo(w, 0.5);
        this.ctx.stroke();

        if (this.renderer.dataStore.length === 0) return;

        const actualSpacing = this.renderer.candleSpacing * this.renderer.zoom;
        if (actualSpacing <= 0) return;

        const minPixelsBetweenLabels = 100;
        let candleStep = Math.max(1, Math.ceil(minPixelsBetweenLabels / actualSpacing));

        if (candleStep > 1 && candleStep < 5) candleStep = 5;
        else if (candleStep > 5 && candleStep < 10) candleStep = 10;
        else if (candleStep > 10 && candleStep < 30) candleStep = 30;

        // Calculate visible bar range across entire screen width (floors properly for negative indices)
        const startBar = Math.floor(this.renderer.cameraX / actualSpacing);
        const endBar = Math.ceil((this.renderer.cameraX + w) / actualSpacing);
        const startIdx = Math.floor(startBar / candleStep) * candleStep;

        this.ctx.font = '11px sans-serif';
        this.ctx.textAlign = 'center';
        this.ctx.textBaseline = 'middle';
        this.ctx.fillStyle = this.hexToCSS(this.renderer.axisTextColor);
        this.ctx.strokeStyle = this.hexToCSS(this.renderer.gridColor);

        const isD = ['1d', '3d', '1w', '1M'].includes(this.renderer.currentInterval);
        const isSec = this.renderer.currentInterval.endsWith('s');

        // 3. Timestamps (Works seamlessly across history and future space)
        for (let i = startIdx; i <= endBar; i += candleStep) {
            const x = Math.round((i * actualSpacing) - this.renderer.cameraX) + 0.5;
            if (x < -20 || x > w + 20) continue;

            const ts = this.renderer.logicalIndexToTime(i);
            if (ts && ts > 0) {
                const date = new Date(ts);
                let timeStr = '';
                if (isD) {
                    timeStr = date.toLocaleDateString([], { month: 'short', day: 'numeric' });
                } else if (isSec) {
                    timeStr = `${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}:${date.getSeconds().toString().padStart(2, '0')}`;
                } else {
                    timeStr = `${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`;
                }

                this.ctx.beginPath();
                this.ctx.moveTo(x, 0);
                this.ctx.lineTo(x, 4);
                this.ctx.stroke();

                this.ctx.fillText(timeStr, x, (h / 2) + 1);
            }
        }

        // 3.5 World Timezone Clocks with Opening/Closing Animated Flash Alerts
        const clockConfig = (this.renderer as any).clockConfig;
        const len = this.renderer.dataStore.length;
        if (clockConfig?.enabled && len > 0) {
            const lastCandleX = ((len - 1) * actualSpacing) - this.renderer.cameraX + actualSpacing;
            const availableSpace = w - lastCandleX;

            if (availableSpace >= 100) {
                const now = new Date();
                const isMobile = w < 600 || availableSpace < 220;
                const isFlashTick = now.getSeconds() % 2 === 0; // Toggles every 1 second

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
                        const targetTz = tz === 'local' ? undefined : tz;
                        const dayStr = new Intl.DateTimeFormat('en-US', { timeZone: targetTz, weekday: 'short' }).format(now);
                        if (dayStr === 'Sat' || dayStr === 'Sun') {
                            return { icon: '🌙', textColor: this.hexToCSS(this.renderer.axisTextColor), borderColor: this.hexToCSS(this.renderer.gridColor), borderWidth: 1, bgColor: this.hexToCSS(this.renderer.axisBgColor) };
                        }

                        const parts = new Intl.DateTimeFormat('en-US', {
                            timeZone: targetTz,
                            hour: 'numeric',
                            minute: 'numeric',
                            hour12: false
                        }).formatToParts(now);

                        const hVal = parseInt(parts.find(p => p.type === 'hour')?.value || '0', 10);
                        const mVal = parseInt(parts.find(p => p.type === 'minute')?.value || '0', 10);
                        const t = (hVal % 24) + (mVal / 60);

                        let isOpening = false;
                        let isClosing = false;
                        let isOpen = false;

                        if (tz === 'America/New_York') {
                            // NYSE / NASDAQ: 09:30 - 16:00 ET
                            isOpening = (t >= 9.5 && t < 10.0);
                            isClosing = (t >= 15.75 && t < 16.0);
                            isOpen = (t >= 9.5 && t < 16.0);
                        } else if (tz === 'Europe/London') {
                            // LSE: 08:00 - 16:30 GMT/BST
                            isOpening = (t >= 8.0 && t < 8.5);
                            isClosing = (t >= 16.0 && t < 16.5);
                            isOpen = (t >= 8.0 && t < 16.5);
                        } else if (tz === 'Asia/Tokyo') {
                            // TSE: 09:00 - 11:30 & 12:30 - 15:30 JST
                            isOpening = (t >= 9.0 && t < 9.5) || (t >= 12.5 && t < 12.75);
                            isClosing = (t >= 11.25 && t < 11.5) || (t >= 15.25 && t < 15.5);
                            isOpen = (t >= 9.0 && t < 11.5) || (t >= 12.5 && t < 15.5);
                        } else if (tz === 'Asia/Hong_Kong') {
                            // HKEX: 09:30 - 12:00 & 13:00 - 16:00 HKT
                            isOpening = (t >= 9.5 && t < 10.0) || (t >= 13.0 && t < 13.25);
                            isClosing = (t >= 11.75 && t < 12.0) || (t >= 15.75 && t < 16.0);
                            isOpen = (t >= 9.5 && t < 12.0) || (t >= 13.0 && t < 16.0);
                        } else if (tz === 'Europe/Frankfurt') {
                            // XETRA: 09:00 - 17:30 CET/CEST
                            isOpening = (t >= 9.0 && t < 9.5);
                            isClosing = (t >= 17.0 && t < 17.5);
                            isOpen = (t >= 9.0 && t < 17.5);
                        } else {
                            // Generic market schedule
                            isOpening = (t >= 8.0 && t < 8.5);
                            isClosing = (t >= 16.5 && t < 17.0);
                            isOpen = (t >= 8.0 && t < 17.0);
                        }

                        // Opening State: Flashing Gold Alert
                        if (isOpening) {
                            return {
                                icon: isFlashTick ? '🔔' : '⚡',
                                textColor: isFlashTick ? '#FFD600' : '#FFF9C4',
                                borderColor: isFlashTick ? '#FFD600' : '#787B86',
                                borderWidth: isFlashTick ? 2 : 1,
                                bgColor: isFlashTick ? 'rgba(255, 214, 0, 0.15)' : this.hexToCSS(this.renderer.axisBgColor)
                            };
                        }

                        // Closing State: Flashing Orange/Red Alert
                        if (isClosing) {
                            return {
                                icon: isFlashTick ? '🔔' : '⚠️',
                                textColor: isFlashTick ? '#FF5722' : '#FFAB91',
                                borderColor: isFlashTick ? '#FF5722' : '#787B86',
                                borderWidth: isFlashTick ? 2 : 1,
                                bgColor: isFlashTick ? 'rgba(255, 87, 34, 0.15)' : this.hexToCSS(this.renderer.axisBgColor)
                            };
                        }

                        // Regular Open State: Solid Green
                        if (isOpen) {
                            return {
                                icon: '🟢',
                                textColor: '#26A69A',
                                borderColor: '#26A69A',
                                borderWidth: 1.5,
                                bgColor: this.hexToCSS(this.renderer.axisBgColor)
                            };
                        }

                        // Closed State: Muted Night
                        return {
                            icon: '🌙',
                            textColor: this.hexToCSS(this.renderer.axisTextColor),
                            borderColor: this.hexToCSS(this.renderer.gridColor),
                            borderWidth: 1,
                            bgColor: this.hexToCSS(this.renderer.axisBgColor)
                        };
                    } catch {
                        return { icon: '', textColor: this.hexToCSS(this.renderer.axisTextColor), borderColor: this.hexToCSS(this.renderer.gridColor), borderWidth: 1, bgColor: this.hexToCSS(this.renderer.axisBgColor) };
                    }
                };

                const badgeH = 18;
                const badgeY = Math.floor((h - badgeH) / 2);
                let rightAnchor = w - 8;

                const drawBadge = (tz: string, label: string) => {
                    const st = getSessionStatus(tz);
                    const timeStr = `${st.icon} ${label} ${formatTime(tz)}`;
                    this.ctx.font = '10px sans-serif';
                    const textW = this.ctx.measureText(timeStr).width;
                    const badgeW = Math.ceil(textW) + 14;
                    const badgeX = rightAnchor - badgeW;

                    if (badgeX > lastCandleX + 8) {
                        this.ctx.fillStyle = st.bgColor;
                        this.ctx.strokeStyle = st.borderColor;
                        this.ctx.lineWidth = st.borderWidth;

                        this.ctx.beginPath();
                        if (typeof this.ctx.roundRect === 'function') {
                            this.ctx.roundRect(badgeX, badgeY, badgeW, badgeH, 4);
                        } else {
                            this.ctx.rect(badgeX, badgeY, badgeW, badgeH);
                        }
                        this.ctx.fill();
                        this.ctx.stroke();

                        this.ctx.fillStyle = st.textColor;
                        this.ctx.textAlign = 'center';
                        this.ctx.textBaseline = 'middle';
                        this.ctx.fillText(timeStr, badgeX + badgeW / 2, (h / 2) + 1);

                        rightAnchor = badgeX - 6;
                    }
                };

                // Draw Primary Clock
                if (clockConfig.primaryTz) {
                    drawBadge(clockConfig.primaryTz, clockConfig.primaryLabel || 'NYC');
                }

                // Draw Secondary Clock (Desktop only)
                if (!isMobile && clockConfig.secondaryTz) {
                    drawBadge(clockConfig.secondaryTz, clockConfig.secondaryLabel || 'LON');
                }
            }
        }

        // 4. Crosshair Date Pill
        if (this.renderer.isCrosshairVisible && this.renderer.crosshairX >= 0 && this.renderer.crosshairX <= w) {
            const logicalIndex = Math.round((this.renderer.crosshairX + this.renderer.cameraX) / actualSpacing);
            const hoverTimeMs = this.renderer.logicalIndexToTime(logicalIndex);

            if (hoverTimeMs > 0) {
                const d = new Date(hoverTimeMs);
                const dateStr = `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;

                this.ctx.font = '11px sans-serif';
                const textW = this.ctx.measureText(dateStr).width + 16;
                const pillX = Math.max(0, Math.min(w - textW, this.renderer.crosshairX - textW / 2));

                this.ctx.fillStyle = '#363A45';
                this.ctx.fillRect(pillX, 0, textW, h);

                this.ctx.fillStyle = '#ffffff';
                this.ctx.fillText(dateStr, pillX + textW / 2, (h / 2) + 1);
            }
        }
    }
}