/**
 * Headless port of the T-Rex runner.
 *
 * Exists so the bot can be exercised without a browser. It is not a game engine:
 * it reproduces only what the bot reads and what decides survival - scroll speed,
 * obstacle spawning and spacing, jump physics, and collision detection - and it
 * presents a `runner` object with the same shape as the live `Runner.instance_`,
 * so `readState`, `reflexPlan` and `resolve` run unmodified against it.
 *
 * Every rule here is transcribed from the game source (see `./constants.js`):
 *   - `speed += ACCELERATION` per frame, capped at `MAX_SPEED`
 *   - `xPos -= Math.floor(speed * FPS / 1000 * deltaTime)`, i.e. `speed` px/frame
 *   - `gap = random(minGap, minGap * 1.5)` with
 *     `minGap = round(width * speed + type.minGap * GAP_COEFFICIENT)`
 *   - no more than two identical obstacle types in a row
 *   - pterodactyls need `speed >= 8.5` and scroll at `speed ± 0.8`
 *   - collision is the game's own two-stage test: a bounding-box broad phase, then
 *     an axis-aligned check of the dino's boxes against the obstacle's boxes, using
 *     the ducking set while ducking
 */

import { CANVAS, OBSTACLE_TYPES, RUNNER, TREX, TREX_BOXES } from '../core/constants.js';
import { FPS } from '../core/geometry.js';

const MAX_GAP_COEFFICIENT = 1.5;
const GAP_COEFFICIENT = 0.6;
const MAX_OBSTACLE_DUPLICATION = 2;
const TYPE_KEYS = Object.keys(OBSTACLE_TYPES);

/** Deterministic PRNG so runs are reproducible and failures can be re-run. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Axis-aligned overlap, as the game's `boxCompare`. */
function overlaps(a, b) {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

/** Fake T-Rex exposing the fields and statics `readState` probes. */
class SimTrex {
  constructor() {
    this.xPos = TREX.START_X_POS;
    this.groundYPos = TREX.GROUND_Y;
    this.yPos = this.groundYPos;
    this.minJumpHeight = this.groundYPos - TREX.MIN_JUMP_HEIGHT;
    this.jumpVelocity = 0;
    this.jumping = false;
    this.ducking = false;
    this.speedDrop = false;
    this.reachedMinHeight = false;
    this.jumpCount = 0;
    this.config = { ...TREX, GROUND_PAD: 0 };
  }
}
SimTrex.collisionBoxes = TREX_BOXES;

class SimObstacle {
  /**
   * @param {number[]} boxes
   * @param {object} params
   */
  constructor(boxes, { type, xPos, yPos, width, height, size, speedOffset, gap }) {
    this.type = type;
    this.xPos = xPos;
    this.yPos = yPos;
    this.width = width;
    this.height = height;
    this.size = size;
    this.speedOffset = speedOffset;
    this.gap = gap;
    this.collisionBoxes = boxes.map(([x, y, w, h]) => ({ x, y, width: w, height: h }));

    // Mirrors the game's group widening: the middle box stretches to span the group.
    if (size > 1) {
      this.collisionBoxes[1].width = this.width - this.collisionBoxes[0].width - this.collisionBoxes[2].width;
      this.collisionBoxes[2].x = this.width - this.collisionBoxes[2].width;
    }
  }
}

export class Sim {
  /** @param {{seed?: number, startSpeed?: number, groups?: boolean, birdsOnlyAfterSpeed?: boolean}} [options] */
  constructor(options = {}) {
    this.random = mulberry32(options.seed ?? 1);
    this.speed = options.startSpeed ?? RUNNER.SPEED;
    this.allowGroups = options.groups ?? true;
    this.width = CANVAS.WIDTH;
    this.distanceRan = 0;
    this.frame = 0;
    this.crashed = false;
    this.playing = true;
    this.duckHeld = false;
    /** @type {string[]} */
    this.obstacleHistory = [];
    /** @type {SimObstacle[]} */
    this.obstacles = [];
    this.tRex = new SimTrex();
    this.spawned = 0;
    /** Reason the run ended, for the report. */
    this.crashDetail = null;

    this.runner = {
      playing: true,
      crashed: false,
      currentSpeed: this.speed,
      distanceRan: 0,
      config: RUNNER,
      dimensions: { WIDTH: this.width, HEIGHT: CANVAS.HEIGHT },
      horizon: { WIDTH: this.width, dimensions: { WIDTH: this.width }, obstacles: this.obstacles },
      tRex: this.tRex,
    };

    this.addNewObstacle();
  }

  /** @param {number} min @param {number} max */
  randomInt(min, max) {
    return Math.floor(this.random() * (max - min + 1)) + min;
  }

  /**
   * Pick the next type, honouring the two-in-a-row limit and per-type minimum speed.
   */
  pickType() {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const type = TYPE_KEYS[this.randomInt(0, TYPE_KEYS.length - 1)];
      const config = OBSTACLE_TYPES[type];

      if (this.speed < (config.minSpeed ?? 0)) continue;

      const duplicates = this.obstacleHistory.filter((t) => t === type).length;
      if (duplicates >= MAX_OBSTACLE_DUPLICATION) continue;

      if (!this.allowGroups && type.startsWith('CACTUS')) {
        // keep the mix honest when groups are disabled
      }

      return type;
    }
    return this.speed >= OBSTACLE_TYPES.PTERODACTYL.minSpeed ? 'PTERODACTYL' : 'CACTUS_SMALL';
  }

  addNewObstacle() {
    const type = this.pickType();
    const config = OBSTACLE_TYPES[type];

    const yPos = Array.isArray(config.yPos) ? config.yPos[this.randomInt(0, config.yPos.length - 1)] : config.yPos;
    const speedOffset = config.speedOffset ? (this.random() > 0.5 ? config.speedOffset : -config.speedOffset) : 0;

    const size = this.allowGroups && type.startsWith('CACTUS') ? this.randomInt(1, 3) : 1;
    const width = config.width * size;

    const minGap = Math.round(width * this.speed + config.minGap * GAP_COEFFICIENT);
    const gap = this.randomInt(minGap, Math.round(minGap * MAX_GAP_COEFFICIENT));

    this.obstacles.push(new SimObstacle(config.boxes, { type, xPos: this.width, yPos, width, height: config.height, size, speedOffset, gap }));
    this.obstacleHistory.unshift(type);
    if (this.obstacleHistory.length > 1) this.obstacleHistory.splice(MAX_OBSTACLE_DUPLICATION);
    this.spawned += 1;
  }

  /** Apply one frame of input, then advance the world. */
  /**
   * @param {{jump?: boolean, duck?: boolean}} input
   */
  step(input) {
    const tRex = this.tRex;

    if (input.jump && !tRex.jumping && !tRex.ducking) {
      tRex.jumping = true;
      tRex.reachedMinHeight = false;
      tRex.speedDrop = false;
      tRex.jumpVelocity = TREX.INITIAL_JUMP_VELOCITY - this.speed / 10;
    }

    if (input.duck !== this.duckHeld) {
      this.duckHeld = input.duck === true;
      // The game only lets the dino duck while it is on the ground.
      tRex.ducking = this.duckHeld && !tRex.jumping;
    }

    this.advanceWorld();
  }

  advanceWorld() {
    const tRex = this.tRex;
    this.frame += 1;

    if (tRex.jumping) {
      tRex.yPos += Math.round(tRex.jumpVelocity);
      tRex.jumpVelocity += TREX.GRAVITY;

      if (tRex.yPos < tRex.minJumpHeight || tRex.speedDrop) tRex.reachedMinHeight = true;
      if (tRex.yPos < TREX.MAX_JUMP_HEIGHT) {
        if (tRex.reachedMinHeight && tRex.jumpVelocity < TREX.DROP_VELOCITY) tRex.jumpVelocity = TREX.DROP_VELOCITY;
      }

      if (tRex.yPos > tRex.groundYPos) {
        tRex.yPos = tRex.groundYPos;
        tRex.jumpVelocity = 0;
        tRex.jumping = false;
        tRex.jumpCount += 1;
      }
    } else {
      tRex.yPos = tRex.groundYPos;
    }

    for (const obstacle of this.obstacles) {
      obstacle.xPos -= Math.floor(this.speed + obstacle.speedOffset);
    }
    // Splice in place: `runner.horizon.obstacles` aliases this array, so replacing
    // it would leave the state reader looking at a different list of obstacles.
    for (let i = this.obstacles.length - 1; i >= 0; i -= 1) {
      if (this.obstacles[i].xPos + this.obstacles[i].width < 0) this.obstacles.splice(i, 1);
    }

    const last = this.obstacles[this.obstacles.length - 1];
    if (this.obstacles.length === 0 || (last && last.xPos + last.width + last.gap < this.width)) {
      this.addNewObstacle();
    }

    if (!this.crashed && this.collides()) {
      this.crashed = true;
      this.crashDetail = this.firstCollider();
      this.playing = false;
      this.runner.crashed = true;
      this.runner.playing = false;
      return;
    }

    this.distanceRan += this.speed;
    if (this.speed < RUNNER.MAX_SPEED) this.speed += RUNNER.ACCELERATION;

    this.runner.currentSpeed = this.speed;
    this.runner.distanceRan = this.distanceRan;
  }

  /** The game's own two-stage collision test. */
  collides() {
    const tRex = this.tRex;
    const trexBox = {
      x: tRex.xPos + 1,
      y: tRex.yPos + 1,
      width: tRex.config.WIDTH - 2,
      height: tRex.config.HEIGHT - 2,
    };
    const trexBoxes = tRex.ducking ? TREX_BOXES.DUCKING : TREX_BOXES.RUNNING;

    for (const obstacle of this.obstacles) {
      const obstacleBox = {
        x: obstacle.xPos + 1,
        y: obstacle.yPos + 1,
        width: OBSTACLE_TYPES[obstacle.type].width * obstacle.size - 2,
        height: obstacle.height - 2,
      };
      if (!overlaps(trexBox, obstacleBox)) continue;

      for (const [bx, by, bw, bh] of trexBoxes) {
        const t = { x: bx + trexBox.x, y: by + trexBox.y, width: bw, height: bh };
        for (const box of obstacle.collisionBoxes) {
          if (overlaps(t, { x: box.x + obstacleBox.x, y: box.y + obstacleBox.y, width: box.width, height: box.height })) {
            return true;
          }
        }
      }
    }
    return false;
  }

  /** Which obstacle ended the run, and where. */
  firstCollider() {
    const tRex = this.tRex;
    for (const obstacle of this.obstacles) {
      const trexBoxes = tRex.ducking ? TREX_BOXES.DUCKING : TREX_BOXES.RUNNING;
      const trexBox = { x: tRex.xPos + 1, y: tRex.yPos + 1 };
      for (const [bx, by, bw, bh] of trexBoxes) {
        const t = { x: bx + trexBox.x, y: by + trexBox.y, width: bw, height: bh };
        for (const box of obstacle.collisionBoxes) {
          const o = { x: box.x + obstacle.xPos + 1, y: box.y + obstacle.yPos + 1, width: box.width, height: box.height };
          if (overlaps(t, o)) {
            return { type: obstacle.type, yPos: obstacle.yPos, size: obstacle.size, tRexY: tRex.yPos, ducking: tRex.ducking, jumping: tRex.jumping };
          }
        }
      }
    }
    return null;
  }

  /** Metres as the game reports them: `distanceRan / (COEFFIENT * 1000)`-ish. */
  get score() {
    return Math.round(this.distanceRan * 0.025);
  }

  get speedNow() {
    return this.speed;
  }
}

export { FPS, TYPE_KEYS };
