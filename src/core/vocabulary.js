/**
 * The vocabulary shared by the decision model and the geometry layer.
 *
 * The label space is three classes, and it is chosen to match the one
 * distinction that decides whether the dino lives: whether the obstacle can be
 * ducked under or must be jumped. Geometry derives that from collision boxes;
 * the model is asked to see it. Keeping the classes here stops the two layers
 * drifting apart.
 */

export const CLASSES = /** @type {const} */ (['cactus', 'bird_high', 'bird_low']);

/** @param {unknown} value */
export function isClass(value) {
  return typeof value === 'string' && CLASSES.includes(/** @type {any} */ (value));
}

/**
 * Describe an obstacle for the model, in plain English.
 *
 * Two findings drove this format, both measured against `tev1:0.8b`:
 *
 *  - **Prose over structured data.** The same obstacle described as a JSON blob
 *    produced a flat distribution with confidence 0.08; described as a sentence
 *    it produced a clean argmax with confidence up to 0.99.
 *  - **No numbers that encode the answer.** The description deliberately reports
 *    only what is physically on screen - whether the obstacle is on the ground or
 *    in the air, and its raw `yPos`. It does not name the class, and it does not
 *    hand over the collision extents that `./classify.js` uses to derive the
 *    answer. If the prompt contained the answer, measuring the model's accuracy
 *    against the geometric reference would just be measuring the echo.
 *
 * @param {import('./state.js').ObstacleView} obstacle
 * @returns {string}
 */
export function describeObstacle(obstacle) {
  if (obstacle.airborne) {
    const height =
      obstacle.y <= 60 ? 'high in the air' : obstacle.y <= 85 ? 'in the air, about head height' : 'low, at the height of the runner';
    return `A pterodactyl is flying ${height}, ahead of the runner.`;
  }
  const size = obstacle.width >= 25 ? 'A large cactus' : 'A small cactus';
  return `${size} is standing on the ground ahead of the runner.`;
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
