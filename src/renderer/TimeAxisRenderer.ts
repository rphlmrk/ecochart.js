import type { ChartRenderer } from './ChartRenderer';

export class TimeAxisRenderer {
    private canvas: HTMLCanvasElement;
    private ctx: CanvasRenderingContext2D;
    private renderer: ChartRenderer;

    // Cache state for partial badge updates (0% CPU idle)
    private lastBadges: Array<{ x: number; y: number; w: number; h: number }> = [];
    private lastWidth = 0;
    private lastHeight = 24;

    constructor(canvas: HTMLCanvasElement, renderer: ChartRenderer) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d')!;
        this.renderer = renderer;
    }

    private hexToCSS(hex: number | string): string {
        if (typeof hex === 'string') return hex.startsWith('#') ? hex : '#' + hex;
        return '#' + (hex & 0xFFFFFF).toString(16).padStart(6, '0');
    }

    private getSessionStatus(tz: string, now: Date, isFlashTick: boolean) {
        const isDark = this.renderer.isDarkTheme;
        const defaultText = this.hexToCSS(this.renderer.axisTextColor);
        const defaultBorder = this.hexToCSS(this.renderer.gridColor);
        const defaultBg = this.hexToCSS(this.renderer.axisBgColor);
        const bullHex = this.hexToCSS(this.renderer.bullColor);
        const bearHex = this.hexToCSS(this.renderer.bearColor);

        try {
            const targetTz = tz === 'local' ? undefined : tz;
            const dayStr = new Intl.DateTimeFormat('en-US', { timeZone: targetTz, weekday: 'short' }).format(now);
            if (dayStr === 'Sat' || dayStr === 'Sun') {
                return { icon: '🌙', textColor: defaultText, borderColor: defaultBorder, borderWidth: 1, bgColor: defaultBg };
            }

            const parts = new Intl.DateTimeFormat('en-US', { timeZone: targetTz, hour: 'numeric', minute: 'numeric', hour12: false }).formatToParts(now);
            const hVal = parseInt(parts.find(p => p.type === 'hour')?.value || '0', 10);
            const mVal = parseInt(parts.find(p => p.type === 'minute')?.value || '0', 10);
            const t = (hVal % 24) + (mVal / 60);

            let isOpening = false, isClosing = false, isOpen = false;
            if (tz === 'America/New_York') {
                isOpening = (t >= 9.5 && t < 10.0); isClosing = (t >= 15.75 && t < 16.0); isOpen = (t >= 9.5 && t < 16.0);
            } else if (tz === 'Europe/London') {
                isOpening = (t >= 8.0 && t < 8.5); isClosing = (t >= 16.0 && t < 16.5); isOpen = (t >= 8.0 && t < 16.5);
            } else if (tz === 'Asia/Tokyo') {
                isOpening = (t >= 9.0 && t < 9.5) || (t >= 12.5 && t < 12.75); isClosing = (t >= 11.25 && t < 11.5) || (t >= 15.25 && t < 15.5); isOpen = (t >= 9.0 && t < 11.5) || (t >= 12.5 && t < 15.5);
            } else if (tz === 'Asia/Hong_Kong') {
                isOpening = (t >= 9.5 && t < 10.0) || (t >= 13.0 && t < 13.25); isClosing = (t >= 11.75 && t < 12.0) || (t >= 15.75 && t < 16.0); isOpen = (t >= 9.5 && t < 12.0) || (t >= 13.0 && t < 16.0);
            } else if (tz === 'Europe/Frankfurt') {
                isOpening = (t >= 9.0 && t < 9.5); isClosing = (t >= 17.0 && t < 17.5); isOpen = (t >= 9.0 && t < 17.5);
            } else {
                isOpening = (t >= 8.0 && t < 8.5); isClosing = (t >= 16.5 && t < 17.0); isOpen = (t >= 8.0 && t < 17.0);
            }

            if (isOpening) {
                // Static colors for Opening state (No background flashing)
                const openText = isDark ? '#FFD600' : '#B45309';
                const openBorder = isDark ? '#FFD600' : '#D97706';
                const openBg = isDark ? 'rgba(255, 214, 0, 0.18)' : 'rgba(217, 119, 6, 0.15)';

                // ONLY the icon flashes (alternates between Bell and Bolt)
                return {
                    icon: isFlashTick ? '🔔' : '⚡',
                    textColor: openText,
                    borderColor: openBorder,
                    borderWidth: 1.5,
                    bgColor: openBg
                };
            }
            if (isClosing) {
                return {
                    icon: '⚠️',
                    textColor: isDark ? '#FFAB91' : '#C2410C',
                    borderColor: isDark ? '#FF5722' : bearHex,
                    borderWidth: 1.5,
                    bgColor: isDark ? 'rgba(255, 87, 34, 0.12)' : 'rgba(194, 65, 12, 0.1)'
                };
            }
            if (isOpen) {
                return {
                    icon: '🟢',
                    textColor: isDark ? bullHex : '#047857',
                    borderColor: bullHex,
                    borderWidth: 1.5,
                    bgColor: isDark ? 'rgba(38, 166, 154, 0.12)' : 'rgba(4, 120, 87, 0.08)'
                };
            }
            return { icon: '🌙', textColor: defaultText, borderColor: defaultBorder, borderWidth: 1, bgColor: defaultBg };
        } catch {
            return { icon: '', textColor: defaultText, borderColor: defaultBorder, borderWidth: 1, bgColor: defaultBg };
        }
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

        // 1. Clear Background to allow GPU Session Shading to show through
        this.ctx.clearRect(0, 0, w, h);

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

        // 3. Pre-Calculate Clocks to Exclude Timestamps from the Clock Zone
        const clockConfig = (this.renderer as any).clockConfig;
        const len = this.renderer.dataStore.length;
        const lastCandleX = ((len - 1) * actualSpacing) - this.renderer.cameraX + actualSpacing;
        const availableSpace = w - lastCandleX;

        // Reset badge tracking
        this.lastBadges = [];
        this.lastWidth = w;
        this.lastHeight = h;

        let clockCutoffX = w + 20; // Default: show timestamps all the way to right edge
        const preparedBadges: Array<{ badgeX: number; badgeY: number; badgeW: number; badgeH: number; st: any; timeStr: string }> = [];

        if (clockConfig?.enabled && len > 0 && availableSpace >= 100) {
            const now = new Date();
            const isMobile = w < 600 || availableSpace < 220;
            const isFlashTick = now.getSeconds() % 2 === 0;

            const formatTime = (tz: string) => {
                try {
                    const opt: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false };
                    if (tz !== 'local') opt.timeZone = tz;
                    return new Intl.DateTimeFormat([], opt).format(now);
                } catch {
                    return '--:--:--';
                }
            };

            const badgeH = 18;
            const badgeY = Math.floor((h - badgeH) / 2);
            let rightAnchor = w - 8;

            const prepareBadge = (tz: string, label: string) => {
                const st = this.getSessionStatus(tz, now, isFlashTick);
                const timeStr = `${st.icon} ${label} ${formatTime(tz)}`;
                this.ctx.font = '10px sans-serif';
                const textW = this.ctx.measureText(timeStr).width;
                const badgeW = Math.ceil(textW) + 14;
                const badgeX = rightAnchor - badgeW;

                if (badgeX > lastCandleX + 8) {
                    preparedBadges.push({ badgeX, badgeY, badgeW, badgeH, st, timeStr });
                    rightAnchor = badgeX - 6;
                }
            };

            // Order: Primary (closest to right edge), then Secondary (further left)
            if (clockConfig.primaryTz) prepareBadge(clockConfig.primaryTz, clockConfig.primaryLabel || 'NYC');
            if (!isMobile && clockConfig.secondaryTz) prepareBadge(clockConfig.secondaryTz, clockConfig.secondaryLabel || 'LON');

            // Set the cutoff boundary right before the leftmost badge (with 12px margin)
            if (preparedBadges.length > 0) {
                const leftmostBadge = preparedBadges[preparedBadges.length - 1];
                clockCutoffX = leftmostBadge.badgeX - 12;
            }
        }

        // 4. Timestamps (Hides all timestamps from clockCutoffX to the right edge)
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

        for (let i = startIdx; i <= endBar; i += candleStep) {
            const x = Math.round((i * actualSpacing) - this.renderer.cameraX) + 0.5;

            // Stop immediately if timestamp falls into or past the clocks area
            if (x < -20 || x >= clockCutoffX) continue;

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

        // 5. Render Prepared Clocks
        for (const b of preparedBadges) {
            this.ctx.fillStyle = b.st.bgColor;
            this.ctx.strokeStyle = b.st.borderColor;
            this.ctx.lineWidth = b.st.borderWidth;

            this.ctx.beginPath();
            if (typeof this.ctx.roundRect === 'function') {
                this.ctx.roundRect(b.badgeX, b.badgeY, b.badgeW, b.badgeH, 4);
            } else {
                this.ctx.rect(b.badgeX, b.badgeY, b.badgeW, b.badgeH);
            }
            this.ctx.fill();
            this.ctx.stroke();

            this.ctx.fillStyle = b.st.textColor;
            this.ctx.textAlign = 'center';
            this.ctx.textBaseline = 'middle';
            this.ctx.fillText(b.timeStr, b.badgeX + b.badgeW / 2, (h / 2) + 1);

            this.lastBadges.push({ x: b.badgeX, y: b.badgeY, w: b.badgeW, h: b.badgeH });
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

    /**
     * Partial Update: Only updates the world clocks in the empty right space.
     * Skips redrawing all historical timestamps, tick marks, and axis borders.
     */
    public updateClocksOnly() {
        if (this.lastWidth === 0 || this.renderer.dataStore.length === 0) {
            this.render();
            return;
        }

        const clockConfig = (this.renderer as any).clockConfig;
        if (!clockConfig?.enabled) return;

        // Clear only the previous badge bounding boxes
        for (const b of this.lastBadges) {
            this.ctx.clearRect(b.x - 2, b.y - 1, b.w + 4, b.h + 2);
        }

        const actualSpacing = this.renderer.candleSpacing * this.renderer.zoom;
        const len = this.renderer.dataStore.length;
        const lastCandleX = ((len - 1) * actualSpacing) - this.renderer.cameraX + actualSpacing;
        const w = this.lastWidth;
        const h = this.lastHeight;
        const availableSpace = w - lastCandleX;

        if (availableSpace < 100) {
            this.lastBadges = [];
            return;
        }

        const now = new Date();
        const isMobile = w < 600 || availableSpace < 220;
        const isFlashTick = now.getSeconds() % 2 === 0;

        const formatTime = (tz: string) => {
            try {
                const opt: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false };
                if (tz !== 'local') opt.timeZone = tz;
                return new Intl.DateTimeFormat([], opt).format(now);
            } catch {
                return '--:--:--';
            }
        };

        const badgeH = 18;
        const badgeY = Math.floor((h - badgeH) / 2);
        let rightAnchor = w - 8;
        this.lastBadges = [];

        const drawBadge = (tz: string, label: string) => {
            const st = this.getSessionStatus(tz, now, isFlashTick);
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

                this.lastBadges.push({ x: badgeX, y: badgeY, w: badgeW, h: badgeH });
                rightAnchor = badgeX - 6;
            }
        };

        if (clockConfig.primaryTz) drawBadge(clockConfig.primaryTz, clockConfig.primaryLabel || 'NYC');
        if (!isMobile && clockConfig.secondaryTz) drawBadge(clockConfig.secondaryTz, clockConfig.secondaryLabel || 'LON');
    }
}