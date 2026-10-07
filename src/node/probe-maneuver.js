/**
 * Why the maneuver question is decomposed into two questions.
 *
 * `probe-prompt.js` established that a single `choice` over `jump`/`bow`/`hold` latches
 * onto whichever option is described most forcefully: JSON state collapsed to "always
 * jump", and the sentence encoding separated jump from bow but never chose to do
 * nothing. Asking for an obstacle *class* instead was sharp (confidence 0.28-0.99) but
 * is not the decision - a class cannot express `hold`, and mapping it back to a
 * maneuver is the lookup table this change set out to remove.
 *
 * This probe re-runs the single-choice maneuver question across framings to find out
 * whether `hold` and `bow` can both be reached, and records the trade-off that makes
 * the decomposition necessary.
 *
 *   node src/node/probe-maneuver.js
 *
 * Each variant describes the SAME scenes with the SAME label space, so only the framing
 * varies. Distance is carried in words because `hold` is a statement about timing, not
 * about the obstacle.
 */

import { Ollama } from 'ollama/browser';
import { DEFAULT_HOST, DEFAULT_MODEL, KEEP_ALIVE } from '../config.js';

const client = new Ollama({ host: process.env.OLLAMA_HOST ?? DEFAULT_HOST });
const model = process.env.DECISAUR_MODEL ?? DEFAULT_MODEL;

/**
 * Scenes spanning the three maneuvers, plus the two bird heights the game actually
 * ships (README: Chrome has two, some mirrors use three).
 *
 * `truth` is read off the collision geometry in `classify.js`, not off intuition.
 */
const CASES = {
  'large cactus, close': { dino: 'running along the ground', obstacle: 'A large cactus is standing on the ground', gap: 120, truth: 'jump' },
  'large cactus, far': { dino: 'running along the ground', obstacle: 'A large cactus is standing on the ground', gap: 900, truth: 'hold' },
  'small cactus, close': { dino: 'running along the ground', obstacle: 'A small cactus is standing on the ground', gap: 140, truth: 'jump' },
  'bird overhead, close': { dino: 'running along the ground', obstacle: 'A pterodactyl is flying high in the air, well above the runner', gap: 130, truth: 'bow' },
  'bird overhead, far': { dino: 'running along the ground', obstacle: 'A pterodactyl is flying high in the air, well above the runner', gap: 900, truth: 'hold' },
  'bird at head height, close': { dino: 'running along the ground', obstacle: 'A pterodactyl is flying at the same height as the runner', gap: 130, truth: 'jump' },
};

/** @param {string} label @param {(c: any) => string} stateFor @param {Record<string, any>} questions */
async function probe(label, stateFor, questions, key = 'maneuver') {
  const rows = [];
  for (const [name, scene] of Object.entries(CASES)) {
    const started = Date.now();
    const response = await client.systemone({
      model,
      state: stateFor(scene),
      questions,
      keep_alive: KEEP_ALIVE,
    });
    const answer = response.answers[key];
    const choice = answer?.type === 'choice' ? answer.choice : '-';
    rows.push({
      case: name,
      truth: scene.truth,
      choice,
      ok: choice === scene.truth ? 'ok ' : 'MISS',
      p: answer?.type === 'choice' ? (answer.probabilities[answer.choice] ?? 0).toFixed(2) : '-',
      dist: answer?.type === 'choice'
        ? Object.entries(answer.probabilities).map(([k, v]) => `${k.slice(0, 4)}:${v.toFixed(2)}`).join(' ')
        : '-',
      conf: answer?.type === 'choice' ? answer.confidence.toFixed(3) : '-',
      ms: Date.now() - started,
    });
  }

  const hits = rows.filter((r) => r.ok === 'ok ').length;
  console.log(`\n=== ${label} ===`);
  for (const row of rows) {
    console.log(
      `  ${row.case.padEnd(28)} ${row.ok} truth=${row.truth.padEnd(5)} got=${row.choice.padEnd(5)}` +
        ` [${row.dist}] conf=${row.conf} ${row.ms}ms`,
    );
  }
  console.log(`  accuracy: ${hits}/${rows.length}`);
  return hits;
}

/** Distance in words, because a bare pixel count means nothing to a text model. */
const gapPhrase = (px) => {
  if (px <= 200) return 'very close, almost touching it';
  if (px <= 350) return 'close';
  if (px <= 700) return 'some way off';
  return 'far away';
};

const CRITERIA = {
  jump: 'Jump: press space to leap over the obstacle.',
  bow: 'Bow: press down to slide underneath the obstacle.',
  hold: 'Hold: take no action and keep running as it is.',
};

// --- Variant A: the wording in production today, but with distance added -------
await probe(
  'A. sentence state with distance',
  (s) => `A T-Rex is ${s.dino}. ${s.obstacle}, ${gapPhrase(s.gap)} ahead.`,
  {
    maneuver: {
      type: 'choice',
      instructions:
        'A T-Rex runs to the right at constant speed and cannot stop or reverse. ' +
        'One obstacle is approaching. Choose the maneuver that gets the T-Rex past it alive.',
      criteria: CRITERIA,
    },
  },
);

// --- Variant B: distance stated twice, since one mention reads as scenery -------
await probe(
  'B. distance stated explicitly',
  (s) =>
    `A T-Rex is ${s.dino}. ${s.obstacle} ahead of it.` +
    ` The obstacle is ${s.gap} pixels away - ${gapPhrase(s.gap)}.`,
  {
    maneuver: {
      type: 'choice',
      instructions:
        'A T-Rex runs to the right at constant speed and cannot stop or reverse. ' +
        'One obstacle is approaching. Choose the maneuver that gets the T-Rex past it alive.',
      criteria: CRITERIA,
    },
  },
);

// --- Variant C: the rules of the game spelled out as tactics -------------------
await probe(
  'C. explicit tactical rules',
  (s) => `A T-Rex is ${s.dino}. ${s.obstacle}, ${gapPhrase(s.gap)} ahead.`,
  {
    maneuver: {
      type: 'choice',
      instructions:
        'Choose the next move for a running T-Rex.\n' +
        'Rules of the game: a jump clears anything standing on the ground. ' +
        'A bow clears a bird flying high overhead. A bird flying at the runner\'s own height must be jumped. ' +
        'When the obstacle is still far away, do nothing and keep running.',
      criteria: {
        jump: 'Jump over it - correct for cacti and low-flying birds.',
        bow: 'Bow under it - correct for birds flying high overhead.',
        hold: 'Wait - correct when the obstacle is still far away.',
      },
    },
  },
);

// --- Variant D: two questions in one pass - what it is, and how urgent ---------
// One pass costs the same latency, and separating perception from urgency avoids
// asking a 0.8b model to hold an obstacle class and a distance in mind at once.
await probe(
  'D. class + urgency as two questions',
  (s) => `A T-Rex is ${s.dino}. ${s.obstacle}, ${gapPhrase(s.gap)} ahead.`,
  {
    kind: {
      type: 'choice',
      instructions: 'Look at the obstacle ahead of the running T-Rex and say what kind of obstacle it is.',
      criteria: {
        cactus: 'A cactus or other solid object standing on the ground.',
        bird_high: 'A bird flying high above the ground, with open space underneath it.',
        bird_low: 'A bird flying at the same height as the T-Rex.',
      },
    },
    urgent: {
      type: 'noul',
      instructions:
        'Is the obstacle close enough that the T-Rex must act right now rather than keep running for another moment?',
    },
  },
  'kind',
);

// --- Variant E: the same pair, but urgency phrased as a yes/no on action -------
await probe(
  'E. class + "must act now" phrased positively',
  (s) => `A T-Rex is ${s.dino}. ${s.obstacle}, ${gapPhrase(s.gap)} ahead.`,
  {
    kind: {
      type: 'choice',
      instructions: 'Look at the obstacle ahead of the running T-Rex and say what kind of obstacle it is.',
      criteria: {
        cactus: 'A cactus or other solid object standing on the ground.',
        bird_high: 'A bird flying high above the ground, with open space underneath it.',
        bird_low: 'A bird flying at the same height as the T-Rex.',
      },
    },
    mustActNow: {
      type: 'noul',
      instructions: 'Can the T-Rex keep running for another moment without hitting the obstacle?',
    },
  },
  'kind',
);
