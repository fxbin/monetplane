import { redirect } from "next/navigation";
import { AuthError } from "next-auth";
import { signIn } from "@/auth";
import { getDictionary } from "@/i18n/server";

/**
 * Operator sign-in (#70).
 *
 * Uses a Server Action form so sign-in works with JavaScript disabled
 * (progressive enhancement): a browser that never hydrates the page still
 * performs a real POST and lands on the console. Client-side autofill
 * quirks therefore cannot trap the operator on this page, and credentials
 * never leak into the URL (a plain HTML form would send them as query
 * params).
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [params, dictionary] = await Promise.all([
    searchParams,
    getDictionary(),
  ]);
  const failed = typeof params.error === "string";
  const redirectTo =
    typeof params.callbackUrl === "string" && params.callbackUrl.startsWith("/")
      ? params.callbackUrl
      : "/overview";

  async function authenticate(formData: FormData) {
    "use server";
    try {
      await signIn("credentials", formData);
    } catch (error) {
      // NEXT_REDIRECT (successful sign-in) must propagate; only credential
      // failures bounce back to the form.
      if (error instanceof AuthError) {
        redirect("/login?error=credentials");
      }
      throw error;
    }
  }

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="login-header">
          <h1 className="login-title">MonetPlane</h1>
          <p className="login-subtitle">{dictionary.login.subtitle}</p>
        </div>

        <form action={authenticate} className="login-form">
          <div className="form-field">
            <label className="form-label">
              {dictionary.login.email}
              <input
                name="email"
                type="email"
                className="form-input"
                placeholder={dictionary.login.emailPlaceholder}
                autoComplete="email"
                required
              />
            </label>
          </div>

          <div className="form-field">
            <label className="form-label">
              {dictionary.login.password}
              <input
                name="password"
                type="password"
                className="form-input"
                placeholder={dictionary.login.passwordPlaceholder}
                autoComplete="current-password"
                required
              />
            </label>
          </div>

          {failed && (
            <p className="form-error">{dictionary.login.invalidCredentials}</p>
          )}

          <input type="hidden" name="redirectTo" value={redirectTo} />

          <button type="submit" className="login-btn">
            {dictionary.login.submit}
          </button>
        </form>
      </div>
    </div>
  );
}
