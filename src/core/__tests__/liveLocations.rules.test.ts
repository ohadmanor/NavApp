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

function makeLiveLocationDoc(
  uid: string,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    uid,
    displayName: 'Alice Hiker',
    email: 'alice@example.com',
    photoURL: null,
    visibility: 'shared',
    active: true,
    sharedWith: [
      {
        uid: 'bob',
        email: 'bob@example.com',
        displayName: 'Bob Trail',
        photoURL: null,
      },
    ],
    sharedWithUids: ['bob'],
    sharedWithEmails: ['bob@example.com'],
    lon: 35.15,
    lat: 31.78,
    accuracy: 8,
    altitude: 510,
    heading: 90,
    speed: 4.5,
    iconId: 'car-4wd',
    accentColor: '#0ea5e9',
    startedAt: '2026-11-17T10:00:00.000Z',
    updatedAt: '2026-11-17T10:05:00.000Z',
    expiresAt: '2026-11-17T14:00:00.000Z',
    expiresAtMs: 1794924000000,
    ...overrides,
  };
}

describe.skipIf(!EMULATOR_HOST)(
  'Firestore Security Rules: live_locations sharing & isolation',
  () => {
    let testEnv: RulesTestEnvironment;

    beforeAll(async () => {
      const rules = fs.readFileSync(
        path.resolve(process.cwd(), 'devops/firebase/firestore.rules'),
        'utf8'
      );
      const [host, portStr] = EMULATOR_HOST.split(':');
      testEnv = await initializeTestEnvironment({
        projectId: 'demo-navapp',
        firestore: {
          host,
          port: Number(portStr || 8080),
          rules,
        },
      });
    });

    beforeEach(async () => {
      await testEnv.clearFirestore();
    });

    afterAll(async () => {
      await testEnv?.cleanup();
    });

    it('allows owner to create/update/delete only their own live_locations doc', async () => {
      const aliceDb = testEnv.authenticatedContext('alice', { email: 'alice@example.com' }).firestore();
      const bobDb = testEnv.authenticatedContext('bob', { email: 'bob@example.com' }).firestore();

      await assertSucceeds(
        aliceDb.collection('live_locations').doc('alice').set(makeLiveLocationDoc('alice'))
      );

      // Bob cannot overwrite Alice's live location
      await assertFails(
        bobDb.collection('live_locations').doc('alice').set(makeLiveLocationDoc('alice'))
      );

      // Alice cannot spoof another user's doc ID
      await assertFails(
        aliceDb.collection('live_locations').doc('bob').set(makeLiveLocationDoc('bob'))
      );

      await assertSucceeds(aliceDb.collection('live_locations').doc('alice').delete());
    });

    it('restricts shared live_locations reads to listed recipients and owner', async () => {
      await testEnv.withSecurityRulesDisabled(async (ctx) => {
        await ctx
          .firestore()
          .collection('live_locations')
          .doc('alice')
          .set(makeLiveLocationDoc('alice'));
      });

      const anonDb = testEnv.unauthenticatedContext().firestore();
      const aliceDb = testEnv.authenticatedContext('alice', { email: 'alice@example.com' }).firestore();
      const bobDb = testEnv.authenticatedContext('bob', { email: 'bob@example.com' }).firestore();
      const eveDb = testEnv.authenticatedContext('eve', { email: 'eve@example.com' }).firestore();

      await assertFails(anonDb.collection('live_locations').doc('alice').get());
      await assertSucceeds(aliceDb.collection('live_locations').doc('alice').get());
      await assertSucceeds(bobDb.collection('live_locations').doc('alice').get());
      await assertSucceeds(
        bobDb.collection('live_locations').where('sharedWithUids', 'array-contains', 'bob').get()
      );
      await assertSucceeds(
        bobDb
          .collection('live_locations')
          .where('sharedWithEmails', 'array-contains', 'bob@example.com')
          .get()
      );
      await assertFails(eveDb.collection('live_locations').doc('alice').get());
    });

    it('allows any signed-in user to read public active live_locations, but rejects unauthenticated', async () => {
      await testEnv.withSecurityRulesDisabled(async (ctx) => {
        await ctx
          .firestore()
          .collection('live_locations')
          .doc('alice')
          .set(
            makeLiveLocationDoc('alice', {
              visibility: 'public',
              sharedWith: [],
              sharedWithUids: [],
              sharedWithEmails: [],
            })
          );
      });

      const anonDb = testEnv.unauthenticatedContext().firestore();
      const eveDb = testEnv.authenticatedContext('eve', { email: 'eve@example.com' }).firestore();

      await assertFails(anonDb.collection('live_locations').doc('alice').get());
      await assertSucceeds(eveDb.collection('live_locations').doc('alice').get());
      await assertSucceeds(
        eveDb
          .collection('live_locations')
          .where('visibility', '==', 'public')
          .get()
      );
    });

    it('rejects inactive docs from non-owners and rejects invalid coordinates', async () => {
      await testEnv.withSecurityRulesDisabled(async (ctx) => {
        await ctx
          .firestore()
          .collection('live_locations')
          .doc('alice')
          .set(
            makeLiveLocationDoc('alice', {
              visibility: 'off',
              active: false,
              sharedWith: [],
              sharedWithUids: [],
              sharedWithEmails: [],
            })
          );
      });

      const aliceDb = testEnv.authenticatedContext('alice', { email: 'alice@example.com' }).firestore();
      const eveDb = testEnv.authenticatedContext('eve', { email: 'eve@example.com' }).firestore();

      await assertSucceeds(aliceDb.collection('live_locations').doc('alice').get());
      await assertFails(eveDb.collection('live_locations').doc('alice').get());

      await assertFails(
        aliceDb
          .collection('live_locations')
          .doc('alice')
          .set(makeLiveLocationDoc('alice', { lat: 95 }))
      );
    });
  }
);
