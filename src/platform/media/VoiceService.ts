/**
 * Proximity voice over the realtime plane — same transport shape as WebcamService.
 *
 * Capture: mic → AudioWorklet (ScriptProcessor fallback) → 8 kHz mono →
 * G.711 µ-law → 60 ms frames → `udp.sendAudioPacket`. Playback: sequence
 * check, then a pluggable sink (Web Audio in the browser; a recorder in tests).
 *
 * Permission: `use_voice_chat`. One UNAUTHORIZED toast, then stop.
 */
import { Emitter } from '@/platform/util/Emitter';
import { acceptVoiceSequence, decodeSamples, encodeSamples } from '@/platform/media/mulaw';

export interface VoiceEvents {
  /** Local capture state changed (HUD toggle). */
  local: { live: boolean; error: string | null };
}

export const CAPTURE_RATE = 8000;
export const FRAME_MS = 60;
export const FRAME_SAMPLES = (CAPTURE_RATE * FRAME_MS) / 1000;
export const VOICE_DISTANCE = 1;
export const SEQUENCE_RESET_MS = 1_500;

export interface VoiceTransport {
  onAudio(
    handler: (n: { uuid: string; audioData: string; sequenceNumber?: number }) => void,
  ): () => void;
  onActorLeft(handler: (n: { uuid: string }) => void): () => void;
  onLaneLeave(handler: (uuid: string) => void): () => void;
  selfUuid(): string | null;
  selfChunk(): { x: string; y: string; z: string } | null;
  selfPosition(): { x: number; y: number; z: number } | null;
  remotePositions(): Array<{ uuid: string; x: number; y: number; z: number }>;
  appId(): string;
  sendAudioPacket(input: {
    appId: string;
    chunk: { x: string; y: string; z: string };
    uuid: string;
    audioData: string;
    distance: number;
    sequenceNumber: number;
  }): Promise<boolean>;
  log(message: string): void;
}

export interface VoicePlayback {
  play(uuid: string, samples: Float32Array, sampleRate: number, gain: number, pan: number): void;
  forget(uuid: string): void;
  dispose(): void;
  resume(): Promise<void>;
}

const CAPTURE_WORKLET = `
class CrowdyVoiceCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(2048);
    this.length = 0;
  }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;
    let offset = 0;
    while (offset < channel.length) {
      const take = Math.min(channel.length - offset, this.buffer.length - this.length);
      this.buffer.set(channel.subarray(offset, offset + take), this.length);
      this.length += take;
      offset += take;
      if (this.length === this.buffer.length) {
        const out = this.buffer.slice(0);
        this.port.postMessage(out, [out.buffer]);
        this.length = 0;
      }
    }
    return true;
  }
}
registerProcessor("crowdy-voice-capture", CrowdyVoiceCapture);
`;

export class RecordingPlayback implements VoicePlayback {
  readonly played: Array<{ uuid: string; samples: Float32Array; gain: number; pan: number }> = [];
  readonly forgotten: string[] = [];

  play(uuid: string, samples: Float32Array, _rate: number, gain: number, pan: number): void {
    this.played.push({ uuid, samples, gain, pan });
  }
  forget(uuid: string): void {
    this.forgotten.push(uuid);
  }
  dispose(): void {}
  async resume(): Promise<void> {}
}

export class WebAudioPlayback implements VoicePlayback {
  private context: AudioContext | null = null;
  private readonly speakers = new Map<
    string,
    { nextAt: number; panner: StereoPannerNode; gain: GainNode }
  >();

  private ensure(): AudioContext {
    this.context ??= new AudioContext({ latencyHint: 'interactive' });
    return this.context;
  }

  async resume(): Promise<void> {
    const ctx = this.ensure();
    if (ctx.state === 'suspended') await ctx.resume();
  }

  play(
    uuid: string,
    samples: Float32Array,
    sampleRate: number,
    gainValue: number,
    pan: number,
  ): void {
    const ctx = this.ensure();
    if (ctx.state === 'suspended') void ctx.resume();
    let speaker = this.speakers.get(uuid);
    if (!speaker) {
      const panner = ctx.createStereoPanner();
      const gain = ctx.createGain();
      panner.connect(gain).connect(ctx.destination);
      speaker = { nextAt: ctx.currentTime, panner, gain };
      this.speakers.set(uuid, speaker);
    }
    speaker.gain.gain.setTargetAtTime(gainValue, ctx.currentTime, 0.05);
    speaker.panner.pan.setTargetAtTime(pan, ctx.currentTime, 0.05);
    const buffer = ctx.createBuffer(1, samples.length, sampleRate);
    buffer.getChannelData(0).set(samples);
    const startAt = Math.max(ctx.currentTime + 0.06, speaker.nextAt);
    if (startAt - ctx.currentTime > 0.25) return;
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(speaker.panner);
    source.start(startAt);
    speaker.nextAt = startAt + buffer.duration;
  }

  forget(uuid: string): void {
    const speaker = this.speakers.get(uuid);
    if (!speaker) return;
    this.speakers.delete(uuid);
    speaker.panner.disconnect();
    speaker.gain.disconnect();
  }

  dispose(): void {
    for (const uuid of [...this.speakers.keys()]) this.forget(uuid);
    void this.context?.close();
    this.context = null;
  }
}

export class VoiceService {
  readonly events = new Emitter<VoiceEvents>();
  framesSent = 0;

  private readonly playback: VoicePlayback;
  private readonly lastSequence = new Map<string, { seq: number; at: number }>();
  private unsubscribes: Array<() => void> = [];
  private stream: MediaStream | null = null;
  private audioContext: AudioContext | null = null;
  private captureNode: AudioWorkletNode | ScriptProcessorNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private transmitting = false;
  private errorValue: string | null = null;
  private refusedOnce = false;
  private sendSequence = 0;
  private decimAcc = 0;
  private decimCount = 0;
  private decimPhase = 0;
  private frame = new Float32Array(FRAME_SAMPLES);
  private frameLength = 0;

  constructor(
    private readonly transport: VoiceTransport,
    options: { playback?: VoicePlayback; now?: () => number } = {},
  ) {
    this.playback = options.playback ?? new WebAudioPlayback();
    this.now = options.now ?? (() => Date.now());
  }

  private readonly now: () => number;

  listen(): void {
    if (this.unsubscribes.length > 0) return;
    this.unsubscribes.push(
      this.transport.onAudio((n) => this.ingest(n.uuid, n.audioData, n.sequenceNumber ?? -1)),
      this.transport.onActorLeft((n) => this.end(n.uuid)),
      this.transport.onLaneLeave((uuid) => this.end(uuid)),
    );
  }

  get isTransmitting(): boolean {
    return this.transmitting;
  }

  get error(): string | null {
    return this.errorValue;
  }

  async toggle(): Promise<void> {
    if (this.transmitting) this.stop();
    else await this.start();
  }

  async start(): Promise<void> {
    if (this.transmitting) return;
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      this.fail('This browser has no microphone access');
      return;
    }
    try {
      this.audioContext ??= new AudioContext({ latencyHint: 'interactive' });
      if (this.audioContext.state === 'suspended') await this.audioContext.resume();
      this.stream ??= await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
      });
      this.source ??= this.audioContext.createMediaStreamSource(this.stream);
      if (!this.captureNode) {
        this.captureNode = await this.createCaptureNode(this.audioContext, this.source);
      }
      this.resetCaptureState();
      this.transmitting = true;
      this.errorValue = null;
      this.refusedOnce = false;
      this.events.emit('local', { live: true, error: null });
    } catch (error) {
      this.fail(`Microphone unavailable: ${messageOf(error)}`);
    }
  }

  stop(): void {
    this.transmitting = false;
    this.resetCaptureState();
    this.events.emit('local', { live: false, error: this.errorValue });
  }

  private async createCaptureNode(
    context: AudioContext,
    source: MediaStreamAudioSourceNode,
  ): Promise<AudioWorkletNode | ScriptProcessorNode> {
    const silent = context.createGain();
    silent.gain.value = 0;
    if (context.audioWorklet && typeof AudioWorkletNode !== 'undefined') {
      const url = URL.createObjectURL(
        new Blob([CAPTURE_WORKLET], { type: 'application/javascript' }),
      );
      try {
        await context.audioWorklet.addModule(url);
        const node = new AudioWorkletNode(context, 'crowdy-voice-capture', {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          channelCount: 1,
        });
        node.port.onmessage = (event: MessageEvent<Float32Array>) => this.ingestCapture(event.data);
        source.connect(node);
        node.connect(silent).connect(context.destination);
        return node;
      } catch (error) {
        this.transport.log(`AudioWorklet unavailable, falling back: ${messageOf(error)}`);
      } finally {
        URL.revokeObjectURL(url);
      }
    }
    const processor = context.createScriptProcessor(2048, 1, 1);
    processor.onaudioprocess = (event) => this.ingestCapture(event.inputBuffer.getChannelData(0));
    source.connect(processor);
    processor.connect(silent).connect(context.destination);
    return processor;
  }

  private resetCaptureState(): void {
    this.decimAcc = 0;
    this.decimCount = 0;
    this.decimPhase = 0;
    this.frameLength = 0;
  }

  private ingestCapture(input: Float32Array): void {
    if (!this.transmitting || !this.audioContext) return;
    const ratio = this.audioContext.sampleRate / CAPTURE_RATE;
    for (let i = 0; i < input.length; i++) {
      this.decimAcc += input[i] ?? 0;
      this.decimCount++;
      this.decimPhase += 1;
      if (this.decimPhase >= ratio) {
        this.decimPhase -= ratio;
        this.frame[this.frameLength++] = this.decimAcc / this.decimCount;
        this.decimAcc = 0;
        this.decimCount = 0;
        if (this.frameLength === FRAME_SAMPLES) {
          const samples = this.frame;
          this.frame = new Float32Array(FRAME_SAMPLES);
          this.frameLength = 0;
          void this.sendFrame(samples);
        }
      }
    }
  }

  private async sendFrame(samples: Float32Array): Promise<void> {
    const chunk = this.transport.selfChunk();
    const uuid = this.transport.selfUuid();
    if (!chunk || !uuid) return;
    const encoded = encodeSamples(samples);
    this.sendSequence = (this.sendSequence + 1) & 0xff;
    try {
      await this.transport.sendAudioPacket({
        appId: this.transport.appId(),
        chunk,
        uuid,
        audioData: bytesToBase64(encoded),
        distance: VOICE_DISTANCE,
        sequenceNumber: this.sendSequence,
      });
      this.framesSent += 1;
    } catch (error) {
      const message = messageOf(error);
      if (/UNAUTHORIZED|permission/i.test(message)) {
        if (!this.refusedOnce) {
          this.refusedOnce = true;
          this.fail('Mic refused: this app does not grant use_voice_chat here');
          this.stop();
        }
      } else {
        this.transport.log(`audio send failed: ${message}`);
      }
    }
  }

  private ingest(uuid: string, audioData: string, sequence: number): void {
    if (uuid === this.transport.selfUuid()) return;
    const prev = this.lastSequence.get(uuid);
    const decision = acceptVoiceSequence(
      prev?.seq ?? -1,
      sequence,
      prev ? this.now() - prev.at : SEQUENCE_RESET_MS + 1,
      SEQUENCE_RESET_MS,
    );
    if (!decision.accept) return;
    this.lastSequence.set(uuid, { seq: decision.nextSequence, at: this.now() });
    let bytes: Uint8Array;
    try {
      bytes = base64ToBytes(audioData);
    } catch {
      return;
    }
    const samples = decodeSamples(bytes);
    const me = this.transport.selfPosition();
    const other = this.transport.remotePositions().find((p) => p.uuid === uuid);
    let gain = 0.9;
    let pan = 0;
    if (me && other) {
      const dx = other.x - me.x;
      const dz = other.z - me.z;
      const distance = Math.hypot(dx, dz);
      gain = Math.max(0.05, Math.min(0.9, 1.2 - distance / 24));
      pan = Math.max(-0.8, Math.min(0.8, dx / 14));
    }
    void this.playback.resume();
    this.playback.play(uuid, samples, CAPTURE_RATE, gain, pan);
  }

  private end(uuid: string): void {
    this.lastSequence.delete(uuid);
    this.playback.forget(uuid);
  }

  private fail(message: string): void {
    this.errorValue = message;
    this.transport.log(message);
    this.events.emit('local', { live: false, error: message });
  }

  dispose(): void {
    this.stop();
    for (const unsubscribe of this.unsubscribes) unsubscribe();
    this.unsubscribes = [];
    this.captureNode?.disconnect();
    this.captureNode = null;
    this.source?.disconnect();
    this.source = null;
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.stream = null;
    void this.audioContext?.close();
    this.audioContext = null;
    for (const uuid of [...this.lastSequence.keys()]) this.end(uuid);
    this.playback.dispose();
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x2000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK) as unknown as number[]);
  }
  return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
