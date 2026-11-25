# Intraday replay and strike centers

Replay reads the existing owner-private append-only archive. It does not contact MenthorQ or Futu, import later data, change the current map, or reconstruct missing positions.

## User path

Choose a New York calendar date and Browse captures. The timeline steps through actual saved MenthorQ capture times. From/To handles bound the time window; arrows shift it; the main bar and previous/next buttons choose a saved capture. Return to latest restores the current lens. Live quote cards above stay separate from the historical chart and strike detail, which carry a replay banner.

Each historical context retains its provider dates, mode, clocks, exposure coverage and delay labels. Capture times drive ordering because source clocks may be unknown. Omitted intervals are not interpolated. Older level-only records can be replayed without claiming numerical exposure existed. Some historic records have no compatible Futu model inputs; their curves and flows stay unavailable.

The price-window slider pans the plotted price range independently from both time selection and the scenario price. Build/fade boundaries use the full strike profile and do not change merely because the view is panned. Historical time steps can change them when compatible saved IV, remaining time or option coverage changes. This is a snapshot replay, not a tick feed.

Planets and wall artwork are anchored at exact strike x-coordinates. The sprites use lighting, a shadow and exposure sizing; the chart has a dark space background so curves remain legible. Selecting a planet changes the explored strike. The removed introductory paragraph and three-step explanatory block stay removed; source details are collapsed.

## Read-only API

- `GET /api/replay?market=NQ&underlyingCode=US.NQ2612&date=YYYY-MM-DD[&cursor=...]`: at most25 indexed MenthorQ archive metadata rows per page. Native R2 reverse-time key seeking bounds lookup to the requested date, with NY DST boundaries.
- `GET /api/replay/snapshot?market=NQ&underlyingCode=US.NQ2612&id=...`: selected context plus latest compatible earlier archived Futu quotes/IV, when available. Contract identity and archive envelope identity are checked. Records are capped at16MiB and candidate searches are bounded; limitations are returned as notes.

Quote, IV, Greek, OI, baseline and comparison clocks later than the cutoff are excluded or nulled. The historical model clock is frozen at the chosen capture. Live overlays and today's historical-volume profile are not injected into replay. Historical gamma positions remain provider estimates or explicit hedge scenarios, not observed dealer books.

## Background asset

`frontend/galaxy-field.png` was created with the built-in image generation tool from the user's Milky Way reference. Prompt: original wide dark navy deep-space starfield, dim diagonal blue-gray Milky Way dust, tiny restrained stars, dark quiet center for readable chart overlays; no planets, black holes, writing, axes, frames or UI. Opaque image. The original remains under Codex generated_images and the project copy is bundled with the private Site.
