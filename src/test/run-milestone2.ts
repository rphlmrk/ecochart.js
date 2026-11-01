import { runPhase2ATests } from './milestone2a-acceptance';

const result = runPhase2ATests();
process.exit(result ? 0 : 1);
