/**
 * The one place key and mouse bindings are named. Scenes and the HUD read
 * this map; they do not invent codes. `KeyboardEvent.code` (physical keys)
 * so WASD stays WASD on an AZERTY layout.
 */
export const Controls = {
  moveForward: ['KeyW', 'ArrowUp'],
  moveBack: ['KeyS', 'ArrowDown'],
  moveLeft: ['KeyA', 'ArrowLeft'],
  moveRight: ['KeyD', 'ArrowRight'],
  run: ['ShiftLeft', 'ShiftRight'],
  activate: ['KeyE'],
  chat: ['KeyT', 'Enter', 'NumpadEnter'],
  webcam: ['KeyB'],
  voice: ['KeyV'],
  studio: ['KeyM'],
  holodeck: ['KeyH'],
  help: ['F1', 'Slash'],
  escape: ['Escape'],
} as const;

export type ControlAction = keyof typeof Controls;

export function codesFor(action: ControlAction): readonly string[] {
  return Controls[action];
}

export function isControl(action: ControlAction, code: string): boolean {
  return (Controls[action] as readonly string[]).includes(code);
}

export type HelpScene = 'holodeck' | 'paint';

/** Lines shown in the F1 / ? overlay. */
export function helpLines(scene: HelpScene): string[] {
  const shared = [
    'WASD / arrows — move',
    'Shift — run (holodeck)',
    'T or Enter — chat',
    'B — webcam',
    'V — voice',
    'M — Crowdy Studio',
    'F1 or ? — this help',
    'Escape — close help, unlock look',
  ];
  if (scene === 'paint') {
    return [
      'Click / drag — paint · right-drag — erase',
      '1–8 — colours · 0 — eraser',
      'Scroll — zoom · middle-drag or Alt+click — pan',
      'H — back to holodeck',
      ...shared,
    ];
  }
  return [
    'Click canvas — lock mouse look',
    'Hold right mouse — look (no lock)',
    'Scroll — zoom camera',
    'E — activate a pad',
    ...shared,
  ];
}
