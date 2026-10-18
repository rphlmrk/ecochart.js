import { BaseIndicator, parseColorAndAlpha, type IndicatorLayout } from '../Indicator';
import type { DataStore } from '../../data/DataStore';
import type { ChartRenderer } from '../../renderer/ChartRenderer';
import { StrokeEngine } from '../../renderer/StrokeEngine';
import { Graphics, Container, BitmapText } from 'pixi.js';

export interface PullbackZoneBox {
    leftBar: number;
    rightBar: number;
    top: number;
    bottom: number;
    isOpen: boolean;
    breakoutDir?: 'up' | 'down';
}

export class MarketStructurePullbackZonesIndicator extends BaseIndicator {
    // Cached structure boxes to eliminate render-loop CPU calculations
    public cachedMicroBoxes: PullbackZoneBox[] = [];
    public cachedMacroBoxes: PullbackZoneBox[] = [];

    private lastCalculatedLength = -1;
    private lastCalcParamHash = '';

    // Zero-GC text pooling for optional zone labels
    private labelContainer = new Container();
    private labelTextPool: BitmapText[] = [];
    private isContainerMounted = false;

    constructor() {
        super('MS_PULLBACK_ZONES', 'Market Structure Pullback Zones');
        this.isOscillator = false;

        this.params = [
            // Micro Structure Group (Blue Boxes)
            { id: 'showMicro', name: 'Show Micro Structure', type: 'boolean', value: true },
            { id: 'microPrd', name: 'Micro Swing Period', type: 'number', value: 2, min: 1, max: 50, step: 1 },
            { id: 'microBorder', name: 'Micro Border Color', type: 'color', value: '#2962FF' },
            { id: 'microBg', name: 'Micro Background Color', type: 'color', value: '#2962FF26' }, // ~85% transparent (15% alpha)

            // Macro Structure Group (Red Boxes)
            { id: 'showMacro', name: 'Show Macro Structure', type: 'boolean', value: true },
            { id: 'macroPrd', name: 'Macro Swing Period', type: 'number', value: 8, min: 3, max: 100, step: 1 },
            { id: 'macroBorder', name: 'Macro Border Color', type: 'color', value: '#EF5350' },
            { id: 'macroBg', name: 'Macro Background Color', type: 'color', value: '#EF53501A' }, // ~90% transparent (10% alpha)

            // General Settings
            { id: 'useWicks', name: 'Breakout strictly on wicks?', type: 'boolean', value: false },
            { id: 'maxBoxes', name: 'Max Boxes Count', type: 'number', value: 500, min: 10, max: 1000, step: 10 },
            { id: 'borderWidth', name: 'Border Width', type: 'number', value: 1, min: 1, max: 4, step: 0.5 },
            { id: 'showMidline', name: 'Show 50% Midline (Equilibrium)', type: 'boolean', value: false },
            { id: 'showLabels', name: 'Show Status Labels', type: 'boolean', value: false }
        ];
    }

    protected override onParamsUpdated(): void {
        this.lastCalculatedLength = -1;
        this.cachedMicroBoxes = [];
        this.cachedMacroBoxes = [];
    }

    public override reset(): void {
        this.cachedMicroBoxes = [];
        this.cachedMacroBoxes = [];
        this.lastCalculatedLength = -1;
        super.reset();
    }

    public calculate(ds: DataStore): void {
        this.buildCachedBoxes(ds);
    }

    public override update(ds: DataStore, isClosedTick: boolean): void {
        this.buildCachedBoxes(ds);
        super.update(ds, isClosedTick);
    }

    /**
     * Highly optimized pivot detection on typed Float64Array
     */
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
     * Builds both Micro and Macro pullback zones in a single pass over historical data
     */
    private buildCachedBoxes(ds: DataStore): void {
        const len = ds.length;
        if (len === 0) {
            this.cachedMicroBoxes = [];
            this.cachedMacroBoxes = [];
            this.lastCalculatedLength = 0;
            return;
        }

        const showMicro = this.getParam<boolean>('showMicro', true);
        const microPrd = Math.max(1, this.getParam<number>('microPrd', 2));
        const showMacro = this.getParam<boolean>('showMacro', true);
        const macroPrd = Math.max(3, this.getParam<number>('macroPrd', 8));
        const useWicks = this.getParam<boolean>('useWicks', false);
        const maxBoxes = Math.max(10, Math.min(1000, this.getParam<number>('maxBoxes', 500)));

        const paramHash = `${showMicro}:${microPrd}:${showMacro}:${macroPrd}:${useWicks}:${maxBoxes}`;

        // Fast update for live tick: if bar count is unchanged and params match, update the active live boxes
        if (len === this.lastCalculatedLength && this.lastCalcParamHash === paramHash) {
            const lastIdx = len - 1;
            const base = lastIdx * 6;
            const h = ds.data[base + 2];
            const l = ds.data[base + 3];
            const c = ds.data[base + 4];

            if (showMicro && this.cachedMicroBoxes.length > 0) {
                const latest = this.cachedMicroBoxes[this.cachedMicroBoxes.length - 1];
                if (latest.isOpen) {
                    latest.rightBar = lastIdx;
                    const breakUp = useWicks ? h > latest.top : c > latest.top;
                    const breakDn = useWicks ? l < latest.bottom : c < latest.bottom;
                    if (breakUp || breakDn) {
                        latest.isOpen = false;
                        latest.breakoutDir = breakUp ? 'up' : 'down';
                    }
                }
            }

            if (showMacro && this.cachedMacroBoxes.length > 0) {
                const latest = this.cachedMacroBoxes[this.cachedMacroBoxes.length - 1];
                if (latest.isOpen) {
                    latest.rightBar = lastIdx;
                    const breakUp = useWicks ? h > latest.top : c > latest.top;
                    const breakDn = useWicks ? l < latest.bottom : c < latest.bottom;
                    if (breakUp || breakDn) {
                        latest.isOpen = false;
                        latest.breakoutDir = breakUp ? 'up' : 'down';
                    }
                }
            }
            return;
        }

        const data = ds.data;

        // 1. Calculate Micro Structure (Blue Boxes)
        const microBoxes: PullbackZoneBox[] = [];
        if (showMicro) {
            let inMicro = false;
            let microTop: number | null = null;
            let microBot: number | null = null;
            let microTopBar: number | null = null;
            let microBotBar: number | null = null;
            let microBreakBar = 0;
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

                    if (microBreakUp || microBreakDn) {
                        inMicro = false;
                        microBox.isOpen = false;
                        microBox.breakoutDir = microBreakUp ? 'up' : 'down';
                        microBreakBar = i;
                        microTop = null;
                        microBot = null;
                        microTopBar = null;
                        microBotBar = null;
                        microBox = null;
                    }
                }

                if (!inMicro) {
                    const actualPhBar = i - microPrd;
                    if (actualPhBar >= 0 && MarketStructurePullbackZonesIndicator.isPivotHigh(data, actualPhBar, microPrd)) {
                        const ph = data[actualPhBar * 6 + 2];
                        if (actualPhBar > microBreakBar) {
                            if (microTop === null || ph > microTop) {
                                microTop = ph;
                                microTopBar = actualPhBar;
                            }
                        }
                    }

                    const actualPlBar = i - microPrd;
                    if (actualPlBar >= 0 && MarketStructurePullbackZonesIndicator.isPivotLow(data, actualPlBar, microPrd)) {
                        const pl = data[actualPlBar * 6 + 3];
                        if (actualPlBar > microBreakBar) {
                            if (microBot === null || pl < microBot) {
                                microBot = pl;
                                microBotBar = actualPlBar;
                            }
                        }
                    }

                    if (microTop !== null && microBot !== null && microTopBar !== null && microBotBar !== null) {
                        inMicro = true;
                        const leftEdge = Math.min(microTopBar, microBotBar);
                        microBox = {
                            leftBar: leftEdge,
                            rightBar: i,
                            top: microTop,
                            bottom: microBot,
                            isOpen: true
                        };
                        microBoxes.push(microBox);
                        if (microBoxes.length > maxBoxes) {
                            microBoxes.shift();
                        }
                    }
                }
            }
        }

        // 2. Calculate Macro Structure (Red Boxes)
        const macroBoxes: PullbackZoneBox[] = [];
        if (showMacro) {
            let inMacro = false;
            let macroTop: number | null = null;
            let macroBot: number | null = null;
            let macroTopBar: number | null = null;
            let macroBotBar: number | null = null;
            let macroBreakBar = 0;
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

                    if (macroBreakUp || macroBreakDn) {
                        inMacro = false;
                        macroBox.isOpen = false;
                        macroBox.breakoutDir = macroBreakUp ? 'up' : 'down';
                        macroBreakBar = i;
                        macroTop = null;
                        macroBot = null;
                        macroTopBar = null;
                        macroBotBar = null;
                        macroBox = null;
                    }
                }

                if (!inMacro) {
                    const actualMacroPhBar = i - macroPrd;
                    if (actualMacroPhBar >= 0 && MarketStructurePullbackZonesIndicator.isPivotHigh(data, actualMacroPhBar, macroPrd)) {
                        const ph = data[actualMacroPhBar * 6 + 2];
                        if (actualMacroPhBar > macroBreakBar) {
                            if (macroTop === null || ph > macroTop) {
                                macroTop = ph;
                                macroTopBar = actualMacroPhBar;
                            }
                        }
                    }

                    const actualMacroPlBar = i - macroPrd;
                    if (actualMacroPlBar >= 0 && MarketStructurePullbackZonesIndicator.isPivotLow(data, actualMacroPlBar, macroPrd)) {
                        const pl = data[actualMacroPlBar * 6 + 3];
                        if (actualMacroPlBar > macroBreakBar) {
                            if (macroBot === null || pl < macroBot) {
                                macroBot = pl;
                                macroBotBar = actualMacroPlBar;
                            }
                        }
                    }

                    if (macroTop !== null && macroBot !== null && macroTopBar !== null && macroBotBar !== null) {
                        inMacro = true;
                        const leftEdge = Math.min(macroTopBar, macroBotBar);
                        macroBox = {
                            leftBar: leftEdge,
                            rightBar: i,
                            top: macroTop,
                            bottom: macroBot,
                            isOpen: true
                        };
                        macroBoxes.push(macroBox);
                        if (macroBoxes.length > maxBoxes) {
                            macroBoxes.shift();
                        }
                    }
                }
            }
        }

        this.cachedMicroBoxes = microBoxes;
        this.cachedMacroBoxes = macroBoxes;
        this.lastCalculatedLength = len;
        this.lastCalcParamHash = paramHash;
    }

    /**
     * Hardware-accelerated GPU Rendering
     * Batches all visible fills and strokes into single draw calls (Zero GC, 60-120 FPS)
     */
    public render(r: ChartRenderer, layout: IndicatorLayout, g: Graphics): void {
        if (!this.visible || r.dataStore.length === 0) {
            this.labelContainer.visible = false;
            return;
        }

        // Lazy compute pullback zones if not yet cached
        if ((this.cachedMicroBoxes.length === 0 && this.cachedMacroBoxes.length === 0) ||
            this.lastCalculatedLength !== r.dataStore.length) {
            this.buildCachedBoxes(r.dataStore);
        }

        const showMicro = this.getParam<boolean>('showMicro', true);
        const showMacro = this.getParam<boolean>('showMacro', true);
        const showMidline = this.getParam<boolean>('showMidline', false);
        const showLabels = this.getParam<boolean>('showLabels', false);
        const borderWidth = Math.max(0.5, this.getParam<number>('borderWidth', 1));

        const microBorder = parseColorAndAlpha(this.getParam<string>('microBorder', '#2962FF'));
        const microBg = parseColorAndAlpha(this.getParam<string>('microBg', '#2962FF26'));
        const macroBorder = parseColorAndAlpha(this.getParam<string>('macroBorder', '#EF5350'));
        const macroBg = parseColorAndAlpha(this.getParam<string>('macroBg', '#EF53501A'));

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
            yMid: number;
            box: PullbackZoneBox;
        }

        // Filter visible Micro boxes
        const visibleMicro: VisibleZoneGeometry[] = [];
        if (showMicro && this.cachedMicroBoxes.length > 0) {
            for (let i = 0; i < this.cachedMicroBoxes.length; i++) {
                const b = this.cachedMicroBoxes[i];
                const x1 = r.getCandleCenterX(b.leftBar) - halfSp;
                const x2 = r.getCandleCenterX(b.rightBar) + halfSp;

                if (x2 < minX || x1 > maxX) continue;

                const topPrice = Math.max(b.top, b.bottom);
                const botPrice = Math.min(b.top, b.bottom);
                const yTop = r.priceToY(topPrice);
                const yBot = r.priceToY(botPrice);
                const w = Math.max(2, x2 - x1);
                const h = Math.max(2, yBot - yTop);
                const yMid = r.priceToY((topPrice + botPrice) * 0.5);

                visibleMicro.push({ x1, x2, yTop, yBot, w, h, yMid, box: b });
            }
        }

        // Filter visible Macro boxes
        const visibleMacro: VisibleZoneGeometry[] = [];
        if (showMacro && this.cachedMacroBoxes.length > 0) {
            for (let i = 0; i < this.cachedMacroBoxes.length; i++) {
                const b = this.cachedMacroBoxes[i];
                const x1 = r.getCandleCenterX(b.leftBar) - halfSp;
                const x2 = r.getCandleCenterX(b.rightBar) + halfSp;

                if (x2 < minX || x1 > maxX) continue;

                const topPrice = Math.max(b.top, b.bottom);
                const botPrice = Math.min(b.top, b.bottom);
                const yTop = r.priceToY(topPrice);
                const yBot = r.priceToY(botPrice);
                const w = Math.max(2, x2 - x1);
                const h = Math.max(2, yBot - yTop);
                const yMid = r.priceToY((topPrice + botPrice) * 0.5);

                visibleMacro.push({ x1, x2, yTop, yBot, w, h, yMid, box: b });
            }
        }

        // =========================================================================
        // 🚀 GPU BATCH 1: Micro Fills & Borders (Single draw call each)
        // =========================================================================
        if (visibleMicro.length > 0) {
            // 1a. Fill all Micro boxes in 1 GPU draw call
            for (let i = 0; i < visibleMicro.length; i++) {
                const vb = visibleMicro[i];
                g.rect(vb.x1, vb.yTop, vb.w, vb.h);
            }
            g.fill({ color: microBg.color, alpha: microBg.alpha });

            // 1b. Stroke all Micro borders in 1 GPU stroke call
            for (let i = 0; i < visibleMicro.length; i++) {
                const vb = visibleMicro[i];
                g.rect(vb.x1, vb.yTop, vb.w, vb.h);
            }
            g.stroke({
                color: microBorder.color,
                width: borderWidth,
                alpha: microBorder.alpha,
                cap: 'butt'
            });

            // 1c. Optional 50% Midline (Equilibrium)
            if (showMidline) {
                for (let i = 0; i < visibleMicro.length; i++) {
                    const vb = visibleMicro[i];
                    StrokeEngine.addDashedLinePath(g, vb.x1, vb.yMid, vb.x2, vb.yMid, 'dashed', 4, 3);
                }
                g.stroke({
                    color: microBorder.color,
                    width: 1,
                    alpha: microBorder.alpha * 0.6,
                    cap: 'butt'
                });
            }
        }

        // =========================================================================
        // 🚀 GPU BATCH 2: Macro Fills & Borders (Single draw call each)
        // =========================================================================
        if (visibleMacro.length > 0) {
            // 2a. Fill all Macro boxes in 1 GPU draw call
            for (let i = 0; i < visibleMacro.length; i++) {
                const vb = visibleMacro[i];
                g.rect(vb.x1, vb.yTop, vb.w, vb.h);
            }
            g.fill({ color: macroBg.color, alpha: macroBg.alpha });

            // 2b. Stroke all Macro borders in 1 GPU stroke call
            for (let i = 0; i < visibleMacro.length; i++) {
                const vb = visibleMacro[i];
                g.rect(vb.x1, vb.yTop, vb.w, vb.h);
            }
            g.stroke({
                color: macroBorder.color,
                width: borderWidth,
                alpha: macroBorder.alpha,
                cap: 'butt'
            });

            // 2c. Optional 50% Midline (Equilibrium)
            if (showMidline) {
                for (let i = 0; i < visibleMacro.length; i++) {
                    const vb = visibleMacro[i];
                    StrokeEngine.addDashedLinePath(g, vb.x1, vb.yMid, vb.x2, vb.yMid, 'dashed', 4, 3);
                }
                g.stroke({
                    color: macroBorder.color,
                    width: 1,
                    alpha: macroBorder.alpha * 0.6,
                    cap: 'butt'
                });
            }
        }

        // =========================================================================
        // 3. Optional Status Labels (Recycled BitmapText with zero GC allocations)
        // =========================================================================
        if (showLabels && (visibleMicro.length > 0 || visibleMacro.length > 0)) {
            if (!this.isContainerMounted) {
                r.app.stage.addChild(this.labelContainer);
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

            for (let i = 0; i < visibleMicro.length; i++) {
                const vb = visibleMicro[i];
                if (vb.x1 <= screenW - 30) {
                    const text = vb.box.isOpen ? 'MICRO PULLBACK' : (vb.box.breakoutDir === 'up' ? 'MICRO BRK UP' : 'MICRO BRK DN');
                    placeLabel(text, Math.max(4, vb.x1 + 3), Math.max(12, vb.yTop - 11), microBorder.color);
                }
            }

            for (let i = 0; i < visibleMacro.length; i++) {
                const vb = visibleMacro[i];
                if (vb.x1 <= screenW - 30) {
                    const text = vb.box.isOpen ? 'MACRO PULLBACK' : (vb.box.breakoutDir === 'up' ? 'MACRO BRK UP' : 'MACRO BRK DN');
                    placeLabel(text, Math.max(4, vb.x1 + 3), Math.max(12, vb.yTop - 11), macroBorder.color);
                }
            }
        } else {
            this.labelContainer.visible = false;
        }
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
