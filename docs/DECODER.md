# Delta 3 Max Plus decoder (M3)

**English** · [Українська](uk/DECODER.md)

Code: `src/decode/`, message definitions: `src/proto/delta3maxplus.proto` (copied from
[foxthefox/ioBroker.ecoflow-mqtt](https://github.com/foxthefox/ioBroker.ecoflow-mqtt), MIT,
license in `src/proto/LICENSE-ioBroker`). Decoded with `protobufjs`, no code generation.

The same model can also be decoded from data: [DECODER_PACKS.md](DECODER_PACKS.md).

## How a message flows

1. MQTT payload = `HeaderMessage { repeated Header header = 1 }`. One payload can carry several
   headers (the reply to a "send everything" request carries 5).
2. The `pdata` type is given by the `cmdFunc/cmdId` pair. If `encType = 1` (and `src != 32`),
   `pdata` is XORed with the low byte of `seq`.
3. The device sends full messages in reply to a request (`get_reply`, every 5 min) and
   incremental ones on its own (changed fields only). So the `Delta3MaxPlus` adapter merges them
   into the current state.

| cmdFunc/cmdId | Message | What we take |
|---|---|---|
| 254/21 | DisplayPropertyUpload | SoC (`cmsBattSoc`), input/output power (`powInSumW`/`powOutSumW`), **grid flag** `plugInInfoAcInFlag`, output frequency `acOutFreq` |
| 254/22 | RuntimePropertyUpload | AC input and output voltage/current, PCS temperatures, battery voltage and current |
| 32/50 | BMSHeartBeatReport | per pack (`num`, 0 = main unit): `cellVol[]`, `cellTemp[]`, SOH, cycles, MOSFET, balancing |
| 32/2 | CMSHeartBeatReport | BMS summary (only a fallback source of SoC for now) |
| 254/18, 254/20, 50/2 | setReply / ConfigReadAck / BpEuLawDataAck | arrive in a burst when the grid changes; not stored |
| 53/249 | unknown | 4 bytes, ignored |

## What the live fixtures showed (2026-11-21)

- **One pack** (`num = 0`, `bmsIsConnt = [3,0,0]`), **16 cells** (`cellSeriesNum = 16`),
  **4 cell temperature sensors** (`cellNtcNum = 4`) and 3 MOSFET sensors. So
  `pack_raw.cell_temps_c` has 4 elements (index = sensor), not 16.
- **Grid**: `plugInInfoAcInFlag` changes instantly (down at 20:40:50, back at 20:51:01
  local time). `plugInInfoAcInVol` is updated only every ~5 min and keeps showing 242 V for a few
  minutes after the grid is gone, so `grid_present` comes from the flag, and the voltage is
  stored as `null` until the first fresh value after a change.
- **Input frequency** `plugInInfoAcInFeq` is always 0 on this model, so `ac_in_freq_hz = null`.
  Output frequency `acOutFreq = 50`.
- SOH: `soh = 100` (as in the app), while `realSoh ≈ 96.9` and `calendarSoh = 88` go to `extra`.
- Battery serials (`bmsSn`, `packSn`) sit inside `pdata`, so fixture recording now also learns
  them from decoded messages, and the existing fixtures were scrubbed again.

## Common model

`src/model/types.ts`: `TelemetrySample`, `PackSample`, `DeviceAdapter`. A device adapter turns
its messages into these types, and the DB writer only knows them. The adapter comes with a
device plugin ([DEVICE_PLUGINS.md](DEVICE_PLUGINS.md)), #12.
