import { BaseIndicator, parseColor, type IndicatorLayout } from '../Indicator';
import type { DataStore } from '../../data/DataStore';
import type { ChartRenderer } from '../../renderer/ChartRenderer';
import { StrokeEngine } from '../../renderer/StrokeEngine';
import { Graphics, Container, BitmapText } from 'pixi.js';
import { MathWorkerClient } from '../../workers/MathWorkerClient';

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
    private labelTextPool: BitmapText[] = [];
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
    // 🧠 MATH ENGINE (Fully Offloaded to Background Worker)
    // =========================================================================
    protected async calculate(ds: DataStore) {
        if (this.isCalculating || ds.length < 10) return;

        this.isCalculating = true;
        const zzLength = Math.max(1, this.getParam<number>('zzLength', 4));

        try {
            // Always process the last 2500 bars to handle dynamic invalidations instantly
            const barsToProcess = Math.min(ds.length, 2500);
            const startIdx = ds.length - barsToProcess;

            // Extract a zero-copy pointer view of exactly what we need to calculate
            const activeData = ds.data.subarray(startIdx * 6, ds.length * 6);

            const res = await MathWorkerClient.calculate('ZIGZAG123', activeData, { zzLength, offset: startIdx });

            if (res) {
                this.cachedZzPoints = res.zzPoints;
                this.cachedBreakoutLines = res.breakoutLines;
                this.cachedLabels = res.labels;
            }
            this.lastCalculatedIdx = ds.length - 1;
        } finally {
            this.isCalculating = false;
            window.dispatchEvent(new Event('ecochart-indicator-ready'));
        }
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
        const rawZzColor = String(this.getParam('zzColor', '#FF9800')).trim().toUpperCase();
        let zzColor = parseColor(rawZzColor);

        const showLevels = this.getParam<boolean>('showLevels', true);
        const rawBreakout = String(this.getParam('breakoutColor', '#EF5350')).trim().toUpperCase();
        let breakoutColor = parseColor(rawBreakout);

        // Luminous Check: Flip bright lines to dark slate in Light Mode
        if (!r.isDarkTheme) {
            const cR1 = (zzColor >> 16) & 0xff, cG1 = (zzColor >> 8) & 0xff, cB1 = zzColor & 0xff;
            if ((0.299 * cR1 + 0.587 * cG1 + 0.114 * cB1) > 180) {
                zzColor = 0x131722;
            } else if (rawZzColor === '#FF9800') {
                zzColor = 0xD97706; // Deep orange adjust
            }

            const cR2 = (breakoutColor >> 16) & 0xff, cG2 = (breakoutColor >> 8) & 0xff, cB2 = breakoutColor & 0xff;
            if ((0.299 * cR2 + 0.587 * cG2 + 0.114 * cB2) > 180) {
                breakoutColor = 0x131722;
            }
        }

        const zzWidth = this.getParam<number>('zzWidth', 2);
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

                // Draw subtle badge circle behind label number, dynamically aware of active theme colors
                const badgeColor = lbl.text === '3' ? (lbl.isHigh ? r.bullColor : r.bearColor) : r.axisBgColor;
                g.circle(x, y + 6, 8).fill({ color: badgeColor, alpha: 0.85 });
                g.circle(x, y + 6, 8).stroke({ color: r.gridColor, width: 1 });

                // Fetch pooled GPU text
                let textItem: BitmapText;
                if (activeTextCount < this.labelTextPool.length) {
                    textItem = this.labelTextPool[activeTextCount];
                } else {
                    textItem = new BitmapText({
                        text: '',
                        style: { fontFamily: 'ChartFont', fontSize: 11 }
                    });
                    textItem.anchor.set(0.5);
                    this.labelTextPool.push(textItem);
                    this.labelContainer.addChild(textItem);
                }

                textItem.text = lbl.text;
                textItem.tint = labelColor; // <-- GPU Tint instead of fill
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

    public getValueAt(idx: number, ds: DataStore, isDark: boolean, _defaultTextClr: number) {
        const close = (idx >= 0 && idx < ds.length) ? ds.data[idx * 6 + 4] : 0;
        const rawZz = String(this.getParam('zzColor', '#FF9800')).toUpperCase();
        let zzColor = parseColor(rawZz);

        if (!isDark && rawZz === '#FF9800') {
            zzColor = 0xD97706; // Adjust to deep orange on light theme
        }

        return {
            label: this.name,
            valueStr: close > 0 ? close.toFixed(2) : 'n/a',
            valueColor: zzColor
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