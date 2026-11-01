import { runPhase2ATests } from './milestone2a-acceptance';
import { runPhase2JTests } from './milestone2j-acceptance';

const resA = runPhase2ATests();
const resJ = runPhase2JTests();

process.exit(resA && resJ ? 0 : 1);
