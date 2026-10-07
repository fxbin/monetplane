"use client";

/**
 * Root error boundary (i18n residual sweep): client component, so no
 * server dictionary is reachable here. Both locales are rendered and the
 * active one is selected by `html[lang]` CSS — the root layout stamps
 * `lang` from the locale cookie, so the boundary stays bilingual-safe
 * without any client-side cookie access.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="error-boundary">
      <h1 className="error-boundary-title">
        <span lang="en">Something went wrong</span>
        <span lang="zh">出错了</span>
      </h1>
      <p className="error-boundary-body">
        <span lang="en">
          An unexpected error occurred while rendering this page.
        </span>
        <span lang="zh">渲染此页面时发生了意外错误。</span>
      </p>
      {error.digest ? (
        <p className="error-boundary-digest">digest: {error.digest}</p>
      ) : null}
      <button type="button" className="error-boundary-home" onClick={reset}>
        <span lang="en">Try again</span>
        <span lang="zh">重试</span>
      </button>
    </main>
  );
}
