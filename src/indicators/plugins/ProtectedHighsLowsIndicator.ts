import { BitmapText, Container, Graphics } from 'pixi.js';
import { BaseIndicator, parseColor, parseColorAndAlpha, type IndicatorLayout } from '../Indicator';
import type { DataStore } from '../../data/DataStore';
import type { ChartRenderer } from '../../renderer/ChartRenderer';
import { StrokeEngine } from '../../renderer/StrokeEngine';
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

export interface PHLTargetSegment {
    readonly startBar: number;
    readonly endBar: number;
    readonly price: number;
    readonly entryPrice: number;
    readonly stepNum: number;
    readonly dir: 1 | -1;
    readonly hit: boolean;
}

export class ProtectedHighsLowsIndicator extends BaseIndicator {
    public cachedEvents: StrategyEvent[] = [];
    public confirmedPivots: PHLConfirmedPivotMarker[] = [];
    public targetSegments: PHLTargetSegment[] = [];
    public trailPrices = new Float64Array(20000);
    public trailDirs = new Int8Array(20000);
    public bullStates = new Int8Array(20000);
    public discontinuityBreaks = new Uint8Array(20000);
    public currentSymbol = 'SOLUSDT';

    private lastCalculatedLength = -1;
    private lastStateHash = '';
    private labelContainer: Container | null = null;
    private labelPool: BitmapText[] = [];

    constructor() {
        super('PHL_BOS_MSS', 'Protected Highs/Lows');
        this.isOscillator = false;
        this.layerType = 'main';

        this.params = [
            { id: 'pivotStrength', name: 'Pivot Strength (1m: 8–15)', type: 'number', value: 10, min: 1, max: 50, step: 1 },
            { id: 'useValidPullbacks', name: 'Use Valid Pullback Criteria', type: 'boolean', value: true },
            { id: 'extraValidPullbacks', name: 'Specific Pullback Candle', type: 'boolean', value: false },
            { id: 'bullColor', name: 'Bullish BOS/MSS Color', type: 'color', value: '#089981' },
            { id: 'bearColor', name: 'Bearish BOS/MSS Color', type: 'color', value: '#F23645' },
            { id: 'showPhl', name: 'Show Protected Triangles (▲ / ▼)', type: 'boolean', value: true },
            { id: 'plColor', name: 'Protected Low Color', type: 'color', value: '#2962FF' },
            { id: 'phColor', name: 'Protected High Color', type: 'color', value: '#F23645' },
            { id: 'trailPhl', name: 'Show Protected Trail', type: 'boolean', value: true },
            { id: 'showTargets', name: 'Show ATR Targets', type: 'boolean', value: true },
            { id: 'showTargetHistory', name: 'Show Target History', type: 'boolean', value: true },
            { id: 'targetReset', name: 'Reset Targets On', type: 'select', value: 'MSS & BOS', options: ['MSS & BOS', 'MSS Only'] },
            { id: 'targetTrigger', name: 'Target Hit Trigger', type: 'select', value: 'Close Only', options: ['Close Only', 'Wick (High/Low)'] },
            { id: 'targetAtrLen', name: 'Target ATR Length', type: 'number', value: 14, min: 2, max: 100, step: 1 },
            { id: 'targetStepMult', name: 'Target Step (ATR Mult)', type: 'number', value: 2.0, min: 0.1, max: 10, step: 0.1 }
        ];
    }

    protected override onParamsUpdated(): void {
        this.lastCalculatedLength = -1;
        this.lastStateHash = '';
        this.cachedEvents = [];
        this.confirmedPivots = [];
        this.targetSegments = [];
    }

    private ensureCapacity(len: number): void {
        if (len <= this.trailPrices.length) return;
        const cap = Math.max(len * 2, 20000);
        this.trailPrices = new Float64Array(cap);
        this.trailDirs = new Int8Array(cap);
        this.bullStates = new Int8Array(cap);
        this.discontinuityBreaks = new Uint8Array(cap);
    }

    private hideLabels(): void {
        for (const lbl of this.labelPool) {
            lbl.visible = false;
        }
    }

    public override reset(): void {
        this.lastCalculatedLength = -1;
        this.lastStateHash = '';
        this.cachedEvents = [];
        this.confirmedPivots = [];
        this.targetSegments = [];
        this.trailPrices.fill(0);
        this.trailDirs.fill(0);
        this.bullStates.fill(0);
        this.discontinuityBreaks.fill(0);
        this.hideLabels();
        super.reset();
    }

    public calculate(ds: DataStore): void {
        const len = ds.length;
        if (len === 0) return;
        this.ensureCapacity(len);

        const pivotStrength = Math.max(1, Math.round(this.getParam<number>('pivotStrength', 10)));
        const useValidPullbacks = this.getParam<boolean>('useValidPullbacks', true);
        const extraValidPullbacks = this.getParam<boolean>('extraValidPullbacks', false);
        const targetReset = this.getParam<string>('targetReset', 'MSS & BOS');
        const targetTrigger = this.getParam<string>('targetTrigger', 'Close Only');
        const targetAtrLen = Math.max(2, Math.round(this.getParam<number>('targetAtrLen', 14)));
        const targetStepMult = Math.max(0.1, this.getParam<number>('targetStepMult', 2.0));
        const intervalMs = (len >= 2 && ds.data[6] > ds.data[0]) ? (ds.data[6] - ds.data[0]) : 60_000;
        const discThresholdMs = Math.max(300_000, intervalMs * 5);

        const lastBase = (len - 1) * 6;
        const rev = (ds as any).revision ?? 0;
        const hash = `${this.currentSymbol}:${intervalMs}:${pivotStrength}:${useValidPullbacks}:${extraValidPullbacks}:${targetReset}:${targetTrigger}:${targetAtrLen}:${targetStepMult}:${len}:${rev}:${ds.data[0]}:${ds.data[lastBase]}:${ds.data[lastBase + 4]}`;
        if (this.lastStateHash === hash && this.lastCalculatedLength === len) return;

        this.cachedEvents = [];
        this.confirmedPivots = [];
        this.targetSegments = [];
        this.trailPrices.fill(0, 0, len);
        this.trailDirs.fill(0, 0, len);
        this.bullStates.fill(0, 0, len);
        this.discontinuityBreaks.fill(0, 0, len);

        const baseCfg = createDefaultPHLConfig(this.currentSymbol, `${Math.round(intervalMs / 60000)}m`, intervalMs);
        const phlCfg = { ...baseCfg, pivotStrength, useValidPullbacks, extraValidPullbacks };

        let phlState = createInitialPHLState();
        let atrState: ATRPeriodState | undefined;
        let targetAtrState: ATRPeriodState | undefined;
        let prevClose: number | null = null;
        let prevTime = -1;
        let acceptedIdx = 0;

        let curTrailPrice = 0;
        let curTrailDir: 1 | -1 | 0 = 0;

        let activeTarget: { startBar: number; price: number; entryPrice: number; stepNum: number; dir: 1 | -1 } | null = null;

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
                curTrailPrice = 0;
                curTrailDir = 0;
                if (activeTarget) {
                    this.targetSegments.push({ ...activeTarget, endBar: Math.max(activeTarget.startBar, i - 1), hit: false });
                    activeTarget = null;
                }
            }
            prevTime = t;

            const atrRes = updateWilderATR(h, l, prevClose, 14, atrState, isDiscontinuity);
            atrState = atrRes.nextState;
            const targetAtrRes = targetAtrLen === 14
                ? atrRes
                : updateWilderATR(h, l, prevClose, targetAtrLen, targetAtrState, isDiscontinuity);
            if (targetAtrLen !== 14) targetAtrState = targetAtrRes.nextState;
            prevClose = c;
            const atrVal = atrRes.isValid && atrRes.atrValue > 0 ? atrRes.atrValue : null;
            const stepAtr = (targetAtrRes.isValid && targetAtrRes.atrValue > 0 ? targetAtrRes.atrValue : null) ?? (h - l);

            const step = stepPHL({ time: t, open: o, high: h, low: l, close: c, volume: v }, acceptedIdx, phlState, phlCfg, isDiscontinuity, atrVal, null);
            phlState = step.nextState;
            acceptedIdx++;

            if (step.events.length > 0) {
                this.cachedEvents.push(...step.events);
                const ev = step.events[0];
                const brokenPrice = Number(ev.structuralContext['brokenLevelPrice']);
                const isBullEv = ev.eventDirection === 'bull';

                if (isBullEv && step.activeProtectedLow) {
                    this.confirmedPivots.push({
                        barIndex: step.activeProtectedLow.barIndex,
                        confirmedBarIndex: i,
                        price: step.activeProtectedLow.price,
                        type: 'low'
                    });
                    curTrailPrice = step.activeProtectedLow.price;
                    curTrailDir = 1;
                } else if (!isBullEv && step.activeProtectedHigh) {
                    this.confirmedPivots.push({
                        barIndex: step.activeProtectedHigh.barIndex,
                        confirmedBarIndex: i,
                        price: step.activeProtectedHigh.price,
                        type: 'high'
                    });
                    curTrailPrice = step.activeProtectedHigh.price;
                    curTrailDir = -1;
                }

                const isMss = ev.structuralContext['breakType'] === 'MSS';
                if (targetReset === 'MSS & BOS' || isMss || !activeTarget) {
                    if (activeTarget) {
                        this.targetSegments.push({ ...activeTarget, endBar: i, hit: false });
                    }
                    const dir: 1 | -1 = isBullEv ? 1 : -1;
                    activeTarget = {
                        startBar: i,
                        price: brokenPrice + dir * stepAtr * targetStepMult,
                        entryPrice: brokenPrice,
                        stepNum: 1,
                        dir
                    };
                }
            } else if (activeTarget && i > activeTarget.startBar) {
                const hit = targetTrigger === 'Wick (High/Low)'
                    ? (activeTarget.dir === 1 ? h >= activeTarget.price : l <= activeTarget.price)
                    : (activeTarget.dir === 1 ? c >= activeTarget.price : c <= activeTarget.price);
                if (hit) {
                    this.targetSegments.push({ ...activeTarget, endBar: i, hit: true });
                    activeTarget = {
                        startBar: i,
                        price: activeTarget.price + activeTarget.dir * stepAtr * targetStepMult,
                        entryPrice: activeTarget.entryPrice,
                        stepNum: activeTarget.stepNum + 1,
                        dir: activeTarget.dir
                    };
                }
            }

            this.trailPrices[i] = curTrailPrice;
            this.trailDirs[i] = curTrailDir;
            this.bullStates[i] = phlState.bull === true ? 1 : phlState.bull === false ? -1 : 0;
        }

        if (activeTarget) {
            this.targetSegments.push({ ...activeTarget, endBar: len - 1 + 10, hit: false });
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
        if (!this.visible || r.dataStore.length === 0) {
            this.hideLabels();
            return;
        }
        if (this.lastCalculatedLength !== r.dataStore.length) this.calculate(r.dataStore);

        const bullClr = parseColorAndAlpha(this.getParam<string>('bullColor', '#089981'), 1.0);
        const bearClr = parseColorAndAlpha(this.getParam<string>('bearColor', '#F23645'), 1.0);
        const plClr = parseColorAndAlpha(this.getParam<string>('plColor', '#2962FF'), 1.0);
        const phClr = parseColorAndAlpha(this.getParam<string>('phColor', '#F23645'), 1.0);
        const showPhl = this.getParam<boolean>('showPhl', true);
        const showTrail = this.getParam<boolean>('trailPhl', true);
        const showTargets = this.getParam<boolean>('showTargets', true);
        const showTargetHistory = this.getParam<boolean>('showTargetHistory', true);

        const sp = r.candleSpacing * r.zoom;
        const visStart = Math.max(0, Math.floor(r.cameraX / sp) - 2);
        const visEnd = Math.min(r.dataStore.length - 1, Math.floor((r.cameraX + layout.chartWidth) / sp) + 2);

        // 1. Unified Protected Trail (Pine blue=PL / red=PH)
        if (showTrail) {
            for (const [dir, clr] of [[1, plClr], [-1, phClr]] as const) {
                g.beginPath();
                let hasSeg = false;
                for (let i = visStart; i < visEnd; i++) {
                    if (this.trailPrices[i] <= 0 || this.trailPrices[i + 1] <= 0) continue;
                    if (this.discontinuityBreaks[i + 1] === 1 || this.trailDirs[i + 1] !== dir) continue;
                    g.moveTo(r.getCandleCenterX(i), r.priceToY(this.trailPrices[i]))
                        .lineTo(r.getCandleCenterX(i + 1), r.priceToY(this.trailPrices[i + 1]));
                    hasSeg = true;
                }
                if (hasSeg) g.stroke({ color: clr.color, width: 2, alpha: 0.9 });
            }
        }

        // 2. BOS / MSS Dashed Break Lines + Protected ▲ / ▼ Markers
        for (const ev of this.cachedEvents) {
            const x1 = r.getCandleCenterX(ev.sourceBarIndex);
            const x2 = r.getCandleCenterX(ev.confirmationBarIndex);
            if (Math.max(x1, x2) < -20 || Math.min(x1, x2) > layout.chartWidth + 20) continue;

            const isBull = ev.eventDirection === 'bull';
            const clr = isBull ? bullClr.color : bearClr.color;
            const level = Number(ev.structuralContext['brokenLevelPrice']);
            const y = r.priceToY(level);

            StrokeEngine.drawLine(g, x1, y, x2, y, {
                color: clr, width: 1.5, alpha: 0.9, style: 'dashed', dashLength: 4, gapLength: 3
            });

            // MSS = larger diamond at midpoint; BOS = small diamond
            const mx = (x1 + x2) * 0.5;
            const rSize = ev.structuralContext['breakType'] === 'MSS' ? 4.5 : 3;
            g.beginPath();
            g.moveTo(mx, y - rSize).lineTo(mx + rSize, y).lineTo(mx, y + rSize).lineTo(mx - rSize, y).closePath();
            g.fill({ color: clr, alpha: 0.95 });
        }

        // Protected Highs / Lows Triangles (▲ / ▼)
        if (showPhl) {
            g.beginPath();
            let hasPh = false;
            for (const p of this.confirmedPivots) {
                if (p.type !== 'high') continue;
                const x = r.getCandleCenterX(p.barIndex);
                if (x < -20 || x > layout.chartWidth + 20) continue;
                const y = r.priceToY(p.price) - 6;
                g.moveTo(x, y + 5).lineTo(x - 4, y - 3).lineTo(x + 4, y - 3).closePath();
                hasPh = true;
            }
            if (hasPh) g.fill({ color: phClr.color, alpha: 0.9 });

            g.beginPath();
            let hasPl = false;
            for (const p of this.confirmedPivots) {
                if (p.type !== 'low') continue;
                const x = r.getCandleCenterX(p.barIndex);
                if (x < -20 || x > layout.chartWidth + 20) continue;
                const y = r.priceToY(p.price) + 6;
                g.moveTo(x, y - 5).lineTo(x - 4, y + 3).lineTo(x + 4, y + 3).closePath();
                hasPl = true;
            }
            if (hasPl) g.fill({ color: plClr.color, alpha: 0.9 });
        }

        // 3. ATR Targets (Pine live solid + historical hit dashed + TP labels)
        if (!showTargets) {
            this.hideLabels();
        } else {
            const fmtPrice = (p: number): string =>
                p >= 1000 ? p.toFixed(2) : p >= 10 ? p.toFixed(3) : p >= 1 ? p.toFixed(4) : p.toFixed(5);

            let labelIdx = 0;
            const canDrawLabels = !!(r.isInitialized && r.indicatorMainContainer);
            if (canDrawLabels) {
                if (!this.labelContainer) this.labelContainer = new Container();
                if (this.labelContainer.parent !== r.indicatorMainContainer) {
                    if (this.labelContainer.parent) this.labelContainer.parent.removeChild(this.labelContainer);
                    r.indicatorMainContainer.addChild(this.labelContainer);
                }
                this.labelContainer.visible = true;
            }

            for (const tgt of this.targetSegments) {
                if (tgt.hit && !showTargetHistory) continue;
                const x1 = r.getCandleCenterX(tgt.startBar);
                const x2 = r.getCandleCenterX(tgt.endBar);
                if (x2 < -20 || x1 > layout.chartWidth + 20) continue;
                const y = r.priceToY(tgt.price);
                if (y < 0 || y > layout.mainChartHeight) continue;

                const clr = tgt.dir === 1 ? bullClr.color : bearClr.color;
                StrokeEngine.drawLine(g, x1, y, x2, y, {
                    color: clr,
                    width: tgt.hit ? 1 : 2,
                    alpha: tgt.hit ? 0.55 : 0.95,
                    style: tgt.hit ? 'dashed' : 'solid',
                    dashLength: 4,
                    gapLength: 3
                });

                if (canDrawLabels && this.labelContainer) {
                    const pct = tgt.entryPrice > 0 ? ((tgt.price - tgt.entryPrice) / tgt.entryPrice) * 100 : 0;
                    const sign = pct >= 0 ? '+' : '';
                    const txt = `TP${tgt.stepNum}: ${fmtPrice(tgt.price)} (${sign}${pct.toFixed(2)}%)`;
                    let lbl: BitmapText;
                    if (labelIdx < this.labelPool.length) {
                        lbl = this.labelPool[labelIdx];
                    } else {
                        lbl = new BitmapText({ text: '', style: { fontFamily: 'ChartFont', fontSize: 10 } });
                        lbl.anchor.set(1, 1);
                        this.labelPool.push(lbl);
                        this.labelContainer.addChild(lbl);
                    }
                    lbl.text = txt;
                    lbl.tint = clr;
                    lbl.alpha = tgt.hit ? 0.65 : 1.0;
                    lbl.x = Math.min(x2, layout.chartWidth - 4);
                    lbl.y = Math.max(12, y - 2);
                    lbl.visible = true;
                    labelIdx++;
                }
            }

            for (let k = labelIdx; k < this.labelPool.length; k++) {
                this.labelPool[k].visible = false;
            }
        }
    }

    public override getValueAt(idx: number, ds: DataStore, _isDark: boolean, defaultTextClr: number) {
        if (idx < 0 || idx >= ds.length) return { label: this.name, valueStr: '—', valueColor: defaultTextClr };
        const st = this.bullStates[idx];
        const bullClr = parseColor(this.getParam('bullColor', '#089981'));
        const bearClr = parseColor(this.getParam('bearColor', '#F23645'));
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
        if (this.labelContainer) {
            this.labelContainer.destroy({ children: true });
            this.labelContainer = null;
        }
        this.labelPool = [];
        this.cachedEvents = [];
        this.confirmedPivots = [];
        this.targetSegments = [];
        this.trailPrices = new Float64Array(0);
        this.trailDirs = new Int8Array(0);
        this.bullStates = new Int8Array(0);
        this.discontinuityBreaks = new Uint8Array(0);
    }
}
