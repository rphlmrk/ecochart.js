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
    readonly fibStartBarIndex: number;
    readonly fibEndBarIndex: number;
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
            { id: 'showSwings', name: 'Show Swing Points', type: 'boolean', value: true },
            { id: 'dispAll', name: 'Display All Zones', type: 'boolean', value: true },
            { id: 'zoneDispNum', name: 'Show Last Zones', type: 'number', value: 1, min: 0, max: 100, step: 1 },
            { id: 'zoneFilter', name: 'Zone Display', type: 'select', value: 'Both', options: ['Bullish Only', 'Bearish Only', 'Both'] },
            { id: 'showFibs', name: 'Show 0.3 / 0.5 / 0.7 Fibs', type: 'boolean', value: true },
            { id: 'noOverlap', name: 'Clean-Up Level Overlap', type: 'boolean', value: true },
            { id: 'extendLeft', name: 'Extend Box Left', type: 'boolean', value: false },
            { id: 'showLifecycle', name: 'Show Retest / Invalidation Markers', type: 'boolean', value: false },
            { id: 'demandColor', name: 'Bullish Zone Color', type: 'color', value: '#08998133' },
            { id: 'supplyColor', name: 'Bearish Zone Color', type: 'color', value: '#F2364533' },
            { id: 'structureColor', name: 'Swing Point Color', type: 'color', value: '#787B86' }
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
        const noOverlap = this.getParam<boolean>('noOverlap', true);
        const intervalMs = (len >= 2 && ds.data[6] > ds.data[0]) ? (ds.data[6] - ds.data[0]) : 60_000;
        const discThresholdMs = Math.max(300_000, intervalMs * 5);

        const lastBase = (len - 1) * 6;
        const rev = (ds as any).revision ?? 0;
        const hash = `${this.currentSymbol}:${intervalMs}:${structureLen}:${noOverlap}:${len}:${rev}:${ds.data[0]}:${ds.data[lastBase]}:${ds.data[lastBase + 4]}`;
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

        const lifecycleById = new Map<number, { zone: DTFXZoneRecord; endBarIndex: number; fibStartBarIndex: number; fibEndBarIndex: number; retestBars: number[] }>();

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
            if (isDiscontinuity && this.zoneLifecycles.length > 0) {
                const lastItem = this.zoneLifecycles[this.zoneLifecycles.length - 1] as any;
                lastItem.fibEndBarIndex = Math.max(lastItem.fibStartBarIndex, acceptedIdx - 1);
            }
            prevTime = t;

            const atrRes = updateWilderATR(h, l, prevClose, 14, atrState, isDiscontinuity);
            atrState = atrRes.nextState;
            prevClose = c;
            const atrVal = atrRes.isValid && atrRes.atrValue > 0 ? atrRes.atrValue : null;

            const step = stepDTFX({ time: t, open: o, high: h, low: l, close: c, volume: v }, acceptedIdx, dtfxState, dtfxCfg, isDiscontinuity, atrVal, null);
            dtfxState = step.nextState;

            for (const cz of step.createdZones) {
                // Pine box span is strictly [t.bar .. bar_index] (sourceBar -> confirmationBar)
                const boxEnd = cz.createdConfirmationBarIndex;
                let fibStart = cz.createdSourceBarIndex;

                if (this.zoneLifecycles.length > 0) {
                    const prevEntry = this.zoneLifecycles[this.zoneLifecycles.length - 1] as any;
                    // Previous live_lvls stops extending when the new zone replaces live_lvls
                    prevEntry.fibEndBarIndex = Math.min(prevEntry.fibEndBarIndex, cz.createdConfirmationBarIndex);
                    if (noOverlap && prevEntry.fibEndBarIndex > cz.createdSourceBarIndex) {
                        const boundary = Math.max(cz.createdSourceBarIndex, prevEntry.zone.createdConfirmationBarIndex);
                        prevEntry.fibEndBarIndex = boundary;
                        fibStart = boundary;
                    }
                }

                const rec = {
                    zone: cz,
                    endBarIndex: boxEnd,
                    fibStartBarIndex: fibStart,
                    fibEndBarIndex: len - 1,
                    retestBars: []
                };
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
        if (this.lastCalculatedLength !== -1 && (ds.length > this.lastCalculatedLength + 2 || ds.length <= this.lastCalculatedLength)) {
            this.lastCalculatedLength = -1;
        }
        this.calculate(ds);
        super.update(ds, isClosedTick);
    }

    public render(r: ChartRenderer, layout: IndicatorLayout, g: Graphics): void {
        if (!this.visible || r.dataStore.length === 0) return;
        if (this.lastCalculatedLength !== r.dataStore.length) this.calculate(r.dataStore);

        const demandClr = parseColorAndAlpha(this.getParam<string>('demandColor', '#08998133'), 0.20);
        const supplyClr = parseColorAndAlpha(this.getParam<string>('supplyColor', '#F2364533'), 0.20);
        const swingClr = parseColor(this.getParam<string>('structureColor', '#787B86'));
        const showSwings = this.getParam<boolean>('showSwings', true);
        const showFibs = this.getParam<boolean>('showFibs', true);
        const showLifecycle = this.getParam<boolean>('showLifecycle', false);
        const dispAll = this.getParam<boolean>('dispAll', true);
        const zoneDispNum = Math.max(0, Math.round(this.getParam<number>('zoneDispNum', 1)));
        const zoneFilter = this.getParam<string>('zoneFilter', 'Both');
        const extendLeft = this.getParam<boolean>('extendLeft', false);

        let visibleZones = this.zoneLifecycles.filter(item => {
            if (zoneFilter === 'Bullish Only') return item.zone.direction === 'bull';
            if (zoneFilter === 'Bearish Only') return item.zone.direction === 'bear';
            return true;
        });
        if (!dispAll) {
            visibleZones = zoneDispNum === 0 ? [] : visibleZones.slice(-zoneDispNum);
        }

        for (const item of visibleZones) {
            const z = item.zone;
            const sourceDsIdx = this.acceptedToDsIndex[z.createdSourceBarIndex] ?? z.createdSourceBarIndex;
            const endDsIdx = this.acceptedToDsIndex[item.endBarIndex] ?? item.endBarIndex;
            const fibStartDsIdx = this.acceptedToDsIndex[item.fibStartBarIndex] ?? item.fibStartBarIndex;
            const fibEndDsIdx = item.fibEndBarIndex < this.acceptedToDsIndex.length
                ? (this.acceptedToDsIndex[item.fibEndBarIndex] ?? item.fibEndBarIndex)
                : item.fibEndBarIndex;

            const x1 = r.getCandleCenterX(sourceDsIdx);
            const x2 = r.getCandleCenterX(endDsIdx);
            const fx1 = r.getCandleCenterX(fibStartDsIdx);
            const fx2 = r.getCandleCenterX(fibEndDsIdx);
            if (Math.max(x2, fx2) < -20 || Math.min(x1, fx1) > layout.chartWidth + 20) continue;

            const yTop = r.priceToY(z.top);
            const yBot = r.priceToY(z.bot);
            const w = Math.max(4, x2 - x1);
            const h = Math.max(2, yBot - yTop);
            const style = z.direction === 'bull' ? demandClr : supplyClr;

            // Pine box(t.bar, _top, bar_index, _bot, border_color = na): always highlights the zone section
            g.rect(x1, yTop, w, h).fill({ color: style.color, alpha: style.alpha });

            // Optional extension beyond the box towards the left
            if (extendLeft && x1 > 0) {
                g.rect(0, yTop, x1, h).fill({ color: style.color, alpha: style.alpha * 0.5 });
            }

            if (showSwings) {
                const sy = z.direction === 'bull' ? yTop - 5 : yBot + 5;
                g.circle(x1, sy, 2.5).fill({ color: swingClr, alpha: 0.85 });
            }

            // Pine Fibs: 0.3 dashed, 0.5 solid, 0.7 dashed
            if (showFibs && fx2 > fx1) {
                const fibSpecs: Array<{ price: number; style: 'dashed' | 'solid' }> = [
                    { price: z.fib03, style: 'dashed' },
                    { price: z.fib05, style: 'solid' },
                    { price: z.fib07, style: 'dashed' }
                ];
                for (const fs of fibSpecs) {
                    const fy = r.priceToY(fs.price);
                    StrokeEngine.drawLine(g, fx1, fy, fx2, fy, {
                        color: style.color, width: fs.style === 'solid' ? 1.5 : 1, alpha: 0.9, style: fs.style, dashLength: 4, gapLength: 3
                    });
                }
            }

            if (showLifecycle) {
                for (const rb of item.retestBars) {
                    const rx = r.getCandleCenterX(this.acceptedToDsIndex[rb] ?? rb);
                    const ry = r.priceToY(z.fib05);
                    g.beginPath();
                    g.moveTo(rx, ry - 4).lineTo(rx + 4, ry).lineTo(rx, ry + 4).lineTo(rx - 4, ry).closePath();
                    g.fill({ color: style.color, alpha: 0.95 });
                }
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
    }

    public override getValueAt(idx: number, ds: DataStore, _isDark: boolean, defaultTextClr: number) {
        if (idx < 0 || idx >= ds.length) return { label: this.name, valueStr: '—', valueColor: defaultTextClr };
        const evAtBar = this.cachedEvents.find(e => e.confirmationBarIndex === idx);
        const activeCount = this.zoneLifecycles.filter(
            z => z.zone.createdConfirmationBarIndex <= idx &&
                (z.zone.invalidationBarIndex === null || z.zone.invalidationBarIndex >= idx) &&
                z.zone.status !== 'INVALIDATED'
        ).length;
        if (evAtBar) {
            const clr = evAtBar.eventDirection === 'bull'
                ? parseColor(this.getParam('demandColor', '#08998133'))
                : parseColor(this.getParam('supplyColor', '#F2364533'));
            return { label: this.name, valueStr: `${evAtBar.eventType} (${activeCount} active)`, valueColor: clr };
        }
        return { label: this.name, valueStr: `Active Zones: ${activeCount}`, valueColor: defaultTextClr };
    }

    public destroy(): void {
        this.cachedEvents = [];
        this.zoneLifecycles = [];
        this.acceptedToDsIndex = [];
    }
}
