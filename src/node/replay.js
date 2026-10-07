/**
 * Replay harness: put obstacle scenes in front of the System One model and report
 * what maneuver it chose.
 *
 * The fastest way to check the model integration, the prompt and the round-trip
 * latency without opening a browser. Each scene is fed through the same
 * `analyse` + `resolveManeuver` path the game uses, so the reported accuracy is the
 * model's accuracy against collision geometry, not against a hand-written label.
 *
 * Every obstacle is asked about at three distances, because the correct maneuver is a
 * function of distance as well as of shape. A high bird 900px out wants `hold`; the
 * same bird at 130px wants `duck`. Replaying each obstacle once would have measured
 * almost nothing, since every scene would land on the same `hold`.
 *
 *   npm run replay
 *   node src/node/replay.js --repeat 5
 *   node src/node/replay.js --model tev1:0.8b --host http://127.0.0.1:11434
 *   node src/node/replay.js --verbose
 */

import { Decider } from '../ollama/decider.js';
import { resolveManeuver, PolicyStats } from '../core/policy.js';
import { analyse } from '../core/classify.js';
import { plan as reflexPlan } from '../core/reflex.js';
import { describeState } from '../core/vocabulary.js';
import { readJumpConstants } from '../core/geometry.js';
import { TREX, TREX_BOXES, OBSTACLE_TYPES, canonicalType } from '../core/constants.js';

function parseArgs(argv) {
  const args = { repeat: 1, model: undefined, host: undefined, verbose: false };
  const valueOf = (i) => {
    const next = argv[i + 1];
    return next === undefined || next.startsWith('--') ? undefined : next;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = valueOf(i);
    if (flag === '--model') { args.model = value; if (value !== undefined) i += 1; }
    else if (flag === '--host') { args.host = value; if (value !== undefined) i += 1; }
    else if (flag === '--repeat') { args.repeat = Math.max(1, Number.parseInt(value ?? '1', 10)); i += 1; }
    else if (flag === '--verbose') args.verbose = true;
  }
  return args;
}

/** Obstacle shapes the bot must tell apart. Chrome ships two bird heights. */
const OBSTACLES = [
  { name: 'cactus_large', type: 'CACTUS_LARGE', yPos: 105 },
  { name: 'cactus_small', type: 'CACTUS_SMALL', yPos: 90 },
  { name: 'bird_body', type: 'PTERODACTYL', yPos: 100 },
  { name: 'bird_overhead', type: 'PTERODACTYL', yPos: 75 },
  { name: 'bird_sky_high', type: 'PTERODACTYL', yPos: 50 },
];

/**
 * Distances to ask about, in px from the dino's centre.
 *
 * 900 is off-screen-but-real and must be `hold`; 130 is inside the jump window and
 * must be acted on. 400 is the mid case, which is where a mistake is most expensive.
 */
const DISTANCES = [900, 400, 130];

/** Build the obstacle view and state the live game would present. */
function sceneFor(obstacleSpec, centreDistance, speed) {
  const type = obstacleSpec.type;
  const config = OBSTACLE_TYPES[type];
  const airborne = type === 'PTERODACTYL';
  const dinoCentre = TREX.START_X_POS + TREX.WIDTH / 2;
  const x = dinoCentre + centreDistance - config.width / 2;

  const obstacle = {
    token: obstacleSpec.name,
    type,
    canonical: canonicalType(type),
    x,
    y: obstacleSpec.yPos,
    width: config.width,
    height: config.height,
    right: x + config.width,
    airborne,
    boxes: config.boxes,
    knownType: true,
    speedOffset: 0,
  };

  const state = {
    playing: true,
    crashed: false,
    speed,
    distance: 0,
    canvasWidth: 600,
    tRex: { x: TREX.START_X_POS, y: TREX.GROUND_Y, width: TREX.WIDTH, jumping: false, ducking: false, jumpVelocity: 0 },
    trexBoxes: TREX_BOXES,
    obstacles: [obstacle],
    nearest: obstacle,
    ...readJumpConstants({ ...TREX, groundYPos: TREX.GROUND_Y }),
  };

  const analysis = analyse(state, obstacle, centreDistance, speed);
  return { state, obstacle, analysis, expected: reflexPlan(state).action };
}

const SCENARIOS = OBSTACLES.flatMap((obstacle) =>
  DISTANCES.map((distance) => ({ name: `${obstacle.name}@${distance}`, obstacle, distance })),
);

const args = parseArgs(process.argv.slice(2));
const decider = new Decider({ model: args.model, host: args.host });
const stats = new PolicyStats();

console.log(`model ${decider.model} @ ${args.host ?? 'http://127.0.0.1:11434'}`);
console.log(`scenes: ${SCENARIOS.length}  rounds: ${args.repeat}\n`);
console.log(['scene', 'model', 'clear', 'urgent', 'conf', 'reflex', 'action', 'ok', 'ms'].join('\t'));
console.log('-'.repeat(92));

let slowest = 0;

for (let round = 0; round < args.repeat; round += 1) {
  for (const scenario of SCENARIOS) {
    const speed = 6 + (round % 7);
    const { state, obstacle, expected } = sceneFor(scenario.obstacle, scenario.distance, speed);
    const sentence = describeState(state, obstacle, scenario.distance);
    if (args.verbose) console.log(`  state: ${sentence}`);

    const decision = await decider.request(`${scenario.name}-${round}`, sentence);
    if (decision !== null && !decision.error) stats.scoreManeuver(decision.maneuver, expected);
    slowest = Math.max(slowest, decision?.latencyMs ?? 0);

    const outcome = resolveManeuver({ decision, reflexAction: expected });
    stats.record(outcome);

    console.log(
      [
        scenario.name,
        decision?.maneuver ?? '-',
        decision?.clearance || '-',
        Number.isFinite(decision?.urgent) ? decision.urgent.toFixed(2) : '-',
        (decision?.confidence ?? 0).toFixed(3),
        expected,
        `${outcome.action}/${outcome.source}`,
        decision?.maneuver === expected ? ' ' : '!',
        String(decision?.latencyMs ?? '-'),
      ].join('\t'),
    );
  }
}

const summary = stats.summary();
const accuracy = summary.maneuverAccuracy;
console.log('');
console.log(
  `maneuver accuracy vs collision geometry: ${accuracy === null ? 'n/a' : `${(accuracy * 100).toFixed(1)}%`} (${summary.correct}/${summary.scored})`,
);
console.log(`model used for ${summary.model}/${summary.total} decisions (${(summary.modelShare * 100).toFixed(0)}%)`);
console.log(`latency avg ${decider.averageLatencyMs.toFixed(0)}ms  slowest ${slowest}ms`);
console.log(`queries ${decider.stats.queries}  failures ${decider.stats.failures}  tokens ${decider.stats.tokens}`);
if (summary.topReasons.length > 0) {
  console.log('reflex fallbacks:');
  for (const [reason, count] of summary.topReasons) console.log(`  ${count}x  ${reason}`);
}

// The model is probabilistic and this is a measurement, not a gate.
process.exit(0);
