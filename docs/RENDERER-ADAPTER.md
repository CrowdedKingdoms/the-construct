# The renderer adapter boundary

Two renderers ship in this repo — three.js (the holodeck) and pixi.js (Paint) —
and neither knows the other exists. What they share is `GameScene`
(`src/engine/GameScene.ts`), a deliberately small contract, and `GameSession`
(`src/platform/GameSession.ts`), the platform facade.

## The contract

```ts
interface GameScene {
  readonly id: string;        // router key, saved with the player's position
  readonly programId: number; // the byte broadcast in the pose (0 = hub)

  mount(context: SceneContext, size: SceneSize): Promise<void> | void;
  update(dt: number, nowMs: number): void; // simulate + render one frame
  resize(size: SceneSize): void;
  unmount(): void;

  localPose(): Pose; // the local player's position/look/velocity in world units
  setLocalPosition(p: { x: number; y: number; z: number; yaw?: number }): void;
}
```

`SceneContext` gives a scene four things: the DOM element to render into, the
`GameSession`, the shared `Input`, the `SceneRouter`, and a `SceneHud` for
hints and toasts. That is the entire surface a scene may touch.

## What the engine does for you

Every frame `GameLoop`:

1. calls `scene.update(dt, now)`;
2. reads `scene.localPose()`, stamps `program`, `name`, `tint` and flags, and
   hands it to the replication store (5 Hz, send-on-change);
3. tells the store when the player crossed a chunk boundary;
4. patches the save blob's position every couple of seconds.

A scene therefore never sends anything. It only reports where the player is
and renders `session.players(programId)` — remote players in the same program,
with sample history for interpolation (`src/scenes/shared/interpolate.ts`).

## Replacing a scene

1. Create `src/scenes/<your-scene>/YourScene.ts` implementing `GameScene`.
2. Register it in `src/main.ts`: `router.register('your-id', () => new YourScene())`.
3. Add a pad in `src/platform/programs.ts` (and the matching row in
   `model/blueprints.mjs`'s `PROGRAM_CATALOG`) if players should load it from the
   holodeck. Or make it the first scene: change the `router.load(...)` call.

World units are shared across scenes: 16 units per chunk on each axis, floor
at `y = 0` (chunk layer 0). Paint maps world `x`/`z` to screen and keeps `y`
at 0.5; the holodeck uses all three. Pick any mapping, but keep positions in
the same world so presence stays meaningful across programs.

## Replacing the renderer entirely

Nothing outside `src/scenes/` imports three.js or pixi.js. To move to another
engine (Babylon, Phaser, a 2D canvas, WebGPU):

- implement `GameScene` for each of your scenes;
- keep `localPose()` in world units;
- render from `session.players(programId)` and `displayPose()`;
- if the engine needs a CSP relaxation, prefer its CSP-safe mode (pixi's
  `pixi.js/unsafe-eval` import is the example here) over widening the policy —
  the CSP is what keeps player mods contained.

Then delete the two demo scene folders and their dependencies from
`package.json`.

## Input and overlays

`Input` (`src/engine/Input.ts`) tracks keys and pointer state and has one
switch overlays flip: `suppress()`. While the chat box has focus or Crowdy
Studio's modal is open, gameplay keys are ignored but `onKey` shortcuts still
fire (except while typing). Scenes read `input.axes()` / `input.isDown()` and
never attach their own keyboard listeners; pointer listeners on the scene's
canvas are fine (Paint does this).

## Layout

While Crowdy Studio is docked it sets `--ck-game-right-inset` on `<body>`;
the stylesheet shrinks `#game-root` by that amount and the loop observes the
resize, so scenes just honour `resize(size)`.
