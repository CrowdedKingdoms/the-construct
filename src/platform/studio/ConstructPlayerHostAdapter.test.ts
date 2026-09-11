import { describe, expect, it, vi } from 'vitest';

import { AgentLocomotion } from '@/platform/studio/agentLocomotion';
import {
  CONSTRUCT_AGENT_TOOL_NAMES,
  ConstructPlayerHostAdapter,
  capabilityRevisionFor,
  type ConstructObservationFrame,
} from '@/platform/studio/ConstructPlayerHostAdapter';
import { studioPermissions } from '@/platform/studio/permissions';
import type { GridSnapshot } from '@/platform/studio/GridService';

function grid(owned = true): GridSnapshot {
  return {
    gridId: '99',
    bounds: { low: { x: '0', y: '0', z: '0' }, high: { x: '0', y: '0', z: '0' } },
    permissions: studioPermissions(['write_server_code', 'run_server_code']),
    owned,
  };
}

function frame(over: Partial<ConstructObservationFrame> = {}): ConstructObservationFrame {
  return {
    playerId: 'player-1',
    position: { x: 1, y: 0, z: 2 },
    velocity: { x: 0, y: 0, z: 0 },
    yaw: 0.5,
    pitch: -0.1,
    grid: grid(),
    nearbyActors: [{ actorId: 'p2', position: { x: 3, y: 0, z: 2 }, label: 'Ada' }],
    humanInputActive: false,
    textInputFocused: false,
    modalOpen: false,
    ...over,
  };
}

function setup(over: Partial<ConstructObservationFrame> = {}) {
  const current = { value: frame(over) };
  const locomotion = new AgentLocomotion();
  const sendChat = vi.fn(async () => undefined);
  const adapter = new ConstructPlayerHostAdapter({
    frame: () => current.value,
    locomotion,
    sendChat,
    now: () => 1_000,
  });
  return { adapter, current, locomotion, sendChat };
}

describe('ConstructPlayerHostAdapter', () => {
  it('advertises only observe, move, look, stop, and local chat', async () => {
    const { adapter } = setup();
    const capabilities = await adapter.capabilities();
    expect(capabilities.gameId).toBe('the-construct');
    expect(capabilities.commands.map((c) => c.toolName)).toEqual(CONSTRUCT_AGENT_TOOL_NAMES.slice(2));
    expect(capabilities.commands.some((c) => /inventory|combat|craft|mount|teleport/i.test(c.toolName))).toBe(
      false,
    );
  });

  it('observes nearby players and the current grid', async () => {
    const { adapter } = setup();
    const observation = await adapter.observe({
      detail: 'STANDARD',
      maxNearbyActors: 8,
      maxNearbyVoxels: 8,
    });
    expect(observation.contractVersion).toBe('crowdy.game-observation/1');
    expect(observation.nearbyActors).toHaveLength(1);
    expect(observation.nearbyActors[0]?.label).toBe('Ada');
    expect(observation.grid?.gridRef).toBe('99');
    expect(observation.nearbyVoxels).toEqual([]);
  });

  it('applies MOVE to locomotion and denies GROUP chat', async () => {
    const { adapter, locomotion, sendChat } = setup();
    const observation = await adapter.observe({
      detail: 'MINIMAL',
      maxNearbyActors: 0,
      maxNearbyVoxels: 0,
    });
    const gate = {
      contractVersion: 'crowdy.validated-gate/1' as const,
      clientEpoch: '1',
      leaseId: 'lease-1',
      scopes: ['locomotion', 'communicate'] as const,
      contextVersion: '1',
      observationId: observation.observationId,
      validatedAt: new Date().toISOString(),
    };
    const moved = await adapter.dispatch(
      {
        kind: 'MOVE',
        observationId: observation.observationId,
        capabilityRevision: observation.capabilityRevision,
        controlledEntityId: observation.controlledEntityId,
        direction: 'FORWARD',
        intensity: 1,
        durationMs: 200,
      },
      gate,
    );
    expect(moved.status).toBe('SUCCEEDED');
    expect(locomotion.sample(1_050).y).toBe(1);

    const chat = await adapter.dispatch(
      {
        kind: 'CHAT_SEND',
        observationId: observation.observationId,
        capabilityRevision: observation.capabilityRevision,
        controlledEntityId: observation.controlledEntityId,
        channel: 'GROUP',
        text: 'nope',
      },
      { ...gate, scopes: ['communicate'] },
    );
    expect(chat.status).toBe('DENIED');
    expect(sendChat).not.toHaveBeenCalled();
  });

  it('preempts when human input is active', async () => {
    const { adapter, current } = setup();
    const observation = await adapter.observe({
      detail: 'MINIMAL',
      maxNearbyActors: 0,
      maxNearbyVoxels: 0,
    });
    current.value = { ...current.value, humanInputActive: true };
    const result = await adapter.dispatch(
      {
        kind: 'LOOK',
        observationId: observation.observationId,
        capabilityRevision: observation.capabilityRevision,
        controlledEntityId: observation.controlledEntityId,
        deltaYaw: 10,
        deltaPitch: 0,
      },
      {
        contractVersion: 'crowdy.validated-gate/1',
        clientEpoch: '1',
        scopes: ['locomotion'],
        contextVersion: '1',
        observationId: observation.observationId,
        validatedAt: new Date().toISOString(),
      },
    );
    expect(result.status).toBe('DENIED');
    expect(result.error?.code).toBe('AGENT_PREEMPTED');
  });

  it('changes capability revision when the grid changes', () => {
    const a = capabilityRevisionFor(frame());
    const b = capabilityRevisionFor(frame({ grid: null }));
    expect(a).not.toBe(b);
  });
});
