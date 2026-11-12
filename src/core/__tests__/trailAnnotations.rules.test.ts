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

const PROJECT_ID = 'demo-navapp-trail-annotations';
const TRAIL_ID = 'trail-1';
const HISTORY_ID = 'history-create-0001';
type Firestore = firebase.firestore.Firestore;
type TrailSnapshot = {
  wayIds: string[];
  color: string;
  number: string;
  description: string;
  status: string;
  geometryPath: string;
  selectionReleaseId: string;
};
let testEnv: RulesTestEnvironment;

function annotationData(
  revision: number,
  lastHistoryId: string,
  actorUid: string,
  overrides: Record<string, unknown> = {}
) {
  return {
    id: TRAIL_ID,
    schemaVersion: 1,
    wayIds: ['osm:way:42'],
    color: '#16a34a',
    number: '001A',
    description: 'שביל קהילתי',
    status: 'active',
    revision,
    lastHistoryId,
    geometryPath: `trail_annotations/${TRAIL_ID}/geometry/${revision}-${lastHistoryId}.json`,
    selectionReleaseId: 'osm:test-release',
    createdByUid: actorUid,
    createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    updatedByUid: actorUid,
    updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
    ...overrides,
  };
}

function snapshotData(annotation: firebase.firestore.DocumentData): TrailSnapshot {
  return {
    wayIds: annotation.wayIds,
    color: annotation.color,
    number: annotation.number,
    description: annotation.description,
    status: annotation.status,
    geometryPath: annotation.geometryPath,
    selectionReleaseId: annotation.selectionReleaseId,
  };
}

async function createTrail(firestore: Firestore, actorUid: string, historyActor = actorUid) {
  const historyId = HISTORY_ID;
  const annotationRef = firestore.doc(`trail_annotations/${TRAIL_ID}`);
  const historyRef = firestore.doc(`trail_annotations/${TRAIL_ID}/history/${historyId}`);
  const annotation = annotationData(1, historyId, actorUid);
  await firestore.runTransaction(async (transaction) => {
    transaction.set(annotationRef, annotation);
    transaction.set(historyRef, {
      revision: 1,
      operation: 'create',
      actorUid: historyActor,
      occurredAt: firebase.firestore.FieldValue.serverTimestamp(),
      previous: null,
      next: snapshotData(annotation),
      reason: '',
    });
  });
}

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)('Firestore community trail annotation rules', () => {
  beforeAll(async () => {
    testEnv = await initializeTestEnvironment({
      projectId: PROJECT_ID,
      firestore: { rules: fs.readFileSync('firestore.rules', 'utf8') },
    });
  });

  beforeEach(async () => {
    await testEnv.clearFirestore();
  });

  afterAll(async () => {
    await testEnv.cleanup();
  });

  it('allows public reads but denies anonymous writes', async () => {
    const anonymousDb = testEnv.unauthenticatedContext().firestore();
    await assertSucceeds(anonymousDb.doc(`trail_annotations/${TRAIL_ID}`).get());
    await assertFails(
      anonymousDb
        .doc(`trail_annotations/${TRAIL_ID}`)
        .set(annotationData(1, HISTORY_ID, 'anonymous'))
    );
  });

  it('requires an authenticated annotation and matching immutable history event', async () => {
    const firestore = testEnv.authenticatedContext('alice').firestore();
    await assertSucceeds(createTrail(firestore, 'alice'));
    const history = await firestore.doc(`trail_annotations/${TRAIL_ID}/history/${HISTORY_ID}`).get();
    expect(history.exists).toBe(true);
  });

  it('allows an authenticated edit only when the matching next revision is appended', async () => {
    const firestore = testEnv.authenticatedContext('alice').firestore();
    await createTrail(firestore, 'alice');
    const annotationRef = firestore.doc(`trail_annotations/${TRAIL_ID}`);
    const current = (await annotationRef.get()).data()!;
    const historyId = 'history-edit-0002';
    const geometryPath = `trail_annotations/${TRAIL_ID}/geometry/2-${historyId}.json`;
    const previous = snapshotData(current);
    const next = {
      ...previous,
      color: '#2563eb',
      geometryPath,
    };
    await firestore.runTransaction(async (transaction) => {
      const currentSnapshot = await transaction.get(annotationRef);
      const currentData = currentSnapshot.data()!;
      transaction.set(annotationRef, {
        ...currentData,
        ...next,
        revision: 2,
        lastHistoryId: historyId,
        updatedByUid: 'alice',
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      });
      transaction.set(
        firestore.doc(`trail_annotations/${TRAIL_ID}/history/${historyId}`),
        {
          revision: 2,
          operation: 'edit',
          actorUid: 'alice',
          occurredAt: firebase.firestore.FieldValue.serverTimestamp(),
          previous,
          next,
          reason: 'Corrected trail color',
        }
      );
    });
    expect((await annotationRef.get()).data()?.revision).toBe(2);
  });

  it('rejects a missing history event and a forged editor UID', async () => {
    const firestore = testEnv.authenticatedContext('alice').firestore();
    await assertFails(
      firestore
        .doc(`trail_annotations/${TRAIL_ID}`)
        .set(annotationData(1, HISTORY_ID, 'alice'))
    );

    await assertFails(createTrail(firestore, 'alice', 'mallory'));
  });

  it('rejects an edit without its corresponding next revision and event', async () => {
    const firestore = testEnv.authenticatedContext('alice').firestore();
    await createTrail(firestore, 'alice');
    const annotationRef = firestore.doc(`trail_annotations/${TRAIL_ID}`);
    const current = (await annotationRef.get()).data()!;
    await assertFails(
      annotationRef.set({
        ...current,
        revision: 2,
        lastHistoryId: 'history-edit-0001',
        number: '002',
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      })
    );
  });

  it('does not allow modifying or deleting a committed history event', async () => {
    const firestore = testEnv.authenticatedContext('alice').firestore();
    await createTrail(firestore, 'alice');
    const historyRef = firestore.doc(`trail_annotations/${TRAIL_ID}/history/${HISTORY_ID}`);
    await assertFails(historyRef.set({ revision: 1, operation: 'edit' }));
    await assertFails(historyRef.delete());
  });

  it('supports public history queries', async () => {
    const firestore = testEnv.authenticatedContext('alice').firestore();
    await createTrail(firestore, 'alice');
    const anonymousDb = testEnv.unauthenticatedContext().firestore();
    const result = await assertSucceeds(
      anonymousDb.doc(`trail_annotations/${TRAIL_ID}/history/${HISTORY_ID}`).get()
    );
    expect(result.data()?.actorUid).toBe('alice');
  });
});
