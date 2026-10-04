import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { getLocale, LOCALE_COOKIE, type Locale } from "@/i18n/server";

/**
 * Console language switcher. A Server Action form (progressive
 * enhancement — works without JS) sets the locale cookie and revalidates
 * the layout; every server component re-renders in the new locale.
 */
export async function LocaleSwitcher() {
  const locale = await getLocale();

  async function switchLocale(formData: FormData) {
    "use server";
    const next = formData.get("locale");
    if (next !== "en" && next !== "zh") return;
    const store = await cookies();
    store.set(LOCALE_COOKIE, next as Locale, {
      httpOnly: false,
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 24 * 365,
    });
    revalidatePath("/", "layout");
  }

  const options: Array<{ value: Locale; label: string }> = [
    { value: "en", label: "EN" },
    { value: "zh", label: "中文" },
  ];

  return (
    <form
      className="locale-switcher"
      action={switchLocale}
      aria-label="Language / 语言"
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="submit"
          name="locale"
          value={option.value}
          className={`locale-switcher-option${locale === option.value ? " is-active" : ""}`}
          aria-pressed={locale === option.value}
        >
          {option.label}
        </button>
      ))}
    </form>
  );
}
