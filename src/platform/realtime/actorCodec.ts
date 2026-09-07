/**
 * The Construct's replication state: what every player broadcasts about
 * itself a few times a second, and what every scene renders for everyone else.
 *
 * Declared ONCE as a binary struct (spatial packets have a ~1.1 KB budget, so
 * poses never travel as JSON). Both scenes consume the same `Pose`; the
 * `program` byte says which scene the actor is standing in so the holodeck can
 * show who is "inside a program" and the program can hide people who are not.
 *
 * Layout (little-endian, 64 bytes):
 *   0-11  position xyz  f32
 *   12-15 yaw           f32
 *   16-19 pitch         f32
 *   20-31 velocity xyz  f32
 *   32    flags         u8   (bit0 moving, bit1 in-program, bit2 studio-open)
 *   33    program       u8   (0 = holodeck, 1.. = program id)
 *   34    tint          u8   (avatar colour index)
 *   35    reserved      u8
 *   36-59 name          24 bytes UTF-8, NUL padded
 *   60-63 reserved
 */
import { bytes, f32, reserved, structCodec, u8, type StateCodec } from '@crowdedkingdoms/crowdyjs/stores';

export const FLAG_MOVING = 1 << 0;
export const FLAG_IN_PROGRAM = 1 << 1;
export const FLAG_STUDIO_OPEN = 1 << 2;

export const NAME_BYTES = 24;

export interface Pose {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  vx: number;
  vy: number;
  vz: number;
  flags: number;
  program: number;
  tint: number;
  name: string;
}

export const NEUTRAL_POSE: Pose = {
  x: 0,
  y: 0,
  z: 0,
  yaw: 0,
  pitch: 0,
  vx: 0,
  vy: 0,
  vz: 0,
  flags: 0,
  program: 0,
  tint: 0,
  name: '',
};

const wire = structCodec({
  x: f32(),
  y: f32(),
  z: f32(),
  yaw: f32(),
  pitch: f32(),
  vx: f32(),
  vy: f32(),
  vz: f32(),
  flags: u8(),
  program: u8(),
  tint: u8(),
  pad0: reserved(1),
  name: bytes(NAME_BYTES),
  pad1: reserved(4),
});

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function encodeName(name: string, length: number = NAME_BYTES): Uint8Array {
  const out = new Uint8Array(length);
  // Trim by bytes, never splitting a multi-byte sequence: encode progressively.
  let cut = name;
  let encoded = encoder.encode(cut);
  while (encoded.length > length && cut.length > 0) {
    cut = cut.slice(0, -1);
    encoded = encoder.encode(cut);
  }
  out.set(encoded.subarray(0, length));
  return out;
}

export function decodeName(raw: Uint8Array): string {
  let end = raw.indexOf(0);
  if (end < 0) end = raw.length;
  return decoder.decode(raw.subarray(0, end));
}

/** The typed codec World Stores use for `self` and `actors`. */
export const poseCodec: StateCodec<Pose> = {
  encode: (pose) =>
    wire.encode({
      x: pose.x,
      y: pose.y,
      z: pose.z,
      yaw: pose.yaw,
      pitch: pose.pitch,
      vx: pose.vx,
      vy: pose.vy,
      vz: pose.vz,
      flags: pose.flags & 0xff,
      program: pose.program & 0xff,
      tint: pose.tint & 0xff,
      name: encodeName(pose.name),
    }),
  decode: (data) => {
    const raw = wire.decode(data);
    return {
      x: raw.x,
      y: raw.y,
      z: raw.z,
      yaw: raw.yaw,
      pitch: raw.pitch,
      vx: raw.vx,
      vy: raw.vy,
      vz: raw.vz,
      flags: raw.flags,
      program: raw.program,
      tint: raw.tint,
      name: decodeName(raw.name),
    };
  },
};

export const POSE_BYTES: number = wire.byteLength;
