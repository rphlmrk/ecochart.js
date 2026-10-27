import { BaseIndicator, parseColorAndAlpha, parseColor, type IndicatorLayout } from '../Indicator';
import type { DataStore } from '../../data/DataStore';
import type { ChartRenderer } from '../../renderer/ChartRenderer';
import { TimeframeResampler } from '../../data/TimeframeResampler';
import { Graphics } from 'pixi.js';
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

/**
 * Strict CBC Pullback Zones (Simplified)
 * 
 * Clean, high-performance Strict Candle Breakout (CBC) Pullback Zones:
 * - Precise anchor-based Bull and Bear pullback zones
 * - Clean multi-timeframe projection (Native and Resampled HTF)
 * - Automatic breakout & trend flip detection for alerts
 * - Extraneous midlines, high/low projections, and text labels removed for a clean chart
 * - Batched single draw-call GPU WebGL rendering
 */
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

            // Bear Zone (Red Box)
            { id: 'bearBorder', name: 'Bear Border Color', type: 'color', value: '#CC0000' },
            { id: 'bearBg', name: 'Bear Background Color', type: 'color', value: '#CC00004D' },

            // Bull Zone (Gray Box)
            { id: 'bullBorder', name: 'Bull Border Color', type: 'color', value: '#9E9E9E' },
            { id: 'bullBg', name: 'Bull Background Color', type: 'color', value: '#9E9E9E4D' },

            // Border Width
            { id: 'borderWidth', name: 'Border Width', type: 'number', value: 1, min: 0.5, max: 4, step: 0.5 }
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

    public getLatestOpenBox(): StrictCBCBox | null {
        for (let i = this.cachedBoxes.length - 1; i >= 0; i--) {
            if (this.cachedBoxes[i].isOpen) return this.cachedBoxes[i];
        }
        return null;
    }

    public getPullbackStatus(): {
        microBox: { top: number; bottom: number } | null;
        macroBox: { top: number; bottom: number } | null;
    } {
        const latest = this.getLatestOpenBox();
        return {
            microBox: null,
            macroBox: latest ? { top: latest.top, bottom: latest.bottom } : null
        };
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

        if (kind === 'bear_flip') {
            window.dispatchEvent(new CustomEvent('ecochart-alert', {
                detail: {
                    id: this.id,
                    title: 'Bearish Flip [Strict CBC]',
                    message: `${sym}: Strict CBC Bearish Flip at $${price.toFixed(2)} (Closed below Anchor Low)`
                }
            }));
        } else if (kind === 'bull_flip') {
            window.dispatchEvent(new CustomEvent('ecochart-alert', {
                detail: {
                    id: this.id,
                    title: 'Bullish Flip [Strict CBC]',
                    message: `${sym}: Strict CBC Bullish Flip at $${price.toFixed(2)} (Closed above Anchor High)`
                }
            }));
        } else if (kind === 'box_breakout' && box) {
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
     * Builds and caches Strict CBC Pullback Zones
     */
    private buildCachedBoxes(ds: DataStore): void {
        const len = ds.length;
        if (len === 0) {
            this.cachedBoxes = [];
            this.lastCalculatedLength = 0;
            this.lastStateHash = '';
            return;
        }

        const maxBoxes = 500;
        const chartTfMs = (ds.length >= 2 && ds.data[6] > ds.data[0]) ? (ds.data[6] - ds.data[0]) : 60000;
        const tfMs = this.getEffectiveTfMs(chartTfMs);
        const isHTF = tfMs > chartTfMs;

        const lastIdx = len - 1;
        const baseLast = lastIdx * 6;
        const lastH = ds.data[baseLast + 2];
        const lastL = ds.data[baseLast + 3];
        const lastC = ds.data[baseLast + 4];

        const stateHash = `${tfMs}:${isHTF}:${len}:${lastH}:${lastL}:${lastC}`;
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

            let anchorHigh = data[2];
            let anchorLow = data[3];
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

                const isBuy = c > o;
                const isSell = c < o;

                const bearishFlip = isBullish && isSell && (c < anchorLow);
                const bullishFlip = !isBullish && isBuy && (c > anchorHigh);

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

                if (bearishFlip) {
                    isBullish = false;

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
                    phaseLow = l;
                    phaseLowIdx = i;

                    if (i === len - 1) {
                        this.dispatchAlert('bear_flip', 'down', c, time, i, newBearBox);
                    }
                }

                if (bullishFlip) {
                    isBullish = true;

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
                    phaseHigh = h;
                    phaseHighIdx = i;

                    if (i === len - 1) {
                        this.dispatchAlert('bull_flip', 'up', c, time, i, newBullBox);
                    }
                }

                if (activeBearBox !== null) {
                    if (c < activeBearBox.bottom || c > activeBearBox.top) {
                        activeBearBox.isOpen = false;
                        activeBearBox.breakoutDir = c > activeBearBox.top ? 'up' : 'down';
                        if (i === len - 1) {
                            this.dispatchAlert('box_breakout', activeBearBox.breakoutDir, c, time, i, activeBearBox);
                        }
                        activeBearBox = null;
                    }
                }

                if (activeBullBox !== null) {
                    if (c > activeBullBox.top || c < activeBullBox.bottom) {
                        activeBullBox.isOpen = false;
                        activeBullBox.breakoutDir = c > activeBullBox.top ? 'up' : 'down';
                        if (i === len - 1) {
                            this.dispatchAlert('box_breakout', activeBullBox.breakoutDir, c, time, i, activeBullBox);
                        }
                        activeBullBox = null;
                    }
                }

                const validContinuation = (isBullish && c > anchorHigh) || (!isBullish && c < anchorLow);

                if (validContinuation || bearishFlip || bullishFlip) {
                    anchorHigh = h;
                    anchorLow = l;
                }

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
     * Batched single draw calls for Bull and Bear zones with viewport culling
     */
    public render(r: ChartRenderer, layout: IndicatorLayout, g: Graphics): void {
        if (!this.visible || r.dataStore.length === 0) {
            return;
        }

        if (this.cachedBoxes.length === 0 || this.lastCalculatedLength !== r.dataStore.length) {
            this.buildCachedBoxes(r.dataStore);
        }

        if (this.cachedBoxes.length === 0) {
            return;
        }

        const borderWidth = Math.max(0.5, this.getParam<number>('borderWidth', 1));
        const bearBg = parseColorAndAlpha(this.getParam<string>('bearBg', '#CC00004D'), 0.30);
        const bearBorder = parseColorAndAlpha(this.getParam<string>('bearBorder', '#CC0000'), 1.0);
        const bullBg = parseColorAndAlpha(this.getParam<string>('bullBg', '#9E9E9E4D'), 0.30);
        const bullBorder = parseColorAndAlpha(this.getParam<string>('bullBorder', '#9E9E9E'), 1.0);

        const screenW = layout.chartWidth;
        const sp = r.candleSpacing * r.zoom;
        const halfSp = sp * 0.45;
        const minX = -40;
        const maxX = screenW + 40;

        interface VisibleZoneGeometry {
            x1: number;
            x2: number;
            yTop: number;
            yBot: number;
            w: number;
            h: number;
        }

        const visibleBull: VisibleZoneGeometry[] = [];
        const visibleBear: VisibleZoneGeometry[] = [];

        for (let i = 0; i < this.cachedBoxes.length; i++) {
            const b = this.cachedBoxes[i];
            const x1 = r.getCandleCenterX(b.leftBar) - halfSp;
            const rightIdx = b.rightBar; // Strictly bounded, never extended to the right side of chart
            const x2 = r.getCandleCenterX(rightIdx) + halfSp;

            // Viewport culling
            if (x2 < minX || x1 > maxX) continue;

            const topPrice = Math.max(b.top, b.bottom);
            const botPrice = Math.min(b.top, b.bottom);
            const yTop = r.priceToY(topPrice);
            const yBot = r.priceToY(botPrice);
            const w = Math.max(2, x2 - x1);
            const h = Math.max(2, yBot - yTop);

            const geom: VisibleZoneGeometry = { x1, x2, yTop, yBot, w, h };
            if (b.type === 'bull') {
                visibleBull.push(geom);
            } else {
                visibleBear.push(geom);
            }
        }

        // Bull Zones (Gray Boxes) - Single Fill & Stroke Batch
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
            g.stroke({ color: bullBorder.color, width: borderWidth, alpha: bullBorder.alpha });
        }

        // Bear Zones (Red Boxes) - Single Fill & Stroke Batch
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
            g.stroke({ color: bearBorder.color, width: borderWidth, alpha: bearBorder.alpha });
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
            valueStr = `▼ Bearish Flip (Anchor: ${fmt(aLow)})`;
            valueColor = bearClr;
        } else if (flip === 1) {
            valueStr = `▲ Bullish Flip (Anchor: ${fmt(aHigh)})`;
            valueColor = bullClr;
        } else if (trend === 1) {
            valueStr = `Bullish Push (Anchor: ${fmt(aHigh)})`;
            valueColor = bullClr;
        } else if (trend === -1) {
            valueStr = `Bearish Pullback (Anchor: ${fmt(aLow)})`;
            valueColor = bearClr;
        } else {
            valueStr = `Strict CBC (H: ${fmt(aHigh)} | L: ${fmt(aLow)})`;
        }

        return {
            label: this.name,
            valueStr,
            valueColor
        };
    }

    public destroy(): void {
        this.cachedBoxes = [];
    }
}
