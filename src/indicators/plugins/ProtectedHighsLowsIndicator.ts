import { Graphics } from 'pixi.js';
import { BaseIndicator, parseColor, parseColorAndAlpha, type IndicatorLayout } from '../Indicator';
import type { DataStore } from '../../data/DataStore';
import type { ChartRenderer } from '../../renderer/ChartRenderer';
import { createDefaultPHLConfig, createInitialPHLState, stepPHL } from '../mlr1/teachers/ProtectedHighsLowsTeacher';
import { updateWilderATR } from '../mlr1/volatility/ATR';
import type { ATRPeriodState } from '../mlr1/ML1FeatureTypes';
import type { StrategyEvent } from '../mlr1/teachers/StrategyEventTypes';

export interface PHLConfirmedPivotMarker {
    readonly barIndex: number;
    readonly confirmedBarIndex: number;
    readonly price: number;
    readonly type: 'high' | 'low';
}

export class ProtectedHighsLowsIndicator extends BaseIndicator {
    public cachedEvents: StrategyEvent[] = [];
    public confirmedPivots: PHLConfirmedPivotMarker[] = [];
    public protectedHighTrail = new Float64Array(20000);
    public protectedLowTrail = new Float64Array(20000);
    public bullStates = new Int8Array(20000);
    public discontinuityBreaks = new Uint8Array(20000);
    public currentSymbol = 'SOLUSDT';

    private lastCalculatedLength = -1;
    private lastStateHash = '';

    constructor() {
        super('PHL_BOS_MSS', 'Protected Highs/Lows');
        this.isOscillator = false;
        this.layerType = 'main';

        this.params = [
            { id: 'pivotStrength', name: 'Pivot Strength', type: 'number', value: 3, min: 1, max: 20, step: 1 },
            { id: 'useValidPullbacks', name: 'Use Valid Pullbacks', type: 'boolean', value: true },
            { id: 'extraValidPullbacks', name: 'Extra Valid Pullbacks', type: 'boolean', value: false },
            { id: 'bullColor', name: 'Bull BOS / MSS Color', type: 'color', value: '#26A69A' },
            { id: 'bearColor', name: 'Bear BOS / MSS Color', type: 'color', value: '#EF5350' },
            { id: 'showProtectedTrail', name: 'Show Protected Trail', type: 'boolean', value: true }
        ];
    }

    protected override onParamsUpdated(): void {
        this.lastCalculatedLength = -1;
        this.lastStateHash = '';
        this.cachedEvents = [];
        this.confirmedPivots = [];
    }

    private ensureCapacity(len: number): void {
        if (len <= this.protectedHighTrail.length) return;
        const cap = Math.max(len * 2, 20000);
        this.protectedHighTrail = new Float64Array(cap);
        this.protectedLowTrail = new Float64Array(cap);
        this.bullStates = new Int8Array(cap);
        this.discontinuityBreaks = new Uint8Array(cap);
    }

    public override reset(): void {
        this.lastCalculatedLength = -1;
        this.lastStateHash = '';
        this.cachedEvents = [];
        this.confirmedPivots = [];
        this.protectedHighTrail.fill(0);
        this.protectedLowTrail.fill(0);
        this.bullStates.fill(0);
        this.discontinuityBreaks.fill(0);
        super.reset();
    }

    public calculate(ds: DataStore): void {
        const len = ds.length;
        if (len === 0) return;
        this.ensureCapacity(len);

        const pivotStrength = Math.max(1, Math.round(this.getParam<number>('pivotStrength', 3)));
        const useValidPullbacks = this.getParam<boolean>('useValidPullbacks', true);
        const extraValidPullbacks = this.getParam<boolean>('extraValidPullbacks', false);
        const intervalMs = (len >= 2 && ds.data[6] > ds.data[0]) ? (ds.data[6] - ds.data[0]) : 60_000;
        const discThresholdMs = Math.max(300_000, intervalMs * 5);

        const lastBase = (len - 1) * 6;
        const rev = (ds as any).revision ?? 0;
        const hash = `${this.currentSymbol}:${intervalMs}:${pivotStrength}:${useValidPullbacks}:${extraValidPullbacks}:${len}:${rev}:${ds.data[0]}:${ds.data[lastBase]}:${ds.data[lastBase + 4]}`;
        if (this.lastStateHash === hash && this.lastCalculatedLength === len) return;

        this.cachedEvents = [];
        this.confirmedPivots = [];
        this.protectedHighTrail.fill(0, 0, len);
        this.protectedLowTrail.fill(0, 0, len);
        this.bullStates.fill(0, 0, len);
        this.discontinuityBreaks.fill(0, 0, len);

        const baseCfg = createDefaultPHLConfig(this.currentSymbol, `${Math.round(intervalMs / 60000)}m`, intervalMs);
        const phlCfg = { ...baseCfg, pivotStrength, useValidPullbacks, extraValidPullbacks };

        let phlState = createInitialPHLState();
        let atrState: ATRPeriodState | undefined;
        let prevClose: number | null = null;
        let prevTime = -1;
        let acceptedIdx = 0;

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

            const atrRes = updateWilderATR(h, l, prevClose, 14, atrState, isDiscontinuity);
            atrState = atrRes.nextState;
            prevClose = c;
            const atrVal = atrRes.isValid && atrRes.atrValue > 0 ? atrRes.atrValue : null;

            const step = stepPHL({ time: t, open: o, high: h, low: l, close: c, volume: v }, acceptedIdx, phlState, phlCfg, isDiscontinuity, atrVal, null);
            phlState = step.nextState;
            acceptedIdx++;

            if (step.confirmedPivotHigh) {
                this.confirmedPivots.push({ barIndex: step.confirmedPivotHigh.barIndex, confirmedBarIndex: i, price: step.confirmedPivotHigh.price, type: 'high' });
            }
            if (step.confirmedPivotLow) {
                this.confirmedPivots.push({ barIndex: step.confirmedPivotLow.barIndex, confirmedBarIndex: i, price: step.confirmedPivotLow.price, type: 'low' });
            }
            if (step.events.length > 0) {
                this.cachedEvents.push(...step.events);
            }
            this.protectedHighTrail[i] = step.activeProtectedHigh ? step.activeProtectedHigh.price : 0;
            this.protectedLowTrail[i] = step.activeProtectedLow ? step.activeProtectedLow.price : 0;
            this.bullStates[i] = phlState.bull === true ? 1 : phlState.bull === false ? -1 : 0;
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
        const showTrail = this.getParam<boolean>('showProtectedTrail', true);

        const sp = r.candleSpacing * r.zoom;
        const visStart = Math.max(0, Math.floor(r.cameraX / sp) - 2);
        const visEnd = Math.min(r.dataStore.length - 1, Math.floor((r.cameraX + layout.chartWidth) / sp) + 2);

        if (showTrail) {
            g.beginPath();
            let hasHi = false;
            for (let i = visStart; i < visEnd; i++) {
                if (this.protectedHighTrail[i] <= 0 || this.protectedHighTrail[i + 1] <= 0) continue;
                if (this.discontinuityBreaks[i + 1] === 1) continue;
                g.moveTo(r.getCandleCenterX(i), r.priceToY(this.protectedHighTrail[i]))
                    .lineTo(r.getCandleCenterX(i + 1), r.priceToY(this.protectedHighTrail[i + 1]));
                hasHi = true;
            }
            if (hasHi) g.stroke({ color: bearClr.color, width: 1.5, alpha: 0.65 });

            g.beginPath();
            let hasLo = false;
            for (let i = visStart; i < visEnd; i++) {
                if (this.protectedLowTrail[i] <= 0 || this.protectedLowTrail[i + 1] <= 0) continue;
                if (this.discontinuityBreaks[i + 1] === 1) continue;
                g.moveTo(r.getCandleCenterX(i), r.priceToY(this.protectedLowTrail[i]))
                    .lineTo(r.getCandleCenterX(i + 1), r.priceToY(this.protectedLowTrail[i + 1]));
                hasLo = true;
            }
            if (hasLo) g.stroke({ color: bullClr.color, width: 1.5, alpha: 0.65 });
        }

        // Confirmed pivot dots
        g.beginPath();
        let hasPiv = false;
        for (const p of this.confirmedPivots) {
            const x = r.getCandleCenterX(p.barIndex);
            if (x < -20 || x > layout.chartWidth + 20) continue;
            g.circle(x, r.priceToY(p.price), 3);
            hasPiv = true;
        }
        if (hasPiv) g.fill({ color: 0xFFC107, alpha: 0.9 });

        // BOS / MSS break lines + confirmation markers
        for (const [dir, clr] of [['bull', bullClr], ['bear', bearClr]] as const) {
            g.beginPath();
            let hasEv = false;
            for (const ev of this.cachedEvents) {
                if (ev.eventDirection !== dir) continue;
                const x1 = r.getCandleCenterX(ev.sourceBarIndex);
                const x2 = r.getCandleCenterX(ev.confirmationBarIndex);
                if (Math.max(x1, x2) < -20 || Math.min(x1, x2) > layout.chartWidth + 20) continue;
                const level = Number(ev.structuralContext['brokenLevelPrice']);
                const y = r.priceToY(level);
                g.moveTo(x1, y).lineTo(x2, y);
                const isMss = ev.structuralContext['breakType'] === 'MSS';
                const markerR = isMss ? 5 : 3.5;
                g.moveTo(x2, y - markerR).lineTo(x2 + markerR, y).lineTo(x2, y + markerR).lineTo(x2 - markerR, y).closePath();
                hasEv = true;
            }
            if (hasEv) g.stroke({ color: clr.color, width: 2, alpha: 0.95 });
        }
    }

    public override getValueAt(idx: number, ds: DataStore, _isDark: boolean, defaultTextClr: number) {
        if (idx < 0 || idx >= ds.length) return { label: this.name, valueStr: '—', valueColor: defaultTextClr };
        const st = this.bullStates[idx];
        const bullClr = parseColor(this.getParam('bullColor', '#26A69A'));
        const bearClr = parseColor(this.getParam('bearColor', '#EF5350'));
        const evAtBar = this.cachedEvents.find(e => e.confirmationBarIndex === idx);
        if (evAtBar) {
            return { label: this.name, valueStr: evAtBar.eventType, valueColor: evAtBar.eventDirection === 'bull' ? bullClr : bearClr };
        }
        return {
            label: this.name,
            valueStr: st === 1 ? 'Bullish Structure' : st === -1 ? 'Bearish Structure' : 'Neutral',
            valueColor: st === 1 ? bullClr : st === -1 ? bearClr : defaultTextClr
        };
    }

    public destroy(): void {
        this.cachedEvents = [];
        this.confirmedPivots = [];
        this.protectedHighTrail = new Float64Array(0);
        this.protectedLowTrail = new Float64Array(0);
        this.bullStates = new Int8Array(0);
        this.discontinuityBreaks = new Uint8Array(0);
    }
}
