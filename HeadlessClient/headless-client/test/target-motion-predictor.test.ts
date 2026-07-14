import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TargetMotionPredictor } from '../src/target-motion-predictor';

test('NEWTICK endpoints are interpolated over tickTime instead of treated as current', () => {
  const predictor = new TargetMotionPredictor();
  predictor.observeTick(0, 200, [{ objectId: 1, x: 2, y: 4 }]);
  predictor.observeTick(200, 200, [{ objectId: 1, x: 4, y: 6 }]);

  assert.deepEqual(predictor.currentPosition(1, { x: 4, y: 6 }, 300), { x: 3, y: 5 });
  assert.deepEqual(predictor.predictPosition(1, { x: 4, y: 6 }, 300, 100), { x: 4, y: 6 });
  assert.deepEqual(predictor.predictPosition(1, { x: 4, y: 6 }, 300, 200), { x: 5, y: 7 });
});

test('circular tick history predicts continued turning after the known segment', () => {
  const predictor = new TargetMotionPredictor();
  const position = (time: number) => ({
    x: 10 + 4 * Math.cos(2 * Math.PI * time / 2_000),
    y: 5 + 4 * Math.sin(2 * Math.PI * time / 2_000),
  });
  for (let index = 0; index < 12; index++) {
    predictor.observeTick(index * 200, 200, [{ objectId: 1, ...position((index + 1) * 200) }]);
  }

  const predicted = predictor.predictPosition(1, position(2_400), 2_200, 600);
  assertPointNear(predicted, position(2_800), 0.01);
});

test('two matching back-and-forth cycles are replayed through the next reversal', () => {
  const predictor = new TargetMotionPredictor();
  const position = (time: number) => {
    const phase = ((time % 1_600) + 1_600) % 1_600 / 1_600;
    const triangle = phase < 0.25
      ? phase * 4
      : phase < 0.75
        ? 2 - phase * 4
        : phase * 4 - 4;
    return { x: 10 + triangle * 3, y: 5 };
  };
  for (let index = 0; index < 16; index++) {
    predictor.observeTick(index * 200, 200, [{ objectId: 1, ...position((index + 1) * 200) }]);
  }

  const predicted = predictor.predictPosition(1, position(3_200), 3_000, 1_000);
  assertPointNear(predicted, position(4_000), 1e-9);
});

function assertPointNear(
  actual: { x: number; y: number },
  expected: { x: number; y: number },
  tolerance: number,
): void {
  assert.ok(Math.hypot(actual.x - expected.x, actual.y - expected.y) <= tolerance,
    `expected (${actual.x}, ${actual.y}) near (${expected.x}, ${expected.y})`);
}
