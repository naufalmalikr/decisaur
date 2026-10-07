/**
 * Replay harness: put obstacle scenes in front of the System One model and report
 * what it classified them as.
 *
 * The fastest way to check the model integration, the prompt and the round-trip
 * latency without opening a browser. Each scene is fed through the same
 * `analyse` + `resolve` path the game uses, so the reported accuracy is the
 * model's accuracy against collision geometry, not against a hand-written label.
 *
 *   npm run replay
 *   node src/node/replay.js --repeat 5
 *   node src/node/replay.js --model tev1:0.8b --host http://127.0.0.1:11434
 *   node src/node/replay.js --verbose
 */

import { Decider } from '../ollama/decider.js';
import { resolve, PolicyStats } from '../core/policy.js';
import { analyse } from '../core/classify.js';
import { describeObstacle, describeDino } from '../core/vocabulary.js';
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

/** Scenes spanning every class the bot must tell apart. */
const SCENARIOS = [
  { name: 'cactus_large', yPos: 105, truth: 'cactus', prefer: 'jump' },
  { name: 'cactus_small', yPos: 90, truth: 'cactus', prefer: 'jump' },
  { name: 'bird_low', yPos: 100, truth: 'bird_low', prefer: 'jump' },
  { name: 'bird_mid', yPos: 75, truth: 'bird_high', prefer: 'duck' },
  { name: 'bird_high', yPos: 50, truth: 'bird_high', prefer: 'hold' },
];

/** Build the obstacle view and state the live game would present. */
function sceneFor(scenario, speed) {
  const type = scenario.yPos === 105 ? 'CACTUS_SMALL' : scenario.yPos === 90 ? 'CACTUS_LARGE' : 'PTERODACTYL';
  const config = OBSTACLE_TYPES[type];
  const airborne = type === 'PTERODACTYL';

  const obstacle = {
    token: scenario.name,
    type,
    canonical: canonicalType(type),
    x: 400,
    y: scenario.yPos,
    width: config.width,
    height: config.height,
    right: 400 + config.width,
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

  const centreDistance = obstacle.x + obstacle.width / 2 - (state.tRex.x + state.tRex.width / 2);
  return { state, obstacle, analysis: analyse(state, obstacle, centreDistance, speed) };
}

const args = parseArgs(process.argv.slice(2));
const decider = new Decider({ model: args.model, host: args.host });
const stats = new PolicyStats();

console.log(`model ${decider.model} @ ${args.host ?? 'http://127.0.0.1:11434'}`);
console.log(`scenes: ${SCENARIOS.length}  rounds: ${args.repeat}\n`);
console.log(['scene', 'model class', 'p', 'conf', 'geometry', 'outcome', 'ok', 'ms'].join('\t'));
console.log('-'.repeat(78));

let slowest = 0;

for (let round = 0; round < args.repeat; round += 1) {
  for (const scenario of SCENARIOS) {
    const speed = 6 + (round % 7);
    const { state, obstacle, analysis } = sceneFor(scenario, speed);
    const sentence = `${describeDino(state)} ${describeObstacle(obstacle)}`;
    if (args.verbose) console.log(`  state: ${sentence}`);

    const decision = await decider.request(`${scenario.name}-${round}`, sentence);
    stats.scoreClassification(decision?.kind || null, analysis.geometric);
    slowest = Math.max(slowest, decision?.latencyMs ?? 0);

    const outcome = resolve({ decision, analysis, reflexAction: analysis.preferred });
    stats.record(outcome);

    console.log(
      [
        scenario.name,
        decision?.kind || '-',
        (decision?.probability ?? 0).toFixed(2),
        (decision?.confidence ?? 0).toFixed(3),
        analysis.geometric ?? '-',
        `${outcome.action}/${outcome.source}`,
        decision?.kind === analysis.geometric ? ' ' : '!',
        String(decision?.latencyMs ?? '-'),
      ].join('\t'),
    );
  }
}

const summary = stats.summary();
const accuracy = summary.classificationAccuracy;
console.log('');
console.log(
  `classification accuracy vs collision geometry: ${accuracy === null ? 'n/a' : `${(accuracy * 100).toFixed(1)}%`} (${summary.correct}/${summary.classified})`,
);
console.log(`model used for ${summary.model}/${summary.total} decisions (${(summary.modelShare * 100).toFixed(0)}%)`);
console.log(`latency avg ${decider.averageLatencyMs.toFixed(0)}ms  slowest ${slowest}ms`);
console.log(`queries ${decider.stats.queries}  failures ${decider.stats.failures}  tokens ${decider.stats.tokens}`);
if (summary.topReasons.length > 0) {
  console.log('reflex overrides:');
  for (const [reason, count] of summary.topReasons) console.log(`  ${count}x  ${reason}`);
}

// The model is probabilistic and this is a measurement, not a gate.
process.exit(0);
