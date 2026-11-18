# ML-R1 Phase 2 — Browser Regression Execution Report

**Final Verdict:** `BROWSER REGRESSION PASSED`

---

## Phase 2 Status

| Gate / Workstream | Status | Evidence Summary |
| :--- | :--- | :--- |
| **Browser execution** | **PASSED** | `runMilestone1AcceptanceSuite()`, `runMilestone2AcceptanceSuite(realCandles, 'SOLUSDT', '1m')`, `runProductionExporterAcceptanceSuite()`, and the combined `#btn-ai-export-audit` UI flow all passed in HeadlessChrome `155.0.8059.12` (`0` unexpected console/page errors, `0` skipped DOM checks). |
| **Phase 2 acceptance suites** | **PASSED** | `tsc --noEmit` (`0` errors), `src/test/milestone5d-phase2-acceptance.ts` (`8/8`), `milestone5d-phase1-acceptance.ts` (`6/6`), plus all Milestone 1–5C suites verified (`PHASE2_ACCEPTANCE_EXECUTION_REPORT.md`). |
| **Frozen source integrity** | **PASSED** | Zero repository source or test files modified; all 6 frozen Phase 2 implementation and test files match `PHASE2_FROZEN_FILES.sha256` (`sha256sum -c` 6/6 `OK`). |
| **Historical A/B parity** | **UNRESOLVED** | Separate, explicitly documented limitation (`BLOCKED — HISTORICAL BASELINE UNAVAILABLE`): no pre-Phase-5D git history or historical `ML1_CONFIG_A` / `ML1_CONFIG_B` baseline artifact exists in the workspace. Not a browser-test failure. |

**Overall:** Phase 2 implementation and browser regression evidence are now substantially complete. Historical A/B parity is retained as a separate, explicitly documented limitation rather than being treated as a browser-test failure.

**Recommendation:** Accept the browser regression report and close the browser-regression blocker. Do not reopen Phase 2 or modify its frozen implementation files merely to address the historical-baseline limitation.

---

## 1. Environment & Browser Setup

| Component | Verified Value |
| :--- | :--- |
| **Application Entry Point** | `http://localhost:3000/` (`index.html` -> `<script type="module">import { WorkspaceManager } from '/src/index.ts'; WorkspaceManager.init();</script>`) |
| **Browser Binary** | Google Chrome for Testing / Headless Shell `155.0.8059.12` (`/ms-playwright/chrome-headless-shell-linux64/chrome-headless-shell`) |
| **User-Agent** | `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/155.0.8059.12 Safari/537.36` |
| **Browser Automation** | Playwright `1.64.0-alpha-1790635538000` (`/usr/local/share/bun-global/node_modules/playwright/index.mjs`) |
| **Launch Flags** | `--headless`, `--no-sandbox`, `--use-gl=angle`, `--use-angle=swiftshader`, `--enable-unsafe-swiftshader` |
| **Viewport** | `1440x900` |
| **Real Market Data Feed** | Live Binance Spot REST API (`https://api.binance.com/api/v3/klines?symbol=SOLUSDT&interval=1m&...`), fetched in-browser without mocks |
| **Run Window (UTC)** | `2026-11-18T06:44:23.859Z` to `2026-11-18T06:46:23.561Z` |

### Global Entry Point Inspection (`src/index.ts`)
- `WorkspaceManager.init()` (`src/index.ts:6062–6063`) binds `window.runMilestone1AcceptanceSuite` and `window.runMilestone2AcceptanceSuite`.
- `runProductionExporterAcceptanceSuite` is imported at `src/index.ts:109` and invoked directly by `runAiExportAudit()` (`src/index.ts:4887`), though it is not assigned to `window.*` (`typeof window.runProductionExporterAcceptanceSuite === 'undefined'`).
- The repository's unified UI browser test entry point is `#btn-topbar-ai-export` -> `#btn-ai-export-audit` (`runAiExportAudit()` in `src/index.ts:4745–4994`), which mines 7 days (`10,080` contiguous `1m` candles) for active `SOLUSDT 1m` and executes Milestones 1–4, Production Exporter, M5B, M5C, Phase 0 Baseline, Streaming M4 Parity, and 500-candle Deterministic Reconstruction in sequence.

---

## 2. Exact Execution Commands & Invocation Methods

Each suite was executed in its own clean Playwright browser context against `http://localhost:3000/`, followed by the full combined UI runner via `#btn-topbar-ai-export` -> `#btn-ai-export-audit`. No source files, fixtures, DOM mocks, or `window` shims were used.

1. **Suite 1 (Isolated Browser Context):**
   - Navigated to `http://localhost:3000/`, waited for `WorkspaceManager.init()` global bindings (`typeof window.runMilestone1AcceptanceSuite === 'function'`), and executed:
     ```js
     window.runMilestone1AcceptanceSuite()
     ```
2. **Suite 2 (Isolated Browser Context with Live Binance `SOLUSDT 1m` Provenance):**
   - Navigated to `http://localhost:3000/`, fetched 7 days (`10,080` contiguous closed `1m` candles across 11 paginated requests from `https://api.binance.com/api/v3/klines`) directly inside the browser page, stored as `window.__realSolCandles`, and executed:
     ```js
     window.runMilestone2AcceptanceSuite(window.__realSolCandles, 'SOLUSDT', '1m')
     ```
3. **Suite 3 (Isolated Browser Context with Full Live Application DOM):**
   - Navigated to `http://localhost:3000/`, waited for full UI/DOM initialization (including `#ai-export-modal` and `.ai-pack-card[data-pack="stream_folder"]`), dynamically imported the Vite-served browser module, and executed:
     ```js
     const mod = await import('/src/test/production-exporter-acceptance.ts');
     await mod.runProductionExporterAcceptanceSuite();
     ```
4. **Combined Official Entry Point (UI Workflow):**
   - Navigated to `http://localhost:3000/` (`BTCUSDT` default) -> clicked `#btn-symbol` -> filled `#symbol-search-input` with `SOLUSDT` -> clicked `#symbol-list .symbol-item` (`SOLUSDT`) -> clicked `#tf-group .tf-btn[data-tf="1m"]` -> verified active chart header (`SOLUSDT +0.30% ▼`) -> clicked `#btn-topbar-ai-export` -> clicked `#btn-ai-export-audit` (`runAiExportAudit()`).
   - Monitored `#ai-export-loading-detail` until completion (`✅ All Milestones 1 to 4 Passed! Check DevTools console.`).
5. **Intentional Alert Dialog Handling:**
   - Playwright's `page.on('dialog', ...)` recorded and accepted browser `alert()` dialogs triggered intentionally by `DatasetAuditor.runCausalityAudit()` (`src/data/AIExporter.ts:2442`) during negative forgery/leakage tests so browser execution could proceed unblocked while capturing every dialog verbatim.

---

## 3. Detailed Suite Execution Results

### Summary Table

| Execution Target | Status | Returned / UI Outcome | Tests (Pass / Fail / Skip) | Duration | Unexpected Console / Page Errors |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `runMilestone1AcceptanceSuite()` | **PASSED** | `true` | `6 / 0 / 0` | `199 ms` | `0 / 0` |
| `runMilestone2AcceptanceSuite(realCandles, 'SOLUSDT', '1m')` | **PASSED** | `true` (`READY FOR FORMAL FREEZE`) | `73 / 0 / 0` + Gate 3 Provenance & Quantitative Audit | `5,831 ms` | `0 / 0` |
| `runProductionExporterAcceptanceSuite()` | **PASSED** | `true` (live DOM check executed) | `11 / 0 / 0` | `16,385 ms` | `0` unexpected (`2` expected negative-test `console.error`s) / `0` |
| Combined UI Runner (`#btn-ai-export-audit`) | **PASSED** | `✅ All Milestones 1 to 4 Passed! Check DevTools console.` | M1 (`6/6`), M2 (`73/73`+Gate3), M3 (`77/77`), M4B (`22/22`), ProdExp (`11/11`), M5B (`17/17`), M5C (`18/18`), Parity/Recon | `68,428 ms` | `0` unexpected (`4` expected negative-test `console.error`s) / `0` |

---

### 3.1 `runMilestone1AcceptanceSuite()`
- **Browser / Version:** HeadlessChrome `155.0.8059.12`
- **Invocation:** `window.runMilestone1AcceptanceSuite()`
- **Return Value:** `true`
- **Duration:** `199 ms`
- **Counts:** `6` executed, `6` passed, `0` failed, `0` skipped
- **Assertion Breakdown:**
  - **Test 1 (Buffer Capacity & Allocation):** Passed — all 12 telemetry buffers resized past `50,000` candles for both `calculate()` and `update(ds, true)`.
  - **Test 2 (Legacy Reference Parity):** Passed — `100%` exact match against frozen legacy StrictCBC across `1,166` pivots over `50,000` candles.
  - **Test 3 (Candidate Extrema Point-in-Time Integrity):** Passed — zero candidate repainting or lookahead across `50,000` candles.
  - **Test 4 (Confirmation Lag & Stamping):** Passed — confirmation events and lag arithmetic verified for all pivots.
  - **Test 5 (Full 16-Field Prefix Invariance):** Passed — `1,000`-bar prefix matches `50,000`-bar run across all 16 teacher fields.
  - **Test 6 (Deterministic Event Delivery, Invalidation & De-duplication):** Passed — real `window.addEventListener('ecochart-alert', ...)` in browser DOM verified all 6 lifecycle steps (details in Section 4).
- **Console Errors / Unhandled Exceptions / Dialogs:** `0` / `0` / `0`

---

### 3.2 `runMilestone2AcceptanceSuite(realCandles, 'SOLUSDT', '1m')`
- **Browser / Version:** HeadlessChrome `155.0.8059.12`
- **Invocation:** `window.runMilestone2AcceptanceSuite(window.__realSolCandles, 'SOLUSDT', '1m')`
- **Historical Data Provenance:**
  - Fetched live from `https://api.binance.com/api/v3/klines` across `11` paginated requests
  - Candle count: `10,080` contiguous `SOLUSDT 1m` candles
  - Range: `2026-11-11T06:44:00.000Z` (`1794379440000`) to `2026-11-18T06:43:00.000Z` (`1794984180000`)
- **Return Value:** `true`
- **Duration:** `5,831 ms`
- **Gate & Test Breakdown:**
  - **Gate 1 (`runPhase2ATests`, Phases 2A–2H):** `70` executed, `70` passed, `0` failed, `0` skipped (`2A`: `15/15`, `2B`: `5/5`, `2C`: `11/11`, `2D`: `10/10`, `2E`: `10/10`, `2F`: `8/8`, `2G`: `7/7`, `2H`: `4/4`).
  - **Gate 2 (`runPhase2JTests`, Phase 2J Schema & Immutability):** `3` executed, `3` passed, `0` failed, `0` skipped.
  - **Gate 3 (`generatePhase2JReports`, Quantitative Invariant, Provenance & Synthetic Rejection Audit):** Passed:
    - Provenance reported: `REAL HISTORICAL FEED (SOLUSDT 1m) | Range: 2026-11-11T06:44:00.000Z to 2026-11-18T06:43:00.000Z`
    - Observations audited (Config A & Config B): `10,080` accepted, `0` rejected, `0` mask mismatches, `0` missing/extra keys, `0` non-boolean validity flags, `0` fallback violations, `0` non-finite accepted values, `0` rejected state mutations.
    - Companion Synthetic Rejection Invariant Audit: `4/4` rejection classes verified (`1` out-of-order, `1` duplicate, `1` non-finite OHLCV, `1` structurally invalid OHLC; `0` state mutations).
    - Final Gate Banner: `Historical Provenance: SOLUSDT 1m VERIFIED` | `Status: READY FOR FORMAL FREEZE`.
- **Console Errors / Unhandled Exceptions / Dialogs:** `0` / `0` / `0`

---

### 3.3 `runProductionExporterAcceptanceSuite()`
- **Browser / Version:** HeadlessChrome `155.0.8059.12`
- **Invocation:** `import('/src/test/production-exporter-acceptance.ts')` -> `await mod.runProductionExporterAcceptanceSuite()` inside live `http://localhost:3000/` DOM (and re-executed inside `#btn-ai-export-audit`)
- **Return Value:** `true`
- **Duration:** `16,385 ms`
- **Counts:** `11` executed, `11` passed, `0` failed, `0` skipped
- **Assertion Breakdown:**
  1. `Raw rejected candles are accounted before feature processing` — **Passed**
  2. `Non-positive OHLC prices are rejected and reconciled as raw source rows` — **Passed**
  3. `Historical fetch applies inclusive bounds and excludes incomplete klines` — **Passed**
  4. `Seven-day fetch uses inclusive open-time bounds and returns exactly 10,080 rows when complete` — **Passed**
  5. `Missing first or last seven-day candle fails exact boundary reconciliation` — **Passed**
  6. `Historical fetch preserves duplicates for source-quality accounting` — **Passed**
  7. `Historical fetch rejects response candles outside requested boundaries` — **Passed**
  8. `Custom date post-validation rejects out-of-range data` — **Passed**
  9. `Generated archive has exact physical entries, bytes, and row counts` — **Passed**
  10. `500-candle production export is deterministic with a mature CBC outcome` — **Passed**
  11. `Live package UI exposes only the supported streaming M4 folder export` — **Passed** (verified in live browser DOM: `[data-pack="csv"] === null`, `[data-pack="zip"] === null`, `.ai-pack-card[data-pack="stream_folder"]` count `=== 1`, `#ai-export-rr === null`, `#ai-export-horizon === null`; **NOT skipped**).
- **Console Errors / Unhandled Exceptions / Dialogs:** `2` intentional negative-test `console.error` calls + `4` intentional `alert()` dialogs (from negative `DatasetAuditor.runCausalityAudit()` assertions); `0` unexpected errors or page exceptions.

---

### 3.4 Combined Official Browser Entry Point (`#btn-topbar-ai-export` -> `#btn-ai-export-audit`)
- **Active Chart State Verified via UI:** `SOLUSDT +0.30% ▼` on `1m` timeframe
- **Provenance Mined via `BackgroundDataMiner.mineHistoricalCandles`:** `10,080` contiguous candles (`2026-11-11T06:45:00.000Z` to `2026-11-18T06:44:00.000Z`)
- **Duration:** `68,428 ms`
- **Final UI Status (`#ai-export-loading-detail`):** `✅ All Milestones 1 to 4 Passed! Check DevTools console.`
- **Suites Executed & Passed Inside `runAiExportAudit()`:**
  - Milestone 1 (`runMilestone1AcceptanceSuite`): **Passed** (`6/6`)
  - Milestone 2 (`runMilestone2AcceptanceSuite(realCandles, 'SOLUSDT', '1m')`): **Passed** (`73/73` + Gate 3 `SOLUSDT 1m VERIFIED` / `READY FOR FORMAL FREEZE`)
  - Milestone 3 (`runPhase3ATests`–`runPhase3ETests`): **Passed** (`77/77`: `3A` `9/9`, `3B` `25/25`, `3C` `20/20`, `3D` `14/14`, `3E` `9/9`)
  - Milestone 4B (`runPhase4BTests`): **Passed** (`22/22`)
  - Production Exporter (`runProductionExporterAcceptanceSuite`): **Passed** (`11/11`, `0` skipped)
  - Milestone 5B (`runPhase5BAcceptanceSuite`): **Passed** (`17/17`)
  - Milestone 5C (`runPhase5CAcceptanceSuite`): **Passed** (`18/18`)
  - Phase 0 Export Baseline (`runPhase0ExportBaseline(1440)`): **Passed** (`1440` candles, `buildMs: 878`, `zipVerifyMs: 1538`)
  - Streaming M4 Parity (`runStreamingExportParityTest(1440)`): **Passed** (`100% byte-for-byte CSV + SHA-256 + manifest parity`)
  - Deterministic Reconstruction (`500` real `SOLUSDT` candles): **Passed** (`bitwise parity across CSV artifacts, audit results, and manifest metrics`)

---

## 4. Milestone 1 Test 6 Investigation & Resolution Verification

In the earlier headless Node/tsx run, Milestone 1 Test 6 (`src/test/milestone1-acceptance.ts:323–359`) failed immediately with `ReferenceError: window is not defined` when registering `window.addEventListener('ecochart-alert', alertListener)`.

In genuine Chromium DOM execution (`http://localhost:3000/`):
- **DOM Event Delivery Confirmed:** `StrictCBCZigZagIndicator.update()` dispatched `CustomEvent('ecochart-alert', ...)` on `window` and `alertListener` received events accurately in real browser DOM.
- **All 6 Sub-Assertions Verified:**
  1. Unclosed tick on Bar 2 suppressed emission (`eventCount === 0`).
  2. Closed tick on Bar 2 emitted `'Swing High'` (`eventCount === 1`).
  3. Repeated closed tick suppressed duplicate emission via structural calculation cache (`eventCount === 1`).
  4. Forced cache bypass (`lastStateHash = ''`) de-duplicated via `notifiedPivots` (`eventCount === 1`).
  5. Mid-series revision on Bar 1 suppressed duplicate emission (`eventCount === 1`).
  6. Subsequent closed bullish flip on Bar 4 emitted `'Swing Low'` (`eventCount === 2`).
- **Resolution:** Confirmed Test 6's prior CLI failure was strictly caused by the absence of a browser `window` global in Node/tsx; under genuine browser execution, Test 6 passes cleanly (`199 ms` full suite runtime, zero errors).

---

## 5. Browser Console Errors, Unhandled Exceptions & Dialogs

- **Unhandled Page Exceptions (`pageerror`):** `0` across all 4 browser sessions (initial load + M1 + M2 + Production Exporter + Combined UI Audit).
- **Initial App Boot (`http://localhost:3000/`):** `0` console errors, `0` page errors.
- **Milestone 1 Standalone:** `0` console errors, `0` dialogs.
- **Milestone 2 Standalone (`SOLUSDT 1m`):** `0` console errors, `0` dialogs.
- **Production Exporter Standalone:**
  - `2` intentional negative-test `console.error` entries emitted by `DatasetAuditor.runCausalityAudit()` (`src/data/AIExporter.ts:1851, 1667`) when fed forged MTF context and forged cached pivot prices:
    1. `DatasetAuditor Error: 1 MTF context provenance or availability checks failed.`
    2. `DatasetAuditor Error: cached pivots differ from the native confirmed-pivot sequence.`
  - `4` intentional negative-test `alert()` dialogs (`"⚠️ ML-R1 Audit Failed!\nCheck developer console."` at `src/data/AIExporter.ts:2442`) triggered by those 4 negative `runCausalityAudit` checks (forged MTF context, future pivot label leak, pre-confirmation teacher leak, forged/same-type pivot sequence).
  - `0` unexpected console errors.
- **Combined UI Audit (`#btn-ai-export-audit`):**
  - `4` intentional negative-test `console.error` entries emitted by `DatasetAuditor.runCausalityAudit()` across M4B and Production Exporter negative tests (`src/data/AIExporter.ts:1663, 1712, 1851, 1667`):
    1. `DatasetAuditor Error: cachedPivots must be supplied as an array.`
    2. `❌ DatasetAuditor Error: accepted row 3 does not match the dataStore bar.`
    3. `DatasetAuditor Error: 1 MTF context provenance or availability checks failed.`
    4. `DatasetAuditor Error: cached pivots differ from the native confirmed-pivot sequence.`
  - `9` intentional negative-test `alert()` dialogs (`"⚠️ ML-R1 Audit Failed!\nCheck developer console."` at `src/data/AIExporter.ts:2442`) across M4B (`4`), Production Exporter (`4`), and M5B (`1`).
  - `0` unexpected console errors.

---

## 6. Source Integrity Verification

SHA-256 checksums of all 6 Phase 2 frozen files matched 100% before and after browser regression execution (zero repository source or test files were modified):

| File | Pre-Execution SHA-256 | Post-Execution SHA-256 | Match |
| :--- | :--- | :--- | :--- |
| `src/indicators/mlr1/teachers/StrategyEventTypes.ts` | `88e07fa2336f047107491fe12188cc2dbbb3c2888da9bf660b6ff0a52ddd9fda` | `88e07fa2336f047107491fe12188cc2dbbb3c2888da9bf660b6ff0a52ddd9fda` | **EXACT** |
| `src/indicators/mlr1/teachers/ProtectedHighsLowsTeacher.ts` | `cf940f696bfbd08826d08f47f2a6088a620b773581d4c79950fe6934fb5aa2b7` | `cf940f696bfbd08826d08f47f2a6088a620b773581d4c79950fe6934fb5aa2b7` | **EXACT** |
| `src/indicators/mlr1/teachers/DTFXAlgoZonesTeacher.ts` | `2fed4e888866a5fc022edcb89e4f5473029c4808f5bc3c480edf9a7ab225b6b0` | `2fed4e888866a5fc022edcb89e4f5473029c4808f5bc3c480edf9a7ab225b6b0` | **EXACT** |
| `src/indicators/mlr1/trend/VolatilityAdjustedMean.ts` | `ff2e06c0d3d84123eb3bf3a5f1a7171e46258549350b25663fb36b229eaa2a65` | `ff2e06c0d3d84123eb3bf3a5f1a7171e46258549350b25663fb36b229eaa2a65` | **EXACT** |
| `src/indicators/mlr1/volatility/ATR.ts` | `5de891584535040ae6136455ce54beafdc50f3fd84e5b1f9a4074dc3a67759f8` | `5de891584535040ae6136455ce54beafdc50f3fd84e5b1f9a4074dc3a67759f8` | **EXACT** |
| `src/test/milestone5d-phase2-acceptance.ts` | `4809b3014c4e71c8449cdf67e535e612f3acd653d723f91d6d414f621760c070` | `4809b3014c4e71c8449cdf67e535e612f3acd653d723f91d6d414f621760c070` | **EXACT** |

---

## 7. Remaining Blockers & Audit Evidence Retention

- **Browser Regression Blocker:** **CLOSED.** All three required browser regression suites (`runMilestone1AcceptanceSuite`, `runMilestone2AcceptanceSuite(realCandles, 'SOLUSDT', '1m')`, `runProductionExporterAcceptanceSuite`) plus the full `#btn-ai-export-audit` combined UI pipeline passed cleanly in HeadlessChrome `155.0.8059.12`.
- **Historical A/B Parity (`UNRESOLVED` — Separate Documented Limitation):** No pre-Phase-5D git commit history or historical `ML1_CONFIG_A` / `ML1_CONFIG_B` baseline artifact exists in the workspace (`BLOCKED — HISTORICAL BASELINE UNAVAILABLE`). This is kept as an independent limitation rather than a browser-test failure; Phase 2 remains closed and frozen without source modifications.
- **Minor Observation (Non-Blocking):** `runProductionExporterAcceptanceSuite` is wired into `runAiExportAudit()` (`src/index.ts:4887`) rather than exposed on `window.*` alongside `runMilestone1AcceptanceSuite` and `runMilestone2AcceptanceSuite`. No source change was made as Phase 2 is frozen.

### Retained Audit Evidence Artifacts
The following audit artifacts are retained together in the workspace root for independent verification:
1. `PHASE2_BROWSER_REGRESSION_REPORT.md` — Full browser regression execution report and Phase 2 closure status.
2. `PHASE2_BROWSER_RUN_LOGS.json` — Complete verbatim console logs, timings, live Binance `SOLUSDT 1m` fetch metadata, dialog records, and error/exception telemetry from Chromium `155.0.8059.12`.
3. `PHASE2_FROZEN_FILES.sha256` — Six-file SHA-256 manifest verifiable anytime via `sha256sum -c PHASE2_FROZEN_FILES.sha256`.
