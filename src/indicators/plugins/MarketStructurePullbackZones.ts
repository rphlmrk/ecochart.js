import { BaseIndicator, parseColorAndAlpha, type IndicatorLayout } from '../Indicator';
import type { DataStore } from '../../data/DataStore';
import { TimeframeResampler } from '../../data/TimeframeResampler';
import type { ChartRenderer } from '../../renderer/ChartRenderer';
import { Graphics } from 'pixi.js';
import { alertManager } from '../../alerts/AlertManager';

export interface PullbackZoneBox {
    leftBar: number;
    rightBar: number;
    topBar: number;
    bottomBar: number;
    top: number;
    bottom: number;
    isOpen: boolean;
    breakoutDir?: 'up' | 'down';
}

export interface HtfBarMapping {
    time: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
    firstChartBar: number;
    lastChartBar: number;
    highChartBar: number;
    lowChartBar: number;
}

/**
 * Market Structure Pullback Zones (Simplified)
 * 
 * Clean, high-performance Market Structure Pullback Zones indicator:
 * - Macro Structure swing period (default 11)
 * - Clean pullback zone boxes plotted between swing pivots
 * - Multi-Timeframe support (Native & Resampled HTF)
 * - Automatic breakout detection for alerts and notifications
 * - Micro structure, text labels, midline/horizontal lines, and breakout candle signals removed for zero clutter
 * - High-speed GPU-accelerated WebGL rendering
 */
export class MarketStructurePullbackZonesIndicator extends BaseIndicator {
    public cachedMacroBoxes: PullbackZoneBox[] = [];
    public cachedMicroBoxes: PullbackZoneBox[] = []; // Maintained for backward compatibility (empty)

    public currentSymbol = 'BTCUSDT';
    private notifiedBreakouts = new Set<string>();

    private lastCalculatedLength = -1;
    private lastStateHash = '';

    constructor() {
        super('MS_PULLBACK_ZONES', 'Market Structure Pullback Zones');
        this.isOscillator = false;
        this.layerType = 'pullback_zone';

        this.params = [
            // Timeframe Selection
            {
                id: 'timeframe',
                name: 'Timeframe',
                type: 'select',
                value: 'Current',
                options: ['Current', '1m', '3m', '5m', '15m', '30m', '45m', '1h', '2h', '3h', '4h', '6h', '8h', '12h', '1d', '3d', '1w', 'Custom HTF']
            },
            { id: 'customTfMins', name: 'Custom Timeframe (Mins)', type: 'number', value: 60, min: 1, max: 43200, step: 1 },

            // Swing Period (Default 11)
            { id: 'macroPrd', name: 'Swing Period', type: 'number', value: 11, min: 2, max: 100, step: 1 },

            // Style Settings
            { id: 'macroBorder', name: 'Border Color', type: 'color', value: '#EF5350' },
            { id: 'macroBg', name: 'Background Color', type: 'color', value: '#EF53501A' },
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
        return MarketStructurePullbackZonesIndicator.getTimeframeOptions(currentInterval);
    }

    public getEffectiveTfMs(chartTfMs: number): number {
        const mode = this.getParam<string>('timeframe', 'Current');
        if (mode === 'Current') return chartTfMs;
        if (mode === 'Custom' || mode === 'Custom HTF') {
            const mins = Math.max(1, this.getParam<number>('customTfMins', 60));
            return Math.max(mins * 60 * 1000, chartTfMs);
        }
        const parsedMs = TimeframeResampler.parseMs(mode.toLowerCase());
        return parsedMs <= chartTfMs ? chartTfMs : parsedMs;
    }

    public isHigherTimeframe(chartTfMs: number): boolean {
        const tfMs = this.getEffectiveTfMs(chartTfMs);
        return tfMs > chartTfMs;
    }

    public override getValueAt(_idx: number, _ds: DataStore, _isDark: boolean, defaultTextClr: number): { label: string; valueStr: string; valueColor: number } {
        const latest = this.getLatestOpenMacroBox();
        const valueStr = latest
            ? `Active: $${latest.bottom.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })} — $${latest.top.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`
            : `${this.cachedMacroBoxes.length} Zones`;
        return {
            label: this.name,
            valueStr,
            valueColor: defaultTextClr
        };
    }

    public getLatestOpenMicroBox(): PullbackZoneBox | null {
        return null;
    }

    public getLatestOpenMacroBox(): PullbackZoneBox | null {
        for (let i = this.cachedMacroBoxes.length - 1; i >= 0; i--) {
            if (this.cachedMacroBoxes[i].isOpen) return this.cachedMacroBoxes[i];
        }
        return null;
    }

    public getPullbackStatus(): {
        microBox: { top: number; bottom: number } | null;
        macroBox: { top: number; bottom: number } | null;
    } {
        const macro = this.getLatestOpenMacroBox();
        return {
            microBox: null,
            macroBox: macro ? { top: macro.top, bottom: macro.bottom } : null
        };
    }

    private dispatchBreakoutAlert(
        direction: 'up' | 'down',
        top: number,
        bottom: number,
        price: number,
        barIndex: number,
        barTime: number
    ): void {
        const sym = this.currentSymbol || 'BTCUSDT';
        const key = `${sym}_macro_${direction}_${barTime || barIndex}`;
        if (this.notifiedBreakouts.has(key)) return;

        this.notifiedBreakouts.add(key);
        if (this.notifiedBreakouts.size > 200) {
            const firstKey = this.notifiedBreakouts.values().next().value;
            if (firstKey) this.notifiedBreakouts.delete(firstKey);
        }

        alertManager.triggerPullbackBreakout(sym, 'macro', direction, price, top, bottom);
    }

    protected override onParamsUpdated(): void {
        const tf = this.getParam<string>('timeframe', 'Current');
        this.name = tf === 'Current' ? 'Market Structure Pullback Zones' : `Market Structure Pullback Zones [${tf}]`;
        this.lastCalculatedLength = -1;
        this.lastStateHash = '';
        this.cachedMacroBoxes = [];
    }

    public override reset(): void {
        this.cachedMacroBoxes = [];
        this.lastCalculatedLength = -1;
        this.lastStateHash = '';
        super.reset();
    }

    public calculate(ds: DataStore): void {
        this.buildCachedBoxes(ds);
    }

    public override update(ds: DataStore, isClosedTick: boolean): void {
        this.buildCachedBoxes(ds);
        super.update(ds, isClosedTick);
    }

    private static isPivotHigh(data: Float64Array, p: number, prd: number): boolean {
        if (p < prd) return false;
        const candidateH = data[p * 6 + 2];
        for (let k = 1; k <= prd; k++) {
            if (data[(p - k) * 6 + 2] > candidateH) return false;
        }
        for (let k = 1; k <= prd; k++) {
            if (data[(p + k) * 6 + 2] >= candidateH) return false;
        }
        return true;
    }

    private static isPivotLow(data: Float64Array, p: number, prd: number): boolean {
        if (p < prd) return false;
        const candidateL = data[p * 6 + 3];
        for (let k = 1; k <= prd; k++) {
            if (data[(p - k) * 6 + 3] < candidateL) return false;
        }
        for (let k = 1; k <= prd; k++) {
            if (data[(p + k) * 6 + 3] <= candidateL) return false;
        }
        return true;
    }

    private buildCachedBoxes(ds: DataStore): void {
        const len = ds.length;
        if (len === 0) {
            this.cachedMacroBoxes = [];
            this.lastCalculatedLength = 0;
            this.lastStateHash = '';
            return;
        }

        const macroPrd = Math.max(2, this.getParam<number>('macroPrd', 11));
        const maxBoxes = 500;

        const chartTfMs = (len >= 2 && ds.data[6] > ds.data[0]) ? (ds.data[6] - ds.data[0]) : 60000;
        const effectiveTfMs = this.getEffectiveTfMs(chartTfMs);
        const isHtfMode = effectiveTfMs > chartTfMs;
        const tfParam = this.getParam<string>('timeframe', 'Current');
        const customTfMins = this.getParam<number>('customTfMins', 60);

        const lastIdx = len - 1;
        const baseLast = lastIdx * 6;
        const lastH = ds.data[baseLast + 2];
        const lastL = ds.data[baseLast + 3];
        const lastC = ds.data[baseLast + 4];

        const stateHash = `${tfParam}:${effectiveTfMs}:${customTfMins}:${macroPrd}:${len}:${lastH}:${lastL}:${lastC}`;
        if (this.lastStateHash === stateHash && this.lastCalculatedLength === len) return;

        const data = ds.data;
        let evalData: Float64Array = data;
        let evalLen: number = len;
        let htfBars: HtfBarMapping[] | null = null;

        if (isHtfMode) {
            htfBars = [];
            let currBucketTime = -1;
            let currHtfBar: HtfBarMapping | null = null;

            for (let i = 0; i < len; i++) {
                const base = i * 6;
                const t = data[base];
                const o = data[base + 1];
                const h = data[base + 2];
                const l = data[base + 3];
                const c = data[base + 4];
                const v = data[base + 5];

                const bTime = TimeframeResampler.getBucketStart(t, effectiveTfMs);
                if (bTime !== currBucketTime) {
                    currBucketTime = bTime;
                    currHtfBar = {
                        time: bTime,
                        open: o,
                        high: h,
                        low: l,
                        close: c,
                        volume: v,
                        firstChartBar: i,
                        lastChartBar: i,
                        highChartBar: i,
                        lowChartBar: i
                    };
                    htfBars.push(currHtfBar);
                } else if (currHtfBar) {
                    currHtfBar.lastChartBar = i;
                    currHtfBar.close = c;
                    currHtfBar.volume += v;
                    if (h > currHtfBar.high) {
                        currHtfBar.high = h;
                        currHtfBar.highChartBar = i;
                    }
                    if (l < currHtfBar.low) {
                        currHtfBar.low = l;
                        currHtfBar.lowChartBar = i;
                    }
                }
            }

            evalLen = htfBars.length;
            if (evalLen < 4) {
                this.cachedMacroBoxes = [];
                this.lastCalculatedLength = len;
                this.lastStateHash = stateHash;
                return;
            }

            evalData = new Float64Array(evalLen * 6);
            for (let i = 0; i < evalLen; i++) {
                const b = htfBars[i];
                const base = i * 6;
                evalData[base] = b.time;
                evalData[base + 1] = b.open;
                evalData[base + 2] = b.high;
                evalData[base + 3] = b.low;
                evalData[base + 4] = b.close;
                evalData[base + 5] = b.volume;
            }
        }

        // Calculate Structure Boxes using swing period (default 11)
        const macroBoxes: PullbackZoneBox[] = [];
        let inMacro = false;
        let macroTop: number | null = null;
        let macroBot: number | null = null;
        let macroTopBar: number | null = null;
        let macroBotBar: number | null = null;
        let lastMacroTop: number | null = null;
        let lastMacroBot: number | null = null;
        let macroBreakBar = 0;
        let macroDir = 0;
        let macroBox: PullbackZoneBox | null = null;

        for (let i = 0; i < evalLen; i++) {
            const base = i * 6;
            const h = evalData[base + 2];
            const l = evalData[base + 3];
            const c = evalData[base + 4];

            if (inMacro && macroBox !== null && macroTop !== null && macroBot !== null) {
                const macroBreakUp = c > macroTop;
                const macroBreakDn = c < macroBot;

                if (macroBreakUp) {
                    inMacro = false;
                    macroBox.isOpen = false;
                    macroBox.breakoutDir = 'up';
                    macroBox.rightBar = i;
                    macroBreakBar = i;
                    macroDir = 1;
                    lastMacroTop = macroTop;
                    lastMacroBot = macroBot;
                    if (i === evalLen - 1) {
                        this.dispatchBreakoutAlert('up', macroTop, macroBot, c, i, evalData[base]);
                    }
                    macroTop = null; macroBot = null; macroTopBar = null; macroBotBar = null; macroBox = null;
                } else if (macroBreakDn) {
                    inMacro = false;
                    macroBox.isOpen = false;
                    macroBox.breakoutDir = 'down';
                    macroBox.rightBar = i;
                    macroBreakBar = i;
                    macroDir = -1;
                    lastMacroTop = macroTop;
                    lastMacroBot = macroBot;
                    if (i === evalLen - 1) {
                        this.dispatchBreakoutAlert('down', macroTop, macroBot, c, i, evalData[base]);
                    }
                    macroTop = null; macroBot = null; macroTopBar = null; macroBotBar = null; macroBox = null;
                } else {
                    if (h > macroTop) {
                        macroTop = h; macroBox.top = h; macroBox.topBar = i;
                    }
                    if (l < macroBot) {
                        macroBot = l; macroBox.bottom = l; macroBox.bottomBar = i;
                    }
                }
            }

            if (!inMacro) {
                const actualMacroPhBar = i - macroPrd;
                const hasMacroPh = actualMacroPhBar >= 0 && MarketStructurePullbackZonesIndicator.isPivotHigh(evalData, actualMacroPhBar, macroPrd);
                const macroPh = hasMacroPh ? evalData[actualMacroPhBar * 6 + 2] : 0;

                const actualMacroPlBar = i - macroPrd;
                const hasMacroPl = actualMacroPlBar >= 0 && MarketStructurePullbackZonesIndicator.isPivotLow(evalData, actualMacroPlBar, macroPrd);
                const macroPl = hasMacroPl ? evalData[actualMacroPlBar * 6 + 3] : 0;

                if (macroDir === 1 && lastMacroBot !== null) {
                    if (c < lastMacroBot) {
                        macroDir = -1;
                        macroBreakBar = i;
                        macroTop = null; macroBot = null; macroTopBar = null; macroBotBar = null;
                    }
                } else if (macroDir === -1 && lastMacroTop !== null) {
                    if (c > lastMacroTop) {
                        macroDir = 1;
                        macroBreakBar = i;
                        macroTop = null; macroBot = null; macroTopBar = null; macroBotBar = null;
                    }
                }

                if (macroDir === 1) {
                    if (hasMacroPh && actualMacroPhBar > macroBreakBar) {
                        if (macroTop === null || macroPh > macroTop) { macroTop = macroPh; macroTopBar = actualMacroPhBar; }
                    }
                    if (macroTop !== null) {
                        if (hasMacroPl && actualMacroPlBar > macroTopBar!) {
                            if (macroBot === null || macroPl < macroBot) { macroBot = macroPl; macroBotBar = actualMacroPlBar; }
                        }
                    }
                } else if (macroDir === -1) {
                    if (hasMacroPl && actualMacroPlBar > macroBreakBar) {
                        if (macroBot === null || macroPl < macroBot) { macroBot = macroPl; macroBotBar = actualMacroPlBar; }
                    }
                    if (macroBot !== null) {
                        if (hasMacroPh && actualMacroPhBar > macroBotBar!) {
                            if (macroTop === null || macroPh > macroTop) { macroTop = macroPh; macroTopBar = actualMacroPhBar; }
                        }
                    }
                } else {
                    if (hasMacroPh && actualMacroPhBar > macroBreakBar) {
                        if (macroTop === null || macroPh > macroTop) { macroTop = macroPh; macroTopBar = actualMacroPhBar; }
                    }
                    if (hasMacroPl && actualMacroPlBar > macroBreakBar) {
                        if (macroBot === null || macroPl < macroBot) { macroBot = macroPl; macroBotBar = actualMacroPlBar; }
                    }
                }

                if (macroTop !== null && macroBot !== null && macroTopBar !== null && macroBotBar !== null) {
                    inMacro = true;
                    macroBox = {
                        leftBar: Math.min(macroTopBar, macroBotBar),
                        rightBar: i,
                        topBar: macroTopBar,
                        bottomBar: macroBotBar,
                        top: macroTop,
                        bottom: macroBot,
                        isOpen: true
                    };
                    macroBoxes.push(macroBox);
                    if (macroBoxes.length > maxBoxes) macroBoxes.shift();
                }
            }
        }

        // Map HTF back to native chart bar coordinates if needed
        if (isHtfMode && htfBars) {
            const mapBox = (b: PullbackZoneBox): PullbackZoneBox => {
                const leftH = htfBars![b.leftBar];
                const rightH = htfBars![b.rightBar];
                const topH = htfBars![b.topBar];
                const botH = htfBars![b.bottomBar];

                const leftBar = leftH ? leftH.firstChartBar : b.leftBar;
                let rightBar = b.isOpen ? (len - 1) : (rightH ? rightH.lastChartBar : b.rightBar);

                if (!b.isOpen && rightH) {
                    let breakChartBar = rightH.lastChartBar;
                    for (let cBar = rightH.firstChartBar; cBar <= rightH.lastChartBar; cBar++) {
                        const cc = data[cBar * 6 + 4];
                        if (b.breakoutDir === 'up' && cc > b.top) {
                            breakChartBar = cBar;
                            break;
                        } else if (b.breakoutDir === 'down' && cc < b.bottom) {
                            breakChartBar = cBar;
                            break;
                        }
                    }
                    rightBar = breakChartBar;
                }

                const topBar = topH ? topH.highChartBar : b.topBar;
                const bottomBar = botH ? botH.lowChartBar : b.bottomBar;

                return {
                    leftBar,
                    rightBar,
                    topBar,
                    bottomBar,
                    top: b.top,
                    bottom: b.bottom,
                    isOpen: b.isOpen,
                    breakoutDir: b.breakoutDir
                };
            };

            this.cachedMacroBoxes = macroBoxes.map(mapBox);
        } else {
            this.cachedMacroBoxes = macroBoxes;
        }

        this.lastCalculatedLength = len;
        this.lastStateHash = stateHash;
    }

    /**
     * Hardware-accelerated GPU Rendering
     */
    public render(r: ChartRenderer, layout: IndicatorLayout, g: Graphics): void {
        if (!this.visible || r.dataStore.length === 0) {
            return;
        }

        if (this.cachedMacroBoxes.length === 0 || this.lastCalculatedLength !== r.dataStore.length) {
            this.buildCachedBoxes(r.dataStore);
        }

        const borderWidth = Math.max(0.5, this.getParam<number>('borderWidth', 1));
        const macroBorder = parseColorAndAlpha(this.getParam<string>('macroBorder', '#EF5350'));
        const macroBg = parseColorAndAlpha(this.getParam<string>('macroBg', '#EF53501A'));

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
            box: PullbackZoneBox;
        }

        const visibleZones: VisibleZoneGeometry[] = [];
        for (let i = 0; i < this.cachedMacroBoxes.length; i++) {
            const b = this.cachedMacroBoxes[i];
            const x1 = r.getCandleCenterX(b.leftBar) - halfSp;
            const rightIdx = b.isOpen ? (dsLength - 1) : b.rightBar;
            const x2 = r.getCandleCenterX(rightIdx) + halfSp;

            if (x2 < minX || x1 > maxX) continue;

            const topPrice = Math.max(b.top, b.bottom);
            const botPrice = Math.min(b.top, b.bottom);
            const yTop = r.priceToY(topPrice);
            const yBot = r.priceToY(botPrice);

            visibleZones.push({
                x1,
                x2,
                yTop,
                yBot,
                w: Math.max(2, x2 - x1),
                h: Math.max(2, yBot - yTop),
                box: b
            });
        }

        if (visibleZones.length === 0) return;

        // Render Pullback Zone Box Fills
        g.beginPath();
        for (const vz of visibleZones) {
            g.rect(vz.x1, vz.yTop, vz.w, vz.h);
        }
        g.fill({ color: macroBg.color, alpha: macroBg.alpha });

        // Render Pullback Zone Box Borders
        g.beginPath();
        for (const vz of visibleZones) {
            g.rect(vz.x1, vz.yTop, vz.w, vz.h);
        }
        g.stroke({ color: macroBorder.color, width: borderWidth, alpha: macroBorder.alpha });
    }

    public destroy(): void {
        this.cachedMacroBoxes = [];
        this.cachedMicroBoxes = [];
    }
}
