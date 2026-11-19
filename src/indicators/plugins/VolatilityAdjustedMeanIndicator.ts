import { Graphics } from 'pixi.js';
import { BaseIndicator, parseColor, parseColorAndAlpha, type IndicatorLayout } from '../Indicator';
import type { DataStore } from '../../data/DataStore';
import type { ChartRenderer } from '../../renderer/ChartRenderer';
import { createInitialVAMState, stepVolatilityAdjustedMean } from '../mlr1/trend/VolatilityAdjustedMean';

export class VolatilityAdjustedMeanIndicator extends BaseIndicator {
    public centers = new Float64Array(20000);
    public atrs = new Float64Array(20000);
    public centerValid = new Uint8Array(20000);
    public trends = new Int8Array(20000);
    public signals = new Int8Array(20000);
    public adxValues = new Float64Array(20000);
    public rsiValues = new Float64Array(20000);
    public discontinuityBreaks = new Uint8Array(20000);
    public tpHits: Array<{ barIndex: number; price: number; dir: 1 | -1; level: 1 | 2 | 3 }> = [];

    private lastCalculatedLength = -1;
    private lastStateHash = '';

    constructor() {
        super('VAM', 'Volatility Adjusted Mean');
        this.isOscillator = false;
        this.layerType = 'main';

        this.params = [
            { id: 'bullColor', name: 'Bullish Color', type: 'color', value: '#00FFE5' },
            { id: 'bearColor', name: 'Bearish Color', type: 'color', value: '#7030A0' },
            { id: 'lineWidth', name: 'Center Line Width', type: 'number', value: 3, min: 1, max: 6, step: 0.5 },
            { id: 'showGradient', name: 'Show Vertical Gradient', type: 'boolean', value: true },
            { id: 'showSignals', name: 'Show Buy / Sell Markers', type: 'boolean', value: true },
            { id: 'signalCenterATR', name: 'Signal Center Offset (ATR)', type: 'number', value: 0.7, min: 0, max: 3, step: 0.05 },
            { id: 'showTP', name: 'Show TP X Markers', type: 'boolean', value: true }
        ];
    }

    protected override onParamsUpdated(): void {
        this.lastCalculatedLength = -1;
        this.lastStateHash = '';
        this.tpHits = [];
    }

    private ensureCapacity(len: number): void {
        if (len <= this.centers.length) return;
        const cap = Math.max(len * 2, 20000);
        this.centers = new Float64Array(cap);
        this.atrs = new Float64Array(cap);
        this.centerValid = new Uint8Array(cap);
        this.trends = new Int8Array(cap);
        this.signals = new Int8Array(cap);
        this.adxValues = new Float64Array(cap);
        this.rsiValues = new Float64Array(cap);
        this.discontinuityBreaks = new Uint8Array(cap);
    }

    public override reset(): void {
        this.lastCalculatedLength = -1;
        this.lastStateHash = '';
        this.tpHits = [];
        this.centers.fill(0);
        this.atrs.fill(0);
        this.centerValid.fill(0);
        this.trends.fill(0);
        this.signals.fill(0);
        this.adxValues.fill(0);
        this.rsiValues.fill(0);
        this.discontinuityBreaks.fill(0);
        super.reset();
    }

    public calculate(ds: DataStore): void {
        const len = ds.length;
        if (len === 0) return;
        this.ensureCapacity(len);

        const intervalMs = (len >= 2 && ds.data[6] > ds.data[0]) ? (ds.data[6] - ds.data[0]) : 60_000;
        const discThresholdMs = Math.max(300_000, intervalMs * 5);
        const lastBase = (len - 1) * 6;
        const rev = (ds as any).revision ?? 0;
        const hash = `${intervalMs}:${len}:${rev}:${ds.data[0]}:${ds.data[lastBase]}:${ds.data[lastBase + 4]}`;
        if (this.lastStateHash === hash && this.lastCalculatedLength === len) return;

        this.centers.fill(0, 0, len);
        this.atrs.fill(0, 0, len);
        this.centerValid.fill(0, 0, len);
        this.trends.fill(0, 0, len);
        this.signals.fill(0, 0, len);
        this.adxValues.fill(0, 0, len);
        this.rsiValues.fill(0, 0, len);
        this.discontinuityBreaks.fill(0, 0, len);
        this.tpHits = [];

        let vamState = createInitialVAMState();
        let prevTime = -1;

        // Pine Take-Profit tracker state (purely downstream display of VAM signals)
        let tradeDir: 1 | -1 | 0 = 0;
        let signalBar = -1;
        let tp1 = 0, tp2 = 0, tp3 = 0;
        let tp1Hit = false, tp2Hit = false, tp3Hit = false;

        for (let i = 0; i < len; i++) {
            const base = i * 6;
            const t = ds.data[base];
            const o = ds.data[base + 1];
            const h = ds.data[base + 2];
            const l = ds.data[base + 3];
            const c = ds.data[base + 4];
            const v = ds.data[base + 5];

            const validOhlcv =
                Number.isFinite(t) && t >= 0 &&
                Number.isFinite(o) && o > 0 &&
                Number.isFinite(h) && h > 0 &&
                Number.isFinite(l) && l > 0 &&
                Number.isFinite(c) && c > 0 &&
                Number.isFinite(v) && v >= 0 &&
                h >= l && h >= Math.max(o, c) && l <= Math.min(o, c);

            if (!validOhlcv || (prevTime !== -1 && t <= prevTime)) continue;

            const isDiscontinuity = prevTime !== -1 && (t - prevTime) >= discThresholdMs;
            if (isDiscontinuity) {
                this.discontinuityBreaks[i] = 1;
                tradeDir = 0;
                signalBar = -1;
            }
            prevTime = t;

            const out = stepVolatilityAdjustedMean(h, l, c, vamState, isDiscontinuity);
            vamState = out.nextState;

            const atrVal = vamState.atrState.isSeeded && vamState.atrState.atr ? vamState.atrState.atr : 0;
            this.atrs[i] = atrVal;

            if (vamState.center !== null && Number.isFinite(vamState.center)) {
                this.centers[i] = vamState.center;
                this.centerValid[i] = 1;
            }
            this.trends[i] = out.trend;
            this.signals[i] = out.signal;
            this.adxValues[i] = out.isAdxValid ? out.adx14 : 0;
            this.rsiValues[i] = out.isRsiValid ? out.rsi14 : 0;

            if (out.signal !== 0 && atrVal > 0) {
                tradeDir = out.signal;
                signalBar = i;
                tp1 = c + tradeDir * atrVal * 1.0;
                tp2 = c + tradeDir * atrVal * 2.0;
                tp3 = c + tradeDir * atrVal * 3.25;
                tp1Hit = false;
                tp2Hit = false;
                tp3Hit = false;
            } else if (tradeDir !== 0 && signalBar >= 0 && i > signalBar && atrVal > 0) {
                const yOffset = atrVal * 0.6;
                if (tradeDir === 1) {
                    if (!tp1Hit && h >= tp1) { tp1Hit = true; this.tpHits.push({ barIndex: i, price: h + yOffset, dir: 1, level: 1 }); }
                    if (!tp2Hit && h >= tp2) { tp2Hit = true; this.tpHits.push({ barIndex: i, price: h + yOffset, dir: 1, level: 2 }); }
                    if (!tp3Hit && h >= tp3) { tp3Hit = true; this.tpHits.push({ barIndex: i, price: h + yOffset, dir: 1, level: 3 }); }
                } else {
                    if (!tp1Hit && l <= tp1) { tp1Hit = true; this.tpHits.push({ barIndex: i, price: l - yOffset, dir: -1, level: 1 }); }
                    if (!tp2Hit && l <= tp2) { tp2Hit = true; this.tpHits.push({ barIndex: i, price: l - yOffset, dir: -1, level: 2 }); }
                    if (!tp3Hit && l <= tp3) { tp3Hit = true; this.tpHits.push({ barIndex: i, price: l - yOffset, dir: -1, level: 3 }); }
                }
            }
        }

        this.lastCalculatedLength = len;
        this.lastStateHash = hash;
    }

    public override update(ds: DataStore, isClosedTick: boolean): void {
        if (this.lastCalculatedLength !== -1 && (ds.length > this.lastCalculatedLength + 2 || ds.length <= this.lastCalculatedLength)) {
            this.lastCalculatedLength = -1;
        }
        this.calculate(ds);
        super.update(ds, isClosedTick);
    }

    public render(r: ChartRenderer, layout: IndicatorLayout, g: Graphics): void {
        if (!this.visible || r.dataStore.length === 0) return;
        if (this.lastCalculatedLength !== r.dataStore.length) this.calculate(r.dataStore);

        const rawBull = String(this.getParam('bullColor', '#00FFE5')).toUpperCase();
        const rawBear = String(this.getParam('bearColor', '#7030A0')).toUpperCase();
        const bullParsed = parseColorAndAlpha(rawBull, 0.85);
        const bearParsed = parseColorAndAlpha(rawBear, 0.85);
        const bullColor = (!r.isDarkTheme && rawBull.startsWith('#00FFE5')) ? 0x00897B : bullParsed.color;
        const bearColor = bearParsed.color;

        const lineWidth = Math.max(1, this.getParam<number>('lineWidth', 3));
        const showGradient = this.getParam<boolean>('showGradient', true);
        const showSignals = this.getParam<boolean>('showSignals', true);
        const signalOffset = this.getParam<number>('signalCenterATR', 0.7);
        const showTP = this.getParam<boolean>('showTP', true);

        const sp = r.candleSpacing * r.zoom;
        const visStart = Math.max(0, Math.floor(r.cameraX / sp) - 2);
        const visEnd = Math.min(r.dataStore.length - 1, Math.floor((r.cameraX + layout.chartWidth) / sp) + 2);

        // 1. Vertical Gradient Ribbon (center <-> close)
        if (showGradient) {
            for (const [targetTrend, clr] of [[1, bullColor], [-1, bearColor]] as const) {
                g.beginPath();
                let hasPoly = false;
                for (let i = visStart; i < visEnd; i++) {
                    if (this.centerValid[i] !== 1 || this.centerValid[i + 1] !== 1) continue;
                    if (this.discontinuityBreaks[i + 1] === 1 || this.trends[i + 1] !== targetTrend) continue;

                    const x1 = r.getCandleCenterX(i);
                    const x2 = r.getCandleCenterX(i + 1);
                    const yc1 = r.priceToY(this.centers[i]);
                    const yc2 = r.priceToY(this.centers[i + 1]);
                    const yp1 = r.priceToY(r.dataStore.data[i * 6 + 4]);
                    const yp2 = r.priceToY(r.dataStore.data[(i + 1) * 6 + 4]);

                    g.moveTo(x1, yc1).lineTo(x2, yc2).lineTo(x2, yp2).lineTo(x1, yp1).closePath();
                    hasPoly = true;
                }
                if (hasPoly) g.fill({ color: clr, alpha: 0.16 });
            }
        }

        // 2. Smooth Adaptive Center Line
        for (const [targetTrend, clr, alpha] of [
            [1, bullColor, bullParsed.alpha],
            [-1, bearColor, bearParsed.alpha],
            [0, 0x787B86, 0.55]
        ] as const) {
            g.beginPath();
            let hasSeg = false;
            for (let i = visStart; i < visEnd; i++) {
                if (this.centerValid[i] !== 1 || this.centerValid[i + 1] !== 1) continue;
                if (this.discontinuityBreaks[i + 1] === 1 || this.trends[i + 1] !== targetTrend) continue;
                g.moveTo(r.getCandleCenterX(i), r.priceToY(this.centers[i]))
                    .lineTo(r.getCandleCenterX(i + 1), r.priceToY(this.centers[i + 1]));
                hasSeg = true;
            }
            if (hasSeg) g.stroke({ color: clr, width: lineWidth, alpha });
        }

        // 3. Midline-Anchored BUY / SELL Markers (center ± atr * 0.7)
        if (showSignals) {
            g.beginPath();
            let hasBuy = false;
            for (let i = visStart; i <= visEnd; i++) {
                if (this.signals[i] !== 1 || this.centerValid[i] !== 1) continue;
                const cx = r.getCandleCenterX(i);
                const anchorPrice = this.centers[i] - this.atrs[i] * signalOffset;
                const py = r.priceToY(anchorPrice);
                g.moveTo(cx, py - 6).lineTo(cx - 5, py + 4).lineTo(cx + 5, py + 4).closePath();
                hasBuy = true;
            }
            if (hasBuy) g.fill({ color: bullColor, alpha: 0.95 });

            g.beginPath();
            let hasSell = false;
            for (let i = visStart; i <= visEnd; i++) {
                if (this.signals[i] !== -1 || this.centerValid[i] !== 1) continue;
                const cx = r.getCandleCenterX(i);
                const anchorPrice = this.centers[i] + this.atrs[i] * signalOffset;
                const py = r.priceToY(anchorPrice);
                g.moveTo(cx, py + 6).lineTo(cx - 5, py - 4).lineTo(cx + 5, py - 4).closePath();
                hasSell = true;
            }
            if (hasSell) g.fill({ color: bearColor, alpha: 0.95 });
        }

        // 4. Take-Profit X Markers (TP1 / TP2 / TP3)
        if (showTP && this.tpHits.length > 0) {
            const tpClr = r.isDarkTheme ? 0xFFFFFF : 0x131722;
            g.beginPath();
            let hasTp = false;
            for (const tp of this.tpHits) {
                if (tp.barIndex < visStart || tp.barIndex > visEnd) continue;
                const x = r.getCandleCenterX(tp.barIndex);
                const y = r.priceToY(tp.price);
                g.moveTo(x - 3.5, y - 3.5).lineTo(x + 3.5, y + 3.5);
                g.moveTo(x + 3.5, y - 3.5).lineTo(x - 3.5, y + 3.5);
                hasTp = true;
            }
            if (hasTp) g.stroke({ color: tpClr, width: 1.5, alpha: 0.9 });
        }
    }

    public override getValueAt(idx: number, ds: DataStore, isDark: boolean, defaultTextClr: number) {
        if (idx < 0 || idx >= ds.length || this.centerValid[idx] !== 1) {
            return { label: this.name, valueStr: 'Warmup', valueColor: 0x787B86 };
        }
        const tr = this.trends[idx];
        const sig = this.signals[idx];
        const rawBull = String(this.getParam('bullColor', '#00FFE5')).toUpperCase();
        const bullClr = (!isDark && rawBull.startsWith('#00FFE5')) ? 0x00897B : parseColor(rawBull);
        const bearClr = parseColor(this.getParam('bearColor', '#7030A0'));
        const clr = tr === 1 ? bullClr : tr === -1 ? bearClr : defaultTextClr;
        const sigTag = sig === 1 ? ' [BUY]' : sig === -1 ? ' [SELL]' : '';
        return {
            label: this.name,
            valueStr: `${this.centers[idx].toFixed(2)} | ADX ${this.adxValues[idx].toFixed(1)} | RSI ${this.rsiValues[idx].toFixed(1)}${sigTag}`,
            valueColor: clr
        };
    }

    public destroy(): void {
        this.tpHits = [];
        this.centers = new Float64Array(0);
        this.atrs = new Float64Array(0);
        this.centerValid = new Uint8Array(0);
        this.trends = new Int8Array(0);
        this.signals = new Int8Array(0);
        this.adxValues = new Float64Array(0);
        this.rsiValues = new Float64Array(0);
        this.discontinuityBreaks = new Uint8Array(0);
    }
}
