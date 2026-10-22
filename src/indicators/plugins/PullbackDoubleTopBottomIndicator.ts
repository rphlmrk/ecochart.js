import { BaseIndicator, parseColorAndAlpha, type IndicatorLayout } from '../Indicator';
import type { DataStore } from '../../data/DataStore';
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

export interface DoublePattern {
    startBar: number;
    endBar: number;
    price: number;
    type: 'DT' | 'DB';
    isMicro: boolean;
}

export class PullbackDoubleTopBottomIndicator extends BaseIndicator {
    public cachedMicroBoxes: PullbackZoneBox[] = [];
    public cachedMacroBoxes: PullbackZoneBox[] = [];
    public cachedPatterns: DoublePattern[] = [];
    
    public currentSymbol = 'BTCUSDT';
    private notifiedBreakouts = new Set<string>();

    private lastCalculatedLength = -1;
    private lastStateHash = '';

    private labelContainer = new Container();
    private labelTextPool: BitmapText[] = [];
    private isContainerMounted = false;

    constructor() {
        super('MS_PULLBACK_DTDB', 'Market Structure Double Top & Bottom');
        this.isOscillator = false;

        this.params = [
            // Double Top & Bottom Detection Settings
            { id: 'showPatterns', name: 'Show DT / DB Patterns', type: 'boolean', value: true },
            { id: 'dtDbTolerance', name: 'DT/DB Price Tolerance %', type: 'number', value: 0.2, min: 0.01, max: 5.0, step: 0.05 },
            { id: 'dtColor', name: 'Double Top Color', type: 'color', value: '#FF1744' },
            { id: 'dbColor', name: 'Double Bottom Color', type: 'color', value: '#00E676' },
            { id: 'dtDbWidth', name: 'DT/DB Line Width', type: 'number', value: 2, min: 1, max: 5, step: 1 },

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
            { id: 'maxBoxes', name: 'Max Boxes Count', type: 'number', value: 500, min: 10, max: 1000, step: 10 },
            { id: 'borderWidth', name: 'Border Width', type: 'number', value: 1, min: 1, max: 4, step: 0.5 },

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

            // Breakout Alerts
            { id: 'alertMicroBreakout', name: '🔔 Alert on Micro Box Breakout', type: 'boolean', value: false },
            { id: 'alertMacroBreakout', name: '🔔 Alert on Macro Box Breakout', type: 'boolean', value: false }
        ];
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

    private dispatchBreakoutAlert(boxType: 'micro' | 'macro', direction: 'up' | 'down', top: number, bottom: number, price: number, barIndex: number, barTime: number): void {
        const isEnabled = boxType === 'micro' ? this.getParam<boolean>('alertMicroBreakout', true) : this.getParam<boolean>('alertMacroBreakout', true);
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
        this.lastCalculatedLength = -1;
        this.lastStateHash = '';
        this.cachedMicroBoxes = [];
        this.cachedMacroBoxes = [];
        this.cachedPatterns = [];
    }

    public override reset(): void {
        this.cachedMicroBoxes = [];
        this.cachedMacroBoxes = [];
        this.cachedPatterns = [];
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

    /**
     * Advanced State Machine to detect Exact Wick Alignment Rejections.
     * Incorporates strict 50% Midline rule and ensures patterns strictly anchor
     * to the defining structural extremes.
     * Caps the tolerance to a maximum of 15% of the box range to ensure "almost equal" highs/lows.
     */
    private findInternalPatterns(boxes: PullbackZoneBox[], isMicro: boolean, ds: DataStore, macroBoxes: PullbackZoneBox[]) {
        const userTolerancePct = this.getParam<number>('dtDbTolerance', 0.2) / 100;
        const data = ds.data;
        
        for (const box of boxes) {
            const start = box.leftBar;
            const end = box.rightBar;
            const midline = (box.top + box.bottom) / 2;
            const boxRange = box.top - box.bottom;

            // Cap the tolerance to a maximum of 15% of the box's height to ensure only true edge tests trigger
            const maxRangeTol = boxRange * 0.15;
            const topTol = Math.min(box.top * userTolerancePct, maxRangeTol);
            const botTol = Math.min(box.bottom * userTolerancePct, maxRangeTol);
            
            const topZone = box.top - topTol;
            const botZone = box.bottom + botTol;

            let dtState = 0; // 0: Wait for structural top, 1: Wait 50% Drop, 2: Wait Re-test, 3: Wait Rejection
            let dbState = 0; // 0: Wait for structural bot, 1: Wait 50% Rise, 2: Wait Re-test, 3: Wait Rejection

            let dtStartBar = box.topBar;
            let dbStartBar = box.bottomBar;
            let dtTouchBar = -1;
            let dbTouchBar = -1;
            
            // Keep track of the active patterns to extend them to the latest rejection
            let activeDt: DoublePattern | null = null;
            let activeDb: DoublePattern | null = null;

            // 1. Initialize Exact Wick Alignment CBC state for this box
            const startOpen = data[start * 6 + 1];
            const startClose = data[start * 6 + 4];
            let cbc = startClose >= startOpen; 
            
            let trackedHigh = data[start * 6 + 2];
            let trackedLow = data[start * 6 + 3];
            
            // 2. Scan box internals using State Machine
            for (let i = start; i <= end; i++) {
                const h = data[i * 6 + 2];
                const l = data[i * 6 + 3];
                const c = data[i * 6 + 4];

                let bearSignal = false;
                let bullSignal = false;

                // --- CORE EXACT WICK ALIGNMENT CBC LOGIC ---
                if (c < trackedLow) {
                    if (cbc) { cbc = false; bearSignal = true; }
                    trackedHigh = h; trackedLow = l;
                } else if (c > trackedHigh) {
                    if (!cbc) { cbc = true; bullSignal = true; }
                    trackedHigh = h; trackedLow = l;
                } else {
                    if (h > trackedHigh) trackedHigh = h;
                    if (l < trackedLow) trackedLow = l;
                }

                // --- DOUBLE TOP STATE MACHINE ---
                if (dtState === 0) {
                    if (i >= box.topBar) {
                        dtState = 1;
                    }
                } else if (dtState === 1) {
                    if (l <= midline) {
                        dtState = 2; // Hit 50% equilibrium, ready for re-test
                    }
                } else if (dtState === 2) {
                    if (h >= topZone) { 
                        dtTouchBar = i; 
                        dtState = 3; 
                    }
                } else if (dtState === 3) {
                    if (h >= topZone && h > data[dtTouchBar * 6 + 2]) {
                        dtTouchBar = i; // Sweeping the re-test higher before rejection
                    }
                    
                    const touchLow = data[dtTouchBar * 6 + 3];
                    const priceDropped = (!cbc && c < touchLow);

                    if (bearSignal || priceDropped) {
                        let isOverlapping = false;
                        if (isMicro) {
                            for (const mBox of macroBoxes) {
                                const timeOverlap = (box.rightBar >= mBox.leftBar && box.leftBar <= mBox.rightBar);
                                const priceOverlap = (Math.abs(box.top - mBox.top) <= topTol);
                                if (timeOverlap && priceOverlap) {
                                    isOverlapping = true; break;
                                }
                            }
                        }
                        
                        if (!isOverlapping) {
                            if (!activeDt) {
                                activeDt = {
                                    startBar: dtStartBar,
                                    endBar: dtTouchBar,
                                    price: box.top,
                                    type: 'DT',
                                    isMicro
                                };
                                this.cachedPatterns.push(activeDt);
                            } else {
                                // Extend the existing DT to this latest valid rejection!
                                activeDt.endBar = dtTouchBar;
                            }
                        }
                        // Reset to state 2 so it can catch subsequent re-tests and extend the line
                        dtState = 2; 
                    }
                }

                // --- DOUBLE BOTTOM STATE MACHINE ---
                if (dbState === 0) {
                    if (i >= box.bottomBar) {
                        dbState = 1; 
                    }
                } else if (dbState === 1) {
                    if (h >= midline) {
                        dbState = 2; // Hit 50% equilibrium, ready for re-test
                    }
                } else if (dbState === 2) {
                    if (l <= botZone) { 
                        dbTouchBar = i; 
                        dbState = 3; 
                    }
                } else if (dbState === 3) {
                    if (l <= botZone && l < data[dbTouchBar * 6 + 3]) {
                        dbTouchBar = i; // Sweeping the re-test lower before rejection
                    }
                    
                    const touchHigh = data[dbTouchBar * 6 + 2];
                    const priceRose = (cbc && c > touchHigh);

                    if (bullSignal || priceRose) {
                        let isOverlapping = false;
                        if (isMicro) {
                            for (const mBox of macroBoxes) {
                                const timeOverlap = (box.rightBar >= mBox.leftBar && box.leftBar <= mBox.rightBar);
                                const priceOverlap = (Math.abs(box.bottom - mBox.bottom) <= botTol);
                                if (timeOverlap && priceOverlap) {
                                    isOverlapping = true; break;
                                }
                            }
                        }

                        if (!isOverlapping) {
                            if (!activeDb) {
                                activeDb = {
                                    startBar: dbStartBar,
                                    endBar: dbTouchBar,
                                    price: box.bottom,
                                    type: 'DB',
                                    isMicro
                                };
                                this.cachedPatterns.push(activeDb);
                            } else {
                                // Extend the existing DB to this latest valid rejection!
                                activeDb.endBar = dbTouchBar;
                            }
                        }
                        // Reset to state 2 so it can catch subsequent re-tests and extend the line
                        dbState = 2; 
                    }
                }
            }
        }
    }

    private buildCachedBoxes(ds: DataStore): void {
        const len = ds.length;
        if (len === 0) {
            this.cachedMicroBoxes = [];
            this.cachedMacroBoxes = [];
            this.cachedPatterns = [];
            this.lastCalculatedLength = 0;
            this.lastStateHash = '';
            return;
        }

        const showMicro = this.getParam<boolean>('showMicro', true);
        const microPrd = Math.max(1, this.getParam<number>('microPrd', 2));
        const showMacro = this.getParam<boolean>('showMacro', true);
        const macroPrd = Math.max(3, this.getParam<number>('macroPrd', 8));
        const useWicks = this.getParam<boolean>('useWicks', false);
        const maxBoxes = Math.max(10, Math.min(1000, this.getParam<number>('maxBoxes', 500)));
        const tolerance = this.getParam<number>('dtDbTolerance', 0.2);

        const lastIdx = len - 1;
        const baseLast = lastIdx * 6;
        const lastH = ds.data[baseLast + 2];
        const lastL = ds.data[baseLast + 3];
        const lastC = ds.data[baseLast + 4];

        const stateHash = `${showMicro}:${microPrd}:${showMacro}:${macroPrd}:${useWicks}:${maxBoxes}:${tolerance}:${len}:${lastH}:${lastL}:${lastC}`;
        if (this.lastStateHash === stateHash && this.lastCalculatedLength === len) return;

        const data = ds.data;
        this.cachedPatterns = []; 

        // 1. Calculate Macro Structure FIRST (So Micro can check against it)
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

            for (let i = 0; i < len; i++) {
                const base = i * 6;
                const h = data[base + 2];
                const l = data[base + 3];
                const c = data[base + 4];

                if (inMacro && macroBox !== null && macroTop !== null && macroBot !== null) {
                    macroBox.rightBar = i;

                    const macroBreakUp = useWicks ? h > macroTop : c > macroTop;
                    const macroBreakDn = useWicks ? l < macroBot : c < macroBot;

                    if (macroBreakUp) {
                        inMacro = false; macroBox.isOpen = false; macroBox.breakoutDir = 'up';
                        macroBreakBar = i; macroDir = 1; lastMacroTop = macroTop; lastMacroBot = macroBot;
                        if (i === len - 1) this.dispatchBreakoutAlert('macro', 'up', macroTop, macroBot, useWicks ? h : c, i, data[base]);
                        macroTop = null; macroBot = null; macroTopBar = null; macroBotBar = null; macroBox = null;
                    } else if (macroBreakDn) {
                        inMacro = false; macroBox.isOpen = false; macroBox.breakoutDir = 'down';
                        macroBreakBar = i; macroDir = -1; lastMacroTop = macroTop; lastMacroBot = macroBot;
                        if (i === len - 1) this.dispatchBreakoutAlert('macro', 'down', macroTop, macroBot, useWicks ? l : c, i, data[base]);
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
                    const hasMacroPh = actualMacroPhBar >= 0 && PullbackDoubleTopBottomIndicator.isPivotHigh(data, actualMacroPhBar, macroPrd);
                    const macroPh = hasMacroPh ? data[actualMacroPhBar * 6 + 2] : 0;

                    const actualMacroPlBar = i - macroPrd;
                    const hasMacroPl = actualMacroPlBar >= 0 && PullbackDoubleTopBottomIndicator.isPivotLow(data, actualMacroPlBar, macroPrd);
                    const macroPl = hasMacroPl ? data[actualMacroPlBar * 6 + 3] : 0;

                    if (macroDir === 1 && lastMacroBot !== null) {
                        if (useWicks ? l < lastMacroBot : c < lastMacroBot) {
                            macroDir = -1; macroBreakBar = i;
                            macroTop = null; macroBot = null; macroTopBar = null; macroBotBar = null;
                        }
                    } else if (macroDir === -1 && lastMacroTop !== null) {
                        if (useWicks ? h > lastMacroTop : c > lastMacroTop) {
                            macroDir = 1; macroBreakBar = i;
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
                        macroBox = { leftBar: Math.min(macroTopBar, macroBotBar), rightBar: i, topBar: macroTopBar, bottomBar: macroBotBar, top: macroTop, bottom: macroBot, isOpen: true };
                        macroBoxes.push(macroBox);
                        if (macroBoxes.length > maxBoxes) macroBoxes.shift();
                    }
                }
            }
            // Pass empty macro array because macro boxes are never suppressed by themselves
            this.findInternalPatterns(macroBoxes, false, ds, []);
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

            for (let i = 0; i < len; i++) {
                const base = i * 6;
                const h = data[base + 2];
                const l = data[base + 3];
                const c = data[base + 4];

                if (inMicro && microBox !== null && microTop !== null && microBot !== null) {
                    microBox.rightBar = i;

                    const microBreakUp = useWicks ? h > microTop : c > microTop;
                    const microBreakDn = useWicks ? l < microBot : c < microBot;

                    if (microBreakUp) {
                        inMicro = false;
                        microBox.isOpen = false;
                        microBox.breakoutDir = 'up';
                        microBreakBar = i;
                        microDir = 1; 
                        lastMicroTop = microTop; 
                        lastMicroBot = microBot;
                        if (i === len - 1) this.dispatchBreakoutAlert('micro', 'up', microTop, microBot, useWicks ? h : c, i, data[base]);
                        microTop = null; microBot = null; microTopBar = null; microBotBar = null; microBox = null;
                    } else if (microBreakDn) {
                        inMicro = false;
                        microBox.isOpen = false;
                        microBox.breakoutDir = 'down';
                        microBreakBar = i;
                        microDir = -1; 
                        lastMicroTop = microTop;
                        lastMicroBot = microBot;
                        if (i === len - 1) this.dispatchBreakoutAlert('micro', 'down', microTop, microBot, useWicks ? l : c, i, data[base]);
                        microTop = null; microBot = null; microTopBar = null; microBotBar = null; microBox = null;
                    } else if (!useWicks) {
                        if (h > microTop) {
                            microTop = h;
                            microBox.top = h;
                            microBox.topBar = i;
                        }
                        if (l < microBot) {
                            microBot = l;
                            microBox.bottom = l;
                            microBox.bottomBar = i;
                        }
                    }
                }

                if (!inMicro) {
                    const actualPhBar = i - microPrd;
                    const hasPh = actualPhBar >= 0 && PullbackDoubleTopBottomIndicator.isPivotHigh(data, actualPhBar, microPrd);
                    const ph = hasPh ? data[actualPhBar * 6 + 2] : 0;

                    const actualPlBar = i - microPrd;
                    const hasPl = actualPlBar >= 0 && PullbackDoubleTopBottomIndicator.isPivotLow(data, actualPlBar, microPrd);
                    const pl = hasPl ? data[actualPlBar * 6 + 3] : 0;

                    if (microDir === 1 && lastMicroBot !== null) {
                        if (useWicks ? l < lastMicroBot : c < lastMicroBot) {
                            microDir = -1; microBreakBar = i;
                            microTop = null; microBot = null; microTopBar = null; microBotBar = null;
                        }
                    } else if (microDir === -1 && lastMicroTop !== null) {
                        if (useWicks ? h > lastMicroTop : c > lastMicroTop) {
                            microDir = 1; microBreakBar = i;
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
                        microBox = { leftBar: Math.min(microTopBar, microBotBar), rightBar: i, topBar: microTopBar, bottomBar: microBotBar, top: microTop, bottom: microBot, isOpen: true };
                        microBoxes.push(microBox);
                        if (microBoxes.length > maxBoxes) microBoxes.shift();
                    }
                }
            }
            // Pass macroBoxes in to perfectly filter out overlapping micro patterns
            this.findInternalPatterns(microBoxes, true, ds, macroBoxes);
        }

        this.cachedMicroBoxes = microBoxes;
        this.cachedMacroBoxes = macroBoxes;
        this.lastCalculatedLength = len;
        this.lastStateHash = stateHash;
    }

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
        const showPatterns = this.getParam<boolean>('showPatterns', true);
        const showMidline = this.getParam<boolean>('showMidline', false);
        const extendMidlineRight = this.getParam<boolean>('extendMidlineRight', false);
        const extendMidlineCount = Math.max(1, this.getParam<number>('extendMidlineCount', 1));
        const showHighLowLines = this.getParam<boolean>('showHighLowLines', false);
        const extendHighLowLines = this.getParam<boolean>('extendHighLowLines', false);
        const extendHighLowCount = Math.max(1, this.getParam<number>('extendHighLowCount', 1));
        const showLabels = this.getParam<boolean>('showLabels', true);
        
        const borderWidth = Math.max(0.5, this.getParam<number>('borderWidth', 1));
        const dtDbWidth = Math.max(1, this.getParam<number>('dtDbWidth', 2));

        const microBorder = parseColorAndAlpha(this.getParam<string>('microBorder', '#2962FF'));
        const microBg = parseColorAndAlpha(this.getParam<string>('microBg', '#2962FF26'));
        const macroBorder = parseColorAndAlpha(this.getParam<string>('macroBorder', '#EF5350'));
        const macroBg = parseColorAndAlpha(this.getParam<string>('macroBg', '#EF53501A'));
        const midlineColor = parseColorAndAlpha(this.getParam<string>('midlineColor', '#EF5350'));
        const highLowLineColor = parseColorAndAlpha(this.getParam<string>('highLowLineColor', '#EF5350'));
        
        const dtColor = parseColorAndAlpha(this.getParam<string>('dtColor', '#FF1744'));
        const dbColor = parseColorAndAlpha(this.getParam<string>('dbColor', '#00E676'));

        const screenW = layout.chartWidth;
        const sp = r.candleSpacing * r.zoom;
        const halfSp = sp * 0.45;
        const minX = -40;
        const maxX = screenW + 40;

        interface VisibleZoneGeometry {
            x1: number; x2: number; midlineEndX?: number; hlLineEndX?: number;
            yTop: number; yBot: number; w: number; h: number; yMid: number; box: PullbackZoneBox;
        }

        const visibleMicro: VisibleZoneGeometry[] = [];
        if (showMicro) {
            for (let i = 0; i < this.cachedMicroBoxes.length; i++) {
                const b = this.cachedMicroBoxes[i];
                const x1 = r.getCandleCenterX(b.leftBar) - halfSp;
                const x2 = r.getCandleCenterX(b.rightBar) + halfSp;
                if (x2 < minX || x1 > maxX) continue;

                const topPrice = Math.max(b.top, b.bottom);
                const botPrice = Math.min(b.top, b.bottom);
                const yTop = r.priceToY(topPrice);
                const yBot = r.priceToY(botPrice);
                visibleMicro.push({ x1, x2, yTop, yBot, w: Math.max(2, x2 - x1), h: Math.max(2, yBot - yTop), yMid: r.priceToY((topPrice + botPrice) * 0.5), box: b });
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
                const rightIdx = b.isOpen ? (r.dataStore.length - 1) : b.rightBar;
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
                visibleMacro.push({ x1, x2, midlineEndX, hlLineEndX, yTop, yBot, w: Math.max(2, x2 - x1), h: Math.max(2, yBot - yTop), yMid: r.priceToY((topPrice + botPrice) * 0.5), box: b });
            }
        }

        // --- Render Boxes ---
        if (visibleMicro.length > 0) {
            g.beginPath();
            for (const vb of visibleMicro) g.rect(vb.x1, vb.yTop, vb.w, vb.h);
            g.fill({ color: microBg.color, alpha: microBg.alpha });

            g.beginPath();
            for (const vb of visibleMicro) g.rect(vb.x1, vb.yTop, vb.w, vb.h);
            g.stroke({ color: microBorder.color, width: borderWidth, alpha: microBorder.alpha });
        }

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
                    const sx = Math.max(0, vb.x1), ex = Math.min(screenW, vb.midlineEndX ?? vb.x2);
                    if (ex > sx) StrokeEngine.addDashedLinePath(g, sx, vb.yMid, ex, vb.yMid, 'dashed', 6, 4);
                }
                g.stroke({ color: midlineColor.color, width: Math.max(1.5, borderWidth), alpha: Math.min(1, Math.max(0.8, midlineColor.alpha)) });
            }

            if (showHighLowLines) {
                g.beginPath();
                for (const vb of visibleMacro) {
                    const sx = Math.max(0, vb.x1), ex = Math.min(screenW, vb.hlLineEndX ?? vb.x2);
                    if (ex > sx) { g.moveTo(sx, vb.yTop).lineTo(ex, vb.yTop); g.moveTo(sx, vb.yBot).lineTo(ex, vb.yBot); }
                }
                g.stroke({ color: highLowLineColor.color, width: Math.max(1, borderWidth), alpha: Math.min(1, Math.max(0.85, highLowLineColor.alpha)) });
            }
        }

        // --- Render Internal DT/DB Patterns ---
        if (showPatterns && this.cachedPatterns.length > 0) {
            // Render DT
            g.beginPath();
            for (const pat of this.cachedPatterns) {
                if (pat.type !== 'DT') continue;
                const x1 = r.getCandleCenterX(pat.startBar);
                const x2 = r.getCandleCenterX(pat.endBar);
                const y = r.priceToY(pat.price);
                if (x2 < minX || x1 > maxX) continue;
                
                g.moveTo(x1, y).lineTo(x2, y);
                g.moveTo(x1, y).lineTo(x1, y + 8); 
                g.moveTo(x2, y).lineTo(x2, y + 8);
            }
            g.stroke({ color: dtColor.color, width: dtDbWidth, alpha: dtColor.alpha, cap: 'round' });

            // Render DB
            g.beginPath();
            for (const pat of this.cachedPatterns) {
                if (pat.type !== 'DB') continue;
                const x1 = r.getCandleCenterX(pat.startBar);
                const x2 = r.getCandleCenterX(pat.endBar);
                const y = r.priceToY(pat.price);
                if (x2 < minX || x1 > maxX) continue;

                g.moveTo(x1, y).lineTo(x2, y);
                g.moveTo(x1, y).lineTo(x1, y - 8); 
                g.moveTo(x2, y).lineTo(x2, y - 8);
            }
            g.stroke({ color: dbColor.color, width: dtDbWidth, alpha: dbColor.alpha, cap: 'round' });
        }

        // --- Setup Labels ---
        const needLabels = showLabels || showPatterns;
        if (needLabels) {
            if (!this.isContainerMounted) { r.app.stage.addChild(this.labelContainer); this.isContainerMounted = true; }
            this.labelContainer.visible = true;

            for (let i = 0; i < this.labelTextPool.length; i++) this.labelTextPool[i].visible = false;
            let activeTextCount = 0;

            const placeLabel = (text: string, xPos: number, yPos: number, tintColor: number) => {
                let item: BitmapText;
                if (activeTextCount < this.labelTextPool.length) item = this.labelTextPool[activeTextCount];
                else {
                    item = new BitmapText({ text: '', style: { fontFamily: 'ChartFont', fontSize: 10, fontWeight: 'bold' } });
                    this.labelTextPool.push(item);
                    this.labelContainer.addChild(item);
                }
                item.text = text; item.tint = tintColor; item.x = xPos; item.y = yPos; item.visible = true; activeTextCount++;
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

            // Internal Pattern Labels
            if (showPatterns) {
                for (const pat of this.cachedPatterns) {
                    const x1 = r.getCandleCenterX(pat.startBar);
                    const x2 = r.getCandleCenterX(pat.endBar);
                    if (x2 < minX || x1 > maxX) continue;

                    const midX = (x1 + x2) / 2;
                    const lbl = pat.type === 'DT' ? 'DT' : 'DB';
                    const col = pat.type === 'DT' ? dtColor.color : dbColor.color;
                    const yOffset = pat.type === 'DT' ? -18 : 6; 
                    
                    placeLabel(lbl, midX - 8, r.priceToY(pat.price) + yOffset, col);
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
