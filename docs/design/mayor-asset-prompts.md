# Mayor site asset specifications

Date: 2026-09-23

## Deliverables

All final assets are independent raster files in `public/assets/mayor/`. Original outputs were copied without resizing, image processing or alpha conversion. The original files remain in the generation output directory. Interface labels, controls and charts should be authored in HTML rather than baked into these assets.

| File | Dimensions | Format | Intended use |
| --- | --- | --- | --- |
| `astana-panorama.png` | 2060 × 763 | RGB PNG | Wide decorative introductory background, with calm space on the left and above the skyline. |
| `planning-icon.png` | 1254 × 1254 | RGBA PNG | Large planning card illustration; genuine transparent background. |
| `dialogue-icon.png` | 1254 × 1254 | RGBA PNG | Large dialogue card illustration; genuine transparent background. |

## Production parameters and validation

- Execution mode: built-in image generation, one separate call per file. The available tool does not expose a model/version selector or return a verified model version; the requested “GPT Images 2.5” version is therefore not asserted.
- Art direction: quiet architectural editorial imagery; warm ivory, deep pine green, brushed warm brass; natural photographic texture in the panorama and tactile material detail in the icons.
- Every output was visually inspected at its native aspect ratio. The panorama has no lettering or interface elements. The icon silhouettes are fully visible and contain no labels, logos or pedestals.
- RGBA format and actual alpha-zero background pixels were verified in both icons. Original generated alpha was preserved.
- The panorama is a decorative architectural interpretation of Astana, not a surveyed geographic reconstruction or a documentary city photograph. It must not be used to establish landmark locations.
- The icon illustrations suit large cards and section introductions. Small navigation controls should use simple vector glyphs for clarity.

## Exact prompts

### astana-panorama.png

```text
Use case: photorealistic-natural.
Asset type: wide editorial website background for an elegant civic planning portal used by mayors in Kazakhstan.
Primary request: Create an exceptionally polished architectural panorama of Astana, Kazakhstan with the recognisable Baiterek tower, the Ishim river and contemporary central Astana buildings. The scene should feel photographed by a top architecture magazine: dignified, human, quiet, completely believable physical architecture and city scale.
Composition: cinematic wide landscape around 2.7:1. A refined view from the riverside with a generous pale airy sky across the top half; keep the left quarter especially calm and uncluttered so dark interface copy can sit over it. Baiterek is in the middle-to-right distance, of credible proportions. Natural river reflections and quiet waterfront planting frame the city without blocking it. The skyline should retain crisp realistic material detail, not look like a generic futuristic megacity.
Lighting and mood: gentle clear September morning or late afternoon golden light, fine atmospheric distance, soft natural shadows, confident and welcoming.
Palette: restrained warm ivory sky, golden sunlight, subdued deep pine and teal greenery/reflections, warm neutral stone, believable glass.
Constraints: no text, no letters, no logos, no seals, no interface, no people featured, no watermark. Avoid oversaturation, neon, fantasy towers, excessive monuments, artificial symmetry, painterly textures, stock marketing gloss, fisheye perspective, cartoon or toy proportions. Deliver a high-resolution landscape raster background with natural photographic texture.
```

### planning-icon.png

```text
Use case: stylized-concept.
Asset type: separate transparent PNG editorial navigation illustration for a beautifully crafted Kazakhstan civic planning website.
Primary request: Create one small sophisticated sculptural isometric city block for the "Planning" section, an original premium tactile architectural miniature.
Subject: a restrained cluster of four elegant rectilinear civic buildings of varied height, three in warm chalk ivory limestone, one slender mid-rise in very deep pine green matte material. Precise tiny recessed windows, refined architectural detail. A short thin brushed warm brass pathway threads gracefully between the buildings and creates one expressive curve. Just two very small organically shaped deep green miniature trees to suggest a considered public space.
Composition: a single compact cohesive object, three-quarter isometric perspective, generous transparent breathing room on every side. Use true orthographic-like architectural projection. The object fills about 70 percent of a square image and is fully visible.
Materials: tactile warm ivory stone and matte pine-green enamel with subtle realistic roughness, brushed brass, delicate bevels. Museum design object, not a toy or a game asset.
Lighting: large soft studio light upper-left, carefully formed ambient occlusion inside the object, understated premium craft.
Background: genuinely transparent alpha background. No floor, no base slab, no pedestal, no environment, no white backdrop, no checkerboard drawn into the image. Any fine contact shading belongs only to the object and fades cleanly into full alpha.
Constraints: exactly one isolated coherent object, no text, no letters, no labels, no logo, no watermarks, no map pins, no bright plastic, no glossy chrome, no cartoon outlines, no blue neon. It must remain clear and dignified at card illustration size.
```

### dialogue-icon.png

```text
Use case: stylized-concept.
Asset type: separate transparent PNG editorial navigation illustration for a beautifully crafted Kazakhstan civic planning website.
Primary request: Create one exquisite compact sculptural object representing civic dialogue: two tactile three-dimensional speech tiles, made as premium physical design objects.
Subject: two overlapping solid speech-bubble tiles, each a softly rounded rectangular slab with one simple short speech tail. The slightly taller rear tile is warm chalk ivory limestone; the front tile is very deep pine green matte ceramic. Both tiles are completely blank. One small inset brushed warm brass circular point sits subtly near the top right of the pine tile as a single accent. The two forms form a calm balanced conversation, with enough separation to read the silhouette at small sizes.
Style and materials: subtle realistic limestone grain on ivory, matte pine ceramic with restrained satin edges, fine brushed brass point. Delicate bevels. High-end architectural editorial product render, sculptural and tactile, no glossy plastic.
Composition: one isolated cohesive pair, three-quarter isometric view consistent with a museum architectural miniature, centered in a square with generous genuinely transparent breathing room on every side. Entire object visible, roughly 68 percent image coverage. The shapes float without a platform; no floor or base.
Lighting: soft studio light from upper left, realistic gentle shading and fine material detail. Refined warmth.
Background: genuinely transparent alpha background, clean alpha around every outer edge, no background color, no white rectangle, no simulated checkerboard. The tile interiors should be fully opaque and solid.
Constraints: no text, no letters, no dots indicating typing, no labels, no logo, no watermark, no frame, no pedestal, no environment, no people, no phones, no blue neon, no cartoon outlines. Exactly two speech tiles and one small brass accent point.
```
