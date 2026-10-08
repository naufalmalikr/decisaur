/**
 * The vocabulary shared by the decision model and the geometry layer.
 *
 * The model is asked to name the maneuver, so the description has to carry two
 * things: what the obstacle is, and how close it is. Distance is not decoration -
 * without it `hold` is unreachable. Across the probe framings, describing an obstacle
 * with no distance produced answers that never chose to do nothing, because nothing
 * in the sentence implied that waiting was an option.
 *
 * What stays withheld is the part `./classify.js` derives the reference from: the
 * collision extents, and the name of the maneuver. `yPos` is reported raw and the
 * description is in words, so the model has to do the reading that the geometric
 * reference does with numbers. Scoring the model against geometry only measures
 * something if the prompt does not already contain the answer.
 */

import { describeDistance } from './geometry.js';

/**
 * The three flight bands a bird can be in, as raw `yPos` ceilings.
 *
 * `PTERODACTYL.yPos` is `[100, 75, 50]` (`./constants.js`) and the collision extent runs
 * `yPos + 8` to `yPos + 27`, so those three values land the bird on the runner's body
 * (100 → 108-127, blocks stand *and* bow → jump), across its head (75 → 83-102, clears a
 * bow → bow) and over it (50 → 58-77, clears a run → nothing to do). Every yPos in
 * between falls in the band above it, which is why these are ceilings rather than
 * three hard-coded heights.
 *
 * The bands are ordered high-first because `yPos` grows downward, so the *lowest*
 * flying bird is the last entry. The wording is the load-bearing part, not the threshold:
 * `QUESTIONS.clear` quotes these phrases back verbatim, because a rule naming words the
 * sentence never used does not reach the model. They are plain altitude words - low,
 * middle, high - because the previous relative phrasing ("above the runner", "at the same
 * height as the runner") had to be explained by the rule and still left the yPos-75 bird
 * reading as a body-level one, which the model then jumped into.
 *
 * `overhead` marks the band whose nearest distance band cannot claim contact; see
 * `describeDistance()`.
 */
const BIRD_BANDS = [
  { maxY: 60, phrase: 'high in the air', overhead: true },
  { maxY: 85, phrase: 'at middle height in the air', overhead: false },
  { maxY: Infinity, phrase: 'low in the air', overhead: false },
];

/**
 * Which flight band a bird's `yPos` falls in.
 *
 * Falls back to the lowest band on a non-finite `yPos`, which `readState()` should never
 * produce but which must not turn into a crash inside the game loop.
 *
 * @param {number} yPos
 * @returns {{maxY: number, phrase: string, overhead: boolean}}
 */
function birdBand(yPos) {
  return BIRD_BANDS.find((band) => yPos <= band.maxY) ?? BIRD_BANDS[BIRD_BANDS.length - 1];
}

/**
 * Describe an obstacle for the model, in plain English.
 *
 * Three findings drove this format, all measured against `tev1:0.8b`:
 *
 *  - **Prose over structured data.** The same obstacle described as a JSON blob
 *    produced a flat distribution with confidence 0.08; described as a sentence it
 *    produced a clean argmax with confidence up to 0.99.
 *  - **Distance in words, and it must be there.** The probe put correct `hold`
 *    answers at 5/6 when distance was phrased ("far away", "close") and dropped to
 *    3/6 when it was absent. A bare pixel count read worse than a word did, so
 *    `describeDistance()` phrases it and the number is not included.
 *  - **No numbers that encode the answer.** The description reports only what is
 *    physically on screen - airborne or not, and the raw `yPos` - and never the
 *    collision extents `classify.js` uses to derive the reference.
 *
 * @param {import('./state.js').ObstacleView} obstacle
 * @param {number} centreDistance Pixels from the dino's centre to the obstacle's.
 * @returns {string}
 */
export function describeObstacle(obstacle, centreDistance) {
  if (obstacle.airborne) {
    const band = birdBand(obstacle.y);
    const distance = describeDistance(centreDistance, { overhead: band.overhead });
    return `A bird is flying ${band.phrase}, ${distance} the runner.`;
  }
  const distance = describeDistance(centreDistance);
  const size = obstacle.width >= 25 ? 'A large cactus' : 'A small cactus';
  return `${size} is standing on the ground, ${distance} the runner.`;
}

/**
 * Describe the dino for the model.
 *
 * "A man", not "A T-Rex", matching `QUESTIONS` in `../ollama/decider.js`. The reason
 * given for that swap was a learned dinosaur bias that would stop the model bowing, and
 * that has now been measured and does not hold: the same 15 replay scenes score 13/15
 * under either noun, with `clear` naming `bow` zero times in both. The only movement is
 * in how flat the distribution comes out - `jump` sits at 0.66 under "man" and 0.73 under
 * "A T-Rex" - so the species is not where the bias lives.
 *
 * Kept as "man" because a prompt that calls the same runner two different things is a
 * trap for whoever edits it next, not because it buys accuracy. `bow` being unreachable
 * is a fault in the question set, not in this sentence; see `QUESTIONS` and
 * `probe-decompose.js`.
 *
 * @param {import('./state.js').BotState} state
 * @returns {string}
 */
export function describeDino(state) {
  const posture = state.tRex.jumping
    ? 'It is in mid-air.'
    : state.tRex.bowing
      ? 'It is sliding along the ground.'
      : 'It is running along the ground.';
  return `A man is running to the right. ${posture}`;
}

/**
 * The full prompt state: the dino, the obstacle, and where the obstacle is.
 *
 * @param {import('./state.js').BotState} state
 * @param {import('./state.js').ObstacleView} obstacle
 * @param {number} centreDistance
 * @returns {string}
 */
export function describeState(state, obstacle, centreDistance) {
  return `${describeDino(state)} ${describeObstacle(obstacle, centreDistance)}`;
}
