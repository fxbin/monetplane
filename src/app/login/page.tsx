import { AuthError } from "next-auth";
import { redirect } from "next/navigation";
import { signIn } from "@/auth";

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
  const params = await searchParams;
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
          <p className="login-subtitle">Operator console</p>
        </div>

        <form action={authenticate} className="login-form">
          <div className="form-field">
            <label htmlFor="email" className="form-label">
              Email
            </label>
            <input
              id="email"
              name="email"
              type="email"
              className="form-input"
              placeholder="operator@yourcompany.com"
              autoComplete="email"
              required
            />
          </div>

          <div className="form-field">
            <label htmlFor="password" className="form-label">
              Password
            </label>
            <input
              id="password"
              name="password"
              type="password"
              className="form-input"
              placeholder="Enter your password"
              autoComplete="current-password"
              required
            />
          </div>

          {failed && <p className="form-error">Invalid email or password</p>}

          <input type="hidden" name="redirectTo" value={redirectTo} />

          <button type="submit" className="login-btn">
            Sign in
          </button>
        </form>
      </div>
    </div>
  );
}
