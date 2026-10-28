import type { CorrectAnswer, PlayItem, PlayQuestion, PlayResponse } from "@/lib/client/types";

/** The student's own answer, in words. */
export function describeResponse(question: PlayQuestion, response: PlayResponse): string {
  if (response.kind === "options") {
    const texts = response.selectedOptionIds.map(
      (id) => question.options.find((o) => o.id === id)?.text ?? id,
    );
    return texts.join("; ") || "(nothing chosen)";
  }
  if (response.kind === "blanks") return response.values.join(" | ");
  return response.text;
}

/** The correct answer, in words. */
export function describeCorrect(question: PlayQuestion, answer: CorrectAnswer): string {
  if (answer.kind === "options") {
    return answer.correctOptionIds
      .map((id) => question.options.find((o) => o.id === id)?.text ?? id)
      .join("; ");
  }
  if (answer.kind === "text") return answer.accepted.join(" or ");
  if (answer.kind === "blanks") return answer.blanks.map((alts) => alts.join(" or ")).join(" | ");
  return "No correct answer has been set.";
}

type Answered = Extract<PlayItem, { status: "answered" }>;

const mark = (outcome?: string) =>
  outcome === "correct" ? "✓" : outcome === "incorrect" ? "✗" : "?";

/**
 * Every answer of a finished session with its correct answer: the reason to hold results back
 * until the end. A retry is shown under its first try.
 */
export function ResultsReview({ items }: { items: PlayItem[] }) {
  const answered = items.filter(
    (i): i is Answered => i.status === "answered" && Boolean(i.question),
  );
  const first = answered.filter((i) => i.pass === 1);
  if (first.length === 0) return null;
  const retryOf = new Map(answered.filter((i) => i.pass === 2).map((i) => [i.questionId, i]));

  return (
    <section aria-labelledby="review-heading" className="stack-sm">
      <h2 id="review-heading">Review your answers</h2>
      <ol className="list" aria-label="Answers">
        {first.map((item) => {
          const question = item.question!;
          const retry = retryOf.get(item.questionId);
          const result = item.result;
          return (
            <li key={item.questionId} className="stack-sm">
              <p>
                <strong>{question.prompt}</strong>
              </p>
              {question.image ? (
                // eslint-disable-next-line @next/next/no-img-element -- an authenticated API route
                <img className="question-image" src={question.image.url} alt={question.image.alt} />
              ) : null}
              {question.codeSnippet ? <pre className="code">{question.codeSnippet}</pre> : null}
              <p className="small">
                <span aria-label={result.outcome}>{mark(result.outcome)}</span> Your answer:{" "}
                {describeResponse(question, result.response)}
              </p>
              {retry ? (
                <p className="small">
                  <span aria-label={retry.result.outcome}>{mark(retry.result.outcome)}</span> Second
                  try: {describeResponse(question, retry.result.response)}
                </p>
              ) : null}
              {result.correctAnswer ? (
                <p className="small">
                  <strong>Correct answer:</strong> {describeCorrect(question, result.correctAnswer)}
                </p>
              ) : null}
              {result.explanation ? <p className="small muted">{result.explanation}</p> : null}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
