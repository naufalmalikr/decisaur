/**
 * Which decomposition of the maneuver question actually works.
 *
 * The single-choice question cannot do this job - `probe-maneuver.js` shows it
 * latching onto whichever option is described most forcefully, trading `bow` against
 * `hold` with no setting that reaches both. The hypothesis behind this probe is that
 * the label space itself is the problem: three options where two are "act" and one is
 * "don't" gives a 0.8b model a single decision axis to be wrong about.
 *
 * Splitting it removes that axis. `clear` answers *what would clear this* from
 * {jump, bow}; `urgent` answers *does it need acting on yet*; `hold` is derived from
 * the second rather than competing in the first.
 *
 *   node src/node/probe-decompose.js
 *
 * Variant L is what `QUESTIONS` in `../ollama/decider.js` is. It is the only framing in
 * any probe that reached all three maneuvers, and it is also the only one that had to
 * spell the game's rules into the question - variant K has the same shape with a neutral
 * `clear` and never picks `bow` at all. Read that as the cost of the approach: the model
 * is told the rules, not the answer.
 */

import { Ollama } from 'ollama/browser';
import { DEFAULT_HOST, DEFAULT_MODEL, KEEP_ALIVE } from '../config.js';

const client = new Ollama({ host: process.env.OLLAMA_HOST ?? DEFAULT_HOST });
const model = process.env.DECISAUR_MODEL ?? DEFAULT_MODEL;

const CASES = {
  'cactus, close': { scene: 'A large cactus is standing on the ground', gap: 120, truth: 'jump' },
  'cactus, far': { scene: 'A large cactus is standing on the ground', gap: 900, truth: 'hold' },
  'overhead bird, close': { scene: 'A pterodactyl is flying high in the air, well above the runner', gap: 130, truth: 'bow' },
  'overhead bird, far': { scene: 'A pterodactyl is flying high in the air, well above the runner', gap: 900, truth: 'hold' },
  'head-height bird, close': { scene: 'A pterodactyl is flying at the same height as the runner', gap: 130, truth: 'jump' },
};

const gapPhrase = (px) => {
  if (px <= 200) return 'very close, almost touching it';
  if (px <= 350) return 'close';
  if (px <= 700) return 'some way off';
  return 'far away';
};

/**
 * Score a decomposed answer against the three maneuvers. `hold` is derived rather
 * than predicted, so a variant can only be right for the right reason if the urgency
 * question separates the near scenes from the far ones.
 *
 * @param {string} label
 * @param {Record<string, any>} questions
 * @param {string} clearKey key of the {jump, bow} choice
 * @param {string} urgentKey key of the noul; true means act now
 */
async function probe(label, questions, clearKey, urgentKey) {
  const rows = [];
  for (const [name, scene] of Object.entries(CASES)) {
    const started = Date.now();
    const response = await client.systemone({
      model,
      state: `A T-Rex is running along the ground. ${scene.scene}, ${gapPhrase(scene.gap)} ahead.`,
      questions,
      keep_alive: KEEP_ALIVE,
    });
    const clear = response.answers[clearKey];
    const urgent = response.answers[urgentKey];
    const clearChoice = clear?.type === 'choice' ? clear.choice : '-';
    const urgentValue = urgent?.type === 'noul' ? urgent.noul : NaN;
    // hold is asserted when the model says the obstacle is not yet a threat.
    const choice = urgentValue < 0.5 ? 'hold' : clearChoice;
    rows.push({
      case: name,
      truth: scene.truth,
      choice,
      ok: choice === scene.truth ? 'ok ' : 'MISS',
      clear: `${clearChoice} p=${clear?.type === 'choice' ? (clear.probabilities[clearChoice] ?? 0).toFixed(2) : '-'}`,
      urgent: Number.isFinite(urgentValue) ? urgentValue.toFixed(2) : '-',
      conf: clear?.type === 'choice' ? clear.confidence.toFixed(3) : '-',
      ms: Date.now() - started,
    });
  }

  const hits = rows.filter((r) => r.ok === 'ok ').length;
  console.log(`\n=== ${label} ===`);
  for (const row of rows) {
    console.log(`  ${row.case.padEnd(24)} ${row.ok} truth=${row.truth.padEnd(5)} got=${row.choice.padEnd(5)} clear=${row.clear.padEnd(18)} urgent=${row.urgent} conf=${row.conf} ${row.ms}ms`);
  }
  console.log(`  accuracy ${hits}/${rows.length}`);
  return hits;
}

// --- K: {jump,bow} clearance + "must act now" --------------------------------
await probe(
  'K. clearance choice + must-act-now',
  {
    clear: {
      type: 'choice',
      instructions: 'Look at the obstacle ahead of the running T-Rex and say which maneuver would get past it.',
      criteria: {
        jump: 'Jump over it. Correct when the obstacle stands on the ground or flies at the runner\'s own height.',
        bow: 'Bow under it. Correct when the obstacle flies above the runner with open air underneath.',
      },
    },
    urgent: {
      type: 'noul',
      instructions: 'Is the obstacle close enough that the T-Rex must act right now rather than keep running for another moment?',
    },
  },
  'clear',
  'urgent',
);

// --- L: K, with the same rules spelled into the clearance instructions ---------
await probe(
  'L. clearance choice with explicit rules',
  {
    clear: {
      type: 'choice',
      instructions:
        'A T-Rex runs to the right and cannot stop. Say which maneuver clears the obstacle ahead.\n' +
        'Anything standing on the ground must be jumped. A bird flying above the runner must be bowed under. ' +
        'A bird flying at the runner\'s own height must be jumped, because bowing would not fit under it.',
      criteria: {
        jump: 'Jump: go over the top of it.',
        bow: 'Bow: shrink down and go underneath it.',
      },
    },
    urgent: {
      type: 'noul',
      instructions: 'Is the obstacle close enough that the T-Rex must act right now rather than keep running for another moment?',
    },
  },
  'clear',
  'urgent',
);

// --- M: K, but urgency framed as safety so the noul polarity is unambiguous ----
// A `noul` asks "is this true", so an inverted polarity silently inverts the meaning.
await probe(
  'M. clearance choice + "safe to keep running"',
  {
    clear: {
      type: 'choice',
      instructions: 'Look at the obstacle ahead of the running T-Rex and say which maneuver would get past it.',
      criteria: {
        jump: 'Jump over it. Correct when the obstacle stands on the ground or flies at the runner\'s own height.',
        bow: 'Bow under it. Correct when the obstacle flies above the runner with open air underneath.',
      },
    },
    safe: {
      type: 'noul',
      instructions: 'Can the T-Rex safely keep running for another moment without reaching the obstacle?',
    },
  },
  'clear',
  'safe',
);

// --- N: M plus a three-way question, to see whether a `noul` can carry hold -----
// If `hold` is expressible as its own boolean it never has to compete with the two
// active maneuvers for probability mass.
await probe(
  'N. clearance choice + separate "must bow" and "must act" booleans',
  {
    clear: {
      type: 'choice',
      instructions: 'Look at the obstacle ahead of the running T-Rex and say which maneuver would get past it.',
      criteria: {
        jump: 'Jump over it. Correct when the obstacle stands on the ground or flies at the runner\'s own height.',
        bow: 'Bow under it. Correct when the obstacle flies above the runner with open air underneath.',
      },
    },
    overhead: {
      type: 'noul',
      instructions: 'Is the obstacle flying above the runner with open air underneath it?',
    },
    actNow: {
      type: 'noul',
      instructions: 'Is the obstacle close enough that the T-Rex must act right now?',
    },
  },
  'clear',
  'actNow',
);
