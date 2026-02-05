import { useEffect, useState } from "react";

type EditableQuestion = {
    id: string;
    text: string;
    options: { id: string; text: string; correct: boolean }[];
};

type Props = {
    quiz: {
        id: string;
        serverId?: string;
        title: string;
        subject: string;
        items: EditableQuestion[];
    } | null;
    onSave: (quiz: {
        id: string;
        serverId?: string;
        title: string;
        subject: string;
        questions: number;
        progress: number;
        lastPlayed: string;
        items: EditableQuestion[];
    }) => Promise<boolean>;
    onDuplicate?: (quiz: {
        id: string;
        serverId?: string;
        title: string;
        subject: string;
        questions: number;
        progress: number;
        lastPlayed: string;
        items: EditableQuestion[];
    }) => Promise<void>;
    onDelete: (id: string, serverId?: string) => void;
};

const newId = () => Math.random().toString(36).slice(2);

const blankQuestion = (id: string): EditableQuestion => ({
    id,
    text: "",
    options: ["A", "B"].map((_, idx) => ({
        id: newId(),
        text: "",
        correct: idx === 0,
    })),
});

export function EditorPage({ quiz, onSave, onDuplicate, onDelete }: Props) {
    const [title, setTitle] = useState(quiz?.title ?? "");
    const [subject, setSubject] = useState(quiz?.subject ?? "");
    const [questions, setQuestions] = useState<EditableQuestion[]>(
        quiz?.items?.length ? quiz.items : [blankQuestion(newId())],
    );
    const [dirty, setDirty] = useState(false);
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        setTitle(quiz?.title ?? "");
        setSubject(quiz?.subject ?? "");
        setQuestions(
            quiz?.items?.length ? quiz.items : [blankQuestion(newId())],
        );
        setDirty(false);
    }, [quiz]);

    const addQuestion = () => {
        const nextIndex = questions.length;
        setQuestions((prev) => [...prev, blankQuestion(newId())]);
        setDirty(true);
    };

    const updateQuestionText = (id: string, text: string) => {
        setQuestions((prev) =>
            prev.map((q) => (q.id === id ? { ...q, text } : q)),
        );
        setDirty(true);
    };

    const updateOption = (qId: string, optId: string, text: string) => {
        setQuestions((prev) =>
            prev.map((q) =>
                q.id !== qId
                    ? q
                    : {
                          ...q,
                          options: q.options.map((o) =>
                              o.id === optId ? { ...o, text } : o,
                          ),
                      },
            ),
        );
        setDirty(true);
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
                      },
            ),
        );
        setDirty(true);
    };

    const addOption = (qId: string) => {
        setQuestions((prev) =>
            prev.map((q) =>
                q.id !== qId || q.options.length >= 4
                    ? q
                    : {
                          ...q,
                          options: [
                              ...q.options,
                              {
                                  id: newId(),
                                  text: "",
                                  correct: false,
                              },
                          ],
                      },
            ),
        );
        setDirty(true);
    };

    const removeOption = (qId: string, optId: string) => {
        setQuestions((prev) =>
            prev.map((q) => {
                if (q.id !== qId || q.options.length <= 2) return q;
                const filtered = q.options.filter((o) => o.id !== optId);
                // ensure one correct remains; if removed correct, set first as correct
                const hasCorrect = filtered.some((o) => o.correct);
                if (!hasCorrect && filtered.length) {
                    filtered[0] = { ...filtered[0], correct: true };
                }
                return { ...q, options: filtered };
            }),
        );
        setDirty(true);
    };

    const deleteQuestion = (qId: string) => {
        setQuestions((prev) => {
            if (prev.length <= 1) return prev; // keep at least one
            return prev.filter((q) => q.id !== qId);
        });
        setDirty(true);
    };

    const duplicateQuestion = (qId: string) => {
        setQuestions((prev) => {
            const found = prev.find((q) => q.id === qId);
            if (!found) return prev;
            const copyId = newId();
            const copy: EditableQuestion = {
                id: copyId,
                text: found.text,
                options: found.options.map((o) => ({
                    ...o,
                    id: o.id,
                })),
            };
            const insertIndex = prev.findIndex((q) => q.id === qId) + 1;
            const next = [...prev];
            next.splice(insertIndex, 0, copy);
            return next;
        });
        setDirty(true);
    };

    const handleSave = async () => {
        if (saving) return;
        setSaving(true);
        const trimmedTitle = title.trim() || "Untitled quiz";
        const payload = {
            id: quiz?.id ?? "new",
            title: trimmedTitle,
            subject: subject.trim() || "No subject",
            questions: questions.length,
            progress: 0,
            lastPlayed: "just now",
            items: questions,
        };
        const ok = await onSave(payload);
        setSaving(false);
        if (ok) setDirty(false);
    };

    return (
        <div className="page editor-layout">
            <main className="main editor-main">
                <header className="main-header">
                    <div>
                        <div className="eyebrow">Quiz editor</div>
                        <h1>Create & edit quiz</h1>
                        <p className="lede">
                            Build questions, set correct answers, and keep
                            everything tidy before you publish.
                        </p>
                    </div>
                    <div className="editor-actions">
                        <a className="btn secondary" href="import">
                            Import
                        </a>
                        <button
                            className="btn primary"
                            onClick={handleSave}
                            disabled={!dirty || saving}
                        >
                            {saving ? "Saving..." : dirty ? "Save" : "Saved"}
                        </button>
                        <button
                            className="btn secondary"
                            onClick={() =>
                                onDuplicate?.({
                                    id: quiz?.id ?? "new",
                                    serverId: quiz?.serverId,
                                    title: title.trim() || "Untitled quiz",
                                    subject: subject.trim() || "No subject",
                                    questions: questions.length,
                                    progress: 0,
                                    lastPlayed: "just now",
                                    items: questions,
                                })
                            }
                        >
                            Duplicate
                        </button>
                        {quiz?.id && (
                            <button
                                className="btn third"
                                onClick={() => onDelete(quiz.id, quiz.serverId)}
                            >
                                Delete
                            </button>
                        )}
                    </div>
                </header>

                <div className="editor-metadata">
                    <input
                        className="option-input"
                        placeholder="Quiz title"
                        value={title}
                        onChange={(e) => {
                            setTitle(e.target.value);
                            setDirty(true);
                        }}
                    />
                    <input
                        className="option-input"
                        placeholder="Subject (optional)"
                        value={subject}
                        onChange={(e) => {
                            setSubject(e.target.value);
                            setDirty(true);
                        }}
                    />
                </div>

                <div className="editor-box">
                    {questions.map((q, idx) => (
                        <div key={q.id} className="question-card">
                            <div className="question-row">
                                <div className="question-label">
                                    Question {idx + 1}
                                </div>
                                <div className="question-actions">
                                    <button
                                        className="ghost small"
                                        onClick={() => duplicateQuestion(q.id)}
                                    >
                                        Duplicate
                                    </button>
                                    <button
                                        className="ghost small"
                                        onClick={() => deleteQuestion(q.id)}
                                        disabled={questions.length <= 1}
                                    >
                                        Delete
                                    </button>
                                </div>
                                <textarea
                                    value={q.text}
                                    onChange={(e) =>
                                        updateQuestionText(q.id, e.target.value)
                                    }
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
                                            onChange={() =>
                                                markCorrect(q.id, opt.id)
                                            }
                                        />
                                        <input
                                            className="option-input"
                                            value={opt.text}
                                            onChange={(e) =>
                                                updateOption(
                                                    q.id,
                                                    opt.id,
                                                    e.target.value,
                                                )
                                            }
                                            placeholder={`Choice ${oi + 1}`}
                                        />
                                        <button
                                            className="ghost small"
                                            onClick={() =>
                                                removeOption(q.id, opt.id)
                                            }
                                            disabled={q.options.length <= 2}
                                        >
                                            ✕
                                        </button>
                                    </label>
                                ))}
                                <div className="options-controls">
                                    <button
                                        className="ghost"
                                        onClick={() => addOption(q.id)}
                                        disabled={q.options.length >= 4}
                                    >
                                        + Add choice
                                    </button>
                                </div>
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
                    This panel will host the quiz-editing assistant. As you add
                    questions and options, the chatbot will stay in view to
                    suggest fixes or generate variations.
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
