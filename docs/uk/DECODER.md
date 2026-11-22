# Декодер Delta 3 Max Plus (M3)

[English](../DECODER.md) · **Українська**

> Це переклад. Основна версія англійська ([docs/DECODER.md](../DECODER.md)); якщо тексти розходяться, правильна англійська.

Код: `src/decode/`, опис повідомлень: `src/proto/delta3maxplus.proto` (скопійовано з
[foxthefox/ioBroker.ecoflow-mqtt](https://github.com/foxthefox/ioBroker.ecoflow-mqtt), MIT,
ліцензія в `src/proto/LICENSE-ioBroker`). Розбір через `protobufjs` без генерації коду.

Ту саму модель можна декодувати й з даних: [DECODER_PACKS.md](DECODER_PACKS.md).

## Як іде повідомлення

1. MQTT payload = `HeaderMessage { repeated Header header = 1 }`. Один payload може нести кілька
   заголовків (відповідь на запит «дай усе» несе 5).
2. Тип `pdata` визначає пара `cmdFunc/cmdId`. Якщо `encType = 1` (і `src != 32`), `pdata`
   заксорено молодшим байтом `seq`.
3. Пристрій шле повні повідомлення у відповідь на запит (`get_reply`, раз на 5 хв) і інкрементні
   самостійно (лише змінені поля). Тому адаптер `Delta3MaxPlus` зливає їх у поточний стан.

| cmdFunc/cmdId | Повідомлення | Що беремо |
|---|---|---|
| 254/21 | DisplayPropertyUpload | SoC (`cmsBattSoc`), потужність вх/вих (`powInSumW`/`powOutSumW`), **ознака мережі** `plugInInfoAcInFlag`, частота виходу `acOutFreq` |
| 254/22 | RuntimePropertyUpload | напруга/струм AC входу й виходу, температури PCS, напруга й струм батареї |
| 32/50 | BMSHeartBeatReport | для кожного блоку (`num`, 0 = основний): `cellVol[]`, `cellTemp[]`, SOH, цикли, MOSFET, балансування |
| 32/2 | CMSHeartBeatReport | зведення BMS (поки лише запасне джерело SoC) |
| 254/18, 254/20, 50/2 | setReply / ConfigReadAck / BpEuLawDataAck | приходять пачкою при зміні мережі; не записуємо |
| 53/249 | невідоме | 4 байти, ігноруємо |

## Що показали живі фікстури (2026-11-21)

- **Один блок** (`num = 0`, `bmsIsConnt = [3,0,0]`), **16 комірок** (`cellSeriesNum = 16`),
  **4 датчики температури** комірок (`cellNtcNum = 4`) і 3 датчики MOSFET. Тобто
  `pack_raw.cell_temps_c` має 4 елементи (індекс = датчик), а не 16.
- **Мережа**: `plugInInfoAcInFlag` міняється миттєво (зникла о 20:40:50, з'явилась о 20:51:01
  за Києвом). `plugInInfoAcInVol` оновлюється лише раз на ~5 хв і ще кілька хвилин після
  зникнення показує 242 В, тому `grid_present` беремо з прапорця, а напругу до першого свіжого
  значення після зміни записуємо як `null`.
- **Частота входу** `plugInInfoAcInFeq` у цієї моделі завжди 0, тому `ac_in_freq_hz = null`.
  Частота виходу `acOutFreq = 50`.
- SOH: `soh = 100` (як у застосунку), а `realSoh ≈ 96.9`, `calendarSoh = 88` кладемо в `extra`.
- Серійники батарей (`bmsSn`, `packSn`) сидять усередині `pdata`, тож запис фікстур тепер
  вчить їх і з розібраних повідомлень, а наявні фікстури перечищено.

## Спільна модель

`src/model/types.ts`: `TelemetrySample`, `PackSample`, `DeviceAdapter`. Адаптер пристрою
перетворює свої повідомлення на ці типи, а запис у БД знає лише їх (задел під інші станції, #12).
