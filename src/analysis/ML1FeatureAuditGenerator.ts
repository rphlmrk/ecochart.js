import { createInitialML1FeatureState, stepML1Features } from '../indicators/mlr1/ML1FeatureEngine';
import { ML1_CONFIG_A, ML1_CONFIG_B } from '../indicators/mlr1/ML1FeatureConfigs';
import type { ML1Candle, ValidatedML1FeatureConfig } from '../indicators/mlr1/ML1FeatureTypes';

interface FeatureReport {
    featureName: string;
    validCount: number;
    invalidCount: number;
    coveragePct: number;
    firstValidBar: number;
}

interface CorrelationReport {
    feature1: string;
    feature2: string;
    correlation: number;
    jointlyValidCount: number;
}

export interface ConfigAuditMetrics {
    acceptedCount: number;
    rejectedCount: number;
    maskMismatchCount: number;
    missingKeysCount: number;
    extraKeysCount: number;
    nonBooleanValidity: number;
    fallbackViolations: number;
    nonFiniteAcceptedValues: number;
    rejectedStateMutations: number;
    rejectionBreakdown: {
        outOfOrder: number;
        duplicate: number;
        nonFiniteOhlcv: number;
        structuralOhlc: number;
    };
}

export interface Phase2JAuditResult {
    passed: boolean;
    provenanceValidated: boolean;
    syntheticRejectionPassed: boolean;
    configA: ConfigAuditMetrics | null;
    configB: ConfigAuditMetrics | null;
}

class SeededRNG {
    private s: number;
    constructor(seed = 42) {
        this.s = seed;
    }
    next(): number {
        let t = (this.s += 0x6d2b79f5);
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }
}

/**
 * Creates a deterministic synthetic sequence preserving chronological flaws
 * (out-of-order, duplicates, gaps, flat candles) without sorting them away.
 */
function generateDeterministicDataset(count: number, seed = 42): ML1Candle[] {
    const rng = new SeededRNG(seed);
    let price = 100.0;
    let time = 1700000000000;

    const candles: ML1Candle[] = [];

    for (let i = 0; i < count; i++) {
        const delta = Math.sin(i / 15) * 1.5 + (rng.next() - 0.49) * 0.8;
        let open = price;
        let close = open + delta;
        let high = Math.max(open, close) + rng.next() * 0.6;
        let low = Math.min(open, close) - rng.next() * 0.6;
        let volume = 100 + Math.abs(Math.sin(i / 8)) * 80 + (rng.next() - 0.5) * 40;

        // 1. Inject true flat candle (High === Low === Open === Close)
        if (i % 250 === 0 && i > 0) {
            high = open;
            low = open;
            close = open;
            volume = 0;
        }

        // 2. Inject zero volume
        if (i % 180 === 0 && i > 0) {
            volume = 0;
        }

        candles.push({ time, open, high, low, close, volume: Math.max(0, volume) });
        price = close;
        time += 60000;

        // 3. Inject major discontinuity gap (10 minutes)
        if (i === Math.floor(count / 2)) {
            time += 600000;
        }
        // 4. Inject out-of-order candle (DO NOT SORT AWAY)
        else if (i === Math.floor(count / 3)) {
            candles.push({ time: time - 120000, open, high, low, close, volume: 50 });
        }
        // 5. Inject duplicate timestamp
        else if (i === Math.floor(count / 4)) {
            candles.push({ time: time - 60000, open, high, low, close, volume: 50 });
        }
        // 6. Inject corrupted NaN
        else if (i === Math.floor(count / 5)) {
            candles.push({ time, open, high: NaN, low, close, volume: 50 });
            time += 60000;
        }
        // 7. Inject structurally invalid OHLC relationship (High < Low)
        else if (i === Math.floor(count / 6)) {
            candles.push({ time, open: 100, high: 90, low: 110, close: 100, volume: 50 });
            time += 60000;
        }
    }

    return candles; // Chronological anomalies intentionally preserved
}

/**
 * Numerically stable two-pass Pearson correlation.
 * Prevents catastrophic floating-point cancellation.
 */
function calculatePearson(x: number[], y: number[]): number {
    const n = x.length;
    if (n < 2 || n !== y.length) return NaN;

    let meanX = 0;
    let meanY = 0;
    for (let i = 0; i < n; i++) {
        meanX += x[i];
        meanY += y[i];
    }
    meanX /= n;
    meanY /= n;

    let sumDxDy = 0;
    let sumDx2 = 0;
    let sumDy2 = 0;

    for (let i = 0; i < n; i++) {
        const dx = x[i] - meanX;
        const dy = y[i] - meanY;
        sumDxDy += dx * dy;
        sumDx2 += dx * dx;
        sumDy2 += dy * dy;
    }

    const denom = Math.sqrt(sumDx2 * sumDy2);
    if (denom === 0 || !Number.isFinite(denom)) return NaN;
    const r = sumDxDy / denom;
    return Number.isFinite(r) ? r : NaN;
}

export function generatePhase2JReports(
    sourceCandles?: ML1Candle[],
    activeSymbol?: string,
    activeTimeframe?: string
): Phase2JAuditResult {
    const historicalInputProvided = sourceCandles !== undefined;
    const isHistorical = historicalInputProvided;

    if (isHistorical && (!Array.isArray(sourceCandles) || sourceCandles.length === 0)) {
        console.error('❌ PHASE 2J AUDIT ABORTED: Historical input was provided but contains no candles.');
        return {
            passed: false,
            provenanceValidated: false,
            syntheticRejectionPassed: false,
            configA: null,
            configB: null
        };
    }

    let provenance = '';
    let validationErrors = 0;

    if (isHistorical) {
        if (activeSymbol !== 'SOLUSDT') {
            console.error(`❌ Provenance Error: Expected symbol 'SOLUSDT', received '${activeSymbol}'`);
            validationErrors++;
        }
        if (activeTimeframe !== '1m') {
            console.error(`❌ Provenance Error: Expected timeframe '1m', received '${activeTimeframe}'`);
            validationErrors++;
        }

        let lastTime = -1;
        for (let i = 0; i < sourceCandles!.length; i++) {
            const candle = sourceCandles![i];
            if (!Number.isFinite(candle.time) || candle.time <= 0 || candle.time >= 1e14) {
                console.error(`❌ Provenance Error: Unsafe timestamp at candle index ${i}: ${candle.time}`);
                validationErrors++;
                break;
            }
            if (!Number.isFinite(candle.open) || !Number.isFinite(candle.high) ||
                !Number.isFinite(candle.low) || !Number.isFinite(candle.close) || !Number.isFinite(candle.volume)) {
                console.error(`❌ Provenance Error: Non-finite values detected at candle index ${i}`);
                validationErrors++;
                break;
            }
            if (candle.high < candle.low || candle.high < Math.max(candle.open, candle.close) ||
                candle.low > Math.min(candle.open, candle.close) || candle.volume < 0) {
                console.error(`❌ Provenance Error: Structurally invalid OHLCV relationship at index ${i}`);
                validationErrors++;
                break;
            }
            if (candle.time <= lastTime) {
                console.error(`❌ Provenance Error: Timestamps not strictly ascending at index ${i} (${candle.time} <= ${lastTime})`);
                validationErrors++;
                break;
            }
            lastTime = candle.time;
        }

        if (validationErrors > 0) {
            console.error(`❌ PHASE 2J AUDIT ABORTED: ${validationErrors} provenance validation error(s). Historical audit halted.`);
            return {
                passed: false,
                provenanceValidated: false,
                syntheticRejectionPassed: false,
                configA: null,
                configB: null
            };
        }

        const firstTimeIso = new Date(sourceCandles![0].time).toISOString();
        const lastTimeIso = new Date(sourceCandles![sourceCandles!.length - 1].time).toISOString();
        provenance = `REAL HISTORICAL FEED (${activeSymbol} ${activeTimeframe}) | Range: ${firstTimeIso} to ${lastTimeIso}`;
    } else {
        provenance = 'SYNTHETIC DATASET (Deterministic PRNG with injected anomalies)';
    }

    const candles = isHistorical ? sourceCandles! : generateDeterministicDataset(50000);

    console.log(`\n======================================================`);
    console.log(`📊 ML-R1 PHASE 2J QUANTITATIVE AUDIT REPORT`);
    console.log(`   ↳ Provenance: ${provenance}`);
    console.log(`   ↳ Observations: ${candles.length.toLocaleString()}`);
    console.log(`======================================================\n`);

    const resultsA = runConfigAudit(candles, ML1_CONFIG_A);
    const resultsB = runConfigAudit(candles, ML1_CONFIG_B);

    // --- 1. FEATURE COVERAGE REPORT ---
    console.log(`### 1. Feature Coverage Report`);
    console.log(`\n#### Configuration A (EMA Ablated)`);
    printFeatureCoverage(resultsA.featureReports);
    console.log(`\n#### Configuration B (Full Context)`);
    printFeatureCoverage(resultsB.featureReports);

    // --- 2. MEASURED WARM-UP REPORT ---
    console.log(`\n### 2. Measured Warm-up Report`);
    console.log(`\n#### Configuration A`);
    printWarmupCoverage(resultsA, ML1_CONFIG_A);
    console.log(`\n#### Configuration B`);
    printWarmupCoverage(resultsB, ML1_CONFIG_B);

    // --- 3. INVALID VALUE & VALIDITY-MASK AUDIT ---
    console.log(`\n### 3. Invalid-Value & Validity-Mask Invariant Audit`);
    printValidityAudit('Configuration A', resultsA);
    printValidityAudit('Configuration B', resultsB);

    // --- 4. NUMERICALLY STABLE CORRELATION REPORT ---
    console.log(`\n### 4. Correlation & Redundancy Matrix (Two-Pass Centered Pearson)`);
    printCorrelationMatrix(resultsB.observations, ML1_CONFIG_B);

    const rejectionAudit = runSyntheticRejectionAudit();

    const invariantChecks = (results: ConfigAuditMetrics) =>
        results.maskMismatchCount === 0 &&
        results.missingKeysCount === 0 &&
        results.extraKeysCount === 0 &&
        results.nonBooleanValidity === 0 &&
        results.fallbackViolations === 0 &&
        results.nonFiniteAcceptedValues === 0 &&
        results.rejectedStateMutations === 0;

    const passed =
        validationErrors === 0 &&
        invariantChecks(resultsA) &&
        invariantChecks(resultsB) &&
        rejectionAudit.passed;

    if (passed) {
        console.log('\n✅ PHASE 2J CONFIGURATION, SCHEMA & QUANTITATIVE AUDIT COMPLETED.');
    } else {
        console.error('\n❌ PHASE 2J CONFIGURATION, SCHEMA & QUANTITATIVE AUDIT FAILED INVARIANT CHECKS.');
    }

    return {
        passed,
        provenanceValidated: isHistorical && validationErrors === 0,
        syntheticRejectionPassed: rejectionAudit.passed,
        configA: resultsA,
        configB: resultsB
    };
}

/**
 * Exercises rejected-observation invariants using deliberate synthetic anomalies.
 */
export function runSyntheticRejectionAudit(): {
    passed: boolean;
    rejectedCount: number;
    rejectedStateMutations: number;
    breakdown: ConfigAuditMetrics['rejectionBreakdown'];
} {
    console.log(`\n### Companion Synthetic Rejection Invariant Audit`);
    const syntheticCandles = generateDeterministicDataset(2000, 42);
    const result = runConfigAudit(syntheticCandles, ML1_CONFIG_B);

    const breakdown = result.rejectionBreakdown;
    const hasAllClasses =
        breakdown.outOfOrder >= 1 &&
        breakdown.duplicate >= 1 &&
        breakdown.nonFiniteOhlcv >= 1 &&
        breakdown.structuralOhlc >= 1;
    const invariantChecksPassed =
        result.maskMismatchCount === 0 &&
        result.missingKeysCount === 0 &&
        result.extraKeysCount === 0 &&
        result.nonBooleanValidity === 0 &&
        result.fallbackViolations === 0 &&
        result.nonFiniteAcceptedValues === 0 &&
        result.rejectedStateMutations === 0;
    const passed = hasAllClasses && result.rejectedCount >= 4 && invariantChecksPassed;

    console.log(`Deliberately Rejected Observations Tested: ${result.rejectedCount} (Expected >= 4)`);
    console.log(`  ↳ Out-Of-Order Timestamps:      ${breakdown.outOfOrder >= 1 ? '✅' : '❌'} (${breakdown.outOfOrder} rejected)`);
    console.log(`  ↳ Duplicate Timestamps:         ${breakdown.duplicate >= 1 ? '✅' : '❌'} (${breakdown.duplicate} rejected)`);
    console.log(`  ↳ Non-Finite OHLCV Values:      ${breakdown.nonFiniteOhlcv >= 1 ? '✅' : '❌'} (${breakdown.nonFiniteOhlcv} rejected)`);
    console.log(`  ↳ Structurally Invalid OHLC:    ${breakdown.structuralOhlc >= 1 ? '✅' : '❌'} (${breakdown.structuralOhlc} rejected)`);
    console.log(`Rejected Observations Causing Mutation:   ${result.rejectedStateMutations === 0 ? '✅ 0' : `❌ ${result.rejectedStateMutations}`}`);
    console.log(`Synthetic Validity-Mask Invariants:       ${invariantChecksPassed ? '✅ PASSED' : '❌ FAILED'}`);
    console.log(`Synthetic Rejection Verification:         ${passed ? '✅ PASSED' : '❌ FAILED'}`);

    return {
        passed,
        rejectedCount: result.rejectedCount,
        rejectedStateMutations: result.rejectedStateMutations,
        breakdown
    };
}

function runConfigAudit(candles: ML1Candle[], config: ValidatedML1FeatureConfig): {
    observations: any[];
    featureReports: FeatureReport[];
} & ConfigAuditMetrics {
    let state = createInitialML1FeatureState();
    const observations = [];
    let rejectedCount = 0;
    let acceptedCount = 0;
    let maskMismatchCount = 0;
    let missingKeysCount = 0;
    let extraKeysCount = 0;
    let nonBooleanValidity = 0;
    let fallbackViolations = 0;
    let nonFiniteAcceptedValues = 0;
    let rejectedStateMutations = 0;
    const rejectionBreakdown = {
        outOfOrder: 0,
        duplicate: 0,
        nonFiniteOhlcv: 0,
        structuralOhlc: 0
    };

    for (let i = 0; i < candles.length; i++) {
        const prevStateSnapshot = JSON.stringify(state);
        const res = stepML1Features(candles[i], i, state, config);
        observations.push(res.observation);

        const isAccepted = res.observation.features['IsSourceValid'] === 1;
        if (isAccepted) {
            acceptedCount++;
            state = res.nextState;

            // Strict Contract Audit 1: Key parity between features and validity
            const fKeys = Object.keys(res.observation.features);
            const vKeys = Object.keys(res.observation.validity);
            if (fKeys.length !== vKeys.length) maskMismatchCount++;

            for (let k = 0; k < fKeys.length; k++) {
                const key = fKeys[k];
                if (!(key in res.observation.validity)) missingKeysCount++;
            }

            for (let k = 0; k < vKeys.length; k++) {
                const key = vKeys[k];
                const valid = res.observation.validity[key];
                if (typeof valid !== 'boolean') nonBooleanValidity++;
                if (!(key in res.observation.features)) extraKeysCount++;
            }

            for (let k = 0; k < fKeys.length; k++) {
                const key = fKeys[k];
                const val = res.observation.features[key];
                const valid = res.observation.validity[key];

                if (!Number.isFinite(val)) {
                    nonFiniteAcceptedValues++;
                }

                if (valid === false && val !== 0) {
                    fallbackViolations++;
                }
            }
        } else {
            rejectedCount++;
            if (JSON.stringify(state) !== prevStateSnapshot || JSON.stringify(res.nextState) !== prevStateSnapshot) {
                rejectedStateMutations++;
            }

            const candle = candles[i];
            const features = res.observation.features;
            if (features['IsOutOfOrder'] === 1) {
                rejectionBreakdown.outOfOrder++;
            } else if (features['IsDuplicateTimestamp'] === 1) {
                rejectionBreakdown.duplicate++;
            } else if (features['IsValidOHLCV'] === 0) {
                const hasNonFiniteValue =
                    !Number.isFinite(candle.time) ||
                    !Number.isFinite(candle.open) ||
                    !Number.isFinite(candle.high) ||
                    !Number.isFinite(candle.low) ||
                    !Number.isFinite(candle.close) ||
                    !Number.isFinite(candle.volume);
                if (hasNonFiniteValue) {
                    rejectionBreakdown.nonFiniteOhlcv++;
                } else {
                    rejectionBreakdown.structuralOhlc++;
                }
            }

            state = JSON.parse(prevStateSnapshot);
        }
    }

    // Measure actual observed first-valid bar indices from output rows
    const featureReports: FeatureReport[] = [];
    const allFeatureKeys = Object.keys(observations[0]?.features || {}).sort();

    for (const key of allFeatureKeys) {
        let validCount = 0;
        let invalidCount = 0;
        let firstValidBar = -1;

        for (let i = 0; i < observations.length; i++) {
            const obs = observations[i];
            if (obs.features['IsSourceValid'] !== 1) continue;

            if (obs.validity[key] === true) {
                validCount++;
                if (firstValidBar === -1) firstValidBar = i;
            } else {
                invalidCount++;
            }
        }

        const coveragePct = acceptedCount > 0 ? (validCount / acceptedCount) * 100 : 0;
        featureReports.push({
            featureName: key,
            validCount,
            invalidCount,
            coveragePct: parseFloat(coveragePct.toFixed(2)),
            firstValidBar
        });
    }

    return {
        observations,
        featureReports,
        acceptedCount,
        rejectedCount,
        maskMismatchCount,
        missingKeysCount,
        extraKeysCount,
        nonBooleanValidity,
        fallbackViolations,
        nonFiniteAcceptedValues,
        rejectedStateMutations,
        rejectionBreakdown
    };
}

function printFeatureCoverage(reports: FeatureReport[]) {
    console.log(`| Feature Name                   | Valid  | Invalid | Coverage % | Measured First Valid Bar |`);
    console.log(`| :----------------------------- | :----- | :------ | :--------- | :----------------------- |`);
    reports.forEach(r => {
        if (!r.featureName.startsWith('source') && !r.featureName.startsWith('Is')) {
            console.log(
                `| ${r.featureName.padEnd(30)} | ${String(r.validCount).padEnd(6)} | ${String(r.invalidCount).padEnd(7)} | ${String(r.coveragePct).padEnd(10)} | ${String(r.firstValidBar).padEnd(24)} |`
            );
        }
    });
}

function printWarmupCoverage(results: any, config: ValidatedML1FeatureConfig) {
    const readyObservations = results.observations.filter(
        (o: any) => o.features['IsSourceValid'] === 1 && o.features['IsWarmupComplete'] === 1
    ).length;

    console.log(`Accepted Observations: ${results.acceptedCount.toLocaleString()}`);
    console.log(`In Warmup State (IsWarmupComplete = 0): ${(results.acceptedCount - readyObservations).toLocaleString()}`);
    console.log(`In Fully Ready State (IsWarmupComplete = 1): ${readyObservations.toLocaleString()}`);

    const measuredGlobalBar = results.observations.findIndex(
        (o: any) => o.features['IsSourceValid'] === 1 && o.features['IsWarmupComplete'] === 1
    );

    console.log(`Measured Global Warm-up Activation: Bar Index ${measuredGlobalBar}`);

    // If Config B, explicitly document the slope 10 offset discrepancy
    if (config.emaPeriods.includes(200)) {
        const slope10Report = results.featureReports.find((r: any) => r.featureName === 'EMA_200_Slope_10');
        console.log(`  ↳ Special Note: EMA_200_Slope_10 became valid at Bar Index ${slope10Report?.firstValidBar} (Evaluates independently of global 200-bar flag)`);
    }
}

function printValidityAudit(label: string, results: any) {
    console.log(`\n--- ${label} ---`);
    console.log(`Total Accepted Observations: ${results.acceptedCount}`);
    console.log(`Total Rejected Observations: ${results.rejectedCount}`);
    console.log(`Feature/Validity Mask Length Mismatches: ${results.maskMismatchCount}`);
    console.log(`Feature Keys Missing from Validity: ${results.missingKeysCount}`);
    console.log(`Validity Keys Missing from Features: ${results.extraKeysCount}`);
    console.log(`Non-Boolean Validity Values: ${results.nonBooleanValidity}`);
    console.log(`Invalid-Flag Non-Zero Fallback Violations: ${results.fallbackViolations}`);
    console.log(`Non-Finite Values in Accepted Features: ${results.nonFiniteAcceptedValues}`);
    console.log(`Rejected Observations Causing State Mutation: ${results.rejectedStateMutations}`);
}

function printCorrelationMatrix(observations: any[], config: ValidatedML1FeatureConfig) {
    const accepted = observations.filter((o: any) => o.features['IsSourceValid'] === 1);
    if (accepted.length < 2) return;

    const targetFeatures = [
        'CandleRange', 'BodySize', 'ATR_14', 'ATR_20',
        'RollingRangeWidth_5', 'RollingRangeWidth_50',
        'Momentum_5', 'Return_5', 'DirectionalEfficiency_5',
        'Volume', 'RelativeVolume_10', 'VolumeZScore_20'
    ];

    if (config.emaPeriods.length > 0) {
        targetFeatures.push('EMA_9_Distance', 'EMA_9_Slope_3', 'EMA_9_Slope_10', 'EMA_9_20_Separation');
    }

    const correlations: CorrelationReport[] = [];

    for (let i = 0; i < targetFeatures.length; i++) {
        for (let j = i + 1; j < targetFeatures.length; j++) {
            const f1 = targetFeatures[i];
            const f2 = targetFeatures[j];

            const x: number[] = [];
            const y: number[] = [];

            for (let k = 0; k < accepted.length; k++) {
                const obs = accepted[k];
                if (obs.validity[f1] && obs.validity[f2]) {
                    x.push(obs.features[f1]);
                    y.push(obs.features[f2]);
                }
            }

            if (x.length >= 30) {
                const r = calculatePearson(x, y);
                if (Number.isFinite(r) && !Number.isNaN(r) && Math.abs(r) >= 0.70) {
                    correlations.push({
                        feature1: f1,
                        feature2: f2,
                        correlation: parseFloat(r.toFixed(4)),
                        jointlyValidCount: x.length
                    });
                }
            }
        }
    }

    correlations.sort((a, b) => Math.abs(b.correlation) - Math.abs(a.correlation));

    console.log(`| Feature 1                  | Feature 2                  | Pearson r   | Jointly Valid Samples |`);
    console.log(`| :------------------------- | :------------------------- | :---------- | :-------------------- |`);
    correlations.slice(0, 15).forEach(c => {
        console.log(
            `| ${c.feature1.padEnd(26)} | ${c.feature2.padEnd(26)} | ${String(c.correlation).padEnd(11)} | ${String(c.jointlyValidCount).padEnd(21)} |`
        );
    });
}
