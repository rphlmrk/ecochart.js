import { BaseIndicator, type IndicatorLayout, parseColorAndAlpha } from '../Indicator';
import type { DataStore } from '../../data/DataStore';
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
    coreEndIdx: number;
    high: number;
    low: number;
    sessionName: string;
    color: string;
    openTime: number;
    openPrice: number;
    orbHigh: number;
    orbLow: number;
    orbEndIdx: number;
    preOpenStartIdx: number;
    hours: string;
    closeTime?: number;
    isCurrentSession?: boolean;
}

export class MarketSessionsIndicator extends BaseIndicator {
    private labelContainer = new Container();
    private labelTextPool: BitmapText[] = [];
    private isContainerMounted = false;

    constructor() {
        super('MARKET_SESSIONS', 'Market Sessions');
        this.isOscillator = false;
        this.layerType = 'session';
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
            { id: 'showEndTime', name: 'Show Session End Time', type: 'boolean', value: true },
            { id: 'showMean', name: 'Show Mean Line', type: 'boolean', value: false },
            { id: 'axisOpacity', name: 'Time Axis Highlight Opacity (%)', type: 'number', value: 40, min: 0, max: 100, step: 5 },

            // Opening & Breakout (ORB) Controls
            { id: 'highlightOpen', name: 'Highlight Session Open', type: 'boolean', value: true },
            { id: 'openWindowDuration', name: 'Opening Chaos Window (Min)', type: 'number', value: 15, min: 1, max: 60, step: 1 },
            { id: 'showOpeningRange', name: 'Show Opening Range (ORB) High/Low', type: 'boolean', value: true },
            { id: 'showPreOpenZone', name: 'Highlight Pre-Open Caution (10-15m)', type: 'boolean', value: true },
            { id: 'endOnNextOpen', name: 'End Previous Session on Next Opening', type: 'boolean', value: true },
            { id: 'showOpenBellLine', name: 'Show Opening Bell Vertical Marker', type: 'boolean', value: true },

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

    // Pre-calculated session boxes per session name to eliminate render-loop CPU overhead
    public cachedBoxesBySession = new Map<string, SessionBox[]>();
    private lastCalculatedLength = -1;
    private lastCalcParamHash = '';

    protected override onParamsUpdated(): void {
        this.lastCalculatedLength = -1;
    }

    public override reset(): void {
        this.cachedBoxesBySession.clear();
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

    private buildCachedBoxes(ds: DataStore): void {
        const len = ds.length;
        if (len === 0) {
            this.cachedBoxesBySession.clear();
            this.lastCalculatedLength = 0;
            return;
        }

        const showRanges = this.getParam<boolean>('showRanges', true);
        if (!showRanges) {
            this.cachedBoxesBySession.clear();
            return;
        }

        const exchangeTz = this.getParam<boolean>('exchangeTimezone', true);
        const tzOffsetHours = exchangeTz ? 0 : this.getParam<number>('timezoneOffset', 0);
        const tzOffsetMs = tzOffsetHours * 3600000;

        const highlightOpen = this.getParam<boolean>('highlightOpen', true);
        const openWindowDuration = this.getParam<number>('openWindowDuration', 15);
        const showOpeningRange = this.getParam<boolean>('showOpeningRange', true);
        const showPreOpenZone = this.getParam<boolean>('showPreOpenZone', true);
        const endOnNextOpen = this.getParam<boolean>('endOnNextOpen', true);
        const showOpenBellLine = this.getParam<boolean>('showOpenBellLine', true);

        const showEndTime = this.getParam<boolean>('showEndTime', true);

        const sessions = [
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

        const axisOpacity = this.getParam<number>('axisOpacity', 40);

        const paramHash = sessions.map(s => `${s.enabled}:${s.hours}:${s.range}:${s.color}`).join('|') +
            `:${tzOffsetMs}:${highlightOpen}:${openWindowDuration}:${showOpeningRange}:${showPreOpenZone}:${endOnNextOpen}:${showOpenBellLine}:${showEndTime}:${axisOpacity}`;

        // Fast update: If length is unchanged and params match, only update the latest bar of the active box
        if (len === this.lastCalculatedLength && this.lastCalcParamHash === paramHash) {
            const lastIdx = len - 1;
            const base = lastIdx * 6;
            const t = ds.data[base];
            const h = ds.data[base + 2];
            const l = ds.data[base + 3];

            for (const sess of sessions) {
                if (!sess.enabled || !sess.range) continue;
                const list = this.cachedBoxesBySession.get(sess.name);
                if (list && list.length > 0) {
                    const latest = list[list.length - 1];
                    if (latest.endIdx === lastIdx || latest.coreEndIdx === lastIdx) {
                        if (h > latest.high) latest.high = h;
                        if (l < latest.low) latest.low = l;
                        if (t < latest.openTime + openWindowDuration * 60000) {
                            latest.orbEndIdx = lastIdx;
                            if (h > latest.orbHigh) latest.orbHigh = h;
                            if (l < latest.orbLow) latest.orbLow = l;
                        }
                    }
                }
            }
            return;
        }

        this.cachedBoxesBySession.clear();
        const openWindowMs = openWindowDuration * 60000;
        const preOpenMs = 15 * 60000;
        const lastBarIdx = len - 1;
        const lastBarTime = ds.data[lastBarIdx * 6];
        const intervalMs = (len >= 2) ? (ds.data[6] - ds.data[0]) : 60000;

        for (const sess of sessions) {
            if (!sess.enabled || !sess.range) continue;

            const { startMin, endMin } = MarketSessionsIndicator.parseSessionHours(sess.hours);
            if (startMin === endMin) continue;

            let inSess = false;
            let sessStartIdx = -1;
            let sessEndIdx = -1;
            let sessHigh = -Infinity;
            let sessLow = Infinity;
            let openTime = 0;
            let openPrice = 0;
            let orbHigh = -Infinity;
            let orbLow = Infinity;
            let orbEndIdx = -1;
            let preOpenStartIdx = -1;
            let prevDayNumber = -1;

            const boxes: SessionBox[] = [];

            for (let i = 0; i < len; i++) {
                const base = i * 6;
                const t = ds.data[base];
                const o = ds.data[base + 1];
                const h = ds.data[base + 2];
                const l = ds.data[base + 3];

                const tAdj = t + tzOffsetMs;
                const minuteOfDay = Math.floor((((tAdj % 86400000) + 86400000) % 86400000) / 60000);
                const dayNumber = Math.floor(tAdj / 86400000);

                const active = MarketSessionsIndicator.isMinuteInSession(minuteOfDay, startMin, endMin);
                const isNewDay = prevDayNumber !== -1 && dayNumber !== prevDayNumber;
                prevDayNumber = dayNumber;

                if (active) {
                    if (!inSess || (startMin < endMin && isNewDay)) {
                        if (inSess && sessStartIdx !== -1) {
                            boxes.push({
                                startIdx: sessStartIdx,
                                endIdx: sessEndIdx,
                                coreEndIdx: sessEndIdx,
                                high: sessHigh,
                                low: sessLow,
                                sessionName: sess.name,
                                color: sess.color,
                                openTime,
                                openPrice,
                                orbHigh: orbHigh === -Infinity ? sessHigh : orbHigh,
                                orbLow: orbLow === Infinity ? sessLow : orbLow,
                                orbEndIdx: orbEndIdx === -1 ? sessStartIdx : orbEndIdx,
                                preOpenStartIdx,
                                hours: sess.hours
                            });
                        }
                        inSess = true;
                        sessStartIdx = i;
                        sessEndIdx = i;
                        sessHigh = h;
                        sessLow = l;
                        openTime = t;
                        openPrice = o;
                        orbHigh = h;
                        orbLow = l;
                        orbEndIdx = i;

                        // Identify pre-open caution window (bars within 10-15 mins before open)
                        preOpenStartIdx = -1;
                        for (let p = i - 1; p >= Math.max(0, i - 60); p--) {
                            const pt = ds.data[p * 6];
                            if (pt >= openTime - preOpenMs && pt < openTime) {
                                preOpenStartIdx = p;
                            } else if (pt < openTime - preOpenMs) {
                                break;
                            }
                        }
                    } else {
                        sessEndIdx = i;
                        if (h > sessHigh) sessHigh = h;
                        if (l < sessLow) sessLow = l;

                        // Track Opening Range (Chaos Window)
                        if (t < openTime + openWindowMs) {
                            orbEndIdx = i;
                            if (h > orbHigh) orbHigh = h;
                            if (l < orbLow) orbLow = l;
                        }
                    }
                } else {
                    if (inSess) {
                        boxes.push({
                            startIdx: sessStartIdx,
                            endIdx: sessEndIdx,
                            coreEndIdx: sessEndIdx,
                            high: sessHigh,
                            low: sessLow,
                            sessionName: sess.name,
                            color: sess.color,
                            openTime,
                            openPrice,
                            orbHigh: orbHigh === -Infinity ? sessHigh : orbHigh,
                            orbLow: orbLow === Infinity ? sessLow : orbLow,
                            orbEndIdx: orbEndIdx === -1 ? sessStartIdx : orbEndIdx,
                            preOpenStartIdx,
                            hours: sess.hours
                        });
                        inSess = false;
                        sessStartIdx = -1;
                    }
                }
            }

            if (inSess && sessStartIdx !== -1) {
                const scheduledCloseTime = MarketSessionsIndicator.getSessionScheduledEndTime(openTime, sess.hours);
                const barsUntilScheduledClose = Math.max(0, Math.round((scheduledCloseTime - lastBarTime) / intervalMs));
                const projectedCoreEnd = lastBarIdx + barsUntilScheduledClose;

                boxes.push({
                    startIdx: sessStartIdx,
                    endIdx: projectedCoreEnd,
                    coreEndIdx: projectedCoreEnd,
                    high: sessHigh,
                    low: sessLow,
                    sessionName: sess.name,
                    color: sess.color,
                    openTime,
                    openPrice,
                    orbHigh: orbHigh === -Infinity ? sessHigh : orbHigh,
                    orbLow: orbLow === Infinity ? sessLow : orbLow,
                    orbEndIdx: orbEndIdx === -1 ? sessStartIdx : orbEndIdx,
                    preOpenStartIdx,
                    hours: sess.hours,
                    isCurrentSession: true
                });
            }

            this.cachedBoxesBySession.set(sess.name, boxes);
        }

        // Chain chronological sessions:
        // Rule: "the contdown for session end should end at pre open open the session should also end on the next session pre open"
        // Rule: "or when I drag the chart right only the current session"
        const allBoxes: SessionBox[] = [];
        for (const list of this.cachedBoxesBySession.values()) {
            allBoxes.push(...list);
        }
        allBoxes.sort((a, b) => a.startIdx - b.startIdx);

        for (let k = 0; k < allBoxes.length; k++) {
            const currentBox = allBoxes[k];
            let nextBoxRef: SessionBox | null = null;
            for (let j = k + 1; j < allBoxes.length; j++) {
                if (allBoxes[j].startIdx > currentBox.startIdx) {
                    nextBoxRef = allBoxes[j];
                    break;
                }
            }

            if (nextBoxRef) {
                const nextPreOpenTime = nextBoxRef.openTime - (15 * 60000);

                // Rule: "the new session does not show pre open until the pre session ends"
                const prevScheduledClose = MarketSessionsIndicator.getSessionScheduledEndTime(currentBox.openTime, currentBox.hours);
                if (lastBarTime < prevScheduledClose && nextBoxRef.openTime > lastBarTime) {
                    if (nextBoxRef.preOpenStartIdx !== -1) {
                        nextBoxRef.preOpenStartIdx = -1; // Suppressed until previous session ends
                    }
                }

                const preStart = (nextBoxRef.preOpenStartIdx !== -1 && nextBoxRef.preOpenStartIdx < nextBoxRef.startIdx)
                    ? nextBoxRef.preOpenStartIdx
                    : nextBoxRef.startIdx;

                // Rule: "Use the pre open as close time also on the box rang"
                const preOpenTime = (preStart < len && preStart >= 0) ? ds.data[preStart * 6] : nextPreOpenTime;
                currentBox.closeTime = preOpenTime;
                currentBox.isCurrentSession = false;

                // Rule: "the session should also end on the next session pre open"
                // Historical boxes end right before the next session pre-open and NEVER project past lastBarIdx!
                currentBox.endIdx = Math.min(lastBarIdx, Math.max(currentBox.startIdx, preStart - 1));
            } else {
                // Latest / current session on chart:
                // Rule: "when I drag the chart right only the current session"
                // Rule: "the contdown for session end should end at pre open open the session should also end on the next session pre open"
                const checkTime = Math.max(currentBox.openTime, lastBarTime);
                const nextPreMarketUtc = MarketSessionsIndicator.getNextPreMarketTimestamp(checkTime, sessions, tzOffsetMs);

                currentBox.closeTime = nextPreMarketUtc;
                currentBox.isCurrentSession = true;

                if (nextPreMarketUtc > lastBarTime) {
                    const barsAhead = Math.round((nextPreMarketUtc - lastBarTime) / intervalMs);
                    currentBox.endIdx = lastBarIdx + barsAhead;
                } else {
                    currentBox.endIdx = Math.max(currentBox.coreEndIdx, currentBox.startIdx);
                }
            }
        }

        this.lastCalculatedLength = len;
        this.lastCalcParamHash = paramHash;
    }

    public static getSessionScheduledEndTime(openTime: number, hoursStr: string): number {
        const { startMin, endMin } = MarketSessionsIndicator.parseSessionHours(hoursStr);
        let durationMin = endMin - startMin;
        if (durationMin <= 0) {
            durationMin += 24 * 60;
        }
        return openTime + (durationMin * 60000);
    }

    public static getNextSessionEndTimestamp(
        fromTime: number,
        sessions: Array<{ enabled: boolean; hours: string }>,
        tzOffsetMs: number
    ): number {
        const active = sessions.filter(s => s.enabled);
        if (active.length === 0) return fromTime + (24 * 3600000);

        let minNextEnd = Infinity;
        const fromLocal = fromTime + tzOffsetMs;
        const fromDayBase = Math.floor(fromLocal / 86400000) * 86400000;

        for (let d = 0; d <= 4; d++) {
            const dayBase = fromDayBase + (d * 86400000);
            for (const sess of active) {
                const { endMin } = MarketSessionsIndicator.parseSessionHours(sess.hours);
                const endLocal = dayBase + (endMin * 60000);
                const endUtc = endLocal - tzOffsetMs;

                if (endUtc > fromTime && endUtc < minNextEnd) {
                    minNextEnd = endUtc;
                }
            }
        }

        return minNextEnd === Infinity ? fromTime + (24 * 3600000) : minNextEnd;
    }

    public static getNextPreMarketTimestamp(
        fromTime: number,
        sessions: Array<{ enabled: boolean; hours: string }>,
        tzOffsetMs: number
    ): number {
        const active = sessions.filter(s => s.enabled);
        if (active.length === 0) return fromTime + (24 * 3600000);

        let minNext = Infinity;
        const fromLocal = fromTime + tzOffsetMs;
        const fromDayBase = Math.floor(fromLocal / 86400000) * 86400000;

        for (let d = 0; d <= 4; d++) {
            const dayBase = fromDayBase + (d * 86400000);
            for (const sess of active) {
                const { startMin } = MarketSessionsIndicator.parseSessionHours(sess.hours);
                // Pre-open caution window starts 15 mins before open
                const preOpenLocal = dayBase + (startMin * 60000) - (15 * 60000);
                const preOpenUtc = preOpenLocal - tzOffsetMs;

                if (preOpenUtc > fromTime && preOpenUtc < minNext) {
                    minNext = preOpenUtc;
                }
            }
        }

        return minNext === Infinity ? fromTime + (24 * 3600000) : minNext;
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

        const showRanges = this.getParam<boolean>('showRanges', true);
        if (!showRanges) {
            this.labelContainer.visible = false;
            return;
        }

        // Lazy compute session boxes if not pre-calculated
        if (this.cachedBoxesBySession.size === 0 || this.lastCalculatedLength !== r.dataStore.length) {
            this.buildCachedBoxes(r.dataStore);
        }

        const parent = r.sessionBoxContainer || r.app.stage;
        if (!this.isContainerMounted || this.labelContainer.parent !== parent) {
            if (this.labelContainer.parent) {
                this.labelContainer.parent.removeChild(this.labelContainer);
            }
            parent.addChild(this.labelContainer);
            this.isContainerMounted = true;
        }
        this.labelContainer.visible = true;

        const screenW = layout.chartWidth;
        const mainH = layout.mainChartHeight;
        const spacing = r.candleSpacing * r.zoom;

        const rangeTransparency = Math.max(0, Math.min(100, this.getParam<number>('rangeTransparency', 80)));
        const rangeOutline = this.getParam<boolean>('rangeOutline', true);
        const rangeLabel = this.getParam<boolean>('rangeLabel', true);
        const showEndTime = this.getParam<boolean>('showEndTime', true);
        const showMean = this.getParam<boolean>('showMean', false);

        const exchangeTz = this.getParam<boolean>('exchangeTimezone', true);
        const tzOffsetHours = exchangeTz ? 0 : this.getParam<number>('timezoneOffset', 0);
        const tzOffsetMs = tzOffsetHours * 3600000;

        const highlightOpen = this.getParam<boolean>('highlightOpen', true);
        const showOpeningRange = this.getParam<boolean>('showOpeningRange', true);
        const showPreOpenZone = this.getParam<boolean>('showPreOpenZone', true);
        const endOnNextOpen = this.getParam<boolean>('endOnNextOpen', true);
        const showOpenBellLine = this.getParam<boolean>('showOpenBellLine', true);

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

        const sessions = [
            {
                enabled: this.getParam<boolean>('showSessionA', true),
                name: this.getParam<string>('sessionAName', 'New York'),
                range: this.getParam<boolean>('sessionARange', true),
                color: this.getParam<string>('sessionAColor', '#EF5350')
            },
            {
                enabled: this.getParam<boolean>('showSessionB', true),
                name: this.getParam<string>('sessionBName', 'London'),
                range: this.getParam<boolean>('sessionBRange', true),
                color: this.getParam<string>('sessionBColor', '#2962FF')
            },
            {
                enabled: this.getParam<boolean>('showSessionC', true),
                name: this.getParam<string>('sessionCName', 'Tokyo'),
                range: this.getParam<boolean>('sessionCRange', true),
                color: this.getParam<string>('sessionCColor', '#FBC02D')
            },
            {
                enabled: this.getParam<boolean>('showSessionD', false),
                name: this.getParam<string>('sessionDName', 'Sydney'),
                range: this.getParam<boolean>('sessionDRange', true),
                color: this.getParam<string>('sessionDColor', '#AB47BC')
            }
        ];

        // Render each session's boxes in batched draw calls
        for (const sess of sessions) {
            if (!sess.enabled || !sess.range) continue;
            const boxes = this.cachedBoxesBySession.get(sess.name);
            if (!boxes || boxes.length === 0) continue;

            const parsedColor = parseColorAndAlpha(sess.color);
            const boxFillAlpha = Math.max(0.02, Math.min(1.0, (100 - rangeTransparency) / 100));
            const outlineAlpha = Math.min(1.0, boxFillAlpha * 2.5 + 0.35);

            interface VisibleBoxGeometry {
                x1: number;
                x2: number;
                xCoreEnd: number;
                boxW: number;
                yHigh: number;
                yLow: number;
                boxH: number;
                yMean: number;
                xOpen: number;
                yOpen: number;
                xOrb1: number;
                xOrb2: number;
                yOrbHigh: number;
                yOrbLow: number;
                hasPreOpen: boolean;
                xPre1: number;
                xPre2: number;
                box: SessionBox;
            }

            const visibleBoxes: VisibleBoxGeometry[] = [];

            for (let bIdx = 0; bIdx < boxes.length; bIdx++) {
                const box = boxes[bIdx];
                const x1 = r.getCandleCenterX(box.startIdx) - (spacing * 0.45);
                const x2 = r.getCandleCenterX(box.endIdx) + (spacing * 0.45);
                const xCoreEnd = r.getCandleCenterX(box.coreEndIdx) + (spacing * 0.45);

                // Check pre-open bounds
                const hasPreOpen = showPreOpenZone && box.preOpenStartIdx !== -1 && box.preOpenStartIdx < box.startIdx;
                const xPre1 = hasPreOpen ? r.getCandleCenterX(box.preOpenStartIdx) - (spacing * 0.45) : x1;
                const xPre2 = x1;

                // Cull if completely off-screen
                if (x2 < -30 || (hasPreOpen ? xPre1 : x1) > screenW + 30) continue;

                const yHigh = r.priceToY(box.high);
                const yLow = r.priceToY(box.low);
                const boxW = Math.max(2, x2 - x1);
                const boxH = Math.max(2, yLow - yHigh);
                const yMean = r.priceToY((box.high + box.low) * 0.5);

                const xOpen = r.getCandleCenterX(box.startIdx);
                const yOpen = r.priceToY(box.openPrice);

                const xOrb1 = x1;
                const xOrb2 = r.getCandleCenterX(box.orbEndIdx) + (spacing * 0.45);
                const yOrbHigh = r.priceToY(box.orbHigh);
                const yOrbLow = r.priceToY(box.orbLow);

                visibleBoxes.push({
                    x1, x2, xCoreEnd, boxW, yHigh, yLow, boxH, yMean,
                    xOpen, yOpen, xOrb1, xOrb2, yOrbHigh, yOrbLow,
                    hasPreOpen, xPre1, xPre2, box
                });
            }

            if (visibleBoxes.length === 0) continue;

            // 1. Batch Fill Pre-Open Caution Zones (Phase 1: 10-15m before open)
            if (showPreOpenZone) {
                let hasDrawnPre = false;
                for (let i = 0; i < visibleBoxes.length; i++) {
                    const vb = visibleBoxes[i];
                    if (vb.hasPreOpen && vb.xPre2 > vb.xPre1) {
                        const preW = Math.max(2, vb.xPre2 - vb.xPre1);
                        g.rect(vb.xPre1, vb.yHigh, preW, vb.boxH);
                        hasDrawnPre = true;
                    }
                }
                if (hasDrawnPre) {
                    g.fill({ color: 0xFFA726, alpha: 0.14 });
                }

                // Dotted vertical line separating pre-open
                for (let i = 0; i < visibleBoxes.length; i++) {
                    const vb = visibleBoxes[i];
                    if (vb.hasPreOpen) {
                        StrokeEngine.addDashedLinePath(g, vb.xPre1, vb.yHigh, vb.xPre1, vb.yLow, 'dotted', 2, 3);
                    }
                }
                g.stroke({ color: 0xFFA726, width: 1, alpha: 0.65 });
            }

            // 2. Batch Fill Core Session Range Boxes
            for (let i = 0; i < visibleBoxes.length; i++) {
                const vb = visibleBoxes[i];
                if ((endOnNextOpen || vb.box.endIdx > vb.box.coreEndIdx) && vb.box.endIdx > vb.box.coreEndIdx) {
                    const coreW = Math.max(2, vb.xCoreEnd - vb.x1);
                    g.rect(vb.x1, vb.yHigh, coreW, vb.boxH);
                } else {
                    g.rect(vb.x1, vb.yHigh, vb.boxW, vb.boxH);
                }
            }
            g.fill({ color: parsedColor.color, alpha: boxFillAlpha });

            // 3. Batch Fill Extended Region (session box extending to when next pre-market starts)
            let hasExt = false;
            for (let i = 0; i < visibleBoxes.length; i++) {
                const vb = visibleBoxes[i];
                if (vb.box.endIdx > vb.box.coreEndIdx) {
                    const extW = Math.max(2, vb.x2 - vb.xCoreEnd);
                    g.rect(vb.xCoreEnd, vb.yHigh, extW, vb.boxH);
                    hasExt = true;
                }
            }
            if (hasExt) {
                g.fill({ color: parsedColor.color, alpha: boxFillAlpha * 0.75 });
            }

            // 4. Highlight Opening Chaos Window (Phase 2: First 5-15 mins)
            if (highlightOpen) {
                for (let i = 0; i < visibleBoxes.length; i++) {
                    const vb = visibleBoxes[i];
                    const orbW = Math.max(2, vb.xOrb2 - vb.xOrb1);
                    g.rect(vb.xOrb1, vb.yHigh, orbW, vb.boxH);
                }
                g.fill({ color: parsedColor.color, alpha: boxFillAlpha * 1.6 });
            }

            // 5. Batch Range Outlines (Entire session box extends to x2 when next pre-market starts)
            if (rangeOutline) {
                for (let i = 0; i < visibleBoxes.length; i++) {
                    const vb = visibleBoxes[i];
                    const outlineRight = vb.x2;

                    // Continuous box boundary from x1 to x2
                    StrokeEngine.addDashedLinePath(g, vb.x1, vb.yHigh, outlineRight, vb.yHigh, 'dotted', 2, 3);
                    StrokeEngine.addDashedLinePath(g, outlineRight, vb.yHigh, outlineRight, vb.yLow, 'dotted', 2, 3);
                    StrokeEngine.addDashedLinePath(g, outlineRight, vb.yLow, vb.x1, vb.yLow, 'dotted', 2, 3);
                    StrokeEngine.addDashedLinePath(g, vb.x1, vb.yLow, vb.x1, vb.yHigh, 'dotted', 2, 3);

                    // Subtly mark core market close if session was extended to next pre-market
                    if (vb.box.endIdx > vb.box.coreEndIdx && vb.xCoreEnd > vb.x1 && vb.xCoreEnd < vb.x2) {
                        StrokeEngine.addDashedLinePath(g, vb.xCoreEnd, vb.yHigh, vb.xCoreEnd, vb.yLow, 'dotted', 2, 4);
                    }
                }
                g.stroke({
                    color: parsedColor.color,
                    width: 1,
                    alpha: outlineAlpha,
                    cap: 'butt'
                });
            }

            // 6. Batch Mean / Midpoint lines
            if (showMean) {
                for (let i = 0; i < visibleBoxes.length; i++) {
                    const vb = visibleBoxes[i];
                    StrokeEngine.addDashedLinePath(g, vb.x1, vb.yMean, vb.x2, vb.yMean, 'dashed', 6, 4);
                }
                g.stroke({
                    color: parsedColor.color,
                    width: 1,
                    alpha: Math.min(1.0, boxFillAlpha * 2.5 + 0.4),
                    cap: 'butt'
                });
            }

            // 7. Opening Bell Vertical Line & Diamond Pip (Phase 2 Open)
            if (highlightOpen) {
                if (showOpenBellLine) {
                    for (let i = 0; i < visibleBoxes.length; i++) {
                        const vb = visibleBoxes[i];
                        // Spans from top of main chart to bottom (only when on-screen)
                        if (vb.xOpen >= 0 && vb.xOpen <= screenW) {
                            g.moveTo(vb.xOpen, 0).lineTo(vb.xOpen, mainH);
                        }
                    }
                    g.stroke({
                        color: parsedColor.color,
                        width: 1.5,
                        alpha: 0.55
                    });
                }

                // Diamond pip at the open price
                for (let i = 0; i < visibleBoxes.length; i++) {
                    const vb = visibleBoxes[i];
                    if (vb.xOpen >= 0 && vb.xOpen <= screenW) {
                        const yo = vb.yOpen;
                        const xo = vb.xOpen;
                        g.moveTo(xo, yo - 4)
                            .lineTo(xo + 4, yo)
                            .lineTo(xo, yo + 4)
                            .lineTo(xo - 4, yo)
                            .closePath();
                    }
                }
                g.fill({ color: parsedColor.color, alpha: 0.95 });
            }

            // 8. Opening Range Breakout (ORB) High & Low Baseline Boundaries (Phase 3: Golden Trading Window)
            if (showOpeningRange) {
                let hasOrb = false;
                for (let i = 0; i < visibleBoxes.length; i++) {
                    const vb = visibleBoxes[i];
                    if (vb.box.orbHigh > -Infinity && vb.box.orbLow < Infinity && vb.x2 > vb.xOrb2) {
                        const startX = Math.max(0, vb.xOrb2);
                        if (vb.x2 > startX) {
                            StrokeEngine.addDashedLinePath(g, startX, vb.yOrbHigh, vb.x2, vb.yOrbHigh, 'dashed', 5, 3);
                            hasOrb = true;
                        }
                    }
                }
                if (hasOrb) {
                    g.stroke({ color: 0x26A69A, width: 1.2, alpha: 0.85, cap: 'butt' });
                }

                let hasOrbLow = false;
                for (let i = 0; i < visibleBoxes.length; i++) {
                    const vb = visibleBoxes[i];
                    if (vb.box.orbHigh > -Infinity && vb.box.orbLow < Infinity && vb.x2 > vb.xOrb2) {
                        const startX = Math.max(0, vb.xOrb2);
                        if (vb.x2 > startX) {
                            StrokeEngine.addDashedLinePath(g, startX, vb.yOrbLow, vb.x2, vb.yOrbLow, 'dashed', 5, 3);
                            hasOrbLow = true;
                        }
                    }
                }
                if (hasOrbLow) {
                    g.stroke({ color: 0xEF5350, width: 1.2, alpha: 0.85, cap: 'butt' });
                }
            }

            // 9. Text Labels: Pre-Open, Session Name (at Open or pinned left when scrolling), Session End Time, and ORB Numbers
            for (let i = 0; i < visibleBoxes.length; i++) {
                const vb = visibleBoxes[i];
                const isScrolledPastOpen = vb.xOpen < 0;

                // 1. Pre-open label: only show if pre-open is on-screen (hidden when scrolled left past open)
                let preOpenShown = false;
                let preOpenRight = 0;
                if (!isScrolledPastOpen && showPreOpenZone && vb.hasPreOpen && vb.xPre1 >= 0 && vb.xPre1 <= screenW - 30) {
                    const preX = Math.max(4, vb.xPre1 + 2);
                    placeLabel('PRE-OPEN', preX, Math.max(12, vb.yHigh - 12), 0xFFA726);
                    preOpenShown = true;
                    preOpenRight = preX + 58; // 58px approximate width of "PRE-OPEN" (font size 10)
                }

                // 2. Open label IS the session name (no separate OPEN tag, no duplicate name)
                // When scrolling left, pin session name to the left edge so it remains visible
                let labelX = Math.max(8, vb.x1 + 2);
                // Ensure sufficient space between PRE-OPEN and the session name so they never overlap!
                if (preOpenShown && labelX < preOpenRight + 12) {
                    labelX = preOpenRight + 12;
                }
                if (rangeLabel && vb.x2 > 30) {
                    if (labelX <= Math.min(screenW - 30, vb.x2 - 15)) {
                        const labelY = Math.max(12, vb.yHigh - 12);
                        placeLabel(vb.box.sessionName, labelX, labelY, parsedColor.color);
                    }
                }

                // 3. Session End Time label on the right side top of the session box
                // Uses the pre open as close time also on the box range!
                if (showEndTime && vb.x2 > 50) {
                    let endStr = '';
                    if (vb.box.closeTime && vb.box.closeTime > 0) {
                        const d = new Date(vb.box.closeTime + tzOffsetMs);
                        const endH = d.getUTCHours();
                        const endM = d.getUTCMinutes();
                        endStr = `${endH.toString().padStart(2, '0')}:${endM.toString().padStart(2, '0')}`;
                    } else if (vb.box.hours) {
                        const { endMin } = MarketSessionsIndicator.parseSessionHours(vb.box.hours);
                        if (endMin > 0) {
                            const endH = Math.floor(endMin / 60) % 24;
                            const endM = endMin % 60;
                            endStr = `${endH.toString().padStart(2, '0')}:${endM.toString().padStart(2, '0')}`;
                        }
                    }

                    if (endStr) {
                        const endText = `Close ${endStr}`;
                        const endTextW = 60;
                        let endX = vb.x2 - endTextW - 4;
                        // ONLY pin inside view if it's the current session extending past screen right edge
                        if (vb.box.isCurrentSession && endX > screenW - endTextW - 10) {
                            endX = screenW - endTextW - 10;
                        }
                        // Only render if it has enough clearance from the left session name label
                        if (endX > labelX + 55 && endX >= 0 && endX <= screenW - 10) {
                            const endY = Math.max(12, vb.yHigh - 12);
                            placeLabel(endText, endX, endY, parsedColor.color);
                        }
                    }
                }

                // 4. ORB High & Low Breakout boundary labels: JUST show the numbers!
                // When scrolling left, only show the session name and orb lines (hide numbers once scrolled past open window)
                if (showOpeningRange && vb.x2 > vb.xOrb2 && vb.box.orbHigh > -Infinity && vb.box.orbLow < Infinity) {
                    if (vb.xOrb2 >= 0 && (vb.xOrb2 + 4) <= Math.min(screenW - 35, vb.x2 - 10)) {
                        const orbNumX = vb.xOrb2 + 4;
                        const hFormatted = vb.box.orbHigh >= 100 ? vb.box.orbHigh.toFixed(2) : vb.box.orbHigh.toFixed(4);
                        const lFormatted = vb.box.orbLow >= 100 ? vb.box.orbLow.toFixed(2) : vb.box.orbLow.toFixed(4);
                        placeLabel(hFormatted, orbNumX, Math.max(12, vb.yOrbHigh - 10), 0x26A69A);
                        placeLabel(lFormatted, orbNumX, Math.min(mainH - 16, vb.yOrbLow + 2), 0xEF5350);
                    }
                }

                // 5. Live Session Countdown placed at Session Box Bottom Right
                // Rule: "move the session countdown from the axis to session box bottom right"
                // Rule: "the contdown for session end should end at pre open"
                if (vb.box.isCurrentSession && vb.box.closeTime && vb.box.closeTime > 0) {
                    const nowMs = Date.now();
                    const remSecs = Math.max(0, Math.floor((vb.box.closeTime - nowMs) / 1000));
                    const h = Math.floor(remSecs / 3600);
                    const m = Math.floor((remSecs % 3600) / 60);
                    const s = remSecs % 60;
                    const timeStr = `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;

                    const isEndingSoon = remSecs <= 900; // <= 15m
                    const icon = isEndingSoon ? '⚠️' : '⏳';
                    const cdText = `${icon} Ends ${timeStr}`;
                    const cdTextW = 76;

                    // Position inside the session box at the bottom right
                    let cdX = vb.x2 - cdTextW - 4;
                    if (cdX > screenW - cdTextW - 10) {
                        cdX = screenW - cdTextW - 10;
                    }
                    cdX = Math.max(8, cdX);

                    let cdY = vb.yLow - 14;
                    if (cdY > mainH - 16) cdY = mainH - 16;
                    if (cdY < vb.yHigh + 14) cdY = vb.yHigh + 14;

                    const cdColor = isEndingSoon ? 0xFFA726 : parsedColor.color;
                    placeLabel(cdText, cdX, cdY, cdColor);
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
