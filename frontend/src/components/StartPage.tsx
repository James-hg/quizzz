import { useEffect, useState } from "react";

type PlayOption = { id: string; text: string; correct: boolean };
type PlayQuestion = { id: string; text: string; options: PlayOption[] };
type PlayQuiz = {
    id: string;
    title: string;
    items: PlayQuestion[];
};

type Props = {
    quiz: PlayQuiz | null;
    apiBase: string;
    onBegin: (
        mode: "new" | "resume",
        opts: { shuffleQuestions: boolean; shuffleChoices: boolean },
        resumeSessionId?: string | null,
    ) => void;
};

export function StartPage({ quiz, apiBase, onBegin }: Props) {
    const [timerEnabled, setTimerEnabled] = useState(true);
    const [shuffleQ, setShuffleQ] = useState(false);
    const [shuffleC, setShuffleC] = useState(false);
    const [attempts, setAttempts] = useState<number>(0);
    const [lastAttempt, setLastAttempt] = useState<{
        correct: number;
        total: number;
    } | null>(null);
    const [resumeSessionId, setResumeSessionId] = useState<string | null>(null);

    useEffect(() => {
        const fetchMeta = async () => {
            if (!quiz) return;
            // history
            try {
                const hResp = await fetch(
                    `${apiBase}/quizzes/${quiz.id}/history`,
                );
                if (hResp.ok) {
                    const hist = await hResp.json();
                    setAttempts(hist.length);
                    if (hist.length) {
                        setLastAttempt({
                            correct: hist[0].correct ?? 0,
                            total: hist[0].total ?? 0,
                        });
                    } else {
                        setLastAttempt(null);
                    }
                }
            } catch {
                setAttempts(0);
                setLastAttempt(null);
            }
            // active session for resume
            try {
                const sResp = await fetch(
                    `${apiBase}/quizzes/${quiz.id}/session`,
                );
                if (sResp.ok) {
                    const data = await sResp.json();
                    setResumeSessionId(data.id);
                } else {
                    setResumeSessionId(null);
                }
            } catch {
                setResumeSessionId(null);
            }
        };
        fetchMeta();
    }, [quiz, apiBase]);

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

    return (
        <div className="play-shell">
            <div className="play-page start-layout">
                <div className="start-card">
                    <div className="eyebrow">Quiz</div>
                    <h2>{quiz.title || "Untitled quiz"}</h2>
                    <p className="muted">{total} questions</p>
                    {resumeSessionId && (
                        <p
                            className="muted"
                            style={{ color: "#10b981", fontWeight: 500 }}
                        >
                            ⏸ In progress - You can resume where you left off
                        </p>
                    )}
                    <p className="muted">
                        {attempts
                            ? `Previous attempts: ${attempts}${
                                  lastAttempt
                                      ? ` (last ${lastAttempt.correct}/${lastAttempt.total})`
                                      : ""
                              }`
                            : "No previous attempts yet."}
                    </p>
                    <div className="start-actions">
                        {attempts === 0 && (
                            <button
                                className="btn primary wide"
                                onClick={() =>
                                    onBegin("new", {
                                        shuffleQuestions: shuffleQ,
                                        shuffleChoices: shuffleC,
                                    })
                                }
                            >
                                Begin
                            </button>
                        )}
                        {attempts > 0 && (
                            <>
                                <button
                                    className="btn primary wide"
                                    onClick={() =>
                                        onBegin("new", {
                                            shuffleQuestions: shuffleQ,
                                            shuffleChoices: shuffleC,
                                        })
                                    }
                                >
                                    Start new game
                                </button>
                                {resumeSessionId && (
                                    <button
                                        className="btn secondary wide"
                                        onClick={() =>
                                            onBegin(
                                                "resume",
                                                {
                                                    shuffleQuestions: shuffleQ,
                                                    shuffleChoices: shuffleC,
                                                },
                                                resumeSessionId,
                                            )
                                        }
                                    >
                                        Resume
                                    </button>
                                )}
                            </>
                        )}
                    </div>

                    <div className="muted">Settings</div>
                    <div className="toggle-row">
                        <span>Shuffle questions</span>
                        <label className="switch">
                            <input
                                type="checkbox"
                                checked={shuffleQ}
                                onChange={(e) => setShuffleQ(e.target.checked)}
                            />
                            <span className="slider" />
                        </label>
                    </div>
                    <div className="toggle-row">
                        <span>Shuffle choices</span>
                        <label className="switch">
                            <input
                                type="checkbox"
                                checked={shuffleC}
                                onChange={(e) => setShuffleC(e.target.checked)}
                            />
                            <span className="slider" />
                        </label>
                    </div>
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
                </div>
            </div>
        </div>
    );
}
