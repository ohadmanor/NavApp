import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  PlanningFolderRecord,
  PlanningTrailPayloadRecord,
  PlanningTrailRecord,
  RoutePayloadRecord,
  SavedRouteRecord,
} from '../db/NavDatabase';

const stores = vi.hoisted(() => ({
  planningFolders: new Map<string, PlanningFolderRecord>(),
  planningTrails: new Map<string, PlanningTrailRecord>(),
  planningTrailPayloads: new Map<string, PlanningTrailPayloadRecord>(),
  routes: new Map<string, SavedRouteRecord>(),
  routePayloads: new Map<string, RoutePayloadRecord>(),
}));

function makeTable<T extends { id: string }>(map: Map<string, T>) {
  return {
    toArray: vi.fn(async () => Array.from(map.values())),
    get: vi.fn(async (id: string) => map.get(id)),
    bulkGet: vi.fn(async (ids: string[]) => ids.map((id) => map.get(id))),
    put: vi.fn(async (item: T) => {
      map.set(item.id, item);
      return item.id;
    }),
    bulkPut: vi.fn(async (items: T[]) => {
      for (const item of items) map.set(item.id, item);
    }),
    delete: vi.fn(async (id: string) => {
      map.delete(id);
    }),
    bulkDelete: vi.fn(async (ids: string[]) => {
      for (const id of ids) map.delete(id);
    }),
  };
}

vi.mock('../db/NavDatabase', () => ({
  db: {
    planningFolders: makeTable(stores.planningFolders),
    planningTrails: makeTable(stores.planningTrails),
    planningTrailPayloads: makeTable(stores.planningTrailPayloads),
    routes: makeTable(stores.routes),
    routePayloads: makeTable(stores.routePayloads),
  },
}));

import { PlanningTrailManager } from '../navigation/PlanningTrailManager';
import { RouteManager } from '../navigation/RouteManager';

describe('PlanningTrailManager', () => {
  beforeEach(() => {
    stores.planningFolders.clear();
    stores.planningTrails.clear();
    stores.planningTrailPayloads.clear();
    stores.routes.clear();
    stores.routePayloads.clear();
    PlanningTrailManager.clearCache();
  });

  it('builds nested folder tree with recursive counts and breadcrumbs', async () => {
    const negev = await PlanningTrailManager.createFolder({
      id: 'f-negev',
      ownerUid: 'user-a',
      name: 'נגב',
      parentId: null,
    });
    const ramon = await PlanningTrailManager.createFolder({
      id: 'f-ramon',
      ownerUid: 'user-a',
      name: 'מכתש רמון',
      parentId: negev.id,
    });
    const hard4x4 = await PlanningTrailManager.createFolder({
      id: 'f-hard',
      ownerUid: 'user-a',
      name: 'מעלות קשים',
      parentId: ramon.id,
    });

    expect(hard4x4.pathIds).toEqual(['f-negev', 'f-ramon']);

    await PlanningTrailManager.persistFullTrail({
      id: 'pt-1',
      ownerUid: 'user-a',
      name: 'מעלה מחמל',
      folderId: hard4x4.id,
      categoryId: '4x4',
      difficulty: 'extreme',
      sourceFormat: 'planned',
      distanceKm: 19.5,
      ascentMeters: 740,
      descentMeters: 210,
      minEle: 390,
      maxEle: 830,
      color: '#f59e0b',
      geojson: { type: 'FeatureCollection', features: [] },
      elevationProfile: [],
      createdAt: '2026-11-16T10:00:00Z',
      updatedAt: '2026-11-16T10:00:00Z',
    });

    const folders = await PlanningTrailManager.listFolders('user-a');
    const trails = await PlanningTrailManager.listTrailSummaries('user-a');
    const tree = PlanningTrailManager.buildFolderTree(folders, trails);

    expect(tree).toHaveLength(1);
    expect(tree[0].recursiveCount).toBe(1);
    expect(tree[0].directCount).toBe(0);
    expect(tree[0].totalDistanceKm).toBeCloseTo(19.5, 2);

    const breadcrumbs = PlanningTrailManager.getFolderBreadcrumbs(hard4x4.id, folders);
    expect(breadcrumbs.map((b) => b.name)).toEqual(['נגב', 'מכתש רמון', 'מעלות קשים']);

    // Per-user isolation: user-b sees none of user-a's folders or trails
    expect(await PlanningTrailManager.listFolders('user-b')).toHaveLength(0);
    expect(await PlanningTrailManager.listTrailSummaries('user-b')).toHaveLength(0);
  });

  it('prevents moving a folder into its own descendant', async () => {
    const root = await PlanningTrailManager.createFolder({
      id: 'f-1',
      ownerUid: 'user-a',
      name: 'ראשי',
    });
    const child = await PlanningTrailManager.createFolder({
      id: 'f-2',
      ownerUid: 'user-a',
      name: 'תת',
      parentId: root.id,
    });

    await expect(PlanningTrailManager.moveFolder(root.id, child.id)).rejects.toThrow();
  });

  it('transfers trails bidirectionally between Planning Trail DB and Active Routes', async () => {
    const folder = await PlanningTrailManager.createFolder({
      id: 'f-golan',
      ownerUid: 'user-a',
      name: 'גולן',
    });

    const sampleGeoJson: GeoJSON.FeatureCollection = {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: {},
          geometry: {
            type: 'LineString',
            coordinates: [
              [35.75, 33.1],
              [35.78, 33.14],
            ],
          },
        },
      ],
    };

    const trail = await PlanningTrailManager.persistFullTrail({
      id: 'pt-golan-1',
      ownerUid: 'user-a',
      name: 'הר בנטל',
      folderId: folder.id,
      categoryId: 'scenic',
      difficulty: 'light',
      sourceFormat: 'planned',
      distanceKm: 12.4,
      ascentMeters: 310,
      descentMeters: 180,
      minEle: 850,
      maxEle: 1160,
      color: '#a855f7',
      geojson: sampleGeoJson,
      elevationProfile: [
        { distKm: 0, ele: 850, lon: 35.75, lat: 33.1 },
        { distKm: 12.4, ele: 1160, lon: 35.78, lat: 33.14 },
      ],
      createdAt: '2026-11-16T10:00:00Z',
      updatedAt: '2026-11-16T10:00:00Z',
    });

    // user-b cannot send user-a's trail
    expect(
      await PlanningTrailManager.sendPlanningTrailToActiveRoutes(trail.id, 'user-b')
    ).toBeUndefined();

    // Planning DB -> Active Routes
    const activeRoute = await PlanningTrailManager.sendPlanningTrailToActiveRoutes(
      trail.id,
      'user-a'
    );
    expect(activeRoute).toBeDefined();
    expect(activeRoute!.name).toBe('הר בנטל');
    expect(activeRoute!.geojson.features).toHaveLength(1);

    // Active Routes -> Planning DB with difficulty 'hard'
    const hydratedActive = await RouteManager.loadFullRoute(activeRoute!.id);
    expect(hydratedActive).toBeDefined();

    const archivedTrail = await PlanningTrailManager.sendActiveRouteToPlanningDb(
      activeRoute!.id,
      {
        ownerUid: 'user-a',
        folderId: folder.id,
        categoryId: '4x4',
        difficulty: 'hard',
        tags: ['גולן', 'תצפית'],
      }
    );
    expect(archivedTrail).toBeDefined();
    expect(archivedTrail!.difficulty).toBe('hard');
    expect(archivedTrail!.categoryId).toBe('4x4');
    expect(archivedTrail!.folderId).toBe(folder.id);
    expect(archivedTrail!.geojson.features).toHaveLength(1);
  });
});
