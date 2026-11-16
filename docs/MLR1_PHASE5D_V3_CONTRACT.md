# ML-R1 Phase 5D (v3) Frozen Contract

**Contract Status:** FROZEN (Phase 1 Verdict: `CONDITIONAL ACCEPTANCE` — see `docs/MLR1_PHASE5D_PHASE1_ACCEPTANCE.md`)  
**Canonical Instrument & Timeframe:** `SOLUSDT` `1m`  
**Legacy Compatibility:** `ML1FeatureEngine` `stateVersion: 4` (`ML1_CONFIG_A`, `ML1_CONFIG_B`) and `MLR1_DATASET_VERSION = 2` remain untouched and default until all v3 audits pass.  
**Historical V4 Compatibility Status:** `NOT PROVEN — NO INDEPENDENT PRE-CHANGE BASELINE AVAILABLE` (current-build regression hashes are current-build drift checks only, not historical proof).  
**Deferred Runtime Scope:** `StrategyEvent` runtime implementation, discriminator collision checks, final-bar (`entryTimestamp: null`) runtime handling, and `v3` export exclusion/censoring are contract-specified here and deferred to Phase 2 (Gate 1) and Phase 4.

---

## 1. MTF Scope (Amended)
- **Retained MTF:** `15m` (`900,000 ms`, exclusive close alignment via `MTFAligner`).
- **Removed MTF:** `1h` is removed from v3 MTF configuration, feature pipeline, chart MTF selectors, and v3 export contracts.
- **Volume Candle Size (360):** Computed on **`1m` only** (never on `15m`).

---

## 2. Tier A Technical Feature Formulas (`ML1_CONFIG_C_v1`, `stateVersion: 5`)

`IsWarmupComplete` remains bound to the core 200-bar readiness contract (`EMA 200`, `ATR`, `RollingRange`, `Momentum`, `Volume 50`). New features carry independent `valid_*` masks.

### 2.1 `Exhaustion (CCI 20)` — Source: `Exhaustion.ts`
- **Typical Price:** `tp_t = (high + low + close) / 3`.
- **Window:** Current candle `tp_t` **is included** (`[t - 19 .. t]`).
- **SMA & MAD:** `sma_t = mean(tp[t-19..t])`; `mad_t = mean(|tp_j - sma_t|)` around the **current** `sma_t` across all 20 bars.
- **Value & Clamp:** `raw = (tp_t - sma_t) / (0.015 * mad_t)`; clamped to `[-300, 300]`.
- **Warmup & Zero-MAD:** Warmup counts **accepted observations only** (`unbrokenRun >= 20`, first valid index **`19`**). Rejected observations do not mutate state. If `mad_t === 0` or non-finite → value `0`, `valid_Exhaustion_20 = false`.
- **Discontinuity:** Resets 20-bar `tpHistory` buffer to `[tp_t]`, `unbrokenRun = 1`.

### 2.2 `Volume / Candle Size (360)` — Source: `volume candle size.txt`
- **Raw Absorption (`jam1`):**
  - `hl2 = low + (high - low) * 0.5`
  - `relSpread = (high - low) / hl2 + 1 / 2000`
  - `jam1 = (volume * hl2) / (10^7 * relSpread)`
- **Baseline (Frozen Prior-Window):** Evaluated strictly against the **`360` preceding accepted observations `[t - 360 .. t - 1]`**, excluding bar `t`.
  - **First valid index:** **`360`** (bars `0..359` emit `0` with `valid = false`).
  - `priorMean = mean(jamHistory[0..359])`
  - `priorStd = sqrt(mean((x - priorMean)^2))` (**population** standard deviation).
- **Emitted Features:**
  - `VolumeCandleSize_Ratio_360 = jam1 / priorMean` (`valid` iff `unbrokenRun >= 360`, `priorMean > 0`, finite).
  - `VolumeCandleSize_ZScore_360 = (jam1 - priorMean) / priorStd` (`valid` iff `unbrokenRun >= 360`, `priorStd > 0`, finite). Zero `std` never emits `valid = true`.
  - `VolumeCandleSize_Regime_360`: `2` if `ratio > 2.0`, `1` if `ratio > 1.0`, `0` otherwise (`valid` iff `Ratio` is valid).
- **Guards & Reset:** Invalidate if `hl2 <= 0`, `relSpread <= 0`, or `!Number.isFinite(jam1)`. Reset buffer on `isDiscontinuity` before evaluating bar `t`.

### 2.3 `Volatility Adjusted Mean (VAM)` — Source: `volatilty mean.txt`
- **Source:** `hlc3 = high / 3 + low / 3 + close / 3`.
- **Efficiency Ratio (`centerLength = 18`):**
  - `changeAbs = |hlc3_t - hlc3_{t-18}|`, `noise = sum_{k=1..18} |hlc3_{t-18+k} - hlc3_{t-18+k-1}|`.
  - Requires `19` unbroken bars (`hlc3History.length === 19`, first valid index **`18`**).
  - During bars `0..17` (Pine `na` behavior), `efficiency = 0` with `valid_VAM_Efficiency = false`. From bar `18+`, `efficiency = noise > 0 ? changeAbs / noise : 0` with `valid_VAM_Efficiency = true`.
- **Adaptive Center Line (`fast = 4`, `slow = 30`, `smooth = 5`):**
  - *Pine v5 `na` parity note (supersedes earlier bar 18/22/25 draft):* In Pine v5, `noise > 0` evaluates `false` when `noise` is `na` on bars `0..17`, yielding `efficiency = 0.0` (with `valid_VAM_Efficiency = false`) and seeding `adaptive` at **bar 0**, `center` at **bar 4**, and `trend` at **bar 7**.
  - `fastSC = 2 / 5 = 0.4`, `slowSC = 2 / 31`, `sc = (efficiency * (fastSC - slowSC) + slowSC)^2`.
  - `adaptive_0 = hlc3_0`; for `t >= 1`, `adaptive_t = adaptive_{t-1} + sc_t * (hlc3_t - adaptive_{t-1})`.
  - `center = EMA(adaptive, 5)` seeded via 5-bar SMA of `adaptive[0..4]` (first valid at bar **`4`**).
  - `slope_3 = center_t - center_{t-3}` (first valid at bar **`7`**).
- **Sub-Indicators:**
  - `ATR(14)`: Wilder RMA via `updateWilderATR` (first valid at bar **`13`**).
  - `RSI(14)`: Wilder RMA of gains/losses over `close` deltas (first valid at bar **`14`**).
  - `DMI(14, 14)`: Wilder RMA of `+DM`, `-DM`, `TR` (first valid `+DI/-DI` at bar **`14`**); `ADX(14)` = 14-bar SMA seed + Wilder RMA of `DX` (first valid at bar **`27`**).
- **Exact `trend` Initialization, Streaks & Transitions (Pine Parity):**
  1. **Seed:** On the first bar where `center[3]` is valid (`bar 7`) and `trend === 0`: `trend = close >= center ? 1 : -1`.
  2. **Noise Filters (`useHTF = false`):**
     - `allowBuy = (adx >= 20 && plusDI > minusDI) && (rsi > 52) && ((center - center_3) >= atr * 0.12)`
     - `allowSell = (adx >= 20 && minusDI > plusDI) && (rsi < 48) && ((center_3 - center) >= atr * 0.12)`
     - `qualifiedBuy = allowBuy && (close > center + atr * 0.50) && (center > center_3)`
     - `qualifiedSell = allowSell && (close < center - atr * 0.50) && (center < center_3)`
  3. **Streaks (evaluated BEFORE signal & trend transition):**
     - `buyStreak = qualifiedBuy ? buyStreak + 1 : 0`
     - `sellStreak = qualifiedSell ? sellStreak + 1 : 0`
  4. **Signals (evaluated against PRE-transition `trend`):**
     - `cooldownPassed = lastSignalBar === null || (acceptedBarIndex - lastSignalBar > 6)`
     - `buySignal = (trend === -1 && buyStreak >= 2 && cooldownPassed)`
     - `sellSignal = (trend === 1 && sellStreak >= 2 && cooldownPassed)`
  5. **Transition (evaluated AFTER signal check):**
     - `if (buySignal) { trend = 1; lastSignalBar = acceptedBarIndex; }`
     - `else if (sellSignal) { trend = -1; lastSignalBar = acceptedBarIndex; }`
  6. **Discontinuity:** Resets all VAM accumulators (`trend = 0`, `buyStreak = 0`, `sellStreak = 0`, `lastSignalBar = null`, `adaptive = hlc3`, etc.).
- **UI Take Profits (`tp1/tp2/tp3`):** Display-only; never exported in Tier A or Tier B.

---

## 3. Universal `StrategyEvent` Contract & Canonical Event Names

```ts
export type StrategyId = 'STRICT_CBC' | 'PHL_BOS_MSS' | 'DTFX_ZONES' | 'VAM_REVERSAL';

export type StrategyEventType =
    | 'CBC_HIGH_HH' | 'CBC_HIGH_LH' | 'CBC_LOW_HL' | 'CBC_LOW_LL'
    | 'PHL_BOS_BULL' | 'PHL_BOS_BEAR' | 'PHL_MSS_BULL' | 'PHL_MSS_BEAR'
    | 'DTFX_DEMAND_CREATED' | 'DTFX_SUPPLY_CREATED'
    | 'DTFX_DEMAND_RETEST' | 'DTFX_SUPPLY_RETEST'
    | 'VAM_BUY' | 'VAM_SELL';

export interface StrategyEvent {
    readonly eventId: string; // Unambiguous length-prefixed encoding: `SE1|${len}:${strategyId}|${len}:${strategyVersion}|${len}:${symbol}|${len}:${timeframe}|${len}:${eventType}|${len}:${sourceBarIndex}|${len}:${confirmationBarIndex}|${len}:${eventDiscriminator}`
    readonly eventDiscriminator: string;
    readonly strategyId: StrategyId;
    readonly strategyVersion: string;
    readonly eventType: StrategyEventType;
    readonly eventDirection: 'bull' | 'bear';

    readonly sourceBarIndex: number;
    readonly sourceTimestamp: number;
    readonly confirmationBarIndex: number;
    readonly confirmationTimestamp: number;
    readonly confirmationLagBars: number;

    readonly observationBarIndex: number;   // === confirmationBarIndex
    readonly observationTimestamp: number;  // === confirmationTimestamp + intervalMs (exclusive close)
    readonly entryBarIndex: number;         // === confirmationBarIndex + 1
    readonly entryTimestamp: number | null; // Actual next accepted candle's open timestamp; null if confirmationBarIndex is the final bar (no next accepted candle yet)

    readonly structuralContext: Readonly<Record<string, number | string | boolean>>;
}
```

### Deterministic `eventDiscriminator` Derivation
- **`STRICT_CBC`:** `String(pivot.id)` (monotonically increasing 1-based pivot ID preserved across discontinuities). On `isDiscontinuity === true`, StrictCBC re-initializes anchor/phase state and clears `prevPivot` so no leg or pivot bridges a gap.
- **`PHL_BOS_MSS`:** `'PH'` for `PHL_BOS_BULL` / `PHL_MSS_BULL` (break of protected high), `'PL'` for `PHL_BOS_BEAR` / `PHL_MSS_BEAR` (break of protected low); combined with `eventType` and `confirmationBarIndex` at most one break per level can occur per bar.
- **`DTFX_ZONES`:**
  - `DTFX_DEMAND_CREATED` / `DTFX_SUPPLY_CREATED`: `String(zone.zoneId)` (monotonically increasing 1-based zone ID).
  - `DTFX_DEMAND_RETEST` / `DTFX_SUPPLY_RETEST`: `${zone.zoneId}_R${zone.retestCount}` (distinguishes simultaneous overlapping zones and sequential retests of the same zone).
- **`VAM_REVERSAL`:** `'BUY'` for `VAM_BUY`, `'SELL'` for `VAM_SELL` (mutually exclusive per bar via `trend` guard). Because `VAM_REVERSAL` is a synchronous bar-close signal evaluated on bar `i`, `sourceBarIndex === confirmationBarIndex` (`confirmationLagBars === 0`) and `sourceTimestamp === confirmationTimestamp`.
- **`DTFX_ZONES` Geometry Guard:** Only zones satisfying `zoneTop > zoneBot && zoneBot > 0` with strictly ascending `fibLevels` inside `(0, 1)` are created.

### Timestamp, Final-Bar & Ordering Rules
- `sourceTimestamp`: Open timestamp of the originating candle (for `DTFX_*_RETEST`, `sourceBarIndex` / `sourceTimestamp` is the retest candle, while `zoneCreatedSourceBarIndex` and `zoneCreatedConfirmationBarIndex` stay in `structuralContext`).
- `confirmationTimestamp`: Open timestamp of the confirmation candle.
- `observationTimestamp`: `confirmationTimestamp + intervalMs` (exact bar close when event becomes observable).
- `entryTimestamp`: Actual next accepted candle's open timestamp (`acceptedRows[entryBarIndex].sourceTimestamp`), never `confirmationTimestamp + intervalMs` blindly across gaps.
- **Final-Bar Semantics:** When `confirmationBarIndex === acceptedRows.length - 1` (`entryBarIndex >= acceptedRows.length`), the live teacher sets `entryTimestamp = null`. In ML-R1 v3 dataset export, any event with `entryBarIndex >= acceptedRows.length` (`excludedMissingNextOpen`) or `entryBarIndex + 180 - 1 >= acceptedRows.length` (`excludedIncompleteHorizon`) is non-actionable/censored and excluded prior to CSV emission, with exact counts reconciled in `Manifest.json`.
- **Deterministic Sort Key:** `(confirmationBarIndex, strategyId, eventType, eventId)`.

### Teacher Edge-Case Rules (Frozen for Phase 2)
- **PHL (`market structure.txt`):** `ps = 3`, single-slot `ph`/`pl`, no `change[1]` delay. When `bull === null`, first break emits `PHL_MSS_BULL` or `PHL_MSS_BEAR`. Same-bar newly created opposite `track_low`/`track_high` takes effect on `barIndex + 1`.
- **DTFX (`dtfx.txt`):** Lifecycle `CREATED → ACTIVE → RETESTED → INVALIDATED`.
  - **Same-bar Precedence & Distinct-Visit Retests (Frozen):** **Invalidation takes precedence over retest.** On bar `j > createdBar`:
    1. If bullish zone and `close < bot` (or bearish zone and `close > top`) → transition to `INVALIDATED` (set `invalidationBarIndex = j`); **no** retest event emitted on bar `j`.
    2. Else if bar `[low, high]` overlaps `[bot, top]`:
       - If `!isCurrentlyInZone` (first touch or a fresh revisit after price previously exited `[bot, top]` on an earlier bar), increment `retestCount` (`1, 2, ...`), set `status = 'RETESTED'`, `isCurrentlyInZone = true`, and emit `DTFX_DEMAND_RETEST` / `DTFX_SUPPLY_RETEST` with `eventDiscriminator = `${zoneId}_R${retestCount}``.
       - If `isCurrentlyInZone === true` (consecutive bars lingering inside `[bot, top]`), emit no duplicate retest event.
    3. Else (`[low, high]` does not touch `[bot, top]`) → set `isCurrentlyInZone = false`.
  - **Resource Bound & BOS Consumption:** `activeZones` is bounded by `maxActiveZones` (default `256`, pruning oldest active zone on overflow). Consistent with `dtfx.txt`, `bosUpCheck`/`bosDownCheck` clears on `mssUp`/`mssDown` even if a degenerate candidate (`zoneTop <= zoneBot || zoneBot <= 0`) is skipped by the geometry guard.

---

## 4. Counterfactual Outcomes & Chart Validation Rules
- **v2 Replay:** Unchanged (60-bar horizon, `next_open`, 1.5 ATR SL, 2.0R TP, 0.05R cost).
- **v3 Replay (60 / 120 / 180 bars):** Independent evaluations from the same entry & barrier geometry. Open-gap fills execute at `fOpen` (matching v2); intrabar touches fill at barrier price with SL precedence. Events with `entryBar + 180 - 1 >= len` are censored/excluded.
- **Phase 5 Chart Rendering & Visual Validation Gate:**
  - Every chart plugin (`Exhaustion CCI20`, `Volume Candle Size 360`, `Volatility Adjusted Mean`, `Strict CBC`, `PHL BOS/MSS`, `DTFX Zones`) must delegate directly to the pure Phase 1–2 engines (zero separate chart-only math).
  - Phase 5 cannot close until visual acceptance checks verify: (1) engine-to-chart value parity per candle, (2) warmup/invalid display states, (3) discontinuity resets, (4) markers on exact confirmation bars, (5) DTFX lifecycle ordering (`CREATED -> RETESTED -> INVALIDATED`), (6) zero repainting, (7) symbol/timeframe switch stability, and (8) `1h` MTF removed from v3 pipeline and chart MTF selectors.
