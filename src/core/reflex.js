/**
 * Reflex layer: the part of the bot that always works.
 *
 * The model is consulted about once per obstacle and needs ~170ms to answer,
 * while an obstacle is on screen roughly 0.6-0.9s before contact. For much of
 * every approach there is no model opinion available, and a slow model must never
 * be able to kill the dino. This module decides from collision geometry alone and
 * is what actually keeps the bot alive.
 *
 * It is also the fallback whenever the policy layer rejects the model's answer,
 * which is what makes `decisaur.reflexOnly()` a meaningful A/B: if the model is
 * genuinely earning its place, the two should be indistinguishable in score and
 * the model should merely be faster to reach a wrong answer.
 */

import { JUMP_AIM } from '../config.js';
import { analyse } from './classify.js';
import { clearanceWindow, jumpProfile, obstacleExtent, trexExtent } from './geometry.js';


/**
 * How far ahead of the bowing dino's right edge a high bird triggers the bow.
 *
 * Bowing has no arc, so starting early is free, and at the game's top speed of
 * 13px/frame a 120px lead is only ~9 frames of warning.
 */
const BOW_LEAD_PX = 120;

/**
 * @typedef {object} Plan
 * @property {import('./state.js').ObstacleView|null} target
 * @property {import('./classify.js').Analysis|null} analysis
 * @property {'jump'|'bow'|'hold'} action
 * @property {boolean} release   True when a held bow should be released this frame.
 * @property {number} centreDistance
 * @property {number} closingSpeed
 * @property {number} timeToContactMs
 * @property {string} reason
 */

const IDLE = {
  target: null,
  analysis: null,
  action: 'hold',
  release: false,
  centreDistance: Infinity,
  closingSpeed: 0,
  timeToContactMs: Infinity,
  reason: 'no obstacle',
};

/**
 * How far ahead, in px, a jump becomes survivable.
 *
 * The distance the dino should be from `centreDistance` when it presses space: the
 * centre of the window in which it is high enough to clear `requiredRise`.
 *
 * Exported because the controller needs it even when the *decision* to jump came from
 * the model rather than from `plan()`. Timing is not a decision - it is when the
 * decision gets executed - so a model-chosen jump is still fired here. A jump pressed
 * the frame the model's answer arrives lands on the obstacle instead of clearing it.
 *
 * @param {import('./state.js').BotState} state
 * @param {import('./classify.js').Analysis} analysis
 * @param {number} closingSpeed
 * @returns {number} Distance in px, or `Infinity` when no jump can clear it.
 */
export function jumpThreshold(state, analysis, closingSpeed) {
  const profile = jumpProfile({
    gravity: state.gravity,
    jumpVelocity0: state.jumpVelocity0,
    dropVelocity: state.dropVelocity,
    maxJumpHeight: state.maxJumpHeight,
    minJumpHeight: state.minJumpHeight,
    groundY: state.groundY,
    speed: state.speed,
  });
  const window = clearanceWindow(profile, analysis.requiredRise);
  if (window === null) return Infinity;
  const aimFrame = window.start + JUMP_AIM * (window.end - window.start);
  return aimFrame * closingSpeed;
}

/**
 * Decide what to do this frame without consulting the model.
 *
 * @param {import('./state.js').BotState} state
 * @param {{jumpAim?: number}} [options]
 * @returns {Plan}
 */
export function plan(state, options = {}) {
  const jumpAim = options.jumpAim ?? JUMP_AIM;
  if (!state.playing || state.crashed) return IDLE;

  const target = state.nearest;
  if (target === null) return IDLE;

  // Pterodactyls scroll at `speed + speedOffset`, where the offset is a random
  // ±0.8, so the closing rate is not the dino's own speed.
  const closingSpeed = Math.max(state.speed + target.speedOffset, 0.001);
  const dinoCentre = state.tRex.x + state.tRex.width / 2;
  const centreDistance = target.x + target.width / 2 - dinoCentre;

  const analysis = analyse(state, target, centreDistance, closingSpeed);
  const base = { target, analysis, centreDistance, closingSpeed, timeToContactMs: analysis.timeToContactMs };

  // Airborne: the maneuver is committed and re-deciding is unsafe. Releasing
  // ArrowDown mid-jump calls `setSpeedDrop()`, which slams the dino to the floor.
  if (state.tRex.jumping) {
    return { ...base, action: 'hold', release: false, reason: 'airborne, maneuver committed' };
  }

  if (analysis.preferred === 'hold') {
    const behind = target.right < state.tRex.x - 4;
    if (state.tRex.bowing && !behind) {
      return { ...base, action: 'hold', release: true, reason: 'passing under, lifting the bow' };
    }
    return { ...base, action: 'hold', release: false, reason: 'obstacle passes overhead, keep running' };
  }

  if (analysis.preferred === 'bow') {
    const ext = obstacleExtent(target);
    const bowingBox = trexExtent(state.tRex, state.trexBoxes?.BOWING);

    if (ext.right < state.tRex.x) {
      return { ...base, action: 'hold', release: true, reason: 'bowed past the bird' };
    }
    if (ext.left < bowingBox.right + BOW_LEAD_PX) {
      return { ...base, action: 'bow', release: false, reason: `high bird, bowing at ${centreDistance.toFixed(0)}px` };
    }
    return { ...base, action: 'hold', release: false, reason: 'watching high bird' };
  }

  // Must jump. Aim the obstacle at the centre of the window in which the dino is
  // high enough to clear it, rather than at a fixed distance: the window moves
  // with speed because gravity is per-frame, not per-second.
  const profile = jumpProfile({
    gravity: state.gravity,
    jumpVelocity0: state.jumpVelocity0,
    dropVelocity: state.dropVelocity,
    maxJumpHeight: state.maxJumpHeight,
    minJumpHeight: state.minJumpHeight,
    groundY: state.groundY,
    speed: state.speed,
  });
  const window = clearanceWindow(profile, analysis.requiredRise);

  if (window === null) {
    return { ...base, action: 'hold', release: false, reason: 'jump cannot clear this obstacle' };
  }

  const aimFrame = window.start + jumpAim * (window.end - window.start);
  const threshold = aimFrame * closingSpeed;

  if (centreDistance <= threshold) {
    return { ...base, action: 'jump', release: false, reason: `jump window open at ${centreDistance.toFixed(0)}/${threshold.toFixed(0)}px` };
  }

  return { ...base, action: 'hold', release: false, reason: `holding, ${centreDistance.toFixed(0)}px out` };
}

