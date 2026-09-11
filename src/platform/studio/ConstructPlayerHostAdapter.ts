/**
 * The Construct implementation of `crowdy.player-host/1`.
 *
 * Ask/Play may observe nearby players and the current grid. Play may walk,
 * look, stop, and send proximity chat — the same paths a human uses. No
 * inventory, combat, craft, mount, or teleport: this starter does not have
 * those services. Effects never touch the token, GraphQL, or the mod worker.
 */
import { CrowdyAgentError, toAgentError } from '@crowdedkingdoms/crowdyjs/agent';
import type { CrowdyAgentPreemptionReason } from '@crowdedkingdoms/crowdyjs/agent';
import type {
  GameCommandResultV1,
  GameCommandV1,
  GameObservationV1,
  ObserveRequestV1,
  PlayerHostAdapterV1,
  PlayerHostCapabilitiesV1,
  PlayerHostCommandCapabilityV1,
  PlayerHostLeaseScope,
  ValidatedGateV1,
} from '@crowdedkingdoms/crowdyjs/player-host';

import type { AgentLocomotion } from '@/platform/studio/agentLocomotion';
import type { GridSnapshot } from '@/platform/studio/GridService';

export const CONSTRUCT_AGENT_TOOL_NAMES = Object.freeze([
  'game.capabilities.get',
  'game.observe',
  'game.control.move',
  'game.control.look',
  'game.control.stop',
  'game.chat.send',
] as const);

export const CONSTRUCT_OBSERVATION_MAX_AGE_MS = 1_500;
export const CONSTRUCT_MAX_NEARBY_ACTORS = 32;
export const CONSTRUCT_MAX_NEARBY_VOXELS = 0;

const COMMAND_CAPABILITIES = Object.freeze([
  command('MOVE', 'game.control.move', 'locomotion', 8),
  command('LOOK', 'game.control.look', 'locomotion', 12),
  command('STOP', 'game.control.stop', undefined, 100),
  command('CHAT_SEND', 'game.chat.send', 'communicate', 2),
] satisfies readonly PlayerHostCommandCapabilityV1[]);

export interface ConstructObservedActor {
  readonly actorId: string;
  readonly position: { x: number; y: number; z: number };
  readonly label?: string;
}

export interface ConstructObservationFrame {
  readonly playerId: string;
  readonly position: { x: number; y: number; z: number };
  readonly velocity: { x: number; y: number; z: number };
  readonly yaw: number;
  readonly pitch: number;
  readonly grid: GridSnapshot | null;
  readonly nearbyActors: readonly ConstructObservedActor[];
  readonly humanInputActive: boolean;
  readonly textInputFocused: boolean;
  readonly modalOpen: boolean;
}

export interface ConstructPlayerHostAdapterOptions {
  readonly frame: () => ConstructObservationFrame;
  readonly locomotion: AgentLocomotion;
  readonly sendChat: (text: string) => Promise<void>;
  readonly now?: () => number;
  readonly maxRememberedObservations?: number;
}

interface RememberedObservation {
  readonly observation: GameObservationV1;
  readonly frame: ConstructObservationFrame;
}

export class ConstructPlayerHostAdapter implements PlayerHostAdapterV1 {
  readonly contractVersion = 'crowdy.player-host/1' as const;
  private readonly observations = new Map<string, RememberedObservation>();
  private sequence = 0;
  private readonly now: () => number;

  constructor(private readonly options: ConstructPlayerHostAdapterOptions) {
    this.now = options.now ?? Date.now;
  }

  async capabilities(): Promise<PlayerHostCapabilitiesV1> {
    const frame = this.options.frame();
    return capabilitiesFor(frame, this.now());
  }

  async observe(request: ObserveRequestV1): Promise<GameObservationV1> {
    const frame = this.options.frame();
    const capabilities = capabilitiesFor(frame, this.now());
    const observedAtMs = this.now();
    const observationId = `construct-obs-${observedAtMs}-${++this.sequence}`;
    const maxActors = Math.min(
      CONSTRUCT_MAX_NEARBY_ACTORS,
      clampInt(request.maxNearbyActors, 0, CONSTRUCT_MAX_NEARBY_ACTORS),
    );
    const nearbyActors = [...frame.nearbyActors]
      .map((actor) => ({
        actor,
        distance: distance(frame.position, actor.position),
      }))
      .sort(
        (left, right) =>
          left.distance - right.distance || left.actor.actorId.localeCompare(right.actor.actorId),
      )
      .slice(0, maxActors)
      .map(({ actor, distance: d }) => ({
        actorId: actor.actorId.slice(0, 128),
        kind: 'PLAYER' as const,
        position: vec(actor.position),
        distance: dec(d),
        disposition: 'NEUTRAL' as const,
        ...(actor.label ? { label: actor.label.slice(0, 128) } : {}),
      }));

    const observation: GameObservationV1 = {
      contractVersion: 'crowdy.game-observation/1',
      observationId,
      capabilityRevision: capabilities.revision,
      controlledEntityId: frame.playerId.slice(0, 128),
      observedAt: new Date(observedAtMs).toISOString(),
      expiresAt: new Date(observedAtMs + CONSTRUCT_OBSERVATION_MAX_AGE_MS).toISOString(),
      player: {
        position: vec(frame.position),
        velocity: vec(frame.velocity),
        look: { yaw: dec(frame.yaw), pitch: dec(frame.pitch) },
        health: '1',
        alive: true,
      },
      controlledEntity: {
        kind: 'PLAYER',
        position: vec(frame.position),
        velocity: vec(frame.velocity),
      },
      ...(frame.grid
        ? {
            grid: {
              gridRef: frame.grid.gridId,
              low: vec({
                x: Number(frame.grid.bounds.low.x),
                y: Number(frame.grid.bounds.low.y),
                z: Number(frame.grid.bounds.low.z),
              }),
              high: vec({
                x: Number(frame.grid.bounds.high.x),
                y: Number(frame.grid.bounds.high.y),
                z: Number(frame.grid.bounds.high.z),
              }),
              effectiveScopes: scopesFor(frame.grid),
            },
          }
        : {}),
      nearbyActors,
      nearbyVoxels: [],
      inputState: {
        modalOpen: frame.modalOpen,
        textInputFocused: frame.textInputFocused,
        humanInputActive: frame.humanInputActive,
      },
    };
    this.observations.set(observationId, { observation, frame });
    while (this.observations.size > (this.options.maxRememberedObservations ?? 32)) {
      const oldest = this.observations.keys().next().value;
      if (!oldest) break;
      this.observations.delete(oldest);
    }
    return observation;
  }

  async dispatch(command: GameCommandV1, gate: ValidatedGateV1): Promise<GameCommandResultV1> {
    if (command.kind === 'STOP') {
      this.clearAgentIntent('HUMAN_STOP');
      return success(command);
    }
    try {
      this.assertGate(command, gate);
      const remembered = this.observations.get(command.observationId);
      if (!remembered) {
        throw new CrowdyAgentError(
          'AGENT_OBSERVATION_STALE',
          'The Construct no longer retains that observation',
        );
      }
      const current = this.options.frame();
      const revision = capabilityRevisionFor(current);
      if (
        command.capabilityRevision !== remembered.observation.capabilityRevision ||
        command.controlledEntityId !== remembered.observation.controlledEntityId
      ) {
        throw new CrowdyAgentError(
          'AGENT_CONTROL_TARGET_CHANGED',
          'Command capability or controlled entity differs from its observation',
        );
      }
      if (
        revision !== command.capabilityRevision ||
        current.playerId !== command.controlledEntityId
      ) {
        this.clearAgentIntent('CONTROL_TARGET_CHANGED');
        throw new CrowdyAgentError(
          'AGENT_CONTROL_TARGET_CHANGED',
          'Host capability or controlled entity changed before dispatch',
        );
      }
      if (Date.parse(remembered.observation.expiresAt) <= this.now()) {
        throw new CrowdyAgentError(
          'AGENT_OBSERVATION_STALE',
          'Observation expired before dispatch',
        );
      }
      if (current.humanInputActive) {
        this.clearAgentIntent('HUMAN_INPUT');
        throw new CrowdyAgentError('AGENT_PREEMPTED', 'Human input took control');
      }
      if (current.modalOpen || current.textInputFocused) {
        throw new CrowdyAgentError(
          'AGENT_CONTEXT_CHANGED',
          'A modal or text field currently blocks agent control',
        );
      }
      return await this.route(command);
    } catch (error) {
      return denied(command, error);
    }
  }

  clearAgentIntent(_reason: CrowdyAgentPreemptionReason): void {
    this.options.locomotion.clear();
  }

  invalidateObservations(): void {
    this.observations.clear();
  }

  private async route(
    command: Exclude<GameCommandV1, { kind: 'STOP' }>,
  ): Promise<GameCommandResultV1> {
    if (command.kind === 'MOVE') {
      this.options.locomotion.applyMove({
        direction: command.direction,
        intensity: command.intensity,
        durationMs: command.durationMs,
        nowMs: this.now(),
      });
      return success(command);
    }
    if (command.kind === 'LOOK') {
      this.options.locomotion.applyLook({
        deltaYaw: command.deltaYaw,
        deltaPitch: command.deltaPitch,
      });
      return success(command);
    }
    if (command.kind === 'CHAT_SEND') {
      if (command.channel !== 'LOCAL') {
        throw new CrowdyAgentError(
          'AGENT_SCOPE_DENIED',
          'The Construct only offers proximity (LOCAL) chat',
        );
      }
      await this.options.sendChat(command.text);
      return success(command);
    }
    throw new CrowdyAgentError(
      'AGENT_HOST_UNAVAILABLE',
      `The Construct does not advertise ${command.kind}`,
    );
  }

  private assertGate(
    command: Exclude<GameCommandV1, { kind: 'STOP' }>,
    gate: ValidatedGateV1,
  ): void {
    if (
      gate.contractVersion !== 'crowdy.validated-gate/1' ||
      gate.observationId !== command.observationId
    ) {
      throw new CrowdyAgentError('AGENT_CONTEXT_STALE', 'Mismatched validated control gate');
    }
    const capability = COMMAND_CAPABILITIES.find((row) => row.kind === command.kind);
    if (!capability) {
      throw new CrowdyAgentError('AGENT_HOST_UNAVAILABLE', `Not advertised: ${command.kind}`);
    }
    if (capability.requiredScope && !gate.scopes.includes(capability.requiredScope)) {
      throw new CrowdyAgentError(
        'AGENT_LEASE_SCOPE_MISSING',
        `${command.kind} requires ${capability.requiredScope}`,
        { requiredScope: capability.requiredScope },
      );
    }
  }
}

export function capabilityRevisionFor(frame: ConstructObservationFrame): string {
  const payload = [
    'construct-host-v1',
    frame.playerId,
    frame.grid?.gridId ?? 'no-grid',
    ...(frame.grid ? scopesFor(frame.grid) : []),
  ].join('|');
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(payload)) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return `construct-host-v1-${hash.toString(16).padStart(16, '0')}`;
}

function capabilitiesFor(frame: ConstructObservationFrame, atMs: number): PlayerHostCapabilitiesV1 {
  return {
    contractVersion: 'crowdy.player-host/1',
    gameId: 'the-construct',
    revision: capabilityRevisionFor(frame),
    controlledEntityId: frame.playerId.slice(0, 128),
    commands: COMMAND_CAPABILITIES,
    observation: {
      maxAgeMs: CONSTRUCT_OBSERVATION_MAX_AGE_MS,
      maxNearbyActors: CONSTRUCT_MAX_NEARBY_ACTORS,
      maxNearbyVoxels: CONSTRUCT_MAX_NEARBY_VOXELS,
    },
    advertisedAt: new Date(atMs).toISOString(),
  };
}

function scopesFor(grid: GridSnapshot): PlayerHostLeaseScope[] {
  const scopes: PlayerHostLeaseScope[] = ['observe'];
  if (grid.owned || grid.permissions.server.canWrite || grid.permissions.client.canWrite) {
    scopes.push('locomotion', 'communicate');
  }
  return scopes;
}

function command(
  kind: PlayerHostCommandCapabilityV1['kind'],
  toolName: string,
  requiredScope: PlayerHostLeaseScope | undefined,
  rateLimitPerSecond: number,
): PlayerHostCommandCapabilityV1 {
  return {
    kind,
    toolName,
    ...(requiredScope ? { requiredScope } : {}),
    risk: 'WORLD_CONTROL',
    approval: 'NONE',
    rateLimitPerSecond,
  };
}

function success(command: GameCommandV1): GameCommandResultV1 {
  return {
    contractVersion: 'crowdy.game-command-result/1',
    status: 'SUCCEEDED',
    commandKind: command.kind,
    ...('observationId' in command ? { observationId: command.observationId } : {}),
  };
}

function denied(command: GameCommandV1, error: unknown): GameCommandResultV1 {
  return {
    contractVersion: 'crowdy.game-command-result/1',
    status: 'DENIED',
    commandKind: command.kind,
    ...('observationId' in command ? { observationId: command.observationId } : {}),
    error: toAgentError(error, 'AGENT_TOOL_FAILED'),
  };
}

function vec(value: { x: number; y: number; z: number }) {
  return { x: dec(value.x), y: dec(value.y), z: dec(value.z) };
}

function dec(value: number): string {
  return Number.isFinite(value) ? String(value) : '0';
}

function distance(
  a: { x: number; y: number; z: number },
  b: { x: number; y: number; z: number },
): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}
