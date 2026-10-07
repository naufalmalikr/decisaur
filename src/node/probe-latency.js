/**
 * Second probe: minimise latency while keeping discrimination.
 *
 * Probe 1 showed:
 *   - multi-way `choice` questions discriminate jump-vs-bow but never `hold`
 *   - binary `noul` questions separate ground-vs-air very cleanly (0.99 / 0.09)
 *   - latency scales with question count (~300ms for 1, ~580ms for 3)
 *
 * This run checks whether a single `choice` over *obstacle classes* beats two
 * `noul`s on both axes at once, and pins down per-question latency.
 *
 *   node src/node/probe-latency.js
 */
 * SUPERSEDED - kept as a historical record, not a description of the current design.
 *
 * This probe tests the obstacle-*class* question, which production no longer uses. The
 * class is distance-invariant and cannot express `hold`, so the maneuver had to be
 * recovered through a lookup table. It is kept because it is the measurement that ruled
 * that design out, and because its latency-vs-question-count numbers are still the ones
 * quoted in `decider.js`. For the question that ships, see `probe-decompose.js`.
 */


import { Ollama } from 'ollama/browser';
import { DEFAULT_HOST, DEFAULT_MODEL, KEEP_ALIVE } from '../config.js';

const client = new Ollama({ host: process.env.OLLAMA_HOST ?? DEFAULT_HOST });
const model = process.env.DECISAUR_MODEL ?? DEFAULT_MODEL;

const CASES = {
  'cactus_large': 'The T-Rex is running on the ground. A cactus stands on the ground ahead of it, blocking the way.',
  'bird_high': 'The T-Rex is running on the ground. A pterodactyl flies high in the air above the T-Rex, clear underneath.',
  'bird_low': 'The T-Rex is running on the ground. A pterodactyl flies low, at the height of the T-Rex.',
};

const CLASS_Q = {
  kind: {
    type: 'choice',
    instructions: 'Identify the obstacle ahead so the T-Rex can choose a maneuver.',
    criteria: {
      cactus: 'A cactus or other solid object resting on the ground.',
      bird_high: 'A bird flying high overhead, which can be bowed under.',
      bird_low: 'A bird flying at body height, which must be jumped over.',
    },
  },
};

const TWO_NOUL_Q = {
  on_ground: { type: 'noul', instructions: 'Is the obstacle resting on the ground, such as a cactus?' },
  flies_high: { type: 'noul', instructions: 'Is the obstacle a bird flying high overhead, which can be bowed under?' },
};

async function run(label, questions, stateOf) {
  console.log(`\n=== ${label} ===`);
  for (const [name, state] of Object.entries(stateOf)) {
    const started = Date.now();
    const response = await client.systemone({ model, state, questions, keep_alive: KEEP_ALIVE });
    const answer = response.answers[Object.keys(questions)[0]];
    const ms = Date.now() - started;
    const detail =
      answer?.type === 'choice'
        ? `${answer.choice.padEnd(10)} conf=${answer.confidence.toFixed(3)} dist=${JSON.stringify(Object.fromEntries(Object.entries(answer.probabilities).map(([k, v]) => [k, Number(v.toFixed(2))])))}`
        : `p=${answer?.noul?.toFixed(2)}`;
    console.log(`  ${name.padEnd(12)} -> ${detail} ${String(ms).padStart(4)}ms`);
  }
}

// Latency scaling, isolated.
console.log('=== latency scaling ===');
for (const count of [1, 2, 3]) {
  const questions = Object.fromEntries(
    Array.from({ length: count }, (_, i) => [`q${i}`, { type: 'noul', instructions: `Probe question number ${i + 1}: is this true?` }]),
  );
  const samples = [];
  for (let i = 0; i < 3; i += 1) {
    const started = Date.now();
    await client.systemone({ model, state: 'a cactus is ahead', questions, keep_alive: KEEP_ALIVE });
    samples.push(Date.now() - started);
  }
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  console.log(`  ${count} question(s): ${samples.join(', ')} ms  mean ${mean.toFixed(0)}ms`);
}

// Discrimination: one choice question over obstacle classes.
const choiceCases = Object.fromEntries(Object.entries(CASES).map(([k, v]) => [k, v]));
await run('one choice question over obstacle classes', CLASS_Q, choiceCases);

// Discrimination: two noul questions.
const noulCases = Object.fromEntries(
  Object.entries(CASES).map(([k, v]) => [k, v]),
);
console.log('\n=== two noul questions (both answers) ===');
for (const [name, state] of Object.entries(noulCases)) {
  const started = Date.now();
  const response = await client.systemone({ model, state, questions: TWO_NOUL_Q, keep_alive: KEEP_ALIVE });
  const values = Object.fromEntries(
    Object.entries(response.answers).map(([k, v]) => [k, v.type === 'noul' ? Number(v.noul.toFixed(2)) : '-']),
  );
  console.log(`  ${name.padEnd(12)} -> ${JSON.stringify(values)} ${String(Date.now() - started).padStart(4)}ms`);
}
