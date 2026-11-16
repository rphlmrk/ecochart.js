# ML-R1 Phase 5D — Phase 1 Acceptance Record

**Verdict:** `CONDITIONAL ACCEPTANCE`  
**Scope Covered:** Phase 0 Contract (`docs/MLR1_PHASE5D_V3_CONTRACT.md`) + Phase 1 Tier A Modules (`Exhaustion.ts`, `VolumeCandleSize.ts`, `VolatilityAdjustedMean.ts`, `ML1FeatureEngine.ts` `stateVersion: 5`, `ML1_CONFIG_C_v1`)  
**Frozen Constraint:** Documentation completion does **not** upgrade historical V4 compatibility to proven or alter the `CONDITIONAL ACCEPTANCE` verdict.

---

## 1. Verification Taxonomy (Strict Separation)

All verification claims in Phase 1 are separated into three non-interchangeable categories:

| Verification Category | Scope | Phase 1 Status | Basis |
| :--- | :--- | :--- | :--- |
| **1. Contract Specification Verification** | Phase 0 math formulas, warmup boundaries, `ML1_CONFIG_C` isolation, `StrategyEvent` schema, `eventDiscriminator` rules, final-bar & `v3` censoring semantics, `15m`-only MTF scope | **SPECIFIED / FROZEN** (runtime enforcement deferred where noted in Section 3) | `docs/MLR1_PHASE5D_V3_CONTRACT.md` |
| **2. Runtime Implementation Verification** | Pure Phase 1 modules (`Exhaustion`, `VolumeCandleSize`, `VAM`), `validateML1ConfigV5`, `validateRestoredV5State` / `validateVAMState`, embedded V4 validation, 750-bar restoration, V4-vs-V5 current-build delegation parity, Milestones 1–5C | **PASSED (Current Build)** | Remediation execution report (`milestone5d-phase1-acceptance.ts` + Milestones 1–5C) |
| **3. Historical Compatibility Verification** | Bitwise parity of current V4 (`ML1_CONFIG_A` / `ML1_CONFIG_B`) against an independent pre-Phase-5D artifact, commit, or captured baseline | **`NOT PROVEN — NO INDEPENDENT PRE-CHANGE BASELINE AVAILABLE`** | No `.git` history or pre-Phase-5D frozen output snapshot exists in the repository |

---

## 2. Historical V4 Compatibility & Current-Build Regression Constants

- **Historical V4 Compatibility Status:**  
  **`NOT PROVEN — NO INDEPENDENT PRE-CHANGE BASELINE AVAILABLE`**
- **Milestones 1–5C & Frozen V4:** Unmodified.
- **Current-Build Analytical Regression Constants (NOT Historical Proof):**  
  The following SHA-256 digests were captured from the **current build's** 210-bar non-flat alternating `CONFIG_A` / `CONFIG_B` analytical fixture in `src/test/milestone5d-phase1-acceptance.ts` (Group 6). They serve **only** as future drift-detection constants for the current build and **must never be reinterpreted as pre-Phase-5D historical compatibility evidence**:
  - Fixture: 210-bar alternating `[100->104 vol 100 / 104->100 vol 200, TR=8]` (`CONFIG_A`: 93 keys; `CONFIG_B`: 120 keys)
  - `current_build_nonflat_obsA_sha256` (`current_build_only`): `cbe1d7f400a159f98dba57e5bcc83ebdb6fc45c43b54977640b22cdc8afae4bf`
  - `current_build_nonflat_obsB_sha256` (`current_build_only`): `14e0834da10b631a4f450c5e6ce8aa148975a3ebd9acf96f987e124503737908`
  - `current_build_nonflat_stateA_sha256` (`current_build_only`): `43f8e26418ae6a1470f3e39ddda002febed09b1439ee8404f2779901532c3a48`
  - `current_build_nonflat_stateB_sha256` (`current_build_only`): `4b81371d1ee8f89337e87bc086f065ba87c4b1ffacac1737006edfdbd151d29e`

---

## 3. Deferred Items (Not Implemented or Runtime-Verified in Phase 1)

The following items are **contract-specified only** in `docs/MLR1_PHASE5D_V3_CONTRACT.md` and remain **DEFERRED** to their authorized implementation phases (not promoted to `PASS`):

| Deferred Item | Authorized Phase | Notes |
| :--- | :--- | :--- |
| **`StrategyEvent` runtime type & constructors** | **Phase 2** (Gate 1) | Contract defined in `MLR1_PHASE5D_V3_CONTRACT.md`; no runtime `StrategyEvent` code exists yet |
| **Deterministic `eventDiscriminator` runtime derivation & collision checks** | **Phase 2** (Gate 1) | Per-strategy derivation (`pivot.id`, `'PH'/'PL'`, `zoneId/_R#`, `'BUY'/'SELL'`) must be tested against simultaneous/overlapping events |
| **Event-ID uniqueness & deterministic sort validation** | **Phase 2** (Gate 1) | Runtime verification of `(confirmationBarIndex, strategyId, eventType, eventId)` ordering |
| **Final-bar (`entryTimestamp: null`) runtime handling** | **Phase 2** (Gate 1) | Live teacher handling when `confirmationBarIndex === acceptedRows.length - 1` |
| **Teacher engines (`PHL_BOS_MSS`, `DTFX_ZONES`, `StrictCBC`/`VAM` adapters)** | **Phase 2–3** | Not yet implemented; deferred until Phase 2 Gate 1 passes |
| **`v3` multi-horizon (`60/120/180`) outcome replay & export censoring (`excludedMissingNextOpen`, `excludedIncompleteHorizon`)** | **Phase 4** | `v2` remains frozen and default; `v3` export exclusion and `15m`-only MTF removal in v3 pipeline deferred to Phase 4 |
| **Chart UI indicator plugins & visual-vs-engine parity** | **Phase 5** | Visual validation checklist deferred to Phase 5 |

---

## 4. Phase 2 Entry Condition (Mandatory Gate 1)

Phase 2 may begin **only after** this acceptance record is saved and frozen.

**Phase 2 Gate 1 (First Acceptance Milestone):**  
Before implementing broader teacher logic (`PHL_BOS_MSS`, `DTFX_ZONES`), Phase 2 must first implement and verify:
1. The actual `StrategyEvent` runtime contract (`StrategyEventTypes.ts`),
2. Deterministic `eventDiscriminator` derivation across all four `StrategyId` types and collision resistance on simultaneous same-bar events,
3. `eventId` global uniqueness and deterministic `(confirmationBarIndex, strategyId, eventType, eventId)` ordering, and
4. Final-bar semantics (`entryBarIndex = confirmationBarIndex + 1`, `entryTimestamp = null` when no next accepted candle exists).
