/**
 * Sweep the jump-aim parameter across seeds.
 *
 * A jump lasts ~34 frames but consecutive obstacles can be only 22-34 frames
 * apart at top speed, so where in the clearance window the obstacle is lined up
 * decides whether the dino lands before the next one arrives. This measures the
 * trade-off instead of guessing it.
 *
 *   node src/node/sweep-aim.js [--seeds 12] [--frames 20000]
 */

import { Sim } from './sim.js';
import { plan as reflexPlan } from '../core/reflex.js';
import { readState, Tokeniser } from '../core/state.js';

const args = process.argv.slice(2);
const readArg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : Number.parseInt(args[i + 1], 10);
};

const SEEDS = readArg('seeds', 12);
const FRAMES = readArg('frames', 20000);
const START = readArg('start', 100);

/**
 * Run one seed with the reflex layer alone and report how far it got.
 *
 * @param {number} seed
 * @param {number} jumpAim
 * @returns {{survived: boolean, frame: number, score: number}}
 */
function runSeed(seed, jumpAim) {
  const sim = new Sim({ seed });
  const tokeniser = new Tokeniser();

  for (let frame = 0; frame < FRAMES && !sim.crashed; frame += 1) {
    const decision = reflexPlan(readState(sim.runner, tokeniser), { jumpAim });
    sim.step({ jump: decision.action === 'jump', bow: decision.action === 'bow' });
  }

  return { survived: !sim.crashed, frame: sim.frame, score: sim.score };
}

const CANDIDATES = (process.env.SWEEP_VALUES ?? "0.40,0.44,0.46,0.48,0.50,0.52,0.54,0.56,0.60").split(",").map(Number);

console.log(`sweeping JUMP_AIM over ${SEEDS} seeds x ${FRAMES} frames\n`);
console.log(['aim', 'survived', 'median frame', 'total score'].join('\t'));
console.log('-'.repeat(52));

const results = [];

for (const aim of CANDIDATES) {
  const runs = [];
  for (let i = 0; i < SEEDS; i += 1) runs.push(runSeed(START + i, aim));

  const survived = runs.filter((r) => r.survived).length;
  const frames = runs.map((r) => r.frame).sort((a, b) => a - b);
  const median = frames[Math.floor(frames.length / 2)];
  const total = runs.reduce((sum, r) => sum + r.score, 0);

  results.push({ aim, survived, median, total });
  console.log([aim.toFixed(2), `${survived}/${SEEDS}`, String(median), String(total)].join('\t'));
}

const best = results.reduce((a, b) => (b.survived > a.survived || (b.survived === a.survived && b.median > a.median) ? b : a));
console.log('');
console.log(`best aim ${best.aim} with ${best.survived}/${SEEDS} surviving`);
process.exit(0);
