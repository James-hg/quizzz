"use client";

export default function ErrorPage({ retry }: { error: Error; retry: () => void }) {
  return (
    <div className="card empty" role="alert">
      <h1>Something went wrong</h1>
      <p>We could not load this page. Your work is saved.</p>
      <button type="button" className="btn btn-primary" onClick={() => retry()}>
        Try again
      </button>
    </div>
  );
}
