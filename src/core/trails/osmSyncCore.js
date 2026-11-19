export const TRAIL_COLOR_TO_OSM = {
  '#dc2626': 'red',
  '#ea580c': 'orange',
  '#ca8a04': 'yellow',
  '#16a34a': 'green',
  '#2563eb': 'blue',
  '#7c3aed': 'purple',
  '#334155': 'black',
};

export function mapTrailColorToOsmName(hexColor) {
  if (!hexColor || typeof hexColor !== 'string') return null;
  return TRAIL_COLOR_TO_OSM[hexColor.trim().toLowerCase()] || null;
}

export function xmlEscape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function parseXmlAttrs(attrString) {
  const attrs = {};
  const re = /([A-Za-z0-9_:-]+)="([^"]*)"/g;
  let m;
  while ((m = re.exec(attrString)) !== null) {
    attrs[m[1]] = m[2]
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&');
  }
  return attrs;
}

export function parseOsmWayFullXml(xml, targetWayId) {
  const nodes = new Map();
  const nodeRe = /<node\s+([^>]+?)\s*(?:\/>|>([\s\S]*?)<\/node>)/g;
  let nm;
  while ((nm = nodeRe.exec(xml)) !== null) {
    const attrs = parseXmlAttrs(nm[1]);
    nodes.set(Number(attrs.id), {
      id: Number(attrs.id),
      lat: Number(attrs.lat),
      lon: Number(attrs.lon),
      version: Number(attrs.version || 1),
    });
  }

  const wayRe = new RegExp(`<way\\s+([^>]*\\bid="${targetWayId}"[^>]*)>([\\s\\S]*?)<\\/way>`);
  const wm = wayRe.exec(xml);
  if (!wm) {
    throw new Error(`OSM way ${targetWayId} not found in API response.`);
  }
  const wayAttrs = parseXmlAttrs(wm[1]);
  const body = wm[2];

  const ndRefs = [];
  const ndRe = /<nd\s+([^>]+?)\s*\/>/g;
  let ndm;
  while ((ndm = ndRe.exec(body)) !== null) {
    const attrs = parseXmlAttrs(ndm[1]);
    ndRefs.push(Number(attrs.ref));
  }

  const tags = {};
  const tagRe = /<tag\s+([^>]+?)\s*\/>/g;
  let tm;
  while ((tm = tagRe.exec(body)) !== null) {
    const attrs = parseXmlAttrs(tm[1]);
    tags[attrs.k] = attrs.v;
  }

  return {
    id: Number(wayAttrs.id),
    version: Number(wayAttrs.version),
    ndRefs,
    tags,
    nodes,
  };
}

export function buildChangesetXml({ comment, userUid, userName }) {
  const tags = [
    ['created_by', 'NavApp-Tools'],
    ['comment', comment || 'Sync community road from NavApp'],
    ['source', 'NavApp community survey'],
    ['navapp:user_uid', userUid],
    ['navapp:user_name', userName || userUid],
  ];
  return [
    '<osm>',
    '  <changeset>',
    ...tags.map(([k, v]) => `    <tag k="${xmlEscape(k)}" v="${xmlEscape(v)}"/>`),
    '  </changeset>',
    '</osm>',
  ].join('\n');
}

function haversineMeters(a, b) {
  const R = 6371008.8;
  const lat1 = (a[1] * Math.PI) / 180;
  const lat2 = (b[1] * Math.PI) / 180;
  const dLat = lat2 - lat1;
  const dLon = ((b[0] - a[0]) * Math.PI) / 180;
  const s1 = Math.sin(dLat / 2);
  const s2 = Math.sin(dLon / 2);
  const h = s1 * s1 + Math.cos(lat1) * Math.cos(lat2) * s2 * s2;
  return 2 * R * Math.atan2(Math.sqrt(h), Math.sqrt(Math.max(0, 1 - h)));
}

function buildUpdatedTags(existingTags, road, trailAnnotation) {
  const tags = { ...existingTags };
  tags.highway = road.highwayClass;
  if (road.name) tags.name = road.name;
  if (road.highwayClass === 'track' && road.tracktype) tags.tracktype = road.tracktype;
  if (road.surface) tags.surface = road.surface;
  if (road.oneway === 1) tags.oneway = 'yes';
  else if (road.oneway === -1) tags.oneway = '-1';
  else if (road.kind === 'osm-override' && 'oneway' in tags) delete tags.oneway;
  if (road.description) tags.description = road.description;

  if (!road.allow4x4) tags.motor_vehicle = 'no';
  if (!road.allowFoot) tags.foot = 'no';
  if (!road.allowBicycle) tags.bicycle = 'no';

  const osmColor = mapTrailColorToOsmName(trailAnnotation?.color);
  if (osmColor) {
    tags.colour = osmColor;
    tags['osmc:symbol'] = `${osmColor}:white:${osmColor}_stripe`;
    if (trailAnnotation?.number) tags.ref = trailAnnotation.number;
  }
  return tags;
}

/**
 * Builds an OsmChange 0.6 XML payload for either a new road (`kind === 'new'`)
 * or an in-place edit of an existing OSM way (`kind === 'osm-override'`).
 */
export function buildOsmChangeXml({
  changesetId,
  road,
  trailAnnotation = null,
  existingTargetWays = new Map(),
}) {
  const createNodes = [];
  const modifyWays = [];
  let nextTempId = -1;

  if (road.kind === 'osm-override') {
    const numericId = Number(String(road.sourceOsmWayId || '').replace('osm:way:', ''));
    const existing = existingTargetWays.get(numericId);
    if (!existing) {
      throw new Error(`Missing fetched OSM way ${numericId} for osm-override ${road.id}.`);
    }
    const tags = buildUpdatedTags(existing.tags, road, trailAnnotation);

    const modifyNodes = [];
    const usedExistingIds = new Set();
    const matchedIdxToNodeId = new Array(road.coordinates.length).fill(null);

    // 1. Match unchanged coordinates (within 2.5m) to their existing OSM node IDs
    for (let i = 0; i < road.coordinates.length; i++) {
      const coord = road.coordinates[i];
      let bestId = null;
      let bestDist = 2.5;
      for (const nid of existing.ndRefs) {
        if (usedExistingIds.has(nid)) continue;
        const node = existing.nodes.get(nid);
        if (!node) continue;
        const d = haversineMeters(coord, [node.lon, node.lat]);
        if (d <= bestDist) {
          bestDist = d;
          bestId = nid;
        }
      }
      if (bestId !== null) {
        matchedIdxToNodeId[i] = bestId;
        usedExistingIds.add(bestId);
      }
    }

    // 2. If same vertex count, reuse unmatched existing node ID at the same index via <modify><node>
    //    Otherwise create new <node> elements for inserted/added vertices
    const ndRefs = [];
    const sameLength = road.coordinates.length === existing.ndRefs.length;
    for (let i = 0; i < road.coordinates.length; i++) {
      if (matchedIdxToNodeId[i] !== null) {
        ndRefs.push(matchedIdxToNodeId[i]);
        continue;
      }
      const [lon, lat] = road.coordinates[i];
      if (sameLength) {
        const origNid = existing.ndRefs[i];
        const origNode = existing.nodes.get(origNid);
        if (origNode && !usedExistingIds.has(origNid)) {
          usedExistingIds.add(origNid);
          ndRefs.push(origNid);
          modifyNodes.push(
            `    <node id="${origNode.id}" version="${origNode.version}" lat="${lat.toFixed(7)}" lon="${lon.toFixed(7)}" changeset="${changesetId}"/>`
          );
          continue;
        }
      }
      const tempId = nextTempId--;
      createNodes.push(
        `    <node id="${tempId}" lat="${lat.toFixed(7)}" lon="${lon.toFixed(7)}" changeset="${changesetId}"/>`
      );
      ndRefs.push(tempId);
    }

    const wayXml = [
      `    <way id="${existing.id}" version="${existing.version}" changeset="${changesetId}">`,
      ...ndRefs.map((ref) => `      <nd ref="${ref}"/>`),
      ...Object.entries(tags).map(([k, v]) => `      <tag k="${xmlEscape(k)}" v="${xmlEscape(v)}"/>`),
      `    </way>`,
    ].join('\n');
    modifyWays.push(wayXml);

    const xmlLines = ['<osmChange version="0.6" generator="NavApp-Tools">'];
    if (createNodes.length > 0) {
      xmlLines.push('  <create>', ...createNodes, '  </create>');
    }
    xmlLines.push('  <modify>', ...modifyNodes, ...modifyWays, '  </modify>', '</osmChange>');
    return xmlLines.join('\n');
  }

  // Clone targetWay entries before mutating ndRefs for T-junction splits
  const workingTargets = new Map();
  for (const [k, v] of existingTargetWays.entries()) {
    workingTargets.set(k, { ...v, ndRefs: [...v.ndRefs] });
  }

  // kind === 'new': create new nodes & way, reusing/inserting junction nodes on existing OSM ways
  const anchorByVertex = new Map((road.anchors || []).map((a) => [a.vertexIndex, a]));
  const wayNodeRefs = [];

  for (let i = 0; i < road.coordinates.length; i++) {
    const [lon, lat] = road.coordinates[i];
    const anchor = anchorByVertex.get(i);
    if (anchor && anchor.targetWayId.startsWith('osm:way:')) {
      const targetOsmId = Number(anchor.targetWayId.replace('osm:way:', ''));
      const targetWay = workingTargets.get(targetOsmId);
      if (targetWay) {
        if (anchor.snapType === 'vertex') {
          let bestNodeId = null;
          let bestDist = 15;
          for (const nid of targetWay.ndRefs) {
            const node = targetWay.nodes.get(nid);
            if (!node) continue;
            const d = haversineMeters([lon, lat], [node.lon, node.lat]);
            if (d < bestDist) {
              bestDist = d;
              bestNodeId = nid;
            }
          }
          if (bestNodeId !== null) {
            wayNodeRefs.push(bestNodeId);
            continue;
          }
        }
        // T-junction segment split: create new node and insert into existing OSM way
        const junctionId = nextTempId--;
        createNodes.push(
          `    <node id="${junctionId}" lat="${lat.toFixed(7)}" lon="${lon.toFixed(7)}" changeset="${changesetId}"/>`
        );
        wayNodeRefs.push(junctionId);

        let bestInsertAfter = 0;
        let bestMidDist = Infinity;
        for (let s = 0; s < targetWay.ndRefs.length - 1; s++) {
          const nA = targetWay.nodes.get(targetWay.ndRefs[s]);
          const nB = targetWay.nodes.get(targetWay.ndRefs[s + 1]);
          if (!nA || !nB) continue;
          const midDist =
            haversineMeters([lon, lat], [nA.lon, nA.lat]) +
            haversineMeters([lon, lat], [nB.lon, nB.lat]) -
            haversineMeters([nA.lon, nA.lat], [nB.lon, nB.lat]);
          if (midDist < bestMidDist) {
            bestMidDist = midDist;
            bestInsertAfter = s;
          }
        }
        const updatedRefs = [...targetWay.ndRefs];
        updatedRefs.splice(bestInsertAfter + 1, 0, junctionId);
        targetWay.ndRefs = updatedRefs;
        continue;
      }
    }

    const tempId = nextTempId--;
    createNodes.push(
      `    <node id="${tempId}" lat="${lat.toFixed(7)}" lon="${lon.toFixed(7)}" changeset="${changesetId}"/>`
    );
    wayNodeRefs.push(tempId);
  }

  for (const [, targetWay] of workingTargets) {
    // Only emit modify if we actually inserted a junction node
    const hasTempNode = targetWay.ndRefs.some((ref) => ref < 0);
    if (!hasTempNode) continue;
    modifyWays.push(
      [
        `    <way id="${targetWay.id}" version="${targetWay.version}" changeset="${changesetId}">`,
        ...targetWay.ndRefs.map((ref) => `      <nd ref="${ref}"/>`),
        ...Object.entries(targetWay.tags).map(
          ([k, v]) => `      <tag k="${xmlEscape(k)}" v="${xmlEscape(v)}"/>`
        ),
        `    </way>`,
      ].join('\n')
    );
  }

  const newWayId = nextTempId--;
  const newTags = buildUpdatedTags({}, road, trailAnnotation);
  const newWayXml = [
    `    <way id="${newWayId}" changeset="${changesetId}">`,
    ...wayNodeRefs.map((ref) => `      <nd ref="${ref}"/>`),
    ...Object.entries(newTags).map(([k, v]) => `      <tag k="${xmlEscape(k)}" v="${xmlEscape(v)}"/>`),
    `    </way>`,
  ].join('\n');

  const lines = [
    '<osmChange version="0.6" generator="NavApp-Tools">',
    '  <create>',
    ...createNodes,
    newWayXml,
    '  </create>',
  ];
  if (modifyWays.length > 0) {
    lines.push('  <modify>', ...modifyWays, '  </modify>');
  }
  lines.push('</osmChange>');
  return lines.join('\n');
}

export async function osmFetch(url, options = {}, token = '') {
  const headers = {
    ...(options.headers || {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
  if (typeof window === 'undefined') {
    headers['User-Agent'] = 'NavApp-Tools/1.0';
  }
  const res = await fetch(url, { ...options, headers });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`OSM API ${res.status} ${res.statusText} (${url}): ${text.slice(0, 300)}`);
  }
  return text;
}

export async function prepareRoadOsmContext(road, osmApiBase) {
  const targetIds = new Set();
  if (road.kind === 'osm-override' && road.sourceOsmWayId) {
    targetIds.add(Number(String(road.sourceOsmWayId).replace('osm:way:', '')));
  }
  for (const a of road.anchors || []) {
    if (typeof a.targetWayId === 'string' && a.targetWayId.startsWith('osm:way:')) {
      targetIds.add(Number(a.targetWayId.replace('osm:way:', '')));
    }
  }
  const existingTargetWays = new Map();
  for (const tid of targetIds) {
    const fullXml = await osmFetch(`${osmApiBase}/api/0.6/way/${tid}/full`);
    existingTargetWays.set(tid, parseOsmWayFullXml(fullXml, tid));
  }
  return existingTargetWays;
}

export function extractSyncedWayFromDiffResult(diffResult, road) {
  const ways = [];
  const wayRe = /<way\s+([^>]+?)\s*\/?>/g;
  let m;
  while ((m = wayRe.exec(diffResult)) !== null) {
    ways.push(parseXmlAttrs(m[1]));
  }
  const sourceId = String(road.sourceOsmWayId || '').replace('osm:way:', '');
  const matched =
    road.kind === 'osm-override'
      ? ways.find((w) => w.old_id === sourceId || w.new_id === sourceId) ||
        ways.find((w) => w.new_id)
      : ways.find((w) => typeof w.old_id === 'string' && w.old_id.startsWith('-') && w.new_id) ||
        ways.find((w) => w.new_id);

  const osmWayId = matched?.new_id
    ? Number(matched.new_id)
    : Number(sourceId);
  const osmVersion = matched?.new_version ? Number(matched.new_version) : 1;
  return { osmWayId, osmVersion };
}

export async function pushRoadToOsmApi({
  road,
  osmApiBase,
  osmToken,
  actorUid,
  actorName,
}) {
  if (!osmToken) {
    throw new Error('נדרש טוקן התחברות ל-OpenStreetMap (היקף write_api).');
  }
  const existingTargetWays = await prepareRoadOsmContext(road, osmApiBase);
  const csXml = buildChangesetXml({
    comment: road.name
      ? `NavApp: ${road.name} (${road.highwayClass})`
      : `NavApp: ${road.highwayClass}`,
    userUid: actorUid,
    userName: actorName || actorUid,
  });
  const csIdStr = await osmFetch(
    `${osmApiBase}/api/0.6/changeset/create`,
    { method: 'PUT', body: csXml, headers: { 'Content-Type': 'text/xml' } },
    osmToken
  );
  const changesetId = Number(csIdStr.trim());
  let diffResult = '';
  try {
    const uploadXml = buildOsmChangeXml({
      changesetId,
      road,
      trailAnnotation: road.trailAnnotation || null,
      existingTargetWays,
    });
    diffResult = await osmFetch(
      `${osmApiBase}/api/0.6/changeset/${changesetId}/upload`,
      { method: 'POST', body: uploadXml, headers: { 'Content-Type': 'text/xml' } },
      osmToken
    );
  } catch (err) {
    await osmFetch(
      `${osmApiBase}/api/0.6/changeset/${changesetId}/close`,
      { method: 'PUT' },
      osmToken
    ).catch(() => {});
    throw err;
  }

  await osmFetch(
    `${osmApiBase}/api/0.6/changeset/${changesetId}/close`,
    { method: 'PUT' },
    osmToken
  );

  const { osmWayId, osmVersion } = extractSyncedWayFromDiffResult(diffResult, road);
  return { changesetId, osmWayId, osmVersion };
}
