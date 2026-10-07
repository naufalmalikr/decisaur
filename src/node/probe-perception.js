/**
 * Perception probe: does the bot read each obstacle shape correctly?
 *
 * Exists because of a bug this repo could not see for itself. `npm run sim -- --model`
 * reported 73-78% maneuver accuracy for months, because `sim.js` builds obstacles in
 * the classic shape (`obstacle.type`). Current Chromium does not do that: `Obstacle`
 * carries only `typeConfig`, and `obstacle.type` is `undefined` forever - measured live,
 * `'type' in obstacle === false`. So the live game reported every bird as a ground
 * cactus, and every bird was described to the model as *"A large cactus is standing on
 * the ground"*, which the rule "anything standing on the ground must be jumped" then
 * answered with `jump` - forever. No bird sentence was ever sent, so `bow` was
 * unreachable and the dino never ducked. The harness could not show it because the
 * harness did not use the broken shape.
 *
 * So this probe pins the perception layer against all three shapes at once, which is
 * the whole point: a regression that only the browser can produce has to be
 * reproducible headlessly, or the next shape change repeats it unseen.
 *
 *   node src/node/probe-perception.js
 *
 * Exits non-zero on any mismatch, so it is usable as a gate.
 */

import { readState, Tokeniser } from '../core/state.js';
import { analyse } from '../core/classify.js';
import { describeObstacle } from '../core/vocabulary.js';
import { TREX, TREX_BOXES, OBSTACLE_TYPES } from '../core/constants.js';

/** Collision boxes as live Chromium `CollisionBox` objects, not plain tuples. */
const asCollisionBoxObjects = (tuples) => tuples.map(([x, y, width, height]) => ({ x, y, width, height }));

/**
 * The three shapes an obstacle can arrive in.
 *
 * `classic` is what every mirror and older Chromium does; `chromium` is what the live
 * game does now; `typeless` is the degenerate case where the name cannot be found at
 * all, which must stay `UNKNOWN` rather than silently defaulting to something survivable.
 *
 * @param {keyof typeof OBSTACLE_TYPES} key
 */
const SHAPES = {
  classic: (key, typeConfig, yPos) => ({
    type: key,
    typeConfig: { ...typeConfig, type: key },
    yPos,
    width: typeConfig.width,
    height: typeConfig.height,
    collisionBoxes: typeConfig.boxes,
  }),
  chromium: (key, typeConfig, yPos) => ({
    typeConfig: { ...typeConfig, type: chromiumNameFor(key) },
    yPos,
    width: typeConfig.width,
    height: typeConfig.height,
    collisionBoxes: typeConfig.boxes,
  }),
  typeless: (key, typeConfig, yPos) => ({
    yPos,
    width: typeConfig.width,
    height: typeConfig.height,
    collisionBoxes: typeConfig.boxes,
  }),
};

/** Chromium's own names for the same sprites, read off the live `horizon.obstacleTypes`. */
const CHROMIUM_NAMES = {
  CACTUS_SMALL: 'cactusSmall',
  CACTUS_LARGE: 'cactusLarge',
  PTERODACTYL: 'pterodactyl',
};

/** @param {keyof typeof OBSTACLE_TYPES} key */
function chromiumNameFor(key) {
  return CHROMIUM_NAMES[key];
}

/** The game state that surrounds an obstacle. Only the obstacle varies between cases. */
function runnerWith(obstacles) {
  return {
    playing: true,
    crashed: false,
    currentSpeed: 13,
    distanceRan: 1000,
    horizon: { obstacles, WIDTH: 600 },
    tRex: {
      xPos: 50,
      yPos: TREX.GROUND_Y,
      jumping: false,
      ducking: false,
      jumpingKeys: {},
      config: { WIDTH: TREX.WIDTH, HEIGHT: TREX.HEIGHT },
      collisionBoxes: TREX_BOXES,
    },
  };
}

/**
 * @param {Array<object>} cases
 * @returns {{failures: number, rows: object[]}}
 */
function probe(cases) {
  const failures = [];
  const rows = [];

  for (const testCase of cases) {
    const raw = testCase.build();
    const tokeniser = new Tokeniser();
    const state = readState(runnerWith([raw]), tokeniser);
    const view = state.obstacles[0];
    const dinoCentre = state.tRex.x + state.tRex.width / 2;
    const centreDistance = raw.xPos + raw.width / 2 - dinoCentre;
    const analysis = analyse(state, view, centreDistance, state.speed);
    const described = describeObstacle(view, centreDistance);

    const mismatches = [];
    for (const [key, expected] of Object.entries(testCase.expect)) {
      const actual = key === 'described' ? described : key === 'preferred' ? analysis.preferred : key === 'geometric' ? analysis.geometric : view[key];
      if (actual !== expected) mismatches.push(`${key}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }

    rows.push({ label: testCase.label, type: view.type, canonical: view.canonical, airborne: view.airborne, geometric: analysis.geometric, preferred: analysis.preferred, described, ok: mismatches.length === 0, mismatches });
    if (mismatches.length > 0) failures.push(...mismatches.map((m) => `${testCase.label} - ${m}`));
  }

  return { failures, rows };
}

const cases = [];

// The regression that shipped the bug: a live-Chromium bird must read as airborne, and
// must reach the model as a bird sentence rather than a cactus one.
for (const [shapeName, build] of Object.entries(SHAPES)) {
  for (const yPos of [100, 75, 50]) {
    const readsAsBird = shapeName !== 'typeless';
    const height = yPos <= 60 ? 'high in the air, well above the runner' : yPos <= 85 ? 'in the air, above the runner' : 'at the same height as the runner';
    cases.push({
      label: `bird yPos ${yPos} (${shapeName} shape)`,
      build: () => {
        const raw = build('PTERODACTYL', OBSTACLE_TYPES.PTERODACTYL, yPos);
        raw.xPos = 400;
        raw.speedOffset = 0.8;
        // Live Chromium hands over `CollisionBox` objects, not tuples.
        raw.collisionBoxes = asCollisionBoxObjects(OBSTACLE_TYPES.PTERODACTYL.boxes);
        return raw;
      },
      expect: readsAsBird
        ? { canonical: 'PTERODACTYL', airborne: true, geometric: yPos === 100 ? 'bird_low' : 'bird_high', described: `A bird is flying ${height}, some way off ahead of the runner.` }
        : { canonical: '', airborne: false, described: 'A large cactus is standing on the ground, some way off ahead of the runner.' },
    });
  }
}

// Cacti stay ground obstacles in every shape, and a Chromium cactus must no longer be
// UNKNOWN - that mislabelling is the same bug seen from the other side.
for (const [shapeName, build] of Object.entries(SHAPES)) {
  for (const [key, yPos] of [['CACTUS_LARGE', 90], ['CACTUS_SMALL', 105]]) {
    const named = shapeName !== 'typeless';
    const size = key === 'CACTUS_LARGE' ? 'A large' : 'A small';
    cases.push({
      label: `${key} (${shapeName} shape)`,
      build: () => {
        const raw = build(key, OBSTACLE_TYPES[key], yPos);
        raw.xPos = 400;
        raw.collisionBoxes = asCollisionBoxObjects(OBSTACLE_TYPES[key].boxes);
        return raw;
      },
      expect: named
        ? { canonical: key, airborne: false, geometric: 'cactus', preferred: 'jump', described: `${size} cactus is standing on the ground, some way off ahead of the runner.` }
        : { canonical: '', airborne: false, described: `${size} cactus is standing on the ground, some way off ahead of the runner.` },
    });
  }
}

const { failures, rows } = probe(cases);

console.log('decisaur perception probe - readState -> analyse -> describeObstacle');
console.log('');
console.log('case\tcanonical\tairborne\tgeometric\tpreferred\tobserved by the model');
console.log('-'.repeat(120));
for (const row of rows) {
  console.log(`${row.ok ? '  ok' : 'FAIL'} ${row.label.padEnd(34)} ${String(row.canonical).padEnd(9)} ${String(row.airborne).padEnd(9)} ${String(row.geometric).padEnd(10)} ${String(row.preferred).padEnd(10)} "${row.described}"`);
}

console.log('');
if (failures.length > 0) {
  for (const failure of failures) console.log(`  ${failure}`);
  console.log('');
  console.log(`${failures.length} perception mismatch(es).`);
  process.exit(1);
}

console.log(`all ${rows.length} cases read correctly across classic, chromium, and typeless shapes.`);