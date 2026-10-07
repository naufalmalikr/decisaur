/**
 * Controller: the bot's decision pipeline, with no DOM in it.
 *
 * Both front ends run this. The browser agent wraps it in a `requestAnimationFrame`
 * loop and dispatches synthetic key events; the headless runner wraps it in a
 * simulation step. Keeping it DOM-free is what makes that possible, and it means
 * the simulator exercises the same code path the browser does rather than a
 * reimplementation that can drift.
 *
 * Two switches shape the decision, both kept here so every front end inherits
 * them. `useModel` asks whether the model is consulted at all. `useReflex` asks
 * whether the model's answer must survive the gates in `policy.js` - confidence,
 * probability, geometry, and jump-window timing - or whether it is mapped
 * straight to an action with the model as sole pilot. The reflex plan is computed
 * either way: it carries the target and the geometric reference the prompt and
 * the scoring need, so only its *action* ever stops being authoritative.
 */

import { Decider } from '../ollama/decider.js';
import { readState, liveTokens, Tokeniser } from './state.js';
import { plan as reflexPlan } from './reflex.js';
import { resolve, resolveModelOnly, PolicyStats } from './policy.js';
import { describeObstacle, describeDino } from './vocabulary.js';
import { LOOP } from '../config.js';

/**
 * @typedef {object} Decision
 * @property {'jump'|'duck'|'hold'} action
 * @property {boolean} ducking  Whether the caller should be holding the duck key.
 * @property {'model'|'reflex'} source
 * @property {string} reason
 * @property {import('./reflex.js').Plan|null} plan
 * @property {import('../ollama/decider.js').ClassDecision|null} modelDecision
 */

export class Controller {
  /**
   * @param {object} [options]
   * @param {Decider} [options.decider]
   * @param {boolean} [options.useModel]
   * @param {boolean} [options.useReflex] False flies the model as the sole pilot
   *   (`resolveModelOnly()`), dropping every gate. Defaults to true.
   * @param {number} [options.perceptionRange]
   */
  constructor(options = {}) {
    this.decider = options.decider ?? new Decider();
    this.useModel = options.useModel !== false;
    this.useReflex = options.useReflex !== false;
    this.perceptionRange = options.perceptionRange ?? LOOP.perceptionRange;
    this.tokeniser = new Tokeniser();
    this.stats = new PolicyStats();

    this.ducking = false;
    /** Obstacles already jumped, so a single approach never presses twice. */
    this.committed = new Set();
    this.source = 'reflex';
    this.reason = 'standby';
    this.plan = null;
    this.state = null;
  }

  /** Switch the model off or on, keeping accumulated score. */
  setUseModel(useModel) {
    this.useModel = useModel;
  }

  /**
   * Switch between the gated policy (`true`) and model-only flight (`false`).
   *
   * @param {boolean} useReflex
   */
  setUseReflex(useReflex) {
    this.useReflex = useReflex;
  }

  /** Forget per-run state after a crash or restart. */
  reset() {
    this.ducking = false;
    this.committed.clear();
    this.plan = null;
    this.source = 'reflex';
    this.reason = 'standby';
    this.tokeniser.reset();
  }

  /** True when the dino should be holding the duck key after this decision. */
  get holdingDuck() {
    return this.ducking;
  }

  /**
   * Read the game, consult the model, and decide what to do this frame.
   *
   * Never throws and never awaits: if the model has not answered yet, the reflex
   * answer stands. A slow or unreachable model therefore cannot change how the
   * dino plays, only how it is described in the HUD.
   *
   * @param {any} runner The live `Runner.instance_` or the simulator's stand-in.
   * @returns {Decision}
   */
  decide(runner) {
    const state = runner === null || runner === undefined ? null : readState(runner, this.tokeniser);
    this.state = state;

    if (state === null) {
      this.reason = 'waiting for Runner.instance_';
      this.source = 'none';
      return this.result('hold', null);
    }

    if (!state.playing || state.crashed) {
      this.ducking = false;
      this.committed.clear();
      this.decider.prune(new Set());
      this.plan = reflexPlan(state);
      this.reason = state.crashed ? 'crashed' : 'standby';
      this.source = 'none';
      return this.result('hold', null);
    }

    const plan = reflexPlan(state);
    this.plan = plan;

    const target = plan.target;
    if (target === null || plan.analysis === null) {
      this.reason = 'clear';
      // `result()` reports `this.source`, and this path produces no outcome to
      // assign it from - without this it keeps the previous frame's value, so the
      // HUD showed a stale "reflex" on frames where no layer decided anything.
      this.source = 'none';
      return this.result('hold', null);
    }

    this.decider.prune(liveTokens(state));

    const asked = this.committed.has(target.token) || this.decider.get(target.token) !== undefined;
    if (this.useModel && plan.centreDistance <= this.perceptionRange && !asked) {
      void this.decider.request(target.token, `${describeDino(state)} ${describeObstacle(target)}`);
    }

    const decision = this.decider.get(target.token) ?? null;
    if (decision !== null) this.stats.scoreClassification(decision.kind || null, plan.analysis.geometric);

    const outcome = this.useReflex
      ? resolve({ decision, analysis: plan.analysis, reflexAction: plan.action })
      : resolveModelOnly({ decision, geometric: plan.analysis.geometric });
    this.stats.record(outcome);

    this.source = outcome.source;
    this.reason = outcome.source === 'model' ? outcome.reason : `${plan.reason} | ${outcome.reason}`;

    return this.result(outcome.action, decision);
  }

  /**
   * @param {'jump'|'duck'|'hold'} action
   * @param {import('../ollama/decider.js').ClassDecision|null} modelDecision
   */
  result(action, modelDecision) {
    // Never press duck while airborne: `Runner.onKeyDown` intercepts ArrowDown
    // during a jump and calls `setSpeedDrop()`, so the press would both slam the
    // dino down and be swallowed, leaving no duck at all.
    const airborne = this.state?.tRex.jumping === true;
    const safe = action === 'duck' && airborne ? 'hold' : action;

    if (safe === 'duck') {
      this.ducking = true;
    } else {
      this.ducking = false;
      if (action !== safe) this.reason = 'duck suppressed while airborne (would speed-drop)';
    }

    if (safe === 'jump' && this.plan?.target) {
      this.committed.add(this.plan.target.token);
    }

    return { action: safe, ducking: this.ducking, source: this.source, reason: this.reason, plan: this.plan, modelDecision };
  }
}
