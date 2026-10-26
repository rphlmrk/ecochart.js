import { BaseIndicator, parseColorAndAlpha, parseColor, type IndicatorLayout } from '../Indicator';
import type { DataStore } from '../../data/DataStore';
import type { ChartRenderer } from '../../renderer/ChartRenderer';
import { StrokeEngine } from '../../renderer/StrokeEngine';
import { TimeframeResampler } from '../../data/TimeframeResampler';
import { Graphics, Container, BitmapText } from 'pixi.js';
import { alertManager } from '../../alerts/AlertManager';

export interface StrictCBCBox {
    id: number;
    type: 'bear' | 'bull';
    leftBar: number;
    rightBar: number;
    top: number;
    bottom: number;
    isOpen: boolean;
    breakoutDir?: 'up' | 'down';
    createdBar: number;
}

export class StrictCBCPullbackZonesIndicator extends BaseIndicator {
    // Cached structure boxes to eliminate render-loop CPU calculations
    public cachedBoxes: StrictCBCBox[] = [];
    public currentSymbol = 'BTCUSDT';
    private notifiedBreakouts = new Set<string>();

    // Cache invalidation state
    private lastCalculatedLength = -1;
    private lastStateHash = '';

    // Per-bar telemetry buffers for fast crosshair inspection
    public flips: Int8Array = new Int8Array(20000); // 1 = Bullish Flip, -1 = Bearish Flip, 0 = none
    public trends: Int8Array = new Int8Array(20000); // 1 = Bullish Push, -1 = Bearish Pullback / Down
    public anchorHighs: Float64Array = new Float64Array(20000);
    public anchorLows: Float64Array = new Float64Array(20000);

    // Zero-GC text pooling for optional zone labels
    private labelContainer = new Container();
    private labelTextPool: BitmapText[] = [];
    private isContainerMounted = false;

    constructor() {
        super('STRICT_CBC_PULLBACK', 'Strict CBC Pullback Zones');
        this.isOscillator = false;
        this.layerType = 'pullback_zone';

        this.params = [
            // Timeframe selection
            {
                id: 'timeframe',
                name: 'Timeframe',
                type: 'select',
                value: 'Current',
                options: ['Current', '1m', '3m', '5m', '15m', '30m', '45m', '1h', '2h', '3h', '4h', '6h', '8h', '12h', '1d', '3d', '1w', 'Custom HTF']
            },
            { id: 'customTfMins', name: 'Custom HTF Minutes', type: 'number', value: 60, min: 1, max: 43200, step: 1 },

            // General Box Settings
            { id: 'maxBoxes', name: 'Max Boxes Count', type: 'number', value: 500, min: 10, max: 1000, step: 10 },
            { id: 'extendBoxes', name: 'Extend Boxes to Right', type: 'boolean', value: false },
            { id: 'borderWidth', name: 'Border Width', type: 'number', value: 1, min: 1, max: 4, step: 0.5 },

            // Bear Zone (Red Box)
            { id: 'bearBg', name: 'Bear Box Background', type: 'color', value: '#CC00004D' }, // #CC0000 with 30% alpha
            { id: 'bearBorder', name: 'Bear Border Color', type: 'color', value: '#CC0000' },

            // Bull Zone (Gray Box)
            { id: 'bullBg', name: 'Bull Box Background', type: 'color', value: '#9E9E9E4D' }, // #9E9E9E with 30% alpha
            { id: 'bullBorder', name: 'Bull Border Color', type: 'color', value: '#9E9E9E' },

            // 50% Midline (Equilibrium) Settings
            { id: 'showMidline', name: 'Show 50% Midline (Equilibrium)', type: 'boolean', value: false },
            { id: 'midlineColor', name: '50% Midline Color', type: 'color', value: '#EF5350' },

            // Box High & Low Horizontal Lines
            { id: 'showHighLowLines', name: 'Draw Box High & Low Lines', type: 'boolean', value: false },
            { id: 'highLowLineColor', name: 'High & Low Lines Color', type: 'color', value: '#787B86' },

            // Zone Labels
            { id: 'showLabels', name: 'Show Status Labels', type: 'boolean', value: false },

            // Alerts
            { id: 'alertBearishFlip', name: '🔔 Alert on Bearish Flip', type: 'boolean', value: true },
            { id: 'alertBullishFlip', name: '🔔 Alert on Bullish Flip', type: 'boolean', value: true },
            { id: 'alertBoxBreakout', name: '🔔 Alert on Box Breakout', type: 'boolean', value: true }
        ];
    }

    public static getTimeframeOptions(currentInterval: string): string[] {
        const ALL = ['1m', '3m', '5m', '15m', '30m', '45m', '1h', '2h', '3h', '4h', '6h', '8h', '12h', '1d', '3d', '1w'];
        const currentMs = TimeframeResampler.parseMs(currentInterval);
        const filtered = ALL.filter(tf => TimeframeResampler.parseMs(tf) > currentMs);
        return ['Current', ...filtered, 'Custom HTF'];
    }

    public getTimeframeOptions(currentInterval: string): string[] {
        return StrictCBCPullbackZonesIndicator.getTimeframeOptions(currentInterval);
    }

    public getEffectiveTfMs(chartTfMs: number): number {
        const mode = this.getParam<string>('timeframe', 'Current');
        if (mode === 'Current') return chartTfMs;
        if (mode === 'Custom' || mode === 'Custom HTF') {
            const mins = Math.max(1, this.getParam<number>('customTfMins', 60));
            const customMs = mins * 60 * 1000;
            return Math.max(customMs, chartTfMs);
        }
        const parsedMs = TimeframeResampler.parseMs(mode.toLowerCase());
        if (parsedMs <= chartTfMs) {
            return chartTfMs;
        }
        return parsedMs;
    }

    protected override onParamsUpdated(): void {
        this.lastCalculatedLength = -1;
        this.lastStateHash = '';
        this.cachedBoxes = [];
        const tf = this.getParam<string>('timeframe', 'Current');
        this.name = tf === 'Current'
            ? 'Strict CBC Pullback Zones'
            : `Strict CBC Pullback Zones [${tf}]`;
    }

    public override reset(): void {
        this.cachedBoxes = [];
        this.lastCalculatedLength = -1;
        this.lastStateHash = '';
        this.flips.fill(0);
        this.trends.fill(0);
        this.anchorHighs.fill(0);
        this.anchorLows.fill(0);
        super.reset();
    }

    public calculate(ds: DataStore): void {
        this.buildCachedBoxes(ds);
    }

    public override update(ds: DataStore, isClosedTick: boolean): void {
        if (ds.length > this.flips.length) {
            const cap = Math.max(ds.length * 2, 20000);
            const newFlips = new Int8Array(cap);
            newFlips.set(this.flips);
            this.flips = newFlips;

            const newTrends = new Int8Array(cap);
            newTrends.set(this.trends);
            this.trends = newTrends;

            const newAnchorHighs = new Float64Array(cap);
            newAnchorHighs.set(this.anchorHighs);
            this.anchorHighs = newAnchorHighs;

            const newAnchorLows = new Float64Array(cap);
            newAnchorLows.set(this.anchorLows);
            this.anchorLows = newAnchorLows;
        }
        this.buildCachedBoxes(ds);
        super.update(ds, isClosedTick);
    }

    /**
     * Dispatches audio & notification alerts on flip or breakout events
     */
    private dispatchAlert(
        kind: 'bear_flip' | 'bull_flip' | 'box_breakout',
        direction: 'up' | 'down',
        price: number,
        barTime: number,
        barIndex: number,
        box?: StrictCBCBox
    ): void {
        const sym = this.currentSymbol || 'BTCUSDT';
        const key = `${sym}_${kind}_${direction}_${barTime || barIndex}`;
        if (this.notifiedBreakouts.has(key)) return;

        this.notifiedBreakouts.add(key);
        if (this.notifiedBreakouts.size > 200) {
            const firstKey = this.notifiedBreakouts.values().next().value;
            if (firstKey) this.notifiedBreakouts.delete(firstKey);
        }

        if (kind === 'bear_flip' && this.getParam<boolean>('alertBearishFlip', true)) {
            window.dispatchEvent(new CustomEvent('ecochart-alert', {
                detail: {
                    id: this.id,
                    title: 'Bearish Flip [Strict CBC]',
                    message: `${sym}: Strict CBC Bearish Flip at $${price.toFixed(2)} (Closed below Anchor Low)`
                }
            }));
        } else if (kind === 'bull_flip' && this.getParam<boolean>('alertBullishFlip', true)) {
            window.dispatchEvent(new CustomEvent('ecochart-alert', {
                detail: {
                    id: this.id,
                    title: 'Bullish Flip [Strict CBC]',
                    message: `${sym}: Strict CBC Bullish Flip at $${price.toFixed(2)} (Closed above Anchor High)`
                }
            }));
        } else if (kind === 'box_breakout' && this.getParam<boolean>('alertBoxBreakout', true) && box) {
            alertManager.triggerPullbackBreakout(
                sym,
                box.type === 'bear' ? 'macro' : 'micro',
                direction,
                price,
                box.top,
                box.bottom
            );
        }
    }

    /**
     * Builds and caches Strict CBC Pullback Zones with strict Pine Script //@version=5 execution order
     */
    private buildCachedBoxes(ds: DataStore): void {
        const len = ds.length;
        if (len === 0) {
            this.cachedBoxes = [];
            this.lastCalculatedLength = 0;
            this.lastStateHash = '';
            return;
        }

        const maxBoxes = Math.max(10, Math.min(1000, this.getParam<number>('maxBoxes', 500)));
        const chartTfMs = (ds.length >= 2 && ds.data[6] > ds.data[0]) ? (ds.data[6] - ds.data[0]) : 60000;
        const tfMs = this.getEffectiveTfMs(chartTfMs);
        const isHTF = tfMs > chartTfMs;

        const extendBoxes = this.getParam<boolean>('extendBoxes', false);
        const lastIdx = len - 1;
        const baseLast = lastIdx * 6;
        const lastH = ds.data[baseLast + 2];
        const lastL = ds.data[baseLast + 3];
        const lastC = ds.data[baseLast + 4];

        const stateHash = `${maxBoxes}:${extendBoxes}:${tfMs}:${isHTF}:${len}:${lastH}:${lastL}:${lastC}`;
        if (this.lastStateHash === stateHash && this.lastCalculatedLength === len) {
            return;
        }

        // =========================================================================
        // MODE 1: Native Chart Timeframe
        // =========================================================================
        if (!isHTF) {
            const data = ds.data;
            const boxes: StrictCBCBox[] = [];
            let nextBoxId = 1;

            // Pine Script State Variables:
            // var float anchorHigh = high
            // var float anchorLow = low
            // var bool isBullish = true
            // var float phaseHigh = high, phaseHighIdx = bar_index
            // var float phaseLow = low, phaseLowIdx = bar_index
            // var box activeBearBox = na, activeBullBox = na

            let anchorHigh = data[2]; // high of bar 0
            let anchorLow = data[3];  // low of bar 0
            let isBullish = true;

            let phaseHigh = data[2];
            let phaseHighIdx = 0;
            let phaseLow = data[3];
            let phaseLowIdx = 0;

            let activeBearBox: StrictCBCBox | null = null;
            let activeBullBox: StrictCBCBox | null = null;

            for (let i = 0; i < len; i++) {
                const base = i * 6;
                const time = data[base];
                const o = data[base + 1];
                const h = data[base + 2];
                const l = data[base + 3];
                const c = data[base + 4];

                // 1. CANDLE DEFINITIONS
                const isBuy = c > o;
                const isSell = c < o;

                // 2. STRICT CBC FLIP CONDITIONS (evaluated against previous anchor bounds)
                const bearishFlip = isBullish && isSell && (c < anchorLow);
                const bullishFlip = !isBullish && isBuy && (c > anchorHigh);

                // 3. EXTREME TRACKERS (Find absolute highest wick / lowest wick before flip)
                if (isBullish) {
                    if (h > phaseHigh) {
                        phaseHigh = h;
                        phaseHighIdx = i;
                    }
                } else {
                    if (l < phaseLow) {
                        phaseLow = l;
                        phaseLowIdx = i;
                    }
                }

                // 4. DRAWING THE ZONES ON FLIP
                if (bearishFlip) {
                    isBullish = false;

                    // Draw Red Box: From highest wick down to breakout candle's low
                    const newBearBox: StrictCBCBox = {
                        id: nextBoxId++,
                        type: 'bear',
                        leftBar: phaseHighIdx,
                        rightBar: i,
                        top: phaseHigh,
                        bottom: l,
                        isOpen: true,
                        createdBar: i
                    };
                    boxes.push(newBearBox);
                    if (boxes.length > maxBoxes) boxes.shift();

                    activeBearBox = newBearBox;

                    // Reset low tracker for new bearish phase
                    phaseLow = l;
                    phaseLowIdx = i;

                    if (i === len - 1) {
                        this.dispatchAlert('bear_flip', 'down', c, time, i, newBearBox);
                    }
                }

                if (bullishFlip) {
                    isBullish = true;

                    // Draw Gray Box: From lowest wick up to breakout candle's high
                    const newBullBox: StrictCBCBox = {
                        id: nextBoxId++,
                        type: 'bull',
                        leftBar: phaseLowIdx,
                        rightBar: i,
                        top: h,
                        bottom: phaseLow,
                        isOpen: true,
                        createdBar: i
                    };
                    boxes.push(newBullBox);
                    if (boxes.length > maxBoxes) boxes.shift();

                    activeBullBox = newBullBox;

                    // Reset high tracker for new bullish phase
                    phaseHigh = h;
                    phaseHighIdx = i;

                    if (i === len - 1) {
                        this.dispatchAlert('bull_flip', 'up', c, time, i, newBullBox);
                    }
                }

                // 5. EXTEND THE ZONES (Only pushes boxes right if extendBoxes is enabled)
                if (activeBearBox !== null) {
                    if (extendBoxes) {
                        activeBearBox.rightBar = i;
                    }
                    if (c < activeBearBox.bottom || c > activeBearBox.top) {
                        activeBearBox.isOpen = false;
                        activeBearBox.breakoutDir = c > activeBearBox.top ? 'up' : 'down';
                        if (i === len - 1) {
                            this.dispatchAlert('box_breakout', activeBearBox.breakoutDir, c, time, i, activeBearBox);
                        }
                        activeBearBox = null; // Stop tracking once broken
                    }
                }

                if (activeBullBox !== null) {
                    if (extendBoxes) {
                        activeBullBox.rightBar = i;
                    }
                    if (c > activeBullBox.top || c < activeBullBox.bottom) {
                        activeBullBox.isOpen = false;
                        activeBullBox.breakoutDir = c > activeBullBox.top ? 'up' : 'down';
                        if (i === len - 1) {
                            this.dispatchAlert('box_breakout', activeBullBox.breakoutDir, c, time, i, activeBullBox);
                        }
                        activeBullBox = null; // Stop tracking once broken
                    }
                }

                // 6. UPDATE THE ANCHOR CANDLE
                // Rule: "Skip if it wicks below and closes inside".
                // Anchor ONLY updates if candle closes beyond the bounds, or on full trend flip.
                const validContinuation = (isBullish && c > anchorHigh) || (!isBullish && c < anchorLow);

                if (validContinuation || bearishFlip || bullishFlip) {
                    anchorHigh = h;
                    anchorLow = l;
                }

                // Record per-bar telemetry
                this.flips[i] = bullishFlip ? 1 : (bearishFlip ? -1 : 0);
                this.trends[i] = isBullish ? 1 : -1;
                this.anchorHighs[i] = anchorHigh;
                this.anchorLows[i] = anchorLow;
            }

            this.cachedBoxes = boxes;
            this.lastCalculatedLength = len;
            this.lastStateHash = stateHash;
            return;
        }

        // =========================================================================
        // MODE 2: Higher Timeframe (HTF Resampled Strict CBC)
        // =========================================================================
        interface HtfBar {
            time: number;
            open: number;
            high: number;
            low: number;
            close: number;
            firstChartBar: number;
            lastChartBar: number;
        }

        const data = ds.data;
        const htfBars: HtfBar[] = [];
        let currBucketTime = -1;
        let currHtfBar: HtfBar | null = null;

        for (let i = 0; i < len; i++) {
            const base = i * 6;
            const t = data[base];
            const o = data[base + 1];
            const h = data[base + 2];
            const l = data[base + 3];
            const c = data[base + 4];

            const bTime = TimeframeResampler.getBucketStart(t, tfMs);
            if (bTime !== currBucketTime) {
                currBucketTime = bTime;
                currHtfBar = {
                    time: bTime,
                    open: o,
                    high: h,
                    low: l,
                    close: c,
                    firstChartBar: i,
                    lastChartBar: i
                };
                htfBars.push(currHtfBar);
            } else if (currHtfBar) {
                currHtfBar.lastChartBar = i;
                currHtfBar.close = c;
                if (h > currHtfBar.high) currHtfBar.high = h;
                if (l < currHtfBar.low) currHtfBar.low = l;
            }
        }

        const htfLen = htfBars.length;
        if (htfLen === 0) {
            this.cachedBoxes = [];
            this.lastCalculatedLength = len;
            this.lastStateHash = stateHash;
            return;
        }

        const boxes: StrictCBCBox[] = [];
        let nextBoxId = 1;

        let anchorHigh = htfBars[0].high;
        let anchorLow = htfBars[0].low;
        let isBullish = true;

        let phaseHigh = htfBars[0].high;
        let phaseHighIdx = htfBars[0].firstChartBar;
        let phaseLow = htfBars[0].low;
        let phaseLowIdx = htfBars[0].firstChartBar;

        let activeBearBox: StrictCBCBox | null = null;
        let activeBullBox: StrictCBCBox | null = null;

        for (let b = 0; b < htfLen; b++) {
            const bar = htfBars[b];
            const o = bar.open;
            const h = bar.high;
            const l = bar.low;
            const c = bar.close;
            const chartIdx = bar.lastChartBar;
            const chartStartIdx = bar.firstChartBar;

            const isBuy = c > o;
            const isSell = c < o;

            const bearishFlip = isBullish && isSell && (c < anchorLow);
            const bullishFlip = !isBullish && isBuy && (c > anchorHigh);

            if (isBullish) {
                if (h > phaseHigh) {
                    phaseHigh = h;
                    phaseHighIdx = chartStartIdx;
                }
            } else {
                if (l < phaseLow) {
                    phaseLow = l;
                    phaseLowIdx = chartStartIdx;
                }
            }

            if (bearishFlip) {
                isBullish = false;
                const newBearBox: StrictCBCBox = {
                    id: nextBoxId++,
                    type: 'bear',
                    leftBar: phaseHighIdx,
                    rightBar: chartIdx,
                    top: phaseHigh,
                    bottom: l,
                    isOpen: true,
                    createdBar: chartIdx
                };
                boxes.push(newBearBox);
                if (boxes.length > maxBoxes) boxes.shift();

                activeBearBox = newBearBox;
                phaseLow = l;
                phaseLowIdx = chartStartIdx;

                if (b === htfLen - 1) {
                    this.dispatchAlert('bear_flip', 'down', c, bar.time, chartIdx, newBearBox);
                }
            }

            if (bullishFlip) {
                isBullish = true;
                const newBullBox: StrictCBCBox = {
                    id: nextBoxId++,
                    type: 'bull',
                    leftBar: phaseLowIdx,
                    rightBar: chartIdx,
                    top: h,
                    bottom: phaseLow,
                    isOpen: true,
                    createdBar: chartIdx
                };
                boxes.push(newBullBox);
                if (boxes.length > maxBoxes) boxes.shift();

                activeBullBox = newBullBox;
                phaseHigh = h;
                phaseHighIdx = chartStartIdx;

                if (b === htfLen - 1) {
                    this.dispatchAlert('bull_flip', 'up', c, bar.time, chartIdx, newBullBox);
                }
            }

            if (activeBearBox !== null) {
                if (extendBoxes) {
                    activeBearBox.rightBar = chartIdx;
                }
                if (c < activeBearBox.bottom || c > activeBearBox.top) {
                    activeBearBox.isOpen = false;
                    activeBearBox.breakoutDir = c > activeBearBox.top ? 'up' : 'down';
                    if (b === htfLen - 1) {
                        this.dispatchAlert('box_breakout', activeBearBox.breakoutDir, c, bar.time, chartIdx, activeBearBox);
                    }
                    activeBearBox = null;
                }
            }

            if (activeBullBox !== null) {
                if (extendBoxes) {
                    activeBullBox.rightBar = chartIdx;
                }
                if (c > activeBullBox.top || c < activeBullBox.bottom) {
                    activeBullBox.isOpen = false;
                    activeBullBox.breakoutDir = c > activeBullBox.top ? 'up' : 'down';
                    if (b === htfLen - 1) {
                        this.dispatchAlert('box_breakout', activeBullBox.breakoutDir, c, bar.time, chartIdx, activeBullBox);
                    }
                    activeBullBox = null;
                }
            }

            const validContinuation = (isBullish && c > anchorHigh) || (!isBullish && c < anchorLow);

            if (validContinuation || bearishFlip || bullishFlip) {
                anchorHigh = h;
                anchorLow = l;
            }

            // Project onto lower timeframe chart bars
            const fBar = bar.firstChartBar;
            const lBar = Math.min(len - 1, bar.lastChartBar);
            for (let k = fBar; k <= lBar; k++) {
                this.flips[k] = (k === lBar && bullishFlip) ? 1 : ((k === lBar && bearishFlip) ? -1 : 0);
                this.trends[k] = isBullish ? 1 : -1;
                this.anchorHighs[k] = anchorHigh;
                this.anchorLows[k] = anchorLow;
            }
        }

        this.cachedBoxes = boxes;
        this.lastCalculatedLength = len;
        this.lastStateHash = stateHash;
    }

    /**
     * Hardware-accelerated GPU Rendering
     * - Batched single draw call per zone type (all Bull fills, all Bull borders, all Bear fills, all Bear borders)
     * - Viewport culling to eliminate off-screen projection
     * - Zero-GC BitmapText pooling for crisp status labels
     */
    public render(r: ChartRenderer, layout: IndicatorLayout, g: Graphics): void {
        if (!this.visible || r.dataStore.length === 0) {
            this.labelContainer.visible = false;
            return;
        }

        if (this.cachedBoxes.length === 0 || this.lastCalculatedLength !== r.dataStore.length) {
            this.buildCachedBoxes(r.dataStore);
        }

        if (this.cachedBoxes.length === 0) {
            this.labelContainer.visible = false;
            return;
        }

        const borderWidth = Math.max(0.5, this.getParam<number>('borderWidth', 1));
        const bearBg = parseColorAndAlpha(this.getParam<string>('bearBg', '#CC00004D'), 0.30);
        const bearBorder = parseColorAndAlpha(this.getParam<string>('bearBorder', '#CC0000'), 1.0);
        const bullBg = parseColorAndAlpha(this.getParam<string>('bullBg', '#9E9E9E4D'), 0.30);
        const bullBorder = parseColorAndAlpha(this.getParam<string>('bullBorder', '#9E9E9E'), 1.0);

        const showMidline = this.getParam<boolean>('showMidline', false);
        const midlineColor = parseColorAndAlpha(this.getParam<string>('midlineColor', '#EF5350'), 0.85);

        const showHighLowLines = this.getParam<boolean>('showHighLowLines', false);
        const highLowLineColor = parseColorAndAlpha(this.getParam<string>('highLowLineColor', '#787B86'), 0.85);

        const showLabels = this.getParam<boolean>('showLabels', false);

        const screenW = layout.chartWidth;
        const sp = r.candleSpacing * r.zoom;
        const halfSp = sp * 0.45;
        const minX = -40;
        const maxX = screenW + 40;
        const dsLength = r.dataStore.length;

        interface VisibleZoneGeometry {
            x1: number;
            x2: number;
            yTop: number;
            yBot: number;
            w: number;
            h: number;
            yMid: number;
            box: StrictCBCBox;
        }

        const visibleBull: VisibleZoneGeometry[] = [];
        const visibleBear: VisibleZoneGeometry[] = [];

        const extendBoxes = this.getParam<boolean>('extendBoxes', false);

        for (let i = 0; i < this.cachedBoxes.length; i++) {
            const b = this.cachedBoxes[i];
            const x1 = r.getCandleCenterX(b.leftBar) - halfSp;
            const rightIdx = (extendBoxes && b.isOpen) ? (dsLength - 1) : b.rightBar;
            const x2 = r.getCandleCenterX(rightIdx) + halfSp;

            // Viewport culling
            if (x2 < minX || x1 > maxX) continue;

            const topPrice = Math.max(b.top, b.bottom);
            const botPrice = Math.min(b.top, b.bottom);
            const yTop = r.priceToY(topPrice);
            const yBot = r.priceToY(botPrice);
            const w = Math.max(2, x2 - x1);
            const h = Math.max(2, yBot - yTop);
            const yMid = r.priceToY((topPrice + botPrice) * 0.5);

            const geom: VisibleZoneGeometry = { x1, x2, yTop, yBot, w, h, yMid, box: b };
            if (b.type === 'bull') {
                visibleBull.push(geom);
            } else {
                visibleBear.push(geom);
            }
        }

        // =========================================================================
        // 🚀 GPU BATCH 1: Bull Zones (Gray Boxes) - Single Fill & Single Stroke
        // =========================================================================
        if (visibleBull.length > 0) {
            g.beginPath();
            for (let i = 0; i < visibleBull.length; i++) {
                const vb = visibleBull[i];
                g.rect(vb.x1, vb.yTop, vb.w, vb.h);
            }
            g.fill({ color: bullBg.color, alpha: bullBg.alpha });

            g.beginPath();
            for (let i = 0; i < visibleBull.length; i++) {
                const vb = visibleBull[i];
                g.rect(vb.x1, vb.yTop, vb.w, vb.h);
            }
            g.stroke({ color: bullBorder.color, width: borderWidth, alpha: bullBorder.alpha, cap: 'butt' });
        }

        // =========================================================================
        // 🚀 GPU BATCH 2: Bear Zones (Red Boxes) - Single Fill & Single Stroke
        // =========================================================================
        if (visibleBear.length > 0) {
            g.beginPath();
            for (let i = 0; i < visibleBear.length; i++) {
                const vb = visibleBear[i];
                g.rect(vb.x1, vb.yTop, vb.w, vb.h);
            }
            g.fill({ color: bearBg.color, alpha: bearBg.alpha });

            g.beginPath();
            for (let i = 0; i < visibleBear.length; i++) {
                const vb = visibleBear[i];
                g.rect(vb.x1, vb.yTop, vb.w, vb.h);
            }
            g.stroke({ color: bearBorder.color, width: borderWidth, alpha: bearBorder.alpha, cap: 'butt' });
        }

        // =========================================================================
        // 🚀 GPU BATCH 3: 50% Midline (Equilibrium)
        // =========================================================================
        if (showMidline && (visibleBull.length > 0 || visibleBear.length > 0)) {
            g.beginPath();
            const allVisible = visibleBull.concat(visibleBear);
            for (let i = 0; i < allVisible.length; i++) {
                const vb = allVisible[i];
                const startX = Math.max(0, vb.x1);
                const endX = Math.min(screenW, vb.x2);
                if (endX > startX) {
                    StrokeEngine.addDashedLinePath(g, startX, vb.yMid, endX, vb.yMid, 'dashed', 6, 4);
                }
            }
            g.stroke({
                color: midlineColor.color,
                width: Math.max(1, borderWidth),
                alpha: midlineColor.alpha,
                cap: 'butt'
            });
        }

        // =========================================================================
        // 🚀 GPU BATCH 4: Box High & Low Horizontal Lines
        // =========================================================================
        if (showHighLowLines && (visibleBull.length > 0 || visibleBear.length > 0)) {
            g.beginPath();
            const allVisible = visibleBull.concat(visibleBear);
            for (let i = 0; i < allVisible.length; i++) {
                const vb = allVisible[i];
                const startX = Math.max(0, vb.x1);
                const endX = Math.min(screenW, vb.x2);
                if (endX > startX) {
                    g.moveTo(startX, vb.yTop).lineTo(endX, vb.yTop);
                    g.moveTo(startX, vb.yBot).lineTo(endX, vb.yBot);
                }
            }
            g.stroke({
                color: highLowLineColor.color,
                width: Math.max(1, borderWidth),
                alpha: highLowLineColor.alpha,
                cap: 'butt'
            });
        }

        // =========================================================================
        // 🚀 BATCH 5: Zero-GC Pooled Bitmap Labels
        // =========================================================================
        if (showLabels && (visibleBull.length > 0 || visibleBear.length > 0)) {
            const parent = r.strictCbcContainer || r.app.stage;
            if (!this.isContainerMounted || this.labelContainer.parent !== parent) {
                if (this.labelContainer.parent) {
                    this.labelContainer.parent.removeChild(this.labelContainer);
                }
                parent.addChild(this.labelContainer);
                this.isContainerMounted = true;
            }
            this.labelContainer.visible = true;

            for (let i = 0; i < this.labelTextPool.length; i++) {
                this.labelTextPool[i].visible = false;
            }
            let activeTextCount = 0;

            const placeLabel = (text: string, xPos: number, yPos: number, tintColor: number) => {
                let item: BitmapText;
                if (activeTextCount < this.labelTextPool.length) {
                    item = this.labelTextPool[activeTextCount];
                } else {
                    item = new BitmapText({
                        text: '',
                        style: { fontFamily: 'ChartFont', fontSize: 10, fontWeight: 'bold' }
                    });
                    this.labelTextPool.push(item);
                    this.labelContainer.addChild(item);
                }
                item.text = text;
                item.tint = tintColor;
                item.x = xPos;
                item.y = yPos;
                item.visible = true;
                activeTextCount++;
            };

            for (let i = 0; i < visibleBull.length; i++) {
                const vb = visibleBull[i];
                if (vb.x1 <= screenW - 30) {
                    const status = vb.box.isOpen ? 'STRICT CBC BULL' : (vb.box.breakoutDir === 'up' ? 'BULL BRK UP' : 'BULL BRK DN');
                    placeLabel(status, Math.max(4, vb.x1 + 3), Math.max(12, vb.yTop - 11), bullBorder.color);
                }
            }

            for (let i = 0; i < visibleBear.length; i++) {
                const vb = visibleBear[i];
                if (vb.x1 <= screenW - 30) {
                    const status = vb.box.isOpen ? 'STRICT CBC BEAR' : (vb.box.breakoutDir === 'up' ? 'BEAR BRK UP' : 'BEAR BRK DN');
                    placeLabel(status, Math.max(4, vb.x1 + 3), Math.max(12, vb.yTop - 11), bearBorder.color);
                }
            }
        } else {
            this.labelContainer.visible = false;
        }
    }

    /**
     * Crosshair Telemetry Inspector: Reports Strict CBC state, Anchor High/Low, and Active Zone
     */
    public override getValueAt(idx: number, ds: DataStore, _isDark: boolean, defaultTextClr: number) {
        if (idx < 0 || idx >= ds.length) {
            return { label: this.name, valueStr: '—', valueColor: defaultTextClr };
        }

        const trend = this.trends[idx];
        const flip = this.flips[idx];
        const aHigh = this.anchorHighs[idx];
        const aLow = this.anchorLows[idx];

        const bearClr = parseColor(this.getParam('bearBorder', '#CC0000'));
        const bullClr = parseColor(this.getParam('bullBorder', '#9E9E9E'));

        const fmt = (p: number) => {
            if (isNaN(p) || !isFinite(p) || p === 0) return '—';
            return p >= 10 ? p.toFixed(2) : p.toPrecision(5);
        };

        let valueStr = '';
        let valueColor = defaultTextClr;

        if (flip === -1) {
            valueStr = `▼ Bearish Flip [Strict CBC] (Anchor L: ${fmt(aLow)})`;
            valueColor = bearClr;
        } else if (flip === 1) {
            valueStr = `▲ Bullish Flip [Strict CBC] (Anchor H: ${fmt(aHigh)})`;
            valueColor = bullClr;
        } else if (trend === 1) {
            valueStr = `Bullish Push (Anchor H: ${fmt(aHigh)} | L: ${fmt(aLow)})`;
            valueColor = bullClr;
        } else if (trend === -1) {
            valueStr = `Bearish Pullback (Anchor H: ${fmt(aHigh)} | L: ${fmt(aLow)})`;
            valueColor = bearClr;
        } else {
            valueStr = `Strict CBC (Anchor H: ${fmt(aHigh)} | L: ${fmt(aLow)})`;
        }

        return {
            label: this.name,
            valueStr,
            valueColor
        };
    }

    public destroy(): void {
        this.labelContainer.visible = false;
        for (let i = 0; i < this.labelTextPool.length; i++) {
            this.labelTextPool[i].visible = false;
        }
        if (this.labelContainer.parent) {
            this.labelContainer.parent.removeChild(this.labelContainer);
        }
        this.isContainerMounted = false;
    }
}
