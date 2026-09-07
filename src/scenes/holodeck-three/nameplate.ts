import * as THREE from 'three';

import { hexColor } from '@/scenes/shared/interpolate';

/** A canvas-textured sprite with the player's name, tinted to their colour. */
export function makeNameplate(name: string, color: number): THREE.Sprite {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.fillStyle = 'rgba(7, 9, 13, 0.72)';
    roundRect(ctx, 8, 8, 240, 48, 10);
    ctx.fill();
    ctx.strokeStyle = hexColor(color);
    ctx.lineWidth = 3;
    roundRect(ctx, 8, 8, 240, 48, 10);
    ctx.stroke();
    ctx.fillStyle = '#e9f5f1';
    ctx.font = '600 26px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(name.slice(0, 18), 128, 33);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(2, 0.5, 1);
  return sprite;
}

export function disposeNameplate(sprite: THREE.Sprite): void {
  const material = sprite.material as THREE.SpriteMaterial;
  material.map?.dispose();
  material.dispose();
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
