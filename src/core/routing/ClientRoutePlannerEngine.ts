import {
  PLANNING_MODE_META,
  type PlanningMode,
} from './RoutingProfiles';
import {
  TileRoadGraphBuilder,
  ROUTING_TILE_ZOOM,
  TILE_EXTENT,
  lonLatToTile,
  haversineMeters,
  type GraphEdge,
  type RoadGraph,
  type TileCoord,
  type TileDataFetcher,
} from './TileRoadGraphBuilder';

export interface SnappedPoint {
  lon: number;
  lat: number;
  clickLon: number;
  clickLat: number;
  distFromClickMeters: number;
  roadLabel: string;
  roadClass: string;
  mode: PlanningMode;
}

export interface RouteLegResult {
  found: boolean;
  reason?: 'no-highway-near-point' | 'disconnected' | 'tile-budget-exceeded';
  coordinates: Array<[number, number]>;
  distanceKm: number;
  legType: 'network' | 'straight';
  roadLabels: string[];
}

interface ProjectedEdgeHit {
  edge: GraphEdge;
  coord: [number, number];
  distMeters: number;
  segIdx: number;
  t: number;
  alongMeters: number;
}

interface HeapItem {
  nodeId: string;
  f: number;
  g: number;
}

class MinBinaryHeap {
  private data: HeapItem[] = [];

  get size(): number {
    return this.data.length;
  }

  push(item: HeapItem): void {
    this.data.push(item);
    this.bubbleUp(this.data.length - 1);
  }

  pop(): HeapItem | undefined {
    if (this.data.length === 0) return undefined;
    const top = this.data[0];
    const last = this.data.pop()!;
    if (this.data.length > 0) {
      this.data[0] = last;
      this.sinkDown(0);
    }
    return top;
  }

  private bubbleUp(idx: number): void {
    const item = this.data[idx];
    while (idx > 0) {
      const parentIdx = (idx - 1) >> 1;
      const parent = this.data[parentIdx];
      if (item.f >= parent.f) break;
      this.data[idx] = parent;
      idx = parentIdx;
    }
    this.data[idx] = item;
  }

  private sinkDown(idx: number): void {
    const len = this.data.length;
    const item = this.data[idx];
    while (true) {
      const left = (idx << 1) + 1;
      const right = left + 1;
      let smallest = idx;

      if (left < len && this.data[left].f < this.data[smallest].f) {
        smallest = left;
      }
      if (right < len && this.data[right].f < this.data[smallest].f) {
        smallest = right;
      }
      if (smallest === idx) break;
      this.data[idx] = this.data[smallest];
      idx = smallest;
    }
    this.data[idx] = item;
  }
}

function projectOntoSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  metersPerDegLon: number,
  metersPerDegLat: number
): { lon: number; lat: number; distMeters: number; t: number } {
  const abx = (bx - ax) * metersPerDegLon;
  const aby = (by - ay) * metersPerDegLat;
  const apx = (px - ax) * metersPerDegLon;
  const apy = (py - ay) * metersPerDegLat;
  const abLenSq = abx * abx + aby * aby;

  let t = 0;
  if (abLenSq > 1e-9) {
    t = Math.max(0, Math.min(1, (apx * abx + apy * aby) / abLenSq));
  }

  const projLon = ax + t * (bx - ax);
  const projLat = ay + t * (by - ay);
  const dx = (px - projLon) * metersPerDegLon;
  const dy = (py - projLat) * metersPerDegLat;

  return {
    lon: Number(projLon.toFixed(6)),
    lat: Number(projLat.toFixed(6)),
    distMeters: Math.sqrt(dx * dx + dy * dy),
    t,
  };
}

function projectPointToEdge(
  lon: number,
  lat: number,
  edge: GraphEdge
): ProjectedEdgeHit | null {
  const coords = edge.coords;
  if (coords.length < 2) return null;

  const metersPerDegLat = 111194.9;
  const metersPerDegLon = 111194.9 * Math.cos((lat * Math.PI) / 180);

  let bestDist = Infinity;
  let bestHit: ProjectedEdgeHit | null = null;
  let cumMeters = 0;

  for (let i = 0; i < coords.length - 1; i++) {
    const a = coords[i];
    const b = coords[i + 1];
    const segLen = haversineMeters(a, b);
    const proj = projectOntoSegment(
      lon,
      lat,
      a[0],
      a[1],
      b[0],
      b[1],
      metersPerDegLon,
      metersPerDegLat
    );

    if (proj.distMeters < bestDist) {
      bestDist = proj.distMeters;
      bestHit = {
        edge,
        coord: [proj.lon, proj.lat],
        distMeters: proj.distMeters,
        segIdx: i,
        t: proj.t,
        alongMeters: cumMeters + proj.t * segLen,
      };
    }

    cumMeters += segLen;
  }

  return bestHit;
}

function sliceEdgeCoords(
  edge: GraphEdge,
  startSplit: { segIdx: number; coord: [number, number] },
  endSplit: { segIdx: number; coord: [number, number] }
): Array<[number, number]> {
  const result: Array<[number, number]> = [startSplit.coord];
  if (startSplit.segIdx <= endSplit.segIdx) {
    for (let i = startSplit.segIdx + 1; i <= endSplit.segIdx; i++) {
      const pt = edge.coords[i];
      const prev = result[result.length - 1];
      if (prev[0] !== pt[0] || prev[1] !== pt[1]) result.push(pt);
    }
  } else {
    for (let i = startSplit.segIdx; i >= endSplit.segIdx + 1; i--) {
      const pt = edge.coords[i];
      const prev = result[result.length - 1];
      if (prev[0] !== pt[0] || prev[1] !== pt[1]) result.push(pt);
    }
  }
  const prev = result[result.length - 1];
  if (prev[0] !== endSplit.coord[0] || prev[1] !== endSplit.coord[1]) {
    result.push(endSplit.coord);
  }
  if (result.length === 1) {
    result.push(endSplit.coord);
  }
  return result;
}

export class ClientRoutePlannerEngine {
  private graphBuilder: TileRoadGraphBuilder;

  constructor(options?: { fetchTileData?: TileDataFetcher; maxCachedTiles?: number }) {
    this.graphBuilder = new TileRoadGraphBuilder(options);
  }

  clearCache(): void {
    this.graphBuilder.clearCache();
  }

  private getTilesAroundPoint(lon: number, lat: number, radiusMeters: number): TileCoord[] {
    const center = lonLatToTile(lon, lat, ROUTING_TILE_ZOOM);
    const n = 1 << ROUTING_TILE_ZOOM;
    const xFrac = ((lon + 180) / 360) * n - center.tx;
    const latRad = (lat * Math.PI) / 180;
    const yFrac =
      ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n - center.ty;

    // At Israel latitude (~31 deg), 1 z14 tile is ~2,100m wide
    const edgeMargin = Math.min(0.45, Math.max(0.15, radiusMeters / 1800));
    const dxList = [0];
    const dyList = [0];
    if (xFrac < edgeMargin && center.tx > 0) dxList.push(-1);
    if (xFrac > 1 - edgeMargin && center.tx < n - 1) dxList.push(1);
    if (yFrac < edgeMargin && center.ty > 0) dyList.push(-1);
    if (yFrac > 1 - edgeMargin && center.ty < n - 1) dyList.push(1);

    const tiles: TileCoord[] = [];
    for (const dx of dxList) {
      for (const dy of dyList) {
        tiles.push({ tx: center.tx + dx, ty: center.ty + dy });
      }
    }
    return tiles;
  }

  private findClosestEdgeInGraph(
    graph: RoadGraph,
    lon: number,
    lat: number,
    maxDistMeters: number
  ): ProjectedEdgeHit | null {
    let best: ProjectedEdgeHit | null = null;
    for (const edge of graph.edges) {
      if (edge.id.startsWith('ramp-') || edge.lengthMeters <= 0) continue;
      const hit = projectPointToEdge(lon, lat, edge);
      if (hit && hit.distMeters <= maxDistMeters && (!best || hit.distMeters < best.distMeters)) {
        best = hit;
      }
    }
    return best;
  }

  /**
   * Snaps a user click [lon, lat] onto the nearest routable highway segment for the active mode.
   */
  async snapToNearestHighway(
    lon: number,
    lat: number,
    mode: PlanningMode,
    maxRadiusMeters = PLANNING_MODE_META[mode].maxSnapRadiusMeters
  ): Promise<SnappedPoint | null> {
    const primaryTiles = this.getTilesAroundPoint(lon, lat, maxRadiusMeters);
    let graph = await this.graphBuilder.buildGraphForTiles(primaryTiles, mode);
    let bestHit = this.findClosestEdgeInGraph(graph, lon, lat, maxRadiusMeters);

    // Check distance in meters from (lon, lat) to the nearest unloaded neighbor tile edge
    const c = lonLatToTile(lon, lat, ROUTING_TILE_ZOOM);
    const n = 1 << ROUTING_TILE_ZOOM;
    const xFrac = ((lon + 180) / 360) * n - c.tx;
    const latRad = (lat * Math.PI) / 180;
    const yFrac =
      ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n - c.ty;
    const tileMeters = (40075016.686 * Math.cos(latRad)) / n;
    const loadedSet = new Set(primaryTiles.map((t) => `${t.tx}/${t.ty}`));

    let minUnloadedEdgeDist = Infinity;
    if (c.tx > 0 && !loadedSet.has(`${c.tx - 1}/${c.ty}`)) {
      minUnloadedEdgeDist = Math.min(minUnloadedEdgeDist, xFrac * tileMeters);
    }
    if (c.tx < n - 1 && !loadedSet.has(`${c.tx + 1}/${c.ty}`)) {
      minUnloadedEdgeDist = Math.min(minUnloadedEdgeDist, (1 - xFrac) * tileMeters);
    }
    if (c.ty > 0 && !loadedSet.has(`${c.tx}/${c.ty - 1}`)) {
      minUnloadedEdgeDist = Math.min(minUnloadedEdgeDist, yFrac * tileMeters);
    }
    if (c.ty < n - 1 && !loadedSet.has(`${c.tx}/${c.ty + 1}`)) {
      minUnloadedEdgeDist = Math.min(minUnloadedEdgeDist, (1 - yFrac) * tileMeters);
    }

    // Expand to full 3x3 grid when no hit OR when an unloaded adjacent tile is closer than current hit / maxRadius
    const effectiveLimit = bestHit ? bestHit.distMeters : maxRadiusMeters;
    if (!bestHit || (minUnloadedEdgeDist <= maxRadiusMeters && minUnloadedEdgeDist < effectiveLimit)) {
      const full3x3: TileCoord[] = [];
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          const tx = c.tx + dx;
          const ty = c.ty + dy;
          if (tx >= 0 && tx < n && ty >= 0 && ty < n) {
            full3x3.push({ tx, ty });
          }
        }
      }
      if (full3x3.length > primaryTiles.length) {
        graph = await this.graphBuilder.buildGraphForTiles(full3x3, mode);
        bestHit = this.findClosestEdgeInGraph(graph, lon, lat, maxRadiusMeters);
      }
    }

    if (!bestHit) return null;

    return {
      lon: bestHit.coord[0],
      lat: bestHit.coord[1],
      clickLon: lon,
      clickLat: lat,
      distFromClickMeters: Math.round(bestHit.distMeters),
      roadLabel: bestHit.edge.roadLabel,
      roadClass: bestHit.edge.roadClass,
      mode,
    };
  }

  private lonLatToTileFloat(lon: number, lat: number, zoom: number): { x: number; y: number } {
    const n = 1 << zoom;
    const clampedLat = Math.max(-85.0511, Math.min(85.0511, lat));
    const latRad = (clampedLat * Math.PI) / 180;
    const x = ((lon + 180) / 360) * n;
    const y = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n;
    return { x, y };
  }

  private buildTileCorridor(
    a: { lon: number; lat: number },
    b: { lon: number; lat: number },
    padTiles: number
  ): TileCoord[] {
    const n = 1 << ROUTING_TILE_ZOOM;
    const fa = this.lonLatToTileFloat(a.lon, a.lat, ROUTING_TILE_ZOOM);
    const fb = this.lonLatToTileFloat(b.lon, b.lat, ROUTING_TILE_ZOOM);

    // Supercover grid traversal along line segment fa -> fb so diagonal corridors don't explode AABB size
    const steps = Math.max(
      1,
      Math.ceil(Math.max(Math.abs(fb.x - fa.x), Math.abs(fb.y - fa.y)) * 4)
    );
    const tileMap = new Map<string, TileCoord>();

    const stamp = (cx: number, cy: number) => {
      for (let dx = -padTiles; dx <= padTiles; dx++) {
        for (let dy = -padTiles; dy <= padTiles; dy++) {
          const tx = cx + dx;
          const ty = cy + dy;
          if (tx >= 0 && tx < n && ty >= 0 && ty < n) {
            const key = `${tx}/${ty}`;
            if (!tileMap.has(key)) {
              tileMap.set(key, { tx, ty });
            }
          }
        }
      }
    };

    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const fx = fa.x + (fb.x - fa.x) * t;
      const fy = fa.y + (fb.y - fa.y) * t;
      stamp(Math.floor(fx), Math.floor(fy));
    }

    return Array.from(tileMap.values());
  }

  /**
   * Finds the shortest mode-appropriate highway path between two snapped points using corridor A*.
   */
  async routeBetweenSnappedPoints(
    fromPt: Pick<SnappedPoint, 'lon' | 'lat'>,
    toPt: Pick<SnappedPoint, 'lon' | 'lat'>,
    mode: PlanningMode
  ): Promise<RouteLegResult> {
    if (haversineMeters([fromPt.lon, fromPt.lat], [toPt.lon, toPt.lat]) < 1.5) {
      return {
        found: true,
        coordinates: [
          [fromPt.lon, fromPt.lat],
          [toPt.lon, toPt.lat],
        ],
        distanceKm: 0,
        legType: 'network',
        roadLabels: [],
      };
    }

    const MAX_CORRIDOR_TILES = 81;
    let lastReason: RouteLegResult['reason'] = 'disconnected';

    for (const pad of [1, 2, 3]) {
      const tiles = this.buildTileCorridor(fromPt, toPt, pad);
      if (tiles.length > MAX_CORRIDOR_TILES) {
        if (pad === 1) {
          lastReason = 'tile-budget-exceeded';
        }
        break;
      }

      const graph = await this.graphBuilder.buildGraphForTiles(tiles, mode);
      const fromHit = this.findClosestEdgeInGraph(graph, fromPt.lon, fromPt.lat, 35);
      const toHit = this.findClosestEdgeInGraph(graph, toPt.lon, toPt.lat, 35);

      if (!fromHit || !toHit) {
        lastReason = 'no-highway-near-point';
        continue;
      }

      const path = this.runAStarWithVirtualSplits(graph, fromHit, toHit);
      if (path) {
        return path;
      }
      lastReason = 'disconnected';
    }

    return {
      found: false,
      reason: lastReason,
      coordinates: [],
      distanceKm: 0,
      legType: 'network',
      roadLabels: [],
    };
  }

  private runAStarWithVirtualSplits(
    graph: RoadGraph,
    fromHit: ProjectedEdgeHit,
    toHit: ProjectedEdgeHit
  ): RouteLegResult | null {
    const START_ID = '__PLAN_START__';
    const END_ID = '__PLAN_END__';

    const virtualAdj = new Map<
      string,
      Array<{ edge: GraphEdge; toNode: string; reverse: boolean }>
    >();
    const virtualCoords = new Map<string, [number, number]>();
    virtualCoords.set(START_ID, fromHit.coord);
    virtualCoords.set(END_ID, toHit.coord);

    const pushAdj = (from: string, item: { edge: GraphEdge; toNode: string; reverse: boolean }) => {
      let arr = virtualAdj.get(from);
      if (!arr) {
        const base = graph.adjacency.get(from);
        arr = base ? [...base] : [];
        virtualAdj.set(from, arr);
      }
      arr.push(item);
    };

    const suppressedEdgeIds = new Set<string>();
    const edgeCounter = { seq: 0 };

    const addChainEdges = (
      baseEdge: GraphEdge,
      splits: Array<{ nodeId: string; hit?: ProjectedEdgeHit; isEdgeStart?: boolean; isEdgeEnd?: boolean }>
    ) => {
      for (let i = 0; i < splits.length - 1; i++) {
        const a = splits[i];
        const b = splits[i + 1];
        const startSplit = a.isEdgeStart
          ? { segIdx: 0, coord: baseEdge.coords[0] }
          : { segIdx: a.hit!.segIdx, coord: a.hit!.coord };
        const endSplit = b.isEdgeEnd
          ? {
              segIdx: baseEdge.coords.length - 2,
              coord: baseEdge.coords[baseEdge.coords.length - 1],
            }
          : { segIdx: b.hit!.segIdx, coord: b.hit!.coord };

        const subCoords = sliceEdgeCoords(baseEdge, startSplit, endSplit);
        let len = 0;
        for (let c = 0; c < subCoords.length - 1; c++) {
          len += haversineMeters(subCoords[c], subCoords[c + 1]);
        }

        const subEdge: GraphEdge = {
          id: `${baseEdge.id}-v${edgeCounter.seq++}`,
          fromNode: a.nodeId,
          toNode: b.nodeId,
          coords: subCoords,
          lengthMeters: len,
          costMeters: len * baseEdge.costMultiplier,
          costMultiplier: baseEdge.costMultiplier,
          forwardAllowed: baseEdge.forwardAllowed,
          reverseAllowed: baseEdge.reverseAllowed,
          roadLabel: baseEdge.roadLabel,
          roadClass: baseEdge.roadClass,
        };

        if (baseEdge.forwardAllowed) {
          pushAdj(a.nodeId, { edge: subEdge, toNode: b.nodeId, reverse: false });
        }
        if (baseEdge.reverseAllowed) {
          pushAdj(b.nodeId, { edge: subEdge, toNode: a.nodeId, reverse: true });
        }
      }
    };

    if (fromHit.edge.id === toHit.edge.id) {
      const edge = fromHit.edge;
      suppressedEdgeIds.add(edge.id);
      const firstIsStart = fromHit.alongMeters <= toHit.alongMeters;
      const chain = firstIsStart
        ? [
            { nodeId: edge.fromNode, isEdgeStart: true },
            { nodeId: START_ID, hit: fromHit },
            { nodeId: END_ID, hit: toHit },
            { nodeId: edge.toNode, isEdgeEnd: true },
          ]
        : [
            { nodeId: edge.fromNode, isEdgeStart: true },
            { nodeId: END_ID, hit: toHit },
            { nodeId: START_ID, hit: fromHit },
            { nodeId: edge.toNode, isEdgeEnd: true },
          ];
      addChainEdges(edge, chain);
    } else {
      suppressedEdgeIds.add(fromHit.edge.id);
      suppressedEdgeIds.add(toHit.edge.id);
      addChainEdges(fromHit.edge, [
        { nodeId: fromHit.edge.fromNode, isEdgeStart: true },
        { nodeId: START_ID, hit: fromHit },
        { nodeId: fromHit.edge.toNode, isEdgeEnd: true },
      ]);
      addChainEdges(toHit.edge, [
        { nodeId: toHit.edge.fromNode, isEdgeStart: true },
        { nodeId: END_ID, hit: toHit },
        { nodeId: toHit.edge.toNode, isEdgeEnd: true },
      ]);
    }

    const getCoord = (nodeId: string): [number, number] | undefined => {
      const vc = virtualCoords.get(nodeId);
      if (vc) return vc;
      const gn = graph.nodes.get(nodeId);
      return gn ? [gn.lon, gn.lat] : undefined;
    };

    const getNeighbors = (nodeId: string) => {
      const vList = virtualAdj.get(nodeId);
      if (vList) return vList;
      return graph.adjacency.get(nodeId) || [];
    };

    const endCoord = toHit.coord;
    const heuristic = (nodeId: string): number => {
      const c = getCoord(nodeId);
      return c ? haversineMeters(c, endCoord) * 0.8 : 0;
    };

    const gScore = new Map<string, number>();
    const cameFrom = new Map<
      string,
      { prevNode: string; edge: GraphEdge; reverse: boolean }
    >();
    const closed = new Set<string>();
    const open = new MinBinaryHeap();

    gScore.set(START_ID, 0);
    open.push({ nodeId: START_ID, f: heuristic(START_ID), g: 0 });

    while (open.size > 0) {
      const current = open.pop()!;
      if (current.nodeId === END_ID) {
        // Reconstruct path
        const steps: Array<{ edge: GraphEdge; reverse: boolean }> = [];
        let cur = END_ID;
        while (cur !== START_ID) {
          const parent = cameFrom.get(cur);
          if (!parent) break;
          steps.push({ edge: parent.edge, reverse: parent.reverse });
          cur = parent.prevNode;
        }
        steps.reverse();

        const coordinates: Array<[number, number]> = [];
        let totalMeters = 0;
        const labelSet = new Set<string>();

        for (const step of steps) {
          if (step.edge.roadLabel) labelSet.add(step.edge.roadLabel);
          totalMeters += step.edge.lengthMeters;
          const pts = step.reverse ? [...step.edge.coords].reverse() : step.edge.coords;
          for (const pt of pts) {
            const prev = coordinates[coordinates.length - 1];
            if (!prev || prev[0] !== pt[0] || prev[1] !== pt[1]) {
              coordinates.push(pt);
            }
          }
        }

        if (coordinates.length < 2) {
          return null;
        }

        return {
          found: true,
          coordinates,
          distanceKm: Number((totalMeters / 1000).toFixed(3)),
          legType: 'network',
          roadLabels: Array.from(labelSet),
        };
      }

      if (closed.has(current.nodeId)) continue;
      closed.add(current.nodeId);

      const neighbors = getNeighbors(current.nodeId);
      for (const n of neighbors) {
        if (suppressedEdgeIds.has(n.edge.id)) continue;
        if (closed.has(n.toNode)) continue;

        const tentativeG = current.g + n.edge.costMeters;
        const prevBest = gScore.get(n.toNode);
        if (prevBest === undefined || tentativeG < prevBest) {
          gScore.set(n.toNode, tentativeG);
          cameFrom.set(n.toNode, {
            prevNode: current.nodeId,
            edge: n.edge,
            reverse: n.reverse,
          });
          open.push({
            nodeId: n.toNode,
            g: tentativeG,
            f: tentativeG + heuristic(n.toNode),
          });
        }
      }
    }

    return null;
  }
}

export const routePlannerEngine = new ClientRoutePlannerEngine();
