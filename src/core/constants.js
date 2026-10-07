/**
 * Constants of the T-Rex runner, transcribed from the game source.
 *
 * Provenance: `Runner.config`, `Runner.defaultDimensions`, `Trex.config`,
 * `Trex.collisionBoxes` and `Obstacle.types` in the runner's `index.js`
 * (Chromium's `neterror` offline game and the widely used mirrors of it share
 * these values; note the upstream typo in `INIITAL_JUMP_VELOCITY`).
 *
 * The browser bot reads all of these back off the live game every frame and only
 * falls back to the numbers here. They are load-bearing for the headless
 * simulator, which has no live game to read.
 */

/** `var FPS = 60`. One `currentSpeed` unit is one pixel per frame. */
export const FPS = 60;

/** `Runner.defaultDimensions` and the canvas sizing. */
export const CANVAS = {
  WIDTH: 600,
  HEIGHT: 150,
};

/** `Runner.config`. */
export const RUNNER = {
  SPEED: 6,
  MAX_SPEED: 13,
  ACCELERATION: 0.001,
  BOTTOM_PAD: 10,
};

/**
 * `Trex.config`.
 *
 * `groundYPos = defaultDimensions.HEIGHT - Trex.config.HEIGHT - Runner.config.BOTTOM_PAD`
 * which is `150 - 47 - 10 = 93`. Careful: that is the *top* of the standing
 * dino sprite, not the floor line. Both the dino's and the obstacles' sprites
 * extend down to y=140, which is where the feet and the cactus bases are.
 */
export const TREX = {
  GROUND_Y: CANVAS.HEIGHT - 47 - RUNNER.BOTTOM_PAD, // 93
  WIDTH: 44,
  HEIGHT: 47,
  WIDTH_BOW: 59,
  HEIGHT_BOW: 25,
  START_X_POS: 50,
  DROP_VELOCITY: -5,
  GRAVITY: 0.6,
  INITIAL_JUMP_VELOCITY: -10,
  MAX_JUMP_HEIGHT: 30,
  MIN_JUMP_HEIGHT: 30,
  SPEED_DROP_COEFFICIENT: 3,
};

/**
 * `Trex.collisionBoxes`, as `[x, y, width, height]` offsets from the dino's
 * `xPos` / `yPos`. The dino does not move its `yPos` when bowing - the shorter
 * silhouette is expressed entirely by the bowing box starting 18px lower.
 */
export const TREX_BOXES = {
  RUNNING: [
    [22, 0, 17, 16],
    [1, 18, 30, 9],
    [10, 35, 14, 8],
    [1, 24, 29, 5],
    [5, 30, 21, 4],
    [9, 34, 15, 4],
  ],
  BOWING: [[1, 18, 55, 25]],
};

/**
 * `Obstacle.types`.
 *
 * Offsets are `[x, y, width, height]` from the obstacle's `xPos` / `yPos`.
 * Note how much smaller the collision extent is than the sprite: a pterodactyl
 * is 40px tall as a sprite but only 19px of collision, and its boxes are far
 * from the sprite's top-left. Classifying a bird by `yPos` alone is therefore
 * wrong - the boxes are what the game actually tests.
 */
export const OBSTACLE_TYPES = {
  CACTUS_SMALL: {
    width: 17,
    height: 35,
    yPos: 105,
    minGap: 120,
    boxes: [[0, 7, 5, 27], [4, 0, 6, 34], [10, 4, 7, 14]],
  },
  CACTUS_LARGE: {
    width: 25,
    height: 50,
    yPos: 90,
    minGap: 120,
    boxes: [[0, 12, 7, 38], [8, 0, 7, 49], [13, 10, 10, 38]],
  },
  PTERODACTYL: {
    width: 46,
    height: 40,
    yPos: [100, 75, 50],
    minGap: 150,
    minSpeed: 8.5,
    boxes: [[15, 15, 16, 5], [18, 21, 24, 6], [2, 14, 4, 3], [6, 10, 4, 7], [10, 8, 6, 9]],
    speedOffset: 0.8,
  },
};

/**
 * Chromium's own `Obstacle.types` uses different keys for the same sprites, and
 * its pterodactyl has two heights rather than three. Both spellings map onto the
 * same three classes so the bot works on either build.
 */
export const TYPE_ALIASES = {
  SMALL_CACTUS: 'CACTUS_SMALL',
  LARGE_CACTUS: 'CACTUS_LARGE',
  SMALL_CACTUS_GROUP: 'CACTUS_SMALL',
  LARGE_CACTUS_GROUP: 'CACTUS_LARGE',
};

/** Normalise an obstacle `type` string to a key of {@link OBSTACLE_TYPES}. */
export function canonicalType(type) {
  const name = String(type ?? '').toUpperCase();
  return TYPE_ALIASES[name] ?? name;
}

/** True for the airborne type, on any known build. */
export function isAirborneType(type) {
  return canonicalType(type) === 'PTERODACTYL';
}
