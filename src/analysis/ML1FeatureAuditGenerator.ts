import { createInitialML1FeatureState, stepML1Features } from '../indicators/mlr1/ML1FeatureEngine';
import { ML1_CONFIG_A, ML1_CONFIG_B } from '../indicators/mlr1/ML1FeatureConfigs';
import type { ML1Candle } from '../indicators/mlr1/ML1FeatureTypes';

/**
 * Generates a deterministic sequence of candles for reproducible audit reports.
 * Prices trend up and down with some noise, volumes fluctuate.
 */
function generateDeterministicDataset(count: number, seed = 42): ML1Candle[] {
    const rng = new SeededRNG(seed);
    let price = 1000;
    let time = 1700000000000; // Jan 1, 2024 UTC

    const candles: ML1Candle[] = [];

    for (let i = 0; i < count; i++) {
        // Introduce some price volatility and direction changes
        const priceChange = Math.sin(i / 10) * 0.5 + (rng.next() - 0.5) * 0.2;
        const open = price;
        const close = open + priceChange;
        const high = Math.max(open, close) + rng.next() * 0.5;
        const low = Math.min(open, close) - rng.next() * 0.5;
        
        // Introduce some volume variability, including occasional zero volume
        let volume = 100 + Math.abs(Math.sin(i / 5)) * 50 + (rng.next() - 0.5) * 20;
        if (rng.next() < 0.005) volume = 0; // 0.5% chance of zero volume
        if (rng.next() < 0.002) price = open; // 0.2% chance of flat candle

        candles.push({ time, open, high, low, close, volume: Math.max(0, volume) });
        price = close;
        time += 60000; // 1-minute interval

        // Introduce a major gap and then resume normal sequence
        if (i === Math.floor(count / 2) && count > 50) {
            time += ML1_CONFIG_A.gapDiscontinuityThresholdMs * 2; // Simulate a 10-minute gap (twice the threshold)
        }
        // Introduce an out-of-order candle
        if (i === Math.floor(count / 4) && count > 50) {
            candles.push({ ...candles[i], time: candles[i].time - 120000 }); // Out-of-order
        }
        // Introduce a duplicate candle
        if (i === Math.floor(count / 3) && count > 50) {
            candles.push({ ...candles[i], volume: candles[i].volume + 100 }); // Duplicate timestamp, different volume
        }
        // Introduce NaN close
        if (i === Math.floor(count / 1.5) && count > 50) {
            candles.push({ ...candles[i], close: NaN }); // Corrupted close
        }
    }
    return candles.sort((a, b) => a.time - b.time); // Ensure final sorted chronology
}

// Fast, seedable Mulberry32 PRNG for reproducible test datasets
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

export function generatePhase2JReports(): void {
    console.log(`\n=======================================`);
    console.log(`📊 ML-R1 PHASE 2J AUDIT REPORTS`);
    console.log(`=======================================\n`);

    const DATASET_SIZE = 50_000; // Use a large dataset for meaningful statistics
    const simulatedCandles = generateDeterministicDataset(DATASET_SIZE);

    console.log(`Dataset: ${ML1_CONFIG_A.symbol} ${ML1_CONFIG_A.timeframe}`);
    console.log(`Simulated Observations: ${simulatedCandles.length.toLocaleString()}`);
    console.log(`\n--- Running Configuration A (EMA Ablated) ---`);
    const resultsA = runConfigAndCollectMetrics(simulatedCandles, ML1_CONFIG_A, 'A');

    console.log(`\n--- Running Configuration B (EMA Included) ---`);
    const resultsB = runConfigAndCollectMetrics(simulatedCandles, ML1_CONFIG_B, 'B');

    // --- REPORTING ---

    // 1. Feature Coverage Report
    console.log(`\n### 1. Feature Coverage Report`);
    console.log(`\n#### Configuration A: Baseline`);
    printFeatureCoverage(resultsA.featureReports);
    console.log(`\n#### Configuration B: Full Context`);
    printFeatureCoverage(resultsB.featureReports);

    // 2. Warm-up Coverage Report
    console.log(`\n### 2. Warm-up Coverage Report`);
    console.log(`\n#### Configuration A: Baseline`);
    printWarmupCoverage(resultsA.allObservations, resultsA.warmupInfo, resultsA.featureReports, ML1_CONFIG_A);
    console.log(`\n#### Configuration B: Full Context`);
    printWarmupCoverage(resultsB.allObservations, resultsB.warmupInfo, resultsB.featureReports, ML1_CONFIG_B);

    // 3. Invalid-Value and Validity-Mask Audit
    console.log(`\n### 3. Invalid-Value and Validity-Mask Audit`);
    printInvalidValueAudit(resultsA.auditInfo, resultsB.auditInfo);

    // 4. Correlation/Redundancy Report (Sample)
    console.log(`\n### 4. Correlation/Redundancy Report (Sample)`);
    printCorrelationReport(resultsB.allObservations, ML1_CONFIG_B);
}

function runConfigAndCollectMetrics(candles: ML1Candle[], config: typeof ML1_CONFIG_A, _configId: string) {
    let state = createInitialML1FeatureState();
    const allObservations: any[] = [];
    let rejectedCount = 0;
    let globalWarmupCompleteCount = 0;
    const firstValidBar: Record<string, number> = {};
    const invalidValueCounts: Record<string, number> = {};

    // Collect all possible feature keys to ensure consistent schema
    let allFeatureKeys: Set<string> = new Set();

    for (let i = 0; i < candles.length; i++) {
        const res = stepML1Features(candles[i], i, state, config);
        allObservations.push(res.observation);
        state = res.nextState;

        if (res.observation.features['IsSourceValid'] === 0) {
            rejectedCount++;
        }

        if (res.observation.features['IsWarmupComplete'] === 1) {
            globalWarmupCompleteCount++;
        }
        
        // Collect schema dynamically from accepted observations
        if (res.observation.features['IsSourceValid'] === 1) {
             Object.keys(res.observation.features).forEach(key => allFeatureKeys.add(key));
        }

        // Audit invalid values for features
        for (const key in res.observation.features) {
            const val = res.observation.features[key];
            if (!Number.isFinite(val)) {
                invalidValueCounts[key] = (invalidValueCounts[key] || 0) + 1;
            }
        }
    }

    const featureReports: FeatureReport[] = [];
    const sortedFeatureKeys = Array.from(allFeatureKeys).sort();

    for (const key of sortedFeatureKeys) {
        let validCount = 0;
        let invalidCount = 0;
        let firstBar = -1;

        for (let i = 0; i < allObservations.length; i++) {
            const obs = allObservations[i];
            // Only count against accepted observations for coverage
            if (obs.features['IsSourceValid'] === 0) continue;

            if (obs.validity[key] === true) {
                validCount++;
                if (firstBar === -1) firstBar = i;
            } else if (Object.prototype.hasOwnProperty.call(obs.validity, key)) { // Only count if the validity is explicitly present
                invalidCount++;
            }
        }
        const totalObservationsForCoverage = allObservations.filter(o => o.features['IsSourceValid'] === 1).length;
        const coveragePct = totalObservationsForCoverage > 0 ? (validCount / totalObservationsForCoverage) * 100 : 0;

        featureReports.push({
            featureName: key,
            validCount,
            invalidCount,
            coveragePct: parseFloat(coveragePct.toFixed(2)),
            firstValidBar: firstBar
        });
    }

    return {
        allObservations,
        featureReports,
        warmupInfo: { rejectedCount, globalWarmupCompleteCount, firstValidBar },
        auditInfo: { invalidValueCounts, rejectedCount }
    };
}

function printFeatureCoverage(reports: FeatureReport[]) {
    console.log(`| Feature Name                   | Valid  | Invalid | Coverage % | First Valid Bar |`);
    console.log(`| :----------------------------- | :----- | :------ | :--------- | :-------------- |`);
    reports.forEach(r => {
        if (!r.featureName.startsWith('source') && !r.featureName.startsWith('Is')) { // Exclude raw sources and simple flags for main report
            console.log(`| ${r.featureName.padEnd(30)} | ${String(r.validCount).padEnd(6)} | ${String(r.invalidCount).padEnd(7)} | ${String(r.coveragePct).padEnd(10)} | ${String(r.firstValidBar).padEnd(15)} |`);
        }
    });
}

function printWarmupCoverage(
    observations: any[],
    warmupInfo: any,
    featureReports: FeatureReport[],
    config: typeof ML1_CONFIG_A
) {
    const totalAccepted = observations.filter(o => o.features['IsSourceValid'] === 1).length;

    console.log(`Total Accepted Observations: ${totalAccepted.toLocaleString()}`);
    console.log(`Observations in Global Warmup State (IsWarmupComplete = 0): ${totalAccepted - warmupInfo.globalWarmupCompleteCount}`);
    console.log(`Observations in Global Ready State (IsWarmupComplete = 1): ${warmupInfo.globalWarmupCompleteCount}`);

    console.log(`\nIndividual Feature Warmup (First bar index where 'isValid' becomes true):`);
    const maxGlobalWarmup = config.emaPeriods.length > 0 ? 200 : 51; // 200 for EMA200, 51 for Volume50 (N+1 rule)
    console.log(`| Feature Name               | Warmup Start (Bar Index) | Threshold (Bars) |`);
    console.log(`| :------------------------- | :----------------------- | :--------------- |`);

    for (const period of config.emaPeriods) {
        const keyDistance = `EMA_${period}_Distance`;
        const keySlope3 = `EMA_${period}_Slope_3`;
        const keySlope10 = `EMA_${period}_Slope_10`;
        console.log(`| EMA_${period}_Distance       | ${String(featureReports.find(r => r.featureName === keyDistance)?.firstValidBar || -1).padEnd(24)} | ${String(Math.max(period, 14)).padEnd(16)} |`);
        console.log(`| EMA_${period}_Slope_3        | ${String(featureReports.find(r => r.featureName === keySlope3)?.firstValidBar || -1).padEnd(24)} | ${String(Math.max(period, 14) + 3).padEnd(16)} |`);
        console.log(`| EMA_${period}_Slope_10       | ${String(featureReports.find(r => r.featureName === keySlope10)?.firstValidBar || -1).padEnd(24)} | ${String(Math.max(period, 14) + 10).padEnd(16)} |`);
    }

    for (const period of config.atrPeriods) {
        const key = `ATR_${period}`;
        console.log(`| ${key.padEnd(26)} | ${String(featureReports.find(r => r.featureName === key)?.firstValidBar || -1).padEnd(24)} | ${String(period).padEnd(16)} |`);
    }

    for (const period of config.rollingRangePeriods) {
        const key = `RollingRangeWidth_${period}`;
        console.log(`| ${key.padEnd(26)} | ${String(featureReports.find(r => r.featureName === key)?.firstValidBar || -1).padEnd(24)} | ${String(period).padEnd(16)} |`);
    }
    
    for (const period of config.momentumPeriods) {
        const key = `Momentum_${period}`;
        console.log(`| ${key.padEnd(26)} | ${String(featureReports.find(r => r.featureName === key)?.firstValidBar || -1).padEnd(24)} | ${String(period + 1).padEnd(16)} |`);
    }

    for (const period of config.volumeSmaPeriods) {
        const key = `RelativeVolume_${period}`;
        console.log(`| ${key.padEnd(26)} | ${String(featureReports.find(r => r.featureName === key)?.firstValidBar || -1).padEnd(24)} | ${String(period + 1).padEnd(16)} |`);
    }
    
    console.log(`\nMax Global Warm-up for current config: ${maxGlobalWarmup} bars`);
}

function printInvalidValueAudit(auditA: any, auditB: any) {
    console.log(`#### Configuration A: Baseline`);
    console.log(`Rejected Observations (IsSourceValid=0): ${auditA.rejectedCount}`);
    if (Object.keys(auditA.invalidValueCounts).length > 0) {
        console.log(`Non-Finite Feature Values Detected:`);
        for (const key in auditA.invalidValueCounts) {
            console.log(`  - ${key}: ${auditA.invalidValueCounts[key]} occurrences`);
        }
    } else {
        console.log(`No non-finite feature values detected in accepted observations.`);
    }

    console.log(`\n#### Configuration B: Full Context`);
    console.log(`Rejected Observations (IsSourceValid=0): ${auditB.rejectedCount}`);
    if (Object.keys(auditB.invalidValueCounts).length > 0) {
        console.log(`Non-Finite Feature Values Detected:`);
        for (const key in auditB.invalidValueCounts) {
            console.log(`  - ${key}: ${auditB.invalidValueCounts[key]} occurrences`);
        }
    } else {
        console.log(`No non-finite feature values detected in accepted observations.`);
    }
}

function printCorrelationReport(observations: any[], config: typeof ML1_CONFIG_B) {
    const activeObservations = observations.filter(o => o.features['IsSourceValid'] === 1);
    if (activeObservations.length < 2) {
        console.log('Insufficient accepted observations for correlation analysis.');
        return;
    }

    const calculatePearson = (x: number[], y: number[]): number => {
        if (x.length < 2 || x.length !== y.length) return NaN;
        const n = x.length;
        let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0, sumY2 = 0;
        for (let i = 0; i < n; i++) {
            sumX += x[i];
            sumY += y[i];
            sumXY += x[i] * y[i];
            sumX2 += x[i] * x[i];
            sumY2 += y[i] * y[i];
        }
        const numerator = n * sumXY - sumX * sumY;
        const denominator = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));
        return denominator === 0 ? 0 : numerator / denominator;
    };

    const coreFeatures = [
        'CandleRange', 'BodySize', 'UpperWick', 'LowerWick',
        'ATR_14', 'ATR_20', 'RollingRangeWidth_5', 'RollingRangeWidth_50',
        'Momentum_5', 'Return_5', 'DirectionalEfficiency_5',
        'Volume', 'RelativeVolume_10', 'VolumeZScore_20'
    ];

    const emaFeatures = config.emaPeriods.length > 0 ? [
        'EMA_9_Distance', 'EMA_20_Distance', 'EMA_50_Distance',
        'EMA_9_Slope_3', 'EMA_20_Slope_10',
        'EMA_9_Above_EMA_20', 'EMA_9_20_Separation', 'EMA_SpreadChange_9_20'
    ] : [];

    const allFeatures = [...coreFeatures, ...emaFeatures];
    const correlations: CorrelationReport[] = [];

    for (let i = 0; i < allFeatures.length; i++) {
        for (let j = i + 1; j < allFeatures.length; j++) {
            const f1 = allFeatures[i];
            const f2 = allFeatures[j];
            
            // Only consider jointly valid rows
            const commonValues: { x: number, y: number }[] = [];
            for (const obs of activeObservations) {
                if (obs.validity[f1] && obs.validity[f2] && 
                    Number.isFinite(obs.features[f1]) && Number.isFinite(obs.features[f2])) {
                    commonValues.push({ x: obs.features[f1], y: obs.features[f2] });
                }
            }

            if (commonValues.length >= 2) { // Need at least 2 points for correlation
                const xVals = commonValues.map(v => v.x);
                const yVals = commonValues.map(v => v.y);
                const corr = calculatePearson(xVals, yVals);
                if (!isNaN(corr) && Math.abs(corr) > 0.1) { // Only report significant correlations
                    correlations.push({
                        feature1: f1,
                        feature2: f2,
                        correlation: parseFloat(corr.toFixed(4)),
                        jointlyValidCount: commonValues.length
                    });
                }
            }
        }
    }

    correlations.sort((a, b) => Math.abs(b.correlation) - Math.abs(a.correlation)); // Sort by absolute correlation

    console.log(`| Feature 1                  | Feature 2                  | Corr. Value | Jointly Valid Samples |`);
    console.log(`| :------------------------- | :------------------------- | :---------- | :-------------------- |`);
    correlations.slice(0, 20).forEach(r => { // Print top 20 correlations
        console.log(`| ${r.feature1.padEnd(26)} | ${r.feature2.padEnd(26)} | ${String(r.correlation).padEnd(11)} | ${String(r.jointlyValidCount).padEnd(21)} |`);
    });

    if (correlations.length === 0) {
        console.log('No significant correlations found among selected features.');
    }
}
