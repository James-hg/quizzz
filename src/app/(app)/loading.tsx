export default function Loading() {
  return (
    <div aria-busy="true" aria-live="polite" className="stack">
      <div className="skeleton" style={{ width: "40%", height: "2rem" }} />
      <div className="skeleton" style={{ width: "100%", height: "6rem" }} />
      <div className="skeleton" style={{ width: "100%", height: "6rem" }} />
      <span className="visually-hidden">Loading…</span>
    </div>
  );
}
