# ML-R1 Phase 2J — Feature Manifest & Configuration Specification

**Project:** EcoChart / Chronos  
**Research track:** ML-R1 — Continuous Market Representation  
**Milestone:** 2 — Native 1m Technical Feature Engine  
**Instrument:** `SOLUSDT`  
**Timeframe:** `1m`  
**Configuration profiles:** A (EMA ablated), B (EMA included)  
**Engine state schema:** Version `4` in the reviewed Phase 2H engine snapshot  
**Document status:** Phase 2J Finalized Artifact

---

## 1. Purpose and scope

Phase 2J defines two controlled feature-engine configurations and records the feature contract needed for later dataset/export work.

ML-R1 is a **causal, continuous technical representation engine**. It is not a price-prediction model, signal generator, trading strategy, or execution policy.

The frozen operating principles remain:

1. One accepted source 1-minute candle produces one observation.
2. All feature calculations use current and past information only.
3. No future candle, forward reconstruction, or fabricated candle may enter the feature vector.
4. Invalid source observations must not advance persistent feature state.
5. Feature validity is explicit and separate from numeric fallback values.
6. Stateful calculations must respect configured gaps and discontinuities.
7. State transitions must remain deterministic, immutable, and restorable.
8. Configuration A and B must differ only by EMA inclusion.

---

## 2. Frozen configuration profiles

Both profiles use the `SOLUSDT` 1-minute dataset contract.

| Parameter | Config A | Config B |
|---|---:|---:|
| `symbol` | `SOLUSDT` | `SOLUSDT` |
| `timeframe` | `1m` | `1m` |
| `expectedIntervalMs` | `60000` | `60000` |
| `gapDiscontinuityThresholdMs` | `300000` | `300000` |
| `emaPeriods` | `[]` | `[9, 20, 50, 100, 200]` |
| `atrPeriods` | `[14, 20]` | `[14, 20]` |
| `rollingRangePeriods` | `[5, 10, 20, 50]` | `[5, 10, 20, 50]` |
| `momentumPeriods` | `[3, 5, 10, 20]` | `[3, 5, 10, 20]` |
| `volumeSmaPeriods` | `[10, 20, 50]` | `[10, 20, 50]` |

### Config A — EMA ablation baseline
EMA calculation is completely disabled with an empty `emaPeriods` array. The engine's non-EMA feature families remain configured identically to Config B.

### Config B — EMA context
Adds five EMA periods. EMA price levels are maintained internally as state; the engine emits **27 normalized features** (distances, slopes, and adjacent-pair relationships). Raw EMA price levels are strictly excluded from the exported vectors.

---

## 3. Feature manifest

### 3.1 Candle anatomy
| Feature | Definition | Warm-up / validity | Gap policy |
|---|---|---|---|
| `CandleRange`, `BodySize`, `UpperWick`, `LowerWick`, `CandleDirection` | Exact derivations from OHLC | 0 bars | Continues |
| `CloseLocation`, `BodyToRange`, `UpperWickRatio`, `LowerWickRatio` | Ratio of components to `CandleRange` | 0 bars (Requires Range > 0) | Invalid if Range is 0 |

### 3.2 ATR and volatility context (Periods: 14, 20)
| Feature | Definition | Warm-up / validity | Gap policy |
|---|---|---|---|
| `ATR_N` | Wilder ATR (SMA seeded) | N contiguous true-ranges | Resets/re-seeds |
| `ATR_N_Normalized` | `ATR_N / Close` | ATR valid, Close positive | Invalid until re-seed |
| `ATR14_to_ATR20` | `ATR_14 / ATR_20` | Both ATRs valid, `ATR_20 > 0` | Invalid until both usable |
| `RangeToATR_N`, `BodyToATR_N` | Anatomy component / `ATR_N` | Anatomy valid, `ATR_N > 0` | Invalid until re-seed |

### 3.3 Rolling range context (Periods: 5, 10, 20, 50)
| Feature pattern | Definition | Warm-up / validity | Gap policy |
|---|---|---|---|
| `RollingHighestHigh_N`, `RollingLowestLow_N`, `RollingRangeWidth_N` | Extrema of rolling buffer | N observations | Flush buffer |
| `PositionWithinRollingRange_N` | Close position within rolling interval | N obs, Width > 0 | Invalid if Width is 0 |
| `RollingHighDistance_N`, `RollingLowDistance_N` | Distance to rolling extremes | N observations | Flush buffer |

### 3.4 Momentum, returns, and directional efficiency
| Feature | Definition | Warm-up / validity |
|---|---|---|
| `Return_N` [1, 3, 5, 10] | `(Close_t - Close_(t-N)) / Close_(t-N)` | N+1 closes, denominator > 0 |
| `Momentum_N` [3, 5, 10, 20] | `Close_t - Close_(t-N)` | N+1 closes |
| `DirectionalEfficiency_N` [5, 10, 20] | Net displacement / Abs Path | N+1 closes, path > 0 |
| `PositiveReturnFraction_N` [5, 10, 20] | Fraction of positive steps | N+1 closes |
| `ReturnBalance_N` [5, 10, 20] | Net return / Sum(AbsReturns) | N+1 closes, absSum > 0 |

*Note: Momentum history is strictly flushed on major discontinuities.*

### 3.5 Volume context (Periods: 10, 20, 50)
| Feature | Definition | Warm-up / validity |
|---|---|---|
| `Volume`, `LogVolume` | Source volume, `Math.log1p(Volume)` | 0 bars (current OHLCV valid) |
| `VolumeChange_1`, `VolumeChange_3` | Current volume minus completed prior | 1 or 3 prior observations |
| `RelativeVolume_N` | Current / Mean of N preceding | N preceding, Mean > 0 |
| `VolumeZScore_N` (20, 50) | `(Current - Mean) / PopStdDev` | N preceding, StdDev > 0 |
| `SignedVolume_20` | `CandleDirection * RelativeVolume_20` | RelVol_20 & Dir valid |

*Note: The current candle is excluded from its own historical baseline.*

### 3.6 EMA context — Config B only (Periods: 9, 20, 50, 100, 200)
Produces exactly **27 features**. EMA values are SMA seeded.

| Feature | Definition | Warm-up / validity |
|---|---|---|
| `EMA_N_Distance` | `(Close - EMA_N) / ATR_14` | EMA_N seeded, ATR_14 > 0 |
| `EMA_N_Slope_3` | `(EMA_t - EMA_(t-3)) / (3 * ATR_14)` | Max(N, 14) + 3 bars |
| `EMA_N_Slope_10` | `(EMA_t - EMA_(t-10)) / (10 * ATR_14)` | Max(N, 14) + 10 bars |
| `EMA_A_Above_EMA_B` | `Sign(EMA_A - EMA_B)` | Both EMAs seeded |
| `EMA_A_B_Separation` | `(EMA_A - EMA_B) / ATR_14` | Both EMAs seeded, ATR_14 > 0 |
| `EMA_SpreadChange_A_B` | Current sep - Previous sep | Previous/Current valid, no gap |

*Note: Adjacent pairs used are 9-20, 20-50, 50-100, and 100-200.*

### 3.7 Temporal context and Data Quality
| Feature | Type | Definition |
|---|---|---|
| `MinuteOfHour`, `HourOfDay`, `DayOfWeek` | Temporal | UTC date/time extraction |
| `SinX`, `CosX` variants | Temporal | Cyclic trig encodings |
| `IsValidOHLCV`, `IsSynthetic`, `IsFlatCandle`, `IsZeroVolume` | DQ | Base OHLCV telemetry |
| `IsInvalidIndex`, `HasDataGap`, `IsDiscontinuity` | DQ | Index and gap detection |
| `IsUnexpectedInterval`, `IsDuplicateTimestamp`, `IsOutOfOrder` | DQ | Chronology validation |
| `HasPreviousCandle`, `HasExpectedPreviousTimestamp`, `TimeDeltaSeconds` | DQ | Delta telemetry |
| `IsSourceValid` | Gate | **True only if data passes all chronology/OHLCV rules.** |

---

## 4. Warm-up behavior and global flags
Warm-up is tracked by feature family. The global `IsWarmupComplete` flag is computed by ensuring all modules are seeded according to their base requirements.

**Global Readiness Thresholds:**
*   **Config A:** 51 uninterrupted observations (Volume_50 requires N+1).
*   **Config B:** 200 uninterrupted observations (EMA_200 requires SMA seed).
    *   *Important Note:* `EMA_200_Slope_10` requires exactly 210 bars to become valid. It evaluates independently of the global 200-bar `IsWarmupComplete` flag.

---

## 5. Invalid values, fallbacks, and validity-mask contract
The engine utilizes a parallel validity mask to distinguish true numeric zeroes from mathematical invalidations.
*   If `validity[featureName] === false`, the numeric fallback emitted by the engine is `0`.
*   Rejected observations (where `IsSourceValid === false`) bypass state updates. In these cases, stateful features default to `0` and their validity flags are strictly `false`.

---

## 6. Export-preparation specification

When converting the single-observation objects into a tabular dataset (Milestone 4), the exporter MUST adhere to the following contracts:

### 6.1 Observation schema & ordering
1. **Identity:** `timestamp`, `symbol`, `timeframe`, `barIndex`
2. **Source:** `sourceOpen`, `sourceHigh`, `sourceLow`, `sourceClose`, `sourceVolume`
3. **Features:** Non-EMA features (alphabetical) -> EMA features (Config B only, alphabetical)
4. **Validity:** Emitted as parallel boolean columns (e.g., `ATR_14__valid`) mapping 1:1 to the feature schema.

### 6.2 Data type invariants
*   `timestamp` is Unix milliseconds (integer). Do not convert to seconds.
*   No `NaN`, `Infinity`, or `-Infinity` values may be exported. The engine explicitly bounds features to finite values.
*   Rejected observations (`IsSourceValid === 0`) **MUST** be excluded from model-training splits, but may be retained in parallel audit files.

### 6.3 Required Export Metadata
Every exported dataset must include a sidecar JSON or header containing:
*   Schema version & Engine git revision.
*   Config profile (`A` or `B`).
*   Symbol, timeframe, and expected interval settings.
*   Total observation count and Rejected observation count.