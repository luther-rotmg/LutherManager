import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ObjectStatusData, StatData, StatType } from 'realmlib';
import { PortalTracker } from '../src/portal-tracker';

test('parseRealmPortal extracts name and player counts', () => {
  assert.deepEqual(PortalTracker.parseRealmPortal('NexusPortal.Horizon (37/85)'), {
    name: 'Horizon',
    players: 37,
    maxPlayers: 85,
  });
  assert.deepEqual(PortalTracker.parseRealmPortal('Frontier (0/85)'), {
    name: 'Frontier',
    players: 0,
    maxPlayers: 85,
  });
  assert.equal(PortalTracker.parseRealmPortal('not a portal'), undefined);
});

test('trackRealmPortal preserves connect stats and reports new vs update', () => {
  const tracker = new PortalTracker();
  const first = tracker.trackRealmPortal(status(123, 'NexusPortal.Squall (7/85)', 1000, 400, 500));
  assert.equal(first?.isNew, true);
  assert.deepEqual(first?.portal, {
    objectId: 123,
    name: 'Squall',
    players: 7,
    maxPlayers: 85,
    openedAt: 1000,
    connectId: 400,
    connectValueTwo: 500,
    x: 10,
    y: 20,
  });

  const update = tracker.trackRealmPortal(status(123, 'NexusPortal.Squall (8/85)'));
  assert.equal(update?.isNew, false);
  assert.equal(update?.portal.openedAt, 1000);
  assert.equal(update?.portal.connectId, 400);
  assert.equal(update?.portal.connectValueTwo, 500);
  assert.equal(update?.portal.players, 8);
});

function status(
  objectId: number,
  name: string,
  openedAt?: number,
  connectId?: number,
  connectValueTwo?: number,
): ObjectStatusData {
  const object = new ObjectStatusData();
  object.objectId = objectId;
  object.pos.x = 10;
  object.pos.y = 20;
  object.stats = [
    stat(StatType.NAME_STAT, 0, name),
    ...(openedAt === undefined ? [] : [stat(StatType.OPENED_AT_TIMESTAMP, openedAt)]),
    ...(connectId === undefined ? [] : [stat(StatType.CONNECT_STAT, connectId, undefined, connectValueTwo)]),
  ];
  return object;
}

function stat(type: StatType, value: number, stringValue?: string, valueTwo = 0): StatData {
  const data = new StatData();
  data.statType = type;
  data.statValue = value;
  data.statValueTwo = valueTwo;
  data.stringStatValue = stringValue ?? '';
  return data;
}
