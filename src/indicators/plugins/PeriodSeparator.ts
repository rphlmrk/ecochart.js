import { BaseIndicator, parseColor, parseColorAndAlpha, type IndicatorLayout } from '../Indicator';
import type { DataStore } from '../../data/DataStore';
import type { ChartRenderer } from '../../renderer/ChartRenderer';
import { StrokeEngine } from '../../renderer/StrokeEngine';
import type { LineStyle } from '../../theme/types';
import { Graphics, Container, BitmapText } from 'pixi.js';

const DOW_LABELS = ['S U N', 'M O N', 'T U E', 'W E D', 'T H U', 'F R I', 'S A T'];

export class PeriodSeparatorIndicator extends BaseIndicator {
    // Zero-GC text pooling for Day of Week labels
    private labelContainer = new Container();
    private labelTextPool: BitmapText[] = [];
    private isContainerMounted = false;

    constructor() {
        super('PERIOD_SEP', 'Period & Day of Week Separator', false);

        this.params = [
            { id: 'showDOW', name: 'Show Days of Week Labels', type: 'boolean', value: true },
            { id: 'dowPosition', name: 'DOW Label Position', type: 'select', value: 'Bottom', options: ['Bottom', 'Top', 'Both'] },
            { id: 'dowVerticalOffset', name: 'DOW Vertical Offset (px)', type: 'number', value: 28, min: 0, max: 400, step: 2 },
            { id: 'dowColor', name: 'DOW Label Color', type: 'color', value: '#D1D4DC' },
            { id: 'showDay', name: 'Show Day Separators', type: 'boolean', value: true },
            { id: 'lineColor', name: 'Day Separator Color', type: 'color', value: '#D2D2D380' },
            { id: 'lineStyle', name: 'Day Separator Style', type: 'select', value: 'Solid', options: ['Solid', 'Dashed', 'Dotted'] },
            { id: 'show4H', name: 'Show 4H Separators', type: 'boolean', value: true },
            { id: 'lineColor4H', name: '4H Separator Color', type: 'color', value: '#80808066' },
            { id: 'lineStyle4H', name: '4H Separator Style', type: 'select', value: 'Dotted', options: ['Solid', 'Dashed', 'Dotted'] },
            { id: 'show1H', name: 'Show 1H Separators', type: 'boolean', value: false },
            { id: 'lineColor1H', name: '1H Separator Color', type: 'color', value: '#80808066' },
            { id: 'lineStyle1H', name: '1H Separator Style', type: 'select', value: 'Dotted', options: ['Solid', 'Dashed', 'Dotted'] },
            { id: 'showFuture', name: 'Project Future Separators', type: 'boolean', value: true }
        ];
    }

    public render(r: ChartRenderer, layout: IndicatorLayout, g: Graphics): void {
        if (!this.visible || r.dataStore.length === 0) {
            this.labelContainer.visible = false;
            return;
        }

        // Intraday only check (DOM = timeframe.isintraday in Pine Script)
        const tfMs = r.parseIntervalMs(r.currentInterval);
        const isIntraday = tfMs < 24 * 60 * 60 * 1000;
        if (!isIntraday) {
            this.labelContainer.visible = false;
            return;
        }

        if (!this.isContainerMounted) {
            r.app.stage.addChild(this.labelContainer);
            this.isContainerMounted = true;
        }
        this.labelContainer.visible = true;

        const ds = r.dataStore;
        const sp = r.candleSpacing * r.zoom;
        const screenW = layout.chartWidth;

        // Settings
        const showDOW = this.getParam<boolean>('showDOW', true);
        const dowPosition = (this.getParam<string>('dowPosition', 'Bottom')) as 'Bottom' | 'Top' | 'Both';
        const dowVerticalOffset = Math.max(0, this.getParam<number>('dowVerticalOffset', 28));
        const rawDowColor = String(this.getParam('dowColor', '#D1D4DC')).trim();
        let dowColor = parseColor(rawDowColor);
        if (!r.isDarkTheme && (dowColor === 0xffffff || dowColor === 0xd1d4dc)) {
            dowColor = 0x131722;
        }

        const showDay = this.getParam<boolean>('showDay', true);
        const dayLineParsed = parseColorAndAlpha(this.getParam('lineColor', '#D2D2D380'), 0.5);
        const dayLineStyle = (this.getParam<string>('lineStyle', 'Solid').toLowerCase()) as LineStyle;

        const show4H = this.getParam<boolean>('show4H', true) && tfMs < 4 * 3600000;
        const line4HParsed = parseColorAndAlpha(this.getParam('lineColor4H', '#80808066'), 0.4);
        const line4HStyle = (this.getParam<string>('lineStyle4H', 'Dotted').toLowerCase()) as LineStyle;

        const show1H = this.getParam<boolean>('show1H', false) && tfMs < 3600000;
        const line1HParsed = parseColorAndAlpha(this.getParam('lineColor1H', '#80808066'), 0.4);
        const line1HStyle = (this.getParam<string>('lineStyle1H', 'Dotted').toLowerCase()) as LineStyle;

        const showFuture = this.getParam<boolean>('showFuture', true);

        // Scan range
        const visStart = Math.max(0, Math.floor(r.cameraX / sp) - 5);
        const visEnd = Math.min(ds.length, Math.floor((r.cameraX + screenW) / sp) + 5);

        // Recency cutoffs from Pine Script: 28 days for DOW/Day, 5 days for 1H/4H
        const now = Date.now();
        const cutoff28Days = now - (28 * 24 * 60 * 60 * 1000);
        const cutoff5Days = now - (5 * 24 * 60 * 60 * 1000);

        let activeTextCount = 0;

        const topY = Math.max(12, Math.min(layout.mainChartHeight - 12, dowVerticalOffset));
        const bottomY = Math.max(12, Math.min(layout.mainChartHeight - 12, layout.mainChartHeight - dowVerticalOffset));

        const placeLabel = (text: string, xPos: number, yPos: number) => {
            let textItem: BitmapText;
            if (activeTextCount < this.labelTextPool.length) {
                textItem = this.labelTextPool[activeTextCount];
            } else {
                textItem = new BitmapText({
                    text: '',
                    style: { fontFamily: 'ChartFont', fontSize: 11, fontWeight: 'bold' }
                });
                textItem.anchor.set(0.5);
                this.labelTextPool.push(textItem);
                this.labelContainer.addChild(textItem);
            }

            textItem.text = text;
            textItem.tint = dowColor;
            textItem.x = xPos;
            textItem.y = yPos;
            textItem.visible = true;
            activeTextCount++;
        };

        const renderDOWLabelAt = (text: string, xPos: number) => {
            if (dowPosition === 'Top') {
                placeLabel(text, xPos, topY);
            } else if (dowPosition === 'Bottom') {
                placeLabel(text, xPos, bottomY);
            } else if (dowPosition === 'Both') {
                placeLabel(text, xPos, topY);
                placeLabel(text, xPos, bottomY);
            }
        };

        // Helper: binary search for first bar at or after targetTime in DataStore
        const findFirstBarIndex = (targetTime: number): number => {
            let low = 0;
            let high = ds.length - 1;
            let res = -1;
            while (low <= high) {
                const mid = (low + high) >> 1;
                if (ds.data[mid * 6] >= targetTime) {
                    res = mid;
                    high = mid - 1;
                } else {
                    low = mid + 1;
                }
            }
            return res;
        };

        // Collect X positions for batch rendering (reduces draw calls from hundreds to 3)
        const dayXs: number[] = [];
        const fourHXs: number[] = [];
        const oneHXs: number[] = [];

        // 1. Iterate visible historical bars to collect separator line coordinates
        for (let i = visStart; i < visEnd; i++) {
            const t = ds.data[i * 6];
            const prevT = i > 0 ? ds.data[(i - 1) * 6] : (t - tfMs);

            const currDay = Math.floor(t / 86400000);
            const prevDay = Math.floor(prevT / 86400000);
            const isNewDay = i === 0 || currDay !== prevDay;

            const isRecentDay = t > cutoff28Days;
            const isRecentHTF = t > cutoff5Days;

            const x = r.getCandleCenterX(i);
            if (x < -20 || x > screenW + 20) continue;

            // Day Separator
            if (showDay && isNewDay && isRecentDay) {
                dayXs.push(x);
            }

            // 4H Separator (only if not already a new day line)
            if (show4H && isRecentHTF) {
                const curr4H = Math.floor(t / (4 * 3600000));
                const prev4H = Math.floor(prevT / (4 * 3600000));
                const isNew4H = curr4H !== prev4H;
                if (isNew4H && (!showDay || !isNewDay)) {
                    fourHXs.push(x);
                }
            }

            // 1H Separator (only if not already 4H or Day line)
            if (show1H && isRecentHTF) {
                const curr1H = Math.floor(t / 3600000);
                const prev1H = Math.floor(prevT / 3600000);
                const isNew1H = curr1H !== prev1H;
                const is4HBoundary = (Math.floor(t / (4 * 3600000)) !== Math.floor(prevT / (4 * 3600000)));
                if (isNew1H && (!showDay || !isNewDay) && (!show4H || !is4HBoundary)) {
                    oneHXs.push(x);
                }
            }
        }

        // 2. Render Day of Week (DOW) Labels centered to full day length
        if (showDOW && ds.length > 0) {
            const minBar = Math.max(0, visStart - 1);
            const maxBar = Math.min(ds.length - 1, visEnd + 1);
            const minDayKey = Math.floor(ds.data[minBar * 6] / 86400000) - 1;
            const maxDayKey = Math.floor(ds.data[maxBar * 6] / 86400000);

            for (let dKey = minDayKey; dKey <= maxDayKey; dKey++) {
                const dayStartTime = dKey * 86400000;
                if (dayStartTime <= cutoff28Days) continue;

                const firstBar = findFirstBarIndex(dayStartTime);
                if (firstBar === -1) continue;
                if (Math.floor(ds.data[firstBar * 6] / 86400000) !== dKey) continue;

                const xStart = r.getCandleCenterX(firstBar);

                const nextDayStartTime = (dKey + 1) * 86400000;
                const nextBar = findFirstBarIndex(nextDayStartTime);
                let xEnd: number;

                if (nextBar !== -1 && Math.floor(ds.data[nextBar * 6] / 86400000) === dKey + 1) {
                    xEnd = r.getCandleCenterX(nextBar);
                } else {
                    // Current / forming day or latest available day: project day end using 24h day length
                    const barsInDay = 86400000 / tfMs;
                    xEnd = r.getCandleCenterX(firstBar + barsInDay);
                }

                // Center of the day length horizontally
                const centerX = (xStart + xEnd) * 0.5;

                if (centerX >= -60 && centerX <= screenW + 60) {
                    const dObj = new Date(dayStartTime);
                    const dowStr = DOW_LABELS[dObj.getUTCDay()];
                    renderDOWLabelAt(dowStr, centerX);
                }
            }
        }

        // =========================================================================
        // 🔮 Future Period Separators & Projections (Right of latest candle)
        // =========================================================================
        if (showFuture && ds.length > 0) {
            const lastIdx = ds.length - 1;
            const lastTime = ds.data[lastIdx * 6];
            const nextDailyTime = (Math.floor(lastTime / 86400000) + 1) * 86400000;

            // 1. Future Daily Separators (Pine Script: 2 days ahead)
            if (showDay) {
                for (let step = 0; step < 2; step++) {
                    const futureTime = nextDailyTime + (step * 86400000);
                    const barsAhead = (futureTime - lastTime) / tfMs;
                    if (barsAhead > 500) break;

                    const fx = r.getCandleCenterX(lastIdx + barsAhead);
                    if (fx >= -20 && fx <= screenW + 20) {
                        dayXs.push(fx);
                    }
                }
            }

            // 2. Future DOW Labels (centered to future day length)
            if (showDOW) {
                for (let step = 0; step < 2; step++) {
                    const futureDayStart = nextDailyTime + (step * 86400000);
                    const futureDayEnd = futureDayStart + 86400000;

                    const startBarsAhead = (futureDayStart - lastTime) / tfMs;
                    const endBarsAhead = (futureDayEnd - lastTime) / tfMs;
                    if (startBarsAhead > 500) break;

                    const fxStart = r.getCandleCenterX(lastIdx + startBarsAhead);
                    const fxEnd = r.getCandleCenterX(lastIdx + endBarsAhead);
                    const fxCenter = (fxStart + fxEnd) * 0.5;

                    if (fxCenter >= -60 && fxCenter <= screenW + 60) {
                        const fDate = new Date(futureDayStart);
                        const dowStr = DOW_LABELS[fDate.getUTCDay()];
                        renderDOWLabelAt(dowStr, fxCenter);
                    }
                }
            }

            // 2. Future 4H Separators (Pine Script: up to 12 blocks ahead)
            if (show4H) {
                const next4HTime = (Math.floor(lastTime / (4 * 3600000)) + 1) * (4 * 3600000);
                for (let step = 0; step < 12; step++) {
                    const futureTime = next4HTime + (step * 4 * 3600000);
                    // Skip if coincident with daily separator
                    if (showDay && futureTime % 86400000 === 0) continue;

                    const barsAhead = (futureTime - lastTime) / tfMs;
                    if (barsAhead > 500) break;

                    const fx = r.getCandleCenterX(lastIdx + barsAhead);
                    if (fx >= 0 && fx <= screenW + 20) {
                        fourHXs.push(fx);
                    }
                }
            }

            // 3. Future 1H Separators (Pine Script: up to 24 blocks ahead)
            if (show1H) {
                const next1HTime = (Math.floor(lastTime / 3600000) + 1) * 3600000;
                for (let step = 0; step < 24; step++) {
                    const futureTime = next1HTime + (step * 3600000);
                    if (showDay && futureTime % 86400000 === 0) continue;
                    if (show4H && futureTime % (4 * 3600000) === 0) continue;

                    const barsAhead = (futureTime - lastTime) / tfMs;
                    if (barsAhead > 500) break;

                    const fx = r.getCandleCenterX(lastIdx + barsAhead);
                    if (fx >= 0 && fx <= screenW + 20) {
                        oneHXs.push(fx);
                    }
                }
            }
        }

        // 3. Execute batched line drawing calls
        const chartH = layout.mainChartHeight;
        if (dayXs.length > 0) {
            StrokeEngine.drawVerticalLines(g, dayXs, 0, chartH, {
                color: dayLineParsed.color,
                width: 1,
                alpha: dayLineParsed.alpha,
                style: dayLineStyle
            });
        }

        if (fourHXs.length > 0) {
            StrokeEngine.drawVerticalLines(g, fourHXs, 0, chartH, {
                color: line4HParsed.color,
                width: 1,
                alpha: line4HParsed.alpha,
                style: line4HStyle
            });
        }

        if (oneHXs.length > 0) {
            StrokeEngine.drawVerticalLines(g, oneHXs, 0, chartH, {
                color: line1HParsed.color,
                width: 1,
                alpha: line1HParsed.alpha,
                style: line1HStyle
            });
        }

        // Hide unused pooled labels
        for (let i = activeTextCount; i < this.labelTextPool.length; i++) {
            this.labelTextPool[i].visible = false;
        }
    }

    public override getValueAt(idx: number, ds: DataStore, _isDark: boolean, defaultTextClr: number) {
        if (idx < 0 || idx >= ds.length) {
            return { label: this.name, valueStr: '—', valueColor: defaultTextClr };
        }
        const t = ds.data[idx * 6];
        const d = new Date(t);
        const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()];
        const hours = String(d.getUTCHours()).padStart(2, '0');
        const mins = String(d.getUTCMinutes()).padStart(2, '0');
        return {
            label: 'Period Separator',
            valueStr: `${day} ${hours}:${mins}`,
            valueColor: parseColor(this.getParam('dowColor', '#D1D4DC'))
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
