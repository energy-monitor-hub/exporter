// Exporter status page: plain JS, no build step. Polls /api/status (src/status.ts).
// Strings: English by default, Ukrainian via the language button (remembered in localStorage).
// Theme: follows the OS; the theme button cycles auto / light / dark (remembered in localStorage).

const STRINGS = {
  en: {
    title: 'Exporter status',
    setup: 'EcoFlow account',
    setupEnv: 'From .env',
    setupNeeded: 'Not set up',
    setupLocked: 'Locked',
    setupReady: 'Saved, encrypted',
    setupError: 'Cannot open',
    hintSetupEnv: 'The credentials come from .env (ECOFLOW_USERNAME, ECOFLOW_PASSWORD, DEVICE_SN). Remove them there to set them up here instead.',
    hintSetupNeeded: 'Enter your EcoFlow app account and the station to read.',
    hintSetupNeedLogin: 'Log in below first: the encryption key is kept with your exporter login.',
    hintSetupLocked: 'Stored encrypted. They open after the Supabase login: {0}',
    hintSetupReady: 'Stored encrypted on this computer; station {0}. To change them, forget and enter them again.',
    hintSetupError: 'The stored credentials cannot be opened ({0}). Forget them and enter them again.',
    ecoEmail: 'E-mail of the EcoFlow app account',
    ecoPassword: 'Password',
    ecoSn: 'Serial number of the station',
    ecoHost: 'Server',
    setupPrivacy:
      'The password is checked with EcoFlow, then stored only on this computer, encrypted. The key is kept with your exporter login, so revoking this exporter on the dashboard makes a copy of the file useless. The exporter uses EcoFlow’s unofficial app interface with your account, at your own risk.',
    setupSave: 'Check and save',
    setupSaving: 'Checking…',
    setupSaved: 'Saved. Connecting to the station.',
    setupForget: 'Forget credentials',
    setupForgetConfirm: 'Forget the EcoFlow credentials on this exporter? It stops reading the station until you enter them again.',
    setupForgotten: 'Credentials deleted.',
    setupFailed: 'Not saved: {0}',
    noDevice: 'No station yet',
    device: 'Device connection',
    lastMessage: 'Last message',
    lastSample: 'Last sample',
    running: 'Running for',
    decoder: 'Data decoder',
    version: 'Version',
    updateAvailable: 'Exporter {0} is available. Docker: pull the new image and recreate the container (or pin {1}). Without Docker: install the new file from the releases. {2}',
    updateRevoked: 'This exporter version was withdrawn (a serious problem): update it now (new image or new file from the releases).',
    updateCurrent: 'up to date',
    updateOneClick: 'Exporter {0} is available. {1}',
    updateRevokedOneClick: 'This exporter version was withdrawn (a serious problem): update it now.',
    updateTo: 'Update to {0}',
    updateConfirm: 'Update the exporter to {0}? It restarts and takes new samples again in about a minute. If the new version does not start, the current one comes back by itself.',
    updateAuto: 'Install stable updates automatically',
    updateNotConfigured: 'The updater is running, but EXPORTER_RELEASES_URL is not set in .env (the dashboard’s Exporters page shows the value).',
    'phase-verifying': 'Updating to {0}: checking the signature and the build provenance…',
    'phase-pulling': 'Updating to {0}: downloading…',
    'phase-starting': 'Updating to {0}: restarting the exporter…',
    'phase-checking': 'Updating to {0}: checking that the new version works…',
    'phase-rolling-back': 'Update to {0} did not work: bringing back the previous version…',
    updateDone: 'Updated to {0}.',
    updateRolledBack: 'Update to {0} did not work ({1}). The previous version is running again.',
    updateFailed: 'Update to {0} failed: {1}',
    updateRestarting: 'The exporter is restarting for the update…',
    updaterError: 'The updater is not answering: {0}',
    decoderBuiltin: 'built-in',
    decoderPack: 'downloaded, {0}',
    decoderOff: 'Decoder updates are off (DECODER_UPDATES=off): the built-in decoder is used.',
    decoderNotConfigured: 'Decoder updates are not set up: add DECODER_INDEX_URL to .env (the dashboard’s Exporters page shows the value).',
    decoderAuto: 'Decoder updates install themselves.',
    decoderNotify: 'Decoder updates are only reported, not installed (DECODER_UPDATES=notify).',
    decoderChecked: 'Update list published {0}, last checked {1}.',
    decoderNotChecked: 'not yet since the start',
    decoderAvailable: 'Available, not used: {0}.',
    decoderError: 'Last check failed: {0}',
    reconnect: 'Reconnect',
    reconnecting: 'Reconnecting…',
    cloud: 'Supabase login',
    tokenExpires: 'Access token until',
    login: 'Log in',
    loginAgain: 'Log in again',
    pasteHint: 'If the browser did not come back here, paste the address it ended on:',
    finish: 'Finish',
    queue: 'Write queue',
    pending: 'Rows waiting',
    lastWrite: 'Last write',
    grid: 'Grid',
    outageSince: 'Outage since',
    outageFor: 'Without grid for',
    values: 'Latest values',
    pack: 'Pack',
    soc: 'SoC',
    soh: 'SoH',
    cycles: 'Cycles',
    cellMin: 'Cell min',
    cellMax: 'Cell max',
    spread: 'Spread',
    temp: 'Temp',
    noValues: 'Nothing from the device yet.',
    outages: 'Recent outages',
    start: 'Start',
    duration: 'Duration',
    socRange: 'SoC',
    energy: 'Used',
    connected: 'Connected',
    disconnected: 'Disconnected',
    stale: 'Silent',
    ok: 'OK',
    loggedOut: 'Not logged in',
    revoked: 'Revoked',
    error: 'Error',
    notConfigured: 'Not configured',
    hintOk: 'Rows are written to Supabase as the user who approved this exporter.',
    hintLoggedOut: 'Log in and approve this exporter on the dashboard. Rows wait in the local queue until then.',
    hintRevoked: 'Access was revoked on the dashboard (or expired). Log in again; queued rows are kept.',
    hintError: 'The last token refresh failed. The exporter keeps retrying.',
    hintNotConfigured: 'SUPABASE_URL / SUPABASE_ANON_KEY are not set: rows are only queued locally.',
    empty: 'Empty',
    waiting: 'Waiting',
    failing: 'Failing',
    present: 'Present',
    absent: 'Absent',
    unknown: 'Unknown',
    ongoing: 'ongoing',
    inferred: 'not seen: inferred from a battery drop while the exporter was asleep or offline',
    approx: 'The exporter was asleep or offline at that moment: the time is somewhere in this window.',
    never: 'never',
    ago: '{0} ago',
    updated: 'Updated {0}',
    offline: 'The exporter is not answering',
    loginOk: 'Exporter logged in. Queued rows will be sent now.',
    loginFailed: 'Login failed: {0}',
    noOutages: 'No outages recorded yet.',
    outagesNeedLogin: 'Shown after the exporter is logged in.',
    outagesError: 'Could not load: {0}',
    main: 'Main unit',
    extra: 'Extra battery {0}',
    watts_in: 'Input',
    watts_out: 'Output',
    ac_in: 'AC in',
    freq: 'Frequency',
    langButton: 'UK',
    theme_system: 'Auto',
    theme_light: 'Light',
    theme_dark: 'Dark',
    themeHint: 'Theme',
    disc: 'Help support your model',
    discWell: 'Supported',
    discPartly: 'Partly understood',
    discOff: 'Unavailable',
    discHint: 'This station: {0} {1}. {2} message types, {3} of messages understood by this exporter. Sharing is optional and needs your consent; nothing is sent until you press a button.',
    discHintOff: 'Not available: {0}.',
    discCensus: 'Model census',
    discSample: 'Share a sample',
    discAgree: 'I have read this and agree',
    discCensusSend: 'Send census',
    discCensusSent: 'Sent {0}',
    discMinutes: 'minutes',
    discRecord: 'Record',
    discStop: 'Stop',
    discRecording: 'Recording: {0} messages, {1} left',
    discSend: 'Send',
    discDiscard: 'Discard',
    discSumMessages: 'Messages',
    discSumDuration: 'Duration',
    discSumSize: 'Compressed size',
    discSumMasked: 'Identifiers masked',
    discSumTypes: 'Message types',
    discResult_sent: 'Sample sent. Thank you! You can see and delete it on the dashboard\'s "My data" page.',
    discResult_supported: 'This model is already supported: nothing was sent.',
    discResult_enough: 'We already have enough samples of this model: nothing was sent.',
    discResult_limit: 'Upload limit reached (one an hour, three at a time): nothing was sent. Try later.',
    discConsentFirst: 'Tick the consent first.',
    discWithdrawHint: 'To withdraw a consent or delete what was sent, open "My data" on the dashboard.',
  },
  uk: {
    title: 'Стан експортера',
    setup: 'Акаунт EcoFlow',
    setupEnv: 'З .env',
    setupNeeded: 'Не налаштовано',
    setupLocked: 'Заблоковано',
    setupReady: 'Збережено, зашифровано',
    setupError: 'Не відкривається',
    hintSetupEnv: 'Облікові дані беруться з .env (ECOFLOW_USERNAME, ECOFLOW_PASSWORD, DEVICE_SN). Прибери їх звідти, щоб налаштувати тут.',
    hintSetupNeeded: 'Введи акаунт застосунку EcoFlow і станцію, яку читати.',
    hintSetupNeedLogin: 'Спершу увійди нижче: ключ шифрування зберігається разом із входом експортера.',
    hintSetupLocked: 'Збережено зашифрованими. Відкриються після входу в Supabase: {0}',
    hintSetupReady: 'Збережено зашифрованими на цьому комп’ютері; станція {0}. Щоб змінити, забудь і введи знову.',
    hintSetupError: 'Збережені дані не відкриваються ({0}). Забудь їх і введи знову.',
    ecoEmail: 'E-mail акаунта застосунку EcoFlow',
    ecoPassword: 'Пароль',
    ecoSn: 'Серійний номер станції',
    ecoHost: 'Сервер',
    setupPrivacy:
      'Пароль перевіряється в EcoFlow, потім зберігається лише на цьому комп’ютері в зашифрованому вигляді. Ключ зберігається разом із входом експортера, тож якщо відкликати цей експортер на дашборді, копія файлу стає непридатною. Експортер використовує неофіційний інтерфейс застосунку EcoFlow з твоїм акаунтом, на твій ризик.',
    setupSave: 'Перевірити і зберегти',
    setupSaving: 'Перевіряю…',
    setupSaved: 'Збережено. Підключаюся до станції.',
    setupForget: 'Забути облікові дані',
    setupForgetConfirm: 'Забути облікові дані EcoFlow на цьому експортері? Він перестане читати станцію, доки не введеш їх знову.',
    setupForgotten: 'Облікові дані видалено.',
    setupFailed: 'Не збережено: {0}',
    noDevice: 'Станції ще немає',
    device: 'Зв’язок зі станцією',
    lastMessage: 'Останнє повідомлення',
    lastSample: 'Останній семпл',
    running: 'Працює',
    decoder: 'Декодер даних',
    version: 'Версія',
    updateAvailable: 'Доступний експортер {0}. Docker: завантаж новий образ і перестворь контейнер (або закріпи {1}). Без Docker: встанови новий файл із релізів. {2}',
    updateRevoked: 'Цю версію експортера відкликано (серйозна проблема): онови її зараз (новий образ або новий файл із релізів).',
    updateCurrent: 'актуальна',
    updateOneClick: 'Доступний експортер {0}. {1}',
    updateRevokedOneClick: 'Цю версію експортера відкликано (серйозна проблема): онови її зараз.',
    updateTo: 'Оновити до {0}',
    updateConfirm: 'Оновити експортер до {0}? Він перезапуститься і приблизно за хвилину знову збиратиме дані. Якщо нова версія не запуститься, поточна повернеться сама.',
    updateAuto: 'Встановлювати стабільні оновлення автоматично',
    updateNotConfigured: 'Оновлювач працює, але в .env немає EXPORTER_RELEASES_URL (значення показує сторінка «Експортери» на дашборді).',
    'phase-verifying': 'Оновлення до {0}: перевіряю підпис і походження образу…',
    'phase-pulling': 'Оновлення до {0}: завантажую…',
    'phase-starting': 'Оновлення до {0}: перезапускаю експортер…',
    'phase-checking': 'Оновлення до {0}: перевіряю, що нова версія працює…',
    'phase-rolling-back': 'Оновлення до {0} не вдалося: повертаю попередню версію…',
    updateDone: 'Оновлено до {0}.',
    updateRolledBack: 'Оновлення до {0} не вдалося ({1}). Знову працює попередня версія.',
    updateFailed: 'Оновлення до {0} не вдалося: {1}',
    updateRestarting: 'Експортер перезапускається для оновлення…',
    updaterError: 'Оновлювач не відповідає: {0}',
    decoderBuiltin: 'вбудований',
    decoderPack: 'завантажений, {0}',
    decoderOff: 'Оновлення декодера вимкнено (DECODER_UPDATES=off): працює вбудований.',
    decoderNotConfigured: 'Оновлення декодера не налаштовано: додай DECODER_INDEX_URL у .env (значення є на сторінці «Експортери» дашборду).',
    decoderAuto: 'Оновлення декодера встановлюються самі.',
    decoderNotify: 'Про оновлення декодера лише повідомляється, без встановлення (DECODER_UPDATES=notify).',
    decoderChecked: 'Список оновлень опубліковано {0}, перевірено {1}.',
    decoderNotChecked: 'ще не перевіряли після запуску',
    decoderAvailable: 'Доступно, але не використовується: {0}.',
    decoderError: 'Остання перевірка не вдалася: {0}',
    reconnect: 'Перепідключити',
    reconnecting: 'Перепідключення…',
    cloud: 'Вхід у Supabase',
    tokenExpires: 'Токен доступу до',
    login: 'Увійти',
    loginAgain: 'Увійти ще раз',
    pasteHint: 'Якщо браузер не повернувся сюди, встав адресу, на якій він зупинився:',
    finish: 'Завершити',
    queue: 'Черга запису',
    pending: 'Рядків у черзі',
    lastWrite: 'Останній запис',
    grid: 'Мережа',
    outageSince: 'Відключення з',
    outageFor: 'Без мережі вже',
    values: 'Останні значення',
    pack: 'Блок',
    soc: 'Заряд',
    soh: 'SoH',
    cycles: 'Цикли',
    cellMin: 'Комірка мін',
    cellMax: 'Комірка макс',
    spread: 'Розкид',
    temp: 'Темп.',
    noValues: 'Від станції ще нічого не було.',
    outages: 'Останні відключення',
    start: 'Початок',
    duration: 'Тривалість',
    socRange: 'Заряд',
    energy: 'Віддано',
    connected: 'Підключено',
    disconnected: 'Не підключено',
    stale: 'Мовчить',
    ok: 'OK',
    loggedOut: 'Не виконано вхід',
    revoked: 'Відкликано',
    error: 'Помилка',
    notConfigured: 'Не налаштовано',
    hintOk: 'Рядки пишуться в Supabase від імені користувача, який підтвердив цей експортер.',
    hintLoggedOut: 'Увійди й підтверди цей експортер на дашборді. Доти рядки чекають у локальній черзі.',
    hintRevoked: 'Доступ відкликано на дашборді (або він сплив). Увійди ще раз, рядки в черзі збережені.',
    hintError: 'Останнє оновлення токена не вдалося. Експортер пробує ще.',
    hintNotConfigured: 'Не задано SUPABASE_URL / SUPABASE_ANON_KEY: рядки лише чекають у локальній черзі.',
    empty: 'Порожня',
    waiting: 'Чекає',
    failing: 'Помилка',
    present: 'Є',
    absent: 'Немає',
    unknown: 'Невідомо',
    ongoing: 'триває',
    inferred: 'не бачили: виведено з падіння заряду, поки експортер спав чи був без зв’язку',
    approx: 'У цей момент експортер спав або був без зв’язку: час десь у цьому вікні.',
    never: 'ще не було',
    ago: '{0} тому',
    updated: 'Оновлено {0}',
    offline: 'Експортер не відповідає',
    loginOk: 'Вхід виконано. Рядки з черги зараз підуть у Supabase.',
    loginFailed: 'Вхід не вдався: {0}',
    noOutages: 'Відключень ще не записано.',
    outagesNeedLogin: 'З’являться після входу експортера.',
    outagesError: 'Не вдалося завантажити: {0}',
    main: 'Основний блок',
    extra: 'Додаткова батарея {0}',
    watts_in: 'Вхід',
    watts_out: 'Вихід',
    ac_in: 'AC вхід',
    freq: 'Частота',
    langButton: 'EN',
    theme_system: 'Авто',
    theme_light: 'Світла',
    theme_dark: 'Темна',
    themeHint: 'Тема',
    disc: 'Допоможи підтримати свою модель',
    discWell: 'Підтримується',
    discPartly: 'Розуміється частково',
    discOff: 'Недоступно',
    discHint: 'Ця станція: {0} {1}. Типів повідомлень: {2}, цей експортер розуміє {3} повідомлень. Ділитися необов’язково і лише за твоєю згодою; нічого не надсилається, доки ти не натиснеш кнопку.',
    discHintOff: 'Недоступно: {0}.',
    discCensus: 'Перепис моделі',
    discSample: 'Поділитися зразком',
    discAgree: 'Я прочитав(-ла) і погоджуюсь',
    discCensusSend: 'Надіслати перепис',
    discCensusSent: 'Надіслано {0}',
    discMinutes: 'хвилин',
    discRecord: 'Записати',
    discStop: 'Зупинити',
    discRecording: 'Запис: {0} повідомлень, лишилось {1}',
    discSend: 'Надіслати',
    discDiscard: 'Відкинути',
    discSumMessages: 'Повідомлень',
    discSumDuration: 'Тривалість',
    discSumSize: 'Стиснений розмір',
    discSumMasked: 'Замасковано ідентифікаторів',
    discSumTypes: 'Типи повідомлень',
    discResult_sent: 'Зразок надіслано. Дякуємо! Його видно й можна видалити на сторінці «Мої дані» дашборду.',
    discResult_supported: 'Ця модель уже підтримується: нічого не надіслано.',
    discResult_enough: 'Зразків цієї моделі вже досить: нічого не надіслано.',
    discResult_limit: 'Ліміт завантажень (одне на годину, три одночасно): нічого не надіслано. Спробуй пізніше.',
    discConsentFirst: 'Спершу постав позначку згоди.',
    discWithdrawHint: 'Відкликати згоду або видалити надіслане можна на сторінці «Мої дані» дашборду.',
  },
};

const UNITS = {
  en: { s: 's', m: 'min', h: 'h', d: 'd' },
  uk: { s: 'с', m: 'хв', h: 'год', d: 'д' },
};

function readLang() {
  try {
    const saved = localStorage.getItem('lang');
    if (saved === 'en' || saved === 'uk') return saved;
  } catch {
    // storage blocked: fall through to the default
  }
  return 'en';
}

const THEMES = ['system', 'light', 'dark'];

function readTheme() {
  try {
    const saved = localStorage.getItem('theme');
    if (saved === 'light' || saved === 'dark') return saved;
  } catch {
    // storage blocked: follow the OS
  }
  return 'system';
}

/** 'system' removes data-theme so app.css follows prefers-color-scheme. */
function applyTheme() {
  if (theme === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', theme);
}

let lang = readLang();
let theme = readTheme();
applyTheme();
let last = null;

const $ = (id) => document.getElementById(id);
const t = (key, ...args) => {
  const s = STRINGS[lang][key] ?? STRINGS.en[key] ?? key;
  return args.reduce((acc, a, i) => acc.replace(`{${i}}`, String(a)), s);
};

function applyStrings() {
  document.documentElement.lang = lang;
  document.title = t('title');
  for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  $('lang').textContent = t('langButton');
  $('theme').textContent = t(`theme_${theme}`);
  $('theme').title = t('themeHint');
}

function duration(ms) {
  const u = UNITS[lang];
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${s} ${u.s}`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m} ${u.m}`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} ${u.h} ${m % 60} ${u.m}`;
  return `${Math.floor(h / 24)} ${u.d} ${h % 24} ${u.h}`;
}

const locale = () => (lang === 'uk' ? 'uk-UA' : undefined);
const time = (iso) => new Date(iso).toLocaleString(locale(), { dateStyle: 'short', timeStyle: 'short' });
const ago = (iso, now) => (iso ? t('ago', duration(now - Date.parse(iso))) : t('never'));
const num = (v, digits = 0) => (v === null || v === undefined ? '—' : Number(v).toFixed(digits));

function badge(el, cls, text) {
  el.className = `badge ${cls}`;
  el.textContent = text;
}

function setError(el, text) {
  el.hidden = !text;
  el.textContent = text ?? '';
}

function cell(text, cls) {
  const td = document.createElement('td');
  td.textContent = text;
  if (cls) td.className = cls;
  return td;
}

function tile(label, value, unit) {
  const div = document.createElement('div');
  div.className = 'tile';
  const l = document.createElement('div');
  l.className = 'label';
  l.textContent = label;
  const v = document.createElement('div');
  v.className = 'value';
  v.textContent = value;
  if (unit && value !== '—') {
    const u = document.createElement('span');
    u.className = 'unit';
    u.textContent = unit;
    v.append(u);
  }
  div.append(l, v);
  return div;
}

function render(s) {
  const now = Date.parse(s.now);
  const d = s.device;
  $('device').textContent = d ? [d.vendor, d.model, d.sn].filter(Boolean).join(' · ') : t('noDevice');
  renderSetup(s);
  $('updated').textContent = t('updated', new Date().toLocaleTimeString(locale()));

  // device connection
  const silentMs = s.source.lastMessageAt ? now - Date.parse(s.source.lastMessageAt) : Infinity;
  if (!s.source.connected) badge($('source-badge'), 'bad', t('disconnected'));
  else if (silentMs > 3 * 60_000) badge($('source-badge'), 'warn', t('stale'));
  else badge($('source-badge'), 'ok', t('connected'));
  $('last-message').textContent = ago(s.source.lastMessageAt, now);
  $('last-sample').textContent = ago(s.sampling.lastSampleAt, now);
  $('uptime').textContent = duration(now - Date.parse(s.startedAt));
  renderDecoders(s.decoders, now);
  renderUpdates(s.updates, now);

  // login
  const state = s.db.configured ? (s.auth?.state ?? 'logged-out') : 'not-configured';
  const authView = {
    ok: ['ok', 'ok', 'hintOk'],
    'logged-out': ['idle', 'loggedOut', 'hintLoggedOut'],
    revoked: ['bad', 'revoked', 'hintRevoked'],
    error: ['warn', 'error', 'hintError'],
    'not-configured': ['idle', 'notConfigured', 'hintNotConfigured'],
  }[state];
  badge($('auth-badge'), authView[0], t(authView[1]));
  $('auth-hint').textContent = t(authView[2]);
  $('auth-expires').textContent = s.auth?.expiresAt ? time(s.auth.expiresAt) : '—';
  setError($('auth-error'), state === 'ok' ? '' : s.auth?.error);
  const login = $('login');
  login.hidden = !s.db.canLogin;
  login.textContent = t(state === 'ok' ? 'loginAgain' : 'login');
  login.classList.toggle('primary', state !== 'ok');
  $('paste').hidden = !s.db.loginPending;

  // queue
  const q = s.queue;
  if (q.lastError) badge($('queue-badge'), 'bad', t('failing'));
  else if (q.pending > 0) badge($('queue-badge'), 'warn', t('waiting'));
  else badge($('queue-badge'), 'ok', t('empty'));
  $('queue-pending').textContent = q.pending.toLocaleString(locale());
  $('queue-ok').textContent = s.db.configured ? ago(q.lastOkAt, now) : '—';
  setError($('queue-error'), q.lastError);

  // grid
  const g = s.grid.present;
  badge($('grid-badge'), g === true ? 'ok' : g === false ? 'bad' : 'idle', t(g === true ? 'present' : g === false ? 'absent' : 'unknown'));
  const since = s.grid.openOutageSince;
  const latest = s.grid.openOutageSinceLatest;
  $('outage-since').textContent = since ? (latest ? `${time(since)} – ${time(latest)}` : time(since)) : '—';
  $('outage-since').title = latest ? t('approx') : '';
  $('outage-for').textContent = !since
    ? '—'
    : latest
      ? `${duration(now - Date.parse(latest))}–${duration(now - Date.parse(since))}`
      : duration(now - Date.parse(since));

  // latest values
  const r = s.reading;
  $('no-values').hidden = r !== null;
  $('packs').hidden = r === null || r.packs.length === 0;
  $('tiles').replaceChildren(
    ...(r
      ? [
          tile(t('soc'), num(r.socPct), '%'),
          tile(t('watts_in'), num(r.wattsIn), 'W'),
          tile(t('watts_out'), num(r.wattsOut), 'W'),
          tile(t('ac_in'), num(r.acInVoltageV), 'V'),
          tile(t('freq'), num(r.acInFreqHz, 1), 'Hz'),
        ]
      : []),
  );
  $('packs').tBodies[0].replaceChildren(
    ...(r?.packs ?? []).map((p) => {
      const tr = document.createElement('tr');
      const temps = p.tempMinC === null ? '—' : p.tempMinC === p.tempMaxC ? `${num(p.tempMinC)} °C` : `${num(p.tempMinC)}–${num(p.tempMaxC)} °C`;
      tr.append(
        cell(p.pack === 0 ? t('main') : t('extra', p.pack)),
        cell(p.socPct === null ? '—' : `${num(p.socPct)} %`, 'num'),
        cell(p.sohPct === null ? '—' : `${num(p.sohPct)} %`, 'num'),
        cell(num(p.cycles), 'num'),
        cell(p.cellMinMv === null ? '—' : `${p.cellMinMv} mV`, 'num'),
        cell(p.cellMaxMv === null ? '—' : `${p.cellMaxMv} mV`, 'num'),
        cell(p.cellSpreadMv === null ? '—' : `${p.cellSpreadMv} mV`, 'num'),
        cell(temps, 'num'),
      );
      return tr;
    }),
  );

  // outages
  const o = s.outages;
  const rows = o?.rows ?? [];
  $('outages').hidden = rows.length === 0;
  $('outages').tBodies[0].replaceChildren(
    ...rows.map((row) => {
      const tr = document.createElement('tr');
      const end = row.ended_at ? Date.parse(row.ended_at) : now;
      // Where the exporter was blind the times are a window: a range of durations, "≈" start.
      const approx = row.inferred || row.start_latest_at !== null || row.end_earliest_at !== null;
      const longest = end - Date.parse(row.started_at);
      const known = (row.end_earliest_at ? Date.parse(row.end_earliest_at) : end) - Date.parse(row.start_latest_at ?? row.started_at);
      const dur =
        (row.inferred ? `≤ ${duration(longest)}` : approx ? `${duration(Math.max(0, known))}–${duration(longest)}` : duration(longest)) +
        (row.ended_at ? '' : ` (${t('ongoing')})`);
      const soc = row.soc_start_pct === null ? '—' : `${num(row.soc_start_pct)} → ${row.soc_end_pct === null ? '…' : num(row.soc_end_pct)} %`;
      const start = cell((approx ? '≈ ' : '') + time(row.started_at));
      if (approx) start.title = row.inferred ? t('inferred') : t('approx');
      tr.append(start, cell(dur), cell(soc, 'num'), cell(row.energy_out_wh === null ? '—' : `${num(row.energy_out_wh)} Wh`, 'num'));
      return tr;
    }),
  );
  $('outages-note').textContent = !o ? t('outagesNeedLogin') : o.error ? t('outagesError', o.error) : rows.length === 0 ? t('noOutages') : '';
}

let updateBanner = '';
/** Version the page was loaded with: a different one after an update reloads the page (new UI files). */
let loadedVersion;
/** An update is running: a short outage of the page is the restart, not a failure. */
let updating = false;
const RUNNING_PHASES = ['verifying', 'pulling', 'starting', 'checking', 'rolling-back'];
const DAY_MS = 24 * 3600_000;

function renderUpdates(u, now) {
  if (!u) return;
  if (loadedVersion === undefined) loadedVersion = u.current;
  else if (u.current !== loadedVersion) {
    location.reload();
    return;
  }
  const fresh = u.configured && !u.latest && !u.revoked && u.checkedAt ? ` (${t('updateCurrent')})` : '';
  $('version').textContent = `${u.current}${fresh}`;

  const up = u.updater && u.updater.available ? u.updater : undefined;
  const job = up && up.job;
  const running = Boolean(job && RUNNING_PHASES.includes(job.phase));
  updating = running;
  // one click when the updater container runs next to the exporter, instructions otherwise
  const text = u.revoked
    ? t(up ? 'updateRevokedOneClick' : 'updateRevoked')
    : u.latest
      ? up
        ? t('updateOneClick', u.latest.version, u.latest.notes)
        : t('updateAvailable', u.latest.version, u.latest.image, u.latest.notes)
      : '';
  // Shown once per change, so the banner does not fight with other messages on every refresh.
  if (text !== updateBanner) {
    updateBanner = text;
    if (text) showBanner(text, Boolean(u.revoked));
  }

  $('update-box').hidden = !up;
  if (!up) return;
  let note = '';
  if (job && running) note = t(`phase-${job.phase}`, job.version);
  else if (job && job.finishedAt && now - Date.parse(job.finishedAt) < DAY_MS) {
    if (job.phase === 'done') note = t('updateDone', job.version);
    else if (job.phase === 'rolled-back') note = t('updateRolledBack', job.version, job.error ?? '');
    else if (job.phase === 'failed') note = t('updateFailed', job.version, job.error ?? '');
  }
  if (!up.configured) note = [t('updateNotConfigured'), note].filter(Boolean).join(' ');
  else if (up.error && !running) note = [note, t('decoderError', up.error)].filter(Boolean).join(' ');
  $('update-text').textContent = note;
  $('update-text').className = `small${job && !running && (job.phase === 'failed' || job.phase === 'rolled-back') ? ' error' : ''}`;
  $('update-text').hidden = !note;

  const btn = $('update-install');
  btn.hidden = !u.latest || running || !up.configured;
  btn.disabled = running;
  if (u.latest) {
    btn.textContent = t('updateTo', u.latest.version);
    btn.dataset.version = u.latest.version;
  }
  $('update-auto-row').hidden = !up.configured;
  $('update-auto').checked = Boolean(up.auto);
}

function renderDecoders(d, now) {
  if (!d) return;
  $('decoder').textContent = d.active ? t('decoderPack', d.active) : t('decoderBuiltin');
  const notes = [];
  if (d.mode === 'off') notes.push(t('decoderOff'));
  else if (!d.configured) notes.push(t('decoderNotConfigured'));
  else {
    notes.push(t(d.mode === 'notify' ? 'decoderNotify' : 'decoderAuto'));
    if (d.publishedAt) notes.push(t('decoderChecked', ago(d.publishedAt, now), d.checkedAt ? ago(d.checkedAt, now) : t('decoderNotChecked')));
    if (d.mode === 'notify' && d.available.length) notes.push(t('decoderAvailable', d.available.map((p) => `${p.id} v${p.version}`).join(', ')));
    if (d.error) notes.push(t('decoderError', d.error));
  }
  $('decoder-note').textContent = notes.join(' ');
}

function renderSetup(s) {
  const st = s.setup ?? { state: 'env', canEdit: false };
  const view = {
    env: ['idle', 'setupEnv', t('hintSetupEnv')],
    'needs-setup': ['warn', 'setupNeeded', t(st.canEdit ? 'hintSetupNeeded' : 'hintSetupNeedLogin')],
    locked: ['warn', 'setupLocked', t('hintSetupLocked', st.reason ?? '')],
    ready: ['ok', 'setupReady', t('hintSetupReady', st.sn ?? '')],
    error: ['bad', 'setupError', t('hintSetupError', st.reason ?? '')],
  }[st.state];
  badge($('setup-badge'), view[0], t(view[1]));
  $('setup-hint').textContent = view[2];
  // The form only while there is nothing stored and the key can be fetched (logged in).
  $('setup-form').hidden = !(st.state === 'needs-setup' && st.canEdit);
  $('setup-forget-row').hidden = !(st.state === 'ready' || st.state === 'error' || st.state === 'locked');
}

function showBanner(text, bad) {
  const b = $('banner');
  b.hidden = !text;
  b.textContent = text ?? '';
  b.classList.toggle('bad', Boolean(bad));
}

async function post(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-exporter-ui': '1' },
    body: JSON.stringify(body ?? {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

let offline = false;
async function refresh() {
  try {
    const res = await fetch('/api/status', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    last = await res.json();
    render(last);
    if (offline) showBanner('');
    offline = false;
  } catch {
    offline = true;
    showBanner(t(updating ? 'updateRestarting' : 'offline'), !updating);
  }
  void refreshDiscovery();
}

$('lang').addEventListener('click', () => {
  lang = lang === 'en' ? 'uk' : 'en';
  try {
    localStorage.setItem('lang', lang);
  } catch {
    // not remembered, still switched
  }
  applyStrings();
  if (last) render(last);
  if (disc) renderDiscovery(disc);
});

$('theme').addEventListener('click', () => {
  theme = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
  try {
    if (theme === 'system') localStorage.removeItem('theme');
    else localStorage.setItem('theme', theme);
  } catch {
    // not remembered, still switched
  }
  applyTheme();
  applyStrings();
});

$('reconnect').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  btn.textContent = t('reconnecting');
  try {
    await post('/api/reconnect');
  } catch (err) {
    showBanner(err.message, true);
  }
  setTimeout(() => {
    btn.disabled = false;
    btn.textContent = t('reconnect');
    void refresh();
  }, 3000);
});

$('login').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  try {
    const { url } = await post('/api/login');
    $('paste').hidden = false;
    // A new tab, so this page stays open for the "paste the address" fallback.
    const w = window.open(url, '_blank');
    if (w) w.opener = null;
    else location.href = url;
  } catch (err) {
    showBanner(t('loginFailed', err.message), true);
  } finally {
    btn.disabled = false;
  }
});

$('paste').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await post('/api/login/finish', { url: $('paste-url').value });
    $('paste-url').value = '';
    showBanner(t('loginOk'));
  } catch (err) {
    showBanner(t('loginFailed', err.message), true);
  }
  void refresh();
});

$('setup-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('setup-save');
  btn.disabled = true;
  btn.textContent = t('setupSaving');
  setError($('setup-error'), '');
  try {
    const body = { username: $('eco-user').value, password: $('eco-pass').value, sn: $('eco-sn').value.trim() };
    if ($('eco-host').value) body.apiHost = $('eco-host').value;
    await post('/api/credentials', body);
    $('eco-pass').value = '';
    showBanner(t('setupSaved'));
  } catch (err) {
    setError($('setup-error'), t('setupFailed', err.message));
  } finally {
    btn.disabled = false;
    btn.textContent = t('setupSave');
    void refresh();
  }
});

$('setup-forget').addEventListener('click', async () => {
  if (!window.confirm(t('setupForgetConfirm'))) return;
  try {
    await post('/api/credentials/forget');
    showBanner(t('setupForgotten'));
  } catch (err) {
    showBanner(err.message, true);
  }
  void refresh();
});

let disc;
function renderDiscovery(d) {
  if (!d) return;
  disc = d;
  const share = d.decodedShare === null ? '—' : `${Math.round(d.decodedShare * 100)}%`;
  if (!d.available) {
    badge($('disc-badge'), 'idle', t('discOff'));
    $('disc-hint').textContent = t('discHintOff', d.reason ?? '');
  } else {
    const well = d.decodedShare !== null && d.decodedShare >= 0.9;
    badge($('disc-badge'), well ? 'ok' : 'warn', t(well ? 'discWell' : 'discPartly'));
    $('disc-hint').textContent = `${t('discHint', d.vendor ?? '', d.productCode ?? '', d.msgTypes, share)} ${t('discWithdrawHint')}`;
  }
  $('disc-body').hidden = !d.available;
  $('census-text').textContent = d.texts.model_census[lang] ?? d.texts.model_census.en;
  $('sample-text').textContent = d.texts.raw_sample_upload[lang] ?? d.texts.raw_sample_upload.en;
  for (const [purpose, box, row] of [
    ['model_census', 'census-consent', 'census-consent-row'],
    ['raw_sample_upload', 'sample-consent', 'sample-consent-row'],
  ]) {
    const given = d.consents[purpose] === true;
    $(box).checked = given;
    $(box).disabled = given;
    $(row).classList.toggle('muted', given);
  }
  $('census-send').disabled = d.consents.model_census !== true || d.messages === 0;
  $('census-sent').textContent = d.census.sentAt ? t('discCensusSent', time(d.census.sentAt)) : '';

  const r = d.recorder;
  $('sample-start-row').hidden = r.state !== 'idle';
  $('sample-record').disabled = d.consents.raw_sample_upload !== true;
  $('sample-rec-row').hidden = r.state !== 'recording';
  $('sample-progress').textContent = t('discRecording', r.messages, duration(r.remainingS * 1000));
  $('sample-ready').hidden = r.state !== 'ready';
  const sum = $('sample-summary');
  sum.replaceChildren();
  if (r.summary) {
    const rows = [
      ['discSumMessages', String(r.summary.messages)],
      ['discSumDuration', duration(r.summary.durationS * 1000)],
      ['discSumSize', `${(r.summary.gzBytes / 1024).toFixed(1)} KB`],
      ['discSumMasked', String(r.summary.masked)],
      ['discSumTypes', r.summary.msgIds.join(', ') || '—'],
    ];
    for (const [k, v] of rows) {
      const dt = document.createElement('dt');
      dt.textContent = t(k);
      const dd = document.createElement('dd');
      dd.textContent = v;
      sum.append(dt, dd);
    }
  }
  setError($('sample-blocked'), r.summary?.blocked ?? '');
  $('sample-send').disabled = Boolean(r.summary?.blocked);
  $('sample-result').textContent = d.lastSample ? t(`discResult_${d.lastSample.result}`) : '';
}

async function refreshDiscovery() {
  try {
    const res = await fetch('/api/discovery', { cache: 'no-store' });
    if (res.ok) renderDiscovery(await res.json());
  } catch {
    // the main refresh shows "offline"
  }
}

async function discAction(action, body, btn) {
  if (btn) btn.disabled = true;
  setError($('disc-error'), '');
  try {
    return await post(`/api/discovery/${action}`, body);
  } catch (err) {
    setError($('disc-error'), err.message);
  } finally {
    if (btn) btn.disabled = false;
    await refreshDiscovery();
  }
}

for (const [box, purpose] of [
  ['census-consent', 'model_census'],
  ['sample-consent', 'raw_sample_upload'],
]) {
  $(box).addEventListener('change', (e) => {
    if (!e.currentTarget.checked || !disc) return;
    void discAction('consent', { purpose, sha256: disc.texts[purpose].sha256 }, e.currentTarget);
  });
}
$('census-send').addEventListener('click', (e) => void discAction('census', {}, e.currentTarget));
$('sample-record').addEventListener('click', (e) => void discAction('record', { minutes: Number($('sample-minutes').value) }, e.currentTarget));
$('sample-stop').addEventListener('click', (e) => void discAction('stop', {}, e.currentTarget));
$('sample-discard').addEventListener('click', (e) => void discAction('discard', {}, e.currentTarget));
$('sample-send').addEventListener('click', (e) => void discAction('send', {}, e.currentTarget));

$('update-install').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  const version = btn.dataset.version;
  if (!version || !window.confirm(t('updateConfirm', version))) return;
  btn.disabled = true;
  try {
    await post('/api/update', { version });
    updating = true;
    await refresh();
  } catch (err) {
    showBanner(t('updateFailed', version, err.message), true);
    btn.disabled = false;
  }
});
$('update-auto').addEventListener('change', async (e) => {
  const box = e.currentTarget;
  box.disabled = true;
  try {
    await post('/api/update/auto', { enabled: box.checked });
  } catch (err) {
    box.checked = !box.checked;
    showBanner(err.message, true);
  } finally {
    box.disabled = false;
  }
});

// Back from the consent page (GET /callback redirects here).
const params = new URLSearchParams(location.search);
if (params.has('login')) showBanner(t('loginOk'));
if (params.has('login_error')) showBanner(t('loginFailed', params.get('login_error')), true);
if (params.has('login') || params.has('login_error')) history.replaceState(null, '', '/');

applyStrings();
void refresh();
setInterval(() => {
  if (!document.hidden) void refresh();
}, 5000);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) void refresh();
});
