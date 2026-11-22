# Контракт з базою (експортер ↔ Supabase)

[English](../DB_CONTRACT.md) · **Українська**

Експортер працює з проєктом Supabase, який йому не належить: схема живе разом із дашбордом (його `supabase/migrations/`). Тут перелік усього, на що експортер там спирається, щоб будь-яку зміну схеми з будь-якого боку можна було звірити. Якщо ти запускаєш свій дашборд, твій проєкт має давати саме це.

**Версія контракту:** `dbContract.minMigration` у [package.json](../../package.json) — найновіша міграція (префікс назви файлу, 14 цифр), потрібна експортеру. Записи релізів беруть її як `min_db_migration` ([UPDATES.md](UPDATES.md)). Піднімай її в тій самій зміні, яка починає користуватися новішим об'єктом.

## Як він підключається

- `SUPABASE_URL` + `SUPABASE_ANON_KEY` (публічний за задумом) і **власний токен користувача**, ніколи не `service_role`.
- Токен видає **OAuth 2.1 сервер** Supabase Auth (`/auth/v1/oauth/*`): динамічна реєстрація клієнта, authorization code + PKCE, loopback-redirect (`http://127.0.0.1:<port>/callback`), refresh-токени. Користувач схвалює клієнта на сторінці дашборда `/oauth/consent` і відкликає на `/exporters`.
- Роль токена — `authenticated`; claim `client_id` ідентифікує експортер (його використовує `exporter_key`).
- Кожен запис іде під RLS: користувач бачить лише рядки пристроїв з `devices.owner_id = auth.uid()`.

## Віддалені процедури (RPC)

| Функція | Аргументи | Повертає | Навіщо | З міграції |
|---|---|---|---|---|
| `ensure_device` | `p_sn text, p_vendor text, p_model text, p_firmware text` | `uuid` (devices.id) | знайти або створити пристрій користувача за серійним номером | `20261121230000`, `20261122100000` |
| `exporter_key` | `p_new text` (base64, 32 байти) | `text` (ключ у base64) | при першому виклику зберігає `p_new`, далі повертає збережений ключ; лише для токена з claim `client_id` | `20261122171000` |
| `forget_exporter_key` | немає | void | видаляє ключ цього експортера («Забути облікові дані») | `20261122171000` |
| `submit_census` | `p_vendor, p_product_code, p_firmware text, p_msg_ids text[], p_exporter text` | void | перепис моделей за згодою | `20261122172000` |
| `reserve_sample` | `p_vendor, p_product_code, p_firmware text` | `jsonb {status, id?, path?, max_bytes?}`; status `wanted` / `supported` / `enough` / `limit` | питає, чи потрібен зразок, і резервує шлях для завантаження | `20261122172000` |
| `complete_sample` | `p_id uuid, p_size int, p_sha256 text` | void | позначає завантажений зразок завершеним | `20261122172000` |

## Таблиці

| Таблиця | Доступ | Колонки, які експортер надсилає чи читає | Ключ конфлікту |
|---|---|---|---|
| `telemetry_raw` | upsert, `ignoreDuplicates` | `device_id, ts, soc_pct, watts_in, watts_out, ac_in_voltage_v, ac_in_freq_hz, ac_out_freq_hz, grid_present, extra (jsonb)` та інші колонки з `src/db/types.ts` (`TelemetryRawInsert`) | `(device_id, ts)` |
| `pack_raw` | upsert, `ignoreDuplicates` | `device_id, pack, ts, soc_pct, soh_pct, cycles, cell_voltages_mv int[], cell_temps_c int[], min_mos_temp_c, max_mos_temp_c, balance_state, extra (jsonb)` (`PackRawInsert`); індекс масиву = номер комірки, `pack` 0 = основний блок | `(device_id, pack, ts)` |
| `outages` | upsert на початку, оновлення в кінці; select (сторінка стану) | `device_id, started_at, ended_at, soc_start_pct, soc_end_pct, energy_out_wh` (`OutageRow`) | `(device_id, started_at)` |
| `device_state` | upsert | `device_id, updated_at, state (jsonb)` | `(device_id)` |
| `consents` | select, insert | `purpose` (`model_census` / `raw_sample_upload`), `text_version, text_sha256, source` (`exporter`), `device_id`; читає `withdrawn_at` | немає |

Точні форми рядків — у `src/db/types.ts`; тримай його узгодженим з цією таблицею.

## Storage

- Бакет `samples` (приватний): `upload(path, file, { upsert: false })` за шляхом, який повернув `reserve_sample`, `application/gzip`, не більше `max_bytes`.

## Скрипт адміністратора (лише оператор)

`npm run samples` (`src/admin/samples.ts`) — єдиний код тут, що використовує `service_role`, з власного оточення оператора, ніколи не в робочому шляху образу: читає `model_census`, `model_samples`, `known_models` і бакет `samples`.

## Зміна контракту

- **Бік дашборда** (нова міграція): додати колонки зі значенням за замовчуванням, таблиці чи функції безпечно. Перейменувати чи видалити будь-що з переліченого, змінити аргументи чи форму відповіді RPC або звузити RLS для `authenticated` — зламає запущені експортери: додай нову функцію чи колонку, а стару тримай, доки всі підтримувані релізи з неї не зійдуть.
- **Бік експортера**: новий об'єкт спершу потребує міграції на боці дашборда, потім підніми `dbContract.minMigration` і додай рядок сюди.
