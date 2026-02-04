import { useState } from "react";

type PlayOption = { id: number; text: string; correct: boolean };
type PlayQuestion = { id: number; text: string; options: PlayOption[] };
type PlayQuiz = {
    id: number;
    title: string;
    items: PlayQuestion[];
};

type Props = {
    quiz: PlayQuiz | null;
    onBegin: (mode: "new" | "resume") => void;
    hasResume: boolean;
};

export function StartPage({ quiz, onBegin, hasResume }: Props) {
    const [timerEnabled, setTimerEnabled] = useState(true);
    const [readAloud, setReadAloud] = useState(false);

    if (!quiz) {
        return (
            <div className="play-shell">
                <div className="play-page">
                    <div className="placeholder-panel full">
                        <div className="eyebrow">Play</div>
                        <h2>No quiz selected</h2>
                        <p className="muted">
                            Choose a quiz from the dashboard to begin.
                        </p>
                    </div>
                </div>
            </div>
        );
    }

    const total = quiz.items.length;
    const historyKey = `playHistory:${quiz.id}`;
    const history = JSON.parse(localStorage.getItem(historyKey) || "[]") as {
        completedAt: string;
        correct: number;
        total: number;
    }[];
    const attempts = history.length;
    const lastAttempt = history[0];

    return (
        <div className="play-shell">
            <div className="play-page start-layout">
                <div className="start-card">
                    <div className="eyebrow">Quiz</div>
                    <h2>{quiz.title || "Untitled quiz"}</h2>
                    <p className="muted">{total} questions</p>
                    <p className="muted">
                        {attempts
                            ? `Previous attempts: ${attempts} (last ${lastAttempt.correct}/${lastAttempt.total})`
                            : "No previous attempts yet."}
                    </p>
                    <div className="start-actions">
                        {attempts === 0 && (
                            <button className="btn primary wide" onClick={() => onBegin("new")}>
                                Begin
                            </button>
                        )}
                        {attempts > 0 && (
                            <>
                                <button className="btn primary wide" onClick={() => onBegin("new")}>
                                    Start new game
                                </button>
                                {hasResume && (
                                    <button className="btn secondary wide" onClick={() => onBegin("resume")}>
                                        Resume
                                    </button>
                                )}
                            </>
                        )}
                    </div>
                </div>

                <div className="start-card">
                    <div className="eyebrow">Settings</div>
                    <div className="toggle-row">
                        <span>Timer</span>
                        <label className="switch">
                            <input
                                type="checkbox"
                                checked={timerEnabled}
                                onChange={(e) =>
                                    setTimerEnabled(e.target.checked)
                                }
                            />
                            <span className="slider" />
                        </label>
                    </div>
                    <div className="toggle-row">
                        <span>Read text aloud</span>
                        <label className="switch">
                            <input
                                type="checkbox"
                                checked={readAloud}
                                onChange={(e) => setReadAloud(e.target.checked)}
                            />
                            <span className="slider" />
                        </label>
                    </div>
                </div>
            </div>
        </div>
    );
}
