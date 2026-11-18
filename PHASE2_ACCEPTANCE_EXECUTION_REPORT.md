# ML-R1 Phase 2 Acceptance Execution & Evidence Report

**Report Date (UTC):** 2026-11-18T06:23–06:25Z  
**Target Suite:** `src/test/milestone5d-phase2-acceptance.ts` (ML-R1 Phase 5D v3 Teacher Architecture — Phase 2 Frozen Implementation)  
**Audit Mode:** Read-Only Verification (`RUN, VERIFY, AND REPORT` — zero production or test source modifications)  
**Overall Verdict:** `CONDITIONALLY PASSED — REGRESSION EVIDENCE INCOMPLETE` *(Historical A/B Parity is also independently `BLOCKED — HISTORICAL BASELINE UNAVAILABLE`)*

---

## 1. Executive Summary

- **TypeScript Compilation (`./node_modules/.bin/tsc --noEmit`):** **PASSED** (`EXIT_CODE=0`, 0 errors under TypeScript `6.0.3`).
- **Phase 2 Acceptance Suite (`src/test/milestone5d-phase2-acceptance.ts`):** **PASSED** (`8/8` tests passed — Gate 1: `3/3`, Teacher Suite: `5/5`, `0` failed, `EXIT_CODE=0`).
- **Pre-Execution Source Audit:** **PASSED** across all 5 inspected modules (`StrategyEventTypes.ts`, `ProtectedHighsLowsTeacher.ts`, `DTFXAlgoZonesTeacher.ts`, `StrictCBCZigZagIndicator.ts`, `VolatilityAdjustedMean.ts` + `ATR.ts`), noting actual workspace paths for `StrictCBCZigZagIndicator.ts` (`src/indicators/plugins/`), `VolatilityAdjustedMean.ts` (`src/indicators/mlr1/trend/`), and `ATR.ts` (`src/indicators/mlr1/volatility/`).
- **Regression Suites:** **13 of 14 executed regression scripts/runners exited `0`** (`225` passed, `0` failed, `1` skipped for browser DOM in `production-exporter-acceptance.ts`). **`milestone1-acceptance.ts` exited `1`** after passing Tests 1–5 (`5/5` core engine tests over 50,000 candles) because Test 6 calls `window.addEventListener('ecochart-alert', ...)` at line 323 (`ReferenceError: window is not defined` in headless Bun CLI). No standalone PHL/DTFX/VAM/StrictCBC regression files exist outside Milestones 1–5D.
- **Historical A/B Bitwise Parity:** **`BLOCKED — HISTORICAL BASELINE UNAVAILABLE`**. The workspace is not a git repository and contains no pre-Phase-5D frozen `ML1_CONFIG_A` / `ML1_CONFIG_B` output artifacts.

---

## 2. Execution Environment & Repository Revision

- **Working Directory:** `/app/applet`
- **OS / Kernel:** `Linux localhost 4.19.0-gvisor #1 SMP Sun Jan 10 15:06:54 PST 2016 x86_64 GNU/Linux`
- **Node.js Version:** `v22.23.2`
- **Bun Runtime Version:** `1.4.4`
- **TypeScript Compiler Version:** `Version 6.0.3` (`./node_modules/.bin/tsc -v`; `package.json`: `"typescript": "~6.0.2"`)
- **Git / VCS State:** Not a git repository (`git status -s` / `git rev-parse HEAD` -> `fatal: not a git repository (or any of the parent directories): .git`)
- **`package.json` Scripts:**
  - `lint`: `tsc --noEmit`
  - `build`: `tsc && vite build`
  - `dev`: `vite --host 0.0.0.0 --port 3000`
- **`tsconfig.json` Strictness:** `target: es2023`, `module: esnext`, `moduleResolution: bundler`, `noEmit: true`, `noUnusedLocals: true`, `noUnusedParameters: true`, `erasableSyntaxOnly: true`, `noFallthroughCasesInSwitch: true`.

---

## 3. Pre-Execution Source Audit Summary (Read-Only Inspection)

*(Category: **SOURCE INSPECTED** — no edits performed.)*

| Target Component | Actual Workspace Path | Key Invariants Verified |
| :--- | :--- | :--- |
| **StrategyEvent Contract & Checkpoints** | `src/indicators/mlr1/teachers/StrategyEventTypes.ts` | - `validateAcceptedTimestampsSequence(ts, expectedIntervalMs?)` validates positive safe integer `expectedIntervalMs`, permits legitimate multi-interval gaps (`delta >= expectedIntervalMs && delta % expectedIntervalMs === 0`), rejects sub-interval or off-grid deltas, and is wired into both `createStrategyEvent()` and `resolveStrategyEventsEntryTimestamps()`.<br>- `stepStrictCBCWithReset()` sets `phaseHighIdx: barIndex` and `phaseLowIdx: barIndex` on reset/discontinuity while preserving monotonic `nextPivotId` and clearing `prevPivot` across discontinuities.<br>- `validateStrictCBCCheckpoint()` checks `currentBarIndex`, `currentCandleTimestamp`, optional `acceptedTimestamps`, anchor/phase ordering, `prevPivot` timestamps/direction, and `activePhaseIdx >= prevPivot.confirmedBarIndex`.<br>- `validateVAMCheckpoint()` enforces `typeof atrState.isSeeded === 'boolean'`, `atrState.isSeeded === (unbrokenRun >= 14)`, `dxHistoryCount === Math.max(0, dmiCount - 13)`, zero streaks/signals while `unbrokenRun < 28`, `centerSeedMean`/`centerHistory`, and segment-relative `lastSignalAcceptedIndex` (`27 <= idx < unbrokenRun`). |
| **PHL Teacher** | `src/indicators/mlr1/teachers/ProtectedHighsLowsTeacher.ts` | - In `validatePHLState()`, `isValidTracker(state.pbFromHigh, ...)` and `isValidTracker(state.pbFromLow, ...)` execute **before** `if (state.window.length === 0)` so null/malformed trackers throw `PHL State Integrity Error` instead of `TypeError`.<br>- `clockCheckpoints` + `resolveExpectedPHLTime()` anchor retained and expired bar/slot references.<br>- `stepPHL()` validates `config`, `previousState`, `isDiscontinuity`, `atr14AtConfirmation`, `candle`, and `barIndex` before evaluating `entryTimestamp <= candle.time`. |
| **DTFX Zones Teacher** | `src/indicators/mlr1/teachers/DTFXAlgoZonesTeacher.ts` | - `validateDTFXState()` checks `stateVersion === 1`, `nextZoneId >= 1`, empty-window invariants, `zoneId < nextZoneId`, unique `zoneId`s, `status`/`retestCount`/`verifyPairSpan()` (`retestCount > 1` strictly later `lastRetest`; `retestCount === 1` equal), `isCurrentlyInZone`, `top > bot > 0`, and `fibLevels`.<br>- `stepDTFX()` checks invalidation (`close < bot` / `close > top`) with `continue` strictly before retest overlap; preserves `bosUpCheck`/`bosDownCheck` on degenerate candidate geometry; evicts oldest zones without emitting invalidation; clears active zones/latches on discontinuity while retaining `nextZoneId`. |
| **StrictCBC Core Engine** *(path note: `plugins/`, not `teachers/`)* | `src/indicators/plugins/StrictCBCZigZagIndicator.ts` | - `stepStrictCBC()` assigns caller's global `barIndex` to `phaseHighIdx` / `phaseLowIdx` on continuations and flips, and increments `nextPivotId++`. |
| **VAM & Wilder ATR Engines** *(path note: `trend/` & `volatility/`, not `teachers/`)* | `src/indicators/mlr1/trend/VolatilityAdjustedMean.ts`, `src/indicators/mlr1/volatility/ATR.ts` | - `updateWilderATR()` (`ATR_LEN = 14`) sets `isSeeded: true` at `nextCount === 14` (`unbrokenRun >= 14`).<br>- `dmiCount === Math.max(0, unbrokenRun - 1)`, `trRma` seeded at `dmiCount === 14`, `dxHistoryCount === Math.max(0, dmiCount - 13)`, `adx` seeded at `dxHistoryCount === 14` (`unbrokenRun === 28`); `canEvaluateConditions` blocks streaks/signals for `unbrokenRun < 28`; `center` seeds at `unbrokenRun === 5`; `centerHistory` caps at 4; `trend` initializes at `unbrokenRun === 8`. |
| **Phase 2 Acceptance Suite** | `src/test/milestone5d-phase2-acceptance.ts` | - Gate 1 (`Gate1.1`–`Gate1.3`) includes direct `validateAcceptedTimestampsSequence` checks.<br>- Test 2 includes all 11 PHL negative assertions (null candle + `entryTimestamp`, malformed OHLC, `entryTimestamp`/`atr14`/volume/off-grid/expired/missing-window/`null` tracker/empty-window checks).<br>- Test 5 (`3a`–`3d`) includes `isoClockPrefix` exactness check and symmetric post-120 directional flip + global phase-index assertions (`> 110`). |

---

## 4. TypeScript Compilation Output

- **Command:** `./node_modules/.bin/tsc --noEmit`
- **Working Directory:** `/app/applet`
- **Compiler Version:** `Version 6.0.3`
- **Exit Code:** `0`
- **Diagnostics / Error Count:** `0` errors (`stdout` and `stderr` empty aside from shell exit wrapper)

```text
$ date -u +"%Y-%m-%dT%H:%M:%SZ" && ./node_modules/.bin/tsc --noEmit ; echo "EXIT_CODE=$?"
2026-11-18T06:23:17Z
EXIT_CODE=0
```

---

## 5. Phase 2 Acceptance Suite Output (`src/test/milestone5d-phase2-acceptance.ts`)

*(Category: **EXECUTED TEST**)*

- **Command:**
  `bun -e "import { runPhase5DPhase2Tests } from './src/test/milestone5d-phase2-acceptance.ts'; const ok = runPhase5DPhase2Tests(); console.log('FINAL_RETURN=' + ok); process.exit(ok ? 0 : 1);"`
- **Working Directory:** `/app/applet`
- **Runtime:** `bun v1.4.4`
- **Exit Code:** `0` (`FINAL_RETURN=true`)
- **Counts:** Gate 1: **3 passed, 0 failed** | Teacher Suite: **5 passed, 0 failed** | Combined: **8 passed, 0 failed**

### Group Breakdown
| Group | Result | Coverage Verified |
| :--- | :--- | :--- |
| **Gate1.1** | `PASSED` | Length-prefixed `SE1\|...` unambiguous ID encoding, collision resistance, 4-key canonical sort, duplicate rejection |
| **Gate1.2** | `PASSED` | Factory input validation (VAM `lag=0`, clock alignment, plain-object `structuralContext`, `intervalMs`, event allowlist, NaN/negative guards) |
| **Gate1.3** | `PASSED` | Resolver clock validation, `expectedIntervalMs` negative cases, gap `entryTimestamp` resolution, final-bar `null`, direct `validateAcceptedTimestampsSequence()` checks |
| **Test 1 (StrictCBC Adapter)** | `PASSED` | All 4 labels (`HH`/`LH`/`HL`/`LL`), malformed pivot rejection, contiguous control vs. gap reset preserving `nextPivotId`, checkpoint restoration with non-null `prevPivot`, positive & negative `validateStrictCBCCheckpoint` checks |
| **Test 2 (PHL Teacher)** | `PASSED` | Pinned `PHL_MSS_BULL @15`, `PHL_BOS_BULL @22`, `PHL_MSS_BEAR @24` (no duplicate @25), `useValidPullbacks` divergence, `extraValidPullbacks` match/no-match, null-candle + `entryTimestamp` ordering, gapped `clockCheckpoints`, expired/retained/empty-window & `null` tracker rejections (0 `TypeError`s) |
| **Test 3 (DTFX Teacher)** | `PASSED` | 24-bar hand-verified lifecycle, immediate touch @17, post-exit latch/count preservation, bull & bear degenerate geometry BOS preservation, `maxActiveZones=2` eviction without invalidation, mixed `RETESTED`+`ACTIVE` discontinuity reset, gapped `clockCheckpoints`, exhaustive state/config/empty-window corruption rejections |
| **Test 4 (VAM Adapter)** | `PASSED` | `signal=0` -> `null`, multi-bar `VAM_BUY` & `VAM_SELL` emission, invalid signal rejection, `validateVAMCheckpoint` across warmup bars `[0,3,4,7,13,14,18,27,38]`, post-discontinuity bar-145 restoration (`unbrokenRun=46`, `lastSignalAcceptedIndex=38`, `VAM_BUY @149`), non-boolean `isSeeded` rejection |
| **Test 5 (Combined 4-Teacher Stream)** | `PASSED` | 300-bar stream with bar-110 gap: 2-run deterministic equality, real `CBC_HIGH_HH @109` resolving bar-110 entry, bar-110 resets, bar-120 combined & isolated (`3a`–`3d`) checkpoint restorations, `isoClockPrefix` exactness, symmetric post-120 bull/bear StrictCBC flips with global phase indices `> 110` |

### Verbatim Execution Log
```text
======================================================
🧪 Starting Phase 5D Phase 2 GATE 1 (StrategyEvent Contract)
======================================================

  ✅ Passed: Gate1.1: Unambiguous SE1 eventId encoding, duplicate rejection & 4-level sort
  ✅ Passed: Gate1.2: Factory input validation (VAM lag=0, clock check, nested context, bad fields)
  ✅ Passed: Gate1.3: Resolver clock validation, expectedIntervalMs rejections, gap & final-bar null

Phase 5D Phase 2 Gate 1: 3 passed, 0 failed.

======================================================
🧪 Starting Phase 5D Phase 2 Teacher Acceptance Suite
======================================================

  ✅ Passed: 1. StrictCBC Adapter: 4 labels, contiguous control, gap reset & restoration with prevPivot
  ✅ Passed: 2. PHL Teacher: pinned bar 24 MSS, no duplicate @25, pullback modes & input/state rejections
  ✅ Passed: 3. DTFX Teacher: lifecycle, immediate touch, post-exit, BOS preservation, cap & corruptions
  ✅ Passed: 4. VAM Adapter: multi-bar real signals, no-signal & invalid signal rejection
  📊 Combined 4-Teacher Counts: {"byStrategy":{"STRICT_CBC":6,"PHL_BOS_MSS":2,"DTFX_ZONES":7,"VAM_REVERSAL":5},"byType":{"CBC_HIGH_HH":3,"VAM_SELL":3,"CBC_LOW_LL":2,"DTFX_DEMAND_CREATED":1,"PHL_MSS_BULL":1,"VAM_BUY":2,"DTFX_DEMAND_RETEST":1,"DTFX_SUPPLY_CREATED":2,"DTFX_SUPPLY_RETEST":3,"CBC_HIGH_LH":1,"PHL_MSS_BEAR":1},"preGapCount":8,"postGapCount":12}
  ✅ Passed: 5. Combined 4-Teacher Stream: all 4 emit, real bar 109 gap entry, full resets & determinism

Phase 5D Phase 2 Full Acceptance: 5 passed, 0 failed.
FINAL_RETURN=true
EXIT_CODE=0
```

---

## 6. Regression Suite Results

### Summary Table

| Suite File & Entrypoint | Category | Passed | Failed | Skipped / Blocked | Exit Code | Notes |
| :--- | :--- | :---: | :---: | :---: | :---: | :--- |
| `src/test/milestone5d-phase1-acceptance.ts` (`runPhase5DPhase1Tests`) | EXECUTED TEST | 6 | 0 | 0 | `0` | Verified Tier A V5 modules (`Exhaustion`, `VCS(360)`, `VAM`), V5/V4 integrity, 750-bar restore, current-build V4 SHA-256 constants |
| `src/test/milestone2a-acceptance.ts` (`runPhase2ATests`) | EXECUTED TEST | 70 | 0 | 0 | `0` | Phases 2A (`15`), 2B (`5`), 2C (`11`), 2D (`10`), 2E (`10`), 2F (`8`), 2G (`7`), 2H (`4`) |
| `src/test/milestone2j-acceptance.ts` (`runPhase2JTests`) | EXECUTED TEST | 3 | 0 | 0 | `0` | Config immutability, A/B non-EMA parity, schema & EMA ablation |
| `src/test/run-milestone2.ts` (`runMilestone2AcceptanceSuite`) | EXECUTED TEST | Gate 1+2+3 | 0 | Historical provenance not run (synthetic fallback) | `0` | Orchestrates 2A (70) + 2J (3) + 50,000-candle audit & 4/4 synthetic rejection classes; live UI provenance requires chart feed |
| `src/test/milestone3a-acceptance.ts` (`runPhase3ATests`) | EXECUTED TEST | 9 | 0 | 0 | `0` | MTF contracts |
| `src/test/milestone3b-acceptance.ts` (`runPhase3BTests`) | EXECUTED TEST | 25 | 0 | 0 | `0` | MTF aggregation |
| `src/test/milestone3c-acceptance.ts` (`runPhase3CTests`) | EXECUTED TEST | 20 | 0 | 0 | `0` | Independent HTF features |
| `src/test/milestone3d-acceptance.ts` (`runPhase3DTests`) | EXECUTED TEST | 14 | 0 | 0 | `0` | Causal alignment |
| `src/test/milestone3e-acceptance.ts` (`runPhase3ETests`) | EXECUTED TEST | 9 | 0 | 0 | `0` | Full MTF pipeline integration |
| `src/test/milestone4b-acceptance.ts` (`runPhase4BTests`) | EXECUTED TEST | 22 | 0 | 0 | `0` | Executed with `< /dev/null` so Bun's global `alert()` on intentional negative `DatasetAuditor` assertions does not block stdin |
| `src/test/production-exporter-acceptance.ts` (`runProductionExporterAcceptanceSuite`) | EXECUTED TEST | 10 | 0 | 1 skipped (`Live package UI check requires a browser DOM`) | `0` | Executed with `< /dev/null` for Bun `alert()` in negative `DatasetAuditor` checks |
| `src/test/milestone5b-acceptance.ts` (`runPhase5BAcceptanceSuite`) | EXECUTED TEST | 17 | 0 | 0 | `0` | Export request contract & pre-ZIP enforcement |
| `src/test/milestone5c-acceptance.ts` (`runPhase5CAcceptanceSuite`) | EXECUTED TEST | 18 | 0 | 0 | `0` | BackgroundDataMiner & Job Processor integration |
| `src/data/StreamingDatasetExporter.ts` (`runStreamingExportParityTest(1440)`) | EXECUTED TEST | 1 | 0 | 0 | `0` | Current-build 1440-candle streaming vs. batch M4 CSV/SHA-256/manifest parity |
| `src/test/milestone1-acceptance.ts` (`runMilestone1AcceptanceSuite`) | PARTIALLY EXECUTED / BLOCKED BY ENVIRONMENT | 5 | 0 *(logic)* | Test 6 blocked (`ReferenceError: window is not defined`) | `1` | Tests 1–5 passed across 50,000 candles (1,166 pivots exact legacy match, zero lookahead, lag arithmetic, 16-field prefix invariance). Test 6 requires browser `window` EventTarget at line 323 |
| Standalone PHL / DTFX / VAM / StrictCBC regression suites outside M1, P1, P2 | **NOT FOUND** | — | — | — | — | No separate dedicated test files exist in `src/test/` beyond the 15 listed files |

### Key Verbatim Regression Excerpts

1. **`milestone5d-phase1-acceptance.ts` (`EXIT_CODE=0`):**
```text
Phase 5D Phase 1 Acceptance: 6 passed, 0 failed.
M5DP1_EXIT=0
```
*(Pinned Current-Build V4 Non-Flat 210-Bar SHA-256: `obsA=cbe1d7f400a159f98dba57e5bcc83ebdb6fc45c43b54977640b22cdc8afae4bf`, `obsB=14e0834da10b631a4f450c5e6ce8aa148975a3ebd9acf96f987e124503737908`, `stateA=43f8e26418ae6a1470f3e39ddda002febed09b1439ee8404f2779901532c3a48`, `stateB=4b81371d1ee8f89337e87bc086f065ba87c4b1ffacac1737006edfdbd151d29e`.)*

2. **`milestone2a-acceptance.ts` (`EXIT_CODE=0`):**
```text
📊 ML-R1 PHASE 2A FINAL AUDIT: Tests Executed: 15, Passed: 15, Failed: 0
📊 ML-R1 PHASE 2B FINAL AUDIT: Tests Executed: 5, Passed: 5, Failed: 0
📊 ML-R1 PHASE 2C FINAL AUDIT: Tests Executed: 11, Passed: 11, Failed: 0
📊 ML-R1 PHASE 2D FINAL AUDIT: Tests Executed: 10, Passed: 10, Failed: 0
📊 ML-R1 PHASE 2E FINAL AUDIT: Tests Executed: 10, Passed: 10, Failed: 0
📊 ML-R1 PHASE 2F FINAL AUDIT: Tests Executed: 8, Passed: 8, Failed: 0
📊 ML-R1 PHASE 2G FINAL AUDIT: Tests Executed: 7, Passed: 7, Failed: 0
📊 ML-R1 PHASE 2H FINAL AUDIT: Tests Executed: 4, Passed: 4, Failed: 0
🏆 MILESTONE 2 CORE DEVELOPMENT COMPLETE.
M2A_EXIT=0
```

3. **`milestone2j-acceptance.ts` (`EXIT_CODE=0`) & `run-milestone2.ts` (`EXIT_CODE=0`):**
```text
📊 ML-R1 PHASE 2J FINAL AUDIT: Tests Executed: 3, Passed: 3, Failed: 0
M2J_EXIT=0
...
⚠️ SYNTHETIC ACCEPTANCE PASSED — HISTORICAL PROVENANCE NOT VALIDATED
   ↳ Core Engine (2A-2H):       PASSED
   ↳ Schema Immutability (2J):   PASSED
   ↳ Synthetic Rejections:       4/4 CLASSES VERIFIED (100% ACCOUNTED)
   ↳ Historical Provenance:      NOT RUN (Synthetic fallback used)
M2_EXIT=0
```

4. **Milestones 3A–3E (`EXIT_CODE=0` each):**
```text
📊 ML-R1 PHASE 3A FULL CONTRACT AUDIT:    Tests Executed:  9, Passed:  9, Failed: 0  (M3A_EXIT=0)
📊 ML-R1 PHASE 3B COMPLETE AUDIT:         Tests Executed: 25, Passed: 25, Failed: 0  (M3B_EXIT=0)
📊 ML-R1 PHASE 3C ACCEPTANCE AUDIT:       Tests Executed: 20, Passed: 20, Failed: 0  (M3C_EXIT=0)
ML-R1 PHASE 3D ACCEPTANCE AUDIT:          Tests Executed: 14, Passed: 14, Failed: 0  (M3D_EXIT=0)
📊 ML-R1 PHASE 3E INTEGRATION AUDIT:      Tests Executed:  9, Passed:  9, Failed: 0  (M3E_EXIT=0)
```

5. **`milestone4b-acceptance.ts` (`EXIT_CODE=0`, invoked with `< /dev/null`):**
```text
📊 ML-R1 PHASE 4B FULL ACCEPTANCE AUDIT:
   ↳ Tests Executed:  22
   ↳ Tests Passed:    22
   ↳ Tests Failed:    0
M4B_EXIT=0
```

6. **`production-exporter-acceptance.ts` (`EXIT_CODE=0`, invoked with `< /dev/null`):**
```text
  ✅ Passed: 500-candle production export is deterministic with a mature CBC outcome
  ⏭️ Skipped: Live package UI check requires a browser DOM.
Production Exporter Integrity: 10 passed, 0 failed.
PROD_EXP_EXIT=0
```

7. **`milestone5b-acceptance.ts` (`EXIT_CODE=0`) & `milestone5c-acceptance.ts` (`EXIT_CODE=0`):**
```text
Phase 5B Acceptance: 17 passed, 0 failed.
M5B_EXIT=0

Phase 5C Acceptance: 18 passed, 0 failed.
M5C_EXIT=0
```

8. **`runStreamingExportParityTest(1440)` (`EXIT_CODE=0`):**
```text
✅ Streaming M4 Parity PASSED (1440 candles): 100% byte-for-byte CSV + SHA-256 + manifest parity!
STREAM_PARITY_EXIT=0
```

9. **`milestone1-acceptance.ts` (`EXIT_CODE=1` — Environment Blocker on Test 6):**
```text
🧪 Starting Milestone 1 Acceptance Suite...
  -> Running Test 1: Buffer Capacity & Allocation...
  ✅ Test 1 Passed: All 12 telemetry buffers resized past 50,000 candles.
  -> Running Test 2: Legacy Reference Parity (50,000 candles)...
  ✅ Test 2 Passed: 100% exact match against frozen legacy code across 1166 pivots.
  -> Running Test 3: Candidate Extrema Point-in-Time Integrity...
  ✅ Test 3 Passed: Zero candidate repainting or lookahead across all 50,000 candles.
  -> Running Test 4: Confirmation Lag & Stamping...
  ✅ Test 4 Passed: Confirmation events and lag arithmetic verified for all pivots.
  -> Running Test 5: Full 16-Field Prefix Invariance...
  ✅ Test 5 Passed: Full 16-field teacher prefix invariance established.
  -> Running Test 6: Deterministic Event Delivery, Invalidation & De-duplication...
318 |     let lastEmittedDetail: any = null;
319 |     const alertListener = (e: any) => {
320 |         eventCount++;
321 |         lastEmittedDetail = e.detail;
322 |     };
323 |     window.addEventListener('ecochart-alert', alertListener);
          ^
ReferenceError: window is not defined
      at runMilestone1AcceptanceSuite (/app/applet/src/test/milestone1-acceptance.ts:323:5)
      at /app/applet/[eval]:1:96

Bun v1.4.4 (Linux x64)
M1_EXIT=1
```

---

## 7. Historical A/B Bitwise Parity Verification

*(Category: **HISTORICAL EVIDENCE UNAVAILABLE**)*

- **Parity Status:** `BLOCKED — HISTORICAL BASELINE UNAVAILABLE`
- **Search Performed:** Inspected workspace root, `docs/`, `src/`, `public/`, `.aistudio/`, and checked git state. No `.git` history exists, and no pre-Phase-5D `ML1_CONFIG_A` / `ML1_CONFIG_B` reference CSV/ZIP/JSON baselines or pre-change SHA-256 digests exist on disk.
- **Documentary Confirmation:** `docs/MLR1_PHASE5D_V3_CONTRACT.md` (line 6) and `docs/MLR1_PHASE5D_PHASE1_ACCEPTANCE.md` (Section 1 & Section 2) already formally classify historical V4 compatibility as `NOT PROVEN — NO INDEPENDENT PRE-CHANGE BASELINE AVAILABLE`.
- **Current-Build Regression Constants (Not Historical Proof):** Running `milestone5d-phase1-acceptance.ts` (Group 6) verified that the current build reproduces the 4 pinned current-build 210-bar analytical SHA-256 digests (`obsA`: `cbe1d7f400a159f98dba57e5bcc83ebdb6fc45c43b54977640b22cdc8afae4bf`, `obsB`: `14e0834da10b631a4f450c5e6ce8aa148975a3ebd9acf96f987e124503737908`, `stateA`: `43f8e26418ae6a1470f3e39ddda002febed09b1439ee8404f2779901532c3a48`, `stateB`: `4b81371d1ee8f89337e87bc086f065ba87c4b1ffacac1737006edfdbd151d29e`) and `runStreamingExportParityTest(1440)` confirmed current-build streaming-vs-batch M4 parity. Neither substitutes for an independent pre-change baseline.

---

## 8. Test Totals Breakdown

*(Counting unique tests across executed suites; `run-milestone2.ts` Gate 1+2 overlap with `milestone2a`/`milestone2j` is deduplicated.)*

- **Phase 2 Acceptance (`milestone5d-phase2-acceptance.ts`):** `8` passed, `0` failed, `0` skipped
- **Unique Regression Tests Executed:** `230` passed, `0` logic failures, `1` skipped (`production-exporter-acceptance.ts` browser DOM UI check), `1` blocked/errored by missing browser `window` (`milestone1-acceptance.ts` Test 6)
- **Combined Unique Executed Total:** **`238` passed, `0` logic failures, `1` skipped (browser DOM), `1` blocked by headless CLI environment (`window is not defined`)**

---

## 9. Discrepancies & Environment Observations

1. **Path Mismatch in Audit Checklist vs. Repository Layout:**
   - `StrictCBCZigZagIndicator.ts` resides at `src/indicators/plugins/StrictCBCZigZagIndicator.ts` (not `src/indicators/mlr1/teachers/`).
   - `VolatilityAdjustedMean.ts` resides at `src/indicators/mlr1/trend/VolatilityAdjustedMean.ts` (not `src/indicators/mlr1/teachers/`).
   - `ATR.ts` resides at `src/indicators/mlr1/volatility/ATR.ts` (not `src/indicators/mlr1/teachers/`).
2. **Interactive `alert()` Behavior in Bun CLI (`DatasetAuditor.runCausalityAudit`):**
   - `src/data/AIExporter.ts:2442` invokes `if (typeof alert !== 'undefined') alert(...)` whenever `runCausalityAudit` returns failure. When `milestone4b-acceptance.ts` and `production-exporter-acceptance.ts` exercise intentional negative audit fixtures under Bun `1.4.4`, Bun's global `alert()` awaits a newline on `stdin`. Running with `< /dev/null` resolves the stdin wait cleanly without altering source or test code.
3. **Browser-Only Test Surface:**
   - `milestone1-acceptance.ts` Test 6 requires `window.addEventListener` / `window.removeEventListener` (and `production-exporter-acceptance.ts`'s final check requires `document`). These must be executed via the in-browser test entrypoint (`src/index.ts`) to complete full browser-side regression coverage.

---

## 10. Verdict & Closure Criteria

### Final Verdict: `CONDITIONALLY PASSED — REGRESSION EVIDENCE INCOMPLETE`
*(Historical A/B Parity is also independently **`BLOCKED — HISTORICAL BASELINE UNAVAILABLE`**.)*

- **Why not `REJECTED — FAILURE`:** Zero TypeScript errors (`tsc --noEmit` exit `0`), `8/8` Phase 2 acceptance tests passed (`exit 0`), `225` additional headless regression tests passed (`exit 0`), `5/5` Milestone 1 pure-engine tests passed, and all read-only source audit invariants hold.
- **Why not `ACCEPTED`:**
  1. `milestone1-acceptance.ts` Test 6 exited `1` in headless Bun CLI due to missing browser `window` (`ReferenceError: window is not defined`), `production-exporter-acceptance.ts` skipped its browser DOM check, `run-milestone2.ts` Gate 3 fell back to synthetic candles rather than live `SOLUSDT 1m` feed provenance, and no standalone per-teacher regression files exist beyond Phase 1/2.
  2. Pre-Phase-5D `ML1_CONFIG_A` / `ML1_CONFIG_B` historical baselines do not exist on disk or in git history (`BLOCKED — HISTORICAL BASELINE UNAVAILABLE`).

### Required Follow-Up Actions to Reach Full Closure
1. Run `runMilestone1AcceptanceSuite()`, `runMilestone2AcceptanceSuite(realCandles, 'SOLUSDT', '1m')`, and `runProductionExporterAcceptanceSuite()` in the live browser runtime (via `src/index.ts`) to close Milestone 1 Test 6, live Milestone 2 Gate 3 provenance, and the Production Exporter UI DOM check.
2. Provide an independent pre-Phase-5D `ML1_CONFIG_A` / `ML1_CONFIG_B` baseline artifact or commit reference to perform true historical A/B bitwise parity verification.

---

## 11. Read-Only Compliance Attestation

No files under `src/`, `docs/`, `package.json`, `tsconfig.json`, fixtures, or baselines were modified during this execution and verification audit. The sole file created is `/PHASE2_ACCEPTANCE_EXECUTION_REPORT.md`.
