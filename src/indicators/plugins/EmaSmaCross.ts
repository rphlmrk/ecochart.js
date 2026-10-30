import { BaseIndicator, parseColor, parseColorAndAlpha, type IndicatorLayout } from '../Indicator';
import type { DataStore } from '../../data/DataStore';
import type { ChartRenderer } from '../../renderer/ChartRenderer';
import { Graphics } from 'pixi.js';
import { alertManager } from '../../alerts/AlertManager';

export type CrossMarkerShape = 'triangle_up' | 'triangle_down' | 'circle' | 'circle_ring' | 'arrow_up' | 'arrow_down' | 'star' | 'cross' | 'diamond';

// Causal Timezone Session Classifier for Production Filter
function classifySession(timestampMs: number): { sessionId: 'London' | 'NewYorkPostOpen' | 'Outside'; sessionDate: string } {
    const date = new Date(timestampMs);
    try {
        const lonFormatter = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour12: false, weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
        const lonParts = lonFormatter.formatToParts(date);
        const lonWeekday = lonParts.find(p => p.type === 'weekday')?.value || '';
        const lonH = parseInt(lonParts.find(p => p.type === 'hour')?.value || '0', 10);
        const lonDateStr = `${lonParts.find(p => p.type === 'year')?.value}-${lonParts.find(p => p.type === 'month')?.value}-${lonParts.find(p => p.type === 'day')?.value}`;
        if (lonWeekday !== 'Sat' && lonWeekday !== 'Sun' && lonH >= 8 && lonH < 10) {
            return { sessionId: 'London', sessionDate: `LON_${lonDateStr}` };
        }

        const nyFormatter = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour12: false, weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
        const nyParts = nyFormatter.formatToParts(date);
        const nyWeekday = nyParts.find(p => p.type === 'weekday')?.value || '';
        const nyH = parseInt(nyParts.find(p => p.type === 'hour')?.value || '0', 10);
        const nyM = parseInt(nyParts.find(p => p.type === 'minute')?.value || '0', 10);
        const nyDateStr = `${nyParts.find(p => p.type === 'year')?.value}-${nyParts.find(p => p.type === 'month')?.value}-${nyParts.find(p => p.type === 'day')?.value}`;
        if (nyWeekday !== 'Sat' && nyWeekday !== 'Sun') {
            const nyTotalMin = nyH * 60 + nyM;
            if (nyTotalMin >= 9 * 60 + 30 && nyTotalMin < 11 * 60 + 30) {
                return { sessionId: 'NewYorkPostOpen', sessionDate: `NY_${nyDateStr}` };
            }
        }
    } catch (e) {}
    return { sessionId: 'Outside', sessionDate: 'OUTSIDE' };
}

export class EmaSmaCrossIndicator extends BaseIndicator {
    public emaValues: Float64Array = new Float64Array(20000);
    public smaValues: Float64Array = new Float64Array(20000);
    // +1 = Bullish Golden Cross (EMA crosses above SMA), -1 = Bearish Death Cross (EMA crosses below SMA), 0 = None
    public crossSignals: Int8Array = new Int8Array(20000);
    public crossPrices: Float64Array = new Float64Array(20000);

    // --- START NEW: Historical Shelf Registry & Quant Telemetry ---
    public crossRegistry: Array<{
        price: number; timeMs: number; direction: number;
        maxRunAtr: number; isMature: boolean; broken: boolean;
        startIndex: number; endIndex?: number;
    }> = [];
    private rollingAtr = 0;

    // Telemetry for Quant Filters (Causal tracking)
    private rawCrossHistory: Array<{ barIndex: number; direction: number }> = [];
    private sessionCounters = new Map<string, number>();
    // -------------------------------------------------------------

    // Alert Deduplication State
    private lastAlertedTime = -1;
    private lastAlertedDirection = 0;
    public currentSymbol = 'BTCUSDT';

    constructor(emaLength = 10, smaLength = 30) {
        super(`EMA_${emaLength}_SMA_${smaLength}_CROSS`, `EMA (${emaLength}) / SMA (${smaLength}) Cross`, false);

        this.params = [
            { id: 'emaLength', name: 'Fast EMA Length', type: 'number', value: emaLength, min: 1, max: 500, step: 1 },
            { id: 'emaColor', name: 'Fast EMA Color', type: 'color', value: '#00E5FF' },
            { id: 'emaWidth', name: 'Fast EMA Width', type: 'number', value: 2, min: 1, max: 5, step: 1 },
            { id: 'smaLength', name: 'Slow SMA Length', type: 'number', value: smaLength, min: 1, max: 500, step: 1 },
            { id: 'smaColor', name: 'Slow SMA Color', type: 'color', value: '#FF9800' },
            { id: 'smaWidth', name: 'Slow SMA Width', type: 'number', value: 2, min: 1, max: 5, step: 1 },
            { id: 'showLines', name: 'Show Moving Average Lines', type: 'boolean', value: true },
            { id: 'showCrossSignals', name: 'Show Cross Markers', type: 'boolean', value: true },
            { id: 'showHistoricalShelves', name: 'Show Mature Historical Shelves', type: 'boolean', value: true },
            { id: 'maxShelfAgeDays', name: 'Max Shelf Age (Days)', type: 'number', value: 2, min: 0.5, max: 30, step: 0.5 },
            { id: 'hideCrossedShelves', name: 'Hide Shelves Once Crossed', type: 'boolean', value: false },
            // --- RAD-ML-04F: PRODUCTION QUANT FILTERS ---
            {
                id: 'quantFilterMode',
                name: 'Quant Quality Filter',
                type: 'select',
                value: 'Off (Raw Mechanical)',
                options: [
                    'Off (Raw Mechanical)',
                    '24/7 Momentum (Chop <= 1 & RVOL >= 1.2)',
                    'Session Specialist (London/NY & Skip #1)'
                ]
            },
            { id: 'minRvol', name: 'Min Volume Surge (RVOL)', type: 'number', value: 1.2, min: 0.5, max: 5.0, step: 0.1 },
            { id: 'maxReversals', name: 'Max Whipsaws (30 Bars)', type: 'number', value: 1, min: 0, max: 5, step: 1 },
            { id: 'showFilteredSignals', name: 'Show Rejected Signals', type: 'boolean', value: true },
            {
                id: 'filteredShape',
                name: 'Rejected Signal Style',
                type: 'select',
                value: 'Hollow Ring (○)',
                options: [
                    'Hollow Ring (○)',
                    'Cross / X (✖)',
                    'Small Dot (•)',
                    'Diamond (◆)',
                    'Same Shape (Dimmed)'
                ]
            },
            { id: 'filteredAlpha', name: 'Rejected Signal Opacity', type: 'number', value: 0.40, min: 0.1, max: 1.0, step: 0.05 },
            // --------------------------------------------
            {
                id: 'shapeMode',
                name: 'Marker Style',
                type: 'select',
                value: 'distinct_symbols',
                options: [
                    'distinct_symbols', // Bull ▲ / Bear ▼ (Different Symbols)
                    'circle',           // Circle (●) for both Bull & Bear
                    'circle_ring',      // Circle Ring (○) for both
                    'arrows',           // Bull ⬆ / Bear ⬇ (Arrows)
                    'star_cross',       // Bull ★ / Bear ✖ (Star & X)
                    'diamonds',         // Diamonds (◆) for both
                    'custom'            // Custom Bull & Bear selection
                ]
            },
            {
                id: 'bullShape',
                name: 'Bull Symbol (Custom)',
                type: 'select',
                value: 'Triangle Up (▲)',
                options: ['Triangle Up (▲)', 'Circle (●)', 'Circle Ring (○)', 'Arrow Up (⬆)', 'Star (★)', 'Diamond (◆)']
            },
            {
                id: 'bearShape',
                name: 'Bear Symbol (Custom)',
                type: 'select',
                value: 'Triangle Down (▼)',
                options: ['Triangle Down (▼)', 'Circle (●)', 'Circle Ring (○)', 'Arrow Down (⬇)', 'Cross (✖)', 'Star (★)', 'Diamond (◆)']
            },
            {
                id: 'markerPosition',
                name: 'Marker Position',
                type: 'select',
                value: 'Above / Below Bar',
                options: ['Above / Below Bar', 'On Cross Price', 'Both']
            },
            { id: 'markerSize', name: 'Marker Size', type: 'number', value: 8, min: 4, max: 24, step: 1 },
            { id: 'bullColor', name: 'Bull Cross Color', type: 'color', value: '#00E676' },
            { id: 'bearColor', name: 'Bear Cross Color', type: 'color', value: '#EF5350' },
            { id: 'notificationsEnabled', name: 'Enable Cross Notifications', type: 'boolean', value: true },
            { id: 'notifyBull', name: 'Notify Bull Cross (Golden Cross)', type: 'boolean', value: true },
            { id: 'notifyBear', name: 'Notify Bear Cross (Death Cross)', type: 'boolean', value: true },
            { id: 'triggerOnClose', name: 'Trigger on Candle Close Only', type: 'boolean', value: true },
            { id: 'notificationSound', name: 'Notification Alarm Sound', type: 'boolean', value: true }
        ];
    }

    protected override onParamsUpdated(): void {
        const emaLen = Math.max(1, this.getParam<number>('emaLength', 10));
        const smaLen = Math.max(1, this.getParam<number>('smaLength', 30));
        this.id = `EMA_${emaLen}_SMA_${smaLen}_CROSS`;
        this.name = `EMA (${emaLen}) / SMA (${smaLen}) Cross`;
        this.reset();
    }

    public override reset(): void {
        this.emaValues.fill(0);
        this.smaValues.fill(0);
        this.crossSignals.fill(0);
        this.crossPrices.fill(0);
        this.lastAlertedTime = -1;
        this.lastAlertedDirection = 0;
        // --- START NEW ---
        this.crossRegistry = [];
        this.rollingAtr = 0;
        this.rawCrossHistory = [];
        this.sessionCounters.clear();
        super.reset();
    }

    public ensureCapacity(len: number): void {
        if (len > this.emaValues.length) {
            const newCap = Math.max(len * 2, 20000);
            const newEma = new Float64Array(newCap);
            newEma.set(this.emaValues);
            this.emaValues = newEma;

            const newSma = new Float64Array(newCap);
            newSma.set(this.smaValues);
            this.smaValues = newSma;

            const newSignals = new Int8Array(newCap);
            newSignals.set(this.crossSignals);
            this.crossSignals = newSignals;

            const newCrossPrices = new Float64Array(newCap);
            newCrossPrices.set(this.crossPrices);
            this.crossPrices = newCrossPrices;

            const newValues = new Float64Array(newCap);
            newValues.set(this.values);
            this.values = newValues;
        }
    }

    /**
     * Evaluates a raw cross against the active Quant Filter.
     * Returns: +1/-1 = Accepted, +2/-2 = Rejected (show with distinct dimmed shape)
     */
    private evaluateQuantSignal(rawCrossDir: number, i: number, ds: DataStore): number {
        if (rawCrossDir === 0) return 0;
        const filterMode = this.getParam<string>('quantFilterMode', 'Off (Raw Mechanical)');
        if (filterMode === 'Off (Raw Mechanical)') return rawCrossDir;

        // 1. Trailing 30-bar true directional reversals
        const windowStart = i - 29;
        const recentCrosses: Array<{ barIndex: number; direction: number }> = [];
        for (let k = this.rawCrossHistory.length - 1; k >= 0; k--) {
            if (this.rawCrossHistory[k].barIndex >= windowStart) {
                recentCrosses.unshift(this.rawCrossHistory[k]);
            } else {
                break;
            }
        }
        let reversals30 = 0;
        for (let k = 1; k < recentCrosses.length; k++) {
            if (recentCrosses[k].direction !== recentCrosses[k - 1].direction) reversals30++;
        }

        // 2. Relative Volume (RVOL)
        let volSum = 0;
        const startBar = Math.max(0, i - 19);
        const count = i - startBar + 1;
        for (let j = startBar; j <= i; j++) volSum += ds.data[j * 6 + 5];
        const avgVol = count > 0 ? (volSum / count) : 1.0;
        const curVol = ds.data[i * 6 + 5];
        const rvol = avgVol > 0 ? (curVol / avgVol) : 1.0;

        // 3. Session Info & Causal Count
        const barTimestamp = ds.data[i * 6];
        const sessionInfo = classifySession(barTimestamp);
        const sTradeNum = (this.sessionCounters.get(sessionInfo.sessionDate) || 0) + 1;
        this.sessionCounters.set(sessionInfo.sessionDate, sTradeNum);

        // 4. Filter Evaluation
        const minRvolReq = this.getParam<number>('minRvol', 1.2);
        const maxRevAllowed = this.getParam<number>('maxReversals', 1);

        let allowTrade = true;
        if (filterMode === '24/7 Momentum (Chop <= 1 & RVOL >= 1.2)') {
            if (reversals30 > maxRevAllowed || rvol < minRvolReq) allowTrade = false;
        } else if (filterMode === 'Session Specialist (London/NY & Skip #1)') {
            const isEligibleSession = sessionInfo.sessionId === 'London' || sessionInfo.sessionId === 'NewYorkPostOpen';
            if (!isEligibleSession || sTradeNum < 2 || reversals30 > maxRevAllowed) allowTrade = false;
        }

        // +1/-1 = ACCEPTED, +2/-2 = REJECTED/FILTERED
        return allowTrade ? rawCrossDir : (rawCrossDir * 2);
    }

    protected override calculate(ds: DataStore): void {
        const len = ds.length;
        if (len === 0) return;

        this.ensureCapacity(len);

        const emaLen = Math.max(1, Math.floor(this.getParam<number>('emaLength', 10)));
        const smaLen = Math.max(1, Math.floor(this.getParam<number>('smaLength', 30)));
        const k = 2 / (emaLen + 1);

        // Calculate full historical data or incremental update
        const isReset = this.lastCalculatedIdx === -1 || this.lastCalculatedIdx >= len || (len > this.lastCalculatedIdx + 2);
        const startIdx = isReset ? 0 : Math.max(0, this.lastCalculatedIdx);

        if (isReset) {
            // Full historical calculation
            let smaSum = 0;

            for (let i = 0; i < len; i++) {
                const c = ds.data[i * 6 + 4];

                // 1. Calculate EMA
                if (i === 0) {
                    this.emaValues[0] = c;
                } else {
                    this.emaValues[i] = (c - this.emaValues[i - 1]) * k + this.emaValues[i - 1];
                }

                // 2. Calculate SMA
                smaSum += c;
                if (i >= smaLen) {
                    smaSum -= ds.data[(i - smaLen) * 6 + 4];
                }

                if (i >= smaLen - 1) {
                    this.smaValues[i] = smaSum / smaLen;
                } else {
                    this.smaValues[i] = smaSum / (i + 1);
                }

                // 3. Detect Crosses with Unified Quant Tagging
                this.crossSignals[i] = 0;
                this.crossPrices[i] = 0;

                const minWarmup = Math.max(emaLen, smaLen) - 1;
                if (i > minWarmup) {
                    const prevEma = this.emaValues[i - 1];
                    const currEma = this.emaValues[i];
                    const prevSma = this.smaValues[i - 1];
                    const currSma = this.smaValues[i];

                    let rawCrossDir = 0;
                    if (prevEma <= prevSma && currEma > currSma) rawCrossDir = 1;
                    else if (prevEma >= prevSma && currEma < currSma) rawCrossDir = -1;

                    if (rawCrossDir !== 0) {
                        this.rawCrossHistory.push({ barIndex: i, direction: rawCrossDir });
                        const signalTag = this.evaluateQuantSignal(rawCrossDir, i, ds);
                        this.crossSignals[i] = signalTag as any;
                        this.crossPrices[i] = this.interpolateCross(prevEma, currEma, prevSma, currSma, c);
                    }
                }

                // --- START NEW: ATR & Historical Shelf Tracker ---
                const h = ds.data[i * 6 + 2];
                const l = ds.data[i * 6 + 3];
                const prevC = i > 0 ? ds.data[(i - 1) * 6 + 4] : c;
                const tr = Math.max(h - l, Math.abs(h - prevC), Math.abs(l - prevC));
                this.rollingAtr = i === 0 ? tr : (this.rollingAtr * 13 + tr) / 14;
                const currentAtr = Math.max(this.rollingAtr, 0.000001);

                // 1. Register New Cross: ONLY accepted signals (+1 or -1) can spawn shelves.
                // Filtered chop crosses (+2 or -2) are strictly blocked from creating lines!
                if (Math.abs(this.crossSignals[i]) === 1) {
                    this.crossRegistry.push({
                        price: this.crossPrices[i] || c,
                        timeMs: ds.data[i * 6],
                        direction: Math.sign(this.crossSignals[i]), // Strictly normalized to +1 or -1
                        maxRunAtr: 0,
                        isMature: false,
                        broken: false,
                        startIndex: i
                    });
                }

                // 2. Update existing crosses in memory
                const maxAgeHours = Math.max(1, this.getParam<number>('maxShelfAgeDays', 2)) * 24;

                for (let r = this.crossRegistry.length - 1; r >= 0; r--) {
                    const shelf = this.crossRegistry[r];
                    const ageHours = (ds.data[i * 6] - shelf.timeMs) / 3600000;

                    // AGE FILTER: Prune shelves older than Max Shelf Age (default 2 days)
                    if (ageHours > maxAgeHours) {
                        this.crossRegistry.splice(r, 1);
                        continue;
                    }

                    const dir = Math.sign(shelf.direction);

                    // Track Excursion
                    const runAtr = dir === 1 ? (h - shelf.price) / currentAtr : (shelf.price - l) / currentAtr;
                    if (runAtr > shelf.maxRunAtr) shelf.maxRunAtr = runAtr;

                    // Maturation: Ran > 5 ATR and is > 12 hours old
                    if (!shelf.isMature && shelf.maxRunAtr >= 5.0 && ageHours >= 12.0) {
                        shelf.isMature = true;
                    }

                    // TERMINATION: When price crosses the line, STOP EXTENDING at this candle!
                    if (shelf.isMature && !shelf.broken && i > shelf.startIndex) {
                        const isCrossed = dir === 1 ? (l <= shelf.price) : (h >= shelf.price);
                        if (isCrossed) {
                            shelf.broken = true;
                            shelf.endIndex = i; // Locks the line end to this candle
                        }
                    }

                    // Invalidation: Price closed 1.5 ATR past the shelf -> Prune completely
                    if ((dir === 1 && c < shelf.price - 1.5 * currentAtr) ||
                        (dir === -1 && c > shelf.price + 1.5 * currentAtr)) {
                        this.crossRegistry.splice(r, 1);
                        continue;
                    }
                }

                this.values[i] = this.emaValues[i]; // (Original line restored here)
                // --- END NEW ---
            }
        } else {
            // Live / incremental calculation for forming or new bar
            for (let i = startIdx; i < len; i++) {
                const c = ds.data[i * 6 + 4];

                if (i === 0) {
                    this.emaValues[0] = c;
                    this.smaValues[0] = c;
                } else {
                    this.emaValues[i] = (c - this.emaValues[i - 1]) * k + this.emaValues[i - 1];

                    // SMA window sum
                    const windowStart = Math.max(0, i - smaLen + 1);
                    const windowCount = i - windowStart + 1;
                    let sum = 0;
                    for (let j = windowStart; j <= i; j++) {
                        sum += ds.data[j * 6 + 4];
                    }
                    this.smaValues[i] = sum / windowCount;
                }

                // Cross detection on current bar with live Quant Tagging
                this.crossSignals[i] = 0;
                this.crossPrices[i] = 0;

                const minWarmup = Math.max(emaLen, smaLen) - 1;
                if (i > minWarmup) {
                    const prevEma = this.emaValues[i - 1];
                    const currEma = this.emaValues[i];
                    const prevSma = this.smaValues[i - 1];
                    const currSma = this.smaValues[i];

                    let rawCrossDir = 0;
                    if (prevEma <= prevSma && currEma > currSma) rawCrossDir = 1;
                    else if (prevEma >= prevSma && currEma < currSma) rawCrossDir = -1;

                    if (rawCrossDir !== 0) {
                        const signalTag = this.evaluateQuantSignal(rawCrossDir, i, ds);
                        this.crossSignals[i] = signalTag as any;
                        this.crossPrices[i] = this.interpolateCross(prevEma, currEma, prevSma, currSma, c);
                    }
                }
                // --- START NEW: ATR & Historical Shelf Tracker ---
                const h = ds.data[i * 6 + 2];
                const l = ds.data[i * 6 + 3];
                const prevC = i > 0 ? ds.data[(i - 1) * 6 + 4] : c;
                const tr = Math.max(h - l, Math.abs(h - prevC), Math.abs(l - prevC));
                this.rollingAtr = i === 0 ? tr : (this.rollingAtr * 13 + tr) / 14;
                const currentAtr = Math.max(this.rollingAtr, 0.000001);

                // 1. Register New Cross (Accepted signals only)
                if (Math.abs(this.crossSignals[i]) === 1) {
                    this.crossRegistry.push({
                        price: this.crossPrices[i] || c,
                        timeMs: ds.data[i * 6],
                        direction: Math.sign(this.crossSignals[i]),
                        maxRunAtr: 0,
                        isMature: false,
                        broken: false,
                        startIndex: i
                    });
                }

                // 2. Update existing crosses in memory
                const maxAgeHours = Math.max(1, this.getParam<number>('maxShelfAgeDays', 2)) * 24;

                for (let r = this.crossRegistry.length - 1; r >= 0; r--) {
                    const shelf = this.crossRegistry[r];
                    const ageHours = (ds.data[i * 6] - shelf.timeMs) / 3600000;

                    if (ageHours > maxAgeHours) {
                        this.crossRegistry.splice(r, 1);
                        continue;
                    }

                    const dir = Math.sign(shelf.direction);

                    const runAtr = dir === 1 ? (h - shelf.price) / currentAtr : (shelf.price - l) / currentAtr;
                    if (runAtr > shelf.maxRunAtr) shelf.maxRunAtr = runAtr;

                    if (!shelf.isMature && shelf.maxRunAtr >= 5.0 && ageHours >= 12.0) {
                        shelf.isMature = true;
                    }

                    // TERMINATION: Stop extending once crossed
                    if (shelf.isMature && !shelf.broken && i > shelf.startIndex) {
                        const isCrossed = dir === 1 ? (l <= shelf.price) : (h >= shelf.price);
                        if (isCrossed) {
                            shelf.broken = true;
                            shelf.endIndex = i;
                        }
                    }

                    if ((dir === 1 && c < shelf.price - 1.5 * currentAtr) ||
                        (dir === -1 && c > shelf.price + 1.5 * currentAtr)) {
                        this.crossRegistry.splice(r, 1);
                        continue;
                    }
                }

                this.values[i] = this.emaValues[i]; // (Original line restored here)
                // --- END NEW ---
            }
        }

        this.lastCalculatedIdx = len - 1;

        // Check if an alert needs to be fired on the latest closed or live tick
        this.checkCrossAlert(ds);
    }

    private interpolateCross(prevEma: number, currEma: number, prevSma: number, currSma: number, fallbackClose: number): number {
        const denom = (currEma - prevEma) - (currSma - prevSma);
        if (Math.abs(denom) > 1e-9) {
            const t = Math.max(0, Math.min(1, (prevSma - prevEma) / denom));
            return prevEma + t * (currEma - prevEma);
        }
        return fallbackClose;
    }

    private checkCrossAlert(ds: DataStore): void {
        const len = ds.length;
        if (len < 2) return;

        const notifEnabled = this.getParam<boolean>('notificationsEnabled', true);
        if (!notifEnabled) return;

        const notifyBull = this.getParam<boolean>('notifyBull', true);
        const notifyBear = this.getParam<boolean>('notifyBear', true);
        const triggerOnClose = this.getParam<boolean>('triggerOnClose', true);
        const soundEnabled = this.getParam<boolean>('notificationSound', true);

        // Check latest confirmed closed bar (len - 2) or live forming bar (len - 1)
        const checkIdx = triggerOnClose ? len - 2 : len - 1;
        if (checkIdx < 1) return;

        const signal = this.crossSignals[checkIdx];
        if (signal === 0) return;

        // INVARIANT: Never fire audio alarms or notifications for rejected/filtered signals
        if (Math.abs(signal) === 2) return;

        if (signal === 1 && !notifyBull) return;
        if (signal === -1 && !notifyBear) return;

        const barTime = ds.data[checkIdx * 6];
        if (barTime === this.lastAlertedTime && signal === this.lastAlertedDirection) {
            return; // Already notified for this bar
        }

        this.lastAlertedTime = barTime;
        this.lastAlertedDirection = signal;

        const emaLen = this.getParam<number>('emaLength', 10);
        const smaLen = this.getParam<number>('smaLength', 30);
        const price = this.crossPrices[checkIdx] || ds.data[checkIdx * 6 + 4];
        const dir: 'bull' | 'bear' = signal === 1 ? 'bull' : 'bear';

        alertManager.triggerCrossAlert(
            this.currentSymbol || 'BTCUSDT',
            dir,
            `EMA (${emaLen})`,
            `SMA (${smaLen})`,
            price,
            soundEnabled,
            `Fast EMA (${emaLen}) crossed ${dir === 'bull' ? 'ABOVE' : 'BELOW'} Slow SMA (${smaLen}) at $${price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`
        );
    }

    public override render(r: ChartRenderer, layout: IndicatorLayout, g: Graphics): void {
        if (!this.visible || r.dataStore.length === 0) return;

        // 1. Draw GPU lines for Fast EMA and Slow SMA
        const showLines = this.getParam<boolean>('showLines', true);
        if (showLines) {
            const rawEmaClr = String(this.getParam('emaColor', '#00E5FF')).trim().toUpperCase();
            let { color: emaClr, alpha: emaAlpha } = parseColorAndAlpha(rawEmaClr);
            const emaWidth = Math.max(1, this.getParam<number>('emaWidth', 2));

            const rawSmaClr = String(this.getParam('smaColor', '#FF9800')).trim().toUpperCase();
            let { color: smaClr, alpha: smaAlpha } = parseColorAndAlpha(rawSmaClr);
            const smaWidth = Math.max(1, this.getParam<number>('smaWidth', 2));

            // Theme adjustments for light themes
            if (!r.isDarkTheme) {
                if (rawEmaClr.startsWith('#00E5FF')) emaClr = 0x00838F;
                if (rawSmaClr.startsWith('#FF9800')) smaClr = 0xD97706;
                if (emaClr === 0xFFFFFF) emaClr = 0x131722;
                if (smaClr === 0xFFFFFF) smaClr = 0x131722;
            }

            r.drawGPUIndicatorLine(`${this.id}_ema`, this.emaValues, emaClr, emaWidth, false, layout, undefined, false, emaAlpha);
            r.drawGPUIndicatorLine(`${this.id}_sma`, this.smaValues, smaClr, smaWidth, false, layout, undefined, false, smaAlpha);
        }

        // 2. Draw Cross Shapes & Markers
        const showCrossSignals = this.getParam<boolean>('showCrossSignals', true);
        if (!showCrossSignals) return;

        const shapeMode = this.getParam<string>('shapeMode', 'distinct_symbols');
        const customBullShape = this.getParam<string>('bullShape', 'Triangle Up (▲)');
        const customBearShape = this.getParam<string>('bearShape', 'Triangle Down (▼)');
        const markerPosition = this.getParam<string>('markerPosition', 'Above / Below Bar');
        const markerSize = Math.max(4, this.getParam<number>('markerSize', 8));

        const bullColor = parseColor(this.getParam('bullColor', '#00E676'));
        const bearColor = parseColor(this.getParam('bearColor', '#EF5350'));

        const sp = r.candleSpacing * r.zoom;
        const dsLength = r.dataStore.length;
        const visStart = Math.max(0, Math.floor(r.cameraX / sp) - 3);
        const visEnd = Math.min(dsLength, Math.floor((r.cameraX + layout.chartWidth) / sp) + 3);
        const ds = r.dataStore;

        const resolveShape = (isBull: boolean): CrossMarkerShape => {
            if (shapeMode === 'circle') return 'circle';
            if (shapeMode === 'circle_ring') return 'circle_ring';
            if (shapeMode === 'arrows') return isBull ? 'arrow_up' : 'arrow_down';
            if (shapeMode === 'star_cross') return isBull ? 'star' : 'cross';
            if (shapeMode === 'diamonds') return 'diamond';
            if (shapeMode === 'custom') {
                const str = isBull ? customBullShape : customBearShape;
                if (str.includes('Circle Ring') || str.includes('(○)')) return 'circle_ring';
                if (str.includes('Circle') || str.includes('(●)')) return 'circle';
                if (str.includes('Arrow Up') || str.includes('(⬆)')) return 'arrow_up';
                if (str.includes('Arrow Down') || str.includes('(⬇)')) return 'arrow_down';
                if (str.includes('Star') || str.includes('(★)')) return 'star';
                if (str.includes('Diamond') || str.includes('(◆)')) return 'diamond';
                if (str.includes('Cross') || str.includes('(✖)')) return 'cross';
                return isBull ? 'triangle_up' : 'triangle_down';
            }
            // Default: 'distinct_symbols' -> Bull triangle up ▲, Bear triangle down ▼
            return isBull ? 'triangle_up' : 'triangle_down';
        };

        const bullShapeType = resolveShape(true);
        const bearShapeType = resolveShape(false);

        const showFiltered = this.getParam<boolean>('showFilteredSignals', true);
        const filteredShapeChoice = this.getParam<string>('filteredShape', 'Hollow Ring (○)');
        const filteredAlpha = Math.max(0.1, Math.min(1.0, this.getParam<number>('filteredAlpha', 0.40)));

        const resolveFilteredShape = (isBull: boolean): CrossMarkerShape => {
            if (filteredShapeChoice.includes('Cross') || filteredShapeChoice.includes('(✖)')) return 'cross';
            if (filteredShapeChoice.includes('Small Dot') || filteredShapeChoice.includes('(•)')) return 'circle';
            if (filteredShapeChoice.includes('Diamond') || filteredShapeChoice.includes('(◆)')) return 'diamond';
            if (filteredShapeChoice.includes('Same Shape')) return isBull ? bullShapeType : bearShapeType;
            return 'circle_ring'; // Default: Hollow Ring (○)
        };

        for (let i = visStart; i < visEnd; i++) {
            const sig = this.crossSignals[i];
            if (sig === 0) continue;

            const isFiltered = Math.abs(sig) === 2;
            if (isFiltered && !showFiltered) continue;

            const isBull = sig > 0;
            const baseClr = isBull ? bullColor : bearColor;
            const shapeType = isFiltered ? resolveFilteredShape(isBull) : (isBull ? bullShapeType : bearShapeType);
            const alpha = isFiltered ? filteredAlpha : 1.0;
            const markerDrawSize = isFiltered ? Math.max(3, markerSize * 0.8) : markerSize;

            const x = r.getCandleCenterX(i);
            const base = i * 6;
            const high = ds.data[base + 2];
            const low = ds.data[base + 3];
            const crossP = this.crossPrices[i] || ds.data[base + 4];

            const drawAtPositions: number[] = [];
            const offset = markerDrawSize + 5;

            if (markerPosition === 'Above / Below Bar' || markerPosition === 'Both') {
                const yBar = isBull ? r.priceToY(low) + offset : r.priceToY(high) - offset;
                drawAtPositions.push(yBar);
            }

            if (markerPosition === 'On Cross Price' || markerPosition === 'Both') {
                const yCross = r.priceToY(crossP);
                drawAtPositions.push(yCross);
            }

            for (const y of drawAtPositions) {
                this.drawMarker(g, x, y, shapeType, markerDrawSize, baseClr, alpha);
            }
        }

        // --- START PHASE 4: Institutional Dotted Rays ---
        if (this.getParam<boolean>('showHistoricalShelves', true)) {
            const hideCrossed = this.getParam<boolean>('hideCrossedShelves', false);

            for (const shelf of this.crossRegistry) {
                if (!shelf.isMature) continue;
                if (shelf.broken && hideCrossed) continue;

                const startX = r.getCandleCenterX(shelf.startIndex);
                
                // If price crossed the line, STOP EXTENDING at the candle where it was crossed!
                // If still unbroken, extend to the right edge of the chart
                let endX = layout.chartWidth + 200;
                if (shelf.endIndex !== undefined) {
                    endX = r.getCandleCenterX(shelf.endIndex);
                }

                const y = r.priceToY(shelf.price);

                if (y < -50 || y > layout.mainChartHeight + 50 || startX > endX) continue;

                const dir = Math.sign(shelf.direction);
                const shelfColor = dir === 1 ? bullColor : bearColor;
                const shelfAlpha = shelf.broken ? 0.30 : 0.65; // Dim line if crossed

                // Fast clipped viewport drawing
                const drawStartX = Math.max(-50, startX);
                const drawEndX = Math.min(layout.chartWidth + 50, endX);
                if (drawStartX >= drawEndX) continue;

                const dash = 8;
                const gap = 6;
                g.moveTo(drawStartX, y);
                for (let curX = drawStartX; curX < drawEndX; curX += dash + gap) {
                    g.moveTo(curX, y);
                    g.lineTo(Math.min(curX + dash, drawEndX), y);
                }
                g.stroke({ color: shelfColor, width: 2, alpha: shelfAlpha });
            }
        }
        // --- END PHASE 4 ---
    }

    private drawMarker(g: Graphics, x: number, y: number, shape: CrossMarkerShape, size: number, color: number, alpha: number = 1.0): void {
        switch (shape) {
            case 'circle': {
                g.circle(x, y, size * 0.75).fill({ color, alpha });
                g.circle(x, y, size * 0.75).stroke({ color: 0x000000, width: 1.5, alpha: alpha * 0.6 });
                break;
            }
            case 'circle_ring': {
                g.circle(x, y, size * 0.85).stroke({ color, width: 2.2, alpha });
                break;
            }
            case 'triangle_up': {
                const h = size * 1.4;
                const halfW = size * 0.95;
                g.moveTo(x, y - h * 0.6)
                 .lineTo(x - halfW, y + h * 0.5)
                 .lineTo(x + halfW, y + h * 0.5)
                 .closePath();
                g.fill({ color, alpha });
                g.stroke({ color: 0x000000, width: 1.2, alpha: alpha * 0.5 });
                break;
            }
            case 'triangle_down': {
                const h = size * 1.4;
                const halfW = size * 0.95;
                g.moveTo(x, y + h * 0.6)
                 .lineTo(x - halfW, y - h * 0.5)
                 .lineTo(x + halfW, y - h * 0.5)
                 .closePath();
                g.fill({ color, alpha });
                g.stroke({ color: 0x000000, width: 1.2, alpha: alpha * 0.5 });
                break;
            }
            case 'arrow_up': {
                const w = size * 0.85;
                const h = size * 1.4;
                g.moveTo(x, y - h * 0.6)
                 .lineTo(x - w, y)
                 .lineTo(x - w * 0.45, y)
                 .lineTo(x - w * 0.45, y + h * 0.55)
                 .lineTo(x + w * 0.45, y + h * 0.55)
                 .lineTo(x + w * 0.45, y)
                 .lineTo(x + w, y)
                 .closePath();
                g.fill({ color, alpha });
                g.stroke({ color: 0x000000, width: 1, alpha: alpha * 0.5 });
                break;
            }
            case 'arrow_down': {
                const w = size * 0.85;
                const h = size * 1.4;
                g.moveTo(x, y + h * 0.6)
                 .lineTo(x - w, y)
                 .lineTo(x - w * 0.45, y)
                 .lineTo(x - w * 0.45, y - h * 0.55)
                 .lineTo(x + w * 0.45, y - h * 0.55)
                 .lineTo(x + w * 0.45, y)
                 .lineTo(x + w, y)
                 .closePath();
                g.fill({ color, alpha });
                g.stroke({ color: 0x000000, width: 1, alpha: alpha * 0.5 });
                break;
            }
            case 'cross': {
                const s = size * 0.8;
                const th = Math.max(2, size * 0.28);
                g.moveTo(x - s, y - s).lineTo(x + s, y + s);
                g.moveTo(x - s, y + s).lineTo(x + s, y - s);
                g.stroke({ color, width: th, alpha });
                break;
            }
            case 'diamond': {
                const s = size * 0.95;
                g.moveTo(x, y - s)
                 .lineTo(x + s * 0.75, y)
                 .lineTo(x, y + s)
                 .lineTo(x - s * 0.75, y)
                 .closePath();
                g.fill({ color, alpha });
                g.stroke({ color: 0x000000, width: 1.2, alpha: alpha * 0.5 });
                break;
            }
            case 'star': {
                const points = 5;
                const outerR = size * 1.1;
                const innerR = size * 0.45;
                for (let p = 0; p < points * 2; p++) {
                    const r = (p % 2 === 0) ? outerR : innerR;
                    const angle = (p * Math.PI) / points - Math.PI / 2;
                    const px = x + Math.cos(angle) * r;
                    const py = y + Math.sin(angle) * r;
                    if (p === 0) g.moveTo(px, py);
                    else g.lineTo(px, py);
                }
                g.closePath();
                g.fill({ color, alpha });
                g.stroke({ color: 0x000000, width: 1, alpha: alpha * 0.5 });
                break;
            }
        }
    }

    public override getValueAt(idx: number, ds: DataStore, isDark: boolean, defaultTextClr: number) {
        if (idx < 0 || idx >= ds.length) {
            return { label: this.name, valueStr: '—', valueColor: defaultTextClr };
        }

        const emaVal = this.emaValues[idx] || 0;
        const smaVal = this.smaValues[idx] || 0;
        const sig = this.crossSignals[idx] || 0;

        const rawEma = String(this.getParam('emaColor', '#00E5FF')).toUpperCase();
        let emaClr = parseColor(rawEma);
        if (!isDark && rawEma === '#00E5FF') emaClr = 0x00838F;

        const bullClr = parseColor(this.getParam('bullColor', '#00E676'));
        const bearClr = parseColor(this.getParam('bearColor', '#EF5350'));

        const fmt = (v: number) => v > 0 ? (v >= 10 ? v.toFixed(2) : v.toPrecision(5)) : '—';

        let crossTag = '';
        let valColor = emaClr;

        if (sig === 1) {
            crossTag = ' [▲ GOLDEN CROSS]';
            valColor = bullClr;
        } else if (sig === -1) {
            crossTag = ' [▼ DEATH CROSS]';
            valColor = bearClr;
        } else if (sig === 2) {
            crossTag = ' [○ GOLDEN CROSS (FILTERED)]';
            valColor = 0x787B86; // Dimmed gray
        } else if (sig === -2) {
            crossTag = ' [○ DEATH CROSS (FILTERED)]';
            valColor = 0x787B86; // Dimmed gray
        }

        const emaLen = this.getParam<number>('emaLength', 10);
        const smaLen = this.getParam<number>('smaLength', 30);

        // --- START PHASE 4: EcoChart HUD Proximity Alert ---
        let shelfAlert = '';
        if (this.crossRegistry && this.crossRegistry.length > 0) {
            const hoverPrice = ds.data[idx * 6 + 4]; // Price at current crosshair/live tick
            const hoverTime = ds.data[idx * 6];      // Time at current crosshair/live tick
            let nearestDistPct = 999;
            let nearestAge = 0;

            for (const shelf of this.crossRegistry) {
                if (!shelf.isMature || shelf.broken) continue;

                // Calculate how close price is to the shelf (Percentage)
                const distPct = Math.abs(hoverPrice - shelf.price) / hoverPrice;

                // If price is within a tight 0.5% boundary of the mature shelf
                if (distPct < 0.005) {
                    if (distPct < nearestDistPct) {
                        nearestDistPct = distPct;
                        nearestAge = Math.floor((hoverTime - shelf.timeMs) / 3600000);
                    }
                }
            }

            if (nearestDistPct !== 999) {
                shelfAlert = `  |  ⚠️ IMPULSE ORIGIN (${nearestAge}h old)`;
                valColor = 0xFFB703; // Turn HUD text Warning Orange
            }
        }

        const filterMode = this.getParam<string>('quantFilterMode', 'Off (Raw Mechanical)');
        let filterTag = '';
        if (filterMode === '24/7 Momentum (Chop <= 1 & RVOL >= 1.2)') {
            filterTag = ' [⚡ 24/7 MOMENTUM ON]';
        } else if (filterMode === 'Session Specialist (London/NY & Skip #1)') {
            filterTag = ' [🎯 SESSION SPECIALIST ON]';
        }

        return {
            label: `EMA(${emaLen})/SMA(${smaLen})`,
            valueStr: `E:${fmt(emaVal)} S:${fmt(smaVal)}${crossTag}${filterTag}${shelfAlert}`,
            valueColor: valColor
        };
        // --- END PHASE 4 ---
    }

    public destroy(renderer?: ChartRenderer): void {
        if (renderer) {
            renderer.removeIndicatorMesh(`${this.id}_ema`);
            renderer.removeIndicatorMesh(`${this.id}_sma`);
        }
    }
}
