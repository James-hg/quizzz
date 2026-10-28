import type { RewriteContent } from "@/lib/client/types";

type Props = {
  title: string;
  content: RewriteContent;
  /** Parts to mark as changed. */
  changed?: {
    prompt?: boolean;
    code?: boolean;
    options?: boolean;
    answer?: boolean;
    explanation?: boolean;
  };
};

const mark = (on?: boolean) => (on ? <span className="badge badge-warn">changed</span> : null);

/** A read-only view of one version of a question, used for "original" and "proposed". */
export function RewritePreview({ title, content, changed = {} }: Props) {
  return (
    <section className="card" aria-label={title}>
      <h4 style={{ margin: "0 0 0.5rem" }}>{title}</h4>
      <p className="question-prompt">
        {content.prompt} {mark(changed.prompt)}
      </p>
      {content.codeSnippet ? (
        <pre className="code">
          {content.codeSnippet} {mark(changed.code)}
        </pre>
      ) : null}
      {content.options ? (
        <ul className="options">
          {content.options.map((o) => {
            const correct = content.correctOptionIds?.includes(o.id);
            return (
              <li key={o.id} className={`option ${correct ? "option-correct" : ""}`}>
                <span>
                  {o.text}
                  {correct ? <strong> — correct</strong> : null}
                </span>
              </li>
            );
          })}
        </ul>
      ) : null}
      {content.options && changed.options ? (
        <p className="small">{mark(true)} option wording</p>
      ) : null}
      {content.accepted ? (
        <p className="small">
          <strong>Accepted:</strong> {content.accepted.join(" · ")} {mark(changed.answer)}
        </p>
      ) : null}
      {content.blanks ? (
        <ol className="small">
          {content.blanks.map((alts, i) => (
            <li key={i}>
              <strong>Blank {i + 1}:</strong> {alts.join(" | ")}
            </li>
          ))}
        </ol>
      ) : null}
      {content.correctOptionIds && changed.answer ? (
        <p className="small">{mark(true)} answer</p>
      ) : null}
      {content.explanation ? (
        <p className="small muted">
          Explanation: {content.explanation} {mark(changed.explanation)}
        </p>
      ) : changed.explanation ? (
        <p className="small muted">No explanation {mark(true)}</p>
      ) : null}
    </section>
  );
}
