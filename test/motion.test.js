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
        for (const motion of [{ from, to }, { from: to, to: from }]) {
          let previous = motionRect(motion, 0);
          for (let elapsed = 1000 / 60; elapsed < MOTION_MS.toggle + 1000 / 60; elapsed += 1000 / 60) {
            const rect = motionRect(motion, Math.min(1, elapsed / MOTION_MS.toggle));
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
