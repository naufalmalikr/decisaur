/**
 * Decision policy: the seam between what the model perceives and what the dino does.
 *
 * The model is asked one question per obstacle and takes ~100-260ms to answer,
 * while the game runs at 60Hz and the dino dies on contact. So the model never
 * gets the last word on its own. Its class must:
 *
 *  - name a class the vocabulary knows;
 *  - imply a maneuver that collision geometry says is feasible;
 *  - clear a probability and concentration gate.
 *
 * Anything else falls through to the reflex layer, with the reason recorded so the
 * HUD shows exactly how often the model is overruled and why.
 *
 * `resolveModelOnly()` is the control that measures what those gates are worth.
 * It maps the model's class straight to an action with none of the checks above -
 * no confidence floor, no probability gate, no geometry veto, and no check that
 * the reflex has armed a jump window - so the model can be flown as the sole
 * pilot. It exists to answer "what would the model alone manage?", and the crash
 * it produces is the measurement, not a fault to fix.
 *
 * Worth being blunt about what this project can and cannot show: because the
 * correct maneuver is fully determined by the game's own collision boxes, a
 * perfect classifier adds nothing to the score. What the model can do is make a
 * mistake, and the whole point of the gate plus `decisaur.reflexOnly()` is that
 * its mistakes are measurable and survivable. The HUD scores every
 * classification against the geometric reference so the claim can be checked
 * rather than believed.
 */

import { POLICY as DEFAULT_POLICY } from '../config.js';
import { isClass } from './vocabulary.js';

/**
 * The maneuver each class implies.
 *
 * A lookup, not a decision. The interesting question - high bird or low bird - is
 * the one the model is actually being asked.
 */
export const CLASS_TO_ACTION = {
  cactus: 'jump',
  bird_low: 'jump',
  bird_high: 'duck',
};

/**
 * Confidence floors per class, calibrated from measured `tev1:0.8b` output.
 *
 * The model is deterministic for a given prompt, so these come from repeated
 * sampling:
 *
 *   cactus    confidence 0.995   probability 1.00
 *   bird_high confidence 0.860   probability 0.97
 *   bird_low  confidence 0.317   probability 0.65
 *
 * `bird_low` is the hard call and the model knows it, splitting its remaining mass
 * between the two bird classes rather than committing. Guessing wrong there is
 * fatal, so birds carry a higher floor than cacti - but not higher than
 * `bird_low` actually scores, or the floor would veto a correct answer.
 *
 * Uninformative prompts measured around confidence 0.08-0.18, so anything at or
 * above 0.2 carries real signal.
 */
export const CLASS_MIN_CONFIDENCE = {
  cactus: 0.2,
  bird_high: 0.25,
  bird_low: 0.25,
};

/**
 * @typedef {object} Resolution
 * @property {'jump'|'duck'|'hold'} action
 * @property {'model'|'reflex'} source
 * @property {string} reason
 * @property {string} [class]
 */

/**
 * @param {object} params
 * @param {import('../ollama/decider.js').ClassDecision|null|undefined} params.decision
 * @param {import('./classify.js').Analysis} params.analysis
 * @param {'jump'|'duck'|'hold'} params.reflexAction
 * @param {typeof DEFAULT_POLICY} [params.policy]
 * @returns {Resolution}
 */
export function resolve({ decision, analysis, reflexAction, policy = DEFAULT_POLICY }) {
  const defer = (reason) => ({ action: reflexAction, source: 'reflex', reason });

  if (!decision) return defer('no model decision yet');
  if (decision.error) return defer(`model query failed: ${decision.error}`);

  const { kind, probability, confidence } = decision;

  if (!isClass(kind)) {
    return defer(`model named unknown class "${kind || 'none'}"`);
  }

  // When geometry cannot classify the obstacle at all, the model is the only
  // source of a class we have, so it is allowed to lead.
  if (analysis.uncertain) {
    return {
      action: CLASS_TO_ACTION[kind],
      source: 'model',
      reason: `geometry could not classify, model says ${kind}`,
      class: kind,
    };
  }

  const floor = CLASS_MIN_CONFIDENCE[kind] ?? policy.minConfidence;
  if (confidence < floor) {
    return defer(`model unsure about ${kind} (confidence ${confidence.toFixed(3)} < ${floor})`);
  }
  if (probability < policy.minProbability) {
    return defer(`model ${kind} only ${(probability * 100).toFixed(0)}%`);
  }

  if (analysis.geometric !== null && analysis.geometric !== kind) {
    return defer(`model says ${kind}, collision boxes say ${analysis.geometric}`);
  }

  const implied = CLASS_TO_ACTION[kind];
  if (!analysis.feasible.has(implied)) {
    const options = [...analysis.feasible].join('/') || 'nothing';
    return defer(`model says ${kind} (${implied}) but geometry allows ${options}`);
  }

  // Timing is not the model's to decide. A jump is only survivable inside the
  // clearance window geometry computes; letting the model also trigger it makes
  // the dino leap when the round trip completes rather than when the cactus
  // arrives, and land on it - which is how `--oracle` and `--adversarial` both
  // died within a second. Ducking and holding have no arc, so they stay offered.
  if (implied === 'jump' && reflexAction !== 'jump') {
    return defer(`model wants jump but the window is not open (reflex ${reflexAction})`);
  }

  return {
    action: implied,
    source: 'model',
    reason: `model ${kind} -> ${implied} @ ${(probability * 100).toFixed(0)}% (conf ${confidence.toFixed(2)})`,
    class: kind,
  };
}

/**
 * Resolve the model's answer with the model as the sole pilot.
 *
 * Deliberately skips every gate `resolve()` applies: no confidence floor, no
 * probability gate, no geometry veto, no feasibility check, and no requirement
 * that the reflex has armed a jump window. The reflex action is not consulted at
 * all, so there is nothing to defer to - the only safe fallback left is `hold`.
 *
 * There is no path through here where the reflex action is returned, which is the
 * point: this measures what the model alone can do, crash included. What it does
 * keep is the error handling - a missing, failed, or unclassifiable answer is a
 * `hold` with a reason, not an exception, because the game loop must not throw.
 *
 * @param {object} params
 * @param {import('../ollama/decider.js').ClassDecision|null|undefined} params.decision
 * @param {string|null} [params.geometric] The collision-geometry class, echoed for the record only.
 * @returns {Resolution}
 */
export function resolveModelOnly({ decision, geometric = null }) {
  if (!decision) return { action: 'hold', source: 'reflex', reason: 'no model decision yet' };
  if (decision.error) return { action: 'hold', source: 'reflex', reason: `model query failed: ${decision.error}` };

  const { kind } = decision;
  if (!isClass(kind)) {
    return { action: 'hold', source: 'reflex', reason: `model named unknown class "${kind || 'none'}"` };
  }

  return {
    action: CLASS_TO_ACTION[kind],
    source: 'model',
    reason: geometric === null
      ? `model ${kind} -> ${CLASS_TO_ACTION[kind]}, no geometric reference`
      : `model ${kind} -> ${CLASS_TO_ACTION[kind]} (geometry says ${geometric})`,
    class: kind,
  };
}

/** Rolling counters, surfaced in the HUD so overreach is measurable. */
export class PolicyStats {
  constructor() {
    this.model = 0;
    this.reflex = 0;
    this.correct = 0;
    this.wrong = 0;
    this.disagreements = 0;
    /** @type {Map<string, number>} */
    this.reasons = new Map();
  }

  /** @param {Resolution} outcome */
  record(outcome) {
    if (outcome.source === 'model') {
      this.model += 1;
    } else {
      this.reflex += 1;
      this.reasons.set(outcome.reason, (this.reasons.get(outcome.reason) ?? 0) + 1);
    }
  }

  /**
   * Score the model against the collision-geometry reference.
   *
   * @param {string|null} predicted
   * @param {string|null} truth
   */
  scoreClassification(predicted, truth) {
    if (predicted === null || truth === null) return;
    if (predicted === truth) this.correct += 1;
    else {
      this.wrong += 1;
      this.disagreements += 1;
    }
  }

  summary() {
    const total = this.model + this.reflex;
    const scored = this.correct + this.wrong;
    return {
      model: this.model,
      reflex: this.reflex,
      total,
      modelShare: total === 0 ? 0 : this.model / total,
      correct: this.correct,
      wrong: this.wrong,
      classificationAccuracy: scored === 0 ? null : this.correct / scored,
      classified: scored,
      topReasons: [...this.reasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4),
    };
  }
}
