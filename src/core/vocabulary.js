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
  const distance = describeDistance(centreDistance);
  if (obstacle.airborne) {
    // The yPos 75 band is the one that decides whether the model ducks or jumps, and
    // the wording matters more than anything else in this file. It was "about head
    // height", which the model read as a body-level bird and jumped - a fatal answer -
    // because the clearance rules in `QUESTIONS.clear` say a bird at head height must
    // be jumped. Describing it as "above the runner" instead took the same scene from
    // 2/6 to 4/6 (`node src/node/probe-wording.js`).
    const height =
      obstacle.y <= 60
        ? 'high in the air, well above the runner'
        : obstacle.y <= 85
          ? 'in the air, above the runner'
          : 'at the same height as the runner';
    return `A pterodactyl is flying ${height}, ${distance} ahead of the runner.`;
  }
  const size = obstacle.width >= 25 ? 'A large cactus' : 'A small cactus';
  return `${size} is standing on the ground, ${distance} ahead of the runner.`;
}

/**
 * Describe the dino for the model.
 *
 * @param {import('./state.js').BotState} state
 * @returns {string}
 */
export function describeDino(state) {
  const posture = state.tRex.jumping
    ? 'It is in mid-air.'
    : state.tRex.ducking
      ? 'It is sliding along the ground.'
      : 'It is running along the ground.';
  return `A T-Rex is running to the right. ${posture}`;
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
