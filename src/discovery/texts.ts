import { createHash } from 'node:crypto';

/**
 * Consent texts the exporter shows before it sends anything. The exact text (both
 * languages) is hashed and stored with the consent (public.consents.text_sha256), so what
 * the user agreed to can be proven later. Change a text = new version: users are asked again.
 */
export type DiscoveryPurpose = 'model_census' | 'raw_sample_upload';

export const CONSENT_TEXTS: Record<DiscoveryPurpose, { version: string; en: string; uk: string }> = {
  model_census: {
    version: '2026-11-22',
    en: [
      'Send a model census to the operator of this dashboard: the vendor, the first 4 characters of the serial number (the model family, shared by every unit of the model), the firmware version if known, and the list of message types your station sends with their counts and sizes.',
      'No measurements, no full serial number, no account details. Purpose: knowing which models people use, to decide which to support. Kept for 12 months, replaced each time you send it.',
      'Optional. You can delete it and withdraw this consent at any time on the dashboard\'s "My data" page.',
    ].join('\n'),
    uk: [
      'Надіслати оператору цього дашборду перепис моделі: виробник, перші 4 символи серійного номера (сімейство моделі, однакове для всіх пристроїв цієї моделі), версія прошивки, якщо відома, і список типів повідомлень станції з їхньою кількістю та розміром.',
      'Без вимірювань, без повного серійного номера, без даних акаунта. Мета: знати, які моделі використовують, щоб вирішити, які підтримати. Зберігається 12 місяців, замінюється при кожній відправці.',
      'Необов’язково. Видалити й відкликати згоду можна будь-коли на сторінці «Мої дані» дашборду.',
    ].join('\n'),
  },
  raw_sample_upload: {
    version: '2026-11-22',
    en: [
      'Record the messages your station sends for a few minutes and, after you have seen the summary and pressed Send, upload them compressed to the operator of this dashboard, to add support for your model.',
      'Before anything leaves this computer, the serial numbers, your account id and e-mail are masked, also inside the messages; if any is still found, nothing is sent. The recording holds your station\'s readings (power, charge, voltages, temperatures) during that time.',
      'Only you and the operator can access it. It is used only to develop and test device support in this open-source project. It is deleted when your model is supported (at the latest 30 days after) or after 12 months, and you can delete it and withdraw this consent at any time on the dashboard\'s "My data" page. Publishing an excerpt as a public test needs a separate consent.',
    ].join('\n'),
    uk: [
      'Записати повідомлення станції протягом кількох хвилин і, після того як ти побачиш підсумок і натиснеш «Надіслати», завантажити їх у стисненому вигляді оператору цього дашборду, щоб додати підтримку твоєї моделі.',
      'Перед тим як щось залишить цей комп’ютер, серійні номери, ідентифікатор акаунта і e-mail маскуються, також усередині повідомлень; якщо щось із цього все ж знайдено, нічого не надсилається. Запис містить показники станції (потужність, заряд, напруги, температури) за цей час.',
      'Доступ до нього маєш лише ти й оператор. Він використовується лише для розробки й тестування підтримки пристроїв у цьому відкритому проєкті. Він видаляється, коли модель підтримано (не пізніше ніж через 30 днів), або через 12 місяців, і ти можеш будь-коли видалити його та відкликати згоду на сторінці «Мої дані» дашборду. Публікація фрагмента як відкритого тесту потребує окремої згоди.',
    ].join('\n'),
  },
};

/** SHA-256 of exactly what was shown: `en`, a separator line, `uk`. */
export function consentSha256(purpose: DiscoveryPurpose): string {
  const t = CONSENT_TEXTS[purpose];
  return createHash('sha256').update(`${t.en}\n---\n${t.uk}`, 'utf8').digest('hex');
}
