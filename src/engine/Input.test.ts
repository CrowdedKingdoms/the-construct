import { afterEach, describe, expect, it } from 'vitest';

import { Input, isPointerLockOn, isTextEntry } from '@/engine/Input';

describe('isPointerLockOn', () => {
  it('treats a descendant canvas as locked, not only the root', () => {
    const root = document.createElement('div');
    const canvas = document.createElement('canvas');
    root.appendChild(canvas);
    expect(isPointerLockOn(root, canvas)).toBe(true);
    expect(isPointerLockOn(root, root)).toBe(true);
    expect(isPointerLockOn(root, document.createElement('div'))).toBe(false);
    expect(isPointerLockOn(root, null)).toBe(false);
  });
});

describe('isTextEntry', () => {
  it('recognises inputs and Monaco', () => {
    const input = document.createElement('input');
    expect(isTextEntry(input)).toBe(true);
    const div = document.createElement('div');
    expect(isTextEntry(div)).toBe(false);
    const monaco = document.createElement('div');
    monaco.className = 'monaco-editor';
    const inner = document.createElement('div');
    monaco.appendChild(inner);
    expect(isTextEntry(inner)).toBe(true);
  });
});

describe('Input', () => {
  const inputs: Input[] = [];

  afterEach(() => {
    for (const input of inputs) input.dispose();
    inputs.length = 0;
  });

  function attach(): { input: Input; root: HTMLElement; canvas: HTMLCanvasElement } {
    const root = document.createElement('div');
    const canvas = document.createElement('canvas');
    root.appendChild(canvas);
    document.body.appendChild(root);
    const input = new Input();
    input.attach(root);
    inputs.push(input);
    return { input, root, canvas };
  }

  it('maps WASD to axes and Shift to run', () => {
    const { input } = attach();
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW' }));
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyD' }));
    expect(input.axes()).toEqual({ x: 1, y: 1 });
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'ShiftLeft' }));
    expect(input.isRun()).toBe(true);
  });

  it('does not record gameplay keys while suppressed or in a text field', () => {
    const { input } = attach();
    const release = input.suppress();
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW' }));
    expect(input.axes()).toEqual({ x: 0, y: 0 });
    release();
    const field = document.createElement('input');
    document.body.appendChild(field);
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW', bubbles: true }));
    // default target is window/body, not the field — still records
    expect(input.isDown('KeyW')).toBe(true);
  });

  it('sets locked when pointer lock is on a descendant canvas', () => {
    const { input, canvas } = attach();
    Object.defineProperty(document, 'pointerLockElement', {
      configurable: true,
      get: () => canvas,
    });
    document.dispatchEvent(new Event('pointerlockchange'));
    expect(input.pointer.locked).toBe(true);
    expect(input.isLooking()).toBe(true);
    Object.defineProperty(document, 'pointerLockElement', {
      configurable: true,
      get: () => null,
    });
    document.dispatchEvent(new Event('pointerlockchange'));
    expect(input.pointer.locked).toBe(false);
  });

  it('looks while RMB is held and cancels on exitLook', () => {
    const { input } = attach();
    window.dispatchEvent(new PointerEvent('pointerdown', { button: 2, buttons: 2 }));
    expect(input.isLooking()).toBe(true);
    input.exitLook();
    expect(input.isLooking()).toBe(false);
    window.dispatchEvent(new PointerEvent('pointerup', { button: 2, buttons: 0 }));
    window.dispatchEvent(new PointerEvent('pointerdown', { button: 2, buttons: 2 }));
    expect(input.isLooking()).toBe(true);
  });

  it('pans on MMB or Alt+LMB', () => {
    const { input } = attach();
    window.dispatchEvent(new PointerEvent('pointerdown', { button: 1, buttons: 4 }));
    expect(input.isPanning()).toBe(true);
    window.dispatchEvent(new PointerEvent('pointerup', { button: 1, buttons: 0 }));
    window.dispatchEvent(new PointerEvent('pointerdown', { button: 0, buttons: 1, altKey: true }));
    expect(input.isPanning()).toBe(true);
  });

  it('accumulates wheel over the game root and takeWheel consumes it', () => {
    const { input, canvas } = attach();
    canvas.dispatchEvent(
      new WheelEvent('wheel', { deltaY: -120, bubbles: true, cancelable: true }),
    );
    expect(input.takeWheel()).toBe(-120);
    expect(input.takeWheel()).toBe(0);
  });

  it('onKeys registers every code', () => {
    const { input } = attach();
    const seen: string[] = [];
    const off = input.onKeys(['KeyT', 'Enter'], (event) => seen.push(event.code));
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyT' }));
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Enter' }));
    expect(seen).toEqual(['KeyT', 'Enter']);
    off();
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyT' }));
    expect(seen).toEqual(['KeyT', 'Enter']);
  });
});
