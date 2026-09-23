/**
 * `@crowdedkingdoms/construct` — the Construct framework.
 *
 * The platform layer every Crowded Kingdoms browser game needs (hosted
 * sign-in, app entry, World Stores presence, voice / webcam / chat, the
 * Crowdy Studio dock with app and grid mods, JS grid programs) and the engine
 * loop around it. Deep imports (`@crowdedkingdoms/construct/platform/...`,
 * `/engine/...`, `/grid/...`) reach every module; this barrel re-exports the
 * pieces a game wires at boot.
 */

// Engine
export { GameLoop } from './engine/GameLoop';
export { SceneRouter, type SceneRouterEvents } from './engine/SceneRouter';
export {
  Input,
  isTextEntry,
  isPointerLockOn,
  type KeyHandler,
  type PointerState,
} from './engine/Input';
export { Controls, helpLines, type ControlAction } from './engine/controls';
export type {
  GameScene,
  SceneContext,
  SceneFactory,
  SceneHud,
  SceneSize,
} from './engine/GameScene';

// Session, network, presence
export { GameSession, type GameSessionEvents } from './platform/GameSession';
export {
  NetworkManager,
  messageOf,
  type AppRoute,
  type BootstrapInfo,
  type SessionUser,
} from './platform/network/NetworkManager';
export { AuthService } from './platform/auth/AuthService';
export {
  worldSession,
  hasWorldSession,
  disposeWorldSession,
  instanceStore,
  type RemotePlayer,
  type SaveState,
} from './platform/realtime/WorldStores';
export { NEUTRAL_POSE, POSE_BYTES, poseCodec, type Pose } from './platform/realtime/actorCodec';
export {
  chunkKey,
  worldToChunk,
  worldToVoxel,
  type ChunkCoord,
  type Vec3,
} from './platform/realtime/space';
export { ensureEnvScope, readScoped, writeScoped } from './platform/envScope';

// Social and media
export { ChatService, type ChatMessage } from './platform/social/ChatService';
export { VoiceService } from './platform/media/VoiceService';
export { WebcamService } from './platform/media/WebcamService';

// Model
export {
  configureGameModel,
  gameModelNames,
  gameKitOptions,
  type GameKitOptions,
  type GameModelNames,
} from './platform/model/gameModelConfig';

// Crowdy Studio, mods, grids
export { StudioService, type StudioHooks, type StudioState } from './platform/studio/StudioService';
export { GridService, type GridSnapshot } from './platform/studio/GridService';
export {
  toBrokerBounds,
  hasAnyStudioPermission,
  type GridBounds,
  type StudioPermissions,
} from './platform/studio/permissions';
export {
  routeClientHostCall,
  routeWithFallback,
  runConsentedGridMod,
  type ClientModHostReads,
  type ClientModHostWrites,
} from './platform/studio/clientModHost';
export { GridProgramRunner, type GridProgramRunnerOptions } from './grid/GridProgramRunner';
