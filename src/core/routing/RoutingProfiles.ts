export type PlanningMode = '4x4' | 'foot' | 'bicycle';

export interface PlanningModeMeta {
  id: PlanningMode;
  labelHe: string;
  shortLabelHe: string;
  color: string;
  maxSnapRadiusMeters: number;
}

export const PLANNING_ROUTE_COLOR = '#2563eb';

export const PLANNING_MODE_META: Record<PlanningMode, PlanningModeMeta> = {
  '4x4': {
    id: '4x4',
    labelHe: 'רכב 4x4',
    shortLabelHe: '4x4',
    color: PLANNING_ROUTE_COLOR,
    maxSnapRadiusMeters: 500,
  },
  foot: {
    id: 'foot',
    labelHe: 'הליכה רגלית',
    shortLabelHe: 'רגלי',
    color: PLANNING_ROUTE_COLOR,
    maxSnapRadiusMeters: 450,
  },
  bicycle: {
    id: 'bicycle',
    labelHe: 'אופניים / MTB',
    shortLabelHe: 'אופניים',
    color: PLANNING_ROUTE_COLOR,
    maxSnapRadiusMeters: 450,
  },
};

export interface EdgeAccessDecision {
  allowed: boolean;
  forwardAllowed: boolean;
  reverseAllowed: boolean;
  costMultiplier: number;
  roadLabel: string;
}

const NON_ROUTABLE_CLASSES = new Set([
  'pier',
  'rail',
  'ferry',
  'aerialway',
  'raceway',
  'busway',
  'bus_guideway',
]);

const MOTORABLE_PAVED_CLASSES = new Set([
  'motorway',
  'trunk',
  'primary',
  'secondary',
  'tertiary',
  'minor',
  'unclassified',
  'residential',
  'living_street',
  'service',
]);

function normTag(val: unknown): string {
  return typeof val === 'string' ? val.trim().toLowerCase() : '';
}

function parseOneway(raw: unknown): 1 | -1 | 0 {
  if (raw === 1 || raw === '1' || raw === true || raw === 'yes' || raw === 'true') {
    return 1;
  }
  if (raw === -1 || raw === '-1' || raw === 'reverse') {
    return -1;
  }
  return 0;
}

function buildRoadLabel(cls: string, subclass: string, props: Record<string, any>): string {
  if (cls === 'track') {
    const tt = normTag(props.tracktype);
    return tt ? `דרך עפר (${tt})` : 'דרך עפר / 4x4';
  }
  if (cls === 'path') {
    if (subclass === 'cycleway') return 'שביל אופניים';
    if (subclass === 'footway') return 'שביל הולכי רגל';
    if (subclass === 'pedestrian') return 'מדרחוב';
    if (subclass === 'steps') return 'מדרגות';
    return 'שביל שטח';
  }
  if (cls === 'motorway') return 'כביש מהיר';
  if (cls === 'trunk') return 'כביש ראשי';
  if (cls === 'primary') return 'כביש ראשי';
  if (cls === 'secondary') return 'כביש אזורי';
  if (cls === 'tertiary') return 'כביש מקומי';
  if (cls === 'service') return 'דרך שירות';
  return 'כביש / רחוב';
}

export function evaluateEdgeAccess(
  props: Record<string, any> | undefined,
  mode: PlanningMode
): EdgeAccessDecision {
  if (!props) {
    return {
      allowed: false,
      forwardAllowed: false,
      reverseAllowed: false,
      costMultiplier: 1,
      roadLabel: '',
    };
  }

  const cls = normTag(props.class);
  const subclass = normTag(props.subclass);
  if (!cls || cls.endsWith('_construction') || NON_ROUTABLE_CLASSES.has(cls)) {
    return {
      allowed: false,
      forwardAllowed: false,
      reverseAllowed: false,
      costMultiplier: 1,
      roadLabel: '',
    };
  }

  const access = normTag(props.access);
  const foot = normTag(props.foot);
  const bicycle = normTag(props.bicycle);
  const motorVehicle = normTag(props.motor_vehicle);
  const motorcar = normTag(props.motorcar);
  const mtbScale = normTag(props.mtb_scale);
  const tracktype = normTag(props.tracktype);
  const hasSpniMark = Boolean(normTag(props.colour) || normTag(props.osmc_symbol));
  const oneway = parseOneway(props.oneway);
  const roadLabel = buildRoadLabel(cls, subclass, props);

  if (mode === '4x4') {
    const isTrack = cls === 'track';
    const isMotorRoad = MOTORABLE_PAVED_CLASSES.has(cls);
    if (!isTrack && !isMotorRoad) {
      return {
        allowed: false,
        forwardAllowed: false,
        reverseAllowed: false,
        costMultiplier: 1,
        roadLabel,
      };
    }

    const motorExplicitYes = motorVehicle === 'yes' || motorcar === 'yes';
    const motorBlocked =
      motorVehicle === 'no' ||
      motorcar === 'no' ||
      (access === 'no' && !motorExplicitYes);
    if (motorBlocked) {
      return {
        allowed: false,
        forwardAllowed: false,
        reverseAllowed: false,
        costMultiplier: 1,
        roadLabel,
      };
    }

    let costMultiplier = 1.0;
    if (isTrack) {
      if (tracktype === 'grade4') costMultiplier = 1.05;
      else if (tracktype === 'grade5') costMultiplier = 1.1;
    } else if (cls === 'service') {
      costMultiplier = 1.2;
    } else if (cls === 'motorway' || cls === 'trunk') {
      costMultiplier = 1.05;
    }

    if ((access === 'private' || motorVehicle === 'private') && !motorExplicitYes) {
      costMultiplier *= 5.0;
    }

    // Dirt tracks are bidirectional; paved roads respect OSM oneway tags
    const forwardAllowed = isTrack ? true : oneway !== -1;
    const reverseAllowed = isTrack ? true : oneway !== 1;

    return {
      allowed: true,
      forwardAllowed,
      reverseAllowed,
      costMultiplier,
      roadLabel,
    };
  }

  if (mode === 'foot') {
    const footExplicitYes =
      foot === 'yes' || foot === 'designated' || foot === 'permissive';

    if (cls === 'motorway' || cls === 'trunk') {
      if (!footExplicitYes) {
        return {
          allowed: false,
          forwardAllowed: false,
          reverseAllowed: false,
          costMultiplier: 1,
          roadLabel,
        };
      }
    } else if (cls !== 'path' && cls !== 'track' && !MOTORABLE_PAVED_CLASSES.has(cls)) {
      return {
        allowed: false,
        forwardAllowed: false,
        reverseAllowed: false,
        costMultiplier: 1,
        roadLabel,
      };
    }

    if (foot === 'no' || (access === 'no' && !footExplicitYes)) {
      return {
        allowed: false,
        forwardAllowed: false,
        reverseAllowed: false,
        costMultiplier: 1,
        roadLabel,
      };
    }

    let costMultiplier = 1.0;
    if (cls === 'path') {
      if (subclass === 'cycleway') costMultiplier = 1.15;
      else costMultiplier = hasSpniMark ? 0.85 : 0.9;
    } else if (cls === 'track') {
      costMultiplier = hasSpniMark ? 0.9 : 0.95;
    } else if (cls === 'minor' || cls === 'unclassified' || cls === 'residential' || cls === 'living_street' || cls === 'service') {
      costMultiplier = 1.1;
    } else if (cls === 'tertiary') {
      costMultiplier = 1.35;
    } else if (cls === 'secondary') {
      costMultiplier = 1.65;
    } else if (cls === 'primary' || cls === 'trunk' || cls === 'motorway') {
      costMultiplier = 2.0;
    }

    if (access === 'private' && !footExplicitYes) {
      costMultiplier *= 5.0;
    }

    return {
      allowed: true,
      forwardAllowed: true,
      reverseAllowed: true,
      costMultiplier,
      roadLabel,
    };
  }

  // mode === 'bicycle'
  const bikeExplicitYes =
    bicycle === 'yes' ||
    bicycle === 'designated' ||
    bicycle === 'permissive' ||
    bicycle === 'mtb' ||
    Boolean(mtbScale);

  if (cls === 'path') {
    if (subclass === 'steps' && bicycle !== 'yes' && bicycle !== 'designated') {
      return {
        allowed: false,
        forwardAllowed: false,
        reverseAllowed: false,
        costMultiplier: 1,
        roadLabel,
      };
    }
    if (
      (subclass === 'footway' || subclass === 'pedestrian' || subclass === 'platform') &&
      !bikeExplicitYes
    ) {
      return {
        allowed: false,
        forwardAllowed: false,
        reverseAllowed: false,
        costMultiplier: 1,
        roadLabel,
      };
    }
  } else if (cls === 'motorway' || cls === 'trunk') {
    if (!bikeExplicitYes) {
      return {
        allowed: false,
        forwardAllowed: false,
        reverseAllowed: false,
        costMultiplier: 1,
        roadLabel,
      };
    }
  } else if (cls !== 'track' && !MOTORABLE_PAVED_CLASSES.has(cls)) {
    return {
      allowed: false,
      forwardAllowed: false,
      reverseAllowed: false,
      costMultiplier: 1,
      roadLabel,
    };
  }

  if (bicycle === 'no' || (access === 'no' && !bikeExplicitYes)) {
    return {
      allowed: false,
      forwardAllowed: false,
      reverseAllowed: false,
      costMultiplier: 1,
      roadLabel,
    };
  }

  let costMultiplier = 1.0;
  if (cls === 'path') {
    costMultiplier = subclass === 'cycleway' || bikeExplicitYes ? 0.85 : 0.95;
  } else if (cls === 'track') {
    costMultiplier = 0.95;
  } else if (
    cls === 'minor' ||
    cls === 'unclassified' ||
    cls === 'residential' ||
    cls === 'living_street' ||
    cls === 'service'
  ) {
    costMultiplier = 1.1;
  } else if (cls === 'tertiary') {
    costMultiplier = 1.3;
  } else if (cls === 'secondary') {
    costMultiplier = 1.6;
  } else if (cls === 'primary' || cls === 'trunk' || cls === 'motorway') {
    costMultiplier = 2.0;
  }

  if (access === 'private' && !bikeExplicitYes) {
    costMultiplier *= 5.0;
  }

  const isBidirectionalType =
    cls === 'track' ||
    cls === 'path' ||
    subclass === 'cycleway';
  const forwardAllowed = isBidirectionalType ? true : oneway !== -1;
  const reverseAllowed = isBidirectionalType ? true : oneway !== 1;

  return {
    allowed: true,
    forwardAllowed,
    reverseAllowed,
    costMultiplier,
    roadLabel,
  };
}
