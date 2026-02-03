import { useState } from "react";

type EditableQuestion = {
    id: string;
    text: string;
    options: { id: string; text: string; correct: boolean }[];
};

export function EditorPage() {
    const [questions, setQuestions] = useState<EditableQuestion[]>([
        {
            id: "q-1",
            text: "",
            options: ["A", "B", "C", "D"].map((_, idx) => ({
                id: `q-1-${idx}`,
                text: "",
                correct: idx === 0,
            })),
        },
    ]);

    const addQuestion = () => {
        const nextIndex = questions.length + 1;
        setQuestions((prev) => [
            ...prev,
            {
                id: `q-${nextIndex}`,
                text: "",
                options: ["A", "B", "C", "D"].map((_, idx) => ({
                    id: `q-${nextIndex}-${idx}`,
                    text: "",
                    correct: idx === 0,
                })),
            },
        ]);
    };

    const updateQuestionText = (id: string, text: string) => {
        setQuestions((prev) =>
            prev.map((q) => (q.id === id ? { ...q, text } : q))
        );
    };

    const updateOption = (qId: string, optId: string, text: string) => {
        setQuestions((prev) =>
            prev.map((q) =>
                q.id !== qId
                    ? q
                    : {
                          ...q,
                          options: q.options.map((o) =>
                              o.id === optId ? { ...o, text } : o
                          ),
                      }
            )
        );
    };

    const markCorrect = (qId: string, optId: string) => {
        setQuestions((prev) =>
            prev.map((q) =>
                q.id !== qId
                    ? q
                    : {
                          ...q,
                          options: q.options.map((o) => ({
                              ...o,
                              correct: o.id === optId,
                          })),
                      }
            )
        );
    };

    return (
        <div className="page editor-layout">
            <main className="main editor-main">
                <header className="main-header">
                    <div>
                        <div className="eyebrow">Quiz editor</div>
                        <h1>Create & edit quiz</h1>
                        <p className="lede">
                            Build questions, set correct answers, and keep everything tidy before you publish.
                        </p>
                    </div>
                </header>

                <div className="editor-box">
                    {questions.map((q, idx) => (
                        <div key={q.id} className="question-card">
                            <div className="question-row">
                                <div className="question-label">Question {idx + 1}</div>
                                <textarea
                                    value={q.text}
                                    onChange={(e) => updateQuestionText(q.id, e.target.value)}
                                    placeholder="Enter your question..."
                                />
                            </div>
                            <div className="options-grid">
                                {q.options.map((opt, oi) => (
                                    <label key={opt.id} className="option-row">
                                        <input
                                            type="radio"
                                            name={`correct-${q.id}`}
                                            checked={opt.correct}
                                            onChange={() => markCorrect(q.id, opt.id)}
                                        />
                                        <input
                                            className="option-input"
                                            value={opt.text}
                                            onChange={(e) =>
                                                updateOption(q.id, opt.id, e.target.value)
                                            }
                                            placeholder={`Choice ${oi + 1}`}
                                        />
                                    </label>
                                ))}
                            </div>
                        </div>
                    ))}

                    <button className="add-question" onClick={addQuestion}>
                        + Create new question
                    </button>
                </div>
            </main>

            <aside className="sidebar right sticky">
                <div className="eyebrow">AI Chatbot</div>
                <h3>Placeholder</h3>
                <p className="muted">
                    This panel will host the quiz-editing assistant. As you add questions and options, the chatbot
                    will stay in view to suggest fixes or generate variations.
                </p>
                <div className="placeholder-card">
                    <div className="placeholder-bubble" />
                    <div className="placeholder-lines">
                        <span />
                        <span />
                        <span />
                    </div>
                </div>
            </aside>
        </div>
    );
}
