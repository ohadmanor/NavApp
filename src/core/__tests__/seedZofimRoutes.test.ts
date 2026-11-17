import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  PlanningFolderRecord,
  PlanningTrailRecord,
} from '../db/NavDatabase';

const stores = vi.hoisted(() => ({
  planningFolders: new Map<string, PlanningFolderRecord>(),
  planningTrails: new Map<string, PlanningTrailRecord>(),
}));

vi.mock('../db/NavDatabase', () => ({
  db: {
    planningFolders: {
      where: (field: string) => ({
        equals: (val: unknown) => ({
          toArray: async () =>
            Array.from(stores.planningFolders.values()).filter(
              (item) => (item as unknown as Record<string, unknown>)[field] === val
            ),
        }),
      }),
      bulkPut: async (items: PlanningFolderRecord[]) => {
        for (const item of items) stores.planningFolders.set(item.id, item);
      },
      toArray: async () => Array.from(stores.planningFolders.values()),
    },
    planningTrails: {
      bulkPut: async (items: PlanningTrailRecord[]) => {
        for (const item of items) stores.planningTrails.set(item.id, item);
      },
      toArray: async () => Array.from(stores.planningTrails.values()),
    },
    transaction: async (
      _mode: string,
      _t1: unknown,
      _t2: unknown,
      fn: () => Promise<void>
    ) => {
      await fn();
    },
  },
}));

import {
  ZOFIM_ROOT_FOLDER_NAME,
  ensureZofimRoutesSeeded,
} from '../navigation/seedZofimRoutes';

describe('ensureZofimRoutesSeeded', () => {
  beforeEach(() => {
    stores.planningFolders.clear();
    stores.planningTrails.clear();
  });

  it('creates מסלולי צופים root folder, 15 region subfolders, and 393 metadata-only routes', async () => {
    const seeded = await ensureZofimRoutesSeeded('user-1');
    expect(seeded).toBe(true);

    const folders = Array.from(stores.planningFolders.values());
    const root = folders.find((f) => f.parentId === null && f.name === ZOFIM_ROOT_FOLDER_NAME);
    expect(root).toBeDefined();

    const subfolders = folders.filter((f) => f.parentId === root!.id);
    expect(subfolders.length).toBe(15);

    const trails = Array.from(stores.planningTrails.values());
    expect(trails.length).toBe(393);

    const subfolderIds = new Set(subfolders.map((f) => f.id));
    for (const trail of trails) {
      expect(trail.ownerUid).toBe('user-1');
      expect(subfolderIds.has(trail.folderId!)).toBe(true);
      expect(trail.geojson.features).toHaveLength(0);
      expect(trail.bounds).toBeUndefined();
      expect(trail.categoryId).toBe('hiking');
      expect(trail.planningMode).toBe('foot');
    }

    // Idempotent on second call
    const secondRun = await ensureZofimRoutesSeeded('user-1');
    expect(secondRun).toBe(false);
    expect(stores.planningFolders.size).toBe(16);
    expect(stores.planningTrails.size).toBe(393);
  });
});
