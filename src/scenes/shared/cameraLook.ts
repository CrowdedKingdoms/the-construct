/**
 * Pointer-look, zoom, and ground-plane WASD math used by the holodeck
 * (unit-tested so a sign flip cannot sneak back in). No renderer types
 * on purpose.
 */

export const LOOK_PITCH_MIN = -1.2;
export const LOOK_PITCH_MAX = 0.6;
export const LOOK_SENSITIVITY = 0.0022;
export const HOLODECK_ZOOM_MIN = 2.5;
export const HOLODECK_ZOOM_MAX = 14;
export const HOLODECK_CAMERA_HEIGHT = 3;
export const DEFAULT_CAMERA_DISTANCE = 6.5;
/** Wheel factor: negative deltaY (scroll up) zooms in. */
export const ZOOM_WHEEL_FACTOR = 0.0016;
export const PAINT_CELL_MIN = 12;
export const PAINT_CELL_MAX = 64;
export const PAINT_CELL_DEFAULT = 28;

export function applyLook(
  yaw: number,
  pitch: number,
  dx: number,
  dy: number,
  sensitivity = LOOK_SENSITIVITY,
  pitchMin = LOOK_PITCH_MIN,
  pitchMax = LOOK_PITCH_MAX,
): { yaw: number; pitch: number } {
  return {
    yaw: yaw - dx * sensitivity,
    pitch: Math.max(pitchMin, Math.min(pitchMax, pitch - dy * sensitivity)),
  };
}

/** Third-person offset: camera sits behind the avatar and looks at eye height. */
export function followCameraOffset(
  yaw: number,
  pitch: number,
  distance: number,
  height = HOLODECK_CAMERA_HEIGHT,
): { x: number; y: number; z: number } {
  const horizontal = distance * Math.cos(pitch);
  return {
    x: Math.sin(yaw) * horizontal,
    y: height - Math.sin(pitch) * distance,
    z: Math.cos(yaw) * horizontal,
  };
}

/** Wheel up (negative deltaY) reduces distance / cell size — zoom in. */
export function zoomDistance(
  distance: number,
  wheelY: number,
  min: number,
  max: number,
  factor = ZOOM_WHEEL_FACTOR,
): number {
  const next = distance * (1 + wheelY * factor);
  return Math.max(min, Math.min(max, next));
}

/**
 * Ground-plane facing and camera-right for WASD.
 *
 * At yaw 0 the follow camera sits on +Z looking toward −Z, so +X is
 * screen-right. The right vector is the right-handed perpendicular
 * `(−forward.z, forward.x)`. `(forward.z, −forward.x)` is left — that
 * was the holodeck bug (A walked right, D left).
 */
export function moveBasis(yaw: number): {
  forward: { x: number; z: number };
  right: { x: number; z: number };
} {
  const forward = { x: -Math.sin(yaw), z: -Math.cos(yaw) };
  return {
    forward,
    right: { x: -forward.z, z: forward.x },
  };
}

/**
 * Unit wish on the ground from WASD axes (`x` = strafe, `y` = forward).
 * Zero input stays zero.
 */
export function wishOnGround(
  yaw: number,
  axes: { x: number; y: number },
): { x: number; z: number } {
  const { forward, right } = moveBasis(yaw);
  const x = forward.x * axes.y + right.x * axes.x;
  const z = forward.z * axes.y + right.z * axes.x;
  const length = Math.hypot(x, z);
  if (length === 0) return { x: 0, z: 0 };
  return { x: x / length, z: z / length };
}

/** Screen-pixel drag → world-unit pan. Dragging right moves the view right. */
export function panOffset(
  offsetX: number,
  offsetZ: number,
  dx: number,
  dy: number,
  cellPx: number,
): { x: number; z: number } {
  if (cellPx === 0) return { x: offsetX, z: offsetZ };
  return { x: offsetX - dx / cellPx, z: offsetZ - dy / cellPx };
}
