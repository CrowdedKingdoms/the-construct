/**
 * Turn a remote player's sample history into a smooth display pose.
 *
 * Presence arrives at ~5 Hz; frames render at 60. Rendering the newest sample
 * directly makes everyone teleport five times a second. The standard fix is
 * to render slightly in the past: interpolate between the two newest samples
 * as if the clock were `RENDER_DELAY_MS` behind, and when the newest sample is
 * older than that, extrapolate along its velocity for a bounded time. Both
 * scenes use this; it is renderer-agnostic on purpose.
 */
import type { Pose } from '@/platform/realtime/actorCodec';
import type { RemotePlayer } from '@/platform/realtime/WorldStores';

export const RENDER_DELAY_MS = 220;
const MAX_EXTRAPOLATION_MS = 400;

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function lerpAngle(a: number, b: number, t: number): number {
  let delta = b - a;
  while (delta > Math.PI) delta -= Math.PI * 2;
  while (delta < -Math.PI) delta += Math.PI * 2;
  return a + delta * t;
}

export function displayPose(player: RemotePlayer, nowMs: number): Pose {
  const samples = player.samples;
  const newest = samples[0];
  if (!newest) return player.pose;
  const renderAt = nowMs - RENDER_DELAY_MS;
  const older = samples[1];

  if (older && renderAt <= newest.receivedAt && newest.receivedAt !== older.receivedAt) {
    const t = Math.max(0, Math.min(1, (renderAt - older.receivedAt) / (newest.receivedAt - older.receivedAt)));
    return {
      ...newest.pose,
      x: lerp(older.pose.x, newest.pose.x, t),
      y: lerp(older.pose.y, newest.pose.y, t),
      z: lerp(older.pose.z, newest.pose.z, t),
      yaw: lerpAngle(older.pose.yaw, newest.pose.yaw, t),
      pitch: lerp(older.pose.pitch, newest.pose.pitch, t),
    };
  }

  const ahead = Math.min(MAX_EXTRAPOLATION_MS, Math.max(0, renderAt - newest.receivedAt)) / 1000;
  return {
    ...newest.pose,
    x: newest.pose.x + newest.pose.vx * ahead,
    y: newest.pose.y + newest.pose.vy * ahead,
    z: newest.pose.z + newest.pose.vz * ahead,
  };
}

/** Avatar palette shared by both renderers so a player looks the same everywhere. */
export const TINT_COLORS: readonly number[] = [
  0x5ef2c8, 0xff7ac8, 0x7ab8ff, 0xffd166, 0xc084fc, 0xff8f6b, 0x9ff27a, 0x6be5ff,
];

export function tintColor(tint: number): number {
  return TINT_COLORS[((tint % TINT_COLORS.length) + TINT_COLORS.length) % TINT_COLORS.length] ?? TINT_COLORS[0]!;
}

export function hexColor(color: number): string {
  return `#${color.toString(16).padStart(6, '0')}`;
}
