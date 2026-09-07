/**
 * "Paint": a shared top-down canvas rendered with pixi.js.
 *
 * It exists to prove the adapter boundary — a second renderer driven by the
 * same session — and to show the platform's chunk/voxel store doing real work:
 * each cell is a voxel in chunk layer y=0, `setVoxel` applies optimistically
 * and replicates, remote edits merge into the cache and repaint, and the
 * result is persisted, so a canvas painted today is there tomorrow for
 * everyone. Players in the program see each other as tinted discs; players in
 * the holodeck are not drawn here (different `program` byte).
 */
// The page's Content-Security-Policy has no 'unsafe-eval' (it runs untrusted
// player mods, so it must not). pixi.js's default shader generator uses
// `new Function`; this side-effect import swaps in the CSP-safe path.
import 'pixi.js/unsafe-eval';
import { Application, Container, Graphics, Text, TextStyle } from 'pixi.js';

import type { GameScene, SceneContext, SceneSize } from '@/engine/GameScene';
import { CHUNK_SIZE } from '@/platform/config';
import { HOLODECK_SCENE_ID, programBySceneId } from '@/platform/programs';
import { NEUTRAL_POSE, type Pose } from '@/platform/realtime/actorCodec';
import { chunkKey, worldToChunk, worldToVoxel, type ChunkCoord } from '@/platform/realtime/space';
import { displayPose, TINT_COLORS, tintColor } from '@/scenes/shared/interpolate';

const CELL_PX = 28;
const MOVE_SPEED = 9;
const DRAW_RADIUS_CHUNKS = 2;
const PALETTE = TINT_COLORS;
/** One zero byte, base64: the smallest non-empty voxel state the API accepts. */
const PAINT_STATE = 'AA==';

interface PlayerSprite {
  container: Container;
  disc: Graphics;
  label: Text;
  tint: number;
  name: string;
}

export class PaintScene implements GameScene {
  readonly id = 'paint';
  readonly programId = programBySceneId('paint')?.programId ?? 1;

  private context: SceneContext | null = null;
  private app: Application | null = null;
  private readonly world = new Container();
  private readonly chunkLayer = new Container();
  private readonly gridLayer = new Graphics();
  private readonly playersLayer = new Container();
  private readonly chunkGraphics = new Map<string, { graphics: Graphics; revision: number }>();
  private readonly players = new Map<string, PlayerSprite>();
  private local: PlayerSprite | null = null;
  private disposables: Array<() => void> = [];

  private position = { x: 8, z: 8 };
  private velocity = { x: 0, z: 0 };
  private paletteIndex = 1;
  private lastPaintedKey: string | null = null;
  private size: SceneSize = { width: 1, height: 1, rightInset: 0 };
  private hintDirty = true;

  async mount(context: SceneContext, size: SceneSize): Promise<void> {
    this.context = context;
    this.size = size;
    const app = new Application();
    await app.init({
      width: size.width,
      height: size.height,
      background: 0x0b0e14,
      antialias: true,
      resolution: Math.min(window.devicePixelRatio, 2),
      autoDensity: true,
    });
    app.canvas.className = 'scene-canvas';
    context.root.appendChild(app.canvas);
    // We drive rendering from the shared GameLoop, not pixi's ticker.
    app.ticker.stop();
    this.app = app;

    this.world.addChild(this.chunkLayer, this.gridLayer, this.playersLayer);
    app.stage.addChild(this.world);
    this.local = this.makePlayerSprite(context.session.displayName, context.session.tint);
    this.playersLayer.addChild(this.local.container);

    const onPointer = (event: PointerEvent) => {
      if (context.input.suppressed) return;
      if (!(event.buttons & 3)) return;
      const erase = (event.buttons & 2) !== 0;
      this.paintAt(event.clientX, event.clientY, erase);
    };
    const onContextMenu = (event: Event) => event.preventDefault();
    app.canvas.addEventListener('pointerdown', onPointer);
    app.canvas.addEventListener('pointermove', onPointer);
    app.canvas.addEventListener('pointerup', () => (this.lastPaintedKey = null));
    app.canvas.addEventListener('contextmenu', onContextMenu);
    this.disposables.push(() => {
      app.canvas.removeEventListener('pointerdown', onPointer);
      app.canvas.removeEventListener('pointermove', onPointer);
      app.canvas.removeEventListener('contextmenu', onContextMenu);
    });
    for (let i = 0; i < PALETTE.length; i++) {
      this.disposables.push(
        context.input.onKey(`Digit${i + 1}`, () => {
          this.paletteIndex = i + 1;
          this.hintDirty = true;
        }),
      );
    }
    this.disposables.push(
      context.input.onKey('Digit0', () => ((this.paletteIndex = 0), (this.hintDirty = true))),
    );
    this.disposables.push(
      context.input.onKey('KeyH', () => {
        if (context.input.suppressed) return;
        context.hud.toast('Returning to the holodeck…');
        void context.router.load(HOLODECK_SCENE_ID, this.holodeckReturnPoint());
      }),
    );
    this.resize(size);
  }

  unmount(): void {
    // Persist any paint still queued before the scene goes away.
    void this.context?.session.world.chunks.flush().catch(() => undefined);
    for (const dispose of this.disposables) dispose();
    this.disposables = [];
    for (const entry of this.chunkGraphics.values()) entry.graphics.destroy();
    this.chunkGraphics.clear();
    for (const sprite of this.players.values()) sprite.container.destroy({ children: true });
    this.players.clear();
    this.local?.container.destroy({ children: true });
    this.local = null;
    this.chunkLayer.removeChildren();
    this.playersLayer.removeChildren();
    this.gridLayer.clear();
    if (this.app) {
      this.app.stage.removeChildren();
      this.app.canvas.remove();
      this.app.destroy(false, { children: false });
      this.app = null;
    }
    this.context?.hud.setHint(null);
    this.context = null;
  }

  resize(size: SceneSize): void {
    this.size = size;
    this.app?.renderer.resize(size.width, size.height);
  }

  setLocalPosition(position: { x: number; y: number; z: number }): void {
    this.position = { x: position.x, z: position.z };
    this.velocity = { x: 0, z: 0 };
  }

  localPose(): Pose {
    return {
      ...NEUTRAL_POSE,
      x: this.position.x,
      y: 0.5,
      z: this.position.z,
      vx: this.velocity.x,
      vz: this.velocity.z,
    };
  }

  update(dt: number, nowMs: number): void {
    const context = this.context;
    const app = this.app;
    if (!context || !app) return;

    const axes = context.input.suppressed ? { x: 0, y: 0 } : context.input.axes();
    const wish = { x: axes.x * MOVE_SPEED, z: -axes.y * MOVE_SPEED };
    const k = Math.min(1, dt * 14);
    this.velocity.x += (wish.x - this.velocity.x) * k;
    this.velocity.z += (wish.z - this.velocity.z) * k;
    this.position.x += this.velocity.x * dt;
    this.position.z += this.velocity.z * dt;

    // Camera: keep the player centred in the visible (non-inset) area.
    this.world.position.set(
      this.size.width / 2 - this.position.x * CELL_PX,
      this.size.height / 2 - this.position.z * CELL_PX,
    );

    this.syncChunks();
    this.syncPlayers(nowMs);
    if (this.local) {
      this.local.container.position.set(this.position.x * CELL_PX, this.position.z * CELL_PX);
    }
    if (this.hintDirty) {
      this.hintDirty = false;
      const colour = this.paletteIndex === 0 ? 'eraser' : `colour ${this.paletteIndex}`;
      context.hud.setHint(
        `Paint — click/drag to paint (${colour}) · 1-8 colours, 0 eraser · WASD move · H back to holodeck`,
      );
    }
    app.renderer.render(app.stage);
  }

  // ---------------------------------------------------------------------------

  private paintAt(clientX: number, clientY: number, erase: boolean): void {
    const context = this.context;
    const app = this.app;
    if (!context || !app) return;
    const rect = app.canvas.getBoundingClientRect();
    const worldX = (clientX - rect.left - this.world.position.x) / CELL_PX;
    const worldZ = (clientY - rect.top - this.world.position.y) / CELL_PX;
    const cell = { x: Math.floor(worldX), y: 0, z: Math.floor(worldZ) };
    const key = `${cell.x},${cell.z}`;
    if (key === this.lastPaintedKey) return;
    this.lastPaintedKey = key;
    const chunk = worldToChunk(cell);
    const voxel = worldToVoxel(cell);
    const voxelType = erase ? 0 : this.paletteIndex;
    // The API refuses an empty voxelState ("voxelState should not be empty",
    // 2026-09-07) and the store sends '' when `state` is omitted, so every
    // paint carries one byte of state. A richer game would encode metadata here.
    const chunks = context.session.world.chunks;
    void chunks
      .setVoxel({ chunk, x: voxel.x, y: 0, z: voxel.z, voxelType, state: PAINT_STATE })
      .then(() => {
        // Two paths, two jobs: the realtime voxel update above is what other
        // players see NOW; it is not the durable terrain (a chunk nobody has
        // written comes back `missing` on the next load — measured
        // 2026-09-07). Marking the chunk dirty queues the store's throttled
        // write-back (`chunks.update`), which is what makes today's canvas
        // exist tomorrow. Last writer wins per chunk; each writer's cache
        // already merged everyone's live edits, so that is rarely visible.
        chunks.markDirty(chunk);
      })
      .catch((error) =>
        context.hud.toast(
          `Paint failed: ${error instanceof Error ? error.message : String(error)}`,
          'error',
        ),
      );
  }

  private syncChunks(): void {
    const context = this.context;
    if (!context) return;
    const center = worldToChunk({ x: this.position.x, y: 0, z: this.position.z });
    const wanted = new Set<string>();
    for (let dx = -DRAW_RADIUS_CHUNKS; dx <= DRAW_RADIUS_CHUNKS; dx++) {
      for (let dz = -DRAW_RADIUS_CHUNKS; dz <= DRAW_RADIUS_CHUNKS; dz++) {
        const coord: ChunkCoord = { x: center.x + dx, y: 0, z: center.z + dz };
        const key = chunkKey(coord);
        wanted.add(key);
        const cached = context.session.world.chunks.get(coord);
        let entry = this.chunkGraphics.get(key);
        if (!entry) {
          entry = { graphics: new Graphics(), revision: -1 };
          entry.graphics.position.set(
            coord.x * CHUNK_SIZE * CELL_PX,
            coord.z * CHUNK_SIZE * CELL_PX,
          );
          this.chunkLayer.addChild(entry.graphics);
          this.chunkGraphics.set(key, entry);
        }
        const revision = cached?.revision ?? 0;
        if (entry.revision !== revision) {
          entry.revision = revision;
          this.drawChunk(entry.graphics, cached?.voxels ?? null);
        }
      }
    }
    for (const [key, entry] of this.chunkGraphics) {
      if (wanted.has(key)) continue;
      entry.graphics.destroy();
      this.chunkGraphics.delete(key);
    }
    this.drawGrid(center);
  }

  private drawChunk(graphics: Graphics, voxels: Uint8Array | null): void {
    graphics.clear();
    graphics.rect(0, 0, CHUNK_SIZE * CELL_PX, CHUNK_SIZE * CELL_PX).fill({ color: 0x10151f });
    if (!voxels) return;
    for (let z = 0; z < CHUNK_SIZE; z++) {
      for (let x = 0; x < CHUNK_SIZE; x++) {
        const type = voxels[x + z * 256] ?? 0; // y = 0 layer of the x + y*16 + z*256 layout
        if (type === 0) continue;
        graphics
          .rect(x * CELL_PX + 1, z * CELL_PX + 1, CELL_PX - 2, CELL_PX - 2)
          .fill({ color: PALETTE[(type - 1) % PALETTE.length] ?? 0xffffff });
      }
    }
  }

  private drawGrid(center: ChunkCoord): void {
    const g = this.gridLayer;
    g.clear();
    const span = (DRAW_RADIUS_CHUNKS * 2 + 1) * CHUNK_SIZE;
    const originX = (center.x - DRAW_RADIUS_CHUNKS) * CHUNK_SIZE;
    const originZ = (center.z - DRAW_RADIUS_CHUNKS) * CHUNK_SIZE;
    for (let i = 0; i <= span; i++) {
      const major = i % CHUNK_SIZE === 0;
      const color = major ? 0x2fd7ad : 0x1a2330;
      const alpha = major ? 0.6 : 0.5;
      g.moveTo((originX + i) * CELL_PX, originZ * CELL_PX)
        .lineTo((originX + i) * CELL_PX, (originZ + span) * CELL_PX)
        .stroke({ color, alpha, width: major ? 2 : 1 });
      g.moveTo(originX * CELL_PX, (originZ + i) * CELL_PX)
        .lineTo((originX + span) * CELL_PX, (originZ + i) * CELL_PX)
        .stroke({ color, alpha, width: major ? 2 : 1 });
    }
  }

  private syncPlayers(nowMs: number): void {
    const context = this.context;
    if (!context) return;
    const seen = new Set<string>();
    for (const player of context.session.players(this.programId)) {
      seen.add(player.uuid);
      const pose = displayPose(player, nowMs);
      let sprite = this.players.get(player.uuid);
      if (!sprite) {
        sprite = this.makePlayerSprite(pose.name || 'player', pose.tint);
        this.playersLayer.addChild(sprite.container);
        this.players.set(player.uuid, sprite);
      } else if (sprite.tint !== pose.tint || sprite.name !== pose.name) {
        this.restyle(sprite, pose.name || 'player', pose.tint);
      }
      sprite.container.position.set(pose.x * CELL_PX, pose.z * CELL_PX);
    }
    for (const [uuid, sprite] of this.players) {
      if (seen.has(uuid)) continue;
      sprite.container.destroy({ children: true });
      this.players.delete(uuid);
    }
  }

  private makePlayerSprite(name: string, tint: number): PlayerSprite {
    const container = new Container();
    const disc = new Graphics();
    const label = new Text({
      text: name,
      style: new TextStyle({
        fill: 0xe9f5f1,
        fontSize: 13,
        fontFamily: 'system-ui, sans-serif',
        fontWeight: '600',
      }),
    });
    label.anchor.set(0.5, 1);
    label.position.set(0, -CELL_PX * 0.55);
    container.addChild(disc, label);
    const sprite: PlayerSprite = { container, disc, label, tint, name };
    this.restyle(sprite, name, tint);
    return sprite;
  }

  private restyle(sprite: PlayerSprite, name: string, tint: number): void {
    sprite.tint = tint;
    sprite.name = name;
    sprite.label.text = name;
    sprite.disc
      .clear()
      .circle(0, 0, CELL_PX * 0.42)
      .fill({ color: tintColor(tint) })
      .stroke({ color: 0x07090d, width: 2 });
  }

  private holodeckReturnPoint(): { x: number; y: number; z: number; yaw: number } {
    const program = programBySceneId(this.id);
    if (!program) return { x: 0, y: 0, z: 6, yaw: Math.PI };
    return { x: program.pad.x, y: 0, z: program.pad.z + 2.5, yaw: 0 };
  }
}
