import { Graphics } from 'pixi.js';
import { BaseIndicator, parseColor, parseColorAndAlpha, type IndicatorLayout } from '../Indicator';
import type { DataStore } from '../../data/DataStore';
import type { ChartRenderer } from '../../renderer/ChartRenderer';
import { createInitialVAMState, stepVolatilityAdjustedMean } from '../mlr1/trend/VolatilityAdjustedMean';

export class VolatilityAdjustedMeanIndicator extends BaseIndicator {
    public centers = new Float64Array(20000);
    public centerValid = new Uint8Array(20000);
    public trends = new Int8Array(20000);
    public signals = new Int8Array(20000);
    public adxValues = new Float64Array(20000);
    public rsiValues = new Float64Array(20000);
    public discontinuityBreaks = new Uint8Array(20000);

    private lastCalculatedLength = -1;
    private lastStateHash = '';

    constructor() {
        super('VAM', 'Volatility Adjusted Mean');
        this.isOscillator = false;
        this.layerType = 'main';

        this.params = [
            { id: 'bullColor', name: 'Bullish Trend Color', type: 'color', value: '#26A69A' },
            { id: 'bearColor', name: 'Bearish Trend Color', type: 'color', value: '#EF5350' },
            { id: 'lineWidth', name: 'Line Thickness', type: 'number', value: 2, min: 1, max: 6, step: 0.5 },
            { id: 'showSignals', name: 'Show BUY / SELL Markers', type: 'boolean', value: true }
        ];
    }

    protected override onParamsUpdated(): void {
        this.lastCalculatedLength = -1;
        this.lastStateHash = '';
    }

    private ensureCapacity(len: number): void {
        if (len <= this.centers.length) return;
        const cap = Math.max(len * 2, 20000);
        this.centers = new Float64Array(cap);
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
        this.centers.fill(0);
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
        this.centerValid.fill(0, 0, len);
        this.trends.fill(0, 0, len);
        this.signals.fill(0, 0, len);
        this.adxValues.fill(0, 0, len);
        this.rsiValues.fill(0, 0, len);
        this.discontinuityBreaks.fill(0, 0, len);

        let vamState = createInitialVAMState();
        let prevTime = -1;

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

            if (!validOhlcv || (prevTime !== -1 && t <= prevTime)) {
                continue;
            }

            const isDiscontinuity = prevTime !== -1 && (t - prevTime) >= discThresholdMs;
            if (isDiscontinuity) this.discontinuityBreaks[i] = 1;
            prevTime = t;

            const out = stepVolatilityAdjustedMean(h, l, c, vamState, isDiscontinuity);
            vamState = out.nextState;

            if (vamState.center !== null && Number.isFinite(vamState.center)) {
                this.centers[i] = vamState.center;
                this.centerValid[i] = 1;
            }
            this.trends[i] = out.trend;
            this.signals[i] = out.signal;
            this.adxValues[i] = out.isAdxValid ? out.adx14 : 0;
            this.rsiValues[i] = out.isRsiValid ? out.rsi14 : 0;
        }

        this.lastCalculatedLength = len;
        this.lastStateHash = hash;
    }

    public override update(ds: DataStore, isClosedTick: boolean): void {
        this.calculate(ds);
        super.update(ds, isClosedTick);
    }

    public render(r: ChartRenderer, layout: IndicatorLayout, g: Graphics): void {
        if (!this.visible || r.dataStore.length === 0) return;
        if (this.lastCalculatedLength !== r.dataStore.length) this.calculate(r.dataStore);

        const bullClr = parseColorAndAlpha(this.getParam<string>('bullColor', '#26A69A'), 1.0);
        const bearClr = parseColorAndAlpha(this.getParam<string>('bearColor', '#EF5350'), 1.0);
        const lineWidth = Math.max(1, this.getParam<number>('lineWidth', 2));
        const showSignals = this.getParam<boolean>('showSignals', true);

        const sp = r.candleSpacing * r.zoom;
        const visStart = Math.max(0, Math.floor(r.cameraX / sp) - 2);
        const visEnd = Math.min(r.dataStore.length - 1, Math.floor((r.cameraX + layout.chartWidth) / sp) + 2);

        for (const [targetTrend, clr] of [[1, bullClr], [-1, bearClr], [0, { color: 0x787B86, alpha: 0.6 }]] as const) {
            g.beginPath();
            let hasSeg = false;
            for (let i = visStart; i < visEnd; i++) {
                if (this.centerValid[i] !== 1 || this.centerValid[i + 1] !== 1) continue;
                if (this.discontinuityBreaks[i + 1] === 1) continue;
                if (this.trends[i + 1] !== targetTrend) continue;

                const x1 = r.getCandleCenterX(i);
                const y1 = r.priceToY(this.centers[i]);
                const x2 = r.getCandleCenterX(i + 1);
                const y2 = r.priceToY(this.centers[i + 1]);
                g.moveTo(x1, y1).lineTo(x2, y2);
                hasSeg = true;
            }
            if (hasSeg) g.stroke({ color: clr.color, width: lineWidth, alpha: clr.alpha });
        }

        if (showSignals) {
            // BUY markers (upward triangle below low)
            g.beginPath();
            let hasBuy = false;
            for (let i = visStart; i <= visEnd; i++) {
                if (this.signals[i] !== 1) continue;
                const cx = r.getCandleCenterX(i);
                const py = r.priceToY(r.dataStore.data[i * 6 + 3]) + 10;
                g.moveTo(cx, py - 7).lineTo(cx - 5, py + 2).lineTo(cx + 5, py + 2).closePath();
                hasBuy = true;
            }
            if (hasBuy) g.fill({ color: bullClr.color, alpha: 0.95 });

            // SELL markers (downward triangle above high)
            g.beginPath();
            let hasSell = false;
            for (let i = visStart; i <= visEnd; i++) {
                if (this.signals[i] !== -1) continue;
                const cx = r.getCandleCenterX(i);
                const py = r.priceToY(r.dataStore.data[i * 6 + 2]) - 10;
                g.moveTo(cx, py + 7).lineTo(cx - 5, py - 2).lineTo(cx + 5, py - 2).closePath();
                hasSell = true;
            }
            if (hasSell) g.fill({ color: bearClr.color, alpha: 0.95 });
        }
    }

    public override getValueAt(idx: number, ds: DataStore, _isDark: boolean, defaultTextClr: number) {
        if (idx < 0 || idx >= ds.length || this.centerValid[idx] !== 1) {
            return { label: this.name, valueStr: 'Warmup', valueColor: 0x787B86 };
        }
        const tr = this.trends[idx];
        const sig = this.signals[idx];
        const clr = tr === 1
            ? parseColor(this.getParam('bullColor', '#26A69A'))
            : tr === -1
                ? parseColor(this.getParam('bearColor', '#EF5350'))
                : defaultTextClr;
        const sigTag = sig === 1 ? ' [BUY]' : sig === -1 ? ' [SELL]' : '';
        return {
            label: this.name,
            valueStr: `${this.centers[idx].toFixed(2)} | ADX ${this.adxValues[idx].toFixed(1)} | RSI ${this.rsiValues[idx].toFixed(1)}${sigTag}`,
            valueColor: clr
        };
    }

    public destroy(): void {
        this.centers = new Float64Array(0);
        this.centerValid = new Uint8Array(0);
        this.trends = new Int8Array(0);
        this.signals = new Int8Array(0);
        this.adxValues = new Float64Array(0);
        this.rsiValues = new Float64Array(0);
        this.discontinuityBreaks = new Uint8Array(0);
    }
}
