import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import fs from 'node:fs';

const PROJECT_ID = 'demo-navapp-global-pois';
const USER_POI_ID = 'user-poi-1001';
const BUNDLED_POI_ID = 'osm-node-42';

let testEnv: RulesTestEnvironment;

function makeGlobalPoiDoc(
  poiId: string,
  createdByUid: string,
  updatedByUid: string = createdByUid,
  overrides: Record<string, unknown> = {}
) {
  const now = '2026-02-01T10:00:00.000Z';
  return {
    id: poiId,
    name: 'Ein Saharonim',
    nameHe: 'עין סהרונים',
    nameEn: 'Ein Saharonim',
    category: 'water',
    subcategory: 'spring',
    lon: 34.94,
    lat: 30.61,
    ele: 280,
    waterStatus: 'דיווח מטייל',
    difficulty4x4: null,
    descHe: 'מעיין מדברי',
    descEn: 'Desert spring',
    source: 'User Field Report (דיווח מטייל)',
    createdByUid,
    createdAt: now,
    updatedByUid,
    updatedAt: now,
    ...overrides,
  };
}

function makeOverrideDoc(
  poiId: string,
  updatedByUid: string,
  overrides: Record<string, unknown> = {}
) {
  return {
    id: poiId,
    deleted: false,
    category: 'water',
    subcategory: 'spring',
    updatedByUid,
    updatedAt: '2026-02-01T12:00:00.000Z',
    ...overrides,
  };
}

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)(
  'Firestore global POIs & overrides security rules',
  () => {
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

    it('allows anonymous users to read/list global_pois and poi_overrides but denies all writes', async () => {
      const ohadDb = testEnv
        .authenticatedContext('ohad-uid', { email: 'ohad.manor@gmail.com' })
        .firestore();
      await assertSucceeds(
        ohadDb.doc(`global_pois/${USER_POI_ID}`).set(makeGlobalPoiDoc(USER_POI_ID, 'ohad-uid'))
      );
      await assertSucceeds(
        ohadDb.doc(`poi_overrides/${BUNDLED_POI_ID}`).set(makeOverrideDoc(BUNDLED_POI_ID, 'ohad-uid'))
      );

      const anonDb = testEnv.unauthenticatedContext().firestore();
      await assertSucceeds(anonDb.doc(`global_pois/${USER_POI_ID}`).get());
      await assertSucceeds(anonDb.collection('global_pois').get());
      await assertSucceeds(anonDb.doc(`poi_overrides/${BUNDLED_POI_ID}`).get());
      await assertSucceeds(anonDb.collection('poi_overrides').get());

      await assertFails(
        anonDb.doc('global_pois/user-poi-anon').set(makeGlobalPoiDoc('user-poi-anon', 'anon'))
      );
      await assertFails(anonDb.doc(`global_pois/${USER_POI_ID}`).delete());
      await assertFails(
        anonDb
          .doc(`poi_overrides/${BUNDLED_POI_ID}`)
          .set(makeOverrideDoc(BUNDLED_POI_ID, 'anon'))
      );
      await assertFails(anonDb.doc(`poi_overrides/${BUNDLED_POI_ID}`).delete());
    });

    it('allows regular signed-in users to create & update global_pois (excluding private userNotes), but denies delete', async () => {
      const aliceDb = testEnv
        .authenticatedContext('alice-uid', { email: 'alice@example.com' })
        .firestore();
      const bobDb = testEnv
        .authenticatedContext('bob-uid', { email: 'bob@example.com' })
        .firestore();

      // Rejects injecting private userNotes or forged createdByUid
      await assertFails(
        aliceDb
          .doc(`global_pois/${USER_POI_ID}`)
          .set(makeGlobalPoiDoc(USER_POI_ID, 'alice-uid', 'alice-uid', { userNotes: 'secret' }))
      );
      await assertFails(
        aliceDb.doc(`global_pois/${USER_POI_ID}`).set(makeGlobalPoiDoc(USER_POI_ID, 'other-uid'))
      );

      // Valid create by Alice
      await assertSucceeds(
        aliceDb.doc(`global_pois/${USER_POI_ID}`).set(makeGlobalPoiDoc(USER_POI_ID, 'alice-uid'))
      );

      // Any signed-in user (Bob) can recategorize while preserving createdByUid & createdAt
      await assertSucceeds(
        bobDb.doc(`global_pois/${USER_POI_ID}`).set(
          makeGlobalPoiDoc(USER_POI_ID, 'alice-uid', 'bob-uid', {
            category: 'peak',
            subcategory: 'summit',
            updatedAt: '2026-02-02T10:00:00.000Z',
          })
        )
      );

      // Rejects changing immutable createdByUid on update
      await assertFails(
        bobDb.doc(`global_pois/${USER_POI_ID}`).set(
          makeGlobalPoiDoc(USER_POI_ID, 'bob-uid', 'bob-uid', {
            category: 'peak',
            subcategory: 'summit',
            updatedAt: '2026-02-03T10:00:00.000Z',
          })
        )
      );

      // Regular signed-in users CANNOT delete global POIs (even ones they created)
      await assertFails(aliceDb.doc(`global_pois/${USER_POI_ID}`).delete());
      await assertFails(bobDb.doc(`global_pois/${USER_POI_ID}`).delete());
    });

    it('allows regular signed-in users to create/update/reset category overrides, but denies deleting POIs or overwriting deleted ones', async () => {
      const aliceDb = testEnv
        .authenticatedContext('alice-uid', { email: 'alice@example.com' })
        .firestore();
      const ohadDb = testEnv
        .authenticatedContext('ohad-uid', { email: 'ohad.manor@gmail.com' })
        .firestore();

      // Alice CANNOT create a deleted=true override
      await assertFails(
        aliceDb
          .doc(`poi_overrides/${BUNDLED_POI_ID}`)
          .set(makeOverrideDoc(BUNDLED_POI_ID, 'alice-uid', { deleted: true, category: null, subcategory: null }))
      );

      // Alice CAN create a category override
      await assertSucceeds(
        aliceDb
          .doc(`poi_overrides/${BUNDLED_POI_ID}`)
          .set(makeOverrideDoc(BUNDLED_POI_ID, 'alice-uid'))
      );

      // Alice CAN update or reset category (deleted: false, category: null)
      await assertSucceeds(
        aliceDb.doc(`poi_overrides/${BUNDLED_POI_ID}`).set(
          makeOverrideDoc(BUNDLED_POI_ID, 'alice-uid', {
            deleted: false,
            category: null,
            subcategory: null,
            updatedAt: '2026-02-02T12:00:00.000Z',
          })
        )
      );

      // Alice CANNOT update an existing override to deleted=true and CANNOT delete override doc
      await assertFails(
        aliceDb.doc(`poi_overrides/${BUNDLED_POI_ID}`).set(
          makeOverrideDoc(BUNDLED_POI_ID, 'alice-uid', {
            deleted: true,
            category: null,
            subcategory: null,
            updatedAt: '2026-02-03T12:00:00.000Z',
          })
        )
      );
      await assertFails(aliceDb.doc(`poi_overrides/${BUNDLED_POI_ID}`).delete());

      // Admin Ohad marks bundled POI as deleted -> regular user Alice CANNOT overwrite deleted state
      await assertSucceeds(
        ohadDb.doc(`poi_overrides/${BUNDLED_POI_ID}`).set(
          makeOverrideDoc(BUNDLED_POI_ID, 'ohad-uid', {
            deleted: true,
            category: null,
            subcategory: null,
            updatedAt: '2026-02-04T12:00:00.000Z',
          })
        )
      );
      await assertFails(
        aliceDb.doc(`poi_overrides/${BUNDLED_POI_ID}`).set(
          makeOverrideDoc(BUNDLED_POI_ID, 'alice-uid', {
            deleted: false,
            category: 'water',
            subcategory: 'spring',
            updatedAt: '2026-02-05T12:00:00.000Z',
          })
        )
      );
    });

    it('allows ONLY ohad.manor@gmail.com and nabibesk@gmail.com (case-insensitive) to delete & restore POIs', async () => {
      const aliceDb = testEnv
        .authenticatedContext('alice-uid', { email: 'alice@example.com' })
        .firestore();
      const ohadUpperDb = testEnv
        .authenticatedContext('ohad-uid', { email: 'OHAD.MANOR@GMAIL.COM' })
        .firestore();
      const nabiUpperDb = testEnv
        .authenticatedContext('nabi-uid', { email: 'NaBiBeSk@GmAiL.CoM' })
        .firestore();

      // Alice creates two POIs
      await assertSucceeds(
        aliceDb.doc('global_pois/user-poi-a').set(makeGlobalPoiDoc('user-poi-a', 'alice-uid'))
      );
      await assertSucceeds(
        aliceDb.doc('global_pois/user-poi-b').set(makeGlobalPoiDoc('user-poi-b', 'alice-uid'))
      );

      // Ohad deletes user-poi-a and marks bundled-1 deleted
      await assertSucceeds(ohadUpperDb.doc('global_pois/user-poi-a').delete());
      await assertSucceeds(
        ohadUpperDb.doc('poi_overrides/bundled-1').set(
          makeOverrideDoc('bundled-1', 'ohad-uid', {
            deleted: true,
            category: null,
            subcategory: null,
          })
        )
      );

      // Nabi deletes user-poi-b, restores bundled-1, and deletes bundled-1 override doc
      await assertSucceeds(nabiUpperDb.doc('global_pois/user-poi-b').delete());
      await assertSucceeds(
        nabiUpperDb.doc('poi_overrides/bundled-1').set(
          makeOverrideDoc('bundled-1', 'nabi-uid', {
            deleted: false,
            category: null,
            subcategory: null,
            updatedAt: '2026-02-06T12:00:00.000Z',
          })
        )
      );
      await assertSucceeds(nabiUpperDb.doc('poi_overrides/bundled-1').delete());
    });
  }
);
