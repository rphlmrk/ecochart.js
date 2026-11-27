import { ML1_CONFIG_D, ML1_CONFIG_D_3M, ML1_CONFIG_D_5M, ML1_CONFIG_D_VERSION } from '../ML1FeatureConfigs';
import {
    createInitialML1FeatureStateV6,
    stepML1FeaturesV6,
    validateML1ConfigV6
} from '../ML1FeatureEngine';
import type {
    ML1Candle,
    ML1FeatureStateV6,
    ML1Observation,
    ValidatedML1FeatureConfigV6
} from '../ML1FeatureTypes';
import { validateV4MTFConfig, type ValidatedV4MTFGlobalConfig } from '../mtf/MTFConfig';
import { createInitialV4MTFState } from '../mtf/MTFState';
import { stepV4MTFCombined } from '../mtf/MTFFeatureEngine';
import { alignV4MTFContext } from '../mtf/MTFAligner';
import type { V4HTFIncompleteDiagnostic, V4MTFState, V4MTFTimeframeContext } from '../mtf/MTFTypes';
import {
    createInitialBackboneStats,
    extractDataQuality,
    generateObservationId,
    processSourceObservation,
    validateCandleOhlcv,
    type BackboneStats,
    type RawSourceTimestampBounds
} from '../dataset/ObservationBackbone';
import type { DataQualityStatus } from '../dataset/DatasetTypes';
import type { IntegrityPolicy } from '../dataset/DatasetConfig';
import type { StrictCBCState, StrictZigZagPivot } from '../../plugins/StrictCBCZigZagIndicator';
import {
    adaptStrictCBCtoStrategyEvent,
    adaptVAMtoStrategyEvent,
    stepStrictCBCWithReset
} from '../teachers/StrategyEventTypes';
import {
    createDefaultPHLV4MultiConfigs,
    createInitialPHLV4MultiState,
    stepPHLV4Multi,
    V4_PHL_TIMEFRAMES,
    type PHLTimeframe,
    type PHLV4Config,
    type PHLV4MultiState,
    type PHLV4TeacherEvent
} from '../teachers/ProtectedHighsLowsTeacher';
import {
    createDefaultV4DTFXStrictCBCMultiConfigs,
    createInitialDTFXStrictCBCMultiState,
    stepDTFXStrictCBCMulti,
    V4_DTFX_STRICTCBC_TIMEFRAMES,
    type DTFXStrictCBCConfig,
    type DTFXStrictCBCMultiState,
    type DTFXStrictCBCTeacherEvent,
    type V4DTFXStrictCBCTimeframe
} from '../teachers/DTFXStrictCBCTeacher';
import { createInitialVAMState, stepVolatilityAdjustedMean } from '../trend/VolatilityAdjustedMean';
import {
    assertV4RepresentationZeroTierCLeakage,
    V4_DATASET_VERSION,
    V4_REPRESENTATION_COLUMNS,
    V4MultiHorizonOutcomeTracker,
    type V4OutcomeAccounting,
    type V4PipelineStrategyEvent,
    type V4PipelineStrategyId,
    type V4StrategyEventRow,
    type V4TierAAtConfirmation
} from './V4OutcomeContracts';

export const V4_3M5M_MTF_VERSION = 'M4_3M5M_v1';

function encodeLen(raw: string): string {
    return `${raw.length}:${raw}`;
}

function buildV4EventId(params: {
    readonly strategyId: V4PipelineStrategyId;
    readonly strategyVersion: string;
    readonly symbol: string;
    readonly timeframe: string;
    readonly eventType: string;
    readonly sourceBarIndex: number;
    readonly confirmationBarIndex: number;
    readonly eventDiscriminator: string;
}): string {
    return `SE1|${[
        params.strategyId,
        params.strategyVersion,
        params.symbol,
        params.timeframe,
        params.eventType,
        String(params.sourceBarIndex),
        String(params.confirmationBarIndex),
        params.eventDiscriminator
    ].map(encodeLen).join('|')}`;
}

function adaptDTFXStrictCBCV4(ev: DTFXStrictCBCTeacherEvent, intervalMs: number): V4PipelineStrategyEvent {
    const observationTimestamp = ev.confirmationTimestamp + intervalMs;
    return Object.freeze({
        eventId: buildV4EventId(ev),
        eventDiscriminator: ev.eventDiscriminator,
        strategyId: 'DTFX_STRICTCBC' as const,
        strategyVersion: ev.strategyVersion,
        eventType: ev.eventType,
        eventDirection: ev.eventDirection,
        sourceBarIndex: ev.sourceBarIndex,
        sourceTimestamp: ev.sourceTimestamp,
        confirmationBarIndex: ev.confirmationBarIndex,
        confirmationTimestamp: ev.confirmationTimestamp,
        confirmationLagBars: ev.confirmationBarIndex - ev.sourceBarIndex,
        observationBarIndex: ev.confirmationBarIndex,
        observationTimestamp,
        entryBarIndex: ev.confirmationBarIndex + 1,
        entryTimestamp: null,
        structuralContext: Object.freeze({ ...ev.structuralContext })
    });
}

function adaptPHLV4(ev: PHLV4TeacherEvent, intervalMs: number): V4PipelineStrategyEvent {
    const observationTimestamp = ev.confirmationTimestamp + intervalMs;
    return Object.freeze({
        eventId: buildV4EventId(ev),
        eventDiscriminator: ev.eventDiscriminator,
        strategyId: 'PHL_BOS_MSS' as const,
        strategyVersion: ev.strategyVersion,
        eventType: ev.eventType,
        eventDirection: ev.eventDirection,
        sourceBarIndex: ev.sourceBarIndex,
        sourceTimestamp: ev.sourceTimestamp,
        confirmationBarIndex: ev.confirmationBarIndex,
        confirmationTimestamp: ev.confirmationTimestamp,
        confirmationLagBars: ev.confirmationBarIndex - ev.sourceBarIndex,
        observationBarIndex: ev.confirmationBarIndex,
        observationTimestamp,
        entryBarIndex: ev.confirmationBarIndex + 1,
        entryTimestamp: null,
        structuralContext: Object.freeze({ ...ev.structuralContext })
    });
}

function compareAscii(a: string, b: string): number {
    return a < b ? -1 : a > b ? 1 : 0;
}

function sortAndVerifyUniqueV4Events(events: readonly V4PipelineStrategyEvent[]): readonly V4PipelineStrategyEvent[] {
    const seen = new Set<string>();
    for (const ev of events) {
        if (!ev || typeof ev.eventId !== 'string' || ev.eventId.trim() === '') {
            throw new Error('V4Pipeline Event Uniqueness Error: missing eventId.');
        }
        if (seen.has(ev.eventId)) {
            throw new Error(`V4Pipeline Event Collision Error: duplicate eventId '${ev.eventId}'.`);
        }
        seen.add(ev.eventId);
    }
    return Object.freeze(
        [...events].sort((a, b) =>
            a.confirmationBarIndex - b.confirmationBarIndex ||
            compareAscii(a.strategyId, b.strategyId) ||
            compareAscii(a.eventType, b.eventType) ||
            compareAscii(a.eventId, b.eventId)
        )
    );
}

export interface V4PipelineConfig {
    readonly symbol: string;
    readonly interval: string;
    readonly intervalMs: number;
    readonly requireContiguous: boolean;
    readonly featureConfig: ValidatedML1FeatureConfigV6;
    readonly mtfConfig: ValidatedV4MTFGlobalConfig | null;
    readonly phlTimeframes: readonly PHLTimeframe[];
    readonly phlConfigs: readonly PHLV4Config[];
    readonly dtfxStrictCbcTimeframes: readonly V4DTFXStrictCBCTimeframe[];
    readonly dtfxStrictCbcConfigs: readonly DTFXStrictCBCConfig[];
    readonly integrityPolicy: IntegrityPolicy;
    readonly sourceTimestampBounds?: RawSourceTimestampBounds;
}

export interface V4PipelineBarStepOutput {
    readonly acceptedBarIndex: number;
    readonly observationId: string;
    readonly sourceTimestamp: number;
    readonly observationTimestamp: number;
    readonly candle: ML1Candle;
    readonly dataQuality: DataQualityStatus;
    readonly observation: ML1Observation;
    readonly context3m: V4MTFTimeframeContext | null;
    readonly htf3mDiagnostic: V4HTFIncompleteDiagnostic | null;
    readonly context5m: V4MTFTimeframeContext | null;
    readonly htf5mDiagnostic: V4HTFIncompleteDiagnostic | null;
    readonly confirmedEvents: readonly V4PipelineStrategyEvent[];
    readonly resolvedPreviousBarEvents: readonly V4PipelineStrategyEvent[];
    readonly completedOutcomeRows: readonly V4StrategyEventRow[];
}

export function createV4PipelineConfig(params: {
    readonly symbol: string;
    readonly interval: string;
    readonly intervalMs: number;
    readonly include3m5mMtf?: boolean;
    readonly phlTimeframes?: readonly PHLTimeframe[];
    readonly dtfxStrictCbcTimeframes?: readonly V4DTFXStrictCBCTimeframe[];
    readonly requireContiguous?: boolean;
    readonly sourceTimestampBounds?: RawSourceTimestampBounds;
}): V4PipelineConfig {
    const { symbol, interval, intervalMs } = params;
    if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
        throw new Error(`V4PipelineConfig Error: intervalMs must be positive safe integer, got ${intervalMs}.`);
    }
    assertV4RepresentationZeroTierCLeakage(V4_REPRESENTATION_COLUMNS);

    const is1m = interval === '1m';
    const featureConfig = validateML1ConfigV6({
        ...ML1_CONFIG_D,
        symbol,
        timeframe: interval,
        expectedIntervalMs: intervalMs,
        gapDiscontinuityThresholdMs: Math.max(ML1_CONFIG_D.gapDiscontinuityThresholdMs, intervalMs * 5),
        emaPeriods: [...ML1_CONFIG_D.emaPeriods],
        atrPeriods: [...ML1_CONFIG_D.atrPeriods],
        rollingRangePeriods: [...ML1_CONFIG_D.rollingRangePeriods],
        momentumPeriods: [...ML1_CONFIG_D.momentumPeriods],
        volumeSmaPeriods: [...ML1_CONFIG_D.volumeSmaPeriods],
        cciPeriods: [...ML1_CONFIG_D.cciPeriods],
        volumeCandleSizePeriods: is1m ? [...ML1_CONFIG_D.volumeCandleSizePeriods] : [],
        enableVAM: ML1_CONFIG_D.enableVAM,
        smaPeriods: [...ML1_CONFIG_D.smaPeriods],
        enableMACD: ML1_CONFIG_D.enableMACD,
        bbPeriod: ML1_CONFIG_D.bbPeriod,
        bbStdMult: ML1_CONFIG_D.bbStdMult
    });

    const enable3m5mMtf = params.include3m5mMtf ?? is1m;
    if (enable3m5mMtf && (!is1m || intervalMs !== 60_000)) {
        throw new Error(`V4PipelineConfig Error: 3m/5m MTF requires '1m' (60000ms) base interval, got '${interval}'.`);
    }

    const mtfConfig: ValidatedV4MTFGlobalConfig | null = enable3m5mMtf
        ? validateV4MTFConfig({
              symbol,
              baseTimeframe: '1m',
              config3m: {
                  timeframe: '3m',
                  durationMs: 180_000,
                  alignment: 'UTC_HALF_OPEN',
                  expectedSourceIntervalMs: 60_000,
                  gapPolicy: 'REJECT_AND_RESET',
                  featureConfig: validateML1ConfigV6({
                      ...ML1_CONFIG_D_3M,
                      symbol,
                      emaPeriods: [...ML1_CONFIG_D_3M.emaPeriods],
                      atrPeriods: [...ML1_CONFIG_D_3M.atrPeriods],
                      rollingRangePeriods: [...ML1_CONFIG_D_3M.rollingRangePeriods],
                      momentumPeriods: [...ML1_CONFIG_D_3M.momentumPeriods],
                      volumeSmaPeriods: [...ML1_CONFIG_D_3M.volumeSmaPeriods],
                      cciPeriods: [...ML1_CONFIG_D_3M.cciPeriods],
                      volumeCandleSizePeriods: [],
                      smaPeriods: [...ML1_CONFIG_D_3M.smaPeriods]
                  })
              },
              config5m: {
                  timeframe: '5m',
                  durationMs: 300_000,
                  alignment: 'UTC_HALF_OPEN',
                  expectedSourceIntervalMs: 60_000,
                  gapPolicy: 'REJECT_AND_RESET',
                  featureConfig: validateML1ConfigV6({
                      ...ML1_CONFIG_D_5M,
                      symbol,
                      emaPeriods: [...ML1_CONFIG_D_5M.emaPeriods],
                      atrPeriods: [...ML1_CONFIG_D_5M.atrPeriods],
                      rollingRangePeriods: [...ML1_CONFIG_D_5M.rollingRangePeriods],
                      momentumPeriods: [...ML1_CONFIG_D_5M.momentumPeriods],
                      volumeSmaPeriods: [...ML1_CONFIG_D_5M.volumeSmaPeriods],
                      cciPeriods: [...ML1_CONFIG_D_5M.cciPeriods],
                      volumeCandleSizePeriods: [],
                      smaPeriods: [...ML1_CONFIG_D_5M.smaPeriods]
                  })
              }
          })
        : null;

    if (!is1m || intervalMs !== 60_000) {
        throw new Error(`V4PipelineConfig Error: V4 multi-timeframe PHL & DTFXStrictCBC require '1m' (60000ms) base interval.`);
    }

    const phlTimeframes = Object.freeze([...(params.phlTimeframes ?? V4_PHL_TIMEFRAMES)]);
    const phlConfigs = Object.freeze(createDefaultPHLV4MultiConfigs(symbol, interval, intervalMs, phlTimeframes, { pivotStrength: 8 }));

    const dtfxStrictCbcTimeframes = Object.freeze([...(params.dtfxStrictCbcTimeframes ?? V4_DTFX_STRICTCBC_TIMEFRAMES)]);
    const dtfxStrictCbcConfigs = Object.freeze(createDefaultV4DTFXStrictCBCMultiConfigs(symbol, interval, intervalMs, dtfxStrictCbcTimeframes));

    const requireContiguous = params.requireContiguous ?? true;

    return Object.freeze({
        symbol,
        interval,
        intervalMs,
        requireContiguous,
        featureConfig,
        mtfConfig,
        phlTimeframes,
        phlConfigs,
        dtfxStrictCbcTimeframes,
        dtfxStrictCbcConfigs,
        integrityPolicy: Object.freeze({
            rejectInvalidSource: true,
            rejectInvalidOhlcv: true,
            rejectDuplicateTimestamp: true,
            rejectOutOfOrder: true,
            requireMinimumUptimeFraction: requireContiguous ? 1.0 : undefined
        }),
        sourceTimestampBounds: params.sourceTimestampBounds
    });
}

export function getV4FeatureConfigVersion(config: V4PipelineConfig): string {
    return config.mtfConfig !== null
        ? `${ML1_CONFIG_D_VERSION}+${V4_3M5M_MTF_VERSION}`
        : ML1_CONFIG_D_VERSION;
}

export class V4PipelineRunner {
    public readonly config: V4PipelineConfig;
    private stats: BackboneStats = createInitialBackboneStats();
    private featureState: ML1FeatureStateV6;
    private mtfState: V4MTFState | null;
    private cbcState: StrictCBCState | null = null;
    private lastCbcPivot: StrictZigZagPivot | null = null;
    private phlMultiState: PHLV4MultiState = createInitialPHLV4MultiState();
    private dtfxStrictCbcState: DTFXStrictCBCMultiState = createInitialDTFXStrictCBCMultiState();
    private vamTeacherState = createInitialVAMState();
    private readonly outcomeTracker: V4MultiHorizonOutcomeTracker;

    private acceptedCount = 0;
    private gridAnchor: number | null;
    private prevAcceptedTs = -1;
    private lastConfirmationBar = -1;
    private pendingEntryResolutionEvents: readonly V4PipelineStrategyEvent[] = Object.freeze([]);
    private htf3mGapCount = 0;
    private htf3mResetCount = 0;
    private htf3mIncompleteWindowCount = 0;
    private htf5mGapCount = 0;
    private htf5mResetCount = 0;
    private htf5mIncompleteWindowCount = 0;

    public constructor(config: V4PipelineConfig) {
        this.config = config;
        this.outcomeTracker = new V4MultiHorizonOutcomeTracker(config.requireContiguous);
        this.featureState = createInitialML1FeatureStateV6(config.featureConfig);
        this.mtfState = config.mtfConfig ? createInitialV4MTFState(config.mtfConfig) : null;
        this.gridAnchor = config.sourceTimestampBounds?.startTimestamp ?? null;
    }

    public getStats(): BackboneStats {
        return this.stats;
    }

    public getAcceptedCount(): number {
        return this.acceptedCount;
    }

    public getHtfStats() {
        return Object.freeze({
            htf3mGapCount: this.htf3mGapCount,
            htf3mResetCount: this.htf3mResetCount,
            htf3mIncompleteWindowCount: this.htf3mIncompleteWindowCount,
            htf5mGapCount: this.htf5mGapCount,
            htf5mResetCount: this.htf5mResetCount,
            htf5mIncompleteWindowCount: this.htf5mIncompleteWindowCount
        });
    }

    public stepCandle(rawCandle: ML1Candle): V4PipelineBarStepOutput {
        const barIndex = this.acceptedCount;
        const { symbol, interval, intervalMs } = this.config;

        if (!Number.isSafeInteger(rawCandle.time) || rawCandle.time < 1e12 || !validateCandleOhlcv(rawCandle)) {
            throw new Error(`V4 Source Integrity Error: invalid OHLCV or timestamp at bar ${barIndex} (time=${rawCandle.time}).`);
        }

        const anchor = this.gridAnchor ?? rawCandle.time;
        this.gridAnchor = anchor;
        const isOnGrid = (rawCandle.time - anchor) % intervalMs === 0;
        const bounds = this.config.sourceTimestampBounds;
        const isWithinRange =
            bounds === undefined || (rawCandle.time >= bounds.startTimestamp && rawCandle.time <= bounds.endTimestamp);

        if (!isOnGrid || !isWithinRange) {
            throw new Error(`V4 Source Integrity Error: off-grid or out-of-range candle at bar ${barIndex}.`);
        }
        if (this.prevAcceptedTs !== -1) {
            const deltaMs = rawCandle.time - this.prevAcceptedTs;
            if (deltaMs <= 0) {
                throw new Error(`V4 Source Integrity Error: duplicate or out-of-order candle at bar ${barIndex}.`);
            }
            if (this.config.requireContiguous && deltaMs !== intervalMs) {
                throw new Error(`V4 Source Integrity Error: non-contiguous candle at bar ${barIndex}.`);
            }
        }
        this.prevAcceptedTs = rawCandle.time;

        const candle: ML1Candle = Object.freeze({
            time: rawCandle.time,
            open: rawCandle.open,
            high: rawCandle.high,
            low: rawCandle.low,
            close: rawCandle.close,
            volume: rawCandle.volume,
            isSynthetic: false as const
        });

        // 1. Tier A (ML1_CONFIG_D_v1, stateVersion: 6)
        const featStep = stepML1FeaturesV6(candle, barIndex, this.featureState, this.config.featureConfig);
        this.featureState = featStep.nextState;
        const obs = featStep.observation;

        const dataQuality = extractDataQuality(obs);
        const backboneStep = processSourceObservation(
            this.stats,
            candle.time,
            dataQuality,
            true,
            this.config.integrityPolicy,
            intervalMs,
            { isUniqueSource: true, isCandidateUniqueAccepted: true },
            { gridAnchor: anchor, isOnGrid, isWithinRange }
        );
        this.stats = backboneStep.nextStats;
        if (!backboneStep.acceptance.isAccepted) {
            throw new Error(`V4 Backbone Error: rejected candle at bar ${barIndex}: ${backboneStep.acceptance.rejectionReasons.join(', ')}`);
        }

        const observationId = generateObservationId(symbol, interval, candle.time, V4_DATASET_VERSION);
        const isDiscontinuity = obs.features['IsDiscontinuity'] === 1;

        // 2. 3m & 5m MTF Context (zero 15m/1h)
        let context3m: V4MTFTimeframeContext | null = null;
        let htf3mDiagnostic: V4HTFIncompleteDiagnostic | null = null;
        let context5m: V4MTFTimeframeContext | null = null;
        let htf5mDiagnostic: V4HTFIncompleteDiagnostic | null = null;

        if (this.mtfState !== null && this.config.mtfConfig !== null) {
            const combined = stepV4MTFCombined(candle, true, this.mtfState, this.config.mtfConfig, barIndex);
            this.mtfState = combined.nextState;
            if (combined.diagnostic3m !== null) {
                if (combined.diagnostic3m.completeness === 'INCOMPLETE_MISSING') {
                    this.htf3mGapCount++;
                }
                this.htf3mResetCount++;
                this.htf3mIncompleteWindowCount++;
            }
            if (combined.diagnostic5m !== null) {
                if (combined.diagnostic5m.completeness === 'INCOMPLETE_MISSING') {
                    this.htf5mGapCount++;
                }
                this.htf5mResetCount++;
                this.htf5mIncompleteWindowCount++;
            }
            htf3mDiagnostic = this.mtfState.state3m.aggregation.lastDiagnostic;
            htf5mDiagnostic = this.mtfState.state5m.aggregation.lastDiagnostic;
            const aligned = alignV4MTFContext(
                backboneStep.observationTimestamp,
                symbol,
                this.mtfState,
                this.config.mtfConfig
            );
            context3m = aligned.context3m;
            context5m = aligned.context5m;
        }

        // 3. Resolve prior bar's pending events + advance outcome tracker
        const resolvedPreviousBarEvents: V4PipelineStrategyEvent[] = [];
        for (const prevEv of this.pendingEntryResolutionEvents) {
            if (prevEv.entryBarIndex !== barIndex || candle.time <= prevEv.confirmationTimestamp) {
                throw new Error(`V4Pipeline Chronology Error on '${prevEv.eventId}'.`);
            }
            resolvedPreviousBarEvents.push(Object.freeze({ ...prevEv, entryTimestamp: candle.time }));
        }

        const completedOutcomeRows = this.outcomeTracker.stepBar(barIndex, candle);

        // 4. Step all 4 V4 Teachers (STRICT_CBC, PHL_BOS_MSS [1m/3m/5m], DTFX_STRICTCBC [1m/3m/5m], VAM_REVERSAL)
        const rawBarEvents: V4PipelineStrategyEvent[] = [];
        const atr14 = obs.features['ATR_14'];
        const atrValid = obs.validity['ATR_14'] === true && Number.isFinite(atr14) && atr14 > 0;
        const atrForContext = atrValid ? atr14 : null;

        // 4a. StrictCBC
        const cbcStep = stepStrictCBCWithReset(candle, barIndex, this.cbcState, this.lastCbcPivot, isDiscontinuity);
        this.cbcState = cbcStep.nextState;
        this.lastCbcPivot = cbcStep.nextPrevPivot;
        if (cbcStep.confirmedPivot) {
            rawBarEvents.push(
                adaptStrictCBCtoStrategyEvent({
                    pivot: cbcStep.confirmedPivot,
                    prevPivot: cbcStep.prevPivotForEvent,
                    confirmationTimestamp: candle.time,
                    entryTimestamp: null,
                    atr14AtConfirmation: atrForContext,
                    symbol,
                    timeframe: interval,
                    intervalMs
                }) as unknown as V4PipelineStrategyEvent
            );
        }

        // 4b. PHL BOS/MSS (1m, 3m, 5m, pivotStrength=8)
        const phlStep = stepPHLV4Multi(candle, barIndex, this.phlMultiState, this.config.phlConfigs, isDiscontinuity, atrForContext);
        this.phlMultiState = phlStep.nextState;
        for (const pev of phlStep.events) {
            rawBarEvents.push(adaptPHLV4(pev, intervalMs));
        }

        // 4c. DTFX StrictCBC (1m, 3m, 5m)
        const dtfxStep = stepDTFXStrictCBCMulti(candle, barIndex, this.dtfxStrictCbcState, this.config.dtfxStrictCbcConfigs, isDiscontinuity, atrForContext);
        this.dtfxStrictCbcState = dtfxStep.nextState;
        for (const dev of dtfxStep.events) {
            rawBarEvents.push(adaptDTFXStrictCBCV4(dev, intervalMs));
        }

        // 4d. VAM Reversal
        const vamOut = stepVolatilityAdjustedMean(candle.high, candle.low, candle.close, this.vamTeacherState, isDiscontinuity);
        this.vamTeacherState = vamOut.nextState;
        const vamEv = adaptVAMtoStrategyEvent({
            vamOutput: vamOut,
            confirmationBarIndex: barIndex,
            confirmationTimestamp: candle.time,
            entryTimestamp: null,
            symbol,
            timeframe: interval,
            intervalMs
        });
        if (vamEv) rawBarEvents.push(vamEv as unknown as V4PipelineStrategyEvent);

        if (barIndex <= this.lastConfirmationBar) {
            throw new Error(`V4Pipeline Chronology Error: non-monotonic barIndex ${barIndex}.`);
        }
        this.lastConfirmationBar = barIndex;
        const sortedBarEvents = sortAndVerifyUniqueV4Events(rawBarEvents);

        if (sortedBarEvents.length > 0) {
            const tierASnapshot: V4TierAAtConfirmation = Object.freeze({
                tierAObservationId: observationId,
                atr14: atrValid ? atr14 : 0,
                exhaustion14: obs.features['Exhaustion_14'] ?? 0,
                exhaustion14Valid: obs.validity['Exhaustion_14'] === true,
                exhaustion20: obs.features['Exhaustion_20'] ?? 0,
                exhaustion20Valid: obs.validity['Exhaustion_20'] === true,
                vcsRatio360: obs.features['VolumeCandleSize_Ratio_360'] ?? 0,
                vcsZScore360: obs.features['VolumeCandleSize_ZScore_360'] ?? 0,
                vcsRegime360: obs.features['VolumeCandleSize_Regime_360'] ?? 0,
                vcsValid: obs.validity['VolumeCandleSize_Ratio_360'] === true,
                vamCenterDistAtr: obs.features['VAM_Center_Dist_ATR'] ?? 0,
                vamSlope3Atr: obs.features['VAM_Slope_3_ATR'] ?? 0,
                vamEfficiency: obs.features['VAM_Efficiency'] ?? 0,
                vamAdx14: obs.features['VAM_ADX_14'] ?? 0,
                vamDiSpread14: obs.features['VAM_DI_Spread_14'] ?? 0,
                vamRsi14: obs.features['VAM_RSI_14'] ?? 0,
                vamTrend: obs.features['VAM_Trend'] ?? 0,
                vamValid: obs.validity['VAM_Signal'] === true,
                sma20DistAtr: obs.features['SMA_20_Distance'] ?? 0,
                sma50DistAtr: obs.features['SMA_50_Distance'] ?? 0,
                sma200DistAtr: obs.features['SMA_200_Distance'] ?? 0,
                sma20Above50: obs.features['SMA_20_Above_SMA_50'] ?? 0,
                sma50Above200: obs.features['SMA_50_Above_SMA_200'] ?? 0,
                smaValid:
                    obs.validity['SMA_20_Distance'] === true &&
                    obs.validity['SMA_50_Distance'] === true &&
                    obs.validity['SMA_200_Distance'] === true,
                macdLineAtr: obs.features['MACD_Line_ATR'] ?? 0,
                macdSignalAtr: obs.features['MACD_Signal_ATR'] ?? 0,
                macdHistAtr: obs.features['MACD_Hist_ATR'] ?? 0,
                macdValid: obs.validity['MACD_Signal_ATR'] === true,
                bbWidth20: obs.features['BB_Width_20'] ?? 0,
                bbPctB20: obs.features['BB_PctB_20'] ?? 0,
                bbValid: obs.validity['BB_Width_20'] === true,
                context3mAvailable: context3m?.isAvailable === true,
                context3mStatus: context3m?.availabilityStatus ?? 'UNAVAILABLE',
                context5mAvailable: context5m?.isAvailable === true,
                context5mStatus: context5m?.availabilityStatus ?? 'UNAVAILABLE'
            });
            this.outcomeTracker.enqueueEvents(sortedBarEvents, symbol, interval, tierASnapshot, atrValid);
        }

        this.pendingEntryResolutionEvents = sortedBarEvents;
        this.acceptedCount++;

        return {
            acceptedBarIndex: barIndex,
            observationId,
            sourceTimestamp: candle.time,
            observationTimestamp: backboneStep.observationTimestamp,
            candle,
            dataQuality,
            observation: obs,
            context3m,
            htf3mDiagnostic,
            context5m,
            htf5mDiagnostic,
            confirmedEvents: sortedBarEvents,
            resolvedPreviousBarEvents: Object.freeze(resolvedPreviousBarEvents),
            completedOutcomeRows
        };
    }

    public getPendingOutcomeCount(): number {
        return this.outcomeTracker.getPendingCount();
    }

    public finalize(): {
        readonly outcomeAccounting: V4OutcomeAccounting;
        readonly unresolvedFinalBarEvents: readonly V4PipelineStrategyEvent[];
    } {
        const outcomeAccounting = this.outcomeTracker.finalizeEndOfStream(this.acceptedCount);
        const unresolvedFinalBarEvents = this.pendingEntryResolutionEvents;
        this.pendingEntryResolutionEvents = Object.freeze([]);
        return Object.freeze({ outcomeAccounting, unresolvedFinalBarEvents });
    }
}
