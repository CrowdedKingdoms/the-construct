/**
 * Agent Play locomotion, consumed by scenes the same way they consume WASD.
 * StudioService writes wishes; HolodeckScene samples them each frame.
 * Human input (the control gate) calls `clear`.
 */
export interface AgentMoveWish {
  readonly direction: 'FORWARD' | 'BACKWARD' | 'LEFT' | 'RIGHT' | 'UP' | 'DOWN';
  readonly intensity: number;
  readonly untilMs: number;
}

export interface AgentLookWish {
  readonly yawDelta: number;
  readonly pitchDelta: number;
}

export interface AgentLocomotionSample {
  /** Camera-relative axes, same convention as `Input.axes()` (−1..1). */
  readonly x: number;
  readonly y: number;
  /** Radians to add this frame (already converted from the LOOK command). */
  readonly yaw: number;
  readonly pitch: number;
}

const DEG_TO_RAD = Math.PI / 180;

export class AgentLocomotion {
  private move: AgentMoveWish | null = null;
  private look: AgentLookWish | null = null;

  applyMove(input: {
    direction: AgentMoveWish['direction'];
    intensity: number;
    durationMs: number;
    nowMs: number;
  }): void {
    const intensity = clamp01(input.intensity);
    const durationMs = Math.max(16, Math.min(2_000, input.durationMs));
    this.move = {
      direction: input.direction,
      intensity,
      untilMs: input.nowMs + durationMs,
    };
  }

  applyLook(input: { deltaYaw: number; deltaPitch: number }): void {
    this.look = {
      yawDelta: finite(input.deltaYaw) * DEG_TO_RAD,
      pitchDelta: finite(input.deltaPitch) * DEG_TO_RAD,
    };
  }

  clear(): void {
    this.move = null;
    this.look = null;
  }

  sample(nowMs: number): AgentLocomotionSample {
    let x = 0;
    let y = 0;
    if (this.move && nowMs < this.move.untilMs) {
      const i = this.move.intensity;
      switch (this.move.direction) {
        case 'FORWARD':
          y = i;
          break;
        case 'BACKWARD':
          y = -i;
          break;
        case 'RIGHT':
          x = i;
          break;
        case 'LEFT':
          x = -i;
          break;
        default:
          break;
      }
    } else {
      this.move = null;
    }
    const yaw = this.look?.yawDelta ?? 0;
    const pitch = this.look?.pitchDelta ?? 0;
    this.look = null;
    return { x, y, yaw, pitch };
  }
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function finite(value: number): number {
  return Number.isFinite(value) ? value : 0;
}
