/**
 * On-screen telemetry.
 *
 * The HUD exists for falsifiability. It shows the model's own class next to the
 * class derived from the game's collision boxes, so a disagreement is visible the
 * moment it happens, and it shows how often the policy layer overrode the model
 * and why. A bot that only reports a score tells you nothing about whether the
 * model earned its place.
 */

const BASE =
  'position:fixed;bottom:12px;left:12px;z-index:2147483647;' +
  "font:11px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;" +
  'color:#e8e8e8;background:rgba(12,12,14,0.9);border:1px solid #333;border-radius:6px;' +
  'padding:10px 12px;min-width:250px;white-space:pre;pointer-events:none;';

// These are span openers, not bare declarations: the HUD renders through innerHTML,
// so a bare `color:#7ee787;` would print as literal text instead of colouring
// anything. Every one of these is closed with `</span>` on the same line.
const DIM = '<span style="color:#8b949e">';
const GOOD = '<span style="color:#7ee787">';
const BAD = '<span style="color:#ff6b6b">';
const WARN = '<span style="color:#ffd479">';

/** Text from the model or an error must not be able to close our own markup. */
const esc = (s) =>
  String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);

export class Hud {
  /** @param {string} title */
  constructor(title) {
    this.title = title;
    /**
     * The last frame the game was actually being played on, kept verbatim.
     *
     * A crash is the frame worth reading: the obstacle, the model's answer, and the
     * reason for the action are all still true, but they are gone by the next tick,
     * because a crashed game produces no plan to report. So the HUD freezes the last
     * live body under the crash banner instead of dropping the run's evidence.
     *
     * @type {string | null}
     */
    this.lastLiveBody = null;
    this.el = document.createElement('div');
    this.el.setAttribute('data-decisaur', 'hud');
    this.el.setAttribute('style', BASE);
    document.body.appendChild(this.el);
  }

  /** @param {object} view */
  render(view) {
    const head = `<b>${this.title}</b>  ${DIM}${view.mode}</span>`;
    const { state } = view;
    const live = state !== null && state.playing && !state.crashed;

    if (live) {
      this.lastLiveBody = this.body(view);
      this.el.innerHTML = `${head}\n${this.lastLiveBody}`;
      return;
    }

    const lines = [head];
    // Kept as separate branches on purpose: "no game found", "game not started", and
    // "crashed" need different responses, and merging them misleads the reader.
    if (state === null) {
      lines.push(`${BAD}no Runner.instance_ found</span>`);
      lines.push(`${DIM}the game was not located; nothing to press</span>`);
    } else if (state.crashed) {
      lines.push(`${BAD}crashed</span>`);
      lines.push(`${DIM}press space to restart</span>`);
      if (this.lastLiveBody !== null) {
        lines.push(`${DIM}last frame before impact</span>`);
        lines.push(`${DIM}${'─'.repeat(28)}</span>`);
        lines.push(this.lastLiveBody);
      }
    } else {
      lines.push(`${DIM}press space to start the game</span>`);
    }
    this.el.innerHTML = lines.join('\n');
  }

  /**
   * Telemetry for one live frame. Split out of {@link render} so the crash branch can
   * replay the previous frame's exact text.
   *
   * @param {object} view
   * @returns {string}
   */
  body(view) {
    const lines = [];
    const { state, plan } = view;

    lines.push(`${state.speed.toFixed(1)}px/f  d${Math.round(state.distance)}</span>`);
    lines.push(`${DIM}${'─'.repeat(28)}</span>`);

    const analysis = plan?.analysis ?? null;
    if (plan?.target && analysis) {
      lines.push(`obstacle  ${analysis.geometric ?? 'unknown'}  w${plan.target.width} y${plan.target.y}`);
      lines.push(`  gap    ${plan.centreDistance.toFixed(0)}px   ttc ${plan.timeToContactMs.toFixed(0)}ms`);

      let verdict = `${DIM}model  -</span>`;
      if (view.modelManeuver !== null) {
        const agree = view.modelManeuver === analysis.preferred;
        verdict = agree
          ? `model ${view.modelManeuver} ${GOOD}ok</span>`
          : `model ${view.modelManeuver} ${BAD}!= ${analysis.preferred}</span>`;
      }
      lines.push(verdict);
      lines.push(
        `  clear ${view.modelClearance ?? '-'}  ` +
          `urgent ${Number.isFinite(view.modelUrgent) ? view.modelUrgent.toFixed(2) : '-'}`,
      );
      lines.push(`  conf  ${view.modelConfidence.toFixed(3)}  p ${view.modelProbability.toFixed(2)}`);

      lines.push(`  need +${analysis.requiredRise.toFixed(0)}px rise, apex +${analysis.apex.toFixed(0)}px`);
      lines.push(`  feasible  ${[...analysis.feasible].join('/')}  prefer ${analysis.preferred}`);
    } else {
      lines.push(`${DIM}clear</span>`);
    }

    lines.push(`${DIM}${'─'.repeat(28)}</span>`);
    lines.push(esc(view.reason));
    lines.push(`${view.source === 'model' ? GOOD : WARN}${view.source}</span>`);

    lines.push(`${DIM}${'─'.repeat(28)}</span>`);
    const s = view.stats;
    const share = s.total === 0 ? '-' : `${Math.round((s.model / s.total) * 100)}%`;
    lines.push(`model ${s.model}  ${view.reflexLabel ?? 'reflex'} ${s.reflex}  ${DIM}model share ${share}</span>`);

    if (s.maneuverAccuracy === null) {
      lines.push(`${DIM}maneuver accuracy n/a</span>`);
    } else if (s.maneuverAccuracy === 1) {
      lines.push(`maneuver accuracy ${GOOD}${(s.maneuverAccuracy * 100).toFixed(1)}%</span> ${DIM}(${s.scored})</span>`);
    } else {
      lines.push(
        `maneuver accuracy ${BAD}${(s.maneuverAccuracy * 100).toFixed(1)}%</span> ${DIM}(${s.scored}, ${s.wrong} wrong)</span>`,
      );
    }

    if (view.decider && view.decider.stats.queries > 0) {
      const d = view.decider;
      lines.push(`${DIM}lat ${d.averageLatencyMs.toFixed(0)}ms avg  q${d.stats.queries}  err${d.stats.failures}</span>`);
    }

    return lines.join('\n');
  }

  destroy() {
    this.el.remove();
  }
}
