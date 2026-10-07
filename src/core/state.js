/**
 * Perception: read a `BotState` out of the live game.
 *
 * Every read here is defensive. The runner's internals are not a public API and
 * get renamed between Chrome releases, so each field is probed and falls back to
 * a value from `./constants.js`. A bot that throws on a missing property is worse
 * than one that plays slightly worse.
 */

import { CANVAS, RUNNER, TREX, TREX_BOXES, canonicalType, isAirborneType, OBSTACLE_TYPES } from './constants.js';
import { readJumpConstants } from './geometry.js';

/**
 * Assigns each obstacle instance a stable token.
 *
 * The game pools obstacle objects and recycles them, so object identity is not a
 * durable id: a recycled cactus reuses the very same object, and a token cached
 * against it would return a stale decision belonging to a previous obstacle.
 *
 * Recycling is detectable, though. A live obstacle's `xPos` only ever decreases,
 * because `Obstacle.update` does `xPos -= floor(speed * FPS / 1000 * deltaTime)`.
 * Any movement to the right means the object was re-purposed, so the token rotates.
 */
export class Tokeniser {
  constructor() {
    /** @type {WeakMap<object, {token: string, lastX: number}>} */
    this.seen = new WeakMap();
    this.counter = 0;
  }

  /** @param {{xPos: number, type: string, yPos: number}} obstacle */
  tokenFor(obstacle) {
    const x = obstacle.xPos;
    const previous = this.seen.get(obstacle);

    if (previous === undefined || x > previous.lastX + 0.5) {
      this.counter += 1;
      const token = `${canonicalType(obstacle.type)}:${Math.round(obstacle.yPos)}:${this.counter}`;
      this.seen.set(obstacle, { token, lastX: x });
      return token;
    }

    previous.lastX = x;
    return previous.token;
  }

  reset() {
    this.seen = new WeakMap();
    this.counter = 0;
  }
}

/**
 * @typedef {object} ObstacleView
 * @property {string} token       Stable id for this obstacle instance.
 * @property {string} type        The game's own type string.
 * @property {string} canonical   Type normalised across Chromium and mirror builds.
 * @property {number} x
 * @property {number} y
 * @property {number} width
 * @property {number} height
 * @property {number} right
 * @property {boolean} airborne
 * @property {number[][]} boxes   Collision boxes as `[x, y, w, h]` offsets.
 * @property {boolean} knownType  Whether the type is one we recognise.
 * @property {number} speedOffset Extra scroll speed, e.g. the pterodactyl's ±0.8.
 */

/**
 * @typedef {object} BotState
 * @property {boolean} playing
 * @property {boolean} crashed
 * @property {number} speed
 * @property {number} distance
 * @property {number} canvasWidth
 * @property {{x: number, y: number, width: number, jumping: boolean, bowing: boolean, jumpVelocity: number}} tRex
 * @property {number[][]} trexBoxes
 * @property {ObstacleView[]} obstacles  Sorted left to right.
 * @property {ObstacleView|null} nearest
 * @property {number} gravity
 * @property {number} jumpVelocity0
 * @property {number} dropVelocity
 * @property {number} maxJumpHeight
 * @property {number} minJumpHeight
 * @property {number} groundY
 */

const num = (value, fallback = 0) => (typeof value === 'number' && Number.isFinite(value) ? value : fallback);

/**
 * Normalise collision boxes into plain `[x, y, width, height]` tuples.
 *
 * Accepts `CollisionBox` instances, which is what the live game exposes, and plain
 * tuples. The tuple branch matters: without it a build that hands over arrays
 * yields `[0,0,0,0]` boxes, collapsing every extent to a point and silently
 * disabling bow feasibility.
 *
 * @param {any} boxes
 * @returns {number[][]|undefined}
 */
function toTuples(boxes) {
  if (!Array.isArray(boxes) || boxes.length === 0) return undefined;
  return boxes.map((box) =>
    Array.isArray(box)
      ? [num(box[0]), num(box[1]), num(box[2]), num(box[3])]
      : [num(box.x), num(box.y), num(box.width), num(box.height)],
  );
}

/**
 * Read the current state out of a `Runner` instance.
 *
 * @param {any} runner The live `Runner.instance_`.
 * @param {Tokeniser} tokeniser
 * @returns {BotState}
 */
export function readState(runner, tokeniser) {
  const tRex = runner?.tRex ?? {};
  const tRexConfig = tRex.config ?? {};
  const horizon = runner?.horizon ?? {};

  const obstacles = [];
  for (const raw of horizon.obstacles ?? []) {
    if (!raw || typeof raw.xPos !== 'number') continue;
    // Cleared obstacles linger until they scroll off the left edge.
    if (raw.xPos + num(raw.width) < 0) continue;

    const canonical = canonicalType(raw.type);
    const knownType = canonical in OBSTACLE_TYPES;
    const boxes = toTuples(raw.collisionBoxes) ?? OBSTACLE_TYPES[canonical]?.boxes;

    obstacles.push({
      token: tokeniser.tokenFor(raw),
      type: String(raw.type ?? 'UNKNOWN'),
      canonical,
      x: num(raw.xPos),
      y: num(raw.yPos, TREX.GROUND_Y),
      width: num(raw.width),
      height: num(raw.height),
      right: num(raw.xPos) + num(raw.width),
      airborne: isAirborneType(raw.type),
      boxes,
      knownType,
      speedOffset: num(raw.speedOffset),
    });
  }

  obstacles.sort((a, b) => a.x - b.x);

  const jump = readJumpConstants({ ...tRexConfig, groundYPos: tRex.groundYPos });
  const boxSet = tRex.collisionBoxes ?? tRex.constructor?.collisionBoxes ?? TREX_BOXES;

  return {
    playing: runner?.playing === true,
    crashed: runner?.crashed === true,
    speed: num(runner?.currentSpeed, RUNNER.SPEED),
    distance: num(runner?.distanceRan),
    canvasWidth: num(horizon.WIDTH, num(horizon.dimensions?.WIDTH, CANVAS.WIDTH)),
    tRex: {
      x: num(tRex.xPos, TREX.START_X_POS),
      y: num(tRex.yPos, jump.groundY),
      width: num(tRexConfig.WIDTH, TREX.WIDTH),
      jumping: tRex.jumping === true,
      bowing: tRex.bowing === true,
      jumpVelocity: num(tRex.jumpVelocity),
    },
    // Both sets, not just the active one: "would standing clear this?" must not be
    // answered with the bowing silhouette just because the dino is bowing now.
    trexBoxes: {
      RUNNING: toTuples(boxSet.RUNNING) ?? TREX_BOXES.RUNNING,
      BOWING: toTuples(boxSet.BOWING) ?? TREX_BOXES.BOWING,
    },
    obstacles,
    nearest: obstacles[0] ?? null,
    ...jump,
  };
}

/** Tokens currently on screen, for pruning cached decisions. */
export function liveTokens(state) {
  return new Set(state.obstacles.map((o) => o.token));
}
