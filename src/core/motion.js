export const MOTION_MS = Object.freeze({ toggle: 280, resize: 180 });

// Interpolar bordes físicos conserva exactamente el lado anclado, incluso a escala fraccionaria.
export function motionRect(motion, progress) {
  const eased = progress * progress * (3 - 2 * progress);
  const edge = key => Math.round(motion.from[key] + (motion.to[key] - motion.from[key]) * eased);
  const x = edge('x');
  const y = edge('y');
  return { x, y, width: edge('right') - x, height: edge('bottom') - y };
}
