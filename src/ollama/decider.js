/**
 * System One decision client.
 *
 * Wraps Ollama's `POST /v1/systemone` endpoint so the rest of the bot deals in
 * maneuvers instead of HTTP.
 *
 * The question set was chosen by measurement, not intuition. The obvious design -
 * one `choice` question over `jump`/`bow`/`hold` - does not work on `tev1:0.8b`,
 * and neither does asking for an obstacle class. What follows is what the probes
 * actually showed, including the two dead ends, because both explain the shape of
 * the thing that does work.
 *
 * **Dead end 1: one three-way maneuver choice.** A `choice` over jump/bow/hold
 * latches onto whichever option is described most forcefully and ignores the scene.
 * Across eleven framings the failure was always the same trade:
 *
 *   | framing                                        | accuracy | what breaks            |
 *   |------------------------------------------------|----------|------------------------|
 *   | sentence state + distance in words             | 5/6      | `bow` unreachable      |
 *   | distance as an explicit pixel count            | 4/6      | `bow` unreachable      |
 *   | explicit tactical rules in the criteria        | 3/6      | `hold` unreachable      |
 *   | bow framed as a posture change ("shrink down")| 1/5      | bows *everything*      |
 *   | gap-underneath + posture rationale             | 1/5      | bows *everything*      |
 *   | bow criterion says "do not jump when..."      | 4/5      | `bow` unreachable      |
 *
 * Giving `bow` a defensible rationale moved its probability to 0.75-0.89 but
 * collapsed `jump` to 0.09: the model bowed cacti. Keeping `jump` as the default
 * stranded `bow` at 0.14-0.37. Sharpening the rules (best confidence, 0.63) was
 * the *least* accurate variant. Confidence and accuracy moved in opposite
 * directions, so the confidence gate could not have separated the good framings.
 *
 * **Dead end 2: ask for an obstacle class and map it to a maneuver.** That is
 * sharp - confidence 0.28-0.99, 80% classification accuracy - but the class is not
 * the decision. A `bird_high` is bowed whether it is 20 frames out or 5, so the
 * class cannot express `hold` at all, and the mapping back to a maneuver is a lookup
 * table that the model was supposed to replace. Asking for the class is asking the
 * model a question the code can answer better.
 *
 * **What works: decompose the decision.** The failure above is a single decision
 * axis - "act or don't" - competing with a second one, "over or under". Splitting
 * them into two questions in one forward pass removes the competition:
 *
 *   - `clear`  : choice between `jump` and `bow` only. Which maneuver clears it.
 *   - `urgent` : `noul`. Does it need acting on yet.
 *   - maneuver : `hold` when `urgent` says no, otherwise whatever `clear` chose.
 *
 * Measured on the six probe scenes spanning all three maneuvers, this reached 5/5,
 * the only framing that ever got `bow` right without losing `hold`. It costs more than
 * a single question: re-measured 2026-10-08, `clear` alone is p50 58ms and `clear`+`urgent`
 * together are p50 170ms, so the second question roughly triples the round trip.
 *
 * The honest caveat, which `policy.js` records at the point of use: `clear` scores a
 * reported confidence of 0.000-0.054 on correct answers. The argmax is right and the
 * distribution is flat, so this model cannot tell you *how sure* it is about a
 * maneuver - only which one it picked. Any confidence gate over this signal rejects
 * nearly everything, so there is no gate; see `resolveManeuver()`.
 *
 * Two properties still matter for a real-time game:
 *
 *  1. **Dedup by obstacle.** There is one decision-relevant moment per obstacle,
 *     not one per frame, so queries scale with events rather than with 60Hz.
 *  2. **Never block the caller.** If a query is in flight the caller is told so
 *     at once and falls back to the reflex layer, which is what keeps the dino
 *     alive while the model thinks.
 */

import { Ollama } from 'ollama/browser';
import { HOST, MODEL, KEEP_ALIVE, LOOP } from '../config.js';


/**
 * Two questions in a single forward pass, decomposing "what should I do" into
 * "what clears it" and "does it need doing yet".
 *
 * The `clear` instructions carry the game's rules explicitly. That is not the same
 * as handing over the answer: the model still has to read the scene to know which
 * rule applies, and `vocabulary.js` still withholds the collision extents that
 * `classify.js` derives the reference from. But the rules have to be spelled out -
 * variant K of the probe, which had the same decomposition with a neutral `clear`
 * question, scored 3/5 and never picked `bow`, while this wording scored 5/5.
 *
 * The rules must also cover every scene shape `vocabulary.js` can send, because the
 * model answers only from the rule that names its sentence's own words. That is why the
 * bird rules are three and not two, and why each one quotes its description phrase word
 * for word - `A bird flying low in the air`, `at middle height`, `high in the air`. With
 * the first two rules alone, a body-height bird was covered by neither and the model
 * guessed `bow`: it slid underneath a bird it had to clear, which is the crash that
 * followed the perception fix once bird sentences first reached the model at all. Adding
 * a rule that quoted the description's own phrase flipped `bird_body@130` from `bow` 3/3
 * wrong to `jump` 3/3 right with no movement on any other scene (A/B over 8 scenes x 3
 * repeats). The phrases were relative until now - "above the runner", "at the same height
 * as the runner" - which had to be explained by the rule text and still left the yPos-75
 * bird reading as body-level; plain altitude words remove the need to explain, and leave
 * each rule matching one band and one band only. See `../core/vocabulary.js`.
 *
 * The high bird's rule names no maneuver on purpose. Its reference answer is `hold` - it
 * passes over a standing dino untouched - and `hold` is not in this question's label
 * space; it is asserted later, by `urgent`, because doing nothing is correct at every
 * distance. Bowing and jumping are both geometrically free at yPos 50 (extent 58-77
 * clears both a bow at 111 and a jump's 91px apex), so whichever of the two the model
 * spends on it is survivable, and the rule exists to stop it borrowing the middle-height
 * band's answer rather than to command one.
 *
 * `criteria` doubles as the label space, so both entries are written to describe the
 * situation each maneuver is for rather than to order the model.
 * 
 * "man", not "T-Rex", originally on the theory that this model carries a learned picture of
 * a dinosaur that does not duck. That has been measured and does not hold: varying the
 * noun in `describeState()` (`../core/vocabulary.js`) against these questions gives 13/15
 * either way, with `clear` naming `bow` zero times in both. The noun is kept consistent
 * with the scene description because a prompt that names the same runner two different ways
 * is a trap to edit, not because it scores better. `bow` being unreachable is a fault in
 * the question set - see `probe-decompose.js` and the rule sentence this one dropped.
 */
export const QUESTIONS = {
  clear: {
    type: 'choice',
    instructions:
      'A man running and cannot stop, say which maneuver clears the obstacle ahead. ' +
      'A cactus standing on the ground must be jumped. ' +
      'A bird flying low in the air must be jumped. ' +
      'A bird flying at middle height in the air must be bowed under. ' +
      'A bird flying high in the air must not be jumped.',
    criteria: {
      jump: 'Jump: go over the top of it.',
      bow: 'Bow: shrink down and go underneath it.',
    },
  },
  urgent: {
    type: 'noul',
    instructions: 'Is the obstacle close enough that the man must act right now rather than keep running for another moment?',
  },
};

/**
 * `urgent` threshold below which the model says "not yet".
 *
 * The probe scenes put this between 0.21 (far, correct) and 0.51 (close, correct),
 * so 0.5 is the midpoint of the range that actually discriminates. It is a measured
 * split point, not a tuned one: the underlying `noul` distributions overlap.
 */
export const URGENT_THRESHOLD = 0.5;

/** @type {readonly string[]} The maneuvers `clear` can name, before `urgent` is folded in. */
export const CLEARANCES = ['jump', 'bow'];

/** @param {unknown} value */
function isClearance(value) {
  return typeof value === 'string' && CLEARANCES.includes(value);
}

/**
 * @typedef {object} ManeuverDecision
 * @property {'jump'|'bow'|'hold'} maneuver  What the dino should do. Derived from
 *   `clearance` and `urgent`, never named by the model in one piece.
 * @property {'jump'|'bow'|''} clearance    What `clear` chose, `''` if not a choice.
 * @property {number} urgent                 `urgent` probability that action is needed now.
 * @property {boolean} isUrgent              Whether that cleared `URGENT_THRESHOLD`.
 * @property {number} probability            Probability on `clearance`.
 * @property {Record<string, number>} distribution  Full `clear` distribution.
 * @property {number} confidence             Reported concentration of `clear`. Measured
 *   at 0.000-0.054 on correct answers - present for the HUD, not for gating.
 * @property {number} latencyMs              Round trip time.
 * @property {{input_tokens: number, output_tokens: number}} usage
 * @property {string} [error]                Set when the query failed.
 */

/**
 * Combine the two answers into a single maneuver.
 *
 * `hold` is asserted whenever the obstacle is not urgent, and overrides whatever
 * `clear` said. That is the whole point of the decomposition: `hold` never competes
 * for probability mass against the two maneuvers that involve pressing a key.
 *
 * @param {'jump'|'bow'|''} clearance
 * @param {number} urgent
 * @returns {'jump'|'bow'|'hold'}
 */
export function deriveManeuver(clearance, urgent) {
  if (!Number.isFinite(urgent) || urgent < URGENT_THRESHOLD) return 'hold';
  return clearance === 'jump' || clearance === 'bow' ? clearance : 'hold';
}

/**
 * Normalise an Ollama System One response into a `ManeuverDecision`.
 *
 * Anything unexpected collapses to safe defaults rather than throwing: this runs
 * inside the game loop, and an exception here would take the bot down. The default
 * is `hold`, which is the only answer that is always survivable.
 *
 * @param {import('ollama/browser').SystemOneResponse} response
 * @param {number} latencyMs
 * @returns {ManeuverDecision}
 */
export function normaliseDecision(response, latencyMs) {
  const clear = response?.answers?.clear;
  const urgentAnswer = response?.answers?.urgent;

  const clearance = clear?.type === 'choice' && isClearance(clear.choice) ? clear.choice : '';
  const distribution = clear?.type === 'choice' && clear.probabilities ? clear.probabilities : {};
  const urgent = urgentAnswer?.type === 'noul' && Number.isFinite(urgentAnswer.noul) ? urgentAnswer.noul : NaN;
  const confidence = clear?.type === 'choice' && typeof clear.confidence === 'number' ? clear.confidence : 0;

  return {
    maneuver: deriveManeuver(clearance, urgent),
    clearance,
    urgent,
    isUrgent: Number.isFinite(urgent) && urgent >= URGENT_THRESHOLD,
    probability: distribution[clearance] ?? 0,
    distribution,
    confidence,
    latencyMs,
    usage: {
      input_tokens: response?.usage?.input_tokens ?? 0,
      output_tokens: response?.usage?.output_tokens ?? 0,
    },
  };
}

export class Decider {
  /**
   * @param {object} [options]
   * @param {string} [options.model]
   * @param {string} [options.host]
   * @param {number} [options.maxConcurrent]
   * @param {(decision: ManeuverDecision, context: {token: string}) => void} [options.onDecision]
   */
  constructor(options = {}) {
    this.model = options.model ?? MODEL;
    this.maxConcurrent = options.maxConcurrent ?? LOOP.maxConcurrent;
    this.onDecision = options.onDecision ?? null;
    this.client = new Ollama({ host: options.host ?? HOST });

    /** @type {Map<string, ManeuverDecision>} */
    this.decisions = new Map();
    /** @type {Set<string>} */
    this.queried = new Set();
    this.inFlight = 0;
    this.stats = { queries: 0, failures: 0, totalLatencyMs: 0, tokens: 0 };
  }

  /** @returns {ManeuverDecision | undefined} */
  get(token) {
    return this.decisions.get(token);
  }

  /**
   * Ask the model which maneuver clears `token`'s obstacle. Never throws.
   *
   * Dedup is per `(token, band)` rather than per token, because a maneuver is a
   * function of distance and the correct answer changes as an obstacle closes. Asking
   * once - which was right when the model named an obstacle *class*, a distance-
   * invariant property - returned `hold` at 460px and cached it for good, so the dino
   * ran into the cactus it was told to wait for. Two bands per obstacle is what the
   * timing allows: at the top speed of 13px/frame the ~170ms round trip is ~130px of
   * travel, so a query fired on entering `near` still lands inside the clearance
   * window, which `JUMP_AIM` sits past the middle of for exactly this reason.
   *
   * @param {string} token Stable identifier for the obstacle.
   * @param {string} state Plain-English scene description.
   * @param {'far'|'near'} band Which approach phase this query answers.
   * @returns {Promise<ManeuverDecision | null>}
   */
  async request(token, state, band = 'near') {
    const key = `${token}:${band}`;
    if (this.queried.has(key)) return this.decisions.get(token) ?? null;
    if (this.inFlight >= this.maxConcurrent) return null;

    this.queried.add(key);
    this.inFlight += 1;
    const startedAt = Date.now();

    try {
      const response = await this.client.systemone({
        model: this.model,
        state,
        questions: QUESTIONS,
        keep_alive: KEEP_ALIVE,
      });
      const decision = normaliseDecision(response, Date.now() - startedAt);
      this.decisions.set(token, decision);
      this.stats.queries += 1;
      this.stats.totalLatencyMs += decision.latencyMs;
      this.stats.tokens += decision.usage.input_tokens;
      this.onDecision?.(decision, { token });
      return decision;
    } catch (error) {
      this.stats.failures += 1;
      const decision = {
        maneuver: 'hold',
        clearance: '',
        urgent: NaN,
        isUrgent: false,
        probability: 0,
        distribution: {},
        confidence: 0,
        latencyMs: Date.now() - startedAt,
        usage: { input_tokens: 0, output_tokens: 0 },
        error: error instanceof Error ? error.message : String(error),
      };
      // A failed re-query must not overwrite a good earlier answer. The far-band
      // reply may already say `jump`, and losing it to a timeout would strand the
      // dino in front of the cactus it was told to clear.
      if (!this.decisions.has(token)) this.decisions.set(token, decision);
      return decision;
    } finally {
      this.inFlight -= 1;
    }
  }

  get averageLatencyMs() {
    return this.stats.queries === 0 ? 0 : this.stats.totalLatencyMs / this.stats.queries;
  }

  /** @param {Set<string>} liveTokens */
  prune(liveTokens) {
    for (const token of this.decisions.keys()) {
      if (!liveTokens.has(token)) this.decisions.delete(token);
    }
    for (const key of this.queried) {
      const token = key.slice(0, key.lastIndexOf(':'));
      if (!liveTokens.has(token)) this.queried.delete(key);
    }
  }

  reset() {
    this.decisions.clear();
    this.queried.clear();
    this.inFlight = 0;
    this.stats = { queries: 0, failures: 0, totalLatencyMs: 0, tokens: 0 };
  }
}

