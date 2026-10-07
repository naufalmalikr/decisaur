/**
 * Browser agent: wires the decision pipeline to a render loop and to the keyboard.
 *
 * All the decision logic lives in `../core/controller.js`, which the headless
 * simulator drives too. This file only does the two things that need a browser:
 * read the live `Runner.instance_` once per frame, and turn an action into
 * synthetic key events.
 */

import { Controller } from '../core/controller.js';
import { Decider } from '../ollama/decider.js';
import { jump, startBow, endBow } from './keys.js';
import { Hud } from './hud.js';

export class Agent {
  /**
   * @param {object} [options]
   * @param {string} [options.model]
   * @param {string} [options.host]
   * @param {boolean} [options.useModel] Set false to run the reflex layer alone.
   * @param {boolean} [options.useReflex] Set false to fly on the model alone.
   * @param {import('./modes.js').MODES[string]} [options.mode] Build mode.
   * @param {boolean} [options.hud]
   */
  constructor(options = {}) {
    this.model = options.model;
    this.decider = new Decider({ model: options.model, host: options.host });
    this.controller = new Controller({
      decider: this.decider,
      useModel: options.useModel !== false,
      useReflex: options.useReflex !== false,
    });
    this.mode = options.mode ?? null;
    this.hud = options.hud === false ? null : new Hud('decisaur');
    this.running = false;
    /** Mirrors what the keyboard currently has down, so we do not spam events. */
    this.bowHeld = false;

    this.tick = this.tick.bind(this);
  }

  /** Attach and start ticking. Safe to call before the game exists. */
  start() {
    if (this.running) return;
    this.running = true;
    const loop = () => {
      if (!this.running) return;
      try {
        this.tick();
      } catch (error) {
        // A throw inside the frame callback would stop the loop entirely, and a
        // dead bot is worse than a confused one.
        this.lastError = error instanceof Error ? error.message : String(error);
      }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  stop() {
    this.running = false;
    this.releaseBow();
    this.hud?.destroy();
  }

  /** Turn the model off or on without dropping the run. */
  setUseModel(useModel) {
    this.controller.setUseModel(useModel);
  }

  /** Turn the reflex veto off or on without dropping the run. */
  setUseReflex(useReflex) {
    this.controller.setUseReflex(useReflex);
  }

  releaseBow() {
    if (this.bowHeld) {
      endBow();
      this.bowHeld = false;
    }
  }

  /**
   * The live game singleton, or null when it is not up yet.
   *
   * Three separate things are wrong in the obvious one-liner, each found the hard
   * way, so do not "simplify" this back:
   *
   * 1. `globalThis.Runner` misses. A top-level `class Runner` in a classic script
   *    lives in the global lexical environment, which the console can see but
   *    `window` does not expose.
   * 2. `instance_` does not exist in current Chrome. The statics are
   *    `initializeInstance` / `getInstance`; the singleton moved behind
   *    `Runner.getInstance()`. Reading `instance_` returns undefined forever.
   * 3. `getInstance()` is a method that may hand back null before the game boots,
   *    so its result has to be checked rather than assumed.
   */
  static runner() {
    const lexical = typeof Runner === 'function' ? Runner : undefined;
    const ctor = lexical ?? (/** @type {any} */ (globalThis).Runner);
    if (ctor === undefined || ctor === null) return null;

    if (typeof ctor.getInstance === 'function') {
      const current = ctor.getInstance();
      if (current !== undefined && current !== null) return current;
    }

    return ctor.instance_ ?? null;
  }

  tick() {
    const decision = this.controller.decide(Agent.runner());

    if (decision.action === 'jump') jump();

    if (decision.bowing && !this.bowHeld) {
      startBow();
      this.bowHeld = true;
    } else if (!decision.bowing && this.bowHeld) {
      endBow();
      this.bowHeld = false;
    }

    this.render(decision);
  }

  render(decision) {
    if (this.hud === null) return;
    const plan = decision.plan;
    const modelDecision = plan?.target ? this.decider.get(plan.target.token) : undefined;

    this.hud.render({
      mode: this.mode === null
        ? `${this.controller.useModel ? this.model ?? 'model' : 'reflex only'}`
        : this.mode.label(this.model ?? 'model'),
      state: this.controller.state,
      plan,
      modelManeuver: modelDecision?.maneuver ?? null,
      modelClearance: modelDecision?.clearance || null,
      modelUrgent: modelDecision?.urgent ?? NaN,
      modelConfidence: modelDecision?.confidence ?? 0,
      modelProbability: modelDecision?.probability ?? 0,
      reason: this.lastError ? `error: ${this.lastError}` : decision.reason,
      source: decision.source,
      stats: this.controller.stats.summary(),
      reflexLabel: this.mode?.reflexLabel ?? 'reflex',
      decider: this.decider,
    });
  }
}
