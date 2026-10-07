/**
 * Classification and feasibility.
 *
 * Answers two questions about one obstacle:
 *
 *  1. **What is it?** - the class, which is what the System One model is asked.
 *  2. **What can be done about it?** - which maneuvers actually survive, derived
 *     from collision geometry rather than from a lookup table.
 *
 * The reference answer here reads the game's own collision boxes, so it needs no
 * inference and is what the model's opinion is scored against.
 *
 * The measured extents (from `./constants.js`) make the interesting cases
 * concrete. Standing dino occupies y 93-136, bowing dino y 111-136:
 *
 *   | obstacle        | extent  | bow | run  | required maneuver |
 *   |-----------------|---------|------|------|-------------------|
 *   | CACTUS_LARGE    | 90-140  | hit  | hit  | jump              |
 *   | CACTUS_SMALL    | 105-139 | hit  | hit  | jump              |
 *   | bird at y=100   | 108-127 | hit  | hit  | jump              |
 *   | bird at y=75    | 83-102  | free | hit  | bow (or jump)    |
 *   | bird at y=50    | 58-77   | free | free | hold              |
 *
 * Note that bowing works for *two* of the three bird heights, and only one of
 * those is a "high bird" by any naive `yPos` threshold. That is why classification
 * is derived from the boxes and not from a magic number.
 */

import { CLEARANCE_MARGIN, FPS, jumpProfile, obstacleExtent, trexExtent } from './geometry.js';

/**
 * @typedef {object} Analysis
 * @property {'cactus'|'bird_high'|'bird_low'|null} klass
 * @property {'cactus'|'bird_high'|'bird_low'|null} geometric Class derived from collision boxes.
 * @property {boolean} uncertain True when the obstacle is too unfamiliar to classify safely.
 * @property {Set<'jump'|'bow'|'hold'>} feasible
 * @property {'jump'|'bow'|'hold'} preferred
 * @property {number} requiredRise Height the dino must gain to clear the obstacle.
 * @property {number} apex Highest the jump can reach.
 * @property {number} timeToContactMs
 * @property {string} reason
 */

/**
 * Analyse an obstacle in the context of the current state.
 *
 * @param {import('./state.js').BotState} state
 * @param {import('./state.js').ObstacleView} obstacle
 * @param {number} centreDistance
 * @param {number} closingSpeed
 * @returns {Analysis}
 */
export function analyse(state, obstacle, centreDistance, closingSpeed) {
  const ext = obstacleExtent(obstacle);
  const boxes = state.trexBoxes;

  // Feasibility comes from the ground stance, never from the live y: obstacles
  // first become visible while the dino is still airborne from the last jump, and
  // measuring mid-air makes a bowable bird look jump-only.
  const stance = { x: state.tRex.x, y: state.groundY, bowing: false };
  const standing = trexExtent(stance, boxes?.RUNNING);
  const bowing = trexExtent(stance, boxes?.BOWING);

  const profile = jumpProfile({
    gravity: state.gravity,
    jumpVelocity0: state.jumpVelocity0,
    speed: state.speed,
  });
  const apex = profile.apex;

  // Jumping clears an obstacle when the dino's lowest collision pixel ends up
  // above the obstacle's highest one.
  const requiredRise = standing.bottom - ext.top + CLEARANCE_MARGIN;

  // `canonical` rather than `type`: the raw name is camelCase on Chromium and upper
  // snake on mirrors, and only the normalised key is safe to compare against.
  const airborne = obstacle.canonical === 'PTERODACTYL';
  const known = airborne || obstacle.boxes !== undefined || obstacle.knownType === true;

  const jumpFeasible = apex >= requiredRise;
  const bowFeasible = ext.bottom <= bowing.top;
  const holdFeasible = ext.bottom <= standing.top;

  const feasible = new Set();
  if (jumpFeasible) feasible.add('jump');
  if (bowFeasible) feasible.add('bow');
  if (holdFeasible) feasible.add('hold');
  if (feasible.size === 0) feasible.add('hold');

  // Cheapest maneuver that works. Holding costs nothing, so it wins whenever the
  // obstacle passes overhead untouched.
  let preferred;
  if (holdFeasible) preferred = 'hold';
  else if (bowFeasible) preferred = 'bow';
  else if (jumpFeasible) preferred = 'jump';
  else preferred = 'hold';

  // A bird is "high" when bowing clears it. Everything else airborne must be
  // jumped, which is exactly the distinction the model is asked to make.
  const geometric = !known
    ? null
    : airborne
      ? bowFeasible
        ? 'bird_high'
        : 'bird_low'
      : 'cactus';

  const reasons = [];
  if (!airborne) reasons.push('ground obstacle');
  else reasons.push(bowFeasible ? 'airborne, bow clears it' : 'airborne at body height');
  if (geometric === null) reasons.push('type unrecognised');
  reasons.push(`need ${requiredRise.toFixed(0)}px of rise, apex ${apex.toFixed(0)}px`);

  return {
    klass: geometric,
    geometric,
    uncertain: geometric === null,
    feasible,
    preferred,
    requiredRise,
    apex,
    timeToContactMs: closingSpeed > 0 ? (centreDistance / closingSpeed / FPS) * 1000 : Infinity,
    reason: reasons.join('; '),
  };
}
