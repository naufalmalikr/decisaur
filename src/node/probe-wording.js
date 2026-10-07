/**
 * Fourth-round probe: the same decomposition, scored through the production vocabulary.
 *
 * Rounds one to three compared framings against a hand-written scene description.
 * `npm run replay` then scored the production path at 5/15, and the disagreement is
 * specific: `bird_overhead` (yPos 75) is the one scene the model gets fatally wrong, and
 * it is the one scene the probe never asked about with production's own words.
 *
 * The probe described yPos 75 as "flying high in the air, well above the runner".
 * `vocabulary.js` describes it as "in the air, about head height" - and by that wording
 * "about head height" means a bird at body level, which the rules in `QUESTIONS.clear`
 * then say must be jumped. The model is reading the description correctly and following
 * the rule correctly; the description and the geometry simply disagree about what yPos
 * 75 is.
 *
 * So this round holds the question set fixed and varies only the description of yPos 75.
 *
 *   node src/node/probe-wording.js
 */

import { Ollama } from 'ollama/browser';
import { QUESTIONS } from '../ollama/decider.js';
import { DEFAULT_HOST, DEFAULT_MODEL, KEEP_ALIVE } from '../config.js';

const client = new Ollama({ host: process.env.OLLAMA_HOST ?? DEFAULT_HOST });
const model = process.env.DECISAUR_MODEL ?? DEFAULT_MODEL;

/**
 * What `analyse()` says each obstacle needs, from the collision boxes.
 *
 * Extents are transcribed from `constants.js`: the standing dino occupies y 93-136 and
 * the bowing dino y 111-136, so a bird is bowable whenever its bottom is above 111.
 */
const TRUTH = {
  'cactus_large@130': 'jump',
  'bird_body@130': 'jump',
  'bird_overhead@130': 'bow',
  'bird_sky_high@130': 'hold',
  'cactus_large@400': 'jump',
  'bird_overhead@400': 'bow',
};

/**
 * Descriptions of yPos 75, one per hypothesis about why the model fails it.
 */
const WORDINGS = {
  'production: "about head height"':
    'A bird is flying in the air, about head height, close ahead of the runner.',
  '"above the runner"':
    'A bird is flying in the air, above the runner, close ahead of the runner.',
  '"high above, clear underneath"':
    'A bird is flying high above the runner, with clear open space underneath it, close ahead of the runner.',
  '"overhead, level with the dino\'s back"':
    'A bird is flying over the runner at the level of the dino\'s back, close ahead of the runner.',
};

/** The other scenes, at the same distance, held fixed so only the wording varies. */
const FIXED = {
  'cactus_large@130': 'A large cactus is standing on the ground, very close, almost touching it ahead of the runner.',
  'bird_body@130': 'A bird is flying at the same height as the runner, very close, almost touching it ahead of the runner.',
  'bird_sky_high@130': 'A bird is flying high in the air, well above the runner, very close, almost touching it ahead of the runner.',
  'cactus_large@400': 'A large cactus is standing on the ground, some way off ahead of the runner.',
  'bird_overhead@400': null,
};

/** Production's own subject wording, from `describeDino()` in `../core/vocabulary.js`. */
const HEAD = 'A man is running to the right. It is running along the ground.';

for (const [label, overhead] of Object.entries(WORDINGS)) {
  console.log(`\n=== ${label} ===`);
  let hits = 0;
  let scored = 0;

  for (const [scene, truth] of Object.entries(TRUTH)) {
    const state = scene === 'bird_overhead@130' || scene === 'bird_overhead@400'
      ? `${HEAD} ${overhead}`
      : `${HEAD} ${FIXED[scene]}`;

    const started = Date.now();
    const response = await client.systemone({ model, state, questions: QUESTIONS, keep_alive: KEEP_ALIVE });
    const clear = response.answers.clear;
    const urgent = response.answers.urgent;
    const clearance = clear?.type === 'choice' ? clear.choice : '-';
    const noul = urgent?.type === 'noul' ? urgent.noul : NaN;
    const maneuver = !Number.isFinite(noul) || noul < 0.5 ? 'hold' : clearance;

    const ok = maneuver === truth;
    if (ok) hits += 1;
    scored += 1;
    const dist = clear?.type === 'choice'
      ? Object.entries(clear.probabilities).map(([k, v]) => `${k.slice(0, 4)}:${v.toFixed(2)}`).join(' ')
      : '-';

    console.log(
      `  ${scene.padEnd(20)} ${ok ? 'ok ' : 'MISS'} truth=${truth.padEnd(5)} got=${maneuver.padEnd(5)}` +
        ` clear=${clearance} [${dist}] urgent=${noul.toFixed(2)} ${Date.now() - started}ms`,
    );
  }

  console.log(`  accuracy ${hits}/${scored}`);
}
