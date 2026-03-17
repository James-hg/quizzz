import { useCallback, useEffect, useReducer, useState } from "react";
import { AIStudyCoach } from "./AIStudyCoach";
import {
    EditorDocumentAction,
    EditorSourceQuiz,
    createEditorDocument,
    editorDocumentReducer,
} from "../editor/draft";

type Props = {
    quiz: EditorSourceQuiz | null;
    folders: {
        id: string;
        name: string;
        parent_id: string | null;
    }[];
    onSave: (quiz: {
        id: string;
        serverId?: string;
        title: string;
        subject: string;
        folderId?: string | null;
        questions: number;
        progress: number;
        lastPlayed: string;
        items: EditorSourceQuiz["items"];
    }) => Promise<boolean>;
    onDuplicate?: (quiz: {
        id: string;
        serverId?: string;
        title: string;
        subject: string;
        folderId?: string | null;
        questions: number;
        progress: number;
        lastPlayed: string;
        items: EditorSourceQuiz["items"];
    }) => Promise<void>;
    onDelete: (id: string, serverId?: string) => void;
    onStartNewDraft?: () => void;
};

export function EditorPage({
    quiz,
    folders,
    onSave,
    onDuplicate,
    onDelete,
    onStartNewDraft,
}: Props) {
    const [document, dispatch] = useReducer(
        editorDocumentReducer,
        quiz,
        createEditorDocument,
    );
    const [dirty, setDirty] = useState(false);
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        dispatch({ type: "hydrate", quiz });
        setDirty(false);
    }, [quiz]);

    const runDraftAction = useCallback((action: EditorDocumentAction) => {
        dispatch(action);
        if (action.type !== "hydrate") {
            setDirty(true);
        }
    }, []);

    const startNewDraft = useCallback(
        (title?: string) => {
            runDraftAction({ type: "start_new_draft", title });
            onStartNewDraft?.();
        },
        [onStartNewDraft, runDraftAction],
    );

    const { draft, sourceQuizId, sourceServerId } = document;
    const currentQuizId = sourceServerId ?? sourceQuizId ?? undefined;

    const handleSave = async () => {
        if (saving) return;
        setSaving(true);
        const trimmedTitle = draft.title.trim() || "Untitled quiz";
        const payload = {
            id: currentQuizId ?? "new",
            serverId: currentQuizId,
            title: trimmedTitle,
            subject: draft.subject.trim() || "No subject",
            folderId: draft.folderId || null,
            questions: draft.questions.length,
            progress: 0,
            lastPlayed: "just now",
            items: draft.questions,
        };
        const ok = await onSave(payload);
        setSaving(false);
        if (ok) {
            setDirty(false);
        }
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
                                    id: "new",
                                    title: draft.title.trim() || "Untitled quiz",
                                    subject: draft.subject.trim() || "No subject",
                                    folderId: draft.folderId || null,
                                    questions: draft.questions.length,
                                    progress: 0,
                                    lastPlayed: "just now",
                                    items: draft.questions,
                                })
                            }
                        >
                            Duplicate
                        </button>
                        {currentQuizId && (
                            <button
                                className="btn third"
                                onClick={() => onDelete(currentQuizId, sourceServerId ?? undefined)}
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
                        value={draft.title}
                        onChange={(event) =>
                            runDraftAction({
                                type: "set_title",
                                title: event.target.value,
                            })
                        }
                    />
                    <input
                        className="option-input"
                        placeholder="Subject (optional)"
                        value={draft.subject}
                        onChange={(event) =>
                            runDraftAction({
                                type: "set_subject",
                                subject: event.target.value,
                            })
                        }
                    />
                    <select
                        className="option-input"
                        value={draft.folderId}
                        onChange={(event) =>
                            runDraftAction({
                                type: "set_folder",
                                folderId: event.target.value,
                            })
                        }
                    >
                        <option value="">No folder</option>
                        {folders.map((folder) => (
                            <option key={folder.id} value={folder.id}>
                                {folder.name}
                            </option>
                        ))}
                    </select>
                </div>

                <div className="editor-box">
                    {draft.questions.map((question, index) => (
                        <div key={question.id} className="question-card">
                            <div className="question-row">
                                <div className="question-label">
                                    Question {index + 1}
                                </div>
                                <div className="question-actions">
                                    <button
                                        className="ghost small"
                                        onClick={() =>
                                            runDraftAction({
                                                type: "duplicate_question",
                                                questionId: question.id,
                                            })
                                        }
                                    >
                                        Duplicate
                                    </button>
                                    <button
                                        className="ghost small"
                                        onClick={() =>
                                            runDraftAction({
                                                type: "delete_question",
                                                questionId: question.id,
                                            })
                                        }
                                        disabled={draft.questions.length <= 1}
                                    >
                                        Delete
                                    </button>
                                </div>
                                <textarea
                                    value={question.text}
                                    onChange={(event) =>
                                        runDraftAction({
                                            type: "set_question_text",
                                            questionId: question.id,
                                            text: event.target.value,
                                        })
                                    }
                                    placeholder="Enter your question..."
                                />
                            </div>
                            <div className="options-grid">
                                {question.options.map((option, optionIndex) => (
                                    <label key={option.id} className="option-row">
                                        <input
                                            type="radio"
                                            name={`correct-${question.id}`}
                                            checked={option.correct}
                                            onChange={() =>
                                                runDraftAction({
                                                    type: "set_correct_option",
                                                    questionId: question.id,
                                                    optionId: option.id,
                                                })
                                            }
                                        />
                                        <input
                                            className="option-input"
                                            value={option.text}
                                            onChange={(event) =>
                                                runDraftAction({
                                                    type: "set_option_text",
                                                    questionId: question.id,
                                                    optionId: option.id,
                                                    text: event.target.value,
                                                })
                                            }
                                            placeholder={`Choice ${optionIndex + 1}`}
                                        />
                                        <button
                                            className="ghost small"
                                            onClick={() =>
                                                runDraftAction({
                                                    type: "remove_option",
                                                    questionId: question.id,
                                                    optionId: option.id,
                                                })
                                            }
                                            disabled={question.options.length <= 2}
                                        >
                                            X
                                        </button>
                                    </label>
                                ))}
                                <div className="options-controls">
                                    <button
                                        className="ghost"
                                        onClick={() =>
                                            runDraftAction({
                                                type: "add_option",
                                                questionId: question.id,
                                            })
                                        }
                                        disabled={question.options.length >= 4}
                                    >
                                        + Add choice
                                    </button>
                                </div>
                            </div>
                        </div>
                    ))}

                    <button
                        className="add-question"
                        onClick={() => runDraftAction({ type: "add_question" })}
                    >
                        + Create new question
                    </button>
                </div>
            </main>

            <aside className="sidebar right sticky">
                <AIStudyCoach
                    key={currentQuizId ?? "new"}
                    mode="editor"
                    editor={{
                        draft,
                        dirty,
                        runDraftAction,
                        startNewDraft,
                    }}
                />
            </aside>
        </div>
    );
}
