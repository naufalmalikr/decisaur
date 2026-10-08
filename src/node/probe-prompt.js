/**
 * Prompt-format probe for tev1:0.8b.
 *
 * The first replay run showed the model returning `jump` for every scenario,
 * including a high-flying bird that only bowing can clear. Before building on
 * top of it, find out whether that is the model being weak or the state /
 * question encoding being wrong.
 *
 *   node src/node/probe-prompt.js
 *
 * SUPERSEDED - kept as a historical record, not a description of the current design.
 *
 * This probe tests the obstacle-*class* question, which production no longer uses. The
 * class is distance-invariant and cannot express `hold`, so the maneuver had to be
 * recovered through a lookup table. It is kept because it is the first measurement that ruled the
 * maneuver-question approach out. Its latency-vs-question-count numbers are stale - see
 * `probe-latency.js` and the measured table in the README. For the question that ships, see
 * `probe-decompose.js`.
 */


import { Ollama } from 'ollama/browser';
import { HOST, MODEL, KEEP_ALIVE } from '../config.js';

const client = new Ollama({ host: HOST });
const model = MODEL;

/** The two situations the bot must tell apart, plus a negative control. */
const CASES = {
  'high bird (must bow)': {
    dino: { speed: 10, on_ground: true, bowing: false },
    obstacle: { kind: 'bird_high', ground: false, y: 75, height: 30 },
    gap_px: 110,
  },
  'large cactus (must jump)': {
    dino: { speed: 8, on_ground: true, bowing: false },
    obstacle: { kind: 'cactus_large', ground: true, height: 50 },
    gap_px: 92,
  },
  'far small cactus (hold)': {
    dino: { speed: 6, on_ground: true, bowing: false },
    obstacle: { kind: 'cactus_small', ground: true, height: 35 },
    gap_px: 520,
  },
};

/**
 * @param {string} label
 * @param {import('ollama/browser').SystemOneContent} state
 * @param {import('ollama/browser').SystemOneQuestion[]} questions
 */
async function probe(label, stateFor, questions) {
  const rows = [];
  for (const [name, scenario] of Object.entries(CASES)) {
    const started = Date.now();
    const response = await client.systemone({
      model,
      state: stateFor(scenario),
      questions,
      keep_alive: KEEP_ALIVE,
    });
    const answer = response.answers.maneuver;
    rows.push({
      case: name,
      choice: answer?.type === 'choice' ? answer.choice : '-',
      p: answer?.type === 'choice' ? (answer.probabilities[answer.choice] ?? 0).toFixed(2) : '-',
      conf: answer?.type === 'choice' ? answer.confidence.toFixed(3) : '-',
      ms: Date.now() - started,
    });
  }
  console.log(`\n=== ${label} ===`);
  for (const row of rows) {
    console.log(`  ${row.case.padEnd(26)} -> ${row.choice.padEnd(5)} p=${row.p} conf=${row.conf} ${row.ms}ms`);
  }
  const picks = rows.map((r) => r.choice);
  const distinct = new Set(picks).size;
  console.log(`  distinct outputs: ${distinct}/${picks.length} ${distinct > 1 ? '<-- discriminates' : '<-- constant'}`);
  return picks;
}

// --- Variant A: the current production encoding ------------------------------
const Q_PRODUCTION = {
  maneuver: {
    type: 'choice',
    instructions:
      'A man runs to the right at constant speed and cannot stop or reverse. ' +
      'One obstacle is approaching. Choose the maneuver that gets the man past it alive.',
    criteria: {
      jump: 'Jump: press space to leap over the obstacle.',
      bow: 'Bow: press down to slide underneath the obstacle.',
      hold: 'Hold: take no action and keep running.',
    },
  },
};
await probe('A. production (JSON state, production question)', (s) => s, Q_PRODUCTION);

// --- Variant B: plain-English state string ----------------------------------
const stateToText = (s) => {
  const o = s.obstacle;
  if (o.ground) {
    return `The man is running on the ground at speed ${s.dino.speed}. A ${o.kind.replace('_', ' ')} is on the ground ahead, ${s.gap_px} pixels away. It is too tall to bow under.`;
  }
  return `The man is running on the ground at speed ${s.dino.speed}. A bird is flying ahead at height ${o.y}, ${s.gap_px} pixels away. It flies high enough to bow under.`;
};
await probe('B. plain-English state string', stateToText, Q_PRODUCTION);

// --- Variant C: english state + tactical instructions in the question -------
const Q_TACTICAL = {
  maneuver: {
    type: 'choice',
    instructions:
      'Choose the next move for a running man.\n' +
      'Rules of the game: a jump clears anything on the ground. A bow clears a bird flying overhead. ' +
      'A bird flying at head height must be jumped. Take no action when the obstacle is still far away.',
    criteria: {
      jump: 'Jump over it - correct for cacti and low-flying birds.',
      bow: 'Bow under it - correct for birds flying high overhead.',
      hold: 'Wait - correct when the obstacle is still far away.',
    },
  },
};
await probe('C. english state + tactical rules', stateToText, Q_TACTICAL);

// --- Variant D: rule-only question, state carries no numbers ----------------
const stateRules = (s) =>
  s.obstacle.ground
    ? 'The obstacle ahead is a cactus sitting on the ground.'
    : 'The obstacle ahead is a bird flying high above the ground.';
await probe('D. categorical state only', stateRules, Q_TACTICAL);

// --- Variant E: the real discriminator - ask the model two binary questions -
const Q_BINARY = {
  blocking: {
    type: 'noul',
    instructions: 'Is the obstacle a solid object resting on the ground, such as a cactus?',
  },
  overhead: {
    type: 'noul',
    instructions: 'Is the obstacle a bird flying in the air above ground level?',
  },
  immediate: {
    type: 'noul',
    instructions: 'Is the obstacle close enough that the man must act within the next half second?',
  },
};
console.log('\n=== E. three binary perceptions (noul) ===');
for (const [name, scenario] of Object.entries(CASES)) {
  const started = Date.now();
  const response = await client.systemone({ model, state: scenario, questions: Q_BINARY, keep_alive: KEEP_ALIVE });
  const p = Object.fromEntries(
    Object.entries(response.answers).map(([k, v]) => [k, v.type === 'noul' ? v.noul.toFixed(2) : '-']),
  );
  console.log(`  ${name.padEnd(26)} -> ${JSON.stringify(p)} ${Date.now() - started}ms`);
}
