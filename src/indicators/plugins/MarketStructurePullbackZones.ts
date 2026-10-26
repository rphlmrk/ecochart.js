import { BaseIndicator, parseColorAndAlpha, type IndicatorLayout } from '../Indicator';
import type { DataStore } from '../../data/DataStore';
import { TimeframeResampler } from '../../data/TimeframeResampler';
import type { ChartRenderer } from '../../renderer/ChartRenderer';
import { StrokeEngine } from '../../renderer/StrokeEngine';
import { Graphics, Container, BitmapText } from 'pixi.js';
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
 * Market Structure Pullback Zones
 * 
 * High-performance Market Structure Pullback Zones indicator with:
 * - Micro Structure (Blue Boxes, fast swing period)
 * - Macro Structure (Red Boxes, trend swing period)
 * - Breakout Signals ('B'/'S' for Macro, 'b'/'s' for Micro)
 * - 50% Midline (Equilibrium) and High/Low reference bounds
 * - Multi-Timeframe support (Native & Resampled HTF)
 * - Bounded pullback swing boxes (no infinite extension)
 * - Hardware-accelerated WebGL GPU rendering with viewport culling
 * - Native AlertManager and Foreground Service integration
 */
export class MarketStructurePullbackZonesIndicator extends BaseIndicator {
    public cachedMicroBoxes: PullbackZoneBox[] = [];
    public cachedMacroBoxes: PullbackZoneBox[] = [];

    public currentSymbol = 'BTCUSDT';
    private notifiedBreakouts = new Set<string>();

    private lastCalculatedLength = -1;
    private lastStateHash = '';

    private labelContainer = new Container();
    private labelTextPool: BitmapText[] = [];
    private isContainerMounted = false;

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

            // Micro Structure Group (Blue Boxes)
            { id: 'showMicro', name: 'Show Micro Structure', type: 'boolean', value: true },
            { id: 'microPrd', name: 'Micro Swing Period', type: 'number', value: 2, min: 1, max: 50, step: 1 },
            { id: 'microBorder', name: 'Micro Border Color', type: 'color', value: '#2962FF' },
            { id: 'microBg', name: 'Micro Background Color', type: 'color', value: '#2962FF26' },

            // Macro Structure Group (Red Boxes)
            { id: 'showMacro', name: 'Show Macro Structure', type: 'boolean', value: true },
            { id: 'macroPrd', name: 'Macro Swing Period', type: 'number', value: 8, min: 3, max: 100, step: 1 },
            { id: 'macroBorder', name: 'Macro Border Color', type: 'color', value: '#EF5350' },
            { id: 'macroBg', name: 'Macro Background Color', type: 'color', value: '#EF53501A' },

            // General Settings
            { id: 'useWicks', name: 'Breakout strictly on wicks?', type: 'boolean', value: false },
            { id: 'extendBoxes', name: 'Extend Boxes to Right', type: 'boolean', value: false },
            { id: 'maxBoxes', name: 'Max Boxes Count', type: 'number', value: 500, min: 10, max: 1000, step: 10 },
            { id: 'borderWidth', name: 'Border Width', type: 'number', value: 1, min: 0.5, max: 4, step: 0.5 },

            // 50% Midline (Equilibrium) Settings
            { id: 'showMidline', name: 'Show 50% Midline (Equilibrium)', type: 'boolean', value: false },
            { id: 'midlineColor', name: '50% Line Color', type: 'color', value: '#EF5350' },
            { id: 'extendMidlineRight', name: 'Extend 50% Line to Right', type: 'boolean', value: false },
            { id: 'extendMidlineCount', name: 'Past Boxes to Extend Line', type: 'number', value: 1, min: 1, max: 20, step: 1 },

            // Box High & Low Horizontal Lines
            { id: 'showHighLowLines', name: 'Draw Box High & Low Lines', type: 'boolean', value: false },
            { id: 'highLowLineColor', name: 'High & Low Lines Color', type: 'color', value: '#EF5350' },
            { id: 'extendHighLowLines', name: 'Extend High & Low Lines to Right', type: 'boolean', value: false },
            { id: 'extendHighLowCount', name: 'Past Boxes to Extend High/Low', type: 'number', value: 1, min: 1, max: 20, step: 1 },

            { id: 'showLabels', name: 'Show Status Labels', type: 'boolean', value: true },

            // Breakout Signals Settings
            { id: 'showBreakoutSignals', name: 'Show Breakout Signals (b/s & B/S)', type: 'boolean', value: true },
            { id: 'buySignalColor', name: 'Buy Signal Color (B/b)', type: 'color', value: '#00E676' },
            { id: 'sellSignalColor', name: 'Sell Signal Color (S/s)', type: 'color', value: '#FF1744' },
            { id: 'macroSignalSize', name: 'Macro Signal Size (B / S)', type: 'number', value: 1.35, min: 0.5, max: 3.0, step: 0.05 },
            { id: 'microSignalSize', name: 'Micro Signal Size (b / s)', type: 'number', value: 1.2, min: 0.5, max: 3.0, step: 0.05 },

            // Breakout Alerts
            { id: 'alertMicroBreakout', name: '🔔 Alert on Micro Box Breakout', type: 'boolean', value: false },
            { id: 'alertMacroBreakout', name: '🔔 Alert on Macro Box Breakout', type: 'boolean', value: false }
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
        const microCount = this.cachedMicroBoxes.length;
        const macroCount = this.cachedMacroBoxes.length;
        return {
            label: this.name,
            valueStr: `Micro: ${microCount} | Macro: ${macroCount}`,
            valueColor: defaultTextClr
        };
    }

    public getLatestOpenMicroBox(): PullbackZoneBox | null {
        for (let i = this.cachedMicroBoxes.length - 1; i >= 0; i--) {
            if (this.cachedMicroBoxes[i].isOpen) return this.cachedMicroBoxes[i];
        }
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
        const micro = this.getLatestOpenMicroBox();
        const macro = this.getLatestOpenMacroBox();
        return {
            microBox: micro ? { top: micro.top, bottom: micro.bottom } : null,
            macroBox: macro ? { top: macro.top, bottom: macro.bottom } : null
        };
    }

    private dispatchBreakoutAlert(
        boxType: 'micro' | 'macro',
        direction: 'up' | 'down',
        top: number,
        bottom: number,
        price: number,
        barIndex: number,
        barTime: number
    ): void {
        const isEnabled = boxType === 'micro'
            ? this.getParam<boolean>('alertMicroBreakout', true)
            : this.getParam<boolean>('alertMacroBreakout', true);
        if (!isEnabled) return;

        const sym = this.currentSymbol || 'BTCUSDT';
        const key = `${sym}_${boxType}_${direction}_${barTime || barIndex}`;
        if (this.notifiedBreakouts.has(key)) return;

        this.notifiedBreakouts.add(key);
        if (this.notifiedBreakouts.size > 200) {
            const firstKey = this.notifiedBreakouts.values().next().value;
            if (firstKey) this.notifiedBreakouts.delete(firstKey);
        }

        alertManager.triggerPullbackBreakout(sym, boxType, direction, price, top, bottom);
    }

    protected override onParamsUpdated(): void {
        const tf = this.getParam<string>('timeframe', 'Current');
        this.name = tf === 'Current' ? 'Market Structure Pullback Zones' : `Market Structure Pullback Zones [${tf}]`;
        this.lastCalculatedLength = -1;
        this.lastStateHash = '';
        this.cachedMicroBoxes = [];
        this.cachedMacroBoxes = [];
    }

    public override reset(): void {
        this.cachedMicroBoxes = [];
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
            this.cachedMicroBoxes = [];
            this.cachedMacroBoxes = [];
            this.lastCalculatedLength = 0;
            this.lastStateHash = '';
            return;
        }

        const showMicro = this.getParam<boolean>('showMicro', true);
        const microPrd = Math.max(1, this.getParam<number>('microPrd', 2));
        const showMacro = this.getParam<boolean>('showMacro', true);
        const macroPrd = Math.max(3, this.getParam<number>('macroPrd', 8));
        const useWicks = this.getParam<boolean>('useWicks', false);
        const extendBoxes = this.getParam<boolean>('extendBoxes', false);
        const maxBoxes = Math.max(10, Math.min(1000, this.getParam<number>('maxBoxes', 500)));

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

        const stateHash = `${tfParam}:${effectiveTfMs}:${customTfMins}:${showMicro}:${microPrd}:${showMacro}:${macroPrd}:${useWicks}:${extendBoxes}:${maxBoxes}:${len}:${lastH}:${lastL}:${lastC}`;
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
                this.cachedMicroBoxes = [];
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

        // 1. Calculate Macro Structure FIRST
        const macroBoxes: PullbackZoneBox[] = [];
        if (showMacro) {
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
                    if (extendBoxes) {
                        macroBox.rightBar = i;
                    }

                    const macroBreakUp = useWicks ? h > macroTop : c > macroTop;
                    const macroBreakDn = useWicks ? l < macroBot : c < macroBot;

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
                            this.dispatchBreakoutAlert('macro', 'up', macroTop, macroBot, useWicks ? h : c, i, evalData[base]);
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
                            this.dispatchBreakoutAlert('macro', 'down', macroTop, macroBot, useWicks ? l : c, i, evalData[base]);
                        }
                        macroTop = null; macroBot = null; macroTopBar = null; macroBotBar = null; macroBox = null;
                    } else if (!useWicks) {
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
                        if (useWicks ? l < lastMacroBot : c < lastMacroBot) {
                            macroDir = -1;
                            macroBreakBar = i;
                            macroTop = null; macroBot = null; macroTopBar = null; macroBotBar = null;
                        }
                    } else if (macroDir === -1 && lastMacroTop !== null) {
                        if (useWicks ? h > lastMacroTop : c > lastMacroTop) {
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
        }

        // 2. Calculate Micro Structure SECOND
        const microBoxes: PullbackZoneBox[] = [];
        if (showMicro) {
            let inMicro = false;
            let microTop: number | null = null;
            let microBot: number | null = null;
            let microTopBar: number | null = null;
            let microBotBar: number | null = null;
            let lastMicroTop: number | null = null;
            let lastMicroBot: number | null = null;
            let microBreakBar = 0;
            let microDir = 0;
            let microBox: PullbackZoneBox | null = null;

            for (let i = 0; i < evalLen; i++) {
                const base = i * 6;
                const h = evalData[base + 2];
                const l = evalData[base + 3];
                const c = evalData[base + 4];

                if (inMicro && microBox !== null && microTop !== null && microBot !== null) {
                    if (extendBoxes) {
                        microBox.rightBar = i;
                    }

                    const microBreakUp = useWicks ? h > microTop : c > microTop;
                    const microBreakDn = useWicks ? l < microBot : c < microBot;

                    if (microBreakUp) {
                        inMicro = false;
                        microBox.isOpen = false;
                        microBox.breakoutDir = 'up';
                        microBox.rightBar = i;
                        microBreakBar = i;
                        microDir = 1;
                        lastMicroTop = microTop;
                        lastMicroBot = microBot;
                        if (i === evalLen - 1) {
                            this.dispatchBreakoutAlert('micro', 'up', microTop, microBot, useWicks ? h : c, i, evalData[base]);
                        }
                        microTop = null; microBot = null; microTopBar = null; microBotBar = null; microBox = null;
                    } else if (microBreakDn) {
                        inMicro = false;
                        microBox.isOpen = false;
                        microBox.breakoutDir = 'down';
                        microBox.rightBar = i;
                        microBreakBar = i;
                        microDir = -1;
                        lastMicroTop = microTop;
                        lastMicroBot = microBot;
                        if (i === evalLen - 1) {
                            this.dispatchBreakoutAlert('micro', 'down', microTop, microBot, useWicks ? l : c, i, evalData[base]);
                        }
                        microTop = null; microBot = null; microTopBar = null; microBotBar = null; microBox = null;
                    } else if (!useWicks) {
                        if (h > microTop) {
                            microTop = h; microBox.top = h; microBox.topBar = i;
                        }
                        if (l < microBot) {
                            microBot = l; microBox.bottom = l; microBox.bottomBar = i;
                        }
                    }
                }

                if (!inMicro) {
                    const actualPhBar = i - microPrd;
                    const hasPh = actualPhBar >= 0 && MarketStructurePullbackZonesIndicator.isPivotHigh(evalData, actualPhBar, microPrd);
                    const ph = hasPh ? evalData[actualPhBar * 6 + 2] : 0;

                    const actualPlBar = i - microPrd;
                    const hasPl = actualPlBar >= 0 && MarketStructurePullbackZonesIndicator.isPivotLow(evalData, actualPlBar, microPrd);
                    const pl = hasPl ? evalData[actualPlBar * 6 + 3] : 0;

                    if (microDir === 1 && lastMicroBot !== null) {
                        if (useWicks ? l < lastMicroBot : c < lastMicroBot) {
                            microDir = -1;
                            microBreakBar = i;
                            microTop = null; microBot = null; microTopBar = null; microBotBar = null;
                        }
                    } else if (microDir === -1 && lastMicroTop !== null) {
                        if (useWicks ? h > lastMicroTop : c > lastMicroTop) {
                            microDir = 1;
                            microBreakBar = i;
                            microTop = null; microBot = null; microTopBar = null; microBotBar = null;
                        }
                    }

                    if (microDir === 1) {
                        if (hasPh && actualPhBar > microBreakBar) {
                            if (microTop === null || ph > microTop) { microTop = ph; microTopBar = actualPhBar; }
                        }
                        if (microTop !== null) {
                            if (hasPl && actualPlBar > microTopBar!) {
                                if (microBot === null || pl < microBot) { microBot = pl; microBotBar = actualPlBar; }
                            }
                        }
                    } else if (microDir === -1) {
                        if (hasPl && actualPlBar > microBreakBar) {
                            if (microBot === null || pl < microBot) { microBot = pl; microBotBar = actualPlBar; }
                        }
                        if (microBot !== null) {
                            if (hasPh && actualPhBar > microBotBar!) {
                                if (microTop === null || ph > microTop) { microTop = ph; microTopBar = actualPhBar; }
                            }
                        }
                    } else {
                        if (hasPh && actualPhBar > microBreakBar) {
                            if (microTop === null || ph > microTop) { microTop = ph; microTopBar = actualPhBar; }
                        }
                        if (hasPl && actualPlBar > microBreakBar) {
                            if (microBot === null || pl < microBot) { microBot = pl; microBotBar = actualPlBar; }
                        }
                    }

                    if (microTop !== null && microBot !== null && microTopBar !== null && microBotBar !== null) {
                        inMicro = true;
                        microBox = {
                            leftBar: Math.min(microTopBar, microBotBar),
                            rightBar: i,
                            topBar: microTopBar,
                            bottomBar: microBotBar,
                            top: microTop,
                            bottom: microBot,
                            isOpen: true
                        };
                        microBoxes.push(microBox);
                        if (microBoxes.length > maxBoxes) microBoxes.shift();
                    }
                }
            }

            // --- Resolve Overlap: Micro vs Macro ---
            let resolvedMicroBoxes: PullbackZoneBox[] = microBoxes;
            if (showMacro && macroBoxes.length > 0) {
                resolvedMicroBoxes = [];
                for (const uBox of microBoxes) {
                    let keep = true;
                    for (const mBox of macroBoxes) {
                        const mLeft = mBox.leftBar;
                        const mRight = mBox.isOpen ? (evalLen - 1) : mBox.rightBar;

                        if (uBox.leftBar <= mRight && uBox.rightBar >= mLeft) {
                            if (uBox.leftBar >= mLeft) {
                                keep = false;
                                break;
                            } else {
                                uBox.rightBar = mLeft;
                                uBox.isOpen = false;
                                uBox.breakoutDir = undefined;
                                break;
                            }
                        }
                    }
                    if (keep && uBox.rightBar >= uBox.leftBar) {
                        resolvedMicroBoxes.push(uBox);
                    }
                }
            }
            microBoxes.length = 0;
            microBoxes.push(...resolvedMicroBoxes);
        }

        // Map HTF back to native chart bar coordinates
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
                        const ch = data[cBar * 6 + 2];
                        const cl = data[cBar * 6 + 3];
                        const cc = data[cBar * 6 + 4];
                        if (b.breakoutDir === 'up') {
                            if (useWicks ? ch > b.top : cc > b.top) {
                                breakChartBar = cBar;
                                break;
                            }
                        } else if (b.breakoutDir === 'down') {
                            if (useWicks ? cl < b.bottom : cc < b.bottom) {
                                breakChartBar = cBar;
                                break;
                            }
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
            this.cachedMicroBoxes = showMicro ? microBoxes.map(mapBox) : [];
        } else {
            this.cachedMacroBoxes = macroBoxes;
            this.cachedMicroBoxes = showMicro ? microBoxes : [];
        }

        this.lastCalculatedLength = len;
        this.lastStateHash = stateHash;
    }

    /**
     * Hardware-accelerated GPU Rendering
     */
    public render(r: ChartRenderer, layout: IndicatorLayout, g: Graphics): void {
        if (!this.visible || r.dataStore.length === 0) {
            this.labelContainer.visible = false;
            return;
        }

        if ((this.cachedMicroBoxes.length === 0 && this.cachedMacroBoxes.length === 0) || this.lastCalculatedLength !== r.dataStore.length) {
            this.buildCachedBoxes(r.dataStore);
        }

        const showMicro = this.getParam<boolean>('showMicro', true);
        const showMacro = this.getParam<boolean>('showMacro', true);
        const showBreakoutSignals = this.getParam<boolean>('showBreakoutSignals', true);
        const macroSignalSize = Math.max(0.5, this.getParam<number>('macroSignalSize', 1.35));
        const microSignalSize = Math.max(0.5, this.getParam<number>('microSignalSize', 1.2));
        const showMidline = this.getParam<boolean>('showMidline', false);
        const extendMidlineRight = this.getParam<boolean>('extendMidlineRight', false);
        const extendMidlineCount = Math.max(1, this.getParam<number>('extendMidlineCount', 1));
        const showHighLowLines = this.getParam<boolean>('showHighLowLines', false);
        const extendHighLowLines = this.getParam<boolean>('extendHighLowLines', false);
        const extendHighLowCount = Math.max(1, this.getParam<number>('extendHighLowCount', 1));
        const showLabels = this.getParam<boolean>('showLabels', true);
        const extendBoxes = this.getParam<boolean>('extendBoxes', false);

        const borderWidth = Math.max(0.5, this.getParam<number>('borderWidth', 1));

        const microBorder = parseColorAndAlpha(this.getParam<string>('microBorder', '#2962FF'));
        const microBg = parseColorAndAlpha(this.getParam<string>('microBg', '#2962FF26'));
        const macroBorder = parseColorAndAlpha(this.getParam<string>('macroBorder', '#EF5350'));
        const macroBg = parseColorAndAlpha(this.getParam<string>('macroBg', '#EF53501A'));
        const midlineColor = parseColorAndAlpha(this.getParam<string>('midlineColor', '#EF5350'));
        const highLowLineColor = parseColorAndAlpha(this.getParam<string>('highLowLineColor', '#EF5350'));

        const buySignalColor = parseColorAndAlpha(this.getParam<string>('buySignalColor', '#00E676'));
        const sellSignalColor = parseColorAndAlpha(this.getParam<string>('sellSignalColor', '#FF1744'));

        const screenW = layout.chartWidth;
        const sp = r.candleSpacing * r.zoom;
        const halfSp = sp * 0.45;
        const minX = -40;
        const maxX = screenW + 40;
        const dsLength = r.dataStore.length;

        interface VisibleZoneGeometry {
            x1: number;
            x2: number;
            midlineEndX?: number;
            hlLineEndX?: number;
            yTop: number;
            yBot: number;
            w: number;
            h: number;
            yMid: number;
            box: PullbackZoneBox;
        }

        const visibleMicro: VisibleZoneGeometry[] = [];
        if (showMicro) {
            for (let i = 0; i < this.cachedMicroBoxes.length; i++) {
                const b = this.cachedMicroBoxes[i];
                const x1 = r.getCandleCenterX(b.leftBar) - halfSp;
                const rightIdx = (extendBoxes && b.isOpen) ? (dsLength - 1) : b.rightBar;
                const x2 = r.getCandleCenterX(rightIdx) + halfSp;
                if (x2 < minX || x1 > maxX) continue;

                const topPrice = Math.max(b.top, b.bottom);
                const botPrice = Math.min(b.top, b.bottom);
                const yTop = r.priceToY(topPrice);
                const yBot = r.priceToY(botPrice);
                visibleMicro.push({
                    x1,
                    x2,
                    yTop,
                    yBot,
                    w: Math.max(2, x2 - x1),
                    h: Math.max(2, yBot - yTop),
                    yMid: r.priceToY((topPrice + botPrice) * 0.5),
                    box: b
                });
            }
        }

        const visibleMacro: VisibleZoneGeometry[] = [];
        if (showMacro) {
            for (let i = 0; i < this.cachedMacroBoxes.length; i++) {
                const b = this.cachedMacroBoxes[i];
                const dist = (this.cachedMacroBoxes.length - 1) - i;
                const isMidlineExtended = extendMidlineRight && (dist < extendMidlineCount);
                const isHLExtended = extendHighLowLines && (dist < extendHighLowCount);

                const x1 = r.getCandleCenterX(b.leftBar) - halfSp;
                const rightIdx = (extendBoxes && b.isOpen) ? (dsLength - 1) : b.rightBar;
                const x2 = r.getCandleCenterX(rightIdx) + halfSp;
                const midlineEndX = isMidlineExtended ? Math.max(x2, screenW) : x2;
                const hlLineEndX = isHLExtended ? Math.max(x2, screenW) : x2;
                const anyLineExt = (showMidline && isMidlineExtended) || (showHighLowLines && isHLExtended);

                if (x2 < minX && !anyLineExt) continue;
                if (x1 > maxX) continue;

                const topPrice = Math.max(b.top, b.bottom);
                const botPrice = Math.min(b.top, b.bottom);
                const yTop = r.priceToY(topPrice);
                const yBot = r.priceToY(botPrice);
                visibleMacro.push({
                    x1,
                    x2,
                    midlineEndX,
                    hlLineEndX,
                    yTop,
                    yBot,
                    w: Math.max(2, x2 - x1),
                    h: Math.max(2, yBot - yTop),
                    yMid: r.priceToY((topPrice + botPrice) * 0.5),
                    box: b
                });
            }
        }

        // --- Render Micro Boxes (Blue) ---
        if (visibleMicro.length > 0) {
            g.beginPath();
            for (const vb of visibleMicro) g.rect(vb.x1, vb.yTop, vb.w, vb.h);
            g.fill({ color: microBg.color, alpha: microBg.alpha });

            g.beginPath();
            for (const vb of visibleMicro) g.rect(vb.x1, vb.yTop, vb.w, vb.h);
            g.stroke({ color: microBorder.color, width: borderWidth, alpha: microBorder.alpha });
        }

        // --- Render Macro Boxes (Red) ---
        if (visibleMacro.length > 0) {
            g.beginPath();
            for (const vb of visibleMacro) if (vb.x2 >= minX) g.rect(vb.x1, vb.yTop, vb.w, vb.h);
            g.fill({ color: macroBg.color, alpha: macroBg.alpha });

            g.beginPath();
            for (const vb of visibleMacro) if (vb.x2 >= minX) g.rect(vb.x1, vb.yTop, vb.w, vb.h);
            g.stroke({ color: macroBorder.color, width: borderWidth, alpha: macroBorder.alpha });

            if (showMidline) {
                g.beginPath();
                for (const vb of visibleMacro) {
                    const sx = Math.max(0, vb.x1);
                    const ex = Math.min(screenW, vb.midlineEndX ?? vb.x2);
                    if (ex > sx) StrokeEngine.addDashedLinePath(g, sx, vb.yMid, ex, vb.yMid, 'dashed', 6, 4);
                }
                g.stroke({ color: midlineColor.color, width: Math.max(1.5, borderWidth), alpha: Math.min(1, Math.max(0.8, midlineColor.alpha)) });
            }

            if (showHighLowLines) {
                g.beginPath();
                for (const vb of visibleMacro) {
                    const sx = Math.max(0, vb.x1);
                    const ex = Math.min(screenW, vb.hlLineEndX ?? vb.x2);
                    if (ex > sx) {
                        g.moveTo(sx, vb.yTop).lineTo(ex, vb.yTop);
                        g.moveTo(sx, vb.yBot).lineTo(ex, vb.yBot);
                    }
                }
                g.stroke({ color: highLowLineColor.color, width: Math.max(1, borderWidth), alpha: Math.min(1, Math.max(0.85, highLowLineColor.alpha)) });
            }
        }

        // --- Setup Labels & Breakout Signals ---
        const needLabels = showLabels || showBreakoutSignals;
        if (needLabels) {
            const parent = r.strictCbcContainer || r.app.stage;
            if (!this.isContainerMounted || this.labelContainer.parent !== parent) {
                if (this.labelContainer.parent) {
                    this.labelContainer.parent.removeChild(this.labelContainer);
                }
                parent.addChild(this.labelContainer);
                this.isContainerMounted = true;
            }
            this.labelContainer.visible = true;

            for (let i = 0; i < this.labelTextPool.length; i++) this.labelTextPool[i].visible = false;
            let activeTextCount = 0;

            const placeLabel = (text: string, xPos: number, yPos: number, tintColor: number, scale = 1) => {
                let item: BitmapText;
                if (activeTextCount < this.labelTextPool.length) {
                    item = this.labelTextPool[activeTextCount];
                } else {
                    item = new BitmapText({ text: '', style: { fontFamily: 'ChartFont', fontSize: 10, fontWeight: 'bold' } });
                    this.labelTextPool.push(item);
                    this.labelContainer.addChild(item);
                }
                item.text = text;
                item.tint = tintColor;
                item.scale.set(scale);
                item.x = xPos;
                item.y = yPos;
                item.visible = true;
                activeTextCount++;
            };

            // Box Status Labels
            if (showLabels) {
                if (showMicro) {
                    for (const vb of visibleMicro) {
                        if (vb.x1 <= screenW - 30) {
                            const txt = vb.box.isOpen ? 'MICRO PULLBACK' : (vb.box.breakoutDir === 'up' ? 'MICRO BRK UP' : 'MICRO BRK DN');
                            placeLabel(txt, Math.max(4, vb.x1 + 3), Math.max(12, vb.yTop - 11), microBorder.color);
                        }
                    }
                }
                if (showMacro) {
                    for (const vb of visibleMacro) {
                        if (vb.x1 <= screenW - 30 && vb.x2 >= minX) {
                            const txt = vb.box.isOpen ? 'MACRO PULLBACK' : (vb.box.breakoutDir === 'up' ? 'MACRO BRK UP' : 'MACRO BRK DN');
                            placeLabel(txt, Math.max(4, vb.x1 + 3), Math.max(12, vb.yTop - 11), macroBorder.color);
                        }
                        if (showMidline) {
                            const endX = Math.min(screenW, vb.midlineEndX ?? vb.x2);
                            const lblX = Math.min(screenW - 34, endX - 30);
                            if (lblX >= 0) placeLabel('50%', lblX, Math.max(12, vb.yMid - 10), midlineColor.color);
                        }
                    }
                }
            }

            // Breakout Signals on Candle (Micro: b / s, Macro: B / S)
            if (showBreakoutSignals) {
                const dsData = r.dataStore.data;

                // Macro Breakouts: Large uppercase 'B' / 'S'
                if (showMacro) {
                    const halfW = Math.round(3.5 * macroSignalSize);
                    const topOffset = Math.round(5 + 10 * macroSignalSize);
                    for (const b of this.cachedMacroBoxes) {
                        if (b.isOpen || !b.breakoutDir) continue;
                        const bar = b.rightBar;
                        if (bar < 0 || bar >= r.dataStore.length) continue;
                        const cx = r.getCandleCenterX(bar);
                        if (cx < minX || cx > maxX) continue;

                        if (b.breakoutDir === 'up') {
                            const low = dsData[bar * 6 + 3];
                            placeLabel('B', cx - halfW, r.priceToY(low) + 6, buySignalColor.color, macroSignalSize);
                        } else {
                            const high = dsData[bar * 6 + 2];
                            placeLabel('S', cx - halfW, r.priceToY(high) - topOffset, sellSignalColor.color, macroSignalSize);
                        }
                    }
                }

                // Micro Breakouts: Small lowercase 'b' / 's'
                if (showMicro) {
                    const halfW = Math.round(3 * microSignalSize);
                    const topOffset = Math.round(5 + 10 * microSignalSize);
                    for (const b of this.cachedMicroBoxes) {
                        if (b.isOpen || !b.breakoutDir) continue;
                        const bar = b.rightBar;
                        if (bar < 0 || bar >= r.dataStore.length) continue;
                        const cx = r.getCandleCenterX(bar);
                        if (cx < minX || cx > maxX) continue;

                        if (b.breakoutDir === 'up') {
                            const low = dsData[bar * 6 + 3];
                            placeLabel('b', cx - halfW, r.priceToY(low) + 6, buySignalColor.color, microSignalSize);
                        } else {
                            const high = dsData[bar * 6 + 2];
                            placeLabel('s', cx - halfW, r.priceToY(high) - topOffset, sellSignalColor.color, microSignalSize);
                        }
                    }
                }
            }
        } else {
            this.labelContainer.visible = false;
        }
    }

    public destroy(): void {
        this.labelContainer.visible = false;
        for (let i = 0; i < this.labelTextPool.length; i++) this.labelTextPool[i].visible = false;
        if (this.labelContainer.parent) this.labelContainer.parent.removeChild(this.labelContainer);
        this.isContainerMounted = false;
    }
}
