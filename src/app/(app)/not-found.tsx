import Link from "next/link";

export default function NotFound() {
  return (
    <div className="card empty">
      <h1>We can’t find that</h1>
      <p>It may have been deleted, or it belongs to a different account.</p>
      <Link className="btn btn-primary" href="/">
        Back to your courses
      </Link>
    </div>
  );
}
