import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import { pmtilesRegistry } from '../pmtiles/PMTilesRegistry';
import { evaluateEdgeAccess, type PlanningMode } from './RoutingProfiles';

export const ROUTING_TILE_ZOOM = 14;
export const TILE_EXTENT = 4096;
const WORLD_PIXELS = TILE_EXTENT * (1 << ROUTING_TILE_ZOOM); // 67,108,864

export interface TileCoord {
  tx: number;
  ty: number;
}

export interface GlobalTilePoint {
  gx: number;
  gy: number;
  lon: number;
  lat: number;
  isClipped: boolean;
}

export interface DecodedWay {
  featureId: string;
  props: Record<string, any>;
  layer: number;
  points: GlobalTilePoint[];
}

export interface GraphNode {
  id: string;
  lon: number;
  lat: number;
  gx: number;
  gy: number;
}

export interface GraphEdge {
  id: string;
  fromNode: string;
  toNode: string;
  coords: Array<[number, number]>;
  lengthMeters: number;
  costMeters: number;
  costMultiplier: number;
  forwardAllowed: boolean;
  reverseAllowed: boolean;
  roadLabel: string;
  roadClass: string;
}

export interface RoadGraph {
  nodes: Map<string, GraphNode>;
  adjacency: Map<string, Array<{ edge: GraphEdge; toNode: string; reverse: boolean }>>;
  edges: GraphEdge[];
}

export type TileDataFetcher = (
  z: number,
  x: number,
  y: number
) => Promise<ArrayBuffer | Uint8Array | undefined>;

export function lonLatToTile(lon: number, lat: number, zoom = ROUTING_TILE_ZOOM): TileCoord {
  const n = 1 << zoom;
  const clampedLat = Math.max(-85.0511, Math.min(85.0511, lat));
  const tx = Math.max(0, Math.min(n - 1, Math.floor(((lon + 180) / 360) * n)));
  const latRad = (clampedLat * Math.PI) / 180;
  const ty = Math.max(
    0,
    Math.min(
      n - 1,
      Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n)
    )
  );
  return { tx, ty };
}

export function globalPixelToLonLat(gx: number, gy: number): [number, number] {
  const lon = (gx / WORLD_PIXELS) * 360 - 180;
  const n = Math.PI - (2 * Math.PI * gy) / WORLD_PIXELS;
  const lat = (180 / Math.PI) * Math.atan(Math.sinh(n));
  return [Number(lon.toFixed(6)), Number(lat.toFixed(6))];
}

export function haversineMeters(a: [number, number], b: [number, number]): number {
  const R = 6371008.8;
  const lat1 = (a[1] * Math.PI) / 180;
  const lat2 = (b[1] * Math.PI) / 180;
  const dLat = lat2 - lat1;
  const dLon = ((b[0] - a[0]) * Math.PI) / 180;
  const sinHalfLat = Math.sin(dLat / 2);
  const sinHalfLon = Math.sin(dLon / 2);
  const h =
    sinHalfLat * sinHalfLat +
    Math.cos(lat1) * Math.cos(lat2) * sinHalfLon * sinHalfLon;
  return 2 * R * Math.atan2(Math.sqrt(h), Math.sqrt(Math.max(0, 1 - h)));
}

/**
 * Liang-Barsky clip of segment (x0, y0) -> (x1, y1) against [0, extent] x [0, extent].
 */
function clipSegmentToTileBox(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  extent: number
): {
  cx0: number;
  cy0: number;
  cx1: number;
  cy1: number;
  startClipped: boolean;
  endClipped: boolean;
} | null {
  const dx = x1 - x0;
  const dy = y1 - y0;
  let t0 = 0;
  let t1 = 1;

  const p = [-dx, dx, -dy, dy];
  const q = [x0, extent - x0, y0, extent - y0];

  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) {
      if (q[i] < 0) return null;
    } else {
      const r = q[i] / p[i];
      if (p[i] < 0) {
        if (r > t1) return null;
        if (r > t0) t0 = r;
      } else {
        if (r < t0) return null;
        if (r < t1) t1 = r;
      }
    }
  }

  return {
    cx0: Math.round(x0 + t0 * dx),
    cy0: Math.round(y0 + t0 * dy),
    cx1: Math.round(x0 + t1 * dx),
    cy1: Math.round(y0 + t1 * dy),
    startClipped: t0 > 1e-6,
    endClipped: t1 < 1 - 1e-6,
  };
}

export class TileRoadGraphBuilder {
  private tileCache = new Map<string, DecodedWay[]>();
  private inFlight = new Map<string, Promise<DecodedWay[]>>();
  private maxCachedTiles: number;
  private customFetcher?: TileDataFetcher;

  constructor(options?: { maxCachedTiles?: number; fetchTileData?: TileDataFetcher }) {
    this.maxCachedTiles = options?.maxCachedTiles ?? 96;
    this.customFetcher = options?.fetchTileData;
  }

  clearCache(): void {
    this.tileCache.clear();
  }

  private async fetchRawTile(tx: number, ty: number): Promise<ArrayBuffer | Uint8Array | undefined> {
    if (this.customFetcher) {
      return this.customFetcher(ROUTING_TILE_ZOOM, tx, ty);
    }
    const osmPmtiles = pmtilesRegistry.getArchive('israel-osm');
    if (!osmPmtiles) return undefined;
    const res = await osmPmtiles.getZxy(ROUTING_TILE_ZOOM, tx, ty);
    return res?.data;
  }

  async getDecodedTileWays(tx: number, ty: number): Promise<DecodedWay[]> {
    const key = `${ROUTING_TILE_ZOOM}/${tx}/${ty}`;
    const cached = this.tileCache.get(key);
    if (cached) {
      // Refresh LRU position
      this.tileCache.delete(key);
      this.tileCache.set(key, cached);
      return cached;
    }

    const pending = this.inFlight.get(key);
    if (pending) return pending;

    const promise = (async () => {
      try {
        const rawData = await this.fetchRawTile(tx, ty);
        if (!rawData) return [];

        const bytes = rawData instanceof Uint8Array ? rawData : new Uint8Array(rawData);
        if (bytes.byteLength === 0) return [];

        const vt = new VectorTile(new PbfReader(bytes));
        const trans = vt.layers['transportation'];
        if (!trans) return [];

        const scale = TILE_EXTENT / (trans.extent || TILE_EXTENT);
        const ways: DecodedWay[] = [];

        for (let i = 0; i < trans.length; i++) {
          const feature = trans.feature(i);
          if (feature.type !== 2) continue; // LineStrings only (skip polygon plazas)

          const props = { ...feature.properties };
          const layerNum = Number(props.layer ?? 0) || 0;
          const featureId =
            feature.id !== undefined && feature.id !== null
              ? String(feature.id)
              : `anon-${tx}-${ty}-${i}`;

          const rings = feature.loadGeometry();
          for (const ring of rings) {
            if (ring.length < 2) continue;

            let activePts: GlobalTilePoint[] = [];

            const flushActive = () => {
              if (activePts.length >= 2) {
                ways.push({
                  featureId,
                  props,
                  layer: layerNum,
                  points: activePts,
                });
              }
              activePts = [];
            };

            const appendPt = (lx: number, ly: number, isClipped: boolean) => {
              const gx = tx * TILE_EXTENT + lx;
              const gy = ty * TILE_EXTENT + ly;
              const prev = activePts[activePts.length - 1];
              if (prev && prev.gx === gx && prev.gy === gy) {
                if (!isClipped) prev.isClipped = false;
                return;
              }
              const [lon, lat] = globalPixelToLonLat(gx, gy);
              activePts.push({ gx, gy, lon, lat, isClipped });
            };

            for (let s = 0; s < ring.length - 1; s++) {
              const x0 = ring[s].x * scale;
              const y0 = ring[s].y * scale;
              const x1 = ring[s + 1].x * scale;
              const y1 = ring[s + 1].y * scale;

              const clipped = clipSegmentToTileBox(x0, y0, x1, y1, TILE_EXTENT);
              if (!clipped) {
                flushActive();
                continue;
              }

              if (activePts.length === 0) {
                appendPt(clipped.cx0, clipped.cy0, clipped.startClipped);
              }
              appendPt(clipped.cx1, clipped.cy1, clipped.endClipped);

              if (clipped.endClipped) {
                flushActive();
              }
            }

            flushActive();
          }
        }

        if (this.tileCache.size >= this.maxCachedTiles) {
          const oldest = this.tileCache.keys().next().value;
          if (oldest !== undefined) this.tileCache.delete(oldest);
        }
        this.tileCache.set(key, ways);
        return ways;
      } catch (err) {
        console.warn(`[TileRoadGraphBuilder] Failed decoding ${key}:`, err);
        return [];
      } finally {
        this.inFlight.delete(key);
      }
    })();

    this.inFlight.set(key, promise);
    return promise;
  }

  /**
   * Builds a connected, mode-filtered, intersection-split RoadGraph across the supplied z14 tiles.
   */
  async buildGraphForTiles(tiles: TileCoord[], mode: PlanningMode): Promise<RoadGraph> {
    const uniqueTiles = new Map<string, TileCoord>();
    for (const t of tiles) {
      uniqueTiles.set(`${t.tx},${t.ty}`, t);
    }

    const tileWaysList = await Promise.all(
      Array.from(uniqueTiles.values()).map((t) => this.getDecodedTileWays(t.tx, t.ty))
    );

    const eligibleWays: Array<{
      way: DecodedWay;
      access: ReturnType<typeof evaluateEdgeAccess>;
      nodeKeys: string[];
    }> = [];

    // Collect boundary vertices to snap minor <= 4 unit buffer-clip rounding mismatches on matching featureId
    const boundarySnapMap = new Map<string, { gx: number; gy: number }>();
    const boundarySeen = new Map<string, Array<{ gx: number; gy: number; key: string }>>();

    const filteredWays: Array<{
      way: DecodedWay;
      access: ReturnType<typeof evaluateEdgeAccess>;
    }> = [];

    for (const ways of tileWaysList) {
      for (const way of ways) {
        const access = evaluateEdgeAccess(way.props, mode);
        if (!access.allowed || way.points.length < 2) continue;
        filteredWays.push({ way, access });

        for (const pt of way.points) {
          const onVertEdge = pt.gx % TILE_EXTENT === 0;
          const onHorizEdge = pt.gy % TILE_EXTENT === 0;
          if (!onVertEdge && !onHorizEdge) continue;

          if (onVertEdge) {
            const bucketKey = `V:${way.featureId}:${way.layer}:${pt.gx}`;
            const rawKey = `${way.layer}:${pt.gx},${pt.gy}`;
            const list = boundarySeen.get(bucketKey) || [];
            const match = list.find((c) => Math.abs(c.gy - pt.gy) <= 4);
            if (match) {
              boundarySnapMap.set(rawKey, { gx: match.gx, gy: match.gy });
            } else {
              list.push({ gx: pt.gx, gy: pt.gy, key: rawKey });
              boundarySeen.set(bucketKey, list);
            }
          }
          if (onHorizEdge) {
            const bucketKey = `H:${way.featureId}:${way.layer}:${pt.gy}`;
            const rawKey = `${way.layer}:${pt.gx},${pt.gy}`;
            const list = boundarySeen.get(bucketKey) || [];
            const match = list.find((c) => Math.abs(c.gx - pt.gx) <= 4);
            if (match) {
              boundarySnapMap.set(rawKey, { gx: match.gx, gy: match.gy });
            } else {
              list.push({ gx: pt.gx, gy: pt.gy, key: rawKey });
              boundarySeen.set(bucketKey, list);
            }
          }
        }
      }
    }

    const groundCoordSet = new Set<string>();
    const nodeOccCount = new Map<string, number>();

    for (const { way, access } of filteredWays) {
      const nodeKeys: string[] = [];
      for (let i = 0; i < way.points.length; i++) {
        const pt = way.points[i];
        const rawKey = `${way.layer}:${pt.gx},${pt.gy}`;
        const snapped = boundarySnapMap.get(rawKey);
        const cgx = snapped ? snapped.gx : pt.gx;
        const cgy = snapped ? snapped.gy : pt.gy;
        const nKey = `${way.layer}:${cgx},${cgy}`;
        nodeKeys.push(nKey);
        if (way.layer === 0) {
          groundCoordSet.add(`${cgx},${cgy}`);
        }
        nodeOccCount.set(nKey, (nodeOccCount.get(nKey) || 0) + 1);
      }
      eligibleWays.push({ way, access, nodeKeys });
    }

    const nodes = new Map<string, GraphNode>();
    const adjacency = new Map<
      string,
      Array<{ edge: GraphEdge; toNode: string; reverse: boolean }>
    >();
    const edges: GraphEdge[] = [];

    const ensureNode = (id: string, gx: number, gy: number, lon: number, lat: number) => {
      if (!nodes.has(id)) {
        nodes.set(id, { id, gx, gy, lon, lat });
        adjacency.set(id, []);
      }
    };

    const addDirectedToAdj = (from: string, to: string, edge: GraphEdge, reverse: boolean) => {
      let list = adjacency.get(from);
      if (!list) {
        list = [];
        adjacency.set(from, list);
      }
      list.push({ edge, toNode: to, reverse });
    };

    let edgeSeq = 0;
    const bridgeLinksAdded = new Set<string>();

    for (const { way, access, nodeKeys } of eligibleWays) {
      const pts = way.points;
      const splitIndices: number[] = [0];

      for (let i = 1; i < pts.length - 1; i++) {
        const k = nodeKeys[i];
        if ((nodeOccCount.get(k) || 0) >= 2) {
          splitIndices.push(i);
        }
      }
      splitIndices.push(pts.length - 1);

      // Deduplicate split indices if consecutive
      const uniqueSplits: number[] = [];
      for (const idx of splitIndices) {
        if (uniqueSplits[uniqueSplits.length - 1] !== idx) {
          uniqueSplits.push(idx);
        }
      }

      // Connect unclipped endpoints of bridges/tunnels (layer !== 0) to matching ground nodes (layer === 0)
      if (way.layer !== 0) {
        for (const endIdx of [0, pts.length - 1]) {
          const pt = pts[endIdx];
          if (pt.isClipped) continue;
          const endKey = nodeKeys[endIdx];
          const snapped = boundarySnapMap.get(`${way.layer}:${pt.gx},${pt.gy}`);
          const cgx = snapped ? snapped.gx : pt.gx;
          const cgy = snapped ? snapped.gy : pt.gy;
          const coordKey = `${cgx},${cgy}`;
          const groundKey = `0:${coordKey}`;
          if (groundCoordSet.has(coordKey)) {
            const linkSig = `${endKey}<->${groundKey}`;
            if (!bridgeLinksAdded.has(linkSig)) {
              bridgeLinksAdded.add(linkSig);
              const [lon, lat] = globalPixelToLonLat(cgx, cgy);
              ensureNode(endKey, cgx, cgy, lon, lat);
              ensureNode(groundKey, cgx, cgy, lon, lat);
              const rampEdge: GraphEdge = {
                id: `ramp-${edgeSeq++}`,
                fromNode: endKey,
                toNode: groundKey,
                coords: [
                  [lon, lat],
                  [lon, lat],
                ],
                lengthMeters: 0,
                costMeters: 0,
                costMultiplier: 1,
                forwardAllowed: true,
                reverseAllowed: true,
                roadLabel: access.roadLabel,
                roadClass: String(way.props.class || ''),
              };
              edges.push(rampEdge);
              addDirectedToAdj(endKey, groundKey, rampEdge, false);
              addDirectedToAdj(groundKey, endKey, rampEdge, true);
            }
          }
        }
      }

      for (let s = 0; s < uniqueSplits.length - 1; s++) {
        const startIdx = uniqueSplits[s];
        const endIdx = uniqueSplits[s + 1];
        if (endIdx <= startIdx) continue;

        const fromKey = nodeKeys[startIdx];
        const toKey = nodeKeys[endIdx];

        const coords: Array<[number, number]> = [];
        let lengthMeters = 0;
        let startGx = pts[startIdx].gx;
        let startGy = pts[startIdx].gy;
        let endGx = pts[endIdx].gx;
        let endGy = pts[endIdx].gy;

        for (let i = startIdx; i <= endIdx; i++) {
          const p = pts[i];
          const snap = boundarySnapMap.get(`${way.layer}:${p.gx},${p.gy}`);
          const cgx = snap ? snap.gx : p.gx;
          const cgy = snap ? snap.gy : p.gy;
          const coord = snap ? globalPixelToLonLat(cgx, cgy) : ([p.lon, p.lat] as [number, number]);
          if (i === startIdx) {
            startGx = cgx;
            startGy = cgy;
          }
          if (i === endIdx) {
            endGx = cgx;
            endGy = cgy;
          }
          const prevCoord = coords[coords.length - 1];
          if (!prevCoord || prevCoord[0] !== coord[0] || prevCoord[1] !== coord[1]) {
            if (prevCoord) {
              lengthMeters += haversineMeters(prevCoord, coord);
            }
            coords.push(coord);
          }
        }

        if (coords.length < 2) continue;

        ensureNode(fromKey, startGx, startGy, coords[0][0], coords[0][1]);
        ensureNode(toKey, endGx, endGy, coords[coords.length - 1][0], coords[coords.length - 1][1]);

        const edge: GraphEdge = {
          id: `e-${edgeSeq++}`,
          fromNode: fromKey,
          toNode: toKey,
          coords,
          lengthMeters,
          costMeters: lengthMeters * access.costMultiplier,
          costMultiplier: access.costMultiplier,
          forwardAllowed: access.forwardAllowed,
          reverseAllowed: access.reverseAllowed,
          roadLabel: access.roadLabel,
          roadClass: String(way.props.class || ''),
        };

        edges.push(edge);
        if (edge.forwardAllowed) {
          addDirectedToAdj(fromKey, toKey, edge, false);
        }
        if (edge.reverseAllowed) {
          addDirectedToAdj(toKey, fromKey, edge, true);
        }
      }
    }

    return { nodes, adjacency, edges };
  }
}
