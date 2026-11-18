import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadCountries, resolveCountry } from '../paths.js';
import {
  extractActivitiesFromDescription,
  extractHazardFromDescription,
  generateLuaEnrichmentLookup,
} from '../steps/pbfTagInjector.js';
import { toWslPath } from '../steps/tilemakerRunner.js';
import type { ResolvedEnrichmentBundle } from '../types.js';

describe('pbf-to-pmtiles config & enrichment injector', () => {
  it('loads default countries including israel-and-palestine', () => {
    const countries = loadCountries();
    expect(countries.length).toBeGreaterThanOrEqual(1);
    const israel = resolveCountry('israel-and-palestine');
    expect(israel.outputPrefix).toBe('Israel');
    expect(israel.pbfUrl).toContain('geofabrik.de');
  });

  it('supports custom country URL and sanitizes outputPrefix', () => {
    const custom = resolveCountry('custom', 'https://example.com/map.osm.pbf', 'My Region!');
    expect(custom.key).toBe('custom');
    expect(custom.outputPrefix).toBe('MyRegion');
    expect(custom.pbfUrl).toBe('https://example.com/map.osm.pbf');
  });

  it('extracts hazards and activities from Hebrew trail descriptions', () => {
    const desc =
      'איזור: מדבר יהודה | שמורת טבע / גן לאומי מוכרז | פעילות: אופניים, הליכה ביום | שטפונות: סגור בחשש לשטפונות | שטח אש: 926';
    expect(extractHazardFromDescription(desc)).toBe('flash_flood;firing_zone');
    expect(extractActivitiesFromDescription(desc)).toBe('foot,bicycle');
  });

  it('generates valid Lua enrichment lookup table for Tilemaker', () => {
    const bundle: ResolvedEnrichmentBundle = {
      generatedAt: new Date().toISOString(),
      countryKey: 'israel-and-palestine',
      totalRecords: 2,
      hostingRecords: 1,
      firestoreRecords: 1,
      byWayId: {
        '230594158': {
          source: 'firestore',
          id: 'ann-1',
          name: 'שביל לדוגמה',
          numbers: ['11420'],
          wayIds: ['230594158'],
          colour: 'red',
          osmcSymbol: 'red:white:red_stripe',
          description: 'תיאור "בדיקה"',
        },
      },
      byRef: {
        '11420': {
          source: 'hosting',
          id: '125',
          name: 'נחל סדום',
          numbers: ['11420'],
          wayIds: [],
          description: 'שטפונות: סגור בחשש לשטפונות',
        },
      },
      records: [],
    };

    const logs: string[] = [];
    const res = generateLuaEnrichmentLookup(bundle, (_lvl, msg) => logs.push(msg));
    expect(res.wayCount).toBe(1);
    expect(res.refCount).toBe(1);
    const lua = fs.readFileSync(res.luaPath, 'utf8');
    expect(lua).toContain('["230594158"]');
    expect(lua).toContain('colour = "red"');
    expect(lua).toContain('["11420"]');
    expect(lua).toContain('hazard = "flash_flood"');
  });

  it('converts Windows paths to WSL /mnt/<drive> paths', () => {
    expect(toWslPath('C:\\Develop\\github\\NavApp\\tools')).toBe('/mnt/c/Develop/github/NavApp/tools');
  });
});
