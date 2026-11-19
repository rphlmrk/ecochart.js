import { Graphics } from 'pixi.js';
import { BaseIndicator, parseColor, parseColorAndAlpha, type IndicatorLayout } from '../Indicator';
import type { DataStore } from '../../data/DataStore';
import type { ChartRenderer } from '../../renderer/ChartRenderer';
import { StrokeEngine } from '../../renderer/StrokeEngine';
import {
    createDefaultDTFXConfig,
    createInitialDTFXState,
    stepDTFX,
    type DTFXZoneRecord
} from '../mlr1/teachers/DTFXAlgoZonesTeacher';
import { updateWilderATR } from '../mlr1/volatility/ATR';
import type { ATRPeriodState } from '../mlr1/ML1FeatureTypes';
import type { StrategyEvent } from '../mlr1/teachers/StrategyEventTypes';

export interface DTFXRenderedZoneLifecycle {
    readonly zone: DTFXZoneRecord;
    readonly endBarIndex: number;
    readonly retestBars: number[];
}

export class DTFXAlgoZonesIndicator extends BaseIndicator {
    public cachedEvents: StrategyEvent[] = [];
    public zoneLifecycles: DTFXRenderedZoneLifecycle[] = [];
    public currentSymbol = 'SOLUSDT';

    private lastCalculatedLength = -1;
    private lastStateHash = '';
    private acceptedToDsIndex: number[] = [];

    constructor() {
        super('DTFX_ZONES', 'DTFX Algo Zones');
        this.isOscillator = false;
        this.layerType = 'main';

        this.params = [
            { id: 'structureLen', name: 'Structure Length', type: 'number', value: 10, min: 2, max: 50, step: 1 },
            { id: 'showFibs', name: 'Show 0.3 / 0.5 / 0.7 Fibs', type: 'boolean', value: true },
            { id: 'extendLeft', name: 'Extend Box Left', type: 'boolean', value: true },
            { id: 'demandColor', name: 'Demand Zone Color', type: 'color', value: '#26A69A40' },
            { id: 'supplyColor', name: 'Supply Zone Color', type: 'color', value: '#EF535040' }
        ];
    }

    protected override onParamsUpdated(): void {
        this.lastCalculatedLength = -1;
        this.lastStateHash = '';
        this.cachedEvents = [];
        this.zoneLifecycles = [];
    }

    public override reset(): void {
        this.lastCalculatedLength = -1;
        this.lastStateHash = '';
        this.cachedEvents = [];
        this.zoneLifecycles = [];
        this.acceptedToDsIndex = [];
        super.reset();
    }

    public calculate(ds: DataStore): void {
        const len = ds.length;
        if (len === 0) return;

        const structureLen = Math.max(2, Math.round(this.getParam<number>('structureLen', 10)));
        const intervalMs = (len >= 2 && ds.data[6] > ds.data[0]) ? (ds.data[6] - ds.data[0]) : 60_000;
        const discThresholdMs = Math.max(300_000, intervalMs * 5);

        const lastBase = (len - 1) * 6;
        const rev = (ds as any).revision ?? 0;
        const hash = `${this.currentSymbol}:${intervalMs}:${structureLen}:${len}:${rev}:${ds.data[0]}:${ds.data[lastBase]}:${ds.data[lastBase + 4]}`;
        if (this.lastStateHash === hash && this.lastCalculatedLength === len) return;

        this.cachedEvents = [];
        this.zoneLifecycles = [];
        this.acceptedToDsIndex = [];

        const baseCfg = createDefaultDTFXConfig(this.currentSymbol, `${Math.round(intervalMs / 60000)}m`, intervalMs);
        const dtfxCfg = { ...baseCfg, structureLen };

        let dtfxState = createInitialDTFXState();
        let atrState: ATRPeriodState | undefined;
        let prevClose: number | null = null;
        let prevTime = -1;
        let acceptedIdx = 0;

        const lifecycleById = new Map<number, { zone: DTFXZoneRecord; endBarIndex: number; retestBars: number[] }>();

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
            if (isDiscontinuity) {
                for (const active of dtfxState.activeZones) {
                    const entry = lifecycleById.get(active.zoneId);
                    if (entry) entry.endBarIndex = Math.max(entry.zone.createdConfirmationBarIndex, acceptedIdx - 1);
                }
            }
            prevTime = t;

            const atrRes = updateWilderATR(h, l, prevClose, 14, atrState, isDiscontinuity);
            atrState = atrRes.nextState;
            prevClose = c;
            const atrVal = atrRes.isValid && atrRes.atrValue > 0 ? atrRes.atrValue : null;

            const step = stepDTFX({ time: t, open: o, high: h, low: l, close: c, volume: v }, acceptedIdx, dtfxState, dtfxCfg, isDiscontinuity, atrVal, null);
            dtfxState = step.nextState;

            for (const cz of step.createdZones) {
                const rec = { zone: cz, endBarIndex: len - 1, retestBars: [] };
                lifecycleById.set(cz.zoneId, rec);
                this.zoneLifecycles.push(rec);
            }
            for (const rz of step.retestedZones) {
                const entry = lifecycleById.get(rz.zoneId);
                if (entry) {
                    entry.zone = rz;
                    entry.retestBars.push(acceptedIdx);
                }
            }
            for (const iz of step.invalidatedZones) {
                const entry = lifecycleById.get(iz.zoneId);
                if (entry) {
                    entry.zone = iz;
                    entry.endBarIndex = acceptedIdx;
                }
            }
            this.acceptedToDsIndex[acceptedIdx] = i;
            if (step.events.length > 0) this.cachedEvents.push(...step.events);
            acceptedIdx++;
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

        const demandClr = parseColorAndAlpha(this.getParam<string>('demandColor', '#26A69A40'), 0.25);
        const supplyClr = parseColorAndAlpha(this.getParam<string>('supplyColor', '#EF535040'), 0.25);
        const showFibs = this.getParam<boolean>('showFibs', true);
        const extendLeft = this.getParam<boolean>('extendLeft', true);

        for (const item of this.zoneLifecycles) {
            const z = item.zone;
            const startAcceptedIdx = extendLeft ? z.createdSourceBarIndex : z.createdConfirmationBarIndex;
            const startDsIdx = this.acceptedToDsIndex[startAcceptedIdx] ?? startAcceptedIdx;
            const endDsIdx = z.status === 'INVALIDATED'
                ? (this.acceptedToDsIndex[item.endBarIndex] ?? item.endBarIndex)
                : item.endBarIndex;
            const x1 = r.getCandleCenterX(startDsIdx);
            const x2 = r.getCandleCenterX(endDsIdx);
            if (x2 < -20 || x1 > layout.chartWidth + 20) continue;

            const yTop = r.priceToY(z.top);
            const yBot = r.priceToY(z.bot);
            const w = Math.max(4, x2 - x1);
            const h = Math.max(2, yBot - yTop);
            const style = z.direction === 'bull' ? demandClr : supplyClr;
            const alphaMult = z.status === 'INVALIDATED' ? 0.35 : 1.0;

            g.rect(x1, yTop, w, h).fill({ color: style.color, alpha: style.alpha * alphaMult });
            g.rect(x1, yTop, w, h).stroke({ color: style.color, width: z.status === 'RETESTED' ? 1.5 : 1, alpha: 0.8 * alphaMult });

            if (showFibs && z.status !== 'INVALIDATED') {
                for (const fibPrice of [z.fib03, z.fib05, z.fib07]) {
                    const fy = r.priceToY(fibPrice);
                    StrokeEngine.drawLine(g, x1, fy, x1 + w, fy, {
                        color: style.color, width: 1, alpha: 0.55, style: 'dashed', dashLength: 3, gapLength: 3
                    });
                }
            }

            // Retest diamond markers
            for (const rb of item.retestBars) {
                const rx = r.getCandleCenterX(this.acceptedToDsIndex[rb] ?? rb);
                const ry = r.priceToY(z.fib05);
                g.beginPath();
                g.moveTo(rx, ry - 4).lineTo(rx + 4, ry).lineTo(rx, ry + 4).lineTo(rx - 4, ry).closePath();
                g.fill({ color: style.color, alpha: 0.95 });
            }

            // Invalidation X marker
            if (z.status === 'INVALIDATED' && z.invalidationBarIndex !== null) {
                const ix = r.getCandleCenterX(this.acceptedToDsIndex[z.invalidationBarIndex] ?? z.invalidationBarIndex);
                const iy = r.priceToY(z.direction === 'bull' ? z.bot : z.top);
                g.beginPath();
                g.moveTo(ix - 4, iy - 4).lineTo(ix + 4, iy + 4);
                g.moveTo(ix + 4, iy - 4).lineTo(ix - 4, iy + 4);
                g.stroke({ color: style.color, width: 1.5, alpha: 0.85 });
            }
        }
    }

    public override getValueAt(idx: number, ds: DataStore, _isDark: boolean, defaultTextClr: number) {
        if (idx < 0 || idx >= ds.length) return { label: this.name, valueStr: '—', valueColor: defaultTextClr };
        const evAtBar = this.cachedEvents.find(e => e.confirmationBarIndex === idx);
        const activeCount = this.zoneLifecycles.filter(
            z => z.zone.createdConfirmationBarIndex <= idx && z.endBarIndex >= idx && z.zone.status !== 'INVALIDATED'
        ).length;
        if (evAtBar) {
            const clr = evAtBar.eventDirection === 'bull'
                ? parseColor(this.getParam('demandColor', '#26A69A40'))
                : parseColor(this.getParam('supplyColor', '#EF535040'));
            return { label: this.name, valueStr: `${evAtBar.eventType} (${activeCount} active)`, valueColor: clr };
        }
        return { label: this.name, valueStr: `Active Zones: ${activeCount}`, valueColor: defaultTextClr };
    }

    public destroy(): void {
        this.cachedEvents = [];
        this.zoneLifecycles = [];
    }
}
