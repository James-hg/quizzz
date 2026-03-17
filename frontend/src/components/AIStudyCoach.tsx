import { FormEvent, useMemo, useState } from "react";
import { createChatProvider } from "../ai/chatClient";
import {
    buildShuffledChoices,
    buildShuffledQuestionOrder,
    parseCorrectAnswer,
    parseEditorIntent,
    parseOptionList,
    resolveQuestionTarget,
    summarizeQuestion,
    type ParsedEditorIntent,
    type ResolvedQuestionTarget,
} from "../ai/editorActions";
import { ChatMessage } from "../ai/types";
import {
    EditableOption,
    EditableQuestion,
    EditorDocumentAction,
    EditorDraft,
    createQuestionFromTexts,
} from "../editor/draft";

const provider = createChatProvider();

type EditorCoachContext = {
    draft: EditorDraft;
    dirty: boolean;
    runDraftAction: (action: EditorDocumentAction) => void;
    startNewDraft: (title?: string) => void;
};

type Props =
    | {
          mode?: "general";
          editor?: never;
      }
    | {
          mode: "editor";
          editor: EditorCoachContext;
      };

type PendingEditorAction =
    | { kind: "confirm_create_quiz"; title?: string }
    | { kind: "add_question_text" }
    | { kind: "add_question_options"; questionText: string }
    | { kind: "add_question_correct"; questionText: string; optionTexts: string[] }
    | {
          kind: "confirm_add_question";
          questionText: string;
          optionTexts: string[];
          correctIndex: number;
      }
    | { kind: "remove_question_target" }
    | { kind: "confirm_remove_question"; target: ResolvedQuestionTarget }
    | { kind: "update_question_target"; changes?: UpdateDraftChanges }
    | {
          kind: "update_question_text";
          target: ResolvedQuestionTarget;
          changes: UpdateDraftChanges;
      }
    | {
          kind: "update_question_options";
          target: ResolvedQuestionTarget;
          changes: UpdateDraftChanges;
      }
    | {
          kind: "update_question_correct";
          target: ResolvedQuestionTarget;
          changes: UpdateDraftChanges;
      }
    | {
          kind: "confirm_update_question";
          target: ResolvedQuestionTarget;
          nextQuestion: EditableQuestion;
      }
    | { kind: "randomize_question_target" }
    | {
          kind: "confirm_randomize_question";
          target: ResolvedQuestionTarget;
          nextQuestion: EditableQuestion;
      }
    | {
          kind: "confirm_shuffle_questions";
          questionIds: string[];
          summary: string[];
      }
    | {
          kind: "confirm_shuffle_choices";
          choicesByQuestionId: Record<string, EditableOption[]>;
          summary: string[];
      };

type UpdateDraftChanges = {
    questionText?: string;
    optionTexts?: string[];
    correctIndex?: number;
    correctAnswerInput?: string | number;
};

type RandomizeQuestionResponse = {
    questionText?: string;
    options?: string[];
    correctOptionIndex?: number;
};

const actionHints = [
    "create quiz",
    "add question",
    "remove question 2",
    "update question 1",
    "randomize question 3",
    "shuffle questions",
    "shuffle choices",
];

function createWelcomeMessage(mode: Props["mode"]): ChatMessage {
    return {
        id: "welcome",
        role: "assistant",
        content:
            mode === "editor"
                ? [
                      "I can edit this quiz draft for you.",
                      "Try actions like: create quiz, add question, remove question 2, update question 1, randomize question 3, shuffle questions, or shuffle choices.",
                      "I will always show a preview before I change the draft.",
                  ].join("\n\n")
                : "I am your study coach. Ask for quiz ideas, revision plans, or question improvements.",
        createdAt: Date.now(),
    };
}

export function AIStudyCoach(props: Props) {
    const isEditorMode = props.mode === "editor";
    const [messages, setMessages] = useState<ChatMessage[]>([
        createWelcomeMessage(props.mode),
    ]);
    const [draft, setDraft] = useState("");
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [pendingAction, setPendingAction] = useState<PendingEditorAction | null>(null);

    const hasGemini = useMemo(() => provider.name === "gemini", []);

    const appendAssistantMessage = (content: string) => {
        setMessages((prev) => [
            ...prev,
            {
                id: `${Date.now()}-a-${Math.random().toString(36).slice(2, 7)}`,
                role: "assistant",
                content,
                createdAt: Date.now(),
            },
        ]);
    };

    const clearPendingAction = (message?: string) => {
        setPendingAction(null);
        if (message) {
            appendAssistantMessage(message);
        }
    };

    const handleConfirm = () => {
        if (!isEditorMode || !pendingAction) {
            return;
        }

        switch (pendingAction.kind) {
            case "confirm_create_quiz":
                props.editor.startNewDraft(pendingAction.title);
                clearPendingAction(
                    pendingAction.title
                        ? `Started a new draft named "${pendingAction.title}".`
                        : "Started a new blank quiz draft.",
                );
                return;
            case "confirm_add_question":
                props.editor.runDraftAction({
                    type: "add_question",
                    question: createQuestionFromTexts({
                        questionText: pendingAction.questionText,
                        optionTexts: pendingAction.optionTexts,
                        correctIndex: pendingAction.correctIndex,
                    }),
                });
                clearPendingAction("Added the new question to your draft.");
                return;
            case "confirm_remove_question":
                props.editor.runDraftAction({
                    type: "delete_question",
                    questionId: pendingAction.target.question.id,
                });
                clearPendingAction(
                    `Removed question ${pendingAction.target.index + 1} from the draft.`,
                );
                return;
            case "confirm_update_question":
                props.editor.runDraftAction({
                    type: "replace_question",
                    questionId: pendingAction.target.question.id,
                    question: pendingAction.nextQuestion,
                });
                clearPendingAction(
                    `Updated question ${pendingAction.target.index + 1}.`,
                );
                return;
            case "confirm_randomize_question":
                props.editor.runDraftAction({
                    type: "replace_question",
                    questionId: pendingAction.target.question.id,
                    question: pendingAction.nextQuestion,
                });
                clearPendingAction(
                    `Reworded question ${pendingAction.target.index + 1}.`,
                );
                return;
            case "confirm_shuffle_questions":
                props.editor.runDraftAction({
                    type: "set_question_order",
                    questionIds: pendingAction.questionIds,
                });
                clearPendingAction("Shuffled the order of the questions.");
                return;
            case "confirm_shuffle_choices":
                props.editor.runDraftAction({
                    type: "set_choices_for_all",
                    choicesByQuestionId: pendingAction.choicesByQuestionId,
                });
                clearPendingAction(
                    "Shuffled the choices for every question. Correct answers stayed intact.",
                );
                return;
            default:
                return;
        }
    };

    const handleCancel = () => {
        clearPendingAction("Canceled the pending edit.");
    };

    const submit = async (event: FormEvent) => {
        event.preventDefault();
        const text = draft.trim();
        if (!text || loading) return;

        const userMessage: ChatMessage = {
            id: `${Date.now()}-u`,
            role: "user",
            content: text,
            createdAt: Date.now(),
        };

        setError(null);
        setDraft("");
        setMessages((prev) => [...prev, userMessage]);

        try {
            if (isEditorMode && isCancelCommand(text) && pendingAction) {
                handleCancel();
                return;
            }

            if (isEditorMode && pendingAction) {
                await handlePendingEditorInput(text);
                return;
            }

            if (isEditorMode) {
                const handled = await handleEditorIntent(text);
                if (handled) {
                    return;
                }
            }

            setLoading(true);
            const reply = await provider.generateReply({
                messages,
                userMessage: isEditorMode
                    ? buildEditorChatPrompt(text, props.editor.draft)
                    : text,
            });
            setMessages((prev) => [
                ...prev,
                {
                    id: `${Date.now()}-a`,
                    role: "assistant",
                    content: reply,
                    createdAt: Date.now(),
                },
            ]);
        } catch (err) {
            setError(err instanceof Error ? err.message : "Failed to get AI response.");
        } finally {
            setLoading(false);
        }
    };

    const handleEditorIntent = async (input: string) => {
        if (!isEditorMode) {
            return false;
        }

        const intent = parseEditorIntent(input);

        switch (intent.kind) {
            case "create_quiz":
                setPendingAction({
                    kind: "confirm_create_quiz",
                    title: intent.title,
                });
                appendAssistantMessage(
                    props.editor.dirty || hasMeaningfulDraft(props.editor.draft)
                        ? intent.title
                            ? `I can reset this editor to a new draft named "${intent.title}". Confirm to discard the current unsaved state.`
                            : "I can reset this editor to a new blank draft. Confirm to discard the current unsaved state."
                        : intent.title
                          ? `Ready to start a new draft named "${intent.title}". Confirm when you want me to reset the editor.`
                          : "Ready to start a new blank draft. Confirm when you want me to reset the editor.",
                );
                return true;
            case "add_question":
                if (intent.questionText) {
                    setPendingAction({
                        kind: "add_question_options",
                        questionText: intent.questionText,
                    });
                    appendAssistantMessage(
                        "Send the answer choices next. Use one per line or separate them with |. I need between 2 and 4 choices.",
                    );
                } else {
                    setPendingAction({ kind: "add_question_text" });
                    appendAssistantMessage("What should the new question ask?");
                }
                return true;
            case "remove_question":
                return handleTargetedIntent(intent, "remove");
            case "update_question":
                return handleTargetedIntent(intent, "update");
            case "randomize_question":
                return handleTargetedIntent(intent, "randomize");
            case "shuffle_questions": {
                if (props.editor.draft.questions.length <= 1) {
                    appendAssistantMessage("You need at least two questions before I can shuffle them.");
                    return true;
                }

                const proposal = buildShuffledQuestionOrder(props.editor.draft);
                setPendingAction({
                    kind: "confirm_shuffle_questions",
                    questionIds: proposal.questionIds,
                    summary: proposal.summary,
                });
                appendAssistantMessage(
                    "I prepared a new question order. Confirm if you want me to apply it.",
                );
                return true;
            }
            case "shuffle_choices": {
                const proposal = buildShuffledChoices(props.editor.draft);
                setPendingAction({
                    kind: "confirm_shuffle_choices",
                    choicesByQuestionId: proposal.choicesByQuestionId,
                    summary: proposal.summary,
                });
                appendAssistantMessage(
                    "I prepared a full-quiz choice shuffle. Confirm if you want me to apply it.",
                );
                return true;
            }
            case "chat":
            default:
                return false;
        }
    };

    const handlePendingEditorInput = async (input: string) => {
        if (!isEditorMode || !pendingAction) {
            return;
        }

        switch (pendingAction.kind) {
            case "add_question_text": {
                setPendingAction({
                    kind: "add_question_options",
                    questionText: input,
                });
                appendAssistantMessage(
                    "Now send the answer choices. Use one per line or separate them with |. I need between 2 and 4 choices.",
                );
                return;
            }
            case "add_question_options": {
                const optionTexts = parseOptionList(input);
                if (optionTexts.length < 2 || optionTexts.length > 4) {
                    appendAssistantMessage(
                        "I need between 2 and 4 choices. Send them again, one per line or separated with |.",
                    );
                    return;
                }

                setPendingAction({
                    kind: "add_question_correct",
                    questionText: pendingAction.questionText,
                    optionTexts,
                });
                appendAssistantMessage(
                    "Which option is correct? Reply with the choice number or the exact text.",
                );
                return;
            }
            case "add_question_correct": {
                const correctIndex = parseCorrectAnswer(input, pendingAction.optionTexts);
                if (correctIndex === null) {
                    appendAssistantMessage(
                        "I could not match that answer. Reply with the choice number or the exact option text.",
                    );
                    return;
                }

                setPendingAction({
                    kind: "confirm_add_question",
                    questionText: pendingAction.questionText,
                    optionTexts: pendingAction.optionTexts,
                    correctIndex,
                });
                appendAssistantMessage(
                    "I have the new question ready. Review the preview and confirm if it looks right.",
                );
                return;
            }
            case "remove_question_target":
                await resolvePendingTarget(input, "remove");
                return;
            case "update_question_target":
                await resolvePendingTarget(input, "update", pendingAction.changes);
                return;
            case "randomize_question_target":
                await resolvePendingTarget(input, "randomize");
                return;
            case "update_question_text": {
                const changes = {
                    ...pendingAction.changes,
                    questionText: isSkipCommand(input) ? undefined : input,
                };
                setPendingAction({
                    kind: "update_question_options",
                    target: pendingAction.target,
                    changes,
                });
                appendAssistantMessage(
                    "Send the full option list next, or type skip to keep the current choices.",
                );
                return;
            }
            case "update_question_options": {
                const optionTexts = isSkipCommand(input)
                    ? undefined
                    : parseOptionList(input);
                if (optionTexts && (optionTexts.length < 2 || optionTexts.length > 4)) {
                    appendAssistantMessage(
                        "I need between 2 and 4 choices. Send the full list again, or type skip.",
                    );
                    return;
                }

                const changes = {
                    ...pendingAction.changes,
                    optionTexts,
                };
                const nextQuestion = buildUpdatedQuestion(
                    pendingAction.target.question,
                    changes,
                );

                if (!nextQuestion) {
                    setPendingAction({
                        kind: "update_question_correct",
                        target: pendingAction.target,
                        changes,
                    });
                    appendAssistantMessage(
                        "Which option should be correct after this update? Reply with the choice number or exact text, or type skip to keep the current correct answer if it still exists.",
                    );
                    return;
                }

                setPendingAction({
                    kind: "confirm_update_question",
                    target: pendingAction.target,
                    nextQuestion,
                });
                appendAssistantMessage(
                    "I prepared the updated question. Review the preview and confirm if it is right.",
                );
                return;
            }
            case "update_question_correct": {
                const optionTexts =
                    pendingAction.changes.optionTexts ??
                    pendingAction.target.question.options.map((option) => option.text);
                const correctIndex = isSkipCommand(input)
                    ? undefined
                    : parseCorrectAnswer(input, optionTexts);
                if (!isSkipCommand(input) && correctIndex === null) {
                    appendAssistantMessage(
                        "I could not match that answer. Reply with the choice number or exact text, or type skip.",
                    );
                    return;
                }

                const nextQuestion = buildUpdatedQuestion(pendingAction.target.question, {
                    ...pendingAction.changes,
                    correctIndex,
                });
                if (!nextQuestion) {
                    appendAssistantMessage(
                        "I still could not determine the correct answer for the updated choices. Please send the correct choice number or exact text.",
                    );
                    return;
                }

                setPendingAction({
                    kind: "confirm_update_question",
                    target: pendingAction.target,
                    nextQuestion,
                });
                appendAssistantMessage(
                    "I prepared the updated question. Review the preview and confirm if it is right.",
                );
                return;
            }
            default:
                return;
        }
    };

    const handleTargetedIntent = async (
        intent: ParsedEditorIntent,
        mode: "remove" | "update" | "randomize",
    ) => {
        if (!isEditorMode) {
            return false;
        }

        const resolution = resolveQuestionTarget(props.editor.draft, intent.target);
        if (resolution.status === "missing") {
            setPendingAction(
                mode === "remove"
                    ? { kind: "remove_question_target" }
                    : mode === "update"
                      ? {
                            kind: "update_question_target",
                            changes: normalizeUpdateChanges(intent.changes),
                        }
                      : { kind: "randomize_question_target" },
            );
            appendAssistantMessage("Which question do you want me to target?");
            return true;
        }

        if (resolution.status === "ambiguous") {
            setPendingAction(
                mode === "remove"
                    ? { kind: "remove_question_target" }
                    : mode === "update"
                      ? {
                            kind: "update_question_target",
                            changes: normalizeUpdateChanges(intent.changes),
                        }
                      : { kind: "randomize_question_target" },
            );
            appendAssistantMessage(
                [
                    "I found more than one matching question. Be more specific with a number or exact text.",
                    ...resolution.candidates.map((candidate) =>
                        summarizeQuestion(candidate.question, candidate.index),
                    ),
                ].join("\n"),
            );
            return true;
        }

        if (mode === "remove") {
            if (props.editor.draft.questions.length <= 1) {
                appendAssistantMessage(
                    "This quiz only has one question left. I cannot remove the final question.",
                );
                return true;
            }
            setPendingAction({
                kind: "confirm_remove_question",
                target: resolution.target,
            });
            appendAssistantMessage(
                `I found question ${resolution.target.index + 1}. Confirm if you want me to remove it.`,
            );
            return true;
        }

        if (mode === "update") {
            startUpdateFlow(resolution.target, normalizeUpdateChanges(intent.changes));
            return true;
        }

        await startRandomizeFlow(resolution.target);
        return true;
    };

    const resolvePendingTarget = async (
        input: string,
        mode: "remove" | "update" | "randomize",
        changes?: UpdateDraftChanges,
    ) => {
        if (!isEditorMode) {
            return;
        }

        const resolution = resolveQuestionTarget(
            props.editor.draft,
            parseEditorIntent(`update question ${input}`).target,
        );

        if (resolution.status === "missing") {
            appendAssistantMessage(
                "I still could not find that question. Reply with a number like question 2 or paste part of the question text.",
            );
            return;
        }

        if (resolution.status === "ambiguous") {
            setPendingAction(
                mode === "remove"
                    ? { kind: "remove_question_target" }
                    : mode === "update"
                      ? { kind: "update_question_target", changes }
                      : { kind: "randomize_question_target" },
            );
            appendAssistantMessage(
                [
                    "That still matches multiple questions. Narrow it down with a number or exact text.",
                    ...resolution.candidates.map((candidate) =>
                        summarizeQuestion(candidate.question, candidate.index),
                    ),
                ].join("\n"),
            );
            return;
        }

        if (mode === "remove") {
            if (props.editor.draft.questions.length <= 1) {
                appendAssistantMessage(
                    "This quiz only has one question left. I cannot remove the final question.",
                );
                return;
            }
            setPendingAction({
                kind: "confirm_remove_question",
                target: resolution.target,
            });
            appendAssistantMessage(
                `I found question ${resolution.target.index + 1}. Confirm if you want me to remove it.`,
            );
            return;
        }

        if (mode === "update") {
            startUpdateFlow(resolution.target, changes);
            return;
        }

        await startRandomizeFlow(resolution.target);
    };

    const startUpdateFlow = (
        target: ResolvedQuestionTarget,
        initialChanges?: UpdateDraftChanges,
    ) => {
        const normalizedChanges = initialChanges ?? {};
        const hasParsedChanges = Object.keys(normalizedChanges).length > 0;

        if (!hasParsedChanges) {
            setPendingAction({
                kind: "update_question_text",
                target,
                changes: {},
            });
            appendAssistantMessage(
                "Send the new question text, or type skip to keep the current wording.",
            );
            return;
        }

        const preparedQuestion = buildUpdatedQuestion(target.question, normalizedChanges);
        if (preparedQuestion) {
            setPendingAction({
                kind: "confirm_update_question",
                target,
                nextQuestion: preparedQuestion,
            });
            appendAssistantMessage(
                "I prepared the updated question from your request. Review the preview and confirm if it is right.",
            );
            return;
        }

        setPendingAction({
            kind: "update_question_correct",
            target,
            changes: normalizedChanges,
        });
        appendAssistantMessage(
            "I need the correct answer for the updated choices. Reply with the choice number or exact text.",
        );
    };

    const startRandomizeFlow = async (target: ResolvedQuestionTarget) => {
        if (!isEditorMode) {
            return;
        }

        setLoading(true);
        try {
            const randomizedQuestion = await generateRandomizedQuestion(target.question);
            setPendingAction({
                kind: "confirm_randomize_question",
                target,
                nextQuestion: randomizedQuestion,
            });
            appendAssistantMessage(
                "I prepared a meaning-preserving rewrite of the question and its choices. Review the preview and confirm if you want to apply it.",
            );
        } catch (err) {
            appendAssistantMessage(
                err instanceof Error
                    ? err.message
                    : "Failed to randomize that question.",
            );
        } finally {
            setLoading(false);
        }
    };

    const generateRandomizedQuestion = async (question: EditableQuestion) => {
        const correctIndex = question.options.findIndex((option) => option.correct);
        if (correctIndex < 0) {
            throw new Error("The selected question does not have a correct answer.");
        }

        if (provider.name !== "gemini") {
            throw new Error(
                "Randomize question requires Gemini to be configured.",
            );
        }

        const response = await provider.generateStructured<RandomizeQuestionResponse>({
            systemInstruction:
                "You rewrite quiz questions while preserving meaning and difficulty. Keep exactly one correct answer. Return JSON with questionText, options, and correctOptionIndex.",
            prompt: [
                "Rewrite this multiple-choice question.",
                "Keep the same meaning, difficulty, and number of answer choices.",
                "Rewrite both the question and all choices.",
                "",
                `Question: ${question.text}`,
                "Options:",
                ...question.options.map(
                    (option, index) => `${index + 1}. ${option.text}${option.correct ? " [correct]" : ""}`,
                ),
                "",
                "Return JSON only in this shape:",
                '{"questionText":"", "options":[""], "correctOptionIndex":0}',
            ].join("\n"),
            maxOutputTokens: 512,
            temperature: 0.7,
        });

        const optionTexts = response.options?.map((option) => option.trim()).filter(Boolean) ?? [];
        const correctOptionIndex = response.correctOptionIndex ?? -1;

        if (
            !response.questionText?.trim() ||
            optionTexts.length !== question.options.length ||
            optionTexts.length < 2 ||
            optionTexts.length > 4 ||
            correctOptionIndex < 0 ||
            correctOptionIndex >= optionTexts.length
        ) {
            throw new Error(
                "Gemini returned an invalid rewrite. Try again or edit the question manually.",
            );
        }

        return createQuestionFromTexts({
            questionId: question.id,
            questionText: response.questionText.trim(),
            optionTexts,
            correctIndex: correctOptionIndex,
        });
    };

    const pendingCard = renderPendingCard(pendingAction);

    return (
        <div className="ai-coach">
            <div className="ai-coach-head">
                <div className="eyebrow">AI Study Coach</div>
                <div className={`ai-badge ${hasGemini ? "live" : "fallback"}`}>
                    {hasGemini ? "Gemini Live" : "Fallback"}
                </div>
            </div>
            <h3>{isEditorMode ? "Edit this quiz with commands" : "Ask for help"}</h3>
            <p className="muted ai-hint">
                {isEditorMode
                    ? hasGemini
                        ? "The assistant can edit your local draft and will always ask for confirmation before applying changes."
                        : "Deterministic draft actions still work. Configure Gemini to enable question randomization and better freeform chat."
                    : hasGemini
                      ? "Gemini is active. Responses are generated in real-time."
                      : "Set VITE_GEMINI_API_KEY to enable Gemini responses."}
            </p>

            {isEditorMode && (
                <div className="ai-action-hints">
                    {actionHints.map((hint) => (
                        <span key={hint} className="ai-hint-chip">
                            {hint}
                        </span>
                    ))}
                </div>
            )}

            <div className="ai-thread">
                {messages.map((message) => (
                    <div key={message.id} className={`ai-msg ${message.role}`}>
                        <span className="ai-role">
                            {message.role === "assistant" ? "AI" : "You"}
                        </span>
                        <p>{message.content}</p>
                    </div>
                ))}
                {loading && <div className="ai-msg assistant typing">Thinking...</div>}
            </div>

            {pendingCard}

            {error && <div className="error-text">{error}</div>}

            <form className="ai-form" onSubmit={submit}>
                <textarea
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    placeholder={
                        isEditorMode
                            ? "Try: add question, remove question 2, or shuffle choices"
                            : "Ask: create me a 7-day revision plan for biology"
                    }
                    rows={3}
                />
                <button
                    className="btn secondary"
                    type="submit"
                    disabled={loading || !draft.trim()}
                >
                    {loading ? "Working..." : "Send"}
                </button>
            </form>
        </div>
    );

    function renderPendingCard(current: PendingEditorAction | null) {
        if (!current) {
            return null;
        }

        const { title, detail, previewLines, confirmable } = describePendingAction(current);

        return (
            <div className="ai-action-card">
                <div className="ai-action-card-head">
                    <strong>{title}</strong>
                    <span className="ai-action-state">
                        {confirmable ? "Waiting for confirmation" : "Waiting for input"}
                    </span>
                </div>
                <p className="muted ai-action-detail">{detail}</p>
                {previewLines.length > 0 && (
                    <div className="ai-preview-list">
                        {previewLines.map((line) => (
                            <div key={line} className="ai-preview-line">
                                {line}
                            </div>
                        ))}
                    </div>
                )}
                <div className="ai-action-buttons">
                    {confirmable && (
                        <button className="btn primary" type="button" onClick={handleConfirm}>
                            Confirm
                        </button>
                    )}
                    <button className="btn secondary" type="button" onClick={handleCancel}>
                        Cancel
                    </button>
                </div>
            </div>
        );
    }
}

function describePendingAction(action: PendingEditorAction): {
    title: string;
    detail: string;
    previewLines: string[];
    confirmable: boolean;
} {
    switch (action.kind) {
        case "confirm_create_quiz":
            return {
                title: "Create quiz",
                detail: action.title
                    ? `This will reset the editor to a new draft named "${action.title}".`
                    : "This will reset the editor to a new blank draft.",
                previewLines: action.title ? [`Title: ${action.title}`] : [],
                confirmable: true,
            };
        case "add_question_text":
            return {
                title: "Add question",
                detail: "Waiting for the question text.",
                previewLines: [],
                confirmable: false,
            };
        case "add_question_options":
            return {
                title: "Add question",
                detail: "Waiting for the full choice list.",
                previewLines: [`Question: ${action.questionText}`],
                confirmable: false,
            };
        case "add_question_correct":
            return {
                title: "Add question",
                detail: "Waiting for the correct answer.",
                previewLines: [
                    `Question: ${action.questionText}`,
                    ...action.optionTexts.map((option, index) => `${index + 1}. ${option}`),
                ],
                confirmable: false,
            };
        case "confirm_add_question":
            return {
                title: "Add question",
                detail: "Review the new question before it is appended to the draft.",
                previewLines: [
                    `Question: ${action.questionText}`,
                    ...action.optionTexts.map((option, index) =>
                        `${index + 1}. ${option}${
                            index === action.correctIndex ? " [correct]" : ""
                        }`,
                    ),
                ],
                confirmable: true,
            };
        case "remove_question_target":
            return {
                title: "Remove question",
                detail: "Waiting for the target question reference.",
                previewLines: [],
                confirmable: false,
            };
        case "confirm_remove_question":
            return {
                title: "Remove question",
                detail: "This question will be removed from the draft.",
                previewLines: questionPreviewLines(action.target.question, action.target.index),
                confirmable: true,
            };
        case "update_question_target":
            return {
                title: "Update question",
                detail: "Waiting for the target question reference.",
                previewLines: [],
                confirmable: false,
            };
        case "update_question_text":
            return {
                title: "Update question",
                detail: "Waiting for the new question text.",
                previewLines: questionPreviewLines(action.target.question, action.target.index),
                confirmable: false,
            };
        case "update_question_options":
            return {
                title: "Update question",
                detail: "Waiting for the new option list.",
                previewLines: questionPreviewLines(action.target.question, action.target.index),
                confirmable: false,
            };
        case "update_question_correct":
            return {
                title: "Update question",
                detail: "Waiting for the correct answer selection.",
                previewLines: action.changes.optionTexts
                    ? [
                          `Question ${action.target.index + 1}`,
                          ...(action.changes.questionText
                              ? [`Question: ${action.changes.questionText}`]
                              : [`Question: ${action.target.question.text}`]),
                          ...action.changes.optionTexts.map(
                              (option, index) => `${index + 1}. ${option}`,
                          ),
                      ]
                    : questionPreviewLines(action.target.question, action.target.index),
                confirmable: false,
            };
        case "confirm_update_question":
            return {
                title: "Update question",
                detail: "Review the final updated version before it replaces the current question.",
                previewLines: questionPreviewLines(action.nextQuestion, action.target.index),
                confirmable: true,
            };
        case "randomize_question_target":
            return {
                title: "Randomize question",
                detail: "Waiting for the target question reference.",
                previewLines: [],
                confirmable: false,
            };
        case "confirm_randomize_question":
            return {
                title: "Randomize question",
                detail: "Review the rewritten question and choices before applying them.",
                previewLines: questionPreviewLines(action.nextQuestion, action.target.index),
                confirmable: true,
            };
        case "confirm_shuffle_questions":
            return {
                title: "Shuffle questions",
                detail: "This will reorder the quiz questions.",
                previewLines: action.summary,
                confirmable: true,
            };
        case "confirm_shuffle_choices":
            return {
                title: "Shuffle choices",
                detail: "This will reorder the answer choices for every question.",
                previewLines: action.summary.slice(0, 6),
                confirmable: true,
            };
        default:
            return {
                title: "Pending action",
                detail: "",
                previewLines: [],
                confirmable: false,
            };
    }
}

function questionPreviewLines(question: EditableQuestion, index: number) {
    return [
        `Question ${index + 1}: ${question.text || "Untitled question"}`,
        ...question.options.map(
            (option, optionIndex) =>
                `${optionIndex + 1}. ${option.text || "Blank choice"}${
                    option.correct ? " [correct]" : ""
                }`,
        ),
    ];
}

function buildUpdatedQuestion(
    original: EditableQuestion,
    changes: UpdateDraftChanges,
): EditableQuestion | null {
    const optionTexts =
        changes.optionTexts ?? original.options.map((option) => option.text);
    const currentCorrectIndex = original.options.findIndex((option) => option.correct);
    const originalCorrectText =
        currentCorrectIndex >= 0 ? original.options[currentCorrectIndex]?.text : "";

    let correctIndex = changes.correctIndex;

    if (correctIndex === undefined && changes.correctAnswerInput !== undefined) {
        correctIndex =
            typeof changes.correctAnswerInput === "number"
                ? changes.correctAnswerInput - 1
                : parseCorrectAnswer(changes.correctAnswerInput, optionTexts) ?? undefined;
    }

    if (correctIndex === undefined && changes.optionTexts) {
        const carriedIndex = optionTexts.findIndex((option) => option === originalCorrectText);
        if (carriedIndex >= 0) {
            correctIndex = carriedIndex;
        } else {
            return null;
        }
    }

    if (correctIndex === undefined) {
        correctIndex = currentCorrectIndex >= 0 ? currentCorrectIndex : 0;
    }

    if (correctIndex < 0 || correctIndex >= optionTexts.length) {
        return null;
    }

    return createQuestionFromTexts({
        questionId: original.id,
        questionText: changes.questionText ?? original.text,
        optionTexts,
        correctIndex,
    });
}

function normalizeUpdateChanges(
    changes: ParsedEditorIntent["changes"],
): UpdateDraftChanges | undefined {
    if (!changes) {
        return undefined;
    }

    const normalized: UpdateDraftChanges = {};

    if (changes.questionText) {
        normalized.questionText = changes.questionText;
    }

    if (changes.options?.length) {
        normalized.optionTexts = changes.options;
    }

    if (changes.correctAnswer !== undefined) {
        normalized.correctAnswerInput = changes.correctAnswer;
    }

    return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function buildEditorChatPrompt(input: string, draft: EditorDraft) {
    const questionCount = draft.questions.length;
    const title = draft.title.trim() || "Untitled quiz";
    return [
        `Current quiz title: ${title}`,
        `Subject: ${draft.subject.trim() || "No subject"}`,
        `Question count: ${questionCount}`,
        "",
        `User request: ${input}`,
    ].join("\n");
}

function hasMeaningfulDraft(draft: EditorDraft) {
    if (draft.title.trim() || draft.subject.trim()) {
        return true;
    }

    return draft.questions.some(
        (question) =>
            question.text.trim() ||
            question.options.some((option) => option.text.trim()),
    );
}

function isCancelCommand(input: string) {
    return /^(cancel|stop|never mind|nevermind)$/i.test(input.trim());
}

function isSkipCommand(input: string) {
    return /^(skip|keep|keep current)$/i.test(input.trim());
}
