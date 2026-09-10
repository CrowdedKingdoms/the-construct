import { afterEach, describe, expect, it } from 'vitest';

import { encodeSamples } from '@/platform/media/mulaw';
import {
  RecordingPlayback,
  VoiceService,
  type VoiceTransport,
} from '@/platform/media/VoiceService';

type AudioN = { uuid: string; audioData: string; sequenceNumber?: number };
type Handler<T> = (n: T) => void;

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary);
}

function fakeTransport(self = 'self-uuid') {
  const audio = new Set<Handler<AudioN>>();
  const left = new Set<Handler<{ uuid: string }>>();
  const lane = new Set<Handler<string>>();
  const transport: VoiceTransport & {
    emitAudio(n: AudioN): void;
    emitLeft(uuid: string): void;
  } = {
    onAudio: (h) => {
      audio.add(h);
      return () => audio.delete(h);
    },
    onActorLeft: (h) => {
      left.add(h);
      return () => left.delete(h);
    },
    onLaneLeave: (h) => {
      lane.add(h);
      return () => lane.delete(h);
    },
    selfUuid: () => self,
    selfChunk: () => ({ x: '0', y: '0', z: '0' }),
    selfPosition: () => ({ x: 0, y: 0, z: 0 }),
    remotePositions: () => [{ uuid: 'other', x: 4, y: 0, z: 0 }],
    appId: () => '1',
    sendAudioPacket: async () => true,
    log: () => undefined,
    emitAudio(n) {
      for (const h of audio) h(n);
    },
    emitLeft(uuid) {
      for (const h of left) h({ uuid });
    },
  };
  return transport;
}

describe('VoiceService receive', () => {
  const services: VoiceService[] = [];

  afterEach(() => {
    for (const service of services) service.dispose();
    services.length = 0;
  });

  function start() {
    const transport = fakeTransport();
    const playback = new RecordingPlayback();
    const voice = new VoiceService(transport, { playback, now: () => 1_000 });
    services.push(voice);
    voice.listen();
    const payload = bytesToBase64(encodeSamples(new Float32Array(8).fill(0.2)));
    return { transport, playback, voice, payload };
  }

  it('ignores self, plays others, drops a duplicate sequence, and tears down on actorLeft', () => {
    const { transport, playback, payload } = start();
    transport.emitAudio({ uuid: 'self-uuid', audioData: payload, sequenceNumber: 1 });
    expect(playback.played).toHaveLength(0);
    transport.emitAudio({ uuid: 'other', audioData: payload, sequenceNumber: 1 });
    expect(playback.played).toHaveLength(1);
    expect(playback.played[0]!.uuid).toBe('other');
    transport.emitAudio({ uuid: 'other', audioData: payload, sequenceNumber: 1 });
    expect(playback.played).toHaveLength(1);
    transport.emitLeft('other');
    expect(playback.forgotten).toContain('other');
  });
});
