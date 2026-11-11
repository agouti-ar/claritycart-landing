# Open product showcase

Replaces only the landing hero illustration/controller. Existing backend, widget, pricing, admin and auth flows are unchanged. Previous full index saved locally in `.vercel/hero-backups/index-before-open-showcase.html` (excluded from public build).

Three illustrative categories: lighting, furniture, jewellery. Fixed sample facts/questions/answers demonstrate grounding; these are not live AI calls or claims about an actual merchant product. No events, usage or analytics are written by this scene.

One 12-second clock per category: arrival → question → checking → answer → action → exit. Category controls seek this clock; pause/play is explicit. Hover does not stop playback. Offscreen/hidden tabs pause the clock; reduced motion shows a static answer. Missing WebGL uses a simple symbolic fallback and retains the conversation and controls.

Lamp and ring are original procedural models; the chair uses the **SheenChair** asset, by **Eric Chadwick / Wayfair, LLC (2020)**, model licensed **CC0-1.0**. Source: https://github.com/KhronosGroup/glTF-Sample-Assets/tree/main/Models/SheenChair . Original license is included at `assets/hero/chair-license.md` (metadata license CC-BY-4.0). A procedural chair is retained as a load fallback. Demonstration product facts are illustrative, not specifications of that sample model.

Three.js r128 and its matching GLTFLoader are vendored for consistency with the existing runtime and to remove the hero's runtime CDN dependency. MIT license included at `assets/hero/three-license.txt`. No new npm dependencies. Explicit public build allowlist includes only the specified hero runtime, model and license files. Model size is approximately 4.1 MB; this remains an optimization opportunity before production.

Verification: `node --test tests/hero-showcase.test.js tests/themes.test.js`, `npm run build`, JS syntax and inline-script checks. Visual/browser observations are reported separately; unit tests do not measure FPS or prove visual quality.

## November 3 polish

The category heading fades on the same clock (350 ms) before its content changes. Explicit category selection on pause still shows a readable frame. A visible demo cart receives the miniature using its actual DOM center projected into the 3D plane; its counter changes only after arrival (9.3 s) and resets for the next product. This represents **add to cart**, not checkout or a confirmed payment. No real commerce events are emitted.

Navigation spacing and hero typography adapt below 640 px; mobile cart and theme controls remain accessible. Cursor parallax is deliberately deferred to preserve the readable, calm motion. Timing remains 12 seconds per product. The source model is unchanged (4.1 MB); lossy asset compression was not introduced during visual polish.

An exact pre-polish copy of index/controller/CSS/build script is kept locally under `.vercel/hero-backups/open-showcase-before-polish-20261103/`, outside the public build.
