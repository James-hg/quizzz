import { useEffect, useMemo, useState } from "react";

type PlayOption = { id: string; text: string; correct: boolean };
type PlayQuestion = { id: string; text: string; options: PlayOption[] };
type PlayQuiz = {
    id: number;
    title: string;
    items: PlayQuestion[];
    serverId?: string;
};

type Props = {
    quiz: PlayQuiz | null;
    sessionId?: string | null;
    apiBase: string;
    onProgressChange?: (index: number) => void;
    onComplete?: () => void;
};

export function PlayPage({
    quiz,
    sessionId,
    apiBase,
    onProgressChange,
    onComplete,
}: Props) {
    const [index, setIndex] = useState(0);
    const [selected, setSelected] = useState<string | null>(null);
    const [feedback, setFeedback] = useState<"idle" | "correct" | "wrong">(
        "idle",
    );
    const [completed, setCompleted] = useState(false);

    const total = quiz?.items.length ?? 0;
    const question = quiz?.items[index];

    const progressPercent = useMemo(
        () => (total === 0 ? 0 : Math.round((index / total) * 100)),
        [index, total],
    );

    useEffect(() => {
        onProgressChange?.(index);
    }, [index, onProgressChange]);

    // Load session (current_index, responses) if backend exposes it
    useEffect(() => {
        if (!sessionId || !quiz?.serverId) return;
        // Optional: fetch session to resume index; minimal resume for now
        fetch(`${apiBase}/plays/${sessionId}`)
            .then((res) => (res.ok ? res.json() : null))
            .then((data) => {
                if (!data) return;
                if (typeof data.current_index === "number") {
                    setIndex(data.current_index);
                }
            })
            .catch(() => {});
    }, [sessionId, quiz?.serverId, apiBase]);

    const handleSubmit = async () => {
        if (!question || selected === null || !sessionId) return;
        const isRight = question.options.find(
            (o) => o.id === selected,
        )?.correct;
        setFeedback(isRight ? "correct" : "wrong");

        try {
            await fetch(`${apiBase}/plays/${sessionId}/answers`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    question_id: question.id,
                    selected_option_id: selected,
                    session_id: sessionId,
                }),
            });
        } catch (err) {
            console.error("Failed to submit answer:", err);
        }

        setTimeout(async () => {
            const next = index + 1;
            if (next >= total) {
                setCompleted(true);
                try {
                    await fetch(`${apiBase}/plays/${sessionId}/complete`, {
                        method: "PATCH",
                    });
                } catch (err) {
                    console.error("Failed to complete session:", err);
                }
                onComplete?.();
            } else {
                setIndex(next);
                setSelected(null);
                setFeedback("idle");
            }
        }, 900);
    };

    useEffect(() => {
        const handler = (e: KeyboardEvent) => {
            if (completed) return;
            if (e.key === "Enter") {
                e.preventDefault();
                handleSubmit();
                return;
            }
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
    }, [feedback, question, completed, selected, handleSubmit]);

    if (total === 0) {
        return (
            <div className="play-shell">
                <div className="play-page">
                    <div className="play-question-box">
                        <div className="eyebrow">No quiz</div>
                        <h2>Select a quiz to begin</h2>
                    </div>
                </div>
            </div>
        );
    }

    if (completed) {
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

    return (
        <div className="play-shell">
            <div className="play-page">
                <div className="play-question-box">
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
                </div>
            </div>
        </div>
    );
}
