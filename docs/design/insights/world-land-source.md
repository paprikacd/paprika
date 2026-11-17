# World land outline

The connection map uses Natural Earth 1:110m land polygons, released in the public domain. No borders or locations are inferred from this outline. Query-supplied coordinates use the same equirectangular projection.

- Source: https://raw.githubusercontent.com/nvkelso/natural-earth-vector/693f11422f4e08d2da4566b854dda53eb7c39fb3/geojson/ne_110m_land.geojson
- Terms: https://www.naturalearthdata.com/about/terms-of-use/
- Source SHA256: 9e0729ee253ca7d7a5c4ae9395fb1902264c5377c52e224d13dd85010e2835d9
- Conversion: each longitude/latitude vertex becomes `x=(longitude+180)*2`, `y=(90-latitude)*2`; round to 0.1 SVG units, remove consecutive duplicate vertices, join each polygon ring with `M/L/Z`. SVG viewBox is `0 0 720 360`, even-odd fill preserves holes.
- Generated asset: `ui/src/features/insights/plugins/world-land.ts`; 127 polygon features. No runtime map service, network request or geolocation lookup.
