# DELTA 3 Max Plus: data catalog

**English** · [Українська](uk/DATA_CATALOG.md)

Everything the station sends over the private MQTT API, what each field means, how often it
changes, how sure we are about it, and what can be charted from it. Built from the first live
recording (`test/fixtures/20261121T171338444Z/`, ~1 h 45 min, one deliberate grid outage) and
the vendored `.proto` (`src/proto/delta3maxplus.proto`). How messages are decoded:
[DECODER.md](DECODER.md).

**Confidence**: **high** = matches the app and other fields (e.g. power = V x A);
**medium** = consistent in the recording but not cross-checked; **low** = a guess from the
name or from values that never changed. Fields that are not in the reference `.proto` are
decoded as `unknownN` (marked "local addition" in the `.proto`).

**Where it lands**: a column (`telemetry_raw.soc_pct`), a key of `telemetry_raw.extra`
(`extra.batt_w`), a key of `pack_raw.extra` (`pack.extra.power_w`), or "not stored".
Numeric `extra` keys are chartable: the dashboard reads them through `public.metric_series`
and they are listed for the "Add card" picker in the dashboard (`web/src/panels/extraMetrics.ts` in the dashboard repository).

## Why not every field in every sample

The station sends ~300 fields (≈7 KB as JSON). A sample every 10 s with all of them would be
~60 MB a day per device, past the Supabase free tier's 500 MB within a week, and most of them
are settings, ids or constants. So the data is split:

- **Every 10 s** (`telemetry_raw`, `pack_raw`, 10 days, then hourly aggregates forever): the
  columns plus the `extra` keys in the tables below, ~1.5 KB per sample.
- **Latest value of everything** (`device_state`, one row per device, upserted about once a
  minute): every decoded field of every message, plus the raw wire fields the `.proto` does not
  know (`unknown`: numbers, `f32:<float>`, hex; printable text only as `text(<length>)`), so
  nothing is lost for future decoding. Serial numbers are removed.
- **Raw MQTT payloads** stay local: `make record` writes them as fixtures for new decoding work.

Moving a field from `device_state` to the time series is a small change in
`src/decode/delta3maxplus.ts` (plus a line in the dashboard (`web/src/panels/extraMetrics.ts` in the dashboard repository)).

## Message types and update rates

| cmdFunc/cmdId | Message | Count in recording | Rate | Content |
|---|---|---|---|---|
| 254/21 | DisplayPropertyUpload | 1039 | changed fields every ~2 s, full every 120 s (device fields `displayProperty*UploadPeriod`) | power per port, SoC, grid flag, settings |
| 254/22 | RuntimePropertyUpload | 36 | changed fields every 60 s, full every 300 s (`runtimeProperty*UploadPeriod`) | voltages, currents, temperatures, firmware |
| 32/50 | BMSHeartBeatReport | 314 | every 10 s, per pack (`num`) | cells, pack V/A, capacity, SOH, lifetime counters |
| 32/2 | CMSHeartBeatReport | 314 | every 10 s | battery management summary, charge target, grid line flag |
| 50/2 | AppRuquestBpEuLawDataAck | 1 | on events (seen once, grid return) | battery passport: first use date, resistance, rated efficiency |
| 254/20 | ConfigReadAck | 8 | on events | schedule list (empty), firmware (`unknown144`) |
| 254/18 | setReply_dp3 | 6 | on events | `actionId 6`, `configOk`, `cfgUtcTime` (clock set) |
| 53/249 | not in the `.proto` | 25 | every ~2.5-5 min | always `08 02 18 01` (`{1: 2, 3: 1}`), probably a keep-alive |

The pack heartbeat (32/50, 32/2) is the steadiest source: every 10 s regardless of changes.
254/21 only sends what changed, so a quiet value can stay silent for minutes.

## Power and energy flows (254/21, 32/50)

| Field | Meaning | Unit | Changes | Confidence | Stored as |
|---|---|---|---|---|---|
| `powInSumW` | total input power | W | every ~2 s | high | `watts_in` |
| `powOutSumW` | total output power | W | every ~2 s | high | `watts_out` |
| `powGetAcIn` | AC (grid) input power | W | every ~2 s, equals `powInSumW` without solar | high | `extra.ac_in_w` |
| `powGetAcOut` | AC output power | W | **always 0 on this model** | high | used only when non-zero |
| `unknown972` (5 floats) | output power per port, negative = out | W | every ~2 s; index 2 equals `powOutSumW` while the load is on AC | medium | `extra.out_ports_w` (array, positive), `extra.ac_out_w` = index 2 |
| `powGetPv`, `powGetPv2` | solar inputs 1, 2 | W | 0 (nothing connected) | high (by name) | `extra.pv_w`, `extra.pv2_w` |
| `powGetQcusb1/2`, `powGetTypec1/2` | USB-A / USB-C outputs | W | 0 | high (by name) | `extra.usb_w` (sum) |
| `powGet_12v` | 12 V car output | W | 0 | high (by name) | `extra.dc12v_w` |
| `powGetDcp`, `powGetBms`, `powGetAc`, `powGetDc` | extra battery port, other | W | 0 | low | not stored |
| 32/50 `vol` x `amp` | pack power, + charge / − discharge | W | every 10 s | high (matches `inputWatts` / `outputWatts`) | `pack.extra.power_w`, sum of packs `extra.batt_w` |
| 32/50 `inputWatts`, `outputWatts` | pack in / out power by the BMS | W | every 10 s | high | `pack.extra.input_w`, `output_w` |
| derived `watts_in − watts_out − batt_w` | conversion losses + the station's own use | W | every sample | medium (timing of 2 s vs 10 s sources adds noise) | `extra.loss_w` |
| 32/50 `accuChgEnergy`, `accuDsgEnergy` | lifetime energy into / out of the pack | Wh | +1 Wh steps | high (≈ 40 full cycles of 2048 Wh vs `cycles` = 37) | `pack.extra.accu_chg_wh`, `accu_dsg_wh` |
| 32/50 `accuChgCap`, `accuDsgCap` | lifetime charge into / out of the pack | mAh | small steps | medium | `pack.extra.accu_chg_mah`, `accu_dsg_mah` |

`flowInfo*` fields (`flowInfoAcIn` 14 → 12 when the grid drops, `flowInfoPv` 8, ...) are
port state codes for the app's flow diagram; the grid one mirrors `plugInInfoAcInFlag`. Not
stored.

## Grid and AC (254/21, 254/22, 32/2)

| Field | Meaning | Unit | Changes | Confidence | Stored as |
|---|---|---|---|---|---|
| `plugInInfoAcInFlag` | grid present (1/0) | flag | instantly on change | high | `grid_present`, outages |
| 32/2 `v1p3.chgLinePlugInFlag` | charge line plugged in | flag | within 5-8 s of the grid change, every 10 s | high in the recording | `extra.chg_line_flag` |
| `plugInInfoAcInVol` | grid voltage | V | **every ~5 min**, stale for minutes after a change | high | `ac_in_voltage_v` (null until fresh) |
| `plugInInfoAcInAmp` | grid current | A | every ~5 min | high | `extra.ac_in_amp_a` |
| `plugInInfoAcInFeq` | grid frequency | Hz | always 0 on this model | high | `ac_in_freq_hz` = null |
| `plugInInfoAcOutVol`, `plugInInfoAcOutAmp` | AC output voltage, current | V, A | every ~5 min | high | `extra.ac_out_voltage_v`, `ac_out_amp_a` |
| `acOutFreq` / `plugInInfoAcOutFreq` | AC output frequency | Hz | constant 50 | high | `ac_out_freq_hz` |
| `plugInInfoAcInChgPowMax` | AC charge power setting | W | on change (900) | high | `extra.ac_in_chg_max_w` |

## Battery system (254/21, 254/22, 32/2)

| Field | Meaning | Unit | Changes | Confidence | Stored as |
|---|---|---|---|---|---|
| `cmsBattSoc` / 32/2 `f32LcdShowSoc` | state of charge shown in the app | % | integer on change / float every 10 s | high | `soc_pct` |
| `cmsChgDsgState` / 32/2 `v1p3.sysChgDsgState` | 0 idle, 1 discharging, 2 charging | enum | on change | high | `extra.chg_dsg_state` |
| `cmsChgRemTime`, `cmsDsgRemTime` (32/2 `chgRemainTime`, `dsgRemainTime`) | time to full / to empty | min | on change; 12927 = "not applicable" | high | `extra.chg_remain_min`, `dsg_remain_min` |
| `cmsMaxChgSoc`, `cmsMinDsgSoc` | charge / discharge limits | % | settings (90 / 10) | high | `extra.max_chg_soc_pct`, `min_dsg_soc_pct` |
| `cmsBattVol`, `cmsBattAmp` (and `bmsBattVol`, `bmsBattAmp`, `plugInInfoBmsVol`) | battery voltage / current | mV, mA | every ~5 min | high | `extra.batt_voltage_v`, `batt_current_a` |
| `cmsChgReqVol`, `cmsChgReqAmp` / 32/2 `chgVol`, `chgAmp` | charger target voltage / current limit | mV, mA | every 10 s (32/2) | medium | `extra.chg_req_v`, `chg_req_a` |
| `bmsMaxCellVol`, `bmsMinCellVol` | highest / lowest cell | mV | every ~5 min | high | pack values used instead |
| `cmsOilOnSoc`, `cmsOilOffSoc`, `cmsOilSelfStart` | generator auto start/stop SoC | % | settings (20 / 80) | medium | not stored |
| `energyBackupEn`, `energyBackupStartSoc`, `backupReverseSoc` | backup reserve | %, flag | settings | medium | not stored |
| `bmsBattSoh`, `cmsBattSoh`, `bmsDesignCap`, `cmsBattFullEnergy`, `bmsMaxMosTemp` ... in 254/21 | | | always 0 here | n/a | pack values used instead |

## Temperatures (254/22, 32/50)

| Field | Meaning | Unit | Changes | Confidence | Stored as |
|---|---|---|---|---|---|
| `tempPcsAc` | inverter (AC) stage | °C | every ~5 min (50-53 °C in the recording) | high | `extra.temp_pcs_ac_c` |
| `tempPcsDc` | DC/DC stage | °C | every ~5 min (39-44 °C) | high | `extra.temp_pcs_dc_c` |
| `tempPv`, `tempPv2` | solar input stages | °C | every ~5 min | high | `extra.temp_pv_c`, `temp_pv2_c` |
| 254/22 `unknown95` (5 floats) | five more internal sensors | °C | every ~5 min (32-36 °C) | medium (values look like temperatures; positions unknown) | `extra.temps_aux_c` (array), `extra.temp_aux_max_c` |
| 32/50 `cellTemp[]` | cell temperature sensors (4 for 16 cells) | °C | every 10 s, 1 °C steps | high | `cell_temps_c` |
| 32/50 `minMosTemp`, `maxMosTemp`, `mosTemp[]` | BMS MOSFETs (3 sensors) | °C | every 10 s | high | `min_mos_temp_c`, `max_mos_temp_c`, `pack.extra.mos_temps_c` |
| 32/50 `maxCurSensorTemp`, `curSensorTemp[]` | current shunt | °C | every 10 s | high | `pack.extra.cur_sensor_temp_c` |
| 32/50 `temp` | pack temperature | °C | every 10 s | high | `pack.extra.temp_c` |
| 32/50 `unknown87` (8 signed bytes, count in `unknown86`) | eight more pack sensors | °C | every 10 s (28-35 °C) | medium | `pack.extra.aux_temps_c` (array), `aux_temp_max_c` |
| `pcsFanLevel` / 32/2 `fanLevel` | fan speed level | level | 0 in the recording | high (by name) | `extra.fan_level` |
| 32/50 `maxEnvTemp`, `minEnvTemp`, `envTemp[]`, `heatfilmTemp[]` | ambient / heater | °C | −127 / empty = no sensor | high | not stored |

## Cells and pack (32/50, per `num`; 0 = main unit)

| Field | Meaning | Unit | Changes | Confidence | Stored as |
|---|---|---|---|---|---|
| `cellVol[]` | cell voltages (16) | mV | every 10 s | high | `cell_voltages_mv`, `cell_spread_mv` (generated) |
| `minCellVol`, `maxCellVol` | lowest / highest cell | mV | every 10 s | high | `pack.extra.cell_min_mv`, `cell_max_mv` |
| `maxVolDiff` | cell spread by the BMS | mV | every 10 s (2-36 mV, peaks while charging) | high | `pack.extra.max_vol_diff_mv` |
| `balanceState`, `balanceCmd`, `remainBalanceTime[]` | cell balancing | flag, s | 0 in the recording | high | `balance_state` |
| `vol`, `amp` | pack voltage, current (+ charge) | mV, mA | every 10 s | high | `pack.extra.voltage_mv`, `current_ma` |
| `soc`, `f32ShowSoc`, `actSoc`, `targetSoc` | pack SoC (shown / actual / BMS target) | % | every 10 s | high / medium (`targetSoc`) | `pack.soc_pct`, `pack.extra.target_soc_pct` |
| `remainCap`, `fullCap`, `designCap` | capacity left / full (measured) / design | mAh | every 10 s / rare / constant | high | `pack.extra.remain_cap_mah`, `full_cap_mah`, `design_cap_mah`; `remain_wh` = `remainCap` x `vol` |
| `soh`, `realSoh`, `cycleSoh`, `calendarSoh` | health: app value / measured / by cycles / by age | % | constant over hours | high (`soh`), medium (others) | `soh_pct`, `pack.extra.real_soh_pct`, `cycle_soh_pct`, `calendar_soh_pct` |
| `cycles` | charge cycles | count | on cycle | high | `cycles` |
| `remainTime` | pack runtime estimate | min | every 10 s | high | `pack.extra.remain_min` |
| `chgDsgState` | 0 idle, 1 discharge, 2 charge | enum | on change | high | `pack.extra.chg_dsg_state` |
| `mosState` | charge/discharge MOSFETs (2 = discharge on, 3 = both on) | bits | on change | medium | `pack.extra.mos_state` |
| `errCode`, `bmsFault`, `allErrCode`, `allBmsFault`, `bmsAlarmState1/2`, `bmsProtectState1/2`, `bmsFaultState` | errors, alarms, protections | codes | 0 in the recording | high | `pack.extra.err_code`, `bms_fault` |
| `cellSeriesNum`, `cellNtcNum`, `mosNtcNum`, `curSensorNtcNum` | 16 cells, 4 cell sensors, 3 MOSFET sensors, 1 shunt sensor | count | constant | high | not stored (shape of the arrays) |
| `bmsSn`, `packSn` | battery serials | text | constant | high | **never stored** (scrubbed from fixtures) |
| `sysVer`, `hwVer`, `productType`, `productDetail`, `cellId`, `type` | firmware / hardware ids | | constant | high | not stored |
| `diffSoc`, `ecloudOcv`, `tagChgAmp`, `bqSysStatReg`, `afeSysStatus`, `waterInFlag`, `unknown83..85` | internals | | constant | low | not stored |

## Battery passport (50/2, rare)

Sent once per event (seen when the grid came back). The exporter keeps the last values and
repeats them in every pack sample.

| Field | Meaning | Unit | Value seen | Confidence | Stored as |
|---|---|---|---|---|---|
| `bpLaunchDate` | first use of the pack | Unix s | a date in 2026 | medium | `pack.extra.launch_ts` |
| `bpOhmRes` | internal resistance | mΩ (likely) | 15 | low on the unit | `pack.extra.ohm_res` |
| `bpRoundTripEff` | rated round trip efficiency | % | 80 | medium | `pack.extra.rated_round_trip_eff_pct` |
| `bpSelfDsgRate` | self-discharge rate | %/month (likely) | 5 | low on the unit | `pack.extra.self_dsg_rate_pct` |
| `bpPowerCapability` | power capability | kW (likely) | 2.6 | low | `pack.extra.power_capability` |
| `deepDsgCnt` | deep discharges | count | 0 | medium | `pack.extra.deep_dsg_count` |
| `highTempChgTime`, `highTempUseTime`, `lowTempChgTime`, `lowTempUseTime` | time charged / used at high / low temperature | unknown unit | 0 | medium | `pack.extra.high_temp_chg_time`, ... |
| `accuChg*`, `accuDsg*`, `bpCycles`, `soh` | same as in 32/50 | | | high | from 32/50 |

## Settings and identity (254/21, 254/22)

Constant unless the user changes them. Not stored as time series; worth showing as a
"device settings" card later.

- Standby timers: `acStandbyTime` (1440 min), `dcStandbyTime` (30), `devStandbyTime` (720),
  `screenOffTime` (300 s), `lcdLight` (128), `enBeep`, `xboostEn`, `fastChargeSwitch`,
  `outputPowerOffMemory`, `bypassOutDisable`.
- Solar charge limits: `plugInInfoPv(2)ChgMaxList` (8 A at 12 V type, 18 A at 24 V type),
  `pvDcChgSettingList` (4 A per input), `plugInInfoPv(2)Type`, `...ChargerFlag`.
- Extra battery port (DCP): `plugInInfoDcp*` all 0 (`plugInInfoDcpSn` all zeros): no extra
  battery attached. With one, a second `num` in 32/50 is expected.
- Clock: `utcTimezone` (offset as hhmm, 200 = UTC+2:00), `utcTimezoneId`
  (IANA name), `utcSetMode`; 254/18 `cfgUtcTime` is the time the cloud set.
- Storm mode, time tasks (`timeTask*`, `stormPattern*`, `touModeConflictFlag`): off / empty.
- Firmware: `pdFirmVer`, `iotFirmVer` (also 254/20 `unknown144`), `bmsFirmVer` are packed
  bytes, e.g. `0x0300002D` = 3.0.0.45. `dcdcFirmVer`, `invFirmVer`, `llc*` = 0 (not reported).
- PV input voltage/current (`plugInInfoPvVol`/`Amp`, `Pv2`) and 12 V (`plugInInfo_12vVol`/`Amp`)
  read ~3.9 V / −0.3 A and ~4.4 V / 0.1 A with nothing connected (sensor offset). Stored as
  `extra.pv_v`, `pv_a`, `pv2_v`, `pv2_a` so a panel shows up once connected.
- 254/22 `unknown970` (two floats ~0.02 / ~0.08), `unknown973`, `unknown974`, `unknown220`;
  254/21 `unknown968`, `969`, `971`, `975`-`979`, `1265`-`1728`: constant, unknown, not stored.

## What the recording already shows

Numbers from the 2026-11-21 recording (one unit, AC load ~60-130 W).

- **Pass-through costs ~4 W from the battery.** With the grid on (35 min average), AC in ≈
  AC out ≈ 62 W and the pack still discharges at ~3.9 W (~70 mA x 53 V). Over a day that is ~90 Wh, so SoC drifts down
  until the station tops it up (charge limit 90 %).
- **Inverter losses matter at light load.** During the outage (10 min average) the load took
  ~78 W while the pack gave ~108 W: ~30 W lost, ~72 % efficiency, so the real runtime is
  shorter than `remain_wh / load`. `extra.loss_w` makes this visible.
- **Charging efficiency ~90 %.** After the grid came back (3 min average): ~979 W from the
  grid, ~79 W passed to the load, ~811 W into the pack (setting 900 W), ~88 W lost.
- **Lifetime pack efficiency ~92 %**: `accu_dsg_wh / accu_chg_wh` = 75.9 / 82.0 kWh.
- **Health**: `fullCap / designCap` 99.6 %, `realSoh` 96.9 %, `calendarSoh` 88 %, app `soh`
  100 %: the app shows the most optimistic one.
- **Cells are tight**: 2-5 mV spread at rest, up to 36 mV in charging peaks.
- **Grid change signals**: `plugInInfoAcInFlag` flips instantly (18:40:50 UTC off,
  18:51:01 on), `chgLinePlugInFlag` and the charge/discharge states follow within 5-8 s. The
  254/20 + 254/18 (+ 50/2) bursts are *not* the grid change: they came at session start, ~60 s
  after the outage began and ~3.5 min after it ended, i.e. when the cloud/app re-read the
  config (and set the clock). Outage detection should keep using the flag (as the exporter
  does), with `chgLinePlugInFlag` as a 10-second heartbeat cross-check.

## Chart and card ideas

| Idea | From | Notes |
|---|---|---|
| Energy flow (grid → station → load, battery ±) | `ac_in_w`, `ac_out_w`, `batt_w`, `pv_w` | stacked or Sankey-like live card |
| Losses and efficiency | `loss_w`, `ac_out_w / -batt_w` on battery, `batt_w / ac_in_w` when charging | shows the light-load inverter penalty |
| Realistic runtime | `remain_wh / (−batt_w)` vs the device's `dsg_remain_min` | the device figure uses its own model |
| Energy per day / month | hourly `extra_max` of `accu_chg_wh`, `accu_dsg_wh` (counters), `energy_in_wh` / `energy_out_wh` | bar chart, kept forever |
| Outage history | `outages` + `soc_start_pct`/`soc_end_pct`, `energy_out_wh` | duration histogram, SoC used per outage |
| Cell imbalance | `cell_spread_mv`, `max_vol_diff_mv`, `cell_min_mv`/`cell_max_mv`, heatmap of `cell_voltages_mv` | spikes while charging are normal; a growing rest spread is not |
| Weak cell finder | per cell deviation from the pack mean over weeks (`pack_hourly.cell_voltages_avg_mv`) | |
| Health over time | `real_soh_pct`, `calendar_soh_pct`, `full_cap_mah`, `cycles` | slow; hourly aggregates are enough |
| Thermal | `temp_pcs_ac_c`, `temp_pcs_dc_c`, `max_mos_temp_c`, `cell_temps_c`, aux sensors vs `watts_out` | correlate heat with load, fan level |
| Grid quality | `ac_in_voltage_v` (5-min resolution), `grid_present` ratio per day | no frequency on this model |
| Charge phase | `chg_req_v`, `chg_req_a`, `batt_current_a`, `chg_dsg_state` | CC/CV phase, charge limit hits |
| Standby drain | `batt_w` while `grid_present` and no charging | ~4 W here |
| Settings card | limits, standby timers, firmware | static, from the last sample |

## Gaps and next recordings

- Solar, USB, 12 V and an extra battery were not connected: their fields are decoded by name
  only. A recording with each one plugged in would confirm units, `unknown972` indexes and the
  second pack `num`.
- `unknown95`, `unknown87`, `unknown972` are inferred; a recording with a heavy AC load
  (fan, heater) and a USB load at the same time would pin them down.
- 53/249 is not in the `.proto`; it never changed.
