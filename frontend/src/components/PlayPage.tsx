import { useEffect, useMemo, useState } from "react";

type PlayOption = { id: string; text: string; correct: boolean };
type PlayQuestion = { id: string; text: string; options: PlayOption[] };

// Hardcoded quiz data
const sampleQuiz: PlayQuestion[] = [
    {
        id: "p1",
        text: "What is the powerhouse of the cell?",
        options: [
            { id: "p1a", text: "Mitochondria", correct: true },
            { id: "p1b", text: "Nucleus", correct: false },
            { id: "p1c", text: "Ribosome", correct: false },
            { id: "p1d", text: "Golgi apparatus", correct: false },
        ],
    },
    {
        id: "p2",
        text: "Which law explains inertia?",
        options: [
            { id: "p2a", text: "Newton's First Law", correct: true },
            { id: "p2b", text: "Newton's Second Law", correct: false },
            { id: "p2c", text: "Newton's Third Law", correct: false },
        ],
    },
    {
        id: "p3",
        text: "What is the capital of France?",
        options: [
            { id: "p3a", text: "Berlin", correct: false },
            { id: "p3b", text: "Paris", correct: true },
            { id: "p3c", text: "Madrid", correct: false },
        ],
    },
];

export function PlayPage() {
    const [index, setIndex] = useState(0);
    const [selected, setSelected] = useState<string | null>(null); // selected option id
    const [feedback, setFeedback] = useState<"idle" | "correct" | "wrong">(
        "idle",
    ); // feedback state
    const [completed, setCompleted] = useState(false);
    const [menuOpen, setMenuOpen] = useState(false);

    const total = sampleQuiz.length;
    const question = sampleQuiz[index];

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
            if (next >= total) {
                setCompleted(true);
            } else {
                setIndex(next);
                setSelected(null);
                setFeedback("idle");
            }
        }, delay);
    };

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
    if (completed) {
        return (
            <div className="play-shell">
                <div className="play-page">
                    <div className="play-menu">
                        <button
                            className="kebab"
                            onClick={() => setMenuOpen((v) => !v)}
                            aria-label="Open menu"
                        >
                            ⋮⋮⋮
                        </button>
                        {menuOpen && (
                            <div className="dropdown">
                                <button className="dropdown-item" onClick={() => (window.location.hash = "/")}>
                                    Home
                                </button>
                                <button className="dropdown-item" onClick={() => alert("Save & exit coming soon")}>
                                    Save & exit
                                </button>
                                <button className="dropdown-item" onClick={() => setMenuOpen(false)}>
                                    Resume
                                </button>
                            </div>
                        )}
                    </div>
                    <div className="play-question-box">
                        <div className="eyebrow">Quiz complete</div>
                        <h2>Nice work!</h2>
                        <p className="muted">
                            You finished all questions. Review answers or return home.
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
                </div>
            </div>
        </div>
    );
}
