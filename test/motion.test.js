import test from 'node:test';
import assert from 'node:assert/strict';
import { MOTION_MS, motionRect } from '../src/core/motion.js';

test('a 60 Hz los bordes físicos anclados permanecen fijos y el recorrido no supera 35 px', () => {
  for (const scale of [1, 1.25, 2]) {
    for (const horizontal of ['left', 'right']) {
      for (const vertical of ['up', 'center', 'down']) {
        const from = { x: 400 * scale, y: 200 * scale, right: 442 * scale, bottom: 266 * scale };
        const dx = horizontal === 'left' ? -286 * scale : 0;
        const dy = vertical === 'up' ? -134 * scale : vertical === 'center' ? -67 * scale : 0;
        const to = { x: from.x + dx, y: from.y + dy, right: from.right + dx + 286 * scale, bottom: from.bottom + dy + 134 * scale };
        for (const [motion, duration] of [[{ from, to, spring: true }, MOTION_MS.open], [{ from: to, to: from }, MOTION_MS.close]]) {
          let previous = motionRect(motion, 0);
          for (let elapsed = 1000 / 60; elapsed < duration + 1000 / 60; elapsed += 1000 / 60) {
            const rect = motionRect(motion, Math.min(1, elapsed / duration));
            assert.equal(horizontal === 'left' ? rect.x + rect.width : rect.x, horizontal === 'left' ? previous.x + previous.width : previous.x);
            if (vertical !== 'center') assert.equal(vertical === 'up' ? rect.y + rect.height : rect.y, vertical === 'up' ? previous.y + previous.height : previous.y);
            for (const delta of [rect.x - previous.x, rect.y - previous.y, rect.x + rect.width - previous.x - previous.width, rect.y + rect.height - previous.y - previous.height]) {
              assert.ok(Math.abs(delta) <= Math.ceil(35 * scale / 1.25), `${scale}: ${delta}`);
            }
            previous = rect;
          }
        }
      }
    }
  }
});

test('abrir se pasa un 3 % del recorrido y se asienta exacto; cerrar nunca se pasa', () => {
  const from = { x: 314, y: 20, right: 356, bottom: 158 };
  const to = { x: 28, y: 20, right: 356, bottom: 254 };
  const widths = motion => Array.from({ length: 101 }, (_, step) => motionRect(motion, step / 100).width);
  const opening = widths({ from, to, spring: true });
  assert.equal(Math.max(...opening) - 328, Math.round(286 * .03));
  assert.equal(opening.at(-1), 328);
  const closing = widths({ from: to, to: from });
  assert.ok(closing.every((width, index) => width >= 42 && (index === 0 || width <= closing[index - 1])));
});
