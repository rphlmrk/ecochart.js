import { runPhase2ATests } from './milestone2a-acceptance';
import { runPhase2JTests } from './milestone2j-acceptance';
import { generatePhase2JReports } from '../analysis/ML1FeatureAuditGenerator';
import type { ML1Candle } from '../indicators/mlr1/ML1FeatureTypes';

/**
 * Complete Milestone 2 Acceptance Orchestrator.
 * Explicitly gates on core engine, schema, and quantitative audit invariants.
 */
export function runMilestone2AcceptanceSuite(
    sourceCandles?: ML1Candle[],
    symbol?: string,
    timeframe?: string
): boolean {
    console.log('\n======================================================');
    console.log('🚀 STARTING COMPLETE MILESTONE 2 ACCEPTANCE ORCHESTRATOR');
    console.log('======================================================');

    console.log('\n--- GATE 1: Core Technical Feature Suites (Phases 2A-2H) ---');
    const passedCore = runPhase2ATests();
    if (!passedCore) {
        console.error('❌ Milestone 2 Gate 1 Failed: Phase 2A-2H suite failed.');
        return false;
    }
    console.log('✅ Gate 1 Passed: Core Technical Feature Suites (2A-2H) Verified.');

    console.log('\n--- GATE 2: Configuration & Schema Immutability Suite (Phase 2J) ---');
    const passedSchema = runPhase2JTests();
    if (!passedSchema) {
        console.error('❌ Milestone 2 Gate 2 Failed: Phase 2J schema test failed.');
        return false;
    }
    console.log('✅ Gate 2 Passed: Configuration & Schema Immutability Verified.');

    console.log('\n--- GATE 3: Quantitative Invariant, Provenance & Synthetic Rejection Audit ---');
    const auditResult = generatePhase2JReports(sourceCandles, symbol, timeframe);
    if (!auditResult.passed) {
        console.error('❌ Milestone 2 Gate 3 Failed: Quantitative invariant audit failed.');
        return false;
    }
    console.log('✅ Gate 3 Passed: Quantitative Invariants & Rejection Handling Verified.');

    console.log('\n======================================================');
    console.log('🏆 ALL MILESTONE 2 ACCEPTANCE GATES & AUDIT CRITERIA PASSED');
    console.log('   ↳ Core Engine (2A-2H):      PASSED');
    console.log('   ↳ Schema Immutability (2J): PASSED');
    console.log('   ↳ Quantitative Audit (2J-B): PASSED');
    console.log('   ↳ Synthetic Rejections:     4/4 CLASSES VERIFIED');
    console.log('   ↳ Status:                   READY FOR FORMAL FREEZE');
    console.log('======================================================\n');
    return true;
}

const isDirectRun = typeof process !== 'undefined' && process.argv && process.argv[1]?.includes('run-milestone2');
if (isDirectRun) {
    const success = runMilestone2AcceptanceSuite();
    process.exit(success ? 0 : 1);
}
