# GIS OSM Objects: PMTiles vs. Style Zoom Levels

This document provides a comprehensive mapping of GIS OpenStreetMap (OSM) objects within the application, comparing:
1. **PMTiles Zoom Level**: The zoom level at which the feature exists inside [`Israel.osm.pmtiles`](file:///c:/Develop/github/NavApp/data/Israel.osm.pmtiles).
2. **Style Zoom Level**: The `minzoom` defined in the MapLibre style sheet ([`navappLayer.json`](file:///c:/Develop/github/NavApp/src/core/style/navappLayer.json) / [`israelOutdoorStyle.ts`](file:///c:/Develop/github/NavApp/src/core/style/israelOutdoorStyle.ts)).
3. **Effective Rendering Zoom Level**: The actual zoom level at which MapLibre GL JS renders the object on the map (computed as $\max(\text{PMTiles Zoom}, \text{Style Zoom})$).

---

## Technical Context & Rendering Logic

In MapLibre GL JS:
- An object is only drawn when **both** conditions are satisfied:
  1. The vector tile pyramid in `Israel.osm.pmtiles` includes the vector layer and geometry at that zoom level.
  2. The style layer's `minzoom` rule has been reached.
- When a style layer specifies `minzoom: 0` (or omits it), the client starts drawing the feature immediately once it is present in the PMTiles archive.
- If a style layer specifies a higher `minzoom` (e.g., primary roads at `minzoom: 10`), the feature remains hidden until zoom 10 even though the geometry is already present in the PMTiles archive at zoom 4.

---

## Zoom Level Comparison Table

### 1. Polygons (Fills & 3D Extrusions)

| GIS OSM Object | OSM / Vector Layer Source | PMTiles Zoom Level (`Israel.osm.pmtiles`) | Style Zoom Level (`navappLayer.json`) | Effective Display Zoom |
| :--- | :--- | :---: | :---: | :---: |
| **Oceans & Sea** | `water` (`class: ocean`) | **z0** | **z0** | **z0** |
| **Lakes & Water Bodies** | `water` (`class: lake, reservoir`) | **z6** | **z0** | **z6** |
| **Intermittent Water Bodies** | `water` (`intermittent: 1`) | **z6** | **z0** | **z6** |
| **Landcover (Sand, Forest/Wood, Farmland, Grass, Wetland)** | `landcover` (`class: sand, wood, farmland, grass, wetland`) | **z0** *(sand/wood/grass at z6)* | **z0** | **z0 / z6** |
| **Quarries** | `landcover` (`subclass: quarry`) | **z6** | **z0** | **z6** |
| **Residential / Urban Areas** | `landuse` (`class: residential`) | **z4** | **z0** | **z4** |
| **Industrial, Substations & Plants** | `landuse` (`class: industrial, substation, plant`) | **z11** *(layer minzoom: z4)* | **z0** | **z11** |
| **Cemeteries** | `landuse` (`class: cemetery`) | **z11** *(layer minzoom: z4)* | **z0** | **z11** |
| **Military Zones / Firing Areas** | `landuse` (`class: military`) | **z11** *(layer minzoom: z4)* | **z9.5** | **z11** |
| **Administrative Areas A, B & H1** | `boundary` / `admin_area` | **z0** | **z0** | **z0** |
| **Nature Reserves & National Parks** | `park` | **z11** | **z9** *(boundary)* | **z11** |
| **Piers & Docks** | `transportation` (`class: pier`) | **z13** *(layer minzoom: z4)* | **z0** | **z13** |
| **Breakwaters** | `landuse` (`class: breakwater`) | **z11** *(layer minzoom: z4)* | **z0** | **z11** |
| **Helipads & Aprons** | `aeroway` (`class: helipad, apron`) | **z11** | **z15** | **z15** |
| **Buildings (3D Footprints & Extrusions)** | `building` | **z13** | **z13** | **z13** |

---

### 2. Lines (Roads, Tracks, Paths, Boundaries & Infrastructure)

| GIS OSM Object | OSM / Vector Layer Source | PMTiles Zoom Level (`Israel.osm.pmtiles`) | Style Zoom Level (`navappLayer.json`) | Effective Display Zoom |
| :--- | :--- | :---: | :---: | :---: |
| **International Borders & Ceasefire Lines** | `boundary` (`admin_level: 2`, Green Line, Golan) | **z0** | **z0** *(dash pattern at z8)* | **z0** |
| **Area A / B Boundary Lines** | `boundary` (`Area A, Area B, Area H1`) | **z0** | **z0** | **z0** |
| **Nature Reserve / Park Boundaries** | `park` (`class: national_park, nature_reserve`) | **z11** | **z9** *(casing at z13)* | **z11** |
| **Motorways / Freeways** | `transportation` (`class: motorway`) | **z4** | **z5** *(casing at z6)* | **z5** |
| **Trunk Highways** | `transportation` (`class: trunk`) | **z4** | **z5** *(casing at z7)* | **z5** |
| **Primary Roads** | `transportation` (`class: primary`) | **z4** | **z10** | **z10** |
| **Secondary Roads** | `transportation` (`class: secondary`) | **z9** *(layer minzoom: z4)* | **z11** | **z11** |
| **Tertiary Roads** | `transportation` (`class: tertiary`) | **z11** *(layer minzoom: z4)* | **z11** *(surface at z12)* | **z11** |
| **Minor / Residential / Service Roads** | `transportation` (`class: minor, service`) | **z12** *(layer minzoom: z4)* | **z12** *(bridges/tunnels at z13)* | **z12** |
| **4x4 / Dirt Tracks (Grades 1–5)** | `transportation` (`class: track`) | **z13** *(layer minzoom: z4)* | **z10** *(casings & tracktypes at z12–13)* | **z13** |
| **Hiking Paths & Footways** | `transportation` (`class: path, footway, pedestrian`) | **z14** *(layer minzoom: z4)* | **z11.5** *(tunnel/bridge at z13)* | **z14** |
| **Cycleways / Bike Paths** | `transportation` (`class: cycleway`) | **z14** *(layer minzoom: z4)* | **z11.5** | **z14** |
| **Steps / Stairways** | `transportation` (`subclass: steps`) | **z14** *(layer minzoom: z4)* | **z13** *(dashes at z14)* | **z14** |
| **Railways / Train Tracks** | `transportation` (`class: rail`) | **z8** *(layer minzoom: z4)* | **z11** | **z11** |
| **Rivers & Major Waterways** | `waterway` (`class: river`) | **z8** | **z0** | **z8** |
| **Streams, Canals, Ditches & Drains** | `waterway` (`class: stream, canal, ditch, drain`) | **z12** *(layer minzoom: z8)* | **z0** | **z12** |
| **Cliffs & Earth Banks** | `flood_defence` (`class: cliff, earth_bank`) | **z12** | **z9** | **z12** |
| **Walls & City Walls** | `flood_defence` (`class: wall, city_wall, dam`) | **z12** | **z11** | **z12** |
| **Fences & Barriers** | `fuel_line` (`class: fence, yes, block`) | **z12** | **z11** | **z12** |
| **Power Transmission Lines** | `fuel_line` (`class: line, minor_line`) | **z12** | **z14** | **z14** |
| **Aerialways (Cable Cars, Chair Lifts)** | `transportation` (`subclass: cable_car, gondola`) | **z12** *(layer minzoom: z4)* | **z14** | **z14** |
| **Airport Runways** | `aeroway` (`class: runway`) | **z11** | **z0** | **z11** |
| **Airport Taxiways** | `aeroway` (`class: taxiway`) | **z11** | **z13** | **z13** |
| **Marked Hiking & Regional Trails** | `transportation` / `israel-trails` | **z4** | **z5** *(regional at z11, local at z12)* | **z5 / z11** |

---

### 3. Points, POIs & Labels

| GIS OSM Object | OSM / Vector Layer Source | PMTiles Zoom Level (`Israel.osm.pmtiles`) | Style Zoom Level (`navappLayer.json`) | Effective Display Zoom |
| :--- | :--- | :---: | :---: | :---: |
| **Country Labels** | `place` (`class: country`) | **z1** *(layer minzoom: z0)* | **z0** | **z1** |
| **City Labels** | `place` (`class: city`) | **z5** *(layer minzoom: z0)* | **z0** | **z5** |
| **Town Labels** | `place` (`class: town`) | **z7** *(layer minzoom: z0)* | **z10** | **z10** |
| **Village Labels** | `place` (`class: village`) | **z9** *(layer minzoom: z0)* | **z11** | **z11** |
| **Hamlet & Farm Labels** | `place` (`class: hamlet, isolated_dwelling`) | **z12** *(layer minzoom: z0)* | **z12** | **z12** |
| **Suburb & Neighborhood Labels** | `place` (`class: suburb, neighbourhood`) | **z11–z13** *(layer minzoom: z0)* | **z13** | **z13** |
| **Mountain Peaks & Elevations** | `mountain_peak` | **z11** | **z11** | **z11** |
| **Highway Shields (Motorway & Trunk)** | `transportation_name` (`motorway, trunk`) | **z8** | **z6** | **z8** |
| **Highway Shields (Primary & Secondary)** | `transportation_name` (`primary, secondary`) | **z10 / z11** *(layer minzoom: z8)* | **z10 / z11** | **z10 / z11** |
| **Street & Road Names (Primary / Secondary / Tertiary)** | `transportation_name` | **z10–z13** *(layer minzoom: z8)* | **z11 / z11 / z12** | **z11 / z11 / z12** |
| **Minor & Service Road Names** | `transportation_name` (`minor, service`) | **z14** *(layer minzoom: z8)* | **z15** | **z15** |
| **Track & Path Names** | `transportation_name` (`track, path`) | **z13 / z14** *(layer minzoom: z8)* | **z0** | **z13 / z14** |
| **Regional & Local Trail Labels** | `transportation_name` (`network: rwn, lwn`) | **z8** | **z13** | **z13** |
| **Nature Park / Reserve Names** | `park` | **z11** | **z9** | **z11** |
| **River & Waterway Names** | `waterway` | **z8** | **z0** | **z8** |
| **Lake & Sea Names** | `water_name` | **z14** | **z0** | **z14** |
| **Water Springs, Cisterns & Pools** | `poi` (`subclass: spring, cistern, pond`) | **z12** | **z11.5** | **z12** |
| **Water Wells & Waterholes** | `poi` (`subclass: water_well, waterhole`) | **z12** | **z12** | **z12** |
| **Water Tanks & Towers** | `poi` (`subclass: water_tower, storage_tank`) | **z12** | **z12** | **z12** |
| **Drinking Water Points** | `poi` (`subclass: drinking_water`) | **z12** | **z12** | **z12** |
| **Waterfalls** | `poi` (`subclass: waterfall`) | **z12** | **z12** | **z12** |
| **Viewpoints** | `poi` (`subclass: viewpoint`) | **z12** | **z0** | **z12** |
| **Caves & Tombs** | `poi` (`subclass: cave_entrance, tomb`) | **z12** | **z0** | **z12** |
| **Ruins & Archaeological Sites** | `poi` (`subclass: ruins, archaeological_site`) | **z12** | **z0** | **z12** |
| **Memorials & Monuments** | `poi` (`subclass: memorial, monument`) | **z12** | **z0** | **z12** |
| **Places of Worship (Synagogues, Mosques, Churches)** | `poi` (`class: place_of_worship`) | **z12** | **z0** | **z12** |
| **Campsites & Picnic Sites** | `poi` (`subclass: camp_site, picnic_site`) | **z12** | **z0** | **z12** |
| **Parking Lots** | `poi` (`subclass: parking`) | **z12** | **z0** | **z12** |
| **Fuel / Gas Stations** | `poi` (`subclass: fuel`) | **z12** | **z0** | **z12** |
| **Railway Stations** | `poi` (`subclass: station`) | **z12** | **z14** | **z14** |
| **Guideposts** | `poi` (`subclass: guidepost`) | **z12** | **z0** | **z12** |
| **Notable Trees** | `poi` (`subclass: tree`) | **z12** | **z0** | **z12** |
| **High Voltage Power Towers / Pylons** | `fuel_line` (`class: tower`) | **z12** | **z14** | **z14** |
| **Building Names** | `building` | **z13** | **z16** | **z16** |
| **House Numbers** | `housenumber` | **z14** | *(not configured)* | *(not rendered)* |

