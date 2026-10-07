/**
 * Headless run harness.
 *
 * Drives the real `Controller` against the simulator in `./sim.js`, which is the
 * only way to test the bot's behaviour without sitting and watching a browser.
 *
 *   npm run sim                       reflex only
 *   npm run sim -- --oracle           model stands in for the collision geometry
 *   npm run sim -- --adversarial      model deliberately wrong, to test the gate
 *   npm run sim -- --frames 6000 --seed 7
 *   npm run sim -- --model            use real tev1:0.8b through Ollama
 *   npm run sim -- --no-reflex --model --fps 60
 *                                     model as sole pilot: no gates, no reflex veto.
 *                                     Expect a fast crash - that is the measurement.
 */

import { Sim } from './sim.js';
import { Controller } from '../core/controller.js';
import { Decider } from '../ollama/decider.js';

function parseArgs(argv) {
  const args = { frames: 4000, seed: 1, mode: 'reflex', verbose: false, model: undefined, host: undefined, runs: 1, fps: 0, noReflex: false };
  const valueOf = (argv, i) => {
    const next = argv[i + 1];
    return next === undefined || next.startsWith('--') ? undefined : next;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = valueOf(argv, i);
    if (flag === '--frames') { args.frames = Number.parseInt(value ?? '4000', 10); i += 1; }
    else if (flag === '--seed') { args.seed = Number.parseInt(value ?? '1', 10); i += 1; }
    else if (flag === '--runs') { args.runs = Number.parseInt(value ?? '1', 10); i += 1; }
    else if (flag === '--fps') { args.fps = Number.parseInt(value ?? '60', 10); i += 1; }
    else if (flag === '--model') { args.mode = 'model'; if (value !== undefined) { args.model = value; i += 1; } }
    else if (flag === '--host') { if (value !== undefined) { args.host = value; i += 1; } }
    else if (flag === '--oracle') args.mode = 'oracle';
    else if (flag === '--adversarial') args.mode = 'adversarial';
    else if (flag === '--no-reflex') args.noReflex = true;
    else if (flag === '--verbose') args.verbose = true;
  }
  return args;
}

/**
 * A stand-in for the System One model that answers from a fixed policy instead of
 * from Ollama. Lets the harness measure the pipeline without a 100-260ms round
 * trip per obstacle, and lets it prove the confidence gate actually protects the
 * dino when the model is wrong.
 */
class ScriptedDecider {
  /** @param {'oracle'|'adversarial'} strategy */
  constructor(strategy) {
    this.strategy = strategy;
    this.stats = { queries: 0, failures: 0, totalLatencyMs: 0, tokens: 0 };
    /** @type {Map<string, any>} */
    this.decisions = new Map();
    this.inFlight = 0;
  }

  /** @param {string} token */
  get(token) {
    return this.decisions.get(token);
  }

  /**
   * @param {string} token
   * @param {string} state Sentence describing the scene.
   * @param {'far'|'near'} band Which approach phase is being asked about.
   */
  async request(token, state, band = 'near') {
    if (this.decisions.has(token)) return this.decisions.get(token);
    this.inFlight += 1;

    // The far band is the whole scene at long range, where "wait" is correct and no
    // collision geometry has been consulted yet. Only the near band carries the
    // decision, which is what makes the oracle an oracle.
    if (band === 'far') {
      this.inFlight -= 1;
      return null;
    }

    const seesBird = state.includes('pterodactyl');
    const overhead = state.includes('well above the runner') || state.includes('above the runner,');
    const close = state.includes('very close') || state.includes('close ahead');
    let maneuver;
    if (this.strategy === 'oracle') {
      if (!close) maneuver = 'hold';
      else if (!seesBird) maneuver = 'jump';
      else maneuver = overhead ? 'bow' : 'jump';
    } else {
      // Always claims the worst thing it can, with total confidence.
      maneuver = seesBird ? 'jump' : 'bow';
    }

    const decision = {
      maneuver,
      clearance: 'jump',
      urgent: maneuver === 'hold' ? 0.1 : 0.9,
      isUrgent: maneuver !== 'hold',
      probability: 0.99,
      distribution: { [maneuver]: 0.99 },
      confidence: 0.99,
      latencyMs: 1,
      usage: { input_tokens: 0, output_tokens: 0 },
    };
    this.decisions.set(token, decision);
    this.stats.queries += 1;
    this.inFlight -= 1;
    return decision;
  }

  get averageLatencyMs() {
    return 1;
  }

  prune(live) {
    for (const token of this.decisions.keys()) if (!live.has(token)) this.decisions.delete(token);
  }

  reset() {
    this.decisions.clear();
  }
}

const args = parseArgs(process.argv.slice(2));

// Model-only flight still needs something to answer the classification question.
// Without a decider there is nothing to fly on, and silently falling back to the
// reflex layer would disguise the experiment as a success.
const decider =
  args.mode === 'model'
    ? new Decider({ model: args.model, host: args.host })
    : args.mode === 'oracle' || args.mode === 'adversarial'
      ? new ScriptedDecider(args.mode)
      : null;

if (args.noReflex && decider === null) {
  console.error('decisaur simulator: --no-reflex needs a decider; pass --model, --oracle, or --adversarial.');
  console.error('  model-only mode has no reflex action to fall back on, so reflex-only + --no-reflex is not a runnable experiment.');
  process.exit(1);
}

console.log(`decisaur simulator`);
console.log(`  mode    ${args.mode}${args.mode === 'model' ? ` (${decider.model})` : ''}${args.noReflex ? ' + no-reflex (model as sole pilot)' : ''}`);
console.log(`  runs    ${args.runs} x ${args.frames} frames  seed ${args.seed}`);
console.log('');

/**
 * Hand control back to the event loop.
 *
 * Without this the Ollama fetch never resolves: the first request stays in flight
 * forever and every run quietly falls back to the reflex layer with 0 queries.
 */
const yieldToEventLoop = () => new Promise((resolve) => setImmediate(resolve));

const results = [];

for (let run = 0; run < args.runs; run += 1) {
  const sim = new Sim({ seed: args.seed + run });
  const controller = new Controller({ decider, useModel: decider !== null, useReflex: !args.noReflex });
  const frameMs = args.fps > 0 ? 1000 / args.fps : 0;
  const startedAt = Date.now();

  let jumps = 0;
  let bows = 0;
  /**
   * One reference row per queried obstacle: the model's maneuver next to the one
   * collision geometry would have given for the same token. Decisions are pruned as
   * obstacles scroll away, so they are captured here while still visible.
   *
   * @type {{maneuver: string, clearance: string|null, urgent: number, preferred: string|null}[]}
   */
  const queries = [];
  /** @type {Set<string>} */
  const snapshotted = new Set();

  for (let frame = 0; frame < args.frames && !sim.crashed; frame += 1) {
    const decision = controller.decide(sim.runner);
    if (decision.action === 'jump') jumps += 1;
    if (decision.action === 'bow') bows += 1;

    if (args.verbose && frame % 600 === 0) {
      const p = decision.plan;
      console.log(
        `  f${String(frame).padStart(5)} speed ${sim.speedNow.toFixed(2)} d${Math.round(sim.distanceRan)} ` +
          `${p?.target ? `${p.analysis?.geometric} @${p.centreDistance.toFixed(0)}px ttc${p.timeToContactMs.toFixed(0)}ms` : 'clear'} ` +
          `-> ${decision.action} (${decision.source})`,
      );
    }

    sim.step({ jump: decision.action === 'jump', bow: controller.holdingBow });
    await yieldToEventLoop();

    // Snapshot each queried obstacle's answer against the geometric reference,
    // on the first frame the answer is visible to `decide()`. The decision cache
    // is pruned as obstacles scroll off, so this is the only place a per-query
    // comparison survives to the report.
    if (args.noReflex && decision.modelDecision !== null && decision.plan?.target) {
      const { token } = decision.plan.target;
      if (!snapshotted.has(token)) {
        snapshotted.add(token);
        queries.push({
          maneuver: decision.modelDecision.maneuver,
          clearance: decision.modelDecision.clearance || null,
          urgent: decision.modelDecision.urgent,
          preferred: decision.plan.analysis?.preferred ?? null,
        });
      }
    }

    // `--fps` holds the loop to wall clock so the single in-flight model slot
    // behaves as in a real game; unpaced, the loop ends before any query lands.
    if (frameMs > 0) {
      const due = startedAt + (frame + 1) * frameMs - Date.now();
      if (due > 1) await new Promise((resolve) => setTimeout(resolve, due));
    }
  }

  const stats = controller.stats.summary();
  const detail = sim.crashDetail;

  results.push({
    crashed: sim.crashed,
    frame: sim.frame,
    score: sim.score,
    distance: Math.round(sim.distanceRan),
    speed: sim.speedNow,
    jumps,
    bows,
    spawned: sim.spawned,
    model: stats.model,
    reflex: stats.reflex,
    accuracy: stats.maneuverAccuracy,
    classified: stats.scored,
    crashType: detail?.type ?? '-',
    crashY: detail?.yPos ?? '-',
    crashState: detail ? `${detail.jumping ? 'airborne' : detail.bowing ? 'bowing' : 'running'}` : '-',
  });

  const label = `run ${run + 1}`;
  if (sim.crashed) {
    console.log(
      `${label.padEnd(7)} CRASHED at frame ${String(sim.frame).padStart(5)}  score ${String(sim.score).padStart(5)}  ` +
        `hit ${detail?.type} y=${detail?.yPos} while ${detail?.jumping ? 'airborne' : detail?.bowing ? 'bowing' : 'running'}`,
    );
  } else {
    console.log(
      `${label.padEnd(7)} survived ${String(sim.frame).padStart(5)} frames  score ${String(sim.score).padStart(5)}  ` +
        `speed ${sim.speedNow.toFixed(2)}  ${sim.spawned} obstacles`,
    );
  }
  console.log(
    `        jumps ${jumps}  bows ${bows}  decisions: model ${stats.model} / ${args.noReflex ? 'unanswered' : 'reflex'} ${stats.reflex}` +
      (stats.maneuverAccuracy === null
        ? ''
        : `  maneuver accuracy ${(stats.maneuverAccuracy * 100).toFixed(1)}% (${stats.scored})`),
  );

  // Model-only runs print every query's pick next to the geometric reference, so
  // disagreement is visible per obstacle rather than only as an aggregate.
if (args.noReflex && decider !== null) {
    for (let i = 0; i < queries.length; i += 1) {
      const q = queries[i];
      const urgent = Number.isFinite(q.urgent) ? q.urgent.toFixed(2) : '-';
      const disagree = q.preferred !== null && q.maneuver !== q.preferred;
      console.log(
        `        query ${i + 1}: model ${q.maneuver} (clear ${q.clearance ?? '-'} urgent ${urgent})` +
          ` vs geometry ${q.preferred ?? '-'}${disagree ? '  <- disagree' : ''}`,
      );
    }
  }
}

const crashes = results.filter((r) => r.crashed).length;
console.log('');
console.log(`${results.length - crashes}/${results.length} runs survived`);

if (args.mode === 'reflex') {
  console.log('model detached; compare against --oracle and --adversarial, which should score the same.');
} else if (args.mode === 'oracle') {
  console.log('oracle model always agrees with geometry; the gate should therefore change nothing.');
} else if (args.mode === 'adversarial') {
  console.log('adversarial model always returns a confident wrong class; the gate should absorb all of it.');
} else {
  console.log(`model latency avg ${decider.averageLatencyMs.toFixed(0)}ms over ${decider.stats.queries} queries, ${decider.stats.failures} failures`);
}

if (args.noReflex) {
  const modelSourced = results.reduce((sum, r) => sum + r.model, 0);
  const totalDecisions = results.reduce((sum, r) => sum + r.model + r.reflex, 0);
  console.log(
    `model-only: the model sourced ${modelSourced} of ${totalDecisions} decisions ` +
      `(${decider.stats.queries} queries completed, avg latency ${decider.averageLatencyMs.toFixed(0)}ms); ` +
      `a jump fires the frame its answer arrives, so a crash here is the measurement.`,
  );
}

process.exit(0);
