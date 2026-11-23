# Експортер без Docker

[English](../NATIVE.md) · **Українська**

> Це переклад. Основна версія англійська ([docs/NATIVE.md](../NATIVE.md)); якщо тексти розходяться, правильна англійська.

Експортер також є **одним виконуваним файлом** для кожної ОС і процесора, з невеликим
інсталятором, що запускає його як фонову службу (issue #45, фаза 1). Це той самий код, що й в
образі Docker, зібраний через [Single Executable Applications](https://nodejs.org/api/single-executable-applications.html)
Node: збірка `src/`, `.proto` і сторінки стану, вбудована в копію закріпленого бінарника Node 22.
Більше нічого встановлювати не треба.

| Файл | Для |
| --- | --- |
| `ecoflow-exporter-linux-x64`, `ecoflow-exporter-linux-arm64` | ПК з Linux, Raspberry Pi (64-біт) |
| `ecoflow-exporter-darwin-arm64` | Mac на Apple silicon |
| `ecoflow-exporter-win-x64.exe` | Windows 10/11 |

Вони прикріплені до кожного релізу на GitHub (`exporter-binaries.yml`), кожен з файлом `.sha256`.
Перевір перед запуском: `shasum -a 256 -c ecoflow-exporter-<target>.sha256`.

## Встановлення

Служба працює від твого користувача, тримає дані (`.env`, токен входу, зашифровані облікові
дані EcoFlow, буфер) у власній теці і показує сторінку стану на **http://127.0.0.1:9101/**, де
ти входиш і вводиш акаунт EcoFlow (редагувати `.env` не потрібно).

```bash
bash packaging/install-linux.sh ./ecoflow-exporter-linux-x64      # служба systemd користувача
bash packaging/install-macos.sh ./ecoflow-exporter-darwin-arm64   # агент launchd
```

```powershell
powershell -ExecutionPolicy Bypass -File packaging\install-windows.ps1 .\ecoflow-exporter-win-x64.exe   # завдання при вході
```

| ОС | Дані й `.env` | Логи | Видалення |
| --- | --- | --- | --- |
| Linux | `~/.local/share/ecoflow-exporter` | `journalctl --user -u ecoflow-exporter` | `install-linux.sh --uninstall` |
| macOS | `~/Library/Application Support/ecoflow-exporter` | `exporter.log` у цій теці | `install-macos.sh --uninstall` |
| Windows | `%LOCALAPPDATA%\ecoflow-exporter` | Історія Планувальника завдань | `install-windows.ps1 -Uninstall` |

Видалення лишає теку з даними; видали її сам, щоб прибрати токен і облікові дані. `.env` не
потрібен: експортер підключається до дашборду проєкту. Налаштування, які таки хочеш у файлі,
клади в `.env` там (див. `.env.example`).

На Linux `sudo loginctl enable-linger $USER` лишає службу працювати, коли ти вийшов із системи.
На Windows завдання стартує при вході; для машини, що має збирати дані без входу користувача,
краще Docker або Linux.

## Підпис

Бінарники поки **не підписані**: macOS отримує ad-hoc підпис (інсталятор знімає карантин
завантаження), Windows SmartScreen може попереджати. Підпис потребує Apple Developer ID (річна
плата плюс нотаризація) і сертифіката чи сервісу підпису для Windows; це рішення про витрати,
відкрите в #45. Файли `.sha256` і реліз на GitHub це те, що можна перевірити вже зараз.

## Сон

Експортер записує, лише коли комп'ютер не спить. Ноутбук у сні лишає прогалини, як в issue #14.
MQTT EcoFlow це хмарний сервіс, тож експортеру не треба бути поряд зі станцією: підійде будь-яка
машина, що працює постійно (міні-ПК, Raspberry Pi, NAS з Docker). На ноутбуці тримай його від
мережі і не давай засинати (macOS: `caffeinate -s` від мережі або налаштування Акумулятора;
Windows: налаштування живлення). Блокування сну з самого застосунку заплановано разом із
застосунком у треї.

## Зібрати самому

```bash
npm ci
npm run sea                                 # build/sea/ecoflow-exporter[.exe] для цієї ОС/архітектури
build/sea/ecoflow-exporter --self-check     # proto і сторінка стану читаються з бінарника
```

Збирай закріпленим Node 22 (бінарник це копія Node, що запускає збірку).

## Далі (фаза 2)

Невеликий застосунок у треї (Tauri) зі статусом, «Відкрити дашборд», автозапуском і підписаним
оновлювачем платформи, що наглядає за цією службою. Не почато; чекає рішення про підпис вище.
