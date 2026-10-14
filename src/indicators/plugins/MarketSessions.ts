import { BaseIndicator, type IndicatorLayout, parseColorAndAlpha } from '../Indicator';
import type { ChartRenderer } from '../../renderer/ChartRenderer';
import { StrokeEngine } from '../../renderer/StrokeEngine';
import { Container, BitmapText, Graphics } from 'pixi.js';

export interface MarketSessionDef {
    enabled: boolean;
    name: string;
    hours: string;
    range: boolean;
    color: string;
}

export interface SessionBox {
    startIdx: number;
    endIdx: number;
    high: number;
    low: number;
    sessionName: string;
    color: string;
}

export class MarketSessionsIndicator extends BaseIndicator {
    private labelContainer = new Container();
    private labelTextPool: BitmapText[] = [];
    private isContainerMounted = false;

    constructor() {
        super('MARKET_SESSIONS', 'Market Sessions');
        this.isOscillator = false;
        this.params = [
            // Master toggle
            { id: 'showRanges', name: 'Show Range Boxes', type: 'boolean', value: true },

            // Timezone
            { id: 'exchangeTimezone', name: 'Use Exchange Timezone (UTC)', type: 'boolean', value: true },
            { id: 'timezoneOffset', name: 'Timezone UTC Offset', type: 'number', value: 0, min: -12, max: 14, step: 1 },

            // Ranges Settings
            { id: 'rangeTransparency', name: 'Range Transparency', type: 'number', value: 80, min: 0, max: 100, step: 1 },
            { id: 'rangeOutline', name: 'Range Outline (Dotted)', type: 'boolean', value: true },
            { id: 'rangeLabel', name: 'Range Label', type: 'boolean', value: true },
            { id: 'showMean', name: 'Show Mean Line', type: 'boolean', value: false },

            // Session A
            { id: 'showSessionA', name: 'Enable Session A', type: 'boolean', value: true },
            { id: 'sessionAName', name: 'Session A Name', type: 'string', value: 'New York' },
            { id: 'sessionATime', name: 'Session A Hours', type: 'string', value: '1300-2200' },
            { id: 'sessionARange', name: 'Session A Range', type: 'boolean', value: true },
            { id: 'sessionAColor', name: 'Session A Color', type: 'color', value: '#EF5350' },

            // Session B
            { id: 'showSessionB', name: 'Enable Session B', type: 'boolean', value: true },
            { id: 'sessionBName', name: 'Session B Name', type: 'string', value: 'London' },
            { id: 'sessionBTime', name: 'Session B Hours', type: 'string', value: '0700-1600' },
            { id: 'sessionBRange', name: 'Session B Range', type: 'boolean', value: true },
            { id: 'sessionBColor', name: 'Session B Color', type: 'color', value: '#2962FF' },

            // Session C
            { id: 'showSessionC', name: 'Enable Session C', type: 'boolean', value: true },
            { id: 'sessionCName', name: 'Session C Name', type: 'string', value: 'Tokyo' },
            { id: 'sessionCTime', name: 'Session C Hours', type: 'string', value: '0000-0900' },
            { id: 'sessionCRange', name: 'Session C Range', type: 'boolean', value: true },
            { id: 'sessionCColor', name: 'Session C Color', type: 'color', value: '#FBC02D' },

            // Session D
            { id: 'showSessionD', name: 'Enable Session D', type: 'boolean', value: false },
            { id: 'sessionDName', name: 'Session D Name', type: 'string', value: 'Sydney' },
            { id: 'sessionDTime', name: 'Session D Hours', type: 'string', value: '2100-0600' },
            { id: 'sessionDRange', name: 'Session D Range', type: 'boolean', value: true },
            { id: 'sessionDColor', name: 'Session D Color', type: 'color', value: '#AB47BC' }
        ];
    }

    public calculate(): void {
        // Range boxes are dynamic viewport bounds rendered in render()
    }

    public static parseSessionHours(hStr: string): { startMin: number; endMin: number } {
        if (!hStr) return { startMin: 0, endMin: 0 };
        const clean = hStr.replace(/\s+/g, '');
        const parts = clean.split('-');
        if (parts.length !== 2) return { startMin: 0, endMin: 0 };

        const parsePart = (p: string) => {
            if (p.includes(':')) {
                const [h, m] = p.split(':');
                return (parseInt(h, 10) || 0) * 60 + (parseInt(m, 10) || 0);
            }
            if (p.length === 4) {
                const h = parseInt(p.slice(0, 2), 10) || 0;
                const m = parseInt(p.slice(2, 4), 10) || 0;
                return h * 60 + m;
            }
            const val = parseInt(p, 10) || 0;
            return val * 60;
        };

        const startMin = parsePart(parts[0]);
        const endMin = parsePart(parts[1]);
        return { startMin, endMin };
    }

    public static isMinuteInSession(minuteOfDay: number, startMin: number, endMin: number): boolean {
        if (startMin === endMin) return false;
        if (startMin < endMin) {
            return minuteOfDay >= startMin && minuteOfDay < endMin;
        }
        // Spans midnight
        return minuteOfDay >= startMin || minuteOfDay < endMin;
    }

    public render(r: ChartRenderer, layout: IndicatorLayout, g: Graphics): void {
        if (!this.visible || r.dataStore.length === 0) {
            this.labelContainer.visible = false;
            return;
        }

        // Market Sessions indicator operates on intraday timeframes (up to 1 hour)
        const htf = ['2h', '3h', '4h', '6h', '8h', '12h', '1d', '3d', '1w', '1M'];
        if (htf.includes(r.currentInterval)) {
            this.labelContainer.visible = false;
            return;
        }

        if (!this.isContainerMounted) {
            r.app.stage.addChild(this.labelContainer);
            this.isContainerMounted = true;
        }
        this.labelContainer.visible = true;

        const ds = r.dataStore;
        const len = ds.length;
        const screenW = layout.chartWidth;
        const spacing = r.candleSpacing * r.zoom;

        const showRanges = this.getParam<boolean>('showRanges', true);
        const exchangeTz = this.getParam<boolean>('exchangeTimezone', true);
        const tzOffsetHours = exchangeTz ? 0 : this.getParam<number>('timezoneOffset', 0);
        const tzOffsetMs = tzOffsetHours * 3600000;

        const rangeTransparency = Math.max(0, Math.min(100, this.getParam<number>('rangeTransparency', 80)));
        const rangeOutline = this.getParam<boolean>('rangeOutline', true);
        const rangeLabel = this.getParam<boolean>('rangeLabel', true);
        const showMean = this.getParam<boolean>('showMean', false);

        // Hide all pooled labels initially
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

        const sessions: { enabled: boolean; name: string; hours: string; range: boolean; color: string }[] = [
            {
                enabled: this.getParam<boolean>('showSessionA', true),
                name: this.getParam<string>('sessionAName', 'New York'),
                hours: this.getParam<string>('sessionATime', '1300-2200'),
                range: this.getParam<boolean>('sessionARange', true),
                color: this.getParam<string>('sessionAColor', '#EF5350')
            },
            {
                enabled: this.getParam<boolean>('showSessionB', true),
                name: this.getParam<string>('sessionBName', 'London'),
                hours: this.getParam<string>('sessionBTime', '0700-1600'),
                range: this.getParam<boolean>('sessionBRange', true),
                color: this.getParam<string>('sessionBColor', '#2962FF')
            },
            {
                enabled: this.getParam<boolean>('showSessionC', true),
                name: this.getParam<string>('sessionCName', 'Tokyo'),
                hours: this.getParam<string>('sessionCTime', '0000-0900'),
                range: this.getParam<boolean>('sessionCRange', true),
                color: this.getParam<string>('sessionCColor', '#FBC02D')
            },
            {
                enabled: this.getParam<boolean>('showSessionD', false),
                name: this.getParam<string>('sessionDName', 'Sydney'),
                hours: this.getParam<string>('sessionDTime', '2100-0600'),
                range: this.getParam<boolean>('sessionDRange', true),
                color: this.getParam<string>('sessionDColor', '#AB47BC')
            }
        ];

        if (!showRanges) return;

        // Process up to 500 session boxes across all active sessions
        for (const sess of sessions) {
            if (!sess.enabled || !sess.range) continue;

            const { startMin, endMin } = MarketSessionsIndicator.parseSessionHours(sess.hours);
            if (startMin === endMin) continue;

            const parsedColor = parseColorAndAlpha(sess.color);
            const boxFillAlpha = Math.max(0.02, Math.min(1.0, (100 - rangeTransparency) / 100));

            // Track session runs
            let inSess = false;
            let sessStartIdx = -1;
            let sessEndIdx = -1;
            let sessHigh = -Infinity;
            let sessLow = Infinity;
            let prevDayNumber = -1;

            const boxes: SessionBox[] = [];

            // Scan range with lookback so boxes spanning across the viewport border are complete
            const visStart = Math.max(0, Math.floor(r.cameraX / spacing) - 5);
            const visEnd = Math.min(len, Math.floor((r.cameraX + screenW) / spacing) + 5);
            const scanStart = Math.max(0, visStart - 200);
            const scanEnd = Math.min(len, visEnd + 50);

            for (let i = scanStart; i < scanEnd; i++) {
                const base = i * 6;
                const t = ds.data[base];
                const h = ds.data[base + 2];
                const l = ds.data[base + 3];

                const tAdj = t + tzOffsetMs;
                const minuteOfDay = Math.floor((((tAdj % 86400000) + 86400000) % 86400000) / 60000);
                const dayNumber = Math.floor(tAdj / 86400000);

                const active = MarketSessionsIndicator.isMinuteInSession(minuteOfDay, startMin, endMin);

                // Detect day boundary if session doesn't span midnight
                const isNewDay = prevDayNumber !== -1 && dayNumber !== prevDayNumber;
                prevDayNumber = dayNumber;

                if (active) {
                    if (!inSess || (startMin < endMin && isNewDay)) {
                        // Close previous if needed
                        if (inSess && sessStartIdx !== -1) {
                            boxes.push({
                                startIdx: sessStartIdx,
                                endIdx: sessEndIdx,
                                high: sessHigh,
                                low: sessLow,
                                sessionName: sess.name,
                                color: sess.color
                            });
                        }
                        inSess = true;
                        sessStartIdx = i;
                        sessEndIdx = i;
                        sessHigh = h;
                        sessLow = l;
                    } else {
                        sessEndIdx = i;
                        if (h > sessHigh) sessHigh = h;
                        if (l < sessLow) sessLow = l;
                    }
                } else {
                    if (inSess) {
                        boxes.push({
                            startIdx: sessStartIdx,
                            endIdx: sessEndIdx,
                            high: sessHigh,
                            low: sessLow,
                            sessionName: sess.name,
                            color: sess.color
                        });
                        inSess = false;
                        sessStartIdx = -1;
                    }
                }
            }

            // If still open at the right edge
            if (inSess && sessStartIdx !== -1) {
                boxes.push({
                    startIdx: sessStartIdx,
                    endIdx: sessEndIdx,
                    high: sessHigh,
                    low: sessLow,
                    sessionName: sess.name,
                    color: sess.color
                });
            }

            // Render all collected session boxes
            for (const box of boxes) {
                const x1 = r.getCandleCenterX(box.startIdx) - (spacing * 0.45);
                const x2 = r.getCandleCenterX(box.endIdx) + (spacing * 0.45);

                // Cull if off-screen
                if (x2 < -30 || x1 > screenW + 30) continue;

                const yHigh = r.priceToY(box.high);
                const yLow = r.priceToY(box.low);

                const boxW = Math.max(2, x2 - x1);
                const boxH = Math.max(2, yLow - yHigh);

                // 1. Fill Range Box
                g.rect(x1, yHigh, boxW, boxH).fill({
                    color: parsedColor.color,
                    alpha: boxFillAlpha
                });

                // 2. Range Outline (dotted)
                if (rangeOutline) {
                    const outlineAlpha = Math.min(1.0, boxFillAlpha * 2.5 + 0.35);
                    const strokeOpts = {
                        color: parsedColor.color,
                        width: 1,
                        alpha: outlineAlpha,
                        style: 'dotted' as const
                    };
                    StrokeEngine.drawLine(g, x1, yHigh, x2, yHigh, strokeOpts);
                    StrokeEngine.drawLine(g, x2, yHigh, x2, yLow, strokeOpts);
                    StrokeEngine.drawLine(g, x2, yLow, x1, yLow, strokeOpts);
                    StrokeEngine.drawLine(g, x1, yLow, x1, yHigh, strokeOpts);
                }

                // 3. Show Mean / Midpoint line
                if (showMean) {
                    const yMean = r.priceToY((box.high + box.low) * 0.5);
                    StrokeEngine.drawLine(g, x1, yMean, x2, yMean, {
                        color: parsedColor.color,
                        width: 1,
                        alpha: Math.min(1.0, boxFillAlpha * 2.5 + 0.4),
                        style: 'dashed'
                    });
                }

                // 4. Show Range Label (Session Name)
                if (rangeLabel && x1 <= screenW - 20) {
                    const labelY = Math.max(12, yHigh - 12);
                    placeLabel(box.sessionName, Math.max(4, x1 + 2), labelY, parsedColor.color);
                }
            }
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

// Backwards compatibility alias
export { MarketSessionsIndicator as LuxSessionsIndicator };
export type { MarketSessionDef as LuxSessionDef };
