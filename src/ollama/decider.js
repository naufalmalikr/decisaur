/**
 * System One decision client.
 *
 * Wraps Ollama's `POST /v1/systemone` endpoint so the rest of the bot deals in
 * obstacle classes instead of HTTP.
 *
 * The question set was chosen by measurement, not intuition. Probing
 * `tev1:0.8b` with three encodings of the same decision:
 *
 *   | encoding                                | latency | confidence | discriminates |
 *   |-----------------------------------------|---------|------------|----------------|
 *   | JSON state, "jump/duck/hold" choice     | ~610ms  | 0.08-0.18  | no (always jump) |
 *   | sentence state, "jump/duck/hold" choice | ~300ms  | 0.37-0.42  | jump vs duck, never hold |
 *   | sentence state, class choice            | ~260ms  | 0.28-0.99  | yes |
 *   | two binary `noul` questions             | ~400ms  | n/a        | poorly (0.47 vs 0.69) |
 *
 * Asking what kind of obstacle is in front of the T-Rex is both the cheapest and
 * by far the sharpest question. The model turns out to be a good perceiver and a
 * poor tactician, so it classifies and the geometry layer picks the maneuver.
 *
 * Two properties matter for a real-time game:
 *
 *  1. **Dedup by obstacle.** There is one decision-relevant moment per obstacle,
 *     not one per frame, so queries scale with events rather than with 60Hz.
 *  2. **Never block the caller.** If a query is in flight the caller is told so
 *     at once and falls back to the reflex layer, which is what keeps the dino
 *     alive while the model thinks.
 */

import { Ollama } from 'ollama/browser';
import { DEFAULT_HOST, DEFAULT_MODEL, KEEP_ALIVE, LOOP } from '../config.js';


/**
 * One `choice` question in a single forward pass.
 *
 * `criteria` doubles as the label space, so the entries are written as visual
 * descriptions rather than as instructions.
 */
export const QUESTIONS = {
  kind: {
    type: 'choice',
    instructions: 'Look at the obstacle ahead of the running T-Rex and say what kind of obstacle it is.',
    criteria: {
      cactus: 'A cactus or other solid object standing on the ground.',
      bird_high: 'A bird flying high above the ground, with open space underneath it.',
      bird_low: 'A bird flying at the same height as the T-Rex.',
    },
  },
};

/**
 * @typedef {object} ClassDecision
 * @property {string} kind             Class key the model chose.
 * @property {number} probability      Probability on that class.
 * @property {Record<string, number>} distribution  Full class distribution.
 * @property {number} confidence       Probability concentration.
 * @property {number} latencyMs        Round trip time.
 * @property {{input_tokens: number, output_tokens: number}} usage
 * @property {string} [error]          Set when the query failed.
 */

/**
 * Normalise an Ollama System One response into a `ClassDecision`.
 *
 * Anything unexpected collapses to safe defaults rather than throwing: this runs
 * inside the game loop, and an exception here would take the bot down.
 *
 * @param {import('ollama/browser').SystemOneResponse} response
 * @param {number} latencyMs
 * @returns {ClassDecision}
 */
export function normaliseDecision(response, latencyMs) {
  const answer = response?.answers?.kind;
  const distribution = answer?.type === 'choice' && answer.probabilities ? answer.probabilities : {};
  const kind = answer?.type === 'choice' && typeof answer.choice === 'string' ? answer.choice : '';
  const confidence = answer?.type === 'choice' && typeof answer.confidence === 'number' ? answer.confidence : 0;

  return {
    kind,
    probability: distribution[kind] ?? 0,
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
   * @param {(decision: ClassDecision, context: {token: string}) => void} [options.onDecision]
   */
  constructor(options = {}) {
    this.model = options.model ?? DEFAULT_MODEL;
    this.maxConcurrent = options.maxConcurrent ?? LOOP.maxConcurrent;
    this.onDecision = options.onDecision ?? null;
    this.client = new Ollama({ host: options.host ?? DEFAULT_HOST });

    /** @type {Map<string, ClassDecision>} */
    this.decisions = new Map();
    /** @type {Set<string>} */
    this.queried = new Set();
    this.inFlight = 0;
    this.stats = { queries: 0, failures: 0, totalLatencyMs: 0, tokens: 0 };
  }

  /** @returns {ClassDecision | undefined} */
  get(token) {
    return this.decisions.get(token);
  }

  /**
   * Ask the model to classify `token`'s obstacle. Never throws.
   *
   * @param {string} token Stable identifier for the obstacle.
   * @param {string} state Plain-English scene description.
   * @returns {Promise<ClassDecision | null>}
   */
  async request(token, state) {
    if (this.queried.has(token)) return this.decisions.get(token) ?? null;
    if (this.inFlight >= this.maxConcurrent) return null;

    this.queried.add(token);
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
        kind: '',
        probability: 0,
        distribution: {},
        confidence: 0,
        latencyMs: Date.now() - startedAt,
        usage: { input_tokens: 0, output_tokens: 0 },
        error: error instanceof Error ? error.message : String(error),
      };
      this.decisions.set(token, decision);
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
    for (const token of this.queried) {
      if (!liveTokens.has(token)) this.queried.delete(token);
    }
  }

  reset() {
    this.decisions.clear();
    this.queried.clear();
    this.inFlight = 0;
    this.stats = { queries: 0, failures: 0, totalLatencyMs: 0, tokens: 0 };
  }
}

