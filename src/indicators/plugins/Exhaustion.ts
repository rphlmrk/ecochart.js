import { Graphics } from 'pixi.js';
import { BaseIndicator, parseColor, parseColorAndAlpha, type IndicatorLayout } from '../Indicator';
import type { DataStore } from '../../data/DataStore';
import type { ChartRenderer } from '../../renderer/ChartRenderer';
import { updateExhaustionCCI } from '../mlr1/momentum/Exhaustion';
import type { ExhaustionPeriodState } from '../mlr1/ML1FeatureTypes';

export class ExhaustionIndicator extends BaseIndicator {
    public values = new Float64Array(20000);
    public validMask = new Uint8Array(20000);
    public discontinuityBreaks = new Uint8Array(20000);

    private lastCalculatedLength = -1;
    private lastStateHash = '';

    constructor() {
        super('EXHAUST', 'Exhaustion (CCI)');
        this.isOscillator = true;
        this.layerType = 'oscillator';
        this.oscillatorScale = { min: -300, max: 300, steps: [100, 80, 0, -80, -100] };

        this.params = [
            { id: 'period', name: 'CCI Period', type: 'number', value: 20, min: 2, max: 200, step: 1 },
            { id: 'lineColor', name: 'Line Color', type: 'color', value: '#2962FF' },
            { id: 'lineWidth', name: 'Line Width', type: 'number', value: 1.5, min: 1, max: 5, step: 0.5 },
            { id: 'bandColor', name: '±100 / ±80 Band Color', type: 'color', value: '#787B8666' }
        ];
    }

    protected override onParamsUpdated(): void {
        this.lastCalculatedLength = -1;
        this.lastStateHash = '';
        this.name = `Exhaustion (CCI ${this.getParam<number>('period', 20)})`;
    }

    private ensureCapacity(len: number): void {
        if (len <= this.values.length) return;
        const cap = Math.max(len * 2, 20000);
        this.values = new Float64Array(cap);
        this.validMask = new Uint8Array(cap);
        this.discontinuityBreaks = new Uint8Array(cap);
    }

    public override reset(): void {
        this.lastCalculatedLength = -1;
        this.lastStateHash = '';
        this.values.fill(0);
        this.validMask.fill(0);
        this.discontinuityBreaks.fill(0);
        super.reset();
    }

    public calculate(ds: DataStore): void {
        const len = ds.length;
        if (len === 0) return;
        this.ensureCapacity(len);

        const period = Math.max(2, Math.round(this.getParam<number>('period', 20)));
        const intervalMs = (len >= 2 && ds.data[6] > ds.data[0]) ? (ds.data[6] - ds.data[0]) : 60_000;
        const discThresholdMs = Math.max(300_000, intervalMs * 5);
        const lastBase = (len - 1) * 6;
        const rev = (ds as any).revision ?? 0;
        const hash = `${period}:${intervalMs}:${len}:${rev}:${ds.data[0]}:${ds.data[lastBase]}:${ds.data[lastBase + 4]}`;
        if (this.lastStateHash === hash && this.lastCalculatedLength === len) return;

        this.values.fill(0, 0, len);
        this.validMask.fill(0, 0, len);
        this.discontinuityBreaks.fill(0, 0, len);

        let state: ExhaustionPeriodState | undefined;
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

            const res = updateExhaustionCCI(h, l, c, period, state, isDiscontinuity);
            state = res.nextState;
            if (res.isValid) {
                this.values[i] = res.cciValue;
                this.validMask[i] = 1;
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

        const usableH = Math.max(1, layout.oscHeight - 4);
        const toY = (val: number) => {
            const norm = Math.max(0, Math.min(1, (val - (-300)) / 600));
            return layout.oscY + 2 + usableH - norm * usableH;
        };

        const bandClr = parseColorAndAlpha(this.getParam<string>('bandColor', '#787B8666'), 0.4);
        g.beginPath();
        for (const lvl of [100, 80, 0, -80, -100]) {
            const y = toY(lvl);
            g.moveTo(0, y).lineTo(layout.chartWidth, y);
        }
        g.stroke({ color: bandClr.color, width: 1, alpha: bandClr.alpha });

        const lineClr = parseColorAndAlpha(this.getParam<string>('lineColor', '#2962FF'), 1.0);
        const lineWidth = Math.max(1, this.getParam<number>('lineWidth', 1.5));
        const sp = r.candleSpacing * r.zoom;
        const visStart = Math.max(0, Math.floor(r.cameraX / sp) - 2);
        const visEnd = Math.min(r.dataStore.length - 1, Math.floor((r.cameraX + layout.chartWidth) / sp) + 2);

        g.beginPath();
        let hasLine = false;
        for (let i = visStart; i < visEnd; i++) {
            if (this.validMask[i] !== 1 || this.validMask[i + 1] !== 1) continue;
            if (this.discontinuityBreaks[i + 1] === 1) continue;
            g.moveTo(r.getCandleCenterX(i), toY(this.values[i]))
                .lineTo(r.getCandleCenterX(i + 1), toY(this.values[i + 1]));
            hasLine = true;
        }
        if (hasLine) g.stroke({ color: lineClr.color, width: lineWidth, alpha: lineClr.alpha });
    }

    public override getValueAt(idx: number, ds: DataStore, _isDark: boolean, defaultTextClr: number) {
        if (idx < 0 || idx >= ds.length) return { label: this.name, valueStr: '—', valueColor: defaultTextClr };
        if (this.validMask[idx] !== 1) return { label: this.name, valueStr: 'Warmup / Invalid', valueColor: 0x787B86 };
        return {
            label: this.name,
            valueStr: this.values[idx].toFixed(2),
            valueColor: parseColor(this.getParam('lineColor', '#2962FF'))
        };
    }

    public destroy(): void {
        this.values = new Float64Array(0);
        this.validMask = new Uint8Array(0);
        this.discontinuityBreaks = new Uint8Array(0);
    }
}