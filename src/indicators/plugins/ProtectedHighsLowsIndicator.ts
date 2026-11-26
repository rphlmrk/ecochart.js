import { BitmapText, Container, Graphics } from 'pixi.js';
import { BaseIndicator, parseColor, parseColorAndAlpha, type IndicatorLayout } from '../Indicator';
import type { DataStore } from '../../data/DataStore';
import type { ChartRenderer } from '../../renderer/ChartRenderer';
import { StrokeEngine } from '../../renderer/StrokeEngine';
import { TimeframeResampler } from '../../data/TimeframeResampler';
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
            {
                id: 'timeframe',
                name: 'Timeframe',
                type: 'select',
                value: 'Current',
                options: ['Current', '3m', '5m', 'Custom HTF']
            },
            { id: 'customTfMins', name: 'Custom HTF Minutes', type: 'number', value: 5, min: 1, max: 43200, step: 1 },
            { id: 'pivotStrength', name: 'Pivot Strength (Default: 8)', type: 'number', value: 8, min: 1, max: 50, step: 1 },
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

    public static getTimeframeOptions(currentInterval: string): string[] {
        const ALL = ['1m', '3m', '5m', '30m', '45m', '1h', '2h', '3h', '4h', '6h', '8h', '12h', '1d', '3d', '1w'];
        const currentMs = TimeframeResampler.parseMs(currentInterval);
        const filtered = ALL.filter(tf => {
            const ms = TimeframeResampler.parseMs(tf);
            return ms > currentMs && ms % currentMs === 0;
        });
        return ['Current', ...filtered, 'Custom HTF'];
    }

    public getTimeframeOptions(currentInterval: string): string[] {
        return ProtectedHighsLowsIndicator.getTimeframeOptions(currentInterval);
    }

    public getEffectiveTfMs(chartTfMs: number): number {
        const mode = this.getParam<string>('timeframe', 'Current');
        if (mode === 'Current') return chartTfMs;
        if (mode === 'Custom' || mode === 'Custom HTF') {
            const rawMins = this.getParam<number>('customTfMins', 5);
            if (!Number.isSafeInteger(rawMins) || rawMins < 1 || rawMins > 43200) {
                return chartTfMs;
            }
            const customMs = rawMins * 60_000;
            if (customMs <= chartTfMs || customMs % chartTfMs !== 0) {
                return chartTfMs; // Option A: disallow partial/non-multiple custom HTF
            }
            return customMs;
        }
        const parsedMs = TimeframeResampler.parseMs(mode.toLowerCase());
        if (parsedMs <= chartTfMs || parsedMs % chartTfMs !== 0) return chartTfMs;
        return parsedMs;
    }

    protected override onParamsUpdated(): void {
        this.lastCalculatedLength = -1;
        this.lastStateHash = '';
        this.cachedEvents = [];
        this.confirmedPivots = [];
        this.targetSegments = [];
        const tf = this.getParam<string>('timeframe', 'Current');
        this.name = tf === 'Current' ? 'Protected Highs/Lows' : `Protected Highs/Lows [${tf}]`;
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

    /**
     * Validates all inputs/events and precomputes the complete commit plan
     * (`preparedCachedEvents`, `preparedPivots`, `preparedClosedTargets`, `simActiveTarget`,
     * `simTrailPrice`, `simTrailDir`) before any array mutation.
     *
     * Contracts:
     * - Rollback guarantees apply to ordinary mutable arrays (`length` writable, not frozen/sealed),
     *   not arbitrary proxies or hostile custom array overrides.
     * - `distToProtectedAtr` is intentionally recomputed at confirmation close using `closePrice` and `atrVal`.
     * - Prospective target prices are pre-checked to be finite and positive (> 0) defensively on every event.
     * - Optional `protectedLevelTimestamp` is validated as a positive safe integer (bar-index helper has no wall-clock confirmation timestamp).
     */
    public static applyBarEvents(params: {
        events: readonly StrategyEvent[];
        activeProtectedLow: { barIndex: number; price: number; time: number } | null;
        activeProtectedHigh: { barIndex: number; price: number; time: number } | null;
        confirmationBar: number;
        closePrice: number;
        atrVal: number | null;
        stepAtr: number;
        targetReset: string;
        targetStepMult: number;
        cachedEvents: StrategyEvent[];
        confirmedPivots: PHLConfirmedPivotMarker[];
        targetSegments: PHLTargetSegment[];
        activeTarget: { startBar: number; price: number; entryPrice: number; stepNum: number; dir: 1 | -1 } | null;
        curTrailPrice: number;
        curTrailDir: 1 | -1 | 0;
    }): {
        activeTarget: { startBar: number; price: number; entryPrice: number; stepNum: number; dir: 1 | -1 } | null;
        curTrailPrice: number;
        curTrailDir: 1 | -1 | 0;
    } {
        if (!Array.isArray(params.events) ||
            !Array.isArray(params.cachedEvents) ||
            !Array.isArray(params.confirmedPivots) ||
            !Array.isArray(params.targetSegments)) {
            throw new Error('PHL Indicator Error: events and output arrays must be arrays.');
        }
        for (const [name, arr] of [
            ['cachedEvents', params.cachedEvents],
            ['confirmedPivots', params.confirmedPivots],
            ['targetSegments', params.targetSegments]
        ] as const) {
            const lengthDesc = Object.getOwnPropertyDescriptor(arr, 'length');
            if (Object.isFrozen(arr) || Object.isSealed(arr) || !Object.isExtensible(arr) || !lengthDesc?.writable) {
                throw new Error(`PHL Indicator Error: output array '${name}' must be an ordinary mutable extensible array with writable length.`);
            }
        }
        if (params.targetReset !== 'MSS & BOS' && params.targetReset !== 'MSS Only') {
            throw new Error(`PHL Indicator Error: invalid targetReset '${String(params.targetReset)}'.`);
        }
        if (typeof params.curTrailPrice !== 'number' || !Number.isFinite(params.curTrailPrice) || params.curTrailPrice < 0) {
            throw new Error(`PHL Indicator Error: invalid curTrailPrice '${String(params.curTrailPrice)}'.`);
        }
        if (params.curTrailDir !== -1 && params.curTrailDir !== 0 && params.curTrailDir !== 1) {
            throw new Error(`PHL Indicator Error: invalid curTrailDir '${String(params.curTrailDir)}'.`);
        }
        if (!Number.isSafeInteger(params.confirmationBar) || params.confirmationBar < 0) {
            throw new Error(`PHL Indicator Error: invalid confirmationBar '${String(params.confirmationBar)}'.`);
        }
        if (typeof params.closePrice !== 'number' || !Number.isFinite(params.closePrice) || params.closePrice <= 0) {
            throw new Error(`PHL Indicator Error: invalid closePrice '${String(params.closePrice)}'.`);
        }
        if (params.atrVal !== null && (typeof params.atrVal !== 'number' || !Number.isFinite(params.atrVal) || params.atrVal <= 0)) {
            throw new Error(`PHL Indicator Error: atrVal must be null or finite positive, got '${String(params.atrVal)}'.`);
        }
        if (typeof params.stepAtr !== 'number' || !Number.isFinite(params.stepAtr) || params.stepAtr <= 0 ||
            typeof params.targetStepMult !== 'number' || !Number.isFinite(params.targetStepMult) || params.targetStepMult <= 0) {
            throw new Error('PHL Indicator Error: stepAtr and targetStepMult must be finite positive numbers.');
        }

        // Copy & validate initial caller-owned activeTarget before simulation (never read during commit)
        let simActiveTarget: { startBar: number; price: number; entryPrice: number; stepNum: number; dir: 1 | -1 } | null = null;
        if (params.activeTarget !== null) {
            const at = params.activeTarget;
            if (!at || typeof at !== 'object' ||
                !Number.isSafeInteger(at.startBar) || at.startBar < 0 || at.startBar > params.confirmationBar ||
                (at.dir !== 1 && at.dir !== -1) ||
                typeof at.price !== 'number' || !Number.isFinite(at.price) || at.price <= 0 ||
                typeof at.entryPrice !== 'number' || !Number.isFinite(at.entryPrice) || at.entryPrice <= 0 ||
                !Number.isSafeInteger(at.stepNum) || at.stepNum < 1) {
                throw new Error('PHL Indicator Error: invalid activeTarget.');
            }
            simActiveTarget = {
                startBar: at.startBar,
                price: at.price,
                entryPrice: at.entryPrice,
                stepNum: at.stepNum,
                dir: at.dir
            };
        }

        for (const [label, slot] of [
            ['activeProtectedLow', params.activeProtectedLow],
            ['activeProtectedHigh', params.activeProtectedHigh]
        ] as const) {
            if (slot !== null) {
                if (!slot || typeof slot !== 'object' ||
                    !Number.isSafeInteger(slot.barIndex) || slot.barIndex < 0 || slot.barIndex > params.confirmationBar ||
                    typeof slot.price !== 'number' || !Number.isFinite(slot.price) || slot.price <= 0 ||
                    !Number.isSafeInteger(slot.time) || slot.time <= 0) {
                    throw new Error(`PHL Indicator Error: invalid ${label}.`);
                }
            }
        }

        const atr14Valid = params.atrVal !== null;
        const knownPivotPriceByKey = new Map<string, number>();
        for (const p of params.confirmedPivots) {
            if (!p || typeof p !== 'object' ||
                !Number.isSafeInteger(p.barIndex) || p.barIndex < 0 ||
                !Number.isSafeInteger(p.confirmedBarIndex) || p.confirmedBarIndex < p.barIndex ||
                p.confirmedBarIndex > params.confirmationBar ||
                (p.type !== 'high' && p.type !== 'low') ||
                typeof p.price !== 'number' || !Number.isFinite(p.price) || p.price <= 0) {
                throw new Error('PHL Indicator Error: malformed or out-of-order existing entry in confirmedPivots.');
            }
            const k = `${p.barIndex}|${p.confirmedBarIndex}|${p.type}`;
            const prevPrice = knownPivotPriceByKey.get(k);
            if (prevPrice !== undefined && prevPrice !== p.price) {
                throw new Error(`PHL Indicator Error: contradictory duplicate pivot key '${k}' in confirmedPivots.`);
            }
            knownPivotPriceByKey.set(k, p.price);
        }

        const preparedCachedEvents: StrategyEvent[] = [];
        const preparedPivots: PHLConfirmedPivotMarker[] = [];
        const preparedClosedTargets: PHLTargetSegment[] = [];
        let simTrailPrice = params.curTrailPrice;
        let simTrailDir: 1 | -1 | 0 = params.curTrailDir;

        for (const ev of params.events) {
            if (!ev || (ev.eventDirection !== 'bull' && ev.eventDirection !== 'bear')) {
                throw new Error(`PHL Indicator Error: unsupported eventDirection '${String((ev as any)?.eventDirection)}'.`);
            }
            const ctx = ev.structuralContext;
            if (!ctx || typeof ctx !== 'object') {
                throw new Error('PHL Indicator Error: missing event structuralContext.');
            }
            const breakType = ctx['breakType'];
            if (breakType !== 'BOS' && breakType !== 'MSS') {
                throw new Error(`PHL Indicator Error: invalid breakType '${String(breakType)}'.`);
            }
            const brokenPrice = ctx['brokenLevelPrice'];
            if (typeof brokenPrice !== 'number' || !Number.isFinite(brokenPrice) || brokenPrice <= 0) {
                throw new Error(`PHL Indicator Error: invalid brokenLevelPrice '${String(brokenPrice)}'.`);
            }
            const hasProt = ctx['hasProtectedLevel'];
            if (typeof hasProt !== 'boolean') {
                throw new Error(`PHL Indicator Error: hasProtectedLevel must be boolean, got '${String(hasProt)}'.`);
            }

            const isBullEv = ev.eventDirection === 'bull';
            const dir: 1 | -1 = isBullEv ? 1 : -1;
            const targetPrice = brokenPrice + dir * params.stepAtr * params.targetStepMult;
            if (!Number.isFinite(targetPrice) || targetPrice <= 0) {
                throw new Error('PHL Indicator Error: calculated target price must be finite and positive.');
            }

            const rawProtPrice = ctx['protectedLevelPrice'];
            const rawOptBar = (ctx as Record<string, unknown>)['protectedLevelBarIndex'];
            const rawOptTime = (ctx as Record<string, unknown>)['protectedLevelTimestamp'];

            let evProtPrice: number | null = null;
            let protBar: number | null = null;
            let protTime: number | null = null;

            if (hasProt) {
                if (typeof rawProtPrice !== 'number' || !Number.isFinite(rawProtPrice) || rawProtPrice <= 0) {
                    throw new Error(`PHL Indicator Error: invalid protectedLevelPrice '${String(rawProtPrice)}'.`);
                }
                evProtPrice = rawProtPrice;

                if (rawOptBar !== undefined && rawOptBar !== null) {
                    if (typeof rawOptBar !== 'number' || !Number.isSafeInteger(rawOptBar) || rawOptBar < 0 || rawOptBar > params.confirmationBar) {
                        throw new Error(`PHL Indicator Error: invalid protectedLevelBarIndex '${String(rawOptBar)}'.`);
                    }
                    protBar = rawOptBar;
                }
                if (rawOptTime !== undefined && rawOptTime !== null) {
                    if (typeof rawOptTime !== 'number' || !Number.isSafeInteger(rawOptTime) || rawOptTime <= 0) {
                        throw new Error(`PHL Indicator Error: invalid protectedLevelTimestamp '${String(rawOptTime)}'.`);
                    }
                    protTime = rawOptTime;
                }

                if (protBar === null || protTime === null) {
                    const stepSlot = isBullEv ? params.activeProtectedLow : params.activeProtectedHigh;
                    if (stepSlot !== null &&
                        stepSlot.price === evProtPrice &&
                        (protBar === null || protBar === stepSlot.barIndex) &&
                        (protTime === null || protTime === stepSlot.time)) {
                        protBar = protBar ?? stepSlot.barIndex;
                        protTime = protTime ?? stepSlot.time;
                    }
                }
            } else {
                if ((rawProtPrice !== undefined && rawProtPrice !== null && rawProtPrice !== 0) ||
                    (rawOptBar !== undefined && rawOptBar !== null) ||
                    (rawOptTime !== undefined && rawOptTime !== null)) {
                    throw new Error('PHL Indicator Error: hasProtectedLevel=false cannot carry non-zero protected-level metadata.');
                }
            }

            const distProtAtr =
                hasProt && evProtPrice !== null && atr14Valid
                    ? (isBullEv ? (params.closePrice - evProtPrice) / params.atrVal! : (evProtPrice - params.closePrice) / params.atrVal!)
                    : null;
            if (distProtAtr !== null && !Number.isFinite(distProtAtr)) {
                throw new Error('PHL Indicator Error: computed distToProtectedAtr is non-finite.');
            }

            preparedCachedEvents.push({
                ...ev,
                structuralContext: {
                    ...ctx,
                    hasProtectedLevel: hasProt,
                    protectedLevelPrice: evProtPrice as any,
                    protectedLevelBarIndex: protBar as any,
                    protectedLevelTimestamp: protTime as any,
                    atr14Valid,
                    distToProtectedAtr: distProtAtr as any
                }
            });

            if (hasProt && evProtPrice !== null && protBar !== null) {
                const pType: 'high' | 'low' = isBullEv ? 'low' : 'high';
                const pKey = `${protBar}|${params.confirmationBar}|${pType}`;
                const knownPrice = knownPivotPriceByKey.get(pKey);
                if (knownPrice !== undefined) {
                    if (knownPrice !== evProtPrice) {
                        throw new Error('PHL Indicator Error: conflicting pivot price for matching deduplication key.');
                    }
                } else {
                    knownPivotPriceByKey.set(pKey, evProtPrice);
                    preparedPivots.push({
                        barIndex: protBar,
                        confirmedBarIndex: params.confirmationBar,
                        price: evProtPrice,
                        type: pType
                    });
                }
                simTrailPrice = evProtPrice;
                simTrailDir = dir;
            }

            if (params.targetReset === 'MSS & BOS' || breakType === 'MSS' || !simActiveTarget) {
                if (simActiveTarget) {
                    preparedClosedTargets.push({ ...simActiveTarget, endBar: params.confirmationBar, hit: false });
                }
                simActiveTarget = {
                    startBar: params.confirmationBar,
                    price: targetPrice,
                    entryPrice: brokenPrice,
                    stepNum: 1,
                    dir
                };
            }
        }

        // Pure commit phase: appends precomputed objects only (no caller-object property reads or validation)
        const origCachedLen = params.cachedEvents.length;
        const origPivotsLen = params.confirmedPivots.length;
        const origTargetsLen = params.targetSegments.length;

        try {
            for (const item of preparedCachedEvents) {
                params.cachedEvents.push(item);
            }
            for (const item of preparedPivots) {
                params.confirmedPivots.push(item);
            }
            for (const item of preparedClosedTargets) {
                params.targetSegments.push(item);
            }
        } catch (commitErr) {
            params.cachedEvents.length = origCachedLen;
            params.confirmedPivots.length = origPivotsLen;
            params.targetSegments.length = origTargetsLen;
            throw commitErr;
        }

        return { activeTarget: simActiveTarget, curTrailPrice: simTrailPrice, curTrailDir: simTrailDir };
    }

    public calculate(ds: DataStore): void {
        const len = ds.length;
        if (len === 0) return;
        this.ensureCapacity(len);

        const pivotStrength = Math.max(1, Math.round(this.getParam<number>('pivotStrength', 8)));
        const useValidPullbacks = this.getParam<boolean>('useValidPullbacks', true);
        const extraValidPullbacks = this.getParam<boolean>('extraValidPullbacks', false);
        const targetReset = this.getParam<string>('targetReset', 'MSS & BOS');
        const targetTrigger = this.getParam<string>('targetTrigger', 'Close Only');
        const targetAtrLen = Math.max(2, Math.round(this.getParam<number>('targetAtrLen', 14)));
        const targetStepMult = Math.max(0.1, this.getParam<number>('targetStepMult', 2.0));
        const chartTfMs = (len >= 2 && ds.data[6] > ds.data[0]) ? (ds.data[6] - ds.data[0]) : 60_000;
        const tfMs = this.getEffectiveTfMs(chartTfMs);
        const isHTF = tfMs > chartTfMs;
        const discThresholdMs = Math.max(300_000, tfMs * 5);

        const lastBase = (len - 1) * 6;
        const rev = (ds as any).revision ?? 0;
        const hash = `${this.currentSymbol}:${chartTfMs}:${tfMs}:${pivotStrength}:${useValidPullbacks}:${extraValidPullbacks}:${targetReset}:${targetTrigger}:${targetAtrLen}:${targetStepMult}:${len}:${rev}:${ds.data[0]}:${ds.data[lastBase]}:${ds.data[lastBase + 4]}`;
        if (this.lastStateHash === hash && this.lastCalculatedLength === len) return;

        this.cachedEvents = [];
        this.confirmedPivots = [];
        this.targetSegments = [];
        this.trailPrices.fill(0, 0, len);
        this.trailDirs.fill(0, 0, len);
        this.bullStates.fill(0, 0, len);
        this.discontinuityBreaks.fill(0, 0, len);

        if (isHTF) {
            interface HtfPhlBucket {
                time: number;
                open: number;
                high: number;
                low: number;
                close: number;
                volume: number;
                firstChartBar: number;
                lastChartBar: number;
                peakChartBar: number;
                troughChartBar: number;
                barCount: number;
                isCorrupt: boolean;
            }
            const htfCfg = {
                ...createDefaultPHLConfig(this.currentSymbol, `${Math.round(tfMs / 60_000)}m`, tfMs),
                pivotStrength,
                useValidPullbacks,
                extraValidPullbacks
            };
            const expectedPerBucket = tfMs / chartTfMs; // Guaranteed positive integer by getEffectiveTfMs

            let phlState = createInitialPHLState();
            let htfAtrState: ATRPeriodState | undefined;
            let chartTargetAtrState: ATRPeriodState | undefined;
            let prevChartClose: number | null = null;
            let prevHtfClose: number | null = null;
            let prevChartTime = -1;
            let prevBucketTime = -1;
            let htfIdx = 0;
            const anchors = new Map<number, { peak: number; trough: number }>();

            let curTrailPrice = 0;
            let curTrailDir: 1 | -1 | 0 = 0;
            let activeTarget: { startBar: number; price: number; entryPrice: number; stepNum: number; dir: 1 | -1 } | null = null;
            let activeBucket: HtfPhlBucket | null = null;

            const resetAllHtfState = (resetEndBar: number) => {
                phlState = createInitialPHLState();
                htfAtrState = undefined;
                prevHtfClose = null;
                htfIdx = 0;
                anchors.clear();
                curTrailPrice = 0;
                curTrailDir = 0;
                if (activeTarget) {
                    this.targetSegments.push({ ...activeTarget, endBar: Math.max(activeTarget.startBar, resetEndBar), hit: false });
                    activeTarget = null;
                }
            };

            const flushBucket = (b: HtfPhlBucket) => {
                const isComplete = !b.isCorrupt &&
                    b.barCount === expectedPerBucket &&
                    ds.data[b.lastChartBar * 6] === b.time + tfMs - chartTfMs;
                if (!isComplete) {
                    resetAllHtfState(b.lastChartBar);
                    return;
                }
                const isHtfDisc = prevBucketTime !== -1 && (b.time - prevBucketTime) >= discThresholdMs;
                if (isHtfDisc) {
                    this.discontinuityBreaks[b.firstChartBar] = 1;
                    resetAllHtfState(b.firstChartBar - 1);
                }
                prevBucketTime = b.time;
                anchors.set(htfIdx, { peak: b.peakChartBar, trough: b.troughChartBar });

                const isResetStep = isHtfDisc || htfIdx === 0;
                const atrRes = updateWilderATR(b.high, b.low, prevHtfClose, 14, htfAtrState, isResetStep);
                htfAtrState = atrRes.nextState;
                prevHtfClose = b.close;
                const atrVal = atrRes.isValid && atrRes.atrValue > 0 ? atrRes.atrValue : null;

                const step = stepPHL(
                    { time: b.time, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume },
                    htfIdx,
                    phlState,
                    htfCfg,
                    isResetStep,
                    atrVal,
                    null
                );
                phlState = step.nextState;
                htfIdx++;

                if (step.events.length > 0) {
                    const atr14Valid = atrVal !== null;
                    for (const ev of step.events) {
                        const isBullEv = ev.eventDirection === 'bull';
                        const srcA = anchors.get(ev.sourceBarIndex);
                        const mappedSrcBar = srcA ? (isBullEv ? srcA.peak : srcA.trough) : b.firstChartBar;

                        const protSlot = isBullEv ? step.activeProtectedLow : step.activeProtectedHigh;
                        const pa = protSlot ? anchors.get(protSlot.barIndex) : undefined;
                        const protBar = protSlot ? (pa ? (isBullEv ? pa.trough : pa.peak) : b.lastChartBar) : null;
                        const protTime = protBar !== null ? ds.data[protBar * 6] : null;
                        const distProtAtr = protSlot && atr14Valid
                            ? (isBullEv ? (b.close - protSlot.price) / atrVal! : (protSlot.price - b.close) / atrVal!)
                            : null;

                        this.cachedEvents.push({
                            ...ev,
                            sourceBarIndex: mappedSrcBar,
                            sourceTimestamp: ds.data[mappedSrcBar * 6],
                            confirmationBarIndex: b.lastChartBar,
                            confirmationTimestamp: ds.data[b.lastChartBar * 6],
                            structuralContext: {
                                ...ev.structuralContext,
                                hasProtectedLevel: protSlot !== null,
                                protectedLevelPrice: protSlot ? protSlot.price : (null as any),
                                protectedLevelBarIndex: protBar as any,
                                protectedLevelTimestamp: protTime as any,
                                atr14Valid,
                                distToProtectedAtr: distProtAtr as any
                            }
                        });

                        const brokenPrice = Number(ev.structuralContext['brokenLevelPrice']);
                        if (isBullEv && step.activeProtectedLow && protBar !== null) {
                            this.confirmedPivots.push({ barIndex: protBar, confirmedBarIndex: b.lastChartBar, price: step.activeProtectedLow.price, type: 'low' });
                            curTrailPrice = step.activeProtectedLow.price;
                            curTrailDir = 1;
                        } else if (!isBullEv && step.activeProtectedHigh && protBar !== null) {
                            this.confirmedPivots.push({ barIndex: protBar, confirmedBarIndex: b.lastChartBar, price: step.activeProtectedHigh.price, type: 'high' });
                            curTrailPrice = step.activeProtectedHigh.price;
                            curTrailDir = -1;
                        }

                        const isMss = ev.structuralContext['breakType'] === 'MSS';
                        if (targetReset === 'MSS & BOS' || isMss || !activeTarget) {
                            if (activeTarget) this.targetSegments.push({ ...activeTarget, endBar: b.lastChartBar, hit: false });
                            const dir: 1 | -1 = isBullEv ? 1 : -1;
                            const stepAtr = atrVal ?? (b.high - b.low);
                            activeTarget = { startBar: b.lastChartBar, price: brokenPrice + dir * stepAtr * targetStepMult, entryPrice: brokenPrice, stepNum: 1, dir };
                        }
                    }
                }

                // Prune anchors strictly older than any active PHL reference or retained window bar
                const keepMin: number[] = [];
                if (phlState.window.length > 0) keepMin.push(phlState.window[0].barIndex);
                if (phlState.ph) keepMin.push(phlState.ph.barIndex);
                if (phlState.pl) keepMin.push(phlState.pl.barIndex);
                if (phlState.trackHighIdx !== null) keepMin.push(phlState.trackHighIdx);
                if (phlState.trackLowIdx !== null) keepMin.push(phlState.trackLowIdx);
                if (phlState.lastHighIdx !== null) keepMin.push(phlState.lastHighIdx);
                if (phlState.lastLowIdx !== null) keepMin.push(phlState.lastLowIdx);
                const minKeep = keepMin.length > 0 ? Math.min(...keepMin) : htfIdx;
                for (const k of anchors.keys()) {
                    if (k < minKeep) anchors.delete(k);
                }
            };

            for (let i = 0; i < len; i++) {
                const base = i * 6;
                const t = ds.data[base], o = ds.data[base + 1], h = ds.data[base + 2], l = ds.data[base + 3], c = ds.data[base + 4], v = ds.data[base + 5];
                const validOhlcv = Number.isFinite(t) && t >= 0 && Number.isFinite(o) && o > 0 && Number.isFinite(h) && h > 0 &&
                    Number.isFinite(l) && l > 0 && Number.isFinite(c) && c > 0 && Number.isFinite(v) && v >= 0 &&
                    h >= l && h >= Math.max(o, c) && l <= Math.min(o, c);
                if (!validOhlcv || (prevChartTime !== -1 && t <= prevChartTime)) {
                    if (activeBucket !== null) activeBucket.isCorrupt = true;
                    resetAllHtfState(i - 1);
                    this.trailPrices[i] = 0;
                    this.trailDirs[i] = 0;
                    this.bullStates[i] = 0;
                    continue;
                }

                const missingRaw = prevChartTime !== -1 && t !== prevChartTime + chartTfMs;
                prevChartTime = t;

                const tAtrRes = updateWilderATR(h, l, prevChartClose, targetAtrLen, chartTargetAtrState, missingRaw);
                chartTargetAtrState = tAtrRes.nextState;
                prevChartClose = c;
                const chartStepAtr = (tAtrRes.isValid && tAtrRes.atrValue > 0 ? tAtrRes.atrValue : null) ?? (h - l);

                const bStart = TimeframeResampler.getBucketStart(t, tfMs);
                if (activeBucket !== null && bStart !== activeBucket.time) {
                    flushBucket(activeBucket);
                    activeBucket = null;
                }
                if (missingRaw) {
                    this.discontinuityBreaks[i] = 1;
                    resetAllHtfState(i - 1);
                    activeBucket = t === bStart
                        ? { time: bStart, open: o, high: h, low: l, close: c, volume: v, firstChartBar: i, lastChartBar: i, peakChartBar: i, troughChartBar: i, barCount: 1, isCorrupt: false }
                        : null;
                } else if (activeBucket === null) {
                    if (t === bStart) {
                        activeBucket = { time: bStart, open: o, high: h, low: l, close: c, volume: v, firstChartBar: i, lastChartBar: i, peakChartBar: i, troughChartBar: i, barCount: 1, isCorrupt: false };
                    }
                } else {
                    if (h > activeBucket.high) { activeBucket.high = h; activeBucket.peakChartBar = i; }
                    if (l < activeBucket.low) { activeBucket.low = l; activeBucket.troughChartBar = i; }
                    activeBucket.close = c;
                    activeBucket.volume += v;
                    activeBucket.lastChartBar = i;
                    activeBucket.barCount++;
                }

                if (activeBucket !== null && activeBucket.barCount === expectedPerBucket && t === bStart + tfMs - chartTfMs) {
                    flushBucket(activeBucket);
                    activeBucket = null;
                } else if (activeTarget && i > activeTarget.startBar) {
                    const hit = targetTrigger === 'Wick (High/Low)'
                        ? (activeTarget.dir === 1 ? h >= activeTarget.price : l <= activeTarget.price)
                        : (activeTarget.dir === 1 ? c >= activeTarget.price : c <= activeTarget.price);
                    if (hit) {
                        this.targetSegments.push({ ...activeTarget, endBar: i, hit: true });
                        activeTarget = {
                            startBar: i,
                            price: activeTarget.price + activeTarget.dir * chartStepAtr * targetStepMult,
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
            return;
        }

        const intervalMs = chartTfMs;
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
                const applied = ProtectedHighsLowsIndicator.applyBarEvents({
                    events: step.events,
                    activeProtectedLow: step.activeProtectedLow,
                    activeProtectedHigh: step.activeProtectedHigh,
                    confirmationBar: i,
                    closePrice: c,
                    atrVal,
                    stepAtr,
                    targetReset,
                    targetStepMult,
                    cachedEvents: this.cachedEvents,
                    confirmedPivots: this.confirmedPivots,
                    targetSegments: this.targetSegments,
                    activeTarget,
                    curTrailPrice,
                    curTrailDir
                });
                activeTarget = applied.activeTarget;
                curTrailPrice = applied.curTrailPrice;
                curTrailDir = applied.curTrailDir;
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
