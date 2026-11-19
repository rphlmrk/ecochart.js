import { Graphics } from 'pixi.js';
import { BaseIndicator, parseColor, parseColorAndAlpha, type IndicatorLayout } from '../Indicator';
import type { DataStore } from '../../data/DataStore';
import type { ChartRenderer } from '../../renderer/ChartRenderer';
import { updateVolumeCandleSize } from '../mlr1/volume/VolumeCandleSize';
import type { VolumeCandleSizeState } from '../mlr1/ML1FeatureTypes';

export class VolumeCandleSizeIndicator extends BaseIndicator {
    public ratios = new Float64Array(20000);
    public zScores = new Float64Array(20000);
    public regimes = new Int8Array(20000);
    public validMask = new Uint8Array(20000);

    private lastCalculatedLength = -1;
    private lastStateHash = '';

    constructor() {
        super('VCS_360', 'Volume Candle Size (360)');
        this.isOscillator = true;
        this.layerType = 'oscillator';
        this.oscillatorScale = { min: 0, max: 4, steps: [1, 2], format: (v) => `${v}x` };

        this.params = [
            { id: 'period', name: 'Baseline Period (1m)', type: 'number', value: 360, min: 2, max: 1440, step: 1 },
            { id: 'normalColor', name: 'Normal (<= 1x)', type: 'color', value: '#787B86CC' },
            { id: 'elevatedColor', name: 'Elevated (1x–2x)', type: 'color', value: '#26A69AE6' },
            { id: 'extremeColor', name: 'Extreme (> 2x)', type: 'color', value: '#FF9800FF' },
            { id: 'baselineColor', name: '1x / 2x Baseline', type: 'color', value: '#9598A180' }
        ];
    }

    protected override onParamsUpdated(): void {
        this.lastCalculatedLength = -1;
        this.lastStateHash = '';
        const p = this.getParam<number>('period', 360);
        this.name = `Volume Candle Size (${p})`;
    }

    private ensureCapacity(len: number): void {
        if (len <= this.ratios.length) return;
        const cap = Math.max(len * 2, 20000);
        this.ratios = new Float64Array(cap);
        this.zScores = new Float64Array(cap);
        this.regimes = new Int8Array(cap);
        this.validMask = new Uint8Array(cap);
    }

    public override reset(): void {
        this.lastCalculatedLength = -1;
        this.lastStateHash = '';
        this.ratios.fill(0);
        this.zScores.fill(0);
        this.regimes.fill(0);
        this.validMask.fill(0);
        super.reset();
    }

    public calculate(ds: DataStore): void {
        const len = ds.length;
        if (len === 0) return;
        this.ensureCapacity(len);

        const period = Math.max(2, Math.round(this.getParam<number>('period', 360)));
        const intervalMs = (len >= 2 && ds.data[6] > ds.data[0]) ? (ds.data[6] - ds.data[0]) : 60_000;
        const lastBase = (len - 1) * 6;
        const rev = (ds as any).revision ?? 0;
        const hash = `${period}:${intervalMs}:${len}:${rev}:${ds.data[0]}:${ds.data[lastBase]}:${ds.data[lastBase + 4]}:${ds.data[lastBase + 5]}`;
        if (this.lastStateHash === hash && this.lastCalculatedLength === len) return;

        this.ratios.fill(0, 0, len);
        this.zScores.fill(0, 0, len);
        this.regimes.fill(0, 0, len);
        this.validMask.fill(0, 0, len);

        // Contract: Volume Candle Size 360 is valid on 1m only
        if (intervalMs !== 60_000) {
            this.lastCalculatedLength = len;
            this.lastStateHash = hash;
            return;
        }

        const discThresholdMs = 300_000;
        let state: VolumeCandleSizeState | undefined;
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
            prevTime = t;

            const res = updateVolumeCandleSize(h, l, v, period, state, isDiscontinuity);
            state = res.nextState;

            if (res.isRatioValid) {
                this.ratios[i] = res.ratio;
                this.zScores[i] = res.isZScoreValid ? res.zScore : 0;
                this.regimes[i] = res.regime;
                this.validMask[i] = 1;
            }
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

        const usableH = Math.max(1, layout.oscHeight - 4);
        const yBottom = layout.oscY + 2 + usableH;
        const maxScale = this.oscillatorScale?.max ?? 4;
        const toY = (val: number) => {
            const norm = Math.max(0, Math.min(1, val / maxScale));
            return yBottom - norm * usableH;
        };

        const baseClr = parseColorAndAlpha(this.getParam<string>('baselineColor', '#9598A180'), 0.5);
        g.beginPath();
        g.moveTo(0, toY(1)).lineTo(layout.chartWidth, toY(1));
        g.moveTo(0, toY(2)).lineTo(layout.chartWidth, toY(2));
        g.stroke({ color: baseClr.color, width: 1, alpha: baseClr.alpha });

        const sp = r.candleSpacing * r.zoom;
        const barW = Math.max(1, sp * 0.7);
        const visStart = Math.max(0, Math.floor(r.cameraX / sp) - 2);
        const visEnd = Math.min(r.dataStore.length, Math.floor((r.cameraX + layout.chartWidth) / sp) + 2);

        const cNormal = parseColorAndAlpha(this.getParam<string>('normalColor', '#787B86CC'), 0.8);
        const cElev = parseColorAndAlpha(this.getParam<string>('elevatedColor', '#26A69AE6'), 0.9);
        const cExt = parseColorAndAlpha(this.getParam<string>('extremeColor', '#FF9800FF'), 1.0);

        for (const [targetRegime, style] of [[0, cNormal], [1, cElev], [2, cExt]] as const) {
            g.beginPath();
            let hasAny = false;
            for (let i = visStart; i < visEnd; i++) {
                if (this.validMask[i] !== 1 || this.regimes[i] !== targetRegime) continue;
                const cx = r.getCandleCenterX(i);
                const topY = toY(this.ratios[i]);
                g.rect(cx - barW * 0.5, topY, barW, Math.max(1, yBottom - topY));
                hasAny = true;
            }
            if (hasAny) g.fill({ color: style.color, alpha: style.alpha });
        }
    }

    public override getValueAt(idx: number, ds: DataStore, _isDark: boolean, defaultTextClr: number) {
        if (idx < 0 || idx >= ds.length) {
            return { label: this.name, valueStr: '—', valueColor: defaultTextClr };
        }
        const intervalMs = (ds.length >= 2 && ds.data[6] > ds.data[0]) ? (ds.data[6] - ds.data[0]) : 60_000;
        if (intervalMs !== 60_000) {
            return { label: this.name, valueStr: '1m Only', valueColor: 0x787B86 };
        }
        if (this.validMask[idx] !== 1) {
            return { label: this.name, valueStr: 'Warmup / Invalid', valueColor: 0x787B86 };
        }
        const r = this.ratios[idx];
        const reg = this.regimes[idx];
        const clr = reg === 2
            ? parseColor(this.getParam('extremeColor', '#FF9800FF'))
            : reg === 1
                ? parseColor(this.getParam('elevatedColor', '#26A69AE6'))
                : parseColor(this.getParam('normalColor', '#787B86CC'));
        return {
            label: this.name,
            valueStr: `${r.toFixed(2)}x (Z=${this.zScores[idx].toFixed(2)}, R${reg})`,
            valueColor: clr
        };
    }

    public destroy(): void {
        this.ratios = new Float64Array(0);
        this.zScores = new Float64Array(0);
        this.regimes = new Int8Array(0);
        this.validMask = new Uint8Array(0);
    }
}
