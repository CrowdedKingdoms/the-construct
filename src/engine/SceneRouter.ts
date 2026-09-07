/**
 * Loads one scene at a time into the game root and keeps the platform session
 * informed of which one. Scenes are constructed lazily from factories so an
 * unused renderer never initialises (or, with code-splitting, never loads).
 */
import type { GameScene, SceneContext, SceneFactory, SceneSize } from '@/engine/GameScene';
import { Emitter } from '@/platform/util/Emitter';

export interface SceneRouterEvents {
  /** Fired after a scene has mounted. */
  scene: GameScene;
  /** Fired when a load fails; the previous scene stays mounted if it can. */
  error: { sceneId: string; error: unknown };
}

export class SceneRouter {
  readonly events = new Emitter<SceneRouterEvents>();
  private readonly factories = new Map<string, SceneFactory>();
  private readonly instances = new Map<string, GameScene>();
  private active: GameScene | null = null;
  private loading: Promise<GameScene> | null = null;
  private context: SceneContext | null = null;
  private size: SceneSize = { width: 1, height: 1, rightInset: 0 };

  register(id: string, factory: SceneFactory): void {
    this.factories.set(id, factory);
  }

  ids(): string[] {
    return [...this.factories.keys()];
  }

  /** Called once by the loop before the first `load`. */
  bind(context: SceneContext, size: SceneSize): void {
    this.context = context;
    this.size = size;
  }

  get current(): GameScene | null {
    return this.active;
  }

  get isLoading(): boolean {
    return this.loading !== null;
  }

  /**
   * Switch scenes. The new scene mounts with the local player at `spawn` (or
   * where the scene decides when omitted). Concurrent loads are serialised.
   */
  async load(
    id: string,
    spawn?: { x: number; y: number; z: number; yaw?: number },
  ): Promise<GameScene> {
    if (this.loading) await this.loading.catch(() => undefined);
    if (this.active?.id === id) return this.active;
    const context = this.context;
    if (!context) throw new Error('SceneRouter.bind() before load()');
    const factory = this.factories.get(id);
    if (!factory) throw new Error(`No scene registered as "${id}"`);

    const run = (async () => {
      const previous = this.active;
      let scene = this.instances.get(id);
      if (!scene) {
        scene = factory();
        this.instances.set(id, scene);
      }
      try {
        previous?.unmount();
        this.active = null;
        await scene.mount(context, this.size);
        if (spawn) scene.setLocalPosition(spawn);
        this.active = scene;
        this.events.emit('scene', scene);
        return scene;
      } catch (error) {
        this.events.emit('error', { sceneId: id, error });
        throw error;
      }
    })();
    this.loading = run;
    try {
      return await run;
    } finally {
      if (this.loading === run) this.loading = null;
    }
  }

  resize(size: SceneSize): void {
    this.size = size;
    this.active?.resize(size);
  }

  dispose(): void {
    this.active?.unmount();
    this.active = null;
    this.instances.clear();
  }
}
