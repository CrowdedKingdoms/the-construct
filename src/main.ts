/**
 * Boot: finish a hosted sign-in we may be returning from -> resolve the app id
 * -> restore or start a sign-in -> enter the app -> join the world -> load the
 * holodeck. Read top to bottom; every step is a platform call and a UI
 * reaction, and the scenes only start once the world session is live.
 *
 * The app id comes BEFORE sign-in, because the hosted sign-in redirect names
 * the app the token is for. There is no in-browser Setup any more: creating an
 * org and app needs an identity session, which a game on its own domain never
 * holds (see platform/auth/AuthService.ts). `npm run setup` does it.
 */
import '@/style.css';

import { Controls } from '@/engine/controls';
import { GameLoop } from '@/engine/GameLoop';
import { Input } from '@/engine/Input';
import { SceneRouter } from '@/engine/SceneRouter';
import { AuthService } from '@/platform/auth/AuthService';
import {
  APP_ID_STORAGE_KEY,
  BUILD_APP_ID,
  GAME_NAME,
  STUDIO_WALLET_URL,
  resolveAppId,
} from '@/platform/config';
import { ensureEnvScope, readScoped, writeScoped } from '@/platform/envScope';
import { GameSession } from '@/platform/GameSession';
import { NetworkManager, messageOf, type AppRoute } from '@/platform/network/NetworkManager';
import { HOLODECK_SCENE_ID, HOLODECK_SPAWN, programById } from '@/platform/programs';
import { HolodeckScene } from '@/scenes/holodeck-three/HolodeckScene';
import { PaintScene } from '@/scenes/program-pixi/PaintScene';
import { BootCard } from '@/ui/BootCard';
import { ChatPanel } from '@/ui/ChatPanel';
import { Hud } from '@/ui/Hud';
import { showSignIn } from '@/ui/LoginForm';
import { showNoApp } from '@/ui/NoAppCard';

const gameRoot = document.getElementById('game-root');
const uiRoot = document.getElementById('ui-root');
if (!gameRoot || !uiRoot) throw new Error('index.html is missing #game-root / #ui-root');

ensureEnvScope();
document.title = GAME_NAME;

const network = NetworkManager.instance;
const auth = new AuthService(network);
const card = new BootCard(uiRoot);
const input = new Input();
input.attach(gameRoot);

let running: RunningGame | null = null;

interface RunningGame {
  session: GameSession;
  loop: GameLoop;
  router: SceneRouter;
  hud: Hud;
  chat: ChatPanel;
  timers: Array<ReturnType<typeof setInterval>>;
  disposers: Array<() => void>;
}

document.getElementById('construct-boot-fallback')?.remove();
void boot();

async function boot(): Promise<void> {
  try {
    card.setStatus('Restoring your session…');
    card.show([]);

    // 1. Returning from Crowded Kingdoms' sign-in page? Finish it: the SDK
    //    exchanges the code for an app token and tells us the app's endpoint.
    const returned = await auth.completeIfReturning();
    if (returned) {
      writeScoped(APP_ID_STORAGE_KEY, returned.appId);
      await enterAndPlay(returned);
      return;
    }

    // 2. A previous visit's token, still valid? Straight in.
    const restored = await auth.restore();
    if (restored) {
      await enterAndPlay(restored);
      return;
    }

    // 3. Otherwise we need to know WHICH app before we can sign in.
    const resolved = resolveAppId({
      search: window.location.search,
      stored: readScoped(APP_ID_STORAGE_KEY),
      env: BUILD_APP_ID,
    });
    if (!resolved.appId) {
      showNoApp(card, (appId) => {
        writeScoped(APP_ID_STORAGE_KEY, appId);
        void boot();
      });
      return;
    }
    writeScoped(APP_ID_STORAGE_KEY, resolved.appId);
    showSignIn(card, auth, resolved.appId);
  } catch (error) {
    card.showError('Could not start', messageOf(error), () => void boot());
  }
}

async function enterAndPlay(route: AppRoute): Promise<void> {
  card.setStatus(`Entering app ${route.appId}…`);
  card.show([]);
  try {
    await network.enterApp(route);
    const boot = await network.bootstrap();
    if (boot.udpConnected === false)
      network.log('UDP proxy not yet connected; the SDK will connect on subscribe');
  } catch (error) {
    // The token may have died, or the app may be gone: forget the pin and let
    // the player choose / sign in again, with the reason on screen.
    await network.signOut();
    writeScoped(APP_ID_STORAGE_KEY, null);
    showNoApp(
      card,
      (appId) => {
        writeScoped(APP_ID_STORAGE_KEY, appId);
        void boot();
      },
      `App ${route.appId} could not be entered: ${messageOf(error)}`,
    );
    return;
  }
  writeScoped(APP_ID_STORAGE_KEY, route.appId);
  const url = new URL(window.location.href);
  if (url.searchParams.has('app')) {
    url.searchParams.delete('app');
    window.history.replaceState({}, '', url.toString());
  }
  await startGame();
}

async function startGame(): Promise<void> {
  await stopGame();
  const session = new GameSession(network);
  card.setStatus('Loading your save…');
  const saved = await session.loadSave();

  const router = new SceneRouter();
  router.register(HOLODECK_SCENE_ID, () => new HolodeckScene());
  router.register('paint', () => new PaintScene());

  const studioWalletUrl = STUDIO_WALLET_URL;
  const hud = new Hud(uiRoot!, {
    openStudio: () => void toggleStudio(),
    openSetup: () => void switchApp(),
    signOut: () => void signOut(),
    toggleCamera: () => void session.webcam.toggle(),
    toggleVoice: () => void session.voice.toggle(),
    ...(studioWalletUrl
      ? {
          openWallet: () => {
            window.open(studioWalletUrl, '_blank', 'noopener');
          },
        }
      : {}),
  });
  const chat = new ChatPanel(uiRoot!, session.chat, input);
  const loop = new GameLoop(gameRoot!, router, session);
  router.bind({ root: gameRoot!, session, input, router, hud }, loop.size());

  session.studio.attach({
    suppressGameplayInput: () => input.suppress(),
    onLayoutChange: (rightInset) => loop.setRightInset(rightInset),
    notify: (text, tone) => hud.toast(text, tone),
    bannerParent: uiRoot!,
  });

  const game: RunningGame = { session, loop, router, hud, chat, timers: [], disposers: [] };
  running = game;

  game.disposers.push(session.studio.events.on('state', (state) => hud.renderStudio(state)));
  hud.renderStudio(session.studio.snapshot);
  game.disposers.push(
    input.onKeys(Controls.studio, () => {
      if (input.suppressed && !session.studio.isOpen) return;
      void toggleStudio();
    }),
  );
  game.disposers.push(session.webcam.events.on('local', (state) => hud.renderCamera(state)));
  game.disposers.push(session.voice.events.on('local', (state) => hud.renderVoice(state)));
  game.disposers.push(
    input.onKeys(Controls.webcam, () => {
      if (input.suppressed) return;
      void session.webcam.toggle();
    }),
  );
  game.disposers.push(
    input.onKeys(Controls.voice, () => {
      if (input.suppressed) return;
      void session.voice.toggle();
    }),
  );
  game.disposers.push(
    input.onKeys(Controls.help, (event) => {
      if (input.suppressed) return;
      event.preventDefault();
      hud.toggleHelp();
    }),
  );
  game.disposers.push(
    input.onKeys(Controls.escape, () => {
      if (hud.isHelpOpen) hud.setHelpOpen(false);
      input.exitLook();
    }),
  );
  game.disposers.push(
    router.events.on('scene', (scene) => {
      const program = programById(scene.programId);
      if (program) session.rememberProgram(program.programId);
      network.log(`scene: ${scene.id}`);
    }),
  );
  game.disposers.push(
    network.events.on('realtime', (status) => network.log(`realtime: ${String(status)}`)),
  );

  // Join where we left off (holodeck only; programs re-spawn at their entry).
  const spawn = saved.position && !saved.lastProgram ? saved.position : HOLODECK_SPAWN;
  card.setStatus('Joining the world…');
  await session.join({ x: spawn.x, y: spawn.y, z: spawn.z });
  await router.load(HOLODECK_SCENE_ID, spawn);
  loop.start();
  card.hide();
  hud.toast(`Welcome to ${GAME_NAME}`);
  session.chat.system(
    'Proximity chat — nearby players hear you. T or Enter to type, B camera, V voice, F1 controls.',
  );
  session.chat.system(
    studioWalletUrl
      ? 'Crowdy Agent lives in Studio (M) after you claim a chunk. Ask/Build writes mods; Play can walk for you. Agent tokens are platform-funded — no OpenRouter key in this game. Grid compute still uses your player wallet (Wallet in the HUD).'
      : 'Crowdy Agent lives in Studio (M) after you claim a chunk. Ask/Build writes mods; Play can walk for you. Agent tokens are platform-funded on the Crowded Kingdoms side.',
  );

  const refreshHud = async () => {
    if (running !== game) return;
    const scene = router.current;
    const [world, progress] = await Promise.all([session.model.world(), session.model.progress()]);
    hud.render(session, {
      players: session.players().length,
      sceneId: scene?.id ?? '…',
      model: { pulses: world.seeded ? world.pulses : undefined, level: progress?.level },
    });
  };
  void refreshHud();
  game.timers.push(setInterval(() => void refreshHud(), 5000));
  game.timers.push(
    setInterval(() => {
      // Cheap presence-count refresh between model polls.
      const scene = router.current;
      if (!scene) return;
      hud.render(session, { players: session.players().length, sceneId: scene.id });
    }, 1500),
  );

  window.addEventListener('beforeunload', () => void session.flushSave(), { once: true });

  if (import.meta.env.DEV) {
    // Dev-only console handle for poking at the running game
    // (`__construct.session.players()`, `__construct.router.load('paint')`).
    (window as unknown as { __construct?: unknown }).__construct = {
      session,
      router,
      loop,
      network,
    };
  }
}

async function toggleStudio(): Promise<void> {
  const game = running;
  if (!game) return;
  const scene = game.router.current;
  if (!scene) return;
  try {
    await game.session.studio.toggle(scene.localPose());
  } catch (error) {
    game.hud.toast(messageOf(error), 'error');
  }
}

/**
 * Switch to another app: the token we hold is confined to this one, so it is
 * a fresh hosted sign-in for the other (one silent bounce while the player's
 * Studio session lasts).
 */
async function switchApp(): Promise<void> {
  await stopGame();
  await network.signOut();
  writeScoped(APP_ID_STORAGE_KEY, null);
  showNoApp(card, (appId) => {
    writeScoped(APP_ID_STORAGE_KEY, appId);
    void boot();
  });
}

async function signOut(): Promise<void> {
  await stopGame();
  await auth.signOut();
  void boot();
}

async function stopGame(): Promise<void> {
  const game = running;
  if (!game) return;
  running = null;
  for (const timer of game.timers) clearInterval(timer);
  for (const dispose of game.disposers) dispose();
  game.loop.stop();
  game.router.dispose();
  game.session.studio.dispose();
  game.chat.dispose();
  game.hud.root.remove();
  await game.session.leave();
  network.leaveApp();
}
