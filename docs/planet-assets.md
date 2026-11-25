# Planet and black-hole assets

Created November 7, 2026 with the built-in image generation tool from the user's two visual references. Original generated files were copied into `frontend/black-hole-lensed.png` and `frontend/planet-atlas.png`. No third-party image was embedded from the reference screenshots. Generated atlas cells are CSS sprites; physical planet sizes do not determine the data scale.

Black-hole prompt: original photorealistic isolated black-hole UI sprite, opaque black central shadow, ivory/gold edge-on accretion disk, lensed arch over the shadow and arc below, long horizontal disk, warm amber bloom, transparent background, no text/numbers/question marks/stars/frame. Reference: user's cinematic black-hole screenshot. This is cinematic lensing art rather than an observational EHT image.

Planet-atlas prompt: transparent 4-column, 2-row aligned sprite atlas. Mercury, Venus, Earth, Mars, Jupiter, Saturn, Uranus and Neptune. Equal globe diameters, consistent upper-left lighting, textured photorealistic surfaces, no writing, numbers, stars, frames or diagram lines. Reference: user's planetary infographic. The on-planet score is live HTML text, separate from the artwork.

## Data scale update

Independent `watchContext.exposure` captures are now the first source for numerical size. A Net GEX score uses `100 * abs(strike Net GEX) / max(abs(captured watched strike Net GEX))`. This is different from the provider's Absolute GEX metric. Provider display scale and independent source/capture clocks are retained; no per-point futures conversion is inferred.

Area follows the normalized score with a 28px minimum diameter for visibility. Larger numbers indicate larger exposure within that captured market watchlist, not a percentage chance or measured price impact. Black holes are wall landmarks with fixed presentation size and no numerical overlay. Legacy map-level numeric GEX remains a fallback. An explicitly labeled ordinal fallback maps provider GEX1..10 to ordinal importance100..10 on a separately labeled scale only when numerical exposure is missing; it does not create a numeric exposure. See the [official rank lesson](https://menthorq.com/academy/gamma-levels/lessons/trade-gex-levels-1-to-10/).

This supersedes the original decorative question-mark placeholders and original size contract in `gravity-visual-research.md`. The app now shows all watched option-strike levels, ordered by numerical exposure, then ordinal rank, then unavailable values. The Futu curve still shows its selected subset; selecting another eligible planet includes that strike in the curve. Probe labels carry their curve index so importance sorting cannot mismatch the halo and strike.

## Model distinction

MenthorQ Exposure is the provider's dealer-positioning/hedging estimate. Futu Greeks, IV, open interest and exact expiry feed this app's separate conditional sensitivity and hedge calculations. No claim is made that MenthorQ uses this app's OI formula or that the app knows its proprietary inventory model. No multiplication of the two model outputs is presented as measured dealer exposure.

## GEX|GRAVITY page backgrounds and entrance

The public edition uses built-in backgrounds and the original planet and black-hole artwork included with the project.

`entrance.js` chooses a built-in color palette per document and avoids immediately repeating it when session storage is available.

The black cover types the eleven brand characters, then fades as content rises in DOM order, two elements sharing each delay. The reveal spans 2,000ms, with each rise lasting 480ms and the last pair starting at 1,520ms. The cover waits at least 1,100ms for typing and at most 1,800ms for initial data/background readiness; a failed or slow data request still exposes the available loading/error state. A 4,200ms failsafe releases the cover if later application work fails. Skip intro and reduced-motion preferences reveal content immediately. Later data updates do not restart the intro or the two-second deadline.

The header and market/source/gamma summaries use plain text over the wallpaper. Connection status, provider map date, gamma scope and source-clock/delay uncertainty remain separate. MenthorQ's saved browser capture is labeled as a saved map rather than a live service connection. Data settings, imports, backups, historical replay and all model functions remain available.
