/**
 * Geometry: when to press a key, and whether a maneuver can work at all.
 *
 * The decision model answers *what is in front of the dino*. This module answers
 * *whether a maneuver survives*, which is a question about collision geometry and
 * physics rather than about perception - and physics is precisely what a model
 * call taking 100-260ms is bad at. Keeping the two apart is what lets the bot
 * survive a slow model.
 *
 * Constants are read off the live game every frame and fall back to
 * `./constants.js`, so the jump arc tracks whatever Chrome build is running
 * instead of drifting from a baked-in table.
 */

import { TREX, TREX_BOXES } from './constants.js';

export const FPS = 60;

/** Extra vertical clearance we insist on, in px. */
export const CLEARANCE_MARGIN = 2;

/**
 * Phrase an obstacle's distance in words, for the model prompt.
 *
 * A bare pixel count is worse than nothing: the probes put correct `hold` answers at
 * 5/6 with a word ("far away") and 4/6 with the number stated outright. The model has
 * no scale for 900px, but it does have one for "far away", and `hold` is unreachable
 * without it.
 *
 * Boundaries follow the real timing rather than round numbers. At the game's top speed
 * of 13px/frame the ~260-370ms model round trip is 170-290px of travel, so anything
 * beyond a few hundred pixels is comfortably decidable before contact, and anything
 * inside 200px is already inside the jump window.
 *
 * @param {number} centreDistance Pixels from the dino's centre to the obstacle's.
 * @returns {string}
 */
export function describeDistance(centreDistance) {
  if (!Number.isFinite(centreDistance)) return 'far away';
  if (centreDistance <= 150) return 'very close, almost touching it';
  if (centreDistance <= 300) return 'close';
  if (centreDistance <= 600) return 'some way off';
  return 'far away';
}

/**
 * Read jump physics from a live `Trex.config`.
 *
 * The upstream config spells it `INIITAL_JUMP_VELOCITY`. A bot that reads only
 * the correctly spelled name silently falls back and jumps at the wrong height,
 * so both spellings are accepted. Note `Runner.config` also has an
 * `INITIAL_JUMP_VELOCITY`, but it is a positive 12 and lives on the *Runner*
 * config, not the T-Rex one - reading the wrong object is a real hazard here.
 */
export function readJumpConstants(tRexConfig) {
  const gravity = Number(tRexConfig?.GRAVITY);
  const initial = Number(tRexConfig?.INIITAL_JUMP_VELOCITY ?? tRexConfig?.INITIAL_JUMP_VELOCITY);
  return {
    gravity: Number.isFinite(gravity) && gravity > 0 ? gravity : TREX.GRAVITY,
    jumpVelocity0: Number.isFinite(initial) && initial !== 0 ? Math.abs(initial) : Math.abs(TREX.INITIAL_JUMP_VELOCITY),
    dropVelocity: Number(tRexConfig?.DROP_VELOCITY) || TREX.DROP_VELOCITY,
    maxJumpHeight: Number(tRexConfig?.MAX_JUMP_HEIGHT) || TREX.MAX_JUMP_HEIGHT,
    minJumpHeight: Number(tRexConfig?.MIN_JUMP_HEIGHT) || TREX.MIN_JUMP_HEIGHT,
    groundY: Number(tRexConfig?.groundYPos) || TREX.GROUND_Y,
  };
}

/**
 * Simulate one jump, returning height above the dino's standing top per frame.
 *
 * This mirrors `Trex.startJump` and `Trex.updateJump` exactly, including two
 * details that are easy to miss and that shift the whole arc:
 *
 *  - the game applies `jumpVelocity` to `yPos` and only *then* adds gravity, so
 *    the first frame moves at the full initial velocity;
 *  - on reaching `MAX_JUMP_HEIGHT` it calls `endJump()`, which clamps velocity to
 *    `DROP_VELOCITY` (-5) - still moving upwards. So the apex is *not* capped at
 *    `MAX_JUMP_HEIGHT`; the dino keeps rising, just more slowly, and peaks around
 *    91px above its standing top.
 *
 * @param {object} params
 * @param {number} params.gravity
 * @param {number} params.jumpVelocity0  Positive magnitude of `INITIAL_JUMP_VELOCITY`.
 * @param {number} [params.dropVelocity]  Negative, normally -5.
 * @param {number} [params.maxJumpHeight] Absolute `yPos` that triggers `endJump`.
 * @param {number} [params.minJumpHeight] Absolute `yPos` that counts as reaching min height.
 * @param {number} [params.groundY] The dino's standing `yPos`.
 * @param {number} [params.speed] The game scales initial velocity by `- speed / 10`.
 * @returns {{heights: number[], apex: number, apexFrame: number, airFrames: number}}
 */
export function jumpProfile({
  gravity,
  jumpVelocity0,
  dropVelocity = TREX.DROP_VELOCITY,
  maxJumpHeight = TREX.MAX_JUMP_HEIGHT,
  minJumpHeight = TREX.MIN_JUMP_HEIGHT,
  groundY = TREX.GROUND_Y,
  speed = 0,
}) {
  let velocity = -(jumpVelocity0 + speed / 10);
  let y = groundY;
  let reachedMinHeight = false;

  const heights = [0];
  let apex = 0;
  let apexFrame = 0;

  for (let frame = 1; frame < 400; frame += 1) {
    y += Math.round(velocity);
    velocity += gravity;
    heights.push(groundY - y);
    if (groundY - y > apex) {
      apex = groundY - y;
      apexFrame = frame;
    }

    if (y < minJumpHeight) reachedMinHeight = true;
    if (y < maxJumpHeight && reachedMinHeight && velocity < dropVelocity) velocity = dropVelocity;

    if (y > groundY) break;
  }

  return { heights, apex, apexFrame, airFrames: heights.length - 1 };
}

/**
 * The widest run of frames during which the dino is high enough to clear a
 * height, and its centre.
 *
 * The centre is the frame to aim for: the start of the window risks landing
 * early onto the far side of a wide cactus, and the end wastes clearance.
 *
 * @param {{heights: number[]}} profile
 * @param {number} requiredHeight
 * @returns {{start: number, end: number, centre: number, width: number} | null}
 */
export function clearanceWindow(profile, requiredHeight) {
  const heights = profile.heights;
  let best = null;
  let start = -1;

  const close = (end) => {
    const run = { start, end, width: end - start + 1, centre: Math.round((start + end) / 2) };
    if (best === null || run.width > best.width) best = run;
    start = -1;
  };

  for (let frame = 0; frame < heights.length; frame += 1) {
    if (heights[frame] >= requiredHeight) {
      if (start === -1) start = frame;
    } else if (start !== -1) {
      close(frame - 1);
    }
  }
  if (start !== -1) close(heights.length - 1);

  return best;
}

/**
 * Vertical and horizontal extent of an obstacle's collision boxes, absolute.
 *
 * @param {{x: number, y: number, width?: number, height?: number, boxes?: number[][]}} obstacle
 * @returns {{top: number, bottom: number, left: number, right: number}}
 */
export function obstacleExtent(obstacle) {
  const boxes = obstacle.boxes ?? [];
  if (boxes.length === 0) {
    return {
      top: obstacle.y,
      bottom: obstacle.y + (obstacle.height ?? 0),
      left: obstacle.x,
      right: obstacle.x + (obstacle.width ?? 0),
    };
  }
  let top = Infinity;
  let bottom = -Infinity;
  let left = Infinity;
  let right = -Infinity;
  for (const [bx, by, bw, bh] of boxes) {
    if (by < top) top = by;
    if (by + bh > bottom) bottom = by + bh;
    if (bx < left) left = bx;
    if (bx + bw > right) right = bx + bw;
  }
  return { top: obstacle.y + top, bottom: obstacle.y + bottom, left: obstacle.x + left, right: obstacle.x + right };
}

/**
 * Extent of the dino's collision boxes, absolute.
 *
 * Bowing does not move `yPos`; the shorter silhouette comes entirely from the
 * bowing box starting 18px lower, and that is what opens the clearance a high
 * bird needs.
 *
 * @param {{x: number, y: number, bowing: boolean}} tRex
 * @param {number[][]} [boxes]
 */
export function trexExtent(tRex, boxes) {
  const list = boxes ?? (tRex.bowing ? TREX_BOXES.BOWING : TREX_BOXES.RUNNING);
  let top = Infinity;
  let bottom = -Infinity;
  let left = Infinity;
  let right = -Infinity;
  for (const [bx, by, bw, bh] of list) {
    if (by < top) top = by;
    if (by + bh > bottom) bottom = by + bh;
    if (bx < left) left = bx;
    if (bx + bw > right) right = bx + bw;
  }
  return { top: tRex.y + top, bottom: tRex.y + bottom, left: tRex.x + left, right: tRex.x + right };
}
