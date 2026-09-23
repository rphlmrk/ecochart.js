import { BaseIndicator, parseColor, type IndicatorLayout } from '../Indicator';
import type { DataStore } from '../../data/DataStore';
import type { ChartRenderer } from '../../renderer/ChartRenderer';
import { StrokeEngine } from '../../renderer/StrokeEngine';
import { Graphics, Container, Text } from 'pixi.js';

interface ZigZagPoint {
    barIdx: number;
    price: number;
    type: 1 | -1; // 1 = High, -1 = Low
}

interface BreakoutLine {
    startBar: number;
    endBar: number;
    price: number;
}

interface NumberLabel {
    barIdx: number;
    price: number;
    text: '1' | '2' | '3';
    isHigh: boolean;
}

export class ZigZag123Indicator extends BaseIndicator {
    // Pre-calculated structures (Updated only when data changes)
    private cachedZzPoints: ZigZagPoint[] = [];
    private cachedBreakoutLines: BreakoutLine[] = [];
    private cachedLabels: NumberLabel[] = [];

    // Zero-GC text pooling for "1-2-3" labels
    private labelContainer = new Container();
    private labelTextPool: Text[] = [];
    private isContainerMounted = false;

    constructor(zzLength = 4) {
        super(`ZZ123_${zzLength}`, `ZigZag 1-2-3 (${zzLength})`);
        this.params = [
            { id: 'zzLength', name: 'Zigzag Length', type: 'number', value: zzLength, min: 1, max: 50, step: 1 },
            { id: 'showZigZag', name: 'Show ZigZag Lines', type: 'boolean', value: true },
            { id: 'zzColor', name: 'ZigZag Color', type: 'color', value: '#FF9800' },
            { id: 'zzWidth', name: 'ZigZag Width', type: 'number', value: 2, min: 1, max: 4, step: 1 },
            { id: 'showLevels', name: 'Show Breakout Lines', type: 'boolean', value: true },
            { id: 'breakoutColor', name: 'Breakout Color', type: 'color', value: '#EF5350' },
            { id: 'lineWidth', name: 'Breakout Line Width', type: 'number', value: 1.5, min: 1, max: 3, step: 0.5 },
            { id: 'showLabels', name: 'Show 1-2-3 Labels', type: 'boolean', value: true },
            { id: 'labelColor', name: 'Label Text Color', type: 'color', value: '#FFFFFF' }
        ];
    }

    protected onParamsUpdated(): void {
        const len = this.getParam<number>('zzLength', 4);
        this.id = `ZZ123_${len}`;
        this.name = `ZigZag 1-2-3 (${len})`;
        this.cachedZzPoints = [];
        this.cachedBreakoutLines = [];
        this.cachedLabels = [];
    }

    // =========================================================================
    // 🧠 MATH ENGINE (Port of PineScript ta.pivothigh / low & State Machine)
    // =========================================================================
    protected calculate(ds: DataStore) {
        if (ds.length < 10) {
            this.cachedZzPoints = [];
            this.cachedBreakoutLines = [];
            this.cachedLabels = [];
            return;
        }

        const zzLength = Math.max(1, this.getParam<number>('zzLength', 4));

        this.cachedZzPoints = [];
        this.cachedBreakoutLines = [];
        this.cachedLabels = [];

        const swingBars: number[] = [];
        const swingPrices: number[] = [];
        const swingTypes: number[] = [];

        let trend = 0; // 1 = Bullish, -1 = Bearish
        let guardLow: number | null = null;
        let guardLowBar: number | null = null;
        let guardLowBroken = false;

        let guardHigh: number | null = null;
        let guardHighBar: number | null = null;
        let guardHighBroken = false;

        let s1Low: number | null = null;
        let s1LowBar: number | null = null;
        let s1LowBroken = false;

        let s1High: number | null = null;
        let s1HighBar: number | null = null;
        let s1HighBroken = false;

        let seqStep = 0;
        let s2Price: number | null = null;
        let s2Bar: number | null = null;
        let lastLabelIdx = -1;

        const getRecentSwing = (targetType: number): [number | null, number | null] => {
            for (let i = swingTypes.length - 1; i >= 0; i--) {
                if (swingTypes[i] === targetType) {
                    return [swingPrices[i], swingBars[i]];
                }
            }
            return [null, null];
        };

        // Sequential bar evaluation (Capped at recent 2,500 bars for mobile performance)
        const startBarIdx = Math.max(0, ds.length - 2500);
        for (let i = startBarIdx; i < ds.length; i++) {
            let newSwing = false;
            let updatedSwing = false;
            let newSwingType = 0;
            let newSwingBar = 0;
            let newSwingPrice = 0;

            const pBar = i - zzLength;

            // 1. Check Pivot High
            if (pBar >= zzLength && i < ds.length) {
                const candH = ds.data[pBar * 6 + 2];
                let isPh = true;
                for (let k = 1; k <= zzLength; k++) {
                    if (ds.data[(pBar - k) * 6 + 2] > candH || ds.data[(pBar + k) * 6 + 2] >= candH) {
                        isPh = false;
                        break;
                    }
                }

                if (isPh) {
                    const n = swingTypes.length;
                    if (n === 0) {
                        swingBars.push(pBar); swingPrices.push(candH); swingTypes.push(1);
                        newSwing = true; newSwingType = 1; newSwingBar = pBar; newSwingPrice = candH;
                    } else {
                        const lastT = swingTypes[n - 1];
                        if (lastT === 1) {
                            if (candH >= swingPrices[n - 1]) {
                                swingBars[n - 1] = pBar; swingPrices[n - 1] = candH;
                                updatedSwing = true; newSwingType = 1; newSwingBar = pBar; newSwingPrice = candH;
                            }
                        } else {
                            swingBars.push(pBar); swingPrices.push(candH); swingTypes.push(1);
                            newSwing = true; newSwingType = 1; newSwingBar = pBar; newSwingPrice = candH;
                        }
                    }
                }
            }

            // 2. Check Pivot Low
            if (pBar >= zzLength && i < ds.length) {
                const candL = ds.data[pBar * 6 + 3];
                let isPl = true;
                for (let k = 1; k <= zzLength; k++) {
                    if (ds.data[(pBar - k) * 6 + 3] < candL || ds.data[(pBar + k) * 6 + 3] <= candL) {
                        isPl = false;
                        break;
                    }
                }

                if (isPl) {
                    const n = swingTypes.length;
                    if (n === 0) {
                        swingBars.push(pBar); swingPrices.push(candL); swingTypes.push(-1);
                        newSwing = true; newSwingType = -1; newSwingBar = pBar; newSwingPrice = candL;
                    } else {
                        const lastT = swingTypes[n - 1];
                        if (lastT === -1) {
                            if (candL <= swingPrices[n - 1]) {
                                swingBars[n - 1] = pBar; swingPrices[n - 1] = candL;
                                updatedSwing = true; newSwingType = -1; newSwingBar = pBar; newSwingPrice = candL;
                            }
                        } else {
                            swingBars.push(pBar); swingPrices.push(candL); swingTypes.push(-1);
                            newSwing = true; newSwingType = -1; newSwingBar = pBar; newSwingPrice = candL;
                        }
                    }
                }
            }

            // 3. Initial Trend Setup
            if (trend === 0 && swingTypes.length >= 3) {
                const n = swingTypes.length;
                const t1 = swingTypes[n - 1];
                const p1 = swingPrices[n - 1];
                const p3 = swingPrices[n - 3];
                if (t1 === 1 && p1 > p3) {
                    trend = 1;
                    guardLow = swingPrices[n - 2];
                    guardLowBar = swingBars[n - 2];
                } else if (t1 === -1 && p1 < p3) {
                    trend = -1;
                    guardHigh = swingPrices[n - 2];
                    guardHighBar = swingBars[n - 2];
                }
            }

            // 4. Breakout & Invalidation Evaluation on Every Bar
            const close = ds.data[i * 6 + 4];

            // Case A: Breaking ZigZag Low in Bullish Trend
            if (trend === 1 && !guardLowBroken && guardLow !== null && close < guardLow && seqStep === 0) {
                if (guardLowBar !== null) {
                    this.cachedBreakoutLines.push({ startBar: guardLowBar, endBar: i, price: guardLow });
                }
                guardLowBroken = true;
                trend = -1;
                seqStep = 1;
                const [p, b] = getRecentSwing(1);
                s1High = p; s1HighBar = b; s1HighBroken = false;
            }

            // Case B: Breaking ZigZag High in Bearish Trend
            if (trend === -1 && !guardHighBroken && guardHigh !== null && close > guardHigh && seqStep === 0) {
                if (guardHighBar !== null) {
                    this.cachedBreakoutLines.push({ startBar: guardHighBar, endBar: i, price: guardHigh });
                }
                guardHighBroken = true;
                trend = 1;
                seqStep = 1;
                const [p, b] = getRecentSwing(-1);
                s1Low = p; s1LowBar = b; s1LowBroken = false;
            }

            // Case C: Bullish Invalidation -> Close below "1 Low"
            if (trend === 1 && seqStep >= 2 && s1Low !== null && !s1LowBroken && close < s1Low) {
                if (s1LowBar !== null) {
                    this.cachedBreakoutLines.push({ startBar: s1LowBar, endBar: i, price: s1Low });
                }
                s1LowBroken = true;
                trend = -1;
                seqStep = 1;
                const [p, b] = getRecentSwing(1);
                s1High = p; s1HighBar = b; s1HighBroken = false;
            }

            // Case D: Bearish Invalidation -> Close above "1 High"
            if (trend === -1 && seqStep >= 2 && s1High !== null && !s1HighBroken && close > s1High) {
                if (s1HighBar !== null) {
                    this.cachedBreakoutLines.push({ startBar: s1HighBar, endBar: i, price: s1High });
                }
                s1HighBroken = true;
                trend = 1;
                seqStep = 1;
                const [p, b] = getRecentSwing(-1);
                s1Low = p; s1LowBar = b; s1LowBroken = false;
            }

            // 5. Swing Confirmation & 1-2-3 State Machine
            if (newSwing) {
                if (trend === -1) {
                    if (seqStep === 1 && newSwingType === -1) {
                        this.cachedLabels.push({ barIdx: newSwingBar, price: newSwingPrice, text: '1', isHigh: false });
                        lastLabelIdx = this.cachedLabels.length - 1;
                        seqStep = 2;
                    } else if (seqStep === 2 && newSwingType === 1) {
                        this.cachedLabels.push({ barIdx: newSwingBar, price: newSwingPrice, text: '2', isHigh: true });
                        lastLabelIdx = this.cachedLabels.length - 1;
                        s2Price = newSwingPrice;
                        s2Bar = newSwingBar;
                        seqStep = 3;
                    } else if (seqStep === 3 && newSwingType === -1) {
                        this.cachedLabels.push({ barIdx: newSwingBar, price: newSwingPrice, text: '3', isHigh: false });
                        lastLabelIdx = this.cachedLabels.length - 1;
                        seqStep = 0;
                        guardHigh = s2Price;
                        guardHighBar = s2Bar;
                        guardHighBroken = false;
                    } else if (seqStep === 0 && newSwingType === 1) {
                        guardHigh = newSwingPrice;
                        guardHighBar = newSwingBar;
                        guardHighBroken = false;
                    }
                } else if (trend === 1) {
                    if (seqStep === 1 && newSwingType === 1) {
                        this.cachedLabels.push({ barIdx: newSwingBar, price: newSwingPrice, text: '1', isHigh: true });
                        lastLabelIdx = this.cachedLabels.length - 1;
                        seqStep = 2;
                    } else if (seqStep === 2 && newSwingType === -1) {
                        this.cachedLabels.push({ barIdx: newSwingBar, price: newSwingPrice, text: '2', isHigh: false });
                        lastLabelIdx = this.cachedLabels.length - 1;
                        s2Price = newSwingPrice;
                        s2Bar = newSwingBar;
                        seqStep = 3;
                    } else if (seqStep === 3 && newSwingType === 1) {
                        this.cachedLabels.push({ barIdx: newSwingBar, price: newSwingPrice, text: '3', isHigh: true });
                        lastLabelIdx = this.cachedLabels.length - 1;
                        seqStep = 0;
                        guardLow = s2Price;
                        guardLowBar = s2Bar;
                        guardLowBroken = false;
                    } else if (seqStep === 0 && newSwingType === -1) {
                        guardLow = newSwingPrice;
                        guardLowBar = newSwingBar;
                        guardLowBroken = false;
                    }
                }
            }

            // 6. Apex Extrapolation on Updated Swings
            if (updatedSwing && lastLabelIdx >= 0 && lastLabelIdx < this.cachedLabels.length) {
                this.cachedLabels[lastLabelIdx].barIdx = newSwingBar;
                this.cachedLabels[lastLabelIdx].price = newSwingPrice;
                if (seqStep === 3) {
                    s2Price = newSwingPrice;
                }
            }
        }

        // Cache final alternating zigzag points
        for (let i = 0; i < swingBars.length; i++) {
            this.cachedZzPoints.push({
                barIdx: swingBars[i],
                price: swingPrices[i],
                type: swingTypes[i] as 1 | -1
            });
        }

        this.lastCalculatedIdx = ds.length - 1;
    }

    // =========================================================================
    // 🎨 RENDER ENGINE (Hardware-accelerated lines & zero-allocation text pool)
    // =========================================================================
    public render(r: ChartRenderer, layout: IndicatorLayout, g: Graphics) {
        if (!this.visible) {
            this.labelContainer.visible = false;
            return;
        }

        // Mount pooled text container into stage once
        if (!this.isContainerMounted) {
            r.app.stage.addChild(this.labelContainer);
            this.isContainerMounted = true;
        }
        this.labelContainer.visible = true;

        const showZigZag = this.getParam<boolean>('showZigZag', true);
        const zzColor = parseColor(this.getParam('zzColor', '#FF9800'));
        const zzWidth = this.getParam<number>('zzWidth', 2);

        const showLevels = this.getParam<boolean>('showLevels', true);
        const breakoutColor = parseColor(this.getParam('breakoutColor', '#EF5350'));
        const lineWidth = this.getParam<number>('lineWidth', 1.5);

        const showLabels = this.getParam<boolean>('showLabels', true);
        const rawLabelColor = String(this.getParam('labelColor', '#FFFFFF')).toUpperCase();
        const labelColor = (!r.isDarkTheme && rawLabelColor === '#FFFFFF') ? r.axisTextColor : parseColor(rawLabelColor);

        const sp = r.candleSpacing * r.zoom;
        const screenW = layout.chartWidth;

        // 1. Draw Alternating ZigZag Swings with Viewport Frustum Culling
        if (showZigZag && this.cachedZzPoints.length > 1) {
            let isDrawing = false;
            for (let i = 0; i < this.cachedZzPoints.length; i++) {
                const pt = this.cachedZzPoints[i];
                const x = (pt.barIdx * sp) - r.cameraX;

                // Skip points if both current and next are far off-screen to the left
                const nextPt = this.cachedZzPoints[i + 1];
                if (nextPt) {
                    const nextX = (nextPt.barIdx * sp) - r.cameraX;
                    if (nextX < -50) continue;
                }

                const normY = (pt.price - r.currentMinPrice) / (r.currentMaxPrice - r.currentMinPrice);
                const y = layout.mainChartHeight - (normY * layout.mainChartHeight) + r.cameraY;

                if (!isDrawing) {
                    g.moveTo(x, y);
                    isDrawing = true;
                } else {
                    g.lineTo(x, y);
                }

                // Stop iterating once we draw past the right edge of the screen
                if (x > screenW + 50) break;
            }
            if (isDrawing) {
                g.stroke({ color: zzColor, width: zzWidth });
            }
        }

        // 2. Draw Breakout Reference Lines (Clipped to Viewport)
        if (showLevels) {
            for (let i = 0; i < this.cachedBreakoutLines.length; i++) {
                const line = this.cachedBreakoutLines[i];
                const rawX1 = (line.startBar * sp) - r.cameraX;
                const rawX2 = (line.endBar * sp) - r.cameraX;

                if (rawX2 < 0 || rawX1 > screenW) continue;

                // Clamp coordinates to screen edges to prevent drawing thousands of off-screen dashes
                const x1 = Math.max(-10, rawX1);
                const x2 = Math.min(screenW + 10, rawX2);
                if (x1 >= x2) continue;

                const normY = (line.price - r.currentMinPrice) / (r.currentMaxPrice - r.currentMinPrice);
                const y = layout.mainChartHeight - (normY * layout.mainChartHeight) + r.cameraY;

                StrokeEngine.drawLine(g, x1, y, x2, y, {
                    color: breakoutColor,
                    width: lineWidth,
                    alpha: 0.85,
                    style: 'dashed',
                    dashLength: 4,
                    gapLength: 3
                });
            }
        }

        // 3. Draw "1-2-3" Labels via GPU Text Pool
        let activeTextCount = 0;

        if (showLabels) {
            for (let i = 0; i < this.cachedLabels.length; i++) {
                const lbl = this.cachedLabels[i];
                const x = (lbl.barIdx * sp) - r.cameraX;

                if (x < -20 || x > screenW + 20) continue;

                const normY = (lbl.price - r.currentMinPrice) / (r.currentMaxPrice - r.currentMinPrice);
                let y = layout.mainChartHeight - (normY * layout.mainChartHeight) + r.cameraY;
                y += lbl.isHigh ? -20 : 6;

                // Draw subtle badge circle behind label number
                const badgeColor = lbl.text === '3' ? (lbl.isHigh ? 0x26A69A : 0xEF5350) : r.axisBgColor;
                g.circle(x, y + 6, 8).fill({ color: badgeColor, alpha: 0.85 });
                g.circle(x, y + 6, 8).stroke({ color: r.gridColor, width: 1 });

                // Fetch pooled text
                let textItem: Text;
                if (activeTextCount < this.labelTextPool.length) {
                    textItem = this.labelTextPool[activeTextCount];
                } else {
                    textItem = new Text({
                        text: '',
                        style: { fontFamily: 'sans-serif', fontSize: 11, fontWeight: 'bold' }
                    });
                    textItem.anchor.set(0.5);
                    this.labelTextPool.push(textItem);
                    this.labelContainer.addChild(textItem);
                }

                textItem.text = lbl.text;
                textItem.style.fill = labelColor;
                textItem.x = x;
                textItem.y = y + 6;
                textItem.visible = true;

                activeTextCount++;
            }
        }

        // Hide unused pooled label texts
        for (let i = activeTextCount; i < this.labelTextPool.length; i++) {
            this.labelTextPool[i].visible = false;
        }
    }

    public getValueAt(idx: number, ds: DataStore, _isDark: boolean, _defaultTextClr: number) {
        const close = (idx >= 0 && idx < ds.length) ? ds.data[idx * 6 + 4] : 0;
        return {
            label: this.name,
            valueStr: close > 0 ? close.toFixed(2) : 'n/a',
            valueColor: parseColor(this.getParam('zzColor', '#FF9800'))
        };
    }

    public destroy(): void {
        this.labelContainer.visible = false;
        if (this.labelContainer.parent) {
            this.labelContainer.parent.removeChild(this.labelContainer);
        }
        this.isContainerMounted = false;
    }
}