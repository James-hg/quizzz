import { useEffect, useMemo, useState } from "react";

type PlayOption = { id: number; text: string; correct: boolean };
type PlayQuestion = { id: number; text: string; options: PlayOption[] };
type PlayQuiz = {
    id: number;
    title: string;
    items: PlayQuestion[];
};

type Props = {
    quiz: PlayQuiz | null;
    sessionId?: string | null;
    onSaveExit?: (progress: { sessionId: string | null; index: number }) => void;
};

export function PlayPage({ quiz, sessionId, onSaveExit }: Props) {
    const [index, setIndex] = useState(0);
    const [selected, setSelected] = useState<number | null>(null); // selected option id
    const [feedback, setFeedback] = useState<"idle" | "correct" | "wrong">(
        "idle",
    ); // feedback state
    const [completed, setCompleted] = useState(false);
    const [responses, setResponses] = useState<
        { questionId: number; selectedOptionId: number; isCorrect: boolean }[]
    >([]);

    const total = quiz?.items.length ?? 0;
    const question = quiz?.items[index];
    const playKey = quiz ? `playState:${quiz.id}` : null;
    const historyKey = quiz ? `playHistory:${quiz.id}` : null;

    // for progress bar
    const progressPercent = useMemo(
        () => Math.round((index / total) * 100),
        [index, total],
    );

    const handleSubmit = () => {
        if (!question || selected === null) return;
        const isRight = question.options.find(
            (o) => o.id === selected,
        )?.correct;
        setFeedback(isRight ? "correct" : "wrong");

        const delay = 900;
        setTimeout(() => {
            const next = index + 1;
            const nextResponses = [
                ...responses,
                {
                    questionId: question.id,
                    selectedOptionId: selected,
                    isCorrect: Boolean(isRight),
                },
            ];
            setResponses(nextResponses);
            if (playKey) {
                localStorage.setItem(
                    playKey,
                    JSON.stringify({ index: next, responses: nextResponses }),
                );
            }
            if (next >= total) {
                setCompleted(true);
                if (historyKey) {
                    const history = JSON.parse(
                        localStorage.getItem(historyKey) || "[]",
                    ) as { completedAt: string; correct: number; total: number }[];
                    const correct = nextResponses.filter((r) => r.isCorrect).length;
                    history.unshift({
                        completedAt: new Date().toISOString(),
                        correct,
                        total,
                    });
                    localStorage.setItem(historyKey, JSON.stringify(history));
                }
                if (playKey) {
                    localStorage.removeItem(playKey);
                }
                if (quiz) {
                    localStorage.removeItem(`playState:${quiz.id}`);
                }
            } else {
                setIndex(next);
                setSelected(null);
                setFeedback("idle");
            }
        }, delay);
    };

    useEffect(() => {
        if (!quiz || !playKey) return;
        const stored = localStorage.getItem(playKey);
        if (!stored) return;
        try {
            const data = JSON.parse(stored) as {
                index: number;
                responses: { questionId: number; selectedOptionId: number; isCorrect: boolean }[];
            };
            if (Number.isFinite(data.index)) setIndex(data.index);
            if (Array.isArray(data.responses)) setResponses(data.responses);
        } catch {
            // ignore
        }
    }, [quiz, playKey]);

    useEffect(() => {
        const handler = (e: KeyboardEvent) => {
            if (completed) return;

            // submit with Enter
            if (e.key === "Enter") {
                e.preventDefault();
                handleSubmit();
                return;
            }

            // quick-select options with 1-4 when not showing feedback
            if (feedback !== "idle") return;
            if (["1", "2", "3", "4"].includes(e.key)) {
                const idx = Number(e.key) - 1;
                const opt = question?.options[idx];
                if (opt) {
                    e.preventDefault();
                    setSelected(opt.id);
                }
            }
        };
        window.addEventListener("keydown", handler);
        return () => window.removeEventListener("keydown", handler);
    }, [feedback, question, completed, selected]);

    // extract to result page later
    if (total === 0 || completed) {
        return (
            <div className="play-shell">
                <div className="play-page">
                    <div className="play-question-box">
                        <div className="eyebrow">Quiz complete</div>
                        <h2>Nice work!</h2>
                        <p className="muted">
                            You finished all questions. Review answers or return
                            home.
                        </p>
                    </div>
                </div>
            </div>
        );
    }

    const handleSaveExit = () => {
        if (onSaveExit) {
            onSaveExit({ sessionId: sessionId ?? null, index });
        }
    };

    return (
        <div className="play-shell">
            <div className="play-page">
                <div className="play-question-box">
                    {/* <div className="count-pill">{`${index + 1}/${total}`}</div> */}
                    <h2>{question.text}</h2>
                </div>

                <div className="choice-grid">
                    {question.options.map((opt, idx) => {
                        const isSelected = selected === opt.id;
                        const showFeedback = feedback !== "idle";
                        const isCorrect = opt.correct;
                        let stateClass = "";
                        if (showFeedback && isSelected && isCorrect)
                            stateClass = "choice-correct";
                        else if (showFeedback && isSelected && !isCorrect)
                            stateClass = "choice-wrong";
                        else if (showFeedback && isCorrect)
                            stateClass = "choice-correct";
                        else if (isSelected) stateClass = "choice-selected";

                        return (
                            <button
                                key={opt.id}
                                className={`choice-card ${stateClass}`}
                                onClick={() => setSelected(opt.id)}
                                disabled={feedback !== "idle"}
                            >
                                <div className="choice-index">{idx + 1}</div>
                                <div className="choice-text">{opt.text}</div>
                            </button>
                        );
                    })}
                </div>

                <div className="play-submit-row">
                    <div className="play-progress">
                        <div className="progress slim">
                            <div
                                className="progress-fill"
                                style={{ width: `${progressPercent}%` }}
                            />
                        </div>
                        <span className="muted">{`${index + 1}/${total}`}</span>
                    </div>
                    <button
                        className="btn primary wide align-right"
                        onClick={handleSubmit}
                        disabled={selected === null || feedback !== "idle"}
                    >
                        Submit ↵
                    </button>
                    <button className="btn secondary" onClick={handleSaveExit}>
                        Save & Exit
                    </button>
                </div>
            </div>
        </div>
    );
}
