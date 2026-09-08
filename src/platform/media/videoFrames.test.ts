/**
 * WebcamService's receive path over the SDK's real fragmenter/assembler, with
 * the platform and the browser mocked: a frame arrives once and whole, the
 * server's actor-left notice ends the stream at once, the idle fallback ends
 * a silent one, and dispose releases everything.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The SDK root barrel pulls Monaco, which does not load under happy-dom, so the
// service's import is answered from the two pure modules it actually uses.
vi.mock('@crowdedkingdoms/crowdyjs', async () => {
  // Hoisted above the imports, so everything it needs is computed inside.
  // The package exports only its barrels, so walk to node_modules directly
  // (vitest runs from the repo root, where vitest.config.ts is).
  const sdkDist = `${process.cwd()}/node_modules/@crowdedkingdoms/crowdyjs/dist/`;
  const media = await vi.importActual<Record<string, unknown>>(`${sdkDist}media/video-frames.js`);
  const utils = await vi.importActual<Record<string, unknown>>(`${sdkDist}utils.js`);
  return { ...media, decodeBase64: utils.decodeBase64, encodeBase64: utils.encodeBase64 };
});

import { encodeBase64, fragmentFrame } from '@crowdedkingdoms/crowdyjs';

import {
  REMOTE_IDLE_MS,
  WebcamService,
  type WebcamTransport,
} from '@/platform/media/WebcamService';

type Handler<T> = (n: T) => void;

function fakeTransport() {
  const video = new Set<Handler<{ uuid: string; videoData: string }>>();
  const left = new Set<Handler<{ uuid: string }>>();
  const lane = new Set<Handler<string>>();
  const transport: WebcamTransport & {
    emitVideo(uuid: string, packet: Uint8Array): void;
    emitLeft(uuid: string): void;
    emitLaneLeave(uuid: string): void;
    subscriptions(): number;
  } = {
    onVideo: (h) => {
      video.add(h);
      return () => video.delete(h);
    },
    onActorLeft: (h) => {
      left.add(h);
      return () => left.delete(h);
    },
    onLaneLeave: (h) => {
      lane.add(h);
      return () => lane.delete(h);
    },
    selfUuid: () => 'self-uuid',
    selfChunk: () => ({ x: '0', y: '0', z: '0' }),
    appId: () => '1',
    sendVideoFrame: vi.fn(async () => 1),
    log: vi.fn(),
    emitVideo: (uuid, packet) => {
      for (const h of video) h({ uuid, videoData: encodeBase64(packet) });
    },
    emitLeft: (uuid) => {
      for (const h of left) h({ uuid });
    },
    emitLaneLeave: (uuid) => {
      for (const h of lane) h(uuid);
    },
    subscriptions: () => video.size + left.size + lane.size,
  };
  return transport;
}

function fakeBitmap(): ImageBitmap {
  return { width: 128, height: 96, close: vi.fn() } as unknown as ImageBitmap;
}

// Decoding is awaited inside `ingest`; drain the microtask queue (fake timers
// are on, so a setTimeout-based flush would hang).
const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

describe('WebcamService receive path', () => {
  let now = 1_000_000;
  const clock = () => now;

  beforeEach(() => {
    now = 1_000_000;
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('delivers a fragmented frame exactly once, decoded, and never its own', async () => {
    const transport = fakeTransport();
    const decode = vi.fn(async () => fakeBitmap());
    const service = new WebcamService(transport, decode, clock);
    const frames: string[] = [];
    service.events.on('frame', ({ uuid, frameId }) => frames.push(`${uuid}:${frameId}`));
    service.listen();
    expect(transport.subscriptions()).toBe(3);

    const jpeg = new Uint8Array(3_000).fill(0xab);
    for (const packet of fragmentFrame(jpeg, 7)) transport.emitVideo('peer-a', packet);
    await flush();
    expect(frames).toEqual(['peer-a:7']);
    expect(decode).toHaveBeenCalledTimes(1);
    expect(service.isLive('peer-a')).toBe(true);
    expect(service.liveSenders()).toEqual(['peer-a']);

    // Our own fragments are echoed by the fan-out; they must not become a face.
    for (const packet of fragmentFrame(jpeg, 8)) transport.emitVideo('self-uuid', packet);
    await flush();
    expect(frames).toEqual(['peer-a:7']);
    service.dispose();
  });

  it('ends the stream at once on the server actor-left notice', async () => {
    const transport = fakeTransport();
    const service = new WebcamService(transport, async () => fakeBitmap(), clock);
    const ended: string[] = [];
    service.events.on('ended', ({ uuid }) => ended.push(uuid));
    service.listen();
    for (const packet of fragmentFrame(new Uint8Array(500).fill(1), 1))
      transport.emitVideo('peer-b', packet);
    await flush();
    expect(service.isLive('peer-b')).toBe(true);

    transport.emitLeft('peer-b');
    expect(ended).toEqual(['peer-b']);
    expect(service.isLive('peer-b')).toBe(false);
    // A second notice, or the lane reaper following up, does not fire twice.
    transport.emitLeft('peer-b');
    transport.emitLaneLeave('peer-b');
    expect(ended).toEqual(['peer-b']);
    service.dispose();
  });

  it('ends a stream whose frames stopped (fallback), via the lane reaper too', async () => {
    const transport = fakeTransport();
    const service = new WebcamService(transport, async () => fakeBitmap(), clock);
    const ended: string[] = [];
    service.events.on('ended', ({ uuid }) => ended.push(uuid));
    service.listen();
    for (const packet of fragmentFrame(new Uint8Array(500).fill(1), 1))
      transport.emitVideo('peer-c', packet);
    for (const packet of fragmentFrame(new Uint8Array(500).fill(1), 1))
      transport.emitVideo('peer-d', packet);
    await flush();

    transport.emitLaneLeave('peer-d');
    expect(ended).toEqual(['peer-d']);

    now += REMOTE_IDLE_MS + 1;
    vi.advanceTimersByTime(1_000);
    expect(ended).toEqual(['peer-d', 'peer-c']);
    service.dispose();
  });

  it('dispose ends every live stream and unsubscribes', async () => {
    const transport = fakeTransport();
    const service = new WebcamService(transport, async () => fakeBitmap(), clock);
    const ended: string[] = [];
    service.events.on('ended', ({ uuid }) => ended.push(uuid));
    service.listen();
    for (const packet of fragmentFrame(new Uint8Array(500).fill(1), 1))
      transport.emitVideo('peer-e', packet);
    await flush();
    service.dispose();
    expect(ended).toEqual(['peer-e']);
    expect(transport.subscriptions()).toBe(0);
    expect(service.isTransmitting).toBe(false);
  });

  it('drops a frame whose bytes do not decode, without ending a live stream', async () => {
    const transport = fakeTransport();
    let fail = false;
    const service = new WebcamService(
      transport,
      async () => {
        if (fail) throw new Error('bad jpeg');
        return fakeBitmap();
      },
      clock,
    );
    const frames: number[] = [];
    service.events.on('frame', ({ frameId }) => frames.push(frameId));
    service.listen();
    for (const packet of fragmentFrame(new Uint8Array(500).fill(1), 1))
      transport.emitVideo('peer-f', packet);
    await flush();
    fail = true;
    for (const packet of fragmentFrame(new Uint8Array(500).fill(2), 2))
      transport.emitVideo('peer-f', packet);
    await flush();
    expect(frames).toEqual([1]);
    expect(service.isLive('peer-f')).toBe(true);
    expect(transport.log).toHaveBeenCalledWith(expect.stringContaining('did not decode'));
    service.dispose();
  });
});
