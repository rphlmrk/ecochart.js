import { BaseIndicator, parseColor, parseColorAndAlpha, type IndicatorLayout } from '../Indicator';
import type { DataStore } from '../../data/DataStore';
import type { ChartRenderer } from '../../renderer/ChartRenderer';
import { Graphics } from 'pixi.js';
import { alertManager } from '../../alerts/AlertManager';

export type CrossMarkerShape = 'triangle_up' | 'triangle_down' | 'circle' | 'circle_ring' | 'arrow_up' | 'arrow_down' | 'star' | 'cross' | 'diamond';

export class EmaSmaCrossIndicator extends BaseIndicator {
    public emaValues: Float64Array = new Float64Array(20000);
    public smaValues: Float64Array = new Float64Array(20000);
    // +1 = Bullish Golden Cross (EMA crosses above SMA), -1 = Bearish Death Cross (EMA crosses below SMA), 0 = None
    public crossSignals: Int8Array = new Int8Array(20000);
    public crossPrices: Float64Array = new Float64Array(20000);

    // --- START NEW: Historical Shelf Registry ---
    public crossRegistry: Array<{
        price: number; timeMs: number; direction: number;
        maxRunAtr: number; isMature: boolean; broken: boolean;
        startIndex: number;
    }> = [];
    private rollingAtr = 0;
    // --- END NEW ---

    // Alert Deduplication State
    private lastAlertedTime = -1;
    private lastAlertedDirection = 0;
    public currentSymbol = 'BTCUSDT';

    constructor(emaLength = 10, smaLength = 30) {
        super(`EMA_${emaLength}_SMA_${smaLength}_CROSS`, `EMA (${emaLength}) / SMA (${smaLength}) Cross`, false);

        this.params = [
            { id: 'emaLength', name: 'Fast EMA Length', type: 'number', value: emaLength, min: 1, max: 500, step: 1 },
            { id: 'emaColor', name: 'Fast EMA Color', type: 'color', value: '#00E5FF' },
            { id: 'emaWidth', name: 'Fast EMA Width', type: 'number', value: 2, min: 1, max: 5, step: 1 },
            { id: 'smaLength', name: 'Slow SMA Length', type: 'number', value: smaLength, min: 1, max: 500, step: 1 },
            { id: 'smaColor', name: 'Slow SMA Color', type: 'color', value: '#FF9800' },
            { id: 'smaWidth', name: 'Slow SMA Width', type: 'number', value: 2, min: 1, max: 5, step: 1 },
            { id: 'showLines', name: 'Show Moving Average Lines', type: 'boolean', value: true },
            { id: 'showCrossSignals', name: 'Show Cross Markers', type: 'boolean', value: true },
            // --- START NEW ---
            { id: 'showHistoricalShelves', name: 'Show Mature Historical Shelves', type: 'boolean', value: true },
            // --- END NEW ---
            {
                id: 'shapeMode',
                name: 'Marker Style',
                type: 'select',
                value: 'distinct_symbols',
                options: [
                    'distinct_symbols', // Bull ▲ / Bear ▼ (Different Symbols)
                    'circle',           // Circle (●) for both Bull & Bear
                    'circle_ring',      // Circle Ring (○) for both
                    'arrows',           // Bull ⬆ / Bear ⬇ (Arrows)
                    'star_cross',       // Bull ★ / Bear ✖ (Star & X)
                    'diamonds',         // Diamonds (◆) for both
                    'custom'            // Custom Bull & Bear selection
                ]
            },
            {
                id: 'bullShape',
                name: 'Bull Symbol (Custom)',
                type: 'select',
                value: 'Triangle Up (▲)',
                options: ['Triangle Up (▲)', 'Circle (●)', 'Circle Ring (○)', 'Arrow Up (⬆)', 'Star (★)', 'Diamond (◆)']
            },
            {
                id: 'bearShape',
                name: 'Bear Symbol (Custom)',
                type: 'select',
                value: 'Triangle Down (▼)',
                options: ['Triangle Down (▼)', 'Circle (●)', 'Circle Ring (○)', 'Arrow Down (⬇)', 'Cross (✖)', 'Star (★)', 'Diamond (◆)']
            },
            {
                id: 'markerPosition',
                name: 'Marker Position',
                type: 'select',
                value: 'Above / Below Bar',
                options: ['Above / Below Bar', 'On Cross Price', 'Both']
            },
            { id: 'markerSize', name: 'Marker Size', type: 'number', value: 8, min: 4, max: 24, step: 1 },
            { id: 'bullColor', name: 'Bull Cross Color', type: 'color', value: '#00E676' },
            { id: 'bearColor', name: 'Bear Cross Color', type: 'color', value: '#EF5350' },
            { id: 'notificationsEnabled', name: 'Enable Cross Notifications', type: 'boolean', value: true },
            { id: 'notifyBull', name: 'Notify Bull Cross (Golden Cross)', type: 'boolean', value: true },
            { id: 'notifyBear', name: 'Notify Bear Cross (Death Cross)', type: 'boolean', value: true },
            { id: 'triggerOnClose', name: 'Trigger on Candle Close Only', type: 'boolean', value: true },
            { id: 'notificationSound', name: 'Notification Alarm Sound', type: 'boolean', value: true }
        ];
    }

    protected override onParamsUpdated(): void {
        const emaLen = Math.max(1, this.getParam<number>('emaLength', 10));
        const smaLen = Math.max(1, this.getParam<number>('smaLength', 30));
        this.id = `EMA_${emaLen}_SMA_${smaLen}_CROSS`;
        this.name = `EMA (${emaLen}) / SMA (${smaLen}) Cross`;
        this.reset();
    }

    public override reset(): void {
        this.emaValues.fill(0);
        this.smaValues.fill(0);
        this.crossSignals.fill(0);
        this.crossPrices.fill(0);
        this.lastAlertedTime = -1;
        this.lastAlertedDirection = 0;
        // --- START NEW ---
        this.crossRegistry = [];
        this.rollingAtr = 0;
        // --- END NEW ---
        super.reset();
    }

    public ensureCapacity(len: number): void {
        if (len > this.emaValues.length) {
            const newCap = Math.max(len * 2, 20000);
            const newEma = new Float64Array(newCap);
            newEma.set(this.emaValues);
            this.emaValues = newEma;

            const newSma = new Float64Array(newCap);
            newSma.set(this.smaValues);
            this.smaValues = newSma;

            const newSignals = new Int8Array(newCap);
            newSignals.set(this.crossSignals);
            this.crossSignals = newSignals;

            const newCrossPrices = new Float64Array(newCap);
            newCrossPrices.set(this.crossPrices);
            this.crossPrices = newCrossPrices;

            const newValues = new Float64Array(newCap);
            newValues.set(this.values);
            this.values = newValues;
        }
    }

    protected override calculate(ds: DataStore): void {
        const len = ds.length;
        if (len === 0) return;

        this.ensureCapacity(len);

        const emaLen = Math.max(1, Math.floor(this.getParam<number>('emaLength', 10)));
        const smaLen = Math.max(1, Math.floor(this.getParam<number>('smaLength', 30)));
        const k = 2 / (emaLen + 1);

        // Calculate full historical data or incremental update
        const isReset = this.lastCalculatedIdx === -1 || this.lastCalculatedIdx >= len || (len > this.lastCalculatedIdx + 2);
        const startIdx = isReset ? 0 : Math.max(0, this.lastCalculatedIdx);

        if (isReset) {
            // Full historical calculation
            let smaSum = 0;

            for (let i = 0; i < len; i++) {
                const c = ds.data[i * 6 + 4];

                // 1. Calculate EMA
                if (i === 0) {
                    this.emaValues[0] = c;
                } else {
                    this.emaValues[i] = (c - this.emaValues[i - 1]) * k + this.emaValues[i - 1];
                }

                // 2. Calculate SMA
                smaSum += c;
                if (i >= smaLen) {
                    smaSum -= ds.data[(i - smaLen) * 6 + 4];
                }

                if (i >= smaLen - 1) {
                    this.smaValues[i] = smaSum / smaLen;
                } else {
                    this.smaValues[i] = smaSum / (i + 1);
                }

                // 3. Detect Crosses
                this.crossSignals[i] = 0;
                this.crossPrices[i] = 0;

                const minWarmup = Math.max(emaLen, smaLen) - 1;
                if (i > minWarmup) {
                    const prevEma = this.emaValues[i - 1];
                    const currEma = this.emaValues[i];
                    const prevSma = this.smaValues[i - 1];
                    const currSma = this.smaValues[i];

                    if (prevEma <= prevSma && currEma > currSma) {
                        // Bullish Golden Cross
                        this.crossSignals[i] = 1;
                        this.crossPrices[i] = this.interpolateCross(prevEma, currEma, prevSma, currSma, c);
                    } else if (prevEma >= prevSma && currEma < currSma) {
                        // Bearish Death Cross
                        this.crossSignals[i] = -1;
                        this.crossPrices[i] = this.interpolateCross(prevEma, currEma, prevSma, currSma, c);
                    }
                }

                // --- START NEW: ATR & Historical Shelf Tracker ---
                const h = ds.data[i * 6 + 2];
                const l = ds.data[i * 6 + 3];
                const prevC = i > 0 ? ds.data[(i - 1) * 6 + 4] : c;
                const tr = Math.max(h - l, Math.abs(h - prevC), Math.abs(l - prevC));
                this.rollingAtr = i === 0 ? tr : (this.rollingAtr * 13 + tr) / 14;
                const currentAtr = Math.max(this.rollingAtr, 0.000001);

                // 1. Register New Cross
                if (this.crossSignals[i] !== 0) {
                    this.crossRegistry.push({
                        price: this.crossPrices[i] || c,
                        timeMs: ds.data[i * 6],
                        direction: this.crossSignals[i],
                        maxRunAtr: 0,
                        isMature: false,
                        broken: false,
                        startIndex: i
                    });
                }

                // 2. Update existing crosses in memory
                for (let r = this.crossRegistry.length - 1; r >= 0; r--) {
                    const shelf = this.crossRegistry[r];
                    if (shelf.broken) continue;

                    const ageHours = (ds.data[i * 6] - shelf.timeMs) / 3600000;

                    // Invalidation: Price closed 1.5 ATR past the shelf
                    if ((shelf.direction === 1 && c < shelf.price - 1.5 * currentAtr) ||
                        (shelf.direction === -1 && c > shelf.price + 1.5 * currentAtr)) {
                        this.crossRegistry.splice(r, 1); // Prune broken shelf immediately to keep memory lean
                        continue;
                    }

                    // Excursion: Track how far price ran from this cross
                    const runAtr = shelf.direction === 1 ? (h - shelf.price) / currentAtr : (shelf.price - l) / currentAtr;
                    if (runAtr > shelf.maxRunAtr) shelf.maxRunAtr = runAtr;

                    // Maturation: Ran > 5 ATR and is > 12 hours old
                    if (!shelf.isMature && shelf.maxRunAtr >= 5.0 && ageHours >= 12.0) {
                        shelf.isMature = true;
                    }
                }

                this.values[i] = this.emaValues[i]; // (Original line restored here)
                // --- END NEW ---
            }
        } else {
            // Live / incremental calculation for forming or new bar
            for (let i = startIdx; i < len; i++) {
                const c = ds.data[i * 6 + 4];

                if (i === 0) {
                    this.emaValues[0] = c;
                    this.smaValues[0] = c;
                } else {
                    this.emaValues[i] = (c - this.emaValues[i - 1]) * k + this.emaValues[i - 1];

                    // SMA window sum
                    const windowStart = Math.max(0, i - smaLen + 1);
                    const windowCount = i - windowStart + 1;
                    let sum = 0;
                    for (let j = windowStart; j <= i; j++) {
                        sum += ds.data[j * 6 + 4];
                    }
                    this.smaValues[i] = sum / windowCount;
                }

                // Cross detection on current bar
                this.crossSignals[i] = 0;
                this.crossPrices[i] = 0;

                const minWarmup = Math.max(emaLen, smaLen) - 1;
                if (i > minWarmup) {
                    const prevEma = this.emaValues[i - 1];
                    const currEma = this.emaValues[i];
                    const prevSma = this.smaValues[i - 1];
                    const currSma = this.smaValues[i];

                    if (prevEma <= prevSma && currEma > currSma) {
                        this.crossSignals[i] = 1;
                        this.crossPrices[i] = this.interpolateCross(prevEma, currEma, prevSma, currSma, c);
                    } else if (prevEma >= prevSma && currEma < currSma) {
                        this.crossSignals[i] = -1;
                        this.crossPrices[i] = this.interpolateCross(prevEma, currEma, prevSma, currSma, c);
                    }
                }
                // --- START NEW: ATR & Historical Shelf Tracker ---
                const h = ds.data[i * 6 + 2];
                const l = ds.data[i * 6 + 3];
                const prevC = i > 0 ? ds.data[(i - 1) * 6 + 4] : c;
                const tr = Math.max(h - l, Math.abs(h - prevC), Math.abs(l - prevC));
                this.rollingAtr = i === 0 ? tr : (this.rollingAtr * 13 + tr) / 14;
                const currentAtr = Math.max(this.rollingAtr, 0.000001);

                // 1. Register New Cross
                if (this.crossSignals[i] !== 0) {
                    this.crossRegistry.push({
                        price: this.crossPrices[i] || c,
                        timeMs: ds.data[i * 6],
                        direction: this.crossSignals[i],
                        maxRunAtr: 0,
                        isMature: false,
                        broken: false,
                        startIndex: i
                    });
                }

                // 2. Update existing crosses in memory
                for (let r = this.crossRegistry.length - 1; r >= 0; r--) {
                    const shelf = this.crossRegistry[r];
                    if (shelf.broken) continue;

                    const ageHours = (ds.data[i * 6] - shelf.timeMs) / 3600000;

                    // Invalidation: Price closed 1.5 ATR past the shelf
                    if ((shelf.direction === 1 && c < shelf.price - 1.5 * currentAtr) ||
                        (shelf.direction === -1 && c > shelf.price + 1.5 * currentAtr)) {
                        this.crossRegistry.splice(r, 1); // Prune broken shelf immediately to keep memory lean
                        continue;
                    }

                    // Excursion: Track how far price ran from this cross
                    const runAtr = shelf.direction === 1 ? (h - shelf.price) / currentAtr : (shelf.price - l) / currentAtr;
                    if (runAtr > shelf.maxRunAtr) shelf.maxRunAtr = runAtr;

                    // Maturation: Ran > 5 ATR and is > 12 hours old
                    if (!shelf.isMature && shelf.maxRunAtr >= 5.0 && ageHours >= 12.0) {
                        shelf.isMature = true;
                    }
                }

                this.values[i] = this.emaValues[i]; // (Original line restored here)
                // --- END NEW ---
            }
        }

        this.lastCalculatedIdx = len - 1;

        // Check if an alert needs to be fired on the latest closed or live tick
        this.checkCrossAlert(ds);
    }

    private interpolateCross(prevEma: number, currEma: number, prevSma: number, currSma: number, fallbackClose: number): number {
        const denom = (currEma - prevEma) - (currSma - prevSma);
        if (Math.abs(denom) > 1e-9) {
            const t = Math.max(0, Math.min(1, (prevSma - prevEma) / denom));
            return prevEma + t * (currEma - prevEma);
        }
        return fallbackClose;
    }

    private checkCrossAlert(ds: DataStore): void {
        const len = ds.length;
        if (len < 2) return;

        const notifEnabled = this.getParam<boolean>('notificationsEnabled', true);
        if (!notifEnabled) return;

        const notifyBull = this.getParam<boolean>('notifyBull', true);
        const notifyBear = this.getParam<boolean>('notifyBear', true);
        const triggerOnClose = this.getParam<boolean>('triggerOnClose', true);
        const soundEnabled = this.getParam<boolean>('notificationSound', true);

        // Check latest confirmed closed bar (len - 2) or live forming bar (len - 1)
        const checkIdx = triggerOnClose ? len - 2 : len - 1;
        if (checkIdx < 1) return;

        const signal = this.crossSignals[checkIdx];
        if (signal === 0) return;

        if (signal === 1 && !notifyBull) return;
        if (signal === -1 && !notifyBear) return;

        const barTime = ds.data[checkIdx * 6];
        if (barTime === this.lastAlertedTime && signal === this.lastAlertedDirection) {
            return; // Already notified for this bar
        }

        this.lastAlertedTime = barTime;
        this.lastAlertedDirection = signal;

        const emaLen = this.getParam<number>('emaLength', 10);
        const smaLen = this.getParam<number>('smaLength', 30);
        const price = this.crossPrices[checkIdx] || ds.data[checkIdx * 6 + 4];
        const dir: 'bull' | 'bear' = signal === 1 ? 'bull' : 'bear';

        alertManager.triggerCrossAlert(
            this.currentSymbol || 'BTCUSDT',
            dir,
            `EMA (${emaLen})`,
            `SMA (${smaLen})`,
            price,
            soundEnabled,
            `Fast EMA (${emaLen}) crossed ${dir === 'bull' ? 'ABOVE' : 'BELOW'} Slow SMA (${smaLen}) at $${price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`
        );
    }

    public override render(r: ChartRenderer, layout: IndicatorLayout, g: Graphics): void {
        if (!this.visible || r.dataStore.length === 0) return;

        // 1. Draw GPU lines for Fast EMA and Slow SMA
        const showLines = this.getParam<boolean>('showLines', true);
        if (showLines) {
            const rawEmaClr = String(this.getParam('emaColor', '#00E5FF')).trim().toUpperCase();
            let { color: emaClr, alpha: emaAlpha } = parseColorAndAlpha(rawEmaClr);
            const emaWidth = Math.max(1, this.getParam<number>('emaWidth', 2));

            const rawSmaClr = String(this.getParam('smaColor', '#FF9800')).trim().toUpperCase();
            let { color: smaClr, alpha: smaAlpha } = parseColorAndAlpha(rawSmaClr);
            const smaWidth = Math.max(1, this.getParam<number>('smaWidth', 2));

            // Theme adjustments for light themes
            if (!r.isDarkTheme) {
                if (rawEmaClr.startsWith('#00E5FF')) emaClr = 0x00838F;
                if (rawSmaClr.startsWith('#FF9800')) smaClr = 0xD97706;
                if (emaClr === 0xFFFFFF) emaClr = 0x131722;
                if (smaClr === 0xFFFFFF) smaClr = 0x131722;
            }

            r.drawGPUIndicatorLine(`${this.id}_ema`, this.emaValues, emaClr, emaWidth, false, layout, undefined, false, emaAlpha);
            r.drawGPUIndicatorLine(`${this.id}_sma`, this.smaValues, smaClr, smaWidth, false, layout, undefined, false, smaAlpha);
        }

        // 2. Draw Cross Shapes & Markers
        const showCrossSignals = this.getParam<boolean>('showCrossSignals', true);
        if (!showCrossSignals) return;

        const shapeMode = this.getParam<string>('shapeMode', 'distinct_symbols');
        const customBullShape = this.getParam<string>('bullShape', 'Triangle Up (▲)');
        const customBearShape = this.getParam<string>('bearShape', 'Triangle Down (▼)');
        const markerPosition = this.getParam<string>('markerPosition', 'Above / Below Bar');
        const markerSize = Math.max(4, this.getParam<number>('markerSize', 8));

        const bullColor = parseColor(this.getParam('bullColor', '#00E676'));
        const bearColor = parseColor(this.getParam('bearColor', '#EF5350'));

        const sp = r.candleSpacing * r.zoom;
        const dsLength = r.dataStore.length;
        const visStart = Math.max(0, Math.floor(r.cameraX / sp) - 3);
        const visEnd = Math.min(dsLength, Math.floor((r.cameraX + layout.chartWidth) / sp) + 3);
        const ds = r.dataStore;

        const resolveShape = (isBull: boolean): CrossMarkerShape => {
            if (shapeMode === 'circle') return 'circle';
            if (shapeMode === 'circle_ring') return 'circle_ring';
            if (shapeMode === 'arrows') return isBull ? 'arrow_up' : 'arrow_down';
            if (shapeMode === 'star_cross') return isBull ? 'star' : 'cross';
            if (shapeMode === 'diamonds') return 'diamond';
            if (shapeMode === 'custom') {
                const str = isBull ? customBullShape : customBearShape;
                if (str.includes('Circle Ring') || str.includes('(○)')) return 'circle_ring';
                if (str.includes('Circle') || str.includes('(●)')) return 'circle';
                if (str.includes('Arrow Up') || str.includes('(⬆)')) return 'arrow_up';
                if (str.includes('Arrow Down') || str.includes('(⬇)')) return 'arrow_down';
                if (str.includes('Star') || str.includes('(★)')) return 'star';
                if (str.includes('Diamond') || str.includes('(◆)')) return 'diamond';
                if (str.includes('Cross') || str.includes('(✖)')) return 'cross';
                return isBull ? 'triangle_up' : 'triangle_down';
            }
            // Default: 'distinct_symbols' -> Bull triangle up ▲, Bear triangle down ▼
            return isBull ? 'triangle_up' : 'triangle_down';
        };

        const bullShapeType = resolveShape(true);
        const bearShapeType = resolveShape(false);

        for (let i = visStart; i < visEnd; i++) {
            const sig = this.crossSignals[i];
            if (sig === 0) continue;

            const isBull = sig === 1;
            const clr = isBull ? bullColor : bearColor;
            const shapeType = isBull ? bullShapeType : bearShapeType;
            const x = r.getCandleCenterX(i);

            const base = i * 6;
            const high = ds.data[base + 2];
            const low = ds.data[base + 3];
            const crossP = this.crossPrices[i] || ds.data[base + 4];

            const drawAtPositions: number[] = [];
            const offset = markerSize + 5;

            if (markerPosition === 'Above / Below Bar' || markerPosition === 'Both') {
                const yBar = isBull ? r.priceToY(low) + offset : r.priceToY(high) - offset;
                drawAtPositions.push(yBar);
            }

            if (markerPosition === 'On Cross Price' || markerPosition === 'Both') {
                const yCross = r.priceToY(crossP);
                drawAtPositions.push(yCross);
            }

            for (const y of drawAtPositions) {
                this.drawMarker(g, x, y, shapeType, markerSize, clr);
            }
        }

        // --- START PHASE 4: Institutional Dotted Rays ---
        if (this.getParam<boolean>('showHistoricalShelves', true)) {
            for (const shelf of this.crossRegistry) {
                if (!shelf.isMature || shelf.broken) continue;

                const startX = r.getCandleCenterX(shelf.startIndex);
                const endX = layout.chartWidth + 200;
                const y = r.priceToY(shelf.price);

                // FIX: Changed layout.chartHeight to layout.mainChartHeight
                if (y < -50 || y > layout.mainChartHeight + 50 || startX > endX) continue;

                const shelfColor = shelf.direction === 1 ? bullColor : bearColor;

                // Draw a professional dotted line to represent the Institutional Shelf
                const dash = 8;
                const gap = 6;
                g.moveTo(startX, y);
                for (let curX = startX; curX < endX; curX += dash + gap) {
                    g.moveTo(curX, y);
                    g.lineTo(Math.min(curX + dash, endX), y);
                }
                g.stroke({ color: shelfColor, width: 2, alpha: 0.65 });
            }
        }
        // --- END PHASE 4 ---
    }

    private drawMarker(g: Graphics, x: number, y: number, shape: CrossMarkerShape, size: number, color: number): void {
        switch (shape) {
            case 'circle': {
                // Solid Circle
                g.circle(x, y, size * 0.75).fill({ color, alpha: 1.0 });
                g.circle(x, y, size * 0.75).stroke({ color: 0x000000, width: 1.5, alpha: 0.6 });
                break;
            }
            case 'circle_ring': {
                // Hollow Circle Ring
                g.circle(x, y, size * 0.85).stroke({ color, width: 2.5, alpha: 1.0 });
                break;
            }
            case 'triangle_up': {
                // Solid Triangle Up ▲
                const h = size * 1.4;
                const halfW = size * 0.95;
                g.moveTo(x, y - h * 0.6)
                 .lineTo(x - halfW, y + h * 0.5)
                 .lineTo(x + halfW, y + h * 0.5)
                 .closePath();
                g.fill({ color, alpha: 1.0 });
                g.stroke({ color: 0x000000, width: 1.2, alpha: 0.5 });
                break;
            }
            case 'triangle_down': {
                // Solid Triangle Down ▼
                const h = size * 1.4;
                const halfW = size * 0.95;
                g.moveTo(x, y + h * 0.6)
                 .lineTo(x - halfW, y - h * 0.5)
                 .lineTo(x + halfW, y - h * 0.5)
                 .closePath();
                g.fill({ color, alpha: 1.0 });
                g.stroke({ color: 0x000000, width: 1.2, alpha: 0.5 });
                break;
            }
            case 'arrow_up': {
                // Stylized Arrow Up ⬆
                const w = size * 0.85;
                const h = size * 1.4;
                g.moveTo(x, y - h * 0.6)
                 .lineTo(x - w, y)
                 .lineTo(x - w * 0.45, y)
                 .lineTo(x - w * 0.45, y + h * 0.55)
                 .lineTo(x + w * 0.45, y + h * 0.55)
                 .lineTo(x + w * 0.45, y)
                 .lineTo(x + w, y)
                 .closePath();
                g.fill({ color, alpha: 1.0 });
                g.stroke({ color: 0x000000, width: 1, alpha: 0.5 });
                break;
            }
            case 'arrow_down': {
                // Stylized Arrow Down ⬇
                const w = size * 0.85;
                const h = size * 1.4;
                g.moveTo(x, y + h * 0.6)
                 .lineTo(x - w, y)
                 .lineTo(x - w * 0.45, y)
                 .lineTo(x - w * 0.45, y - h * 0.55)
                 .lineTo(x + w * 0.45, y - h * 0.55)
                 .lineTo(x + w * 0.45, y)
                 .lineTo(x + w, y)
                 .closePath();
                g.fill({ color, alpha: 1.0 });
                g.stroke({ color: 0x000000, width: 1, alpha: 0.5 });
                break;
            }
            case 'cross': {
                // Cross / X ✖
                const s = size * 0.8;
                const th = Math.max(2, size * 0.28);
                g.moveTo(x - s, y - s).lineTo(x + s, y + s);
                g.moveTo(x - s, y + s).lineTo(x + s, y - s);
                g.stroke({ color, width: th, alpha: 1.0 });
                break;
            }
            case 'diamond': {
                // Diamond ◆
                const s = size * 0.95;
                g.moveTo(x, y - s)
                 .lineTo(x + s * 0.75, y)
                 .lineTo(x, y + s)
                 .lineTo(x - s * 0.75, y)
                 .closePath();
                g.fill({ color, alpha: 1.0 });
                g.stroke({ color: 0x000000, width: 1.2, alpha: 0.5 });
                break;
            }
            case 'star': {
                // 5-Point Star ★
                const points = 5;
                const outerR = size * 1.1;
                const innerR = size * 0.45;
                for (let p = 0; p < points * 2; p++) {
                    const r = (p % 2 === 0) ? outerR : innerR;
                    const angle = (p * Math.PI) / points - Math.PI / 2;
                    const px = x + Math.cos(angle) * r;
                    const py = y + Math.sin(angle) * r;
                    if (p === 0) g.moveTo(px, py);
                    else g.lineTo(px, py);
                }
                g.closePath();
                g.fill({ color, alpha: 1.0 });
                g.stroke({ color: 0x000000, width: 1, alpha: 0.5 });
                break;
            }
        }
    }

    public override getValueAt(idx: number, ds: DataStore, isDark: boolean, defaultTextClr: number) {
        if (idx < 0 || idx >= ds.length) {
            return { label: this.name, valueStr: '—', valueColor: defaultTextClr };
        }

        const emaVal = this.emaValues[idx] || 0;
        const smaVal = this.smaValues[idx] || 0;
        const sig = this.crossSignals[idx] || 0;

        const rawEma = String(this.getParam('emaColor', '#00E5FF')).toUpperCase();
        let emaClr = parseColor(rawEma);
        if (!isDark && rawEma === '#00E5FF') emaClr = 0x00838F;

        const bullClr = parseColor(this.getParam('bullColor', '#00E676'));
        const bearClr = parseColor(this.getParam('bearColor', '#EF5350'));

        const fmt = (v: number) => v > 0 ? (v >= 10 ? v.toFixed(2) : v.toPrecision(5)) : '—';

        let crossTag = '';
        let valColor = emaClr;

        if (sig === 1) {
            crossTag = ' [▲ GOLDEN CROSS]';
            valColor = bullClr;
        } else if (sig === -1) {
            crossTag = ' [▼ DEATH CROSS]';
            valColor = bearClr;
        }

        const emaLen = this.getParam<number>('emaLength', 10);
        const smaLen = this.getParam<number>('smaLength', 30);

        // --- START PHASE 4: EcoChart HUD Proximity Alert ---
        let shelfAlert = '';
        if (this.crossRegistry && this.crossRegistry.length > 0) {
            const hoverPrice = ds.data[idx * 6 + 4]; // Price at current crosshair/live tick
            const hoverTime = ds.data[idx * 6];      // Time at current crosshair/live tick
            let nearestDistPct = 999;
            let nearestAge = 0;

            for (const shelf of this.crossRegistry) {
                if (!shelf.isMature || shelf.broken) continue;

                // Calculate how close price is to the shelf (Percentage)
                const distPct = Math.abs(hoverPrice - shelf.price) / hoverPrice;

                // If price is within a tight 0.5% boundary of the mature shelf
                if (distPct < 0.005) {
                    if (distPct < nearestDistPct) {
                        nearestDistPct = distPct;
                        nearestAge = Math.floor((hoverTime - shelf.timeMs) / 3600000);
                    }
                }
            }

            if (nearestDistPct !== 999) {
                shelfAlert = `  |  ⚠️ IMPULSE ORIGIN (${nearestAge}h old)`;
                valColor = 0xFFB703; // Turn HUD text Warning Orange
            }
        }

        return {
            label: `EMA(${emaLen})/SMA(${smaLen})`,
            valueStr: `E:${fmt(emaVal)} S:${fmt(smaVal)}${crossTag}${shelfAlert}`,
            valueColor: valColor
        };
        // --- END PHASE 4 ---
    }

    public destroy(renderer?: ChartRenderer): void {
        if (renderer) {
            renderer.removeIndicatorMesh(`${this.id}_ema`);
            renderer.removeIndicatorMesh(`${this.id}_sma`);
        }
    }
}
