import { cookies } from "next/headers";
import { type Dictionary, en } from "./dictionaries/en";
import { zh } from "./dictionaries/zh";

/**
 * Cookie-based locale resolution (i18n decision, 2026-10-04).
 *
 * Route-based locales (/en/…, /zh/…) were rejected for this console: every
 * page is a server component reading session/application cookies anyway,
 * so a locale cookie keeps URLs stable and avoids restructuring 28 route
 * segments. Default is English (the existing console language); an unknown
 * cookie value falls back to English, never to an error.
 */

export const LOCALE_COOKIE = "monetplane_locale";

export const LOCALES = ["en", "zh"] as const;
export type Locale = (typeof LOCALES)[number];

export function resolveLocale(value: string | undefined): Locale {
  return value === "zh" ? "zh" : "en";
}

export async function getLocale(): Promise<Locale> {
  const store = await cookies();
  return resolveLocale(store.get(LOCALE_COOKIE)?.value);
}

export async function getDictionary(): Promise<Dictionary> {
  return (await getLocale()) === "zh" ? zh : en;
}

/** Replaces `{placeholder}` tokens — the only interpolation mechanism. */
export function formatMessage(
  template: string,
  values: Record<string, string>,
): string {
  let result = template;
  for (const [key, value] of Object.entries(values)) {
    result = result.replaceAll(`{${key}}`, value);
  }
  return result;
}
