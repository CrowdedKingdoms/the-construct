/**
 * Pointer-look and zoom math used by the holodeck (and unit-tested so a
 * sign flip cannot sneak back in). No renderer types on purpose.
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
