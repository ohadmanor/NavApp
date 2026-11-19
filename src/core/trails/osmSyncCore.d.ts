import type { CommunityHighwayClass, CommunityRoadKind, RoadConnectionAnchor } from './CommunityRoadTypes';

export const TRAIL_COLOR_TO_OSM: Record<string, string>;

export interface OsmFetchedNode {
  id: number;
  lat: number;
  lon: number;
  version: number;
}

export interface OsmFetchedWay {
  id: number;
  version: number;
  ndRefs: number[];
  tags: Record<string, string>;
  nodes: Map<number, OsmFetchedNode>;
}

export interface OsmSyncRoadInput {
  id: string;
  kind: CommunityRoadKind;
  sourceOsmWayId?: string;
  coordinates: Array<[number, number]>;
  highwayClass: CommunityHighwayClass;
  tracktype?: string;
  surface?: string;
  name?: string;
  description?: string;
  oneway?: -1 | 0 | 1;
  allow4x4: boolean;
  allowFoot: boolean;
  allowBicycle: boolean;
  anchors?: RoadConnectionAnchor[];
  trailAnnotation?: { color?: string; number?: string } | null;
}

export function mapTrailColorToOsmName(hexColor: string | null | undefined): string | null;
export function xmlEscape(value: unknown): string;
export function parseOsmWayFullXml(xml: string, targetWayId: number): OsmFetchedWay;
export function buildChangesetXml(params: {
  comment?: string;
  userUid: string;
  userName?: string;
}): string;
export function buildOsmChangeXml(params: {
  changesetId: number;
  road: OsmSyncRoadInput;
  trailAnnotation?: { color?: string; number?: string } | null;
  existingTargetWays?: Map<number, OsmFetchedWay>;
}): string;
export function osmFetch(
  url: string,
  options?: RequestInit,
  token?: string
): Promise<string>;
export function prepareRoadOsmContext(
  road: Pick<OsmSyncRoadInput, 'kind' | 'sourceOsmWayId' | 'anchors'>,
  osmApiBase: string
): Promise<Map<number, OsmFetchedWay>>;
export function extractSyncedWayFromDiffResult(
  diffResult: string,
  road: Pick<OsmSyncRoadInput, 'kind' | 'sourceOsmWayId'>
): { osmWayId: number; osmVersion: number };
export function pushRoadToOsmApi(params: {
  road: OsmSyncRoadInput;
  osmApiBase: string;
  osmToken: string;
  actorUid: string;
  actorName?: string;
}): Promise<{ changesetId: number; osmWayId: number; osmVersion: number }>;
