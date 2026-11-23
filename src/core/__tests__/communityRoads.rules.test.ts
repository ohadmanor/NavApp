import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import firebase from 'firebase/compat/app';
import 'firebase/compat/firestore';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import fs from 'node:fs';

const PROJECT_ID = 'demo-navapp-community-roads';
const ROAD_ID = 'road-test-0001';
const HISTORY_ID = '1-create-0001';
type Firestore = firebase.firestore.Firestore;

let testEnv: RulesTestEnvironment;

function roadSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'new',
    coordinates: [
      { lon: 35.2, lat: 31.77 },
      { lon: 35.202, lat: 31.772 },
    ],
    bounds: [35.2, 31.77, 35.202, 31.772],
    highwayClass: 'track',
    tracktype: 'grade2',
    surface: 'gravel',
    name: 'דרך בדיקה',
    description: '',
    oneway: 0,
    allow4x4: true,
    allowFoot: true,
    allowBicycle: true,
    anchors: [],
    trailColor: '',
    trailNumber: '',
    trailName: '',
    status: 'active',
    ...overrides,
  };
}

function roadDocData(
  revision: number,
  lastHistoryId: string,
  actorUid: string,
  overrides: Record<string, unknown> = {}
) {
  return {
    schemaVersion: 1,
    ...roadSnapshot(),
    revision,
    lastHistoryId,
    createdByUid: actorUid,
    createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    updatedByUid: actorUid,
    updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
    ...overrides,
  };
}

async function createRoad(firestore: Firestore, actorUid: string) {
  const roadRef = firestore.doc(`community_roads/${ROAD_ID}`);
  const historyRef = firestore.doc(`community_roads/${ROAD_ID}/history/${HISTORY_ID}`);
  const snap = roadSnapshot();
  await firestore.runTransaction(async (tx) => {
    tx.set(roadRef, roadDocData(1, HISTORY_ID, actorUid));
    tx.set(historyRef, {
      revision: 1,
      operation: 'create',
      actorUid,
      occurredAt: firebase.firestore.FieldValue.serverTimestamp(),
      previous: null,
      next: snap,
      reason: 'create road',
    });
  });
}

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)(
  'Firestore community_roads & osm-sync rules',
  () => {
    beforeAll(async () => {
      testEnv = await initializeTestEnvironment({
        projectId: PROJECT_ID,
        firestore: { rules: fs.readFileSync('devops/firebase/firestore.rules', 'utf8') },
      });
    });

    beforeEach(async () => {
      await testEnv.clearFirestore();
    });

    afterAll(async () => {
      await testEnv.cleanup();
    });

    it('allows public reads, denies anonymous writes, and rejects forged osmSync on create', async () => {
      const anonDb = testEnv.unauthenticatedContext().firestore();
      await assertSucceeds(anonDb.doc(`community_roads/${ROAD_ID}`).get());
      await assertFails(
        anonDb.doc(`community_roads/${ROAD_ID}`).set(roadDocData(1, HISTORY_ID, 'anon'))
      );

      const aliceDb = testEnv.authenticatedContext('alice').firestore();
      const forgedHistoryId = '1-create-forged';
      await assertFails(
        aliceDb.runTransaction(async (tx) => {
          tx.set(aliceDb.doc(`community_roads/${ROAD_ID}`), {
            ...roadDocData(1, forgedHistoryId, 'alice'),
            osmSync: {
              changesetId: 10,
              osmWayId: 20,
              osmVersion: 1,
              syncedRevision: 1,
              syncedAt: firebase.firestore.FieldValue.serverTimestamp(),
              syncedByUid: 'alice',
              syncedByName: 'Alice',
            },
          });
          tx.set(aliceDb.doc(`community_roads/${ROAD_ID}/history/${forgedHistoryId}`), {
            revision: 1,
            operation: 'create',
            actorUid: 'alice',
            occurredAt: firebase.firestore.FieldValue.serverTimestamp(),
            previous: null,
            next: roadSnapshot(),
            reason: 'forged sync',
          });
        })
      );
    });

    it('allows valid osm-sync update + history and rejects content mutation during osm-sync', async () => {
      const aliceDb = testEnv.authenticatedContext('alice').firestore();
      await assertSucceeds(createRoad(aliceDb, 'alice'));

      const bobDb = testEnv.authenticatedContext('bob').firestore();
      const roadRef = bobDb.doc(`community_roads/${ROAD_ID}`);
      const syncHistoryId = '2-osm-sync-0002';

      await assertSucceeds(
        bobDb.runTransaction(async (tx) => {
          const prev = (await tx.get(roadRef)).data()!;
          const snap = roadSnapshot();
          tx.set(bobDb.doc(`community_roads/${ROAD_ID}/history/${syncHistoryId}`), {
            revision: 2,
            operation: 'osm-sync',
            actorUid: 'bob',
            occurredAt: firebase.firestore.FieldValue.serverTimestamp(),
            previous: snap,
            next: snap,
            reason: 'סנכרון ל-OSM',
          });
          tx.update(roadRef, {
            revision: 2,
            lastHistoryId: syncHistoryId,
            updatedByUid: 'bob',
            updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
            osmSync: {
              changesetId: 9001,
              osmWayId: 55555,
              osmVersion: 1,
              syncedRevision: 2,
              syncedAt: firebase.firestore.FieldValue.serverTimestamp(),
              syncedByUid: 'bob',
              syncedByName: 'Bob',
              osmUsername: 'BobMapper',
            },
          });
          expect(prev.revision).toBe(1);
        })
      );

      // Mutating road name during osm-sync must fail
      const badHistoryId = '3-osm-sync-bad';
      await assertFails(
        bobDb.runTransaction(async (tx) => {
          tx.set(bobDb.doc(`community_roads/${ROAD_ID}/history/${badHistoryId}`), {
            revision: 3,
            operation: 'osm-sync',
            actorUid: 'bob',
            occurredAt: firebase.firestore.FieldValue.serverTimestamp(),
            previous: roadSnapshot(),
            next: roadSnapshot({ name: 'Hacked' }),
            reason: 'bad sync',
          });
          tx.update(roadRef, {
            name: 'Hacked',
            revision: 3,
            lastHistoryId: badHistoryId,
            updatedByUid: 'bob',
            updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
            osmSync: {
              changesetId: 9002,
              osmWayId: 55555,
              osmVersion: 2,
              syncedRevision: 3,
              syncedAt: firebase.firestore.FieldValue.serverTimestamp(),
              syncedByUid: 'bob',
              syncedByName: 'Bob',
            },
          });
        })
      );

      // Subsequent normal edit preserving prior osmSync succeeds and marks syncedRevision < revision
      const editHistoryId = '3-edit-after-sync';
      await assertSucceeds(
        aliceDb.runTransaction(async (tx) => {
          const prev = (await tx.get(aliceDb.doc(`community_roads/${ROAD_ID}`))).data()!;
          const nextSnap = roadSnapshot({ name: 'דרך מעודכנת' });
          tx.set(aliceDb.doc(`community_roads/${ROAD_ID}/history/${editHistoryId}`), {
            revision: 3,
            operation: 'edit',
            actorUid: 'alice',
            occurredAt: firebase.firestore.FieldValue.serverTimestamp(),
            previous: roadSnapshot(),
            next: nextSnap,
            reason: 'rename',
          });
          tx.set(aliceDb.doc(`community_roads/${ROAD_ID}`), {
            schemaVersion: 1,
            ...nextSnap,
            osmSync: prev.osmSync,
            revision: 3,
            lastHistoryId: editHistoryId,
            createdByUid: prev.createdByUid,
            createdAt: prev.createdAt,
            updatedByUid: 'alice',
            updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
          });
        })
      );

      const finalDoc = (await aliceDb.doc(`community_roads/${ROAD_ID}`).get()).data()!;
      expect(finalDoc.revision).toBe(3);
      expect(finalDoc.osmSync.syncedRevision).toBe(2);
    });

    it('allows a removed-road tombstone on an osm-override and rejects `removed` on a new road', async () => {
      const aliceDb = testEnv.authenticatedContext('alice').firestore();
      const createWithSnapshot = (roadId: string, historyId: string, snap: Record<string, unknown>) =>
        aliceDb.runTransaction(async (tx) => {
          tx.set(aliceDb.doc(`community_roads/${roadId}`), roadDocData(1, historyId, 'alice', snap));
          tx.set(aliceDb.doc(`community_roads/${roadId}/history/${historyId}`), {
            revision: 1,
            operation: 'create',
            actorUid: 'alice',
            occurredAt: firebase.firestore.FieldValue.serverTimestamp(),
            previous: null,
            next: snap,
            reason: 'הסרת דרך מהמפה',
          });
        });

      await assertSucceeds(
        createWithSnapshot(
          ROAD_ID,
          '1-create-removed',
          roadSnapshot({ kind: 'osm-override', sourceOsmWayId: 'osm:way:777001', removed: true })
        )
      );

      // Only an OSM way can be tombstoned, and the flag is only ever `true`
      await assertFails(
        createWithSnapshot('road-test-0002', '1-create-bad-kind', roadSnapshot({ removed: true }))
      );
      await assertFails(
        createWithSnapshot(
          'road-test-0003',
          '1-create-bad-flag',
          roadSnapshot({ kind: 'osm-override', sourceOsmWayId: 'osm:way:777002', removed: false })
        )
      );
    });
  }
);
