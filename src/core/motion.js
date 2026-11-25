export const MOTION_MS = Object.freeze({ open: 360, close: 280, resize: 180 });

const smooth = p => p * p * (3 - 2 * p);
// Quíntica sin velocidad al empezar ni al terminar: cruza el destino hacia el 72 % del tiempo, se pasa
// un 3 % en el 82 % y se asienta. Su velocidad máxima es 2.05 veces la media; a 360 ms queda por
// debajo de 35 px por frame, como la curva suave a 280.
const spring = p => p * p * (3.924396 + p * (1.491312 + p * (-9.755811 + p * 5.340103)));

// Interpolar bordes físicos conserva exactamente el lado anclado, incluso a escala fraccionaria.
export function motionRect(motion, progress) {
  const eased = progress >= 1 ? 1 : (motion.spring ? spring : smooth)(progress);
  const edge = key => Math.round(motion.from[key] + (motion.to[key] - motion.from[key]) * eased);
  const x = edge('x');
  const y = edge('y');
  return { x, y, width: edge('right') - x, height: edge('bottom') - y };
}
