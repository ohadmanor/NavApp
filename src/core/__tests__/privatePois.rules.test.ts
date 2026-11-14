import fs from 'node:fs';
import path from 'node:path';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';

const EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '';

function makePrivatePoiDoc(
  poiId: string,
  ownerUid: string,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id: poiId,
    name: 'מעיין פרטי',
    nameHe: 'מעיין פרטי',
    nameEn: 'Private Spring',
    category: 'water',
    subcategory: 'spring',
    lon: 35.15,
    lat: 31.78,
    ele: 510,
    waterStatus: 'פעיל',
    difficulty4x4: null,
    descHe: 'נביעה סודית',
    descEn: 'Secret spring',
    source: 'נקודה פרטית (משתמש)',
    visibility: 'private',
    ownerUid,
    ownerEmail: 'alice@example.com',
    ownerDisplayName: 'Alice Hiker',
    sharedWith: [],
    sharedWithUids: [],
    sharedWithEmails: [],
    createdByUid: ownerUid,
    createdAt: '2026-11-14T08:00:00.000Z',
    updatedByUid: ownerUid,
    updatedAt: '2026-11-14T08:00:00.000Z',
    ...overrides,
  };
}

function makeGlobalPoiDoc(
  poiId: string,
  uid: string,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id: poiId,
    name: 'מעיין גלובלי',
    nameHe: 'מעיין גלובלי',
    nameEn: 'Global Spring',
    category: 'water',
    subcategory: 'spring',
    lon: 35.15,
    lat: 31.78,
    ele: 510,
    waterStatus: 'פעיל',
    difficulty4x4: null,
    descHe: 'פתוח לכולם',
    descEn: 'Open for all',
    source: 'User Field Report (דיווח מטייל)',
    createdByUid: uid,
    createdAt: '2026-11-14T08:00:00.000Z',
    updatedByUid: uid,
    updatedAt: '2026-11-14T08:00:00.000Z',
    ...overrides,
  };
}

describe.skipIf(!EMULATOR_HOST)(
  'Firestore Security Rules: private_pois owner/recipient isolation & promotion',
  () => {
    let testEnv: RulesTestEnvironment;

    beforeAll(async () => {
      const [host, portStr] = EMULATOR_HOST.split(':');
      const rules = fs.readFileSync(path.resolve(process.cwd(), 'firestore.rules'), 'utf8');
      testEnv = await initializeTestEnvironment({
        projectId: 'navapp-private-pois-rules-test',
        firestore: {
          host: host || '127.0.0.1',
          port: Number(portStr) || 8080,
          rules,
        },
      });
    });

    beforeEach(async () => {
      await testEnv.clearFirestore();
    });

    afterAll(async () => {
      if (testEnv) await testEnv.cleanup();
    });

    it('denies unauthenticated access to /private_pois', async () => {
      const anonDb = testEnv.unauthenticatedContext().firestore();
      await assertFails(anonDb.doc('private_pois/p-1').get());
      await assertFails(
        anonDb.doc('private_pois/p-1').set(makePrivatePoiDoc('p-1', 'alice-uid'))
      );
    });

    it('enforces owner-only writes and recipient-only reads on /private_pois', async () => {
      const aliceDb = testEnv
        .authenticatedContext('alice-uid', { email: 'alice@example.com' })
        .firestore();
      const bobDb = testEnv
        .authenticatedContext('bob-uid', { email: 'BOB@GMAIL.COM' })
        .firestore();
      const carolDb = testEnv
        .authenticatedContext('carol-uid', { email: 'carol@example.com' })
        .firestore();

      // Alice cannot spoof ownerUid
      await assertFails(
        aliceDb.doc('private_pois/spoof').set(makePrivatePoiDoc('spoof', 'bob-uid'))
      );

      // Alice creates private POI shared with Bob (by lowercase email & UID)
      const sharedDoc = makePrivatePoiDoc('p-shared', 'alice-uid', {
        sharedWith: [
          {
            uid: 'bob-uid',
            email: 'bob@gmail.com',
            displayName: 'Bob',
            photoURL: null,
            sharedAt: '2026-11-14T08:00:00.000Z',
          },
        ],
        sharedWithUids: ['bob-uid'],
        sharedWithEmails: ['bob@gmail.com'],
      });

      await assertSucceeds(aliceDb.doc('private_pois/p-shared').set(sharedDoc));
      await assertSucceeds(aliceDb.doc('private_pois/p-shared').get());

      // Bob can read because he is in sharedWithUids / sharedWithEmails
      await assertSucceeds(bobDb.doc('private_pois/p-shared').get());

      // Bob CANNOT update or delete Alice's private POI
      await assertFails(
        bobDb.doc('private_pois/p-shared').update({ nameHe: 'ניסיון שינוי' })
      );
      await assertFails(bobDb.doc('private_pois/p-shared').delete());

      // Carol (outsider) CANNOT read, update, or delete
      await assertFails(carolDb.doc('private_pois/p-shared').get());
      await assertFails(
        carolDb.doc('private_pois/p-shared').set(makePrivatePoiDoc('p-shared', 'carol-uid'))
      );
      await assertFails(carolDb.doc('private_pois/p-shared').delete());

      // Alice promotes p-shared -> writes global_pois/p-shared and deletes private_pois/p-shared
      await assertSucceeds(
        aliceDb.doc('global_pois/p-shared').set(makeGlobalPoiDoc('p-shared', 'alice-uid'))
      );
      await assertSucceeds(aliceDb.doc('private_pois/p-shared').delete());

      // Alice still cannot delete from global_pois (admin-only)
      await assertFails(aliceDb.doc('global_pois/p-shared').delete());
    });
  }
);
