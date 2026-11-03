# ML-R1 Representation and Model-Input Contract

## Status and scope

This document records the explicit Tier A / Tier B / Tier C representation boundary for dataset version 2. It preserves the accepted M1–M4B and StrictCBCZigZag behavior; it does not change feature or teacher calculations.

The repository does not contain a frozen Phase 4A or Phase 4B specification. The available frozen Phase 2J feature manifest defines causal M1 observations and validity masks. This document records the representation decision applied to the exporter and should be read alongside the Phase 2J manifest.

## Information tiers

### Tier A — causal market observations

`Continuous_Observations.csv` is the canonical Tier A observation artifact. Each accepted M1 source candle contributes one row with its causal M1 feature values and validity mask, data-quality metadata, and (for the integrated 1m export) completed 15m/1h context. The MTF data retains completion timestamps, availability, age, warmup, validity, and diagnostics from the existing M3 pipeline.

The event representation also contains these six Tier A event-window summaries, computed only from accepted rows after the previous pivot confirmation through the current pivot confirmation, inclusive:

| Field | Source and calculation | Availability |
|---|---|---|
| `context_net_return_atr` | Close of the current confirmation candle minus open of the first context candle, divided by ATR-14 at confirmation | Current confirmation boundary |
| `context_max_favorable_atr` | Maximum accepted context high minus first context open, divided by ATR-14 at confirmation | Current confirmation boundary |
| `context_max_adverse_atr` | First context open minus minimum accepted context low, divided by ATR-14 at confirmation | Current confirmation boundary |
| `context_candle_count` | Number of accepted candles in that closed context interval | Current confirmation boundary |
| `context_relative_volume` | Mean of valid M1 `RelativeVolume_20` observations in the context interval; `-1` when none are valid | Current confirmation boundary |
| `context_relative_volume_valid_fraction` | Valid `RelativeVolume_20` observations divided by context candle count | Current confirmation boundary |

These are completed historical observations at the teacher confirmation boundary, not forward outcomes. The full M1/MTF feature sequence remains in the continuous artifact; the event representation does not independently reconstruct or duplicate M3 features.

Each event representation row carries `tierA_observation_id`, a non-feature alignment key to the exact completed observation at that event's confirmation index. A model-input loader joins this key to `Continuous_Observations.csv` to obtain the M1 values, validity/data-quality fields, and completed MTF context. The key is metadata, not a tensor feature; it is independently checked against the accepted row by the auditor.

### Tier B — confirmed structural teacher information

The model-input CSV selects exactly the following six descriptors in a separately named `tierB_` channel:

| Field | Native source and calculation | Earliest availability | Future information |
|---|---|---|---|
| `pivot_type` | Current event's native `StrictCBCZigZagIndicator.cachedPivots` record type | The pivot's `confirmedBarIndex` close | None; it is the already-confirmed event |
| `pivot_label` | The same native record's HH/LH/HL/LL label | The pivot's `confirmedBarIndex` close | None; it is the label assigned by the teacher to that confirmed pivot |
| `completed_leg_direction` | Sign of current native pivot price minus preceding native pivot price (`up`, `down`, or `flat`) | The current pivot's confirmation close | None; both pivots are confirmed |
| `zigzag_next_leg_orientation` | Structural convention: HIGH → `down`, LOW → `up` | The current pivot's confirmation close | No forecast; it names the structurally following leg orientation |
| `bars_since_last_pivot` | Current confirmation index minus preceding pivot confirmation index | The current pivot's confirmation close | None; both indices are known |
| `leg_distance_atr` | Current pivot price minus preceding pivot price, divided by the authoritative ATR-14 at current confirmation | The current pivot's confirmation close | None; all inputs are available at confirmation |

The source timestamp of a confirming candle is its open time. The descriptor becomes available only when that candle completes, at its exclusive observation close boundary. The export's next-open boundary is aligned to that completion time. The auditor independently checks each descriptor against the native confirmed-pivot sequence and accepted observation rows.

### Tier C — future outcomes and execution results

Forward returns, horizon/maturity data, barriers, entry/exit prices, net R, outcome classes, execution results, and outcome validity/completion metadata remain in the separate Events artifact. They are not selected into the representation CSV or the versioned model-input channels. Exact representation headers and scalar-only model-input validation prevent unknown or nested Tier C fields from entering those channels.

## Versioning and compatibility

| Contract | Previous | Current |
|---|---|---|
| Dataset / observation identity version | 1 | 2 |
| Representation schema | `MLR1_REPRESENTATION_V1` (unversioned/ambiguous Tier A label) | `MLR1_REPRESENTATION_V2` |
| Model-input schema | `MLR1_MODEL_INPUT_V1` (unversioned/ambiguous Tier A label) | `MLR1_MODEL_INPUT_V2` |
| M1 feature, StrictCBCZigZag teacher, and outcome calculations | Existing versions | Unchanged |

The representation CSV now prefixes feature columns with `tierA_` or `tierB_` and includes the non-feature `tierA_observation_id` join key; this is a semantic and serialized-schema change. Existing version-1 datasets remain interpretable as historical artifacts, but their representation classification must be treated as legacy/ambiguous. Model-input artifacts should be regenerated before training against the version-2 contract. Historical experiment records must not be overwritten.

The combined Events file remains an archival/label artifact and is not an alternate model-input source. A future tensor loader must select Tier A and Tier B through the manifest's explicit schema versions and channel definitions; it must not infer features from the Events file.
