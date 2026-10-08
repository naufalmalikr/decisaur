/**
 * Decision policy: the seam between what the model perceives and what the dino does.
 *
 * The model is asked which maneuver clears the obstacle and whether it needs acting on
 * yet, and it takes ~170ms to answer while the game runs at 60Hz and the dino dies
 * on contact. So the question of whether its answer is allowed to act has to be asked
 * explicitly, and the honest answer here is that **it is not gated at all**.
 *
 * That is a measured decision, not an oversight. The decomposed question set in
 * `../ollama/decider.js` reports a `clear` confidence of 0.000-0.054 on answers that
 * are *correct*, with per-class probabilities as flat as `bow 0.51 / jump 0.49`. This
 * model can name the right maneuver and has no idea how sure it is. Every gate that
 * existed for the obstacle-class question - a per-class confidence floor, a probability
 * floor, a geometry veto - was calibrated against a signal that scored 0.28-0.99, and
 * none of them would survive contact with this one. They would reject nearly every
 * answer, including the correct ones, and the feature would appear to work while never
 * firing.
 *
 * So `resolveManeuver()` gives the model sole authority over the action, and the
 * reflex layer is left with exactly one job: to act while there is no answer yet. That
 * is not a cosmetic fallback - at ~170ms against a ~590ms perception range, ~71% of
 * every approach has no model opinion available.
 *
 * What this costs is stated plainly rather than discovered later: the model can now be
 * wrong, and nothing catches it. `PolicyStats.scoreManeuver()` scores every decision
 * against the maneuver collision geometry says is survivable, so the error rate is a
 * measured number in the HUD and in `npm run replay` rather than a surprise. Expect it
 * to be poor. `npm run sim -- --model --fps 60` is the headless version of the same
 * measurement, and it dies.
 */

/**
 * @typedef {object} Resolution
 * @property {'jump'|'bow'|'hold'} action
 * @property {'model'|'reflex'} source
 * @property {string} reason
 * @property {string} [clearance] What the model's `clear` question chose.
 */

/**
 * The model's maneuver, unchecked.
 *
 * Only two things can stop it, and neither is a gate on its opinion:
 *
 *  - **No answer yet.** The obstacle is visible for ~590ms and the model needs ~170ms
 *    to reply, so ~71% of every approach is served by the reflex. That is
 *    the reflex's remaining job and the only reason it survives.
 *  - **A failed or nonsensical answer.** An unreachable Ollama, or a response where
 *    neither question parsed, has no opinion to act on and falls back.
 *
 * Note what is *not* consulted: the geometric reference. The model's maneuver is not
 * compared against `analysis.preferred`, because comparing them and then preferring the
 * model's answer is not a gate - it is decoration, and it would produce the false
 * impression that geometry is checking the model.
 *
 * @param {object} params
 * @param {import('../ollama/decider.js').ManeuverDecision|null|undefined} params.decision
 * @param {'jump'|'bow'|'hold'} params.reflexAction  Serves as the answer until one arrives.
 * @returns {Resolution}
 */
export function resolveManeuver({ decision, reflexAction }) {
  if (!decision) return { action: reflexAction, source: 'reflex', reason: 'no model decision yet' };
  if (decision.error) return { action: reflexAction, source: 'reflex', reason: `model query failed: ${decision.error}` };
  if (decision.clearance === '') {
    return { action: reflexAction, source: 'reflex', reason: 'model named no usable maneuver' };
  }

  return {
    action: decision.maneuver,
    source: 'model',
    reason:
      `${decision.clearance} @ p=${decision.probability.toFixed(2)} conf=${decision.confidence.toFixed(2)}, ` +
      `urgent=${Number.isFinite(decision.urgent) ? decision.urgent.toFixed(2) : 'n/a'} -> ${decision.maneuver}`,
    clearance: decision.clearance,
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
   * Score the model's maneuver against the geometric reference.
   *
   * This is the only check the model's opinion ever gets, and it happens after the
   * fact rather than before: the answer has already been acted on by the time it is
   * scored. That is the deliberate cost of removing the gate, and this is what makes
   * it visible instead of silent.
   *
   * @param {'jump'|'bow'|'hold'} predicted
   * @param {'jump'|'bow'|'hold'|null} truth
   */
  scoreManeuver(predicted, truth) {
    if (truth === null) return;
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
      maneuverAccuracy: scored === 0 ? null : this.correct / scored,
      scored,
      topReasons: [...this.reasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4),
    };
  }
}
