import {
  haversineMeters,
  lonLatToTile,
  TILE_EXTENT,
  TileRoadGraphBuilder,
} from '../routing/TileRoadGraphBuilder';
import type { DecodedWay, TileCoord } from '../routing/TileRoadGraphBuilder';
import {
  parseTrailWayId,
  TRAIL_ANNOTATION_LIMITS,
  type ResolvedTrailWay,
  type TrailWayGeometry,
} from './TrailAnnotationTypes';

const WEB_MERCATOR_MAX_TILES = 1 << 14;
const ENDPOINT_SNAP_PIXELS = 4;

function getAdjacentTiles(
  point: { gx: number; gy: number },
  direction: { gx: number; gy: number },
  tile: TileCoord
): TileCoord[] {
  const localX = point.gx - tile.tx * TILE_EXTENT;
  const localY = point.gy - tile.ty * TILE_EXTENT;
  const verticalBoundary =
    localX <= ENDPOINT_SNAP_PIXELS
      ? -1
      : localX >= TILE_EXTENT - ENDPOINT_SNAP_PIXELS
        ? 1
        : 0;
  const horizontalBoundary =
    localY <= ENDPOINT_SNAP_PIXELS
      ? -1
      : localY >= TILE_EXTENT - ENDPOINT_SNAP_PIXELS
        ? 1
        : 0;
  const outwardX = Math.sign(point.gx - direction.gx);
  const outwardY = Math.sign(point.gy - direction.gy);
  const crossX = verticalBoundary !== 0 && (outwardX === 0 || outwardX === verticalBoundary);
  const crossY =
    horizontalBoundary !== 0 && (outwardY === 0 || outwardY === horizontalBoundary);
  const x = tile.tx + (crossX ? verticalBoundary : 0);
  const y = tile.ty + (crossY ? horizontalBoundary : 0);
  if (x < 0 || y < 0 || x >= WEB_MERCATOR_MAX_TILES || y >= WEB_MERCATOR_MAX_TILES) {
    return [];
  }
  if (crossX && crossY && outwardX !== 0 && outwardY !== 0) {
    return [{ tx: x, ty: y }];
  }
  const result: TileCoord[] = [];
  if (crossX) result.push({ tx: x, ty: tile.ty });
  if (crossY) result.push({ tx: tile.tx, ty: y });
  if (crossX && crossY) result.push({ tx: x, ty: y });
  return result;
}

function coordinateKey(point: [number, number]): string {
  return `${point[0].toFixed(6)},${point[1].toFixed(6)}`;
}

function canonicalLineKey(points: Array<[number, number]>): string {
  const forward = points.map(coordinateKey).join(';');
  const reverse = points.slice().reverse().map(coordinateKey).join(';');
  return forward < reverse ? forward : reverse;
}

function joinConnectedLines(lines: Array<Array<[number, number]>>): Array<Array<[number, number]>> {
  const joined = lines.map((line) => line.map((point) => [...point] as [number, number]));
  let changed = true;
  while (changed) {
    changed = false;
    outer: for (let i = 0; i < joined.length; i++) {
      for (let j = i + 1; j < joined.length; j++) {
        const first = joined[i];
        const second = joined[j];
        const firstStart = first[0];
        const firstEnd = first[first.length - 1];
        const secondStart = second[0];
        const secondEnd = second[second.length - 1];
        const pairs: Array<[number, number, boolean]> = [
          [0, 0, false],
          [0, second.length - 1, true],
          [first.length - 1, 0, false],
          [first.length - 1, second.length - 1, true],
        ];
        let join: [number, number, boolean] | null = null;
        for (const pair of pairs) {
          const a = pair[0] === 0 ? firstStart : firstEnd;
          const b = pair[1] === 0 ? secondStart : secondEnd;
          if (haversineMeters(a, b) <= 1.5) {
            join = pair;
            break;
          }
        }
        if (!join) continue;

        let left = first;
        let right = second;
        if (join[0] === 0) left = first.slice().reverse();
        if (join[1] === second.length - 1) right = second.slice().reverse();
        joined[i] = [...left, ...right.slice(1)];
        joined.splice(j, 1);
        changed = true;
        break outer;
      }
    }
  }
  return joined;
}

export class HighwayWayGeometryService {
  private readonly tileBuilder: TileRoadGraphBuilder;

  constructor(tileBuilder = new TileRoadGraphBuilder({ maxCachedTiles: 512 })) {
    this.tileBuilder = tileBuilder;
  }

  clearTileCache(): void {
    this.tileBuilder.clearCache();
  }

  async resolveWayAt(
    wayId: string,
    lon: number,
    lat: number,
    releaseId: string
  ): Promise<ResolvedTrailWay> {
    const featureId = parseTrailWayId(wayId);
    if (featureId === null) throw new Error('The selected highway does not have a stable way ID.');

    const pendingTiles: TileCoord[] = [lonLatToTile(lon, lat)];
    const visited = new Set<string>();
    const found = new Map<string, DecodedWay>();
    const missingNeighbor = new Set<string>();

    while (pendingTiles.length > 0) {
      const tile = pendingTiles.pop()!;
      const tileKey = `${tile.tx},${tile.ty}`;
      if (visited.has(tileKey)) continue;
      if (visited.size >= TRAIL_ANNOTATION_LIMITS.maxWayTiles) {
        throw new Error('This highway is too long to resolve safely from the current map archive.');
      }
      visited.add(tileKey);

      const ways = await this.tileBuilder.getDecodedTileWays(tile.tx, tile.ty);
      const matches = ways.filter((way) => way.featureId === String(featureId));
      if (matches.length === 0) {
        if (missingNeighbor.has(tileKey)) {
          throw new Error('The selected highway is clipped or missing from the current map archive.');
        }
        continue;
      }

      for (const way of matches) {
        const fragmentKey = `${tileKey}|${way.layer}|${canonicalLineKey(
          way.points.map((point) => [point.lon, point.lat])
        )}`;
        found.set(fragmentKey, way);

        const lastIndex = way.points.length - 1;
        for (const [endpoint, direction] of [
          [way.points[0], way.points[1]],
          [way.points[lastIndex], way.points[lastIndex - 1]],
        ] as const) {
          if (!endpoint.isClipped) continue;
          for (const neighbor of getAdjacentTiles(endpoint, direction, tile)) {
            const neighborKey = `${neighbor.tx},${neighbor.ty}`;
            if (!visited.has(neighborKey)) {
              missingNeighbor.add(neighborKey);
              pendingTiles.push(neighbor);
            }
          }
        }
      }
    }

    const fragments = Array.from(found.values());
    if (fragments.length === 0) {
      throw new Error('Could not find the selected highway in the active map archive.');
    }
    const first = fragments[0];
    if (fragments.some((way) => way.layer !== first.layer)) {
      throw new Error('The selected way has conflicting bridge or tunnel layers.');
    }

    const linesByKey = new Map<string, Array<[number, number]>>();
    for (const way of fragments) {
      const coordinates = way.points.map((point) => [point.lon, point.lat] as [number, number]);
      linesByKey.set(canonicalLineKey(coordinates), coordinates);
    }
    const lines = joinConnectedLines(Array.from(linesByKey.values()));
    if (lines.some((line) => line.length < 2)) {
      throw new Error('The map archive returned incomplete highway geometry.');
    }

    const merged = {
      type: 'MultiLineString' as const,
      coordinates: lines,
    };
    const props = first.props;
    return {
      wayId,
      geometry: merged,
      releaseId,
      layer: first.layer,
      highwayClass: String(props.class || ''),
      highwaySubclass: String(props.subclass || ''),
      fragments,
    };
  }

  static getGeometryByteLength(ways: TrailWayGeometry[]): number {
    return new TextEncoder().encode(JSON.stringify(ways)).byteLength;
  }
}

export const highwayWayGeometryService = new HighwayWayGeometryService();
