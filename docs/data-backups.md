# Private data backups

GEX Gravity uses its existing Sites R2 bucket. A separate Supabase project is
not required. Access remains owner-private, and R2 encrypts stored objects at
rest. OAuth credentials remain in their separate encrypted connection records
and are excluded from data backups.

The archive is append-only from the application's perspective: objects use a
SHA-256 content identity and conditional create, never replacement or pruning.
The normal save path awaits the archive before replacing the latest record.
If the archive fails, the save fails explicitly and the previous record remains.
These are copies in the same storage service, not an independent offsite backup.
Use **Data backups → Download all backups** to retain an independent copy.

## Included records

- Successful saved exact-contract Futu quote and option snapshots, including
  partial coverage where that was the actual saved result.
- Saved watched-series IV observations, their retained comparisons and history.
- Historical five-minute bars and completed comparison profiles.
- Provider metadata and exact futures selections.
- Every saved MenthorQ map, independently captured aggregate regime and any
  actually captured heatmap cells in that map.
- Recovered local capture files imported explicitly by the owner.

Unknown source clocks, original capture times, source dates, delay labels,
scope/coverage and null values remain unchanged. `backedUpAt` is separate from
all provider and collection timestamps. A backup is not proof of fresh data.
Failed provider attempts and in-progress jobs are not successful snapshots.
Operational leases, auth records and tokens are not archived. No data is
collected from a provider by any backup operation.

## Private endpoints

- `GET /api/backups?limit=25&cursor=...` lists one bounded archive page.
- `GET /api/backups/export?id=...` downloads one exact archive envelope.
- `GET /api/backups/export` streams all envelopes as NDJSON. A final
  `export-complete` record includes the count; its absence means the download
  was interrupted. Each envelope contains its checksum for round-trip checks.
- `POST /api/backups/checkpoint` with `{cursor}` copies one retained server
  source object per call. Continue returned cursors until `done:true`.
- `POST /api/backups/import` with `{records:[{name,value}]}` archives recognized
  historical records without updating current data. Recovery timestamps are
  preserved. Batches are limited to 30 records / 16 MiB. Recognized local
  source files use `recovered/<filename>`; large multi-market files can be
  split into `.../<market>` and `.../metadata` without dropping their envelope.

The last two endpoints require same-origin POSTs and the existing Site access
gate. There is no arbitrary R2 key reader, deletion endpoint or automatic
restore. Credentials in recovery inputs are rejected.

## Historical limits

On introduction, retained server objects and available local capture files can
be backfilled. Earlier overwritten captures with no surviving saved copy
cannot be reconstructed. Backfill never invents a source clock, synthesizes a
heatmap or marks an old map current. No automatic expiry is applied to archives.

Backups do not sync browser-only morning plans or manual readings; those keep
their existing watchlist JSON export/import workflow.
