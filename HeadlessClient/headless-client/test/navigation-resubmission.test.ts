import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client } from '../src/client';
import type { ExplorativePathfinder } from '../src/explorative-pathfinder';

test('pathfindingWalkTo no-ops resubmission while planning with same goal and mapVersion', () => {
  const client = new Client({
    alias: 'navigation-resubmission-noop-test',
    accessToken: '',
    clientToken: '',
    charId: 1,
    needsNewChar: false,
    host: 'localhost',
  });
  const state = client as unknown as {
    navigationStatus: 'planning';
    navigationRequestKey: string;
    navigationMapVersion: number;
    pathfinder: ExplorativePathfinder;
  };
  const target = { x: 8.5, y: 2.5 };
  state.pathfinder.setMapBounds(20, 20);
  state.pathfinder.setTarget(target, 0.5);

  state.navigationStatus = 'planning';
  state.navigationRequestKey = `goal:${target.x}:${target.y}:0.5:`;
  state.navigationMapVersion = state.pathfinder.getMapVersion();

  let setTargetCalls = 0;
  const originalSetTarget = state.pathfinder.setTarget.bind(state.pathfinder);
  state.pathfinder.setTarget = (...args) => {
    setTargetCalls++;
    return originalSetTarget(...args);
  };

  assert.equal(client.pathfindingWalkTo(target), true);
  assert.equal(setTargetCalls, 0);
});

test('pathfindingWalkTo resubmission refreshes when mapVersion changes', () => {
  const BLOCKING = 99;
  const client = new Client({
    alias: 'navigation-map-version-test',
    accessToken: '',
    clientToken: '',
    charId: 1,
    needsNewChar: false,
    host: 'localhost',
    combatData: {
      getObject: () => undefined,
      getProjectile: () => undefined,
      tileIsBlockingWalk: (type) => type === BLOCKING,
    },
  });
  const state = client as unknown as {
    pos: { x: number; y: number };
    serverPos: { x: number; y: number };
    player: { spd: number; spdBoost: number; condition: number; condition2: number };
    pathfinder: ExplorativePathfinder;
    navigationMapVersion: number;
    updateTarget(dt: number, integrateFromLocal?: boolean, now?: number): void;
  };
  const start = { x: 0.5, y: 2.5 };
  const target = { x: 40.5, y: 2.5 };
  Object.assign(state, {
    pos: { ...start },
    serverPos: { ...start },
    player: { spd: 75, spdBoost: 0, condition: 0, condition2: 0 },
  });
  state.pathfinder.setMapBounds(64, 8);

  assert.equal(client.pathfindingWalkTo(target), true);
  state.updateTarget(16, false, 1000);
  const mapVersionAfterFirstRequest = state.pathfinder.getMapVersion();

  state.pathfinder.observeTile(10, 2, BLOCKING);
  assert.notEqual(state.pathfinder.getMapVersion(), mapVersionAfterFirstRequest);
  assert.equal(client.pathfindingWalkTo(target), true);
  assert.equal(state.navigationMapVersion, state.pathfinder.getMapVersion());
});
