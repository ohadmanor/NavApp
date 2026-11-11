# Fix Missing Israeli Nature Reserves & National Parks in Tilemaker (`Israel.osm.pmtiles`)

## 1. Context & Problem Summary

In the current `Israel.osm.pmtiles`, the `park` vector layer only contains **47 named polygon features** (all emitted with `class="nature_reserve"`, zero `"national_park"`, zero `"protected_area"`). Every one of those 47 features happened to have `leisure="nature_reserve"` in OpenStreetMap — even National Parks like `גן לאומי מגדל אפק` that also carried `leisure=nature_reserve`.

Meanwhile, across Israel (`29.45–33.35°N`, `34.2–35.9°E`), OpenStreetMap contains **494** protected-area / reserve / national-park features, ~410+ of which are **missing** because:
1. Official OSM Israel tagging guidelines use **`boundary="protected_area"` + `protect_class` + `protection_title` (without `leisure="nature_reserve"`)**.
2. Several major National Parks are mapped as **`type="boundary"` relations** rather than `type="multipolygon"`, so Tilemaker does not automatically pass them to `way_function()`.
3. The consuming NavApp style (`src/core/style/navappLayer.json`) only draws reserve/park **borders and border casings** when `park.class` is `"national_park"` or `"nature_reserve"`.

---

## 2. Actual OSM Israel Tagging Breakdown (494 Elements)

| Geometry / Relation Type | `boundary` | `leisure` | `protect_class` | `protection_title` | Count | Notes / Examples |
| :--- | :--- | :--- | :--- | :--- | :---: | :--- |
| Closed way | `protected_area` | *(none)* | `1` | `Nature Reserve` | 202 | e.g. `שמורת טבע מצוק הצינים` (`way/318954262`) |
| `relation` (`type=multipolygon`) | `protected_area` | *(none)* | `1` | `Nature Reserve` | 100 | e.g. `שמורת טבע עין גדי`, `הר מירון`, `יהודיה` |
| Closed way | `protected_area` | *(none)* | `2` | `National Park` | 77 | e.g. `גן לאומי עין-עבדת`, `מצדה` |
| `relation` (`type=multipolygon`) | `protected_area` | *(none)* | `2` | `National Park` | 29 | — |
| Closed way / `multipolygon` | *(none or `protected_area`)* | `nature_reserve` | *(various/none)* | *(various/none)* | ~42 | Previously the **only** ones included (all forced to `nature_reserve`) |
| **`relation` (`type=boundary`)** | `protected_area` | *(none)* | `2` | `National Park` | **4** | `הר הכרמל` (`4759745`), `בית-שאן` (`5917822`), `עבדת` (`5927348`), `חצור` (`5931545`) |
| Closed way / `multipolygon` | `protected_area` | *(none)* | `22` | `National Monument` | 16 | Israeli `אתר לאומי` sites (e.g. Castel, Khan Mazkeret Batya) + Petra |
| Closed way | `protected_area` | *(none)* | `2` or *(none)* | *(missing)* | ~8 | e.g. `גן לאומי אקווה בלה` (`way/320295882`), Wadi Rum (`243200322`) |
| `relation` (`type=boundary`) | `protected_area` | *(none)* | `98` | `World Heritage Convention` | 1 | `העיר העתיקה בירושלים וחומותיה` (`7880713`) — usually exclude |

---

## 3. Target PMTiles Contract (Required by NavApp)

1. **Vector layer name & geometry**: `park`, emitted as filled polygon (`Layer("park", true)`).
2. **`class` attribute** (exact values expected by NavApp's style filters):
   - `boundary-park` (`line`, `minzoom: 9`) and `boundary-park-casing` (`line`, `minzoom: 13`) strictly filter:
     ```json
     ["in", "class", "national_park", "nature_reserve"]
     ```
   - `name-park` (`symbol`, `minzoom: 9`) filters:
     ```json
     ["in", "class", "national_park", "nature_reserve", "protected_area"]
     ```
   - Therefore, emit **`"national_park"`** or **`"nature_reserve"`** on `park` features — if you emit `"protected_area"`, `"national_monument"`, `"forest_reserve"`, or omit `class`, NavApp will **not draw the dashed green borders/casing** (without also editing NavApp's style JSON).
3. **Name attributes**:
   - `name:latin` is required (populated via `SetNameAttributes()`; used by both `name-park` label fallback and NavApp's `pmtilesSearchCore.js` search indexer).
   - Including `"he"` and `"en"` in `additional_languages` (emitting `name:he` and `name:en`) enables bilingual Hebrew + English two-line labels in `name-park`.
4. **Zoom range**:
   - In the Tilemaker JSON config, keep `layers.park.minzoom <= 9` (current archive uses `minzoom: 4`, `maxzoom: 14`; do **not** use stock OpenMapTiles `minzoom: 11` or reserves will be invisible at z9–z10).
   - Call `SetMinZoomByArea()` (or `SetMinZoomByAreaWithLimit(...)`) per feature so large reserves appear at lower zooms and small reserves appear by z9–z14 without bloating z4 tiles.

---

## 4. Missing Parameters & Changes Needed in Tilemaker Lua

### A. If `way_keys` is defined, include `"boundary"` and `"leisure"`
In Tilemaker, `way_keys` filters ways and `type=multipolygon` relations during pre-scan before Lua runs. Ensure both `"boundary"` and `"leisure"` are in `way_keys` (omit or update accordingly if no `way_keys` whitelist is used).

### B. Accept `type="boundary"` protected areas in `relation_scan_function()`
Currently Tilemaker only passes `type="multipolygon"` to `way_function()`. To prevent Tilemaker from discarding member ways of `type="boundary"` parks (`הר הכרמל`, `בית-שאן`, `עבדת`, `חצור`), `relation_scan_function()` must `Accept()` them alongside administrative boundaries.

### C. Critical: guard the existing `NextRelation()` loop in `way_function()`
Standard OpenMapTiles Lua scripts assume **only** `boundary="administrative"` relations were `Accept()`ed:
```lua
while true do
    local rel = NextRelation()
    if not rel then break end
    isBoundary = true
    admin_level = math.min(admin_level, tonumber(FindInRelation("admin_level")) or 11)
end
```
Once `protected_area` relations are also `Accept()`ed in `relation_scan_function()`, **you must guard that loop with `if FindInRelation("boundary") == "administrative" then`** — otherwise every member way of Mount Carmel, Avdat, Hatzor, and Beit She'an will be emitted into the `boundary` layer with `admin_level=11`.

### D. Add `relation_function()` for `type="boundary"` polygons
Tilemaker invokes `way_function()` for `type="multipolygon"` and `relation_function()` for non-multipolygon relations (`isNativeMP == false`). Calling `Layer("park", true)` inside `relation_function()` for `type="boundary"` builds the full MultiPolygon geometry without duplicating `multipolygon` relations.

### E. Normalize `class` with proper precedence + fallback
Check **`National Park` / `protect_class == "2"` BEFORE `leisure == "nature_reserve"`**, handle variant titles/classes (`1`, `1a`, `1b`, `3`, `4`, `5`, `6`, `Forest Reserve`, `Biosphere Reserve`, `Marine Park`), skip `protect_class == "98"` (`World Heritage Convention`), decide whether to include or skip `protect_class == "22"` (`National Monument`), and fall back to `"nature_reserve"` for named `boundary="protected_area"` polygons missing `protect_class`/`protection_title` (like `גן לאומי אקווה בלה`).

---

## 5. Reference Lua Implementation

Adapt and integrate into your existing Tilemaker `.lua` script:

```lua
-- Resolve OSM tags -> NavApp `park.class` ("national_park" | "nature_reserve") or nil to skip
local function resolve_park_class()
	local boundary = Find("boundary")
	local leisure  = Find("leisure")
	if boundary ~= "national_park" and boundary ~= "protected_area" and leisure ~= "nature_reserve" then
		return nil
	end

	local title  = Find("protection_title"):lower()
	local pclass = Find("protect_class")

	-- Exclude heritage-only overlays (e.g. Old City of Jerusalem WHC relation/7880713)
	if pclass == "98" then
		return nil
	end

	-- Optional: uncomment to exclude Israeli National Monuments (אתר לאומי, protect_class=22)
	-- if pclass == "22" or title == "national monument" then return nil end

	-- Check National Park before leisure=nature_reserve (fixes parks carrying both tags, e.g. Migdal Afek)
	if boundary == "national_park" or title == "national park" or pclass == "2" then
		return "national_park"
	end

	if title == "nature reserve"
		or title == "forest reserve"
		or title == "biosphere reserve"
		or title == "marine park"
		or leisure == "nature_reserve"
		or pclass == "1" or pclass == "1a" or pclass == "1b"
		or pclass == "3" or pclass == "4" or pclass == "5" or pclass == "6"
		or pclass == "22" then
		return "nature_reserve"
	end

	-- Fallback for named boundary=protected_area missing protect_class/title (e.g. Aqua Bella)
	if boundary == "protected_area" and Holds("name") then
		return "nature_reserve"
	end

	return nil
end

local function write_park()
	local cls = resolve_park_class()
	if not cls then return end

	Layer("park", true)
	Attribute("class", cls)
	SetNameAttributes()
	SetMinZoomByArea() -- or SetMinZoomByAreaWithLimit(4)
end
```

Hook into the three Tilemaker entrypoints:

```lua
function relation_scan_function()
	if Find("type") == "boundary" then
		local b = Find("boundary")
		if b == "administrative"
			or b == "protected_area"
			or b == "national_park"
			or Find("leisure") == "nature_reserve" then
			Accept()
		end
	end
end

function relation_function()
	-- Only non-multipolygon accepted relations reach here; multipolygons go to way_function()
	if Find("type") == "boundary" then
		write_park()
	end
end

function way_function()
	local is_closed = IsClosed()

	-- IMPORTANT: Guard existing admin boundary loop so protected_area relations are NOT added to `boundary`
	while true do
		local rel = NextRelation()
		if not rel then break end
		if FindInRelation("boundary") == "administrative" then
			isBoundary = true
			admin_level = math.min(admin_level, tonumber(FindInRelation("admin_level")) or 11)
		end
	end

	-- ... rest of existing way_function() rules ...

	if is_closed then
		write_park()
	end
end
```

---

## 6. Post-Build Verification Checklist

After regenerating `Israel.osm.pmtiles`:
1. **Verify `park` feature count & classes at z14**:
   - Count should jump from `47` to ~`450+`, containing both `class="nature_reserve"` and `class="national_park"`.
2. **Spot-check previously missing reserves/parks**:
   - Closed ways without `leisure`: `שמורת טבע מצוק הצינים`, `גן לאומי עין-עבדת`, `גן לאומי מצדה`, `גן לאומי אקווה בלה`
   - `type=multipolygon` relations without `leisure`: `שמורת טבע עין גדי`, `שמורת טבע הר מירון`, `שמורת טבע יהודיה`
   - `type=boundary` relations: `גן לאומי הר הכרמל`, `גן לאומי עבדת`, `גן לאומי בית-שאן`, `גן לאומי חצור`
   - Corrected class: `גן לאומי מגדל אפק` should now be `class="national_park"` instead of `"nature_reserve"`.
3. **Spot-check `boundary` layer**:
   - Confirm no spurious `admin_level=11` lines appeared along Mount Carmel (`הר הכרמל`) or Avdat boundaries.
4. **Rebuild NavApp's search index**:
   - In the NavApp repo, regenerate `Israel.search.idx` by running `node devops/build-pmtiles-search-index.mjs` (or `devops/upload-map-data.bat`, which runs it automatically) so all newly added reserves and parks are searchable.
