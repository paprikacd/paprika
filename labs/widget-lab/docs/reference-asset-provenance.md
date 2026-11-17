# Reference study asset provenance

Recorded 31 October 2026. The iteration-04 reference studies use native HTML and SVG. The supplied screenshots are retained as design evidence and tracing inputs; the application does not display either screenshot as its dashboard background.

## User-supplied concepts

| Local evidence | Source | Dimensions | SHA-256 |
| --- | --- | --- | --- |
| `docs/reference/edge-watch.png` | User attachment `image(20261030-100941).png` | 1592 × 988 | `7ebe883c90ce7268416833f73a9476764d36f908fb190576e01839ea31192eb6` |
| `docs/reference/reliability-room.png` | User attachment `image(20261030-100917).png` | 1592 × 988 | `389173443f4f686d1eef84850b83bbd50d088170030461d84d95da41a7de9a15` |

The user requested literal pixel reproduction. Labels, values, dates, table content, initial open inspectors and plot composition are reproduced as an **authored synthetic concept fixture**. This is not a recovered telemetry dataset or evidence that the pictured services, addresses or incidents were observed by Paprika. The earlier analytical lab retains its separate numerical contracts.

## Trace geometry

`scripts/trace-reference-profiles.py` reads the two concept PNGs and writes four 361-point vertical profiles to `src/reference/reference-profiles.ts`. It selects visible cyan/violet pixels in bounded chart regions. It deliberately omits selection rings, inspectors and unknown regions, then reconstructs missing geometry deterministically between visible endpoints. The vector output is rendered by the trusted `reference-timeseries` registry plugin in `src/reference/ReferenceCharts.tsx`.

| Profile | Source bounds (left, top, right, bottom) | Excluded x spans |
| --- | --- | --- |
| Edge ingress | 154, 280, 1027, 388 | 638–650; 710–965 |
| Edge egress | 154, 392, 1027, 468 | 638–650; 710–965 |
| Reliability one-hour | 143, 331, 1001, 497 | 555–568; 596–822; 833–921 |
| Reliability six-hour | 143, 408, 1001, 503 | 555–568; 596–822; 833–921 |

These profiles preserve the visible curve envelope and narrow detail. They do not establish original sample cadence, integrated traffic, precision, or unseen events. Reliability's explicit unknown interval is reintroduced as nulls in the public fixture result. Initial selected values and timestamps are authored overrides matching the inspector labels. The piecewise display calibration follows the concept's tick placement; it must not be presented as a recovered physical scale.

## Typography

The new reference font binaries were retrieved from the official Google Fonts repository. URLs below identify the actual retrieval locations; they are mutable branch URLs, so local file hashes identify the exact retained assets. No immutable source revision is claimed.

| Asset | Retrieval source | SHA-256 |
| --- | --- | --- |
| `src/fonts/Roboto-Variable.ttf` | [Roboto variable font](https://raw.githubusercontent.com/google/fonts/main/ofl/roboto/Roboto%5Bwdth,wght%5D.ttf) | `d7598e12c5dbef095ff8272cfc55da0250bd07fbdecbac8a530b9b277872a134` |
| `src/fonts/RobotoCondensed-Variable.ttf` | [Roboto Condensed variable font](https://raw.githubusercontent.com/google/fonts/main/ofl/robotocondensed/RobotoCondensed%5Bwght%5D.ttf) | `dace262afcee68a5276f200d8026c57221735c0118ab5fda8c2c0d3dc409a8d0` |

Both binaries retain their **SIL Open Font License 1.1** notices in `public/fonts/`, where they ship with the static build: `Roboto-OFL.txt` and `RobotoCondensed-OFL.txt`. The notices credit the Roboto Project Authors. Their source files are [Roboto OFL](https://raw.githubusercontent.com/google/fonts/main/ofl/roboto/OFL.txt) and [Roboto Condensed OFL](https://raw.githubusercontent.com/google/fonts/main/ofl/robotocondensed/OFL.txt). The Barlow files (now in `src/fonts/`) and `public/fonts/OFL.txt` belong to the earlier lab and remain retained.

These are candidate approximations to the raster reference, not a claim that the original concepts used these exact fonts. Rendered comparison selected the existing Barlow face for body content and Roboto for titles/metric values; Roboto Condensed was evaluated but proved too narrow and is not the chosen body face. Its retained binary and license document that study asset. Self-hosting makes the chosen typography independent of a runtime Google Fonts request.

## Geographic geometry

`src/reference/world-geometry.ts` derives country outlines from **Natural Earth 1:110m Admin 0 countries**, credited as public-domain map data. The input was retrieved from the project's [country GeoJSON](https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_110m_admin_0_countries.geojson). Natural Earth's [terms of use](https://www.naturalearthdata.com/about/terms-of-use/) describe its data-use policy.

The input file contained 838,726 bytes with SHA-256 `6866c877d39cba9c357620878839b336d569f8c662d3cfab4cb1dbe2d39c977f`. The source URL tracks a mutable branch; no immutable upstream commit was recorded. Country paths are projected and rounded into native SVG path data. City locations use the same projection. The generated source retains its attribution.

The connection counts, risk categories, cluster point distributions and glow are authored synthetic fixture content in `EdgeSupporting.tsx`. They are not Natural Earth observations and do not imply that geography determines risk. Country-flag marks are native SVG compositions. Navigation and control icons reuse the existing Lucide dependency; the Paprika mark is native SVG.

## Runtime and evidence boundaries

Keep this asset provenance separate from [Paprika owner provenance](paprika-source.md), numerical fixture validation and browser verification. Asset attribution establishes where inputs came from; it does not establish screenshot fidelity, interaction accessibility, live data availability or production performance. Update the source hashes and reconstruction notes if the retained inputs or tracing procedure change.

## Additional authored profiles

`reference-mini-profiles.ts` stores six native Edge KPI/inspector path profiles generated by `scripts/trace-reference-mini-profiles.py`. `reference-reliability-profiles.ts` stores the achieved and target miniature ridges with coordinate bounds and source digest. `reference-timeline-profile.ts` samples state colours at 85 evenly distributed source-cell centres across x203–1006 and y636/657/679/701/722/744. These display fixtures do not recover original measurement cadence or health accounting. The actual reference contains variable raster cell edges; 85 is the observed approximate 9.5px pitch, not a claim of an original 85-sample query.
