/**
 * Render CLIENT `overlay_draw` primitives in the holodeck.
 * @deprecated Use InstanceLayer — overlay and replicated instances share it.
 */
export {
  InstanceLayer,
  InstanceLayer as OverlayLayer,
} from '@/scenes/holodeck-three/instanceLayer';
