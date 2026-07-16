import assert from 'node:assert/strict';
import test from 'node:test';
import { PredictiveAutoDodgeController } from 'headless-client';
import { buildDodgeViewerTelemetry } from '../src/dev/server/dodgeViewerTelemetry.js';

const environment = {
  canOccupy: () => true,
  isProjectileSegmentOpen: () => true,
};

test('viewer telemetry distinguishes plan commits, lookahead updates, and reused searches', () => {
  const controller = new PredictiveAutoDodgeController({ maxStatesPerLayer: 64 });
  controller.setEnabled(true);
  const base = {
    playerId: 10,
    goal: { x: 10, y: 5 },
    movementIntent: {
      mode: 'goal' as const,
      goalX: 20,
      goalY: 5,
      goalId: 'viewer-goal',
    },
    routeRevision: 1,
    moveSpeed: 0.004,
    intentVelocity: { x: 0.004, y: 0 },
    movementLeadMs: 0,
    projectiles: [],
    aoes: [],
    environment,
  };
  let position = { x: 5, y: 5 };
  const committedState = controller.evaluate({ ...base, time: 0, position });
  const committed = buildDodgeViewerTelemetry(committedState);

  assert.equal(committed?.planCommitted, true);
  assert.equal(committed?.searchPerformed, true);
  assert.equal(committed?.planRevision, 1);
  assert.equal(committed?.searchRevision, 1);

  position = {
    x: position.x + committedState.velocity.x * 16,
    y: position.y + committedState.velocity.y * 16,
  };
  const lookaheadState = controller.evaluate({ ...base, time: 16, position });
  const lookahead = buildDodgeViewerTelemetry(lookaheadState);
  assert.equal(lookahead?.planCommitted, false);
  assert.equal(lookahead?.searchPerformed, false);
  assert.equal(lookahead?.planReused, true);
  assert.equal(lookahead?.lookaheadChanged, true);
  assert.ok((lookahead?.lookaheadRevision ?? 0) > (committed?.lookaheadRevision ?? 0));

  position = {
    x: position.x + lookaheadState.velocity.x * 84,
    y: position.y + lookaheadState.velocity.y * 84,
  };
  const searched = buildDodgeViewerTelemetry(
    controller.evaluate({ ...base, time: 100, position }),
  );
  assert.equal(searched?.searchPerformed, true);
  assert.equal(searched?.planCommitted, false);
  assert.equal(searched?.planReused, true);
  assert.equal(searched?.searchRevision, 2);
  assert.equal(searched?.planRevision, 1);
  assert.equal(searched?.replanCause, 'periodic_refresh');
});
