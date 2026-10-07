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

const DIM = 'color:#8b949e;';
const GOOD = 'color:#7ee787;';
const BAD = 'color:#ff6b6b;';
const WARN = 'color:#ffd479;';

export class Hud {
  /** @param {string} title */
  constructor(title) {
    this.title = title;
    this.el = document.createElement('div');
    this.el.setAttribute('data-decisaur', 'hud');
    this.el.setAttribute('style', BASE);
    document.body.appendChild(this.el);
  }

  /** @param {object} view */
  render(view) {
    const lines = [`<b>${this.title}</b>  ${DIM}${view.mode}${''}`];

    const { state, plan } = view;
    if (state === null || !state.playing || state.crashed) {
      // Kept as separate branches on purpose: "no game found" and "game not
      // started" need opposite responses, and merging them misleads the reader.
      if (state === null) {
        lines.push(`${BAD}no Runner.instance_ found${''}`);
        lines.push(`${DIM}the game was not located; nothing to press${''}`);
      } else if (state.crashed) {
        lines.push(`${BAD}crashed${''}`);
        lines.push(`${DIM}press space to restart${''}`);
      } else {
        lines.push(`${DIM}press space to start the game${''}`);
      }
      this.el.innerHTML = lines.join('\n');
      return;
    }

    lines.push(`${DIM}${view.mode}  ${state.speed.toFixed(1)}px/f  d${Math.round(state.distance)}${''}`);
    lines.push(`${DIM}${'─'.repeat(28)}${''}`);

    const analysis = plan?.analysis ?? null;
    if (plan?.target && analysis) {
      lines.push(`obstacle  ${analysis.geometric ?? 'unknown'}  w${plan.target.width} y${plan.target.y}`);
      lines.push(`  gap    ${plan.centreDistance.toFixed(0)}px   ttc ${plan.timeToContactMs.toFixed(0)}ms`);

      let verdict = `${DIM}model  -${''}`;
      if (view.modelManeuver !== null) {
        const agree = view.modelManeuver === analysis.preferred;
        verdict = agree
          ? `model  ${view.modelManeuver}  ${GOOD}ok${''}`
          : `model  ${view.modelManeuver}  ${BAD}!=${analysis.preferred}${''}`;
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
      lines.push(`${DIM}clear${''}`);
    }

    lines.push(`${DIM}${'─'.repeat(28)}${''}`);
    lines.push(view.reason);
    lines.push(`${view.source === 'model' ? GOOD : WARN}${view.source}${''}`);

    lines.push(`${DIM}${'─'.repeat(28)}${''}`);
    const s = view.stats;
    const share = s.total === 0 ? '-' : `${Math.round((s.model / s.total) * 100)}%`;
    lines.push(`model ${s.model}  ${view.reflexLabel ?? 'reflex'} ${s.reflex}  ${DIM}model share ${share}${''}`);

    if (s.maneuverAccuracy === null) {
      lines.push(`${DIM}maneuver accuracy n/a${''}`);
    } else if (s.maneuverAccuracy === 1) {
      lines.push(`maneuver accuracy ${GOOD}${(s.maneuverAccuracy * 100).toFixed(1)}%${''} ${DIM}(${s.scored})${''}`);
    } else {
      lines.push(
        `maneuver accuracy ${BAD}${(s.maneuverAccuracy * 100).toFixed(1)}%${''} ${DIM}(${s.scored}, ${s.wrong} wrong)${''}`,
      );
    }

    if (view.decider && view.decider.stats.queries > 0) {
      const d = view.decider;
      lines.push(`${DIM}lat ${d.averageLatencyMs.toFixed(0)}ms avg  q${d.stats.queries}  err${d.stats.failures}${''}`);
    }

    this.el.innerHTML = lines.join('\n');
  }

  destroy() {
    this.el.remove();
  }
}
