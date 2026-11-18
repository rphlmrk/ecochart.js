import { ML1_CONFIG_B, ML1_CONFIG_C, ML1_CONFIG_C_VERSION } from '../ML1FeatureConfigs';
import {
    createInitialML1FeatureStateV5,
    stepML1FeaturesV5,
    validateML1Config,
    validateML1ConfigV5
} from '../ML1FeatureEngine';
import type {
    ML1Candle,
    ML1FeatureStateV5,
    ML1Observation,
    ValidatedML1FeatureConfigV5
} from '../ML1FeatureTypes';
import type { MTFTimeframeConfig } from '../mtf/MTFConfig';
import { createInitialMTFTimeframeState } from '../mtf/MTFState';
import { stepHTFAggregation } from '../mtf/MTFAggregator';
import { stepTimeframeFeatureEngine } from '../mtf/MTFFeatureEngine';
import { alignTimeframeContext } from '../mtf/MTFAligner';
import type { HTFIncompleteDiagnostic, MTFTimeframeContext, MTFTimeframeState } from '../mtf/MTFTypes';
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
    sortAndVerifyUniqueStrategyEvents,
    stepStrictCBCWithReset,
    type StrategyEvent
} from '../teachers/StrategyEventTypes';
import { createDefaultPHLConfig, createInitialPHLState, stepPHL, type PHLConfig, type PHLState } from '../teachers/ProtectedHighsLowsTeacher';
import { createDefaultDTFXConfig, createInitialDTFXState, stepDTFX, type DTFXConfig, type DTFXState } from '../teachers/DTFXAlgoZonesTeacher';
import { createInitialVAMState, stepVolatilityAdjustedMean } from '../trend/VolatilityAdjustedMean';
import {
    assertV3RepresentationZeroTierCLeakage,
    MultiHorizonOutcomeTracker,
    V3_DATASET_VERSION,
    V3_REPRESENTATION_COLUMNS,
    type V3OutcomeAccounting,
    type V3StrategyEventRow,
    type V3TierAAtConfirmation
} from './MultiHorizonOutcomeEngine';

export const V3_15M_ONLY_MTF_VERSION = 'M3_15M_ONLY_v1';

export interface V3PipelineConfig {
    readonly symbol: string;
    readonly interval: string;
    readonly intervalMs: number;
    readonly requireContiguous: boolean;
    readonly featureConfig: ValidatedML1FeatureConfigV5;
    readonly mtf15mConfig: MTFTimeframeConfig | null; // 15m only when interval === '1m'; NO 1h
    readonly phlConfig: PHLConfig;
    readonly dtfxConfig: DTFXConfig;
    readonly integrityPolicy: IntegrityPolicy;
    readonly sourceTimestampBounds?: RawSourceTimestampBounds;
}

export interface V3PipelineBarStepOutput {
    readonly acceptedBarIndex: number;
    readonly observationId: string;
    readonly sourceTimestamp: number;
    readonly observationTimestamp: number;
    readonly candle: ML1Candle;
    readonly dataQuality: DataQualityStatus;
    readonly observation: ML1Observation;
    readonly context15m: MTFTimeframeContext | null;
    readonly htf15mDiagnostic: HTFIncompleteDiagnostic | null;
    readonly confirmedEvents: readonly StrategyEvent[];       // Emitted on current bar (entryTimestamp === null)
    readonly resolvedPreviousBarEvents: readonly StrategyEvent[]; // Prior bar's confirmed events with actual entryTimestamp
    readonly completedOutcomeRows: readonly V3StrategyEventRow[];
}

export function createV3PipelineConfig(params: {
    readonly symbol: string;
    readonly interval: string;
    readonly intervalMs: number;
    readonly requireContiguous?: boolean;
    readonly sourceTimestampBounds?: RawSourceTimestampBounds;
}): V3PipelineConfig {
    const { symbol, interval, intervalMs } = params;
    if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
        throw new Error(`V3PipelineConfig Error: intervalMs must be positive safe integer, got ${intervalMs}.`);
    }

    assertV3RepresentationZeroTierCLeakage(V3_REPRESENTATION_COLUMNS);

    const is1m = interval === '1m';
    const featureConfig = validateML1ConfigV5({
        ...ML1_CONFIG_C,
        symbol,
        timeframe: interval,
        expectedIntervalMs: intervalMs,
        gapDiscontinuityThresholdMs: Math.max(ML1_CONFIG_C.gapDiscontinuityThresholdMs, intervalMs),
        emaPeriods: [...ML1_CONFIG_C.emaPeriods],
        atrPeriods: [...ML1_CONFIG_C.atrPeriods],
        rollingRangePeriods: [...ML1_CONFIG_C.rollingRangePeriods],
        momentumPeriods: [...ML1_CONFIG_C.momentumPeriods],
        volumeSmaPeriods: [...ML1_CONFIG_C.volumeSmaPeriods],
        cciPeriods: [...ML1_CONFIG_C.cciPeriods],
        volumeCandleSizePeriods: is1m ? [...ML1_CONFIG_C.volumeCandleSizePeriods] : [],
        enableVAM: ML1_CONFIG_C.enableVAM
    });

    // 15m-ONLY MTF config (1h explicitly removed from v3; VolumeCandleSize stays 1m-only)
    const mtf15mConfig: MTFTimeframeConfig | null = is1m
        ? Object.freeze({
              timeframe: '15m' as const,
              durationMs: 900_000,
              alignment: 'UTC_HALF_OPEN' as const,
              expectedSourceIntervalMs: 60_000,
              gapPolicy: 'REJECT_AND_RESET' as const,
              featureConfig: validateML1Config({
                  ...ML1_CONFIG_B,
                  symbol,
                  timeframe: '15m',
                  expectedIntervalMs: 900_000,
                  gapDiscontinuityThresholdMs: 4_500_000
              })
          })
        : null;

    const requireContiguous = params.requireContiguous ?? true;

    return Object.freeze({
        symbol,
        interval,
        intervalMs,
        requireContiguous,
        featureConfig,
        mtf15mConfig,
        phlConfig: createDefaultPHLConfig(symbol, interval, intervalMs),
        dtfxConfig: createDefaultDTFXConfig(symbol, interval, intervalMs),
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

export function getV3FeatureConfigVersion(config: V3PipelineConfig): string {
    return config.mtf15mConfig !== null
        ? `${ML1_CONFIG_C_VERSION}+${V3_15M_ONLY_MTF_VERSION}`
        : ML1_CONFIG_C_VERSION;
}

/**
 * Unified Single-Pass Causal V3 Engine.
 * Executes Tier A (ML1_CONFIG_C + 15m-only MTF), all 4 Teachers (CBC, PHL, DTFX, VAM),
 * and bounded-memory 60/120/180-bar Outcome Replay cleanly in one shared implementation.
 */
export class V3PipelineRunner {
    public readonly config: V3PipelineConfig;
    private stats: BackboneStats = createInitialBackboneStats();
    private featureState: ML1FeatureStateV5;
    private mtf15mState: MTFTimeframeState | null;
    private cbcState: StrictCBCState | null = null;
    private lastCbcPivot: StrictZigZagPivot | null = null;
    private phlState: PHLState = createInitialPHLState();
    private dtfxState: DTFXState = createInitialDTFXState();
    private vamTeacherState = createInitialVAMState();
    private readonly outcomeTracker = new MultiHorizonOutcomeTracker();

    private acceptedCount = 0;
    private gridAnchor: number | null;
    private prevAcceptedTs = -1;
    private lastConfirmationBar = -1;
    private pendingEntryResolutionEvents: readonly StrategyEvent[] = Object.freeze([]);
    private htf15mGapCount = 0;
    private htf15mResetCount = 0;
    private htf15mIncompleteWindowCount = 0;

    public constructor(config: V3PipelineConfig) {
        this.config = config;
        this.featureState = createInitialML1FeatureStateV5(config.featureConfig);
        this.mtf15mState = config.mtf15mConfig ? createInitialMTFTimeframeState('15m') : null;
        this.gridAnchor = config.sourceTimestampBounds?.startTimestamp ?? null;
    }

    public getStats(): BackboneStats {
        return this.stats;
    }

    public getAcceptedCount(): number {
        return this.acceptedCount;
    }

    public getHtf15mStats(): {
        readonly htf15mGapCount: number;
        readonly htf15mResetCount: number;
        readonly htf15mIncompleteWindowCount: number;
    } {
        return Object.freeze({
            htf15mGapCount: this.htf15mGapCount,
            htf15mResetCount: this.htf15mResetCount,
            htf15mIncompleteWindowCount: this.htf15mIncompleteWindowCount
        });
    }

    public stepCandle(rawCandle: ML1Candle): V3PipelineBarStepOutput {
        const barIndex = this.acceptedCount;
        const { symbol, interval, intervalMs } = this.config;

        if (!Number.isSafeInteger(rawCandle.time) || rawCandle.time < 1e12 || !validateCandleOhlcv(rawCandle)) {
            throw new Error(`V3 Source Integrity Error: invalid OHLCV or timestamp at bar ${barIndex} (time=${rawCandle.time}).`);
        }

        const anchor = this.gridAnchor ?? rawCandle.time;
        this.gridAnchor = anchor;
        const isOnGrid = (rawCandle.time - anchor) % intervalMs === 0;
        const bounds = this.config.sourceTimestampBounds;
        const isWithinRange =
            bounds === undefined || (rawCandle.time >= bounds.startTimestamp && rawCandle.time <= bounds.endTimestamp);

        if (!isOnGrid || !isWithinRange) {
            throw new Error(`V3 Source Integrity Error: off-grid or out-of-range candle at bar ${barIndex} (time=${rawCandle.time}).`);
        }
        if (this.prevAcceptedTs !== -1) {
            const deltaMs = rawCandle.time - this.prevAcceptedTs;
            if (deltaMs <= 0) {
                throw new Error(`V3 Source Integrity Error: duplicate or out-of-order candle at bar ${barIndex} (time=${rawCandle.time}).`);
            }
            if (this.config.requireContiguous && deltaMs !== intervalMs) {
                throw new Error(
                    `V3 Source Integrity Error: non-contiguous candle at bar ${barIndex}: expected ${this.prevAcceptedTs + intervalMs}, got ${rawCandle.time}.`
                );
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

        // 1. Tier A (ML1_CONFIG_C_v1, stateVersion: 5)
        const featStep = stepML1FeaturesV5(candle, barIndex, this.featureState, this.config.featureConfig);
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
            throw new Error(`V3 Backbone Error: rejected candle at bar ${barIndex}: ${backboneStep.acceptance.rejectionReasons.join(', ')}`);
        }

        const observationId = generateObservationId(symbol, interval, candle.time, V3_DATASET_VERSION);
        const isDiscontinuity = obs.features['IsDiscontinuity'] === 1;

        // 2. 15m-Only MTF Context (zero 1h computation)
        let context15m: MTFTimeframeContext | null = null;
        let htf15mDiagnostic: HTFIncompleteDiagnostic | null = null;
        if (this.mtf15mState !== null && this.config.mtf15mConfig !== null) {
            const agg15 = stepHTFAggregation(
                candle,
                true,
                this.mtf15mState.aggregation,
                this.config.mtf15mConfig
            );
            if (agg15.diagnostics.length > 0) {
                this.htf15mGapCount += agg15.diagnostics.length;
                this.htf15mResetCount += agg15.diagnostics.length;
                this.htf15mIncompleteWindowCount += agg15.diagnostics.length;
            }
            const afterAggState: MTFTimeframeState = Object.freeze({
                ...this.mtf15mState,
                aggregation: agg15.nextState
            });
            const feat15 = stepTimeframeFeatureEngine(
                afterAggState,
                agg15.completedCandle,
                agg15.diagnostic,
                this.config.mtf15mConfig
            );
            this.mtf15mState = feat15.nextTimeframeState;
            htf15mDiagnostic = this.mtf15mState.aggregation.lastDiagnostic;
            context15m = alignTimeframeContext(
                backboneStep.observationTimestamp,
                this.mtf15mState,
                this.config.mtf15mConfig
            );
        }

        // 3. Resolve actual next-accepted entryTimestamp for prior bar's confirmed events & step outcome tracker
        const resolvedPreviousBarEvents: StrategyEvent[] = [];
        for (const prevEv of this.pendingEntryResolutionEvents) {
            if (prevEv.entryBarIndex !== barIndex) {
                throw new Error(
                    `V3Pipeline Chronology Error: pending event '${prevEv.eventId}' expected entryBarIndex=${prevEv.entryBarIndex}, got ${barIndex}.`
                );
            }
            if (candle.time <= prevEv.confirmationTimestamp) {
                throw new Error(
                    `V3Pipeline Chronology Error: entryTimestamp (${candle.time}) must strictly exceed confirmationTimestamp (${prevEv.confirmationTimestamp}).`
                );
            }
            resolvedPreviousBarEvents.push(
                Object.freeze({
                    ...prevEv,
                    entryTimestamp: candle.time
                })
            );
        }

        const completedOutcomeRows = this.outcomeTracker.stepBar(barIndex, candle);

        // 4. Step all 4 Causal Teachers on barIndex
        const rawBarEvents: StrategyEvent[] = [];
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
                })
            );
        }

        // 4b. PHL BOS/MSS
        const phlStep = stepPHL(candle, barIndex, this.phlState, this.config.phlConfig, isDiscontinuity, atrForContext, null);
        this.phlState = phlStep.nextState;
        rawBarEvents.push(...phlStep.events);

        // 4c. DTFX Zones
        const dtfxStep = stepDTFX(candle, barIndex, this.dtfxState, this.config.dtfxConfig, isDiscontinuity, atrForContext, null);
        this.dtfxState = dtfxStep.nextState;
        rawBarEvents.push(...dtfxStep.events);

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
        if (vamEv) rawBarEvents.push(vamEv);

        // Canonical sort & bar-level eventId uniqueness (global uniqueness follows from barIndex monotonicity)
        if (barIndex <= this.lastConfirmationBar) {
            throw new Error(`V3Pipeline Chronology Error: non-monotonic barIndex ${barIndex}.`);
        }
        this.lastConfirmationBar = barIndex;
        const sortedBarEvents = sortAndVerifyUniqueStrategyEvents(rawBarEvents);

        if (sortedBarEvents.length > 0) {
            const tierASnapshot: V3TierAAtConfirmation = Object.freeze({
                tierAObservationId: observationId,
                atr14: atrValid ? atr14 : 0,
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
                context15mAvailable: context15m?.isAvailable === true,
                context15mStatus: context15m?.availabilityStatus ?? 'UNAVAILABLE'
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
            context15m,
            htf15mDiagnostic,
            confirmedEvents: sortedBarEvents,
            resolvedPreviousBarEvents: Object.freeze(resolvedPreviousBarEvents),
            completedOutcomeRows
        };
    }

    public getPendingOutcomeCount(): number {
        return this.outcomeTracker.getPendingCount();
    }

    public finalize(): {
        readonly outcomeAccounting: V3OutcomeAccounting;
        readonly unresolvedFinalBarEvents: readonly StrategyEvent[];
    } {
        const outcomeAccounting = this.outcomeTracker.finalizeEndOfStream(this.acceptedCount);
        const unresolvedFinalBarEvents = this.pendingEntryResolutionEvents;
        this.pendingEntryResolutionEvents = Object.freeze([]);
        return Object.freeze({
            outcomeAccounting,
            unresolvedFinalBarEvents
        });
    }
}
