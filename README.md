# decisaur

A bot for the Chrome T-Rex Runner (`chrome://dino`) whose obstacle perception is a
local [Ollama](https://ollama.com) **System One** decision model, `tev1:0.8b`,
reached over `POST /v1/systemone`.

The interesting part is not that it plays well. It is the finding underneath:
**on this game the model cannot improve the score, and the project is built so
that is measurable rather than asserted.**

---

## The short version

Three layers, each with a job it is actually good at:

| Layer | Question it answers | Latency | Measured accuracy |
|---|---|---|---|
| **Model** (`tev1:0.8b`) | *what kind of obstacle is this?* | 67-280ms | **80%** (32/40) |
| **Geometry** | *what can be done about it, and when?* | ~0 (per frame) | exact |
| **Policy** | *is the model's opinion allowed to act?* | ~0 | — |

Geometry is what actually drives the dino. The model is asked once per obstacle,
and its answer is checked against collision geometry before it is allowed to do
anything.

### Why the model cannot win

In this game the correct maneuver is fully determined by the game's own collision
boxes. There is no judgement call, no trade-off, no strategy to infer. So a perfect
classifier adds exactly nothing to the score, and a mediocre one can only hurt.

Rather than pretend otherwise, the project measures it. `npm run sim` runs the same
seeds three ways:

```
reflex only     5/6 survived    score 5888
--oracle        5/6 survived    score 5888     model 100% accurate
--adversarial   5/6 survived    score 5888     model ~20% accurate, always confident
```

Crash frames, scores and jump counts come out byte-identical across all three
(same md5 over the run summary). An always-wrong, maximally-confident model
changes nothing, because the policy layer refuses answers that disagree with
geometry. That is the safety property, and it is demonstrated rather than claimed.

The one place the model does move the needle is mild: it labels a bird that could
simply be run under as `bird_high`, so the dino ducks when it did not need to
(283 duck frames instead of 51 over 4000 frames). That is safe - ducking clears
those birds - and the score is unchanged, but it is the model adding motion rather
than accuracy. Worth knowing before reading too much into the agreement above.

The model still does something real: it is scored on every obstacle against the
geometric reference, in the HUD and in `npm run replay`, and its one systematic
error is visible rather than silent.

---

## Install

Requires Node 20+ and a local Ollama with the model pulled.

```sh
ollama pull tev1:0.8b
npm install
npm run build
```

## Use it in the browser

Chrome will not let `chrome://dino` reach a loopback address at all, so two separate
things are needed before the bot can query the model: a launch flag, and the proxy.
See [Limitations](#limitations) for the measurements behind this.

1. **Launch Chrome with the local-network check disabled.** There is no
   `chrome://flags` entry for this any more, so it has to go on the command line:

   ```sh
   google-chrome --disable-features=LocalNetworkAccessChecks
   ```

   To make it permanent, add the flag to the `Exec=` line in
   `~/.local/share/applications/google-chrome.desktop`.

2. **Start the proxy**, which fixes the separate Ollama-side refusal:

   ```sh
   npm run proxy                 # 127.0.0.1:11436 -> 127.0.0.1:11434
   ```

3. Open `chrome://dino`, press <kbd>F12</kbd>, open the **Console**.
4. Set the host, then paste and run the build you want - `dist/decisaur.user.js`
   for normal play, or one of the two A/B builds listed under
   [The three builds](#the-three-builds):

   ```js
   decisaurHost = 'http://127.0.0.1:11436';
   ```

5. **Click the game page** so it holds keyboard focus, then press <kbd>Space</kbd>.

Or install `dist/decisaur.user.js` as a Tampermonkey userscript - it already
carries the `@match chrome://dino` header.

A HUD appears in the bottom left showing the model's class next to the class
derived from collision geometry, whether they agree, the classification accuracy
so far, and the round-trip latency. Disagreements turn red the instant they happen.

### The three builds

`npm run build` writes three bundles. They differ only in which layer is in
charge, decided at compile time - there is no runtime switch to get wrong.

| File | Model | Reflex | For |
|---|---|---|---|
| `dist/decisaur.model-only.user.js` | sole pilot | off | seeing what the model does unaided |
| `dist/decisaur.reflex-only.user.js` | never queried | on | the A/B baseline |
| `dist/decisaur.user.js` | classifies | vetoes, owns timing | normal play |

Pick the file, paste it, done. The model-only build has no geometry veto and no
timing help, so the dino dies the moment an answer is late or wrong - that is the
experiment, and `npm run sim -- --no-reflex --model` measures the same thing
headlessly (it dies around frame 89).

Each bundle prints its own mode on attach, and `decisaur.mode` reports it.

### Console API

```js
decisaur.stop()    // detach
decisaur.stats()   // counters
decisaur.mode      // which build this is
```

## Use it headlessly

Everything runs without a browser, against a port of the game's physics in
`src/node/sim.js`.

```sh
npm run replay                       # score the model against collision geometry
npm run sim                          # reflex layer alone
npm run sim -- --oracle              # model stands in for geometry
npm run sim -- --adversarial         # model confidently wrong
npm run sim -- --model --fps 60      # real tev1:0.8b, paced like a real game
npm run sim -- --frames 20000 --runs 10 --seed 900
```

`--fps 60` matters. Without it the loop finishes in milliseconds and almost no
model query ever completes, which looks like success while measuring nothing.

```sh
node src/node/sweep-aim.js           # how JUMP_AIM was chosen
node src/node/probe-prompt.js        # why the prompt asks for a class, not a maneuver
node src/node/probe-latency.js       # latency vs question count
```

---

## How the model is prompted

The question set was measured, not guessed. Four encodings of the same decision
against `tev1:0.8b`:

| Encoding | Latency | Confidence | Discriminates |
|---|---|---|---|
| JSON state, `jump`/`duck`/`hold` choice | ~610ms | 0.08-0.18 | **no** - always jump |
| Sentence state, `jump`/`duck`/`hold` choice | ~300ms | 0.37-0.42 | jump vs duck, never hold |
| **Sentence state, obstacle-class choice** | **~260ms** | **0.28-0.99** | **yes** |
| Two binary `noul` questions | ~400ms | n/a | poorly (0.47 vs 0.69) |

So the model is asked what it is *looking at*, not what it should *do*:

```js
{
  kind: {
    type: 'choice',
    instructions: 'Look at the obstacle ahead of the running T-Rex and say what kind of obstacle it is.',
    criteria: {
      cactus:     'A cactus or other solid object standing on the ground.',
      bird_high:  'A bird flying high above the ground, with open space underneath it.',
      bird_low:   'A bird flying at the same height as the T-Rex.',
    },
  },
}
```

Two rules keep the measurement honest:

- **Prose, not JSON.** The same obstacle described as a JSON object gave a flat
  distribution with confidence 0.08; as a sentence it gave a clean argmax at 0.99.
- **No answer in the prompt.** The description reports only what is on screen -
  airborne or not, and the raw `yPos`. It never names the class and never hands
  over the collision extents that `classify.js` uses to derive the answer. If the
  prompt contained the answer, scoring the model against geometry would just be
  measuring an echo.

### What it actually gets wrong

80% over 40 samples, and the error is systematic rather than random:

| Scene | Model | Geometry | Outcome |
|---|---|---|---|
| cactus, small / large | `cactus` | `cactus` | jump |
| bird at y=100 | **`bird_high`** | `bird_low` | **caught by the gate** -> jump |
| bird at y=75 | `bird_high` | `bird_high` | duck |
| bird at y=50 | `bird_high` | `bird_high` | duck |

It reads a body-height bird as "high overhead" every single time. The gate catches
all 8 of 8, the dino jumps correctly, and the HUD counts the mistake.

---

## Why geometry, and not the model, owns timing

A jump has an arc. It is only survivable inside the clearance window that
geometry computes. An early version let the model pick the maneuver *and* trigger
it the instant its answer arrived - which made the dino leap when the round trip
completed rather than when the cactus arrived, and land on it. Both `--oracle` and
`--adversarial` died within a second, about 250 frames in.

So the policy may substitute one executable maneuver for another, but a jump is
only offered to the model once the reflex has armed the window. Ducking and
holding have no arc, so they stay available at any time.

There is a second hazard in the same family: **never press duck while airborne.**
`Runner.onKeyDown` intercepts ArrowDown during a jump and calls `setSpeedDrop()`,
so the press both slams the dino into the floor and gets swallowed - the duck never
happens at all. The controller suppresses it centrally so both front ends inherit
the guard.

---

## Game internals

Constants are transcribed in `src/core/constants.js` from the runner's `index.js`,
with provenance noted per block. The browser bot reads all of them back off the
live game every frame and only falls back to that file, so the jump arc tracks
whatever Chrome build is running. The headless simulator has no live game to read,
which is why they are there at all.

Details that are easy to get wrong, and were:

- `Trex.config` spells it **`INIITAL_JUMP_VELOCITY`** - a long-standing upstream
  typo. Reading only the correct spelling silently falls back and jumps wrong.
- `Runner.config` *also* has an `INITIAL_JUMP_VELOCITY`, positive `12`, on a
  different object. Reading the wrong one gets the sign wrong.
- On reaching `MAX_JUMP_HEIGHT` the game calls `endJump()`, which clamps velocity
  to `DROP_VELOCITY` (-5) - **still moving upward**. So the apex is *not* capped
  at `MAX_JUMP_HEIGHT`; the dino peaks around 91px above its standing top.
- The game applies `jumpVelocity` to `yPos` and only *then* adds gravity. Reversing
  that order shifts the arc by a frame.
- Ducking does not move `yPos`. The shorter silhouette comes entirely from the
  ducking collision box starting 18px lower.
- A pterodactyl sprite is 40px tall but its collision extent is only 19px, and the
  boxes sit far from the sprite's top-left. Classifying a bird by `yPos` alone is
  wrong, which is why classification is derived from the boxes.

### Which maneuver is actually possible

Standing dino occupies y 93-136; ducking, y 111-136.

| Obstacle | Extent | Duck | Run | Maneuver |
|---|---|---|---|---|
| `CACTUS_LARGE` | 90-140 | hit | hit | jump |
| `CACTUS_SMALL` | 105-139 | hit | hit | jump |
| bird at y=100 | 108-127 | hit | hit | jump |
| bird at y=75 | 83-102 | **free** | hit | duck |
| bird at y=50 | 58-77 | **free** | **free** | hold |

Ducking works for *two* of the three bird heights, and only one of those is "high"
by any naive `yPos` threshold. Hence three classes derived from boxes.

### Jump timing

`JUMP_AIM` is where in the clearance window the obstacle gets lined up. A jump
lasts ~34 frames and at top speed consecutive obstacles can be only 22-34 frames
apart, so the dino is sometimes still airborne when the next one arrives. The
value was swept, not guessed:

```
aim   0.40  0.46  0.50  0.54  0.58  0.60  0.70  0.90
ok    8/20  14/20 15/20 19/24 13/24  9/20   0/12  0/12
```

The curve is sharply peaked and aiming late is fatal: the obstacle then arrives
exactly as the dino descends back through the clearance height. `0.54` holds up on
held-out seeds.

---

## Layout

```
src/
  config.js              tunables: model, host, confidence gates, JUMP_AIM
  core/
    constants.js         game physics, transcribed, with provenance
    geometry.js          jump arc, clearance windows, collision extents
    state.js             defensive BotState extraction from Runner.instance_
    classify.js          class + feasible maneuvers, from collision geometry
    reflex.js            60Hz safety net
    policy.js            model answer -> action, gated
    controller.js        the pipeline; DOM-free
    vocabulary.js        class space and the model-facing description
  ollama/decider.js      System One client: dedup, one in flight, keep_alive
  browser/
    agent.js             rAF loop + keyboard
    keys.js              synthetic keydown/keyup carrying keyCode
    hud.js               live telemetry
    entry.js             window.decisaur console API
    modes.js             the three build modes, shared by build.mjs and the bundle
  node/
    sim.js               headless port of the game
    run-sim.js           simulator CLI (reflex / oracle / adversarial / model)
    replay.js            model accuracy harness
    sweep-aim.js         JUMP_AIM sweep
    probe-prompt.js      prompt-encoding comparison
    probe-latency.js     latency vs question count
scripts/build.mjs        esbuild -> dist/decisaur.user.js
```

`controller.js` is DOM-free on purpose: the browser agent and the headless
simulator drive the same object, so the simulator exercises the real decision path
rather than a reimplementation that can drift from it.

---

## Limitations

- **70% of seeds survive 30000 frames** (42/60 on seeds 3000-3059, mean score
  ~7800); the rest die almost entirely to one case: the dino is still airborne
  when the next obstacle needs a jump, and it lands after that obstacle's window
  has already opened. Crash breakdown across those 18 failures - 14 airborne into
  `CACTUS_LARGE`, 2 running into `CACTUS_LARGE`, 2 into a pterodactyl.
  This is a limit of a jump-only strategy, not something the model addresses. It
  was traced rather than papered over, and ArrowDown speed-drop does not fix it:
  from the apex it descends *slower* than gravity alone (3px/frame against ~5px/frame
  average), so cutting the jump short lands the dino later, not sooner.
- **Chrome's pterodactyl has two heights, not three.** Some mirrors use three.
  Classification reads `yPos` from the live game so both work, but the constants
  table lists three.
- The bot reads and writes `Runner` internals, which are not a public API. Current
  Chrome has modularised them: the singleton is behind `Runner.getInstance()` rather
  than a `Runner.instance_` property, and `Runner` itself is a lexical binding rather
  than a `window` property. `Agent.runner()` handles all three shapes, but a
  sufficiently large rename would need attention.
- **Reaching Ollama from `chrome://dino` requires disabling a security check.** The
  page has an opaque origin (`null`) and is not a secure context, so Chrome refuses
  `fetch` into the loopback address space. The refusal is local to the renderer:
  measured on Chrome 154, **no preflight and no request reach the network at all**,
  which is why it is reported as a CORS failure rather than a connection error. No
  response header can fix it, because nothing is sent - and `OLLAMA_ORIGINS` cannot
  either, since the browser never gets as far as reading it.

  Chrome enforces this with the `LocalNetworkAccessChecks` feature. Its
  `chrome://flags` entry has been removed, but the feature has not, so the launch
  flag still works:

  | Initiator | `isSecureContext` | Result |
  |---|---|---|
  | opaque origin `null`, stock Chrome | `false` | blocked, zero network traffic |
  | opaque origin `null`, `--disable-features=LocalNetworkAccessChecks` | `false` | `200`, model answers |
  | `http://localhost` page | `true` | `200`, model answers |

  The last row is the way out if you would rather not disable anything: a page served
  from `http://localhost` is a secure context and is not gated at all. Only this one
  column depends on the current Chrome behaviour - if the feature is renamed or the
  flag stops working, the flag-based setup breaks with it.
- **The proxy is still required, for the separate Ollama-side failure.** Once Chrome
  is allowed to make the request, Ollama refuses it anyway. Its browser-origin
  middleware answers *any* request carrying an `Origin` it does not allow with a bare
  `403` and no CORS headers, and `Origin: null` is never allowed - so a proxy that only
  answered the preflight still gets `403` on every model call. `scripts/cors-proxy.mjs`
  therefore drops `Origin` on the way to Ollama, which is what gets a `200` at all, and
  adds `Access-Control-Allow-Origin` plus `Access-Control-Allow-Private-Network` on
  the way back. Measured with `Origin: null`: direct to Ollama `403`, through the proxy
  `200` with the model answering at 0.996 confidence.
- **With Ollama down or unreachable, the bot still plays.** This is the design
  working, not a bug: the reflex layer is geometry-driven and synchronous, so it
  never waits on a model round trip. The HUD then shows `model query failed` as the
  reason and `model share 0%`, which is the honest report of a model that contributed
  nothing that run.
