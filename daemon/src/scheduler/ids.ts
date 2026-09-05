import { randomBytes } from 'node:crypto';

const B36 = 36;
const COUNTER_WIDTH = 4;
const COUNTER_MAX = B36 ** COUNTER_WIDTH;

let lastMs = 0;
let counter = 0;

/**
 * Lexicographically sortable job id: `<ms base36><counter base36><random>`.
 *
 * The counter is not decoration. A whole batch is minted inside a single
 * millisecond, so a timestamp-plus-randomness id would order those jobs
 * arbitrarily — and the scheduler starts work in id order, which would make a
 * submitted batch run in a random sequence. The counter makes mint order and
 * sort order the same thing.
 */
export function newJobId(now: number = Date.now()): string {
  if (now !== lastMs) {
    lastMs = now;
    counter = 0;
  }
  const n = counter++ % COUNTER_MAX;
  return [
    now.toString(B36).padStart(9, '0'),
    n.toString(B36).padStart(COUNTER_WIDTH, '0'),
    randomBytes(4).toString('hex'),
  ].join('');
}
