/** Lasers inside the range chunk. A hit asks Buddy to fly that pilot out. */

export const LASER_SPEED = 46;
export const LASER_LIFE_S = 1.15;
export const HULL_HIT_RADIUS = 1.55;

export interface LaserPoint {
  x: number;
  y: number;
  z: number;
}

export function laserPoint(
  origin: LaserPoint,
  direction: LaserPoint,
  ageSeconds: number,
  speed: number = LASER_SPEED,
): LaserPoint {
  return {
    x: origin.x + direction.x * speed * ageSeconds,
    y: origin.y + direction.y * speed * ageSeconds,
    z: origin.z + direction.z * speed * ageSeconds,
  };
}

export function hullHit(
  shot: LaserPoint,
  target: LaserPoint,
  radius: number = HULL_HIT_RADIUS,
): boolean {
  const dx = shot.x - target.x;
  const dy = shot.y - target.y;
  const dz = shot.z - target.z;
  return dx * dx + dy * dy + dz * dz <= radius * radius;
}

/** True when the laser's travel this frame passes through the hull, not only its tip. */
export function hullHitSegment(
  from: LaserPoint,
  to: LaserPoint,
  target: LaserPoint,
  radius: number = HULL_HIT_RADIUS,
): boolean {
  const abx = to.x - from.x;
  const aby = to.y - from.y;
  const abz = to.z - from.z;
  const lengthSq = abx * abx + aby * aby + abz * abz;
  if (lengthSq < 1e-8) return hullHit(to, target, radius);
  const t = Math.max(
    0,
    Math.min(
      1,
      ((target.x - from.x) * abx + (target.y - from.y) * aby + (target.z - from.z) * abz) /
        lengthSq,
    ),
  );
  return hullHit(
    { x: from.x + abx * t, y: from.y + aby * t, z: from.z + abz * t },
    target,
    radius,
  );
}
