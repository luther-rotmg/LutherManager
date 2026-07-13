import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MovementController } from '../src/movement-controller';

test('MovementController steps from authoritative server position when available', () => {
  const movement = new MovementController();
  movement.setTarget({ x: 10, y: 0 }, 0.1);
  const update = movement.update(
    {
      localPos: { x: 9, y: 0 },
      serverPos: { x: 0, y: 0 },
      playerSpeed: 0,
      playerSpeedBoost: 0,
    },
    1000,
  );

  assert.equal(update.reached, undefined);
  assert.ok(update.pos.x > 3.9 && update.pos.x < 4.1);
  assert.equal(update.pos.y, 0);
});

test('MovementController emits reached target and clears target state', () => {
  const movement = new MovementController();
  movement.setTarget({ x: 1, y: 1 }, 0.1);
  const update = movement.update(
    {
      localPos: { x: 0, y: 0 },
      playerSpeed: 75,
      playerSpeedBoost: 0,
    },
    1000,
  );

  assert.deepEqual(update.reached, { x: 1, y: 1 });
  assert.equal(movement.hasTarget(), false);
});

test('MovementController waits for authoritative position before confirming a waypoint', () => {
  const movement = new MovementController();
  movement.setTarget({ x: 1, y: 0 }, 0.1);

  const predicted = movement.update(
    {
      localPos: { x: 0, y: 0 },
      serverPos: { x: 0, y: 0 },
      playerSpeed: 75,
      playerSpeedBoost: 0,
    },
    1000,
  );
  assert.deepEqual(predicted.pos, { x: 1, y: 0 });
  assert.equal(predicted.reached, undefined);
  assert.equal(movement.hasTarget(), true);

  const confirmed = movement.update(
    {
      localPos: predicted.pos,
      serverPos: { x: 1, y: 0 },
      playerSpeed: 75,
      playerSpeedBoost: 0,
    },
    100,
  );
  assert.deepEqual(confirmed.reached, { x: 1, y: 0 });
  assert.equal(movement.hasTarget(), false);
});
