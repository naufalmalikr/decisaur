/**
 * Controller: the bot's decision pipeline, with no DOM in it.
 *
 * Both front ends run this. The browser agent wraps it in a `requestAnimationFrame`
 * loop and dispatches synthetic key events; the headless runner wraps it in a
 * simulation step. Keeping it DOM-free is what makes that possible, and it means
 * the simulator exercises the same code path the browser does rather than a
 * reimplementation that can drift.
 *
 * Two switches shape the decision, both kept here so every front end inherits them.
 * `useModel` asks whether the model is consulted at all. `useReflex` asks what happens
 * during the window before it answers: with it, the reflex geometry serves every frame
 * the model has not yet replied for; without it, the dino does nothing until the model
 * commits. That window is real rather than theoretical - ~370ms of round trip against a
 * ~600ms perception range means the reflex is in charge for much of every approach.
 *
 * The reflex plan is computed either way. It carries the target, the prompt distance,
 * and the geometric reference the scoring needs, so only its *action* stops being
 * authoritative.
 */

import { Decider } from '../ollama/decider.js';
import { readState, liveTokens, Tokeniser } from './state.js';
import { plan as reflexPlan, jumpThreshold } from './reflex.js';
import { resolveManeuver, PolicyStats } from './policy.js';
import { describeState } from './vocabulary.js';
import { LOOP } from '../config.js';

/**
 * @typedef {object} Decision
 * @property {'jump'|'duck'|'hold'} action
 * @property {boolean} ducking  Whether the caller should be holding the duck key.
 * @property {'model'|'reflex'} source
 * @property {string} reason
 * @property {import('./reflex.js').Plan|null} plan
 * @property {import('../ollama/decider.js').ManeuverDecision|null} modelDecision
 */

/**
 * Distance at which an obstacle moves from the `far` approach band to `near`, in px.
 *
 * Chosen so the second query's ~240ms round trip still lands inside the clearance
 * window. At the game's top speed of 13px/frame that is ~180px of travel, putting the
 * answer around 120px - late, but `JUMP_AIM` sits past the middle of the window
 * precisely so a slightly late jump still clears. At the opening speed of 6px/frame it
 * is ~50px of travel and the answer is comfortably early.
 */
const NEAR_BAND_PX = 300;

export class Controller {
  /**
   * @param {object} [options]
   * @param {Decider} [options.decider]
   * @param {boolean} [options.useModel]
   * @param {boolean} [options.useReflex] Whether the reflex geometry covers the frames
   *   before the model answers. Defaults to true.
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
   * Switch whether the reflex covers the frames before the model answers.
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
   * answer stands. A slow or unreachable model therefore cannot crash the loop, and
   * with `useReflex` it cannot change how the dino plays - only how it is described
   * in the HUD.
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

    // Dedup belongs to the `Decider`, keyed per `(token, band)`. Gating it here as well
    // would suppress the second query: the far-band answer arrives at ~278px, by which
    // point the obstacle is already in the `near` band and a fresh answer is needed.
    const band = plan.centreDistance <= NEAR_BAND_PX ? 'near' : 'far';
    if (this.useModel && plan.centreDistance <= this.perceptionRange && !this.committed.has(target.token)) {
      void this.decider.request(target.token, describeState(state, target, plan.centreDistance), band);
    }

    const decision = this.decider.get(target.token) ?? null;
    if (decision !== null && !decision.error) {
      this.stats.scoreManeuver(decision.maneuver, plan.analysis.preferred);
    }

    const outcome = resolveManeuver({ decision, reflexAction: this.useReflex ? plan.action : 'hold' });
    this.stats.record(outcome);

    // A jump the model chose still has to be *timed*, and timing is not a decision.
    // The model's round trip is ~240ms - roughly 180px of travel at the game's top
    // speed - while the clearance window sits around 234px out. Firing the moment the
    // answer lands puts the dino on the obstacle instead of over it, which is how this
    // path died at frame 86 before the window was introduced.
    const action = outcome.action === 'jump' ? this.timedJump(plan, state) : outcome.action;

    this.source = outcome.source;
    this.reason = outcome.source === 'model' ? outcome.reason : `${plan.reason} | ${outcome.reason}`;

    return this.result(action, decision);
  }

  /**
   * Fire a jump only once the obstacle is inside the window geometry says clears it.
   *
   * Returns `hold` while waiting, which is indistinguishable from "decided not to jump"
   * from the dino's point of view - nothing is pressed either way.
   *
   * @param {import('./reflex.js').Plan} plan
   * @param {import('./state.js').BotState} state
   * @returns {'jump'|'hold'}
   */
  timedJump(plan, state) {
    if (state.tRex.jumping) return 'hold';
    const threshold = jumpThreshold(state, plan.analysis, plan.closingSpeed);
    if (plan.centreDistance <= threshold) return 'jump';
    this.reason = `model chose jump, waiting for window (${plan.centreDistance.toFixed(0)}/${threshold.toFixed(0)}px)`;
    return 'hold';
  }

  /**
   * @param {'jump'|'duck'|'hold'} action
   * @param {import('../ollama/decider.js').ManeuverDecision|null} modelDecision
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
