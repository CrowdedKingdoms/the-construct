/**
 * Proximity text chat over the realtime plane.
 *
 * A text packet is addressed to the sender's chunk and fanned out within
 * `distance` chunks — the same spatial delivery as poses, which is why chat
 * "just works" in whichever scene the player is standing in. Names are not on
 * the wire: the receiver looks the sender's uuid up in the players lane.
 */
import { REPLICATION_DISTANCE } from '@/platform/config';
import { NetworkManager } from '@/platform/network/NetworkManager';
import { chunkInput, type ChunkCoord } from '@/platform/realtime/space';
import { remotePlayers, worldSession } from '@/platform/realtime/WorldStores';
import { Emitter } from '@/platform/util/Emitter';

export interface ChatMessage {
  id: number;
  uuid: string;
  name: string;
  text: string;
  at: number;
  self: boolean;
}

export const MAX_CHAT_TEXT = 240;

export class ChatService {
  readonly events = new Emitter<{ message: ChatMessage }>();
  private readonly history: ChatMessage[] = [];
  private nextId = 1;
  private sequence = 0;
  private unsubscribe: (() => void) | null = null;

  constructor(private readonly network: NetworkManager = NetworkManager.instance) {}

  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.network.on('text', (n) => {
      const session = worldSession();
      const self = n.uuid === session.self.uuid;
      const name = self
        ? session.self.state.name || 'you'
        : remotePlayers().find((p) => p.uuid === n.uuid)?.pose.name || shortUuid(n.uuid);
      this.push({ uuid: n.uuid, name, text: n.text, self });
    });
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  messages(): readonly ChatMessage[] {
    return this.history;
  }

  /** Send from the chunk the local actor currently stands in. */
  async send(text: string, chunk?: ChunkCoord): Promise<void> {
    const trimmed = text.trim().slice(0, MAX_CHAT_TEXT);
    if (!trimmed) return;
    const session = worldSession();
    const at = chunk ? chunkInput(chunk) : session.self.chunk;
    if (!at) throw new Error('Join the world before chatting');
    this.sequence = (this.sequence + 1) % 256;
    await this.network.game.udp.sendTextPacket({
      appId: this.network.appId!,
      chunk: at,
      uuid: session.self.uuid,
      text: trimmed,
      sequenceNumber: this.sequence,
      distance: REPLICATION_DISTANCE,
    });
    // The platform echoes our own text back as a notification, which is what
    // appends it to history — no optimistic insert, so what you see is what
    // everyone else saw.
  }

  /** Local-only line (system notices), never sent. */
  system(text: string): void {
    this.push({ uuid: '', name: 'construct', text, self: false });
  }

  private push(entry: Omit<ChatMessage, 'id' | 'at'>): void {
    const message: ChatMessage = { id: this.nextId++, at: Date.now(), ...entry };
    this.history.push(message);
    if (this.history.length > 200) this.history.shift();
    this.events.emit('message', message);
  }
}

function shortUuid(uuid: string): string {
  return `player-${uuid.slice(0, 6)}`;
}
