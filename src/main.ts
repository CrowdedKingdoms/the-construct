/**
 * Boot: sign in -> resolve an app (or run Setup) -> enter it -> join the world
 * -> load the holodeck. Read top to bottom; every step is a platform call and
 * a UI reaction, and the scenes only start once the world session is live.
 */
import '@/style.css';

import { GameLoop } from '@/engine/GameLoop';
import { Input } from '@/engine/Input';
import { SceneRouter } from '@/engine/SceneRouter';
import { AuthService } from '@/platform/auth/AuthService';
import { APP_ID_STORAGE_KEY, BUILD_APP_ID, GAME_NAME, resolveAppId } from '@/platform/config';
import { ensureEnvScope, readScoped, writeScoped } from '@/platform/envScope';
import { GameSession } from '@/platform/GameSession';
import { NetworkManager, messageOf } from '@/platform/network/NetworkManager';
import { HOLODECK_SCENE_ID, HOLODECK_SPAWN, programById } from '@/platform/programs';
import { HolodeckScene } from '@/scenes/holodeck-three/HolodeckScene';
import { PaintScene } from '@/scenes/program-pixi/PaintScene';
import { BootCard } from '@/ui/BootCard';
import { ChatPanel } from '@/ui/ChatPanel';
import { Hud } from '@/ui/Hud';
import { showLoginForm } from '@/ui/LoginForm';
import { showSetupWizard } from '@/ui/SetupWizard';

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

void boot();

async function boot(): Promise<void> {
  try {
    card.setStatus('Restoring your session…');
    card.show([]);
    await network.completeMagicLinkIfPresent();
    let user = await network.restoreIdentity();
    if (!user) user = await showLoginForm(card, auth);
    card.setStatus(`Signed in as ${user.gamertag ?? user.email ?? user.userId}`);

    const resolved = resolveAppId({
      search: window.location.search,
      stored: readScoped(APP_ID_STORAGE_KEY),
      env: BUILD_APP_ID,
    });
    if (resolved.appId) {
      await enterAndPlay(resolved.appId, `Entering app ${resolved.appId} (${resolved.source})…`);
    } else {
      await runSetupThenPlay();
    }
  } catch (error) {
    card.showError('Could not start', messageOf(error), () => void boot());
  }
}

async function runSetupThenPlay(reason?: string): Promise<void> {
  const current = readScoped(APP_ID_STORAGE_KEY);
  const { appId } = await showSetupWizard(card, network, { reason, currentAppId: current });
  await enterAndPlay(appId, `Entering app ${appId}…`);
}

async function enterAndPlay(appId: string, status: string): Promise<void> {
  card.setStatus(status);
  card.show([]);
  try {
    await network.enterApp(appId);
    const boot = await network.bootstrap();
    if (boot.udpConnected === false) network.log('UDP proxy not yet connected; the SDK will connect on subscribe');
  } catch (error) {
    // The pinned/remembered app may be gone, or not ours: fall back to Setup
    // with the reason on screen rather than a dead end.
    writeScoped(APP_ID_STORAGE_KEY, null);
    await runSetupThenPlay(`App ${appId} could not be entered: ${messageOf(error)}`);
    return;
  }
  writeScoped(APP_ID_STORAGE_KEY, appId);
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

  const hud = new Hud(uiRoot!, {
    openStudio: () => void toggleStudio(),
    openSetup: () => void switchApp(),
    signOut: () => void signOut(),
  });
  const chat = new ChatPanel(uiRoot!, session.chat, input);
  const loop = new GameLoop(gameRoot!, router, session);
  router.bind({ root: gameRoot!, session, input, router, hud }, loop.size());

  session.studio.attach({
    suppressGameplayInput: () => input.suppress(),
    onLayoutChange: (rightInset) => loop.setRightInset(rightInset),
    notify: (text, tone) => hud.toast(text, tone),
  });

  const game: RunningGame = { session, loop, router, hud, chat, timers: [], disposers: [] };
  running = game;

  game.disposers.push(session.studio.events.on('state', (state) => hud.renderStudio(state)));
  hud.renderStudio(session.studio.snapshot);
  game.disposers.push(
    input.onKey('KeyM', () => {
      if (input.suppressed && !session.studio.isOpen) return;
      void toggleStudio();
    }),
  );
  game.disposers.push(
    router.events.on('scene', (scene) => {
      const program = programById(scene.programId);
      if (program) session.rememberProgram(program.programId);
      network.log(`scene: ${scene.id}`);
    }),
  );
  game.disposers.push(network.events.on('realtime', (status) => network.log(`realtime: ${String(status)}`)));

  // Join where we left off (holodeck only; programs re-spawn at their entry).
  const spawn = saved.position && !saved.lastProgram ? saved.position : HOLODECK_SPAWN;
  card.setStatus('Joining the world…');
  await session.join({ x: spawn.x, y: spawn.y, z: spawn.z });
  await router.load(HOLODECK_SCENE_ID, spawn);
  loop.start();
  card.hide();
  hud.toast(`Welcome to ${GAME_NAME}`);
  session.chat.system('Proximity chat — only players within a few chunks hear you. Press T to type.');

  const refreshHud = async () => {
    if (running !== game) return;
    const scene = router.current;
    const [world, progress] = await Promise.all([session.model.world(), session.model.progress()]);
    hud.render(session, {
      players: session.players().length,
      sceneId: scene?.id ?? '…',
      pulses: world.seeded ? world.pulses : undefined,
      level: progress?.level,
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

async function switchApp(): Promise<void> {
  await stopGame();
  card.setStatus('Setup');
  await runSetupThenPlay('Create another app, switch apps, or re-run the seed on this one.').catch((error) =>
    card.showError('Setup failed', messageOf(error), () => void boot()),
  );
}

async function signOut(): Promise<void> {
  await stopGame();
  await auth.signOut();
  writeScoped(APP_ID_STORAGE_KEY, null);
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
