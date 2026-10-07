/**
 * G.711 µ-law — the codec BWF and this starter send over `udp.sendAudioPacket`.
 * The platform never looks inside `audioData`; this is a client convention.
 */

const MU_BIAS = 0x84;
const MU_CLIP = 32635;

export function muLawEncode(sample: number): number {
  let value = Math.max(-1, Math.min(1, sample)) * 32767;
  const sign = value < 0 ? 0x80 : 0;
  value = Math.abs(value);
  if (value > MU_CLIP) value = MU_CLIP;
  value += MU_BIAS;
  let exponent = 7;
  for (let mask = 0x4000; (value & mask) === 0 && exponent > 0; mask >>= 1) exponent--;
  const mantissa = (value >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

export function muLawDecode(byte: number): number {
  const inverted = ~byte & 0xff;
  const sign = inverted & 0x80;
  const exponent = (inverted >> 4) & 0x07;
  const mantissa = inverted & 0x0f;
  let value = ((mantissa << 3) + MU_BIAS) << exponent;
  value -= MU_BIAS;
  return (sign ? -value : value) / 32767;
}

export function encodeSamples(samples: Float32Array): Uint8Array {
  const encoded = new Uint8Array(samples.length);
  for (let i = 0; i < samples.length; i++) encoded[i] = muLawEncode(samples[i] ?? 0);
  return encoded;
}

export function decodeSamples(bytes: Uint8Array): Float32Array {
  const samples = new Float32Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) samples[i] = muLawDecode(bytes[i]!);
  return samples;
}

/** Drop duplicate / stale 8-bit sequence numbers; a long gap starts a new utterance. */
export function acceptVoiceSequence(
  lastSequence: number,
  sequence: number,
  gapMs: number,
  resetAfterMs: number,
): { accept: boolean; nextSequence: number } {
  if (gapMs > resetAfterMs) lastSequence = -1;
  if (sequence >= 0 && lastSequence >= 0) {
    const advance = (sequence - lastSequence + 256) % 256;
    if (advance === 0 || advance > 128) return { accept: false, nextSequence: lastSequence };
  }
  return { accept: true, nextSequence: sequence >= 0 ? sequence : lastSequence };
}
