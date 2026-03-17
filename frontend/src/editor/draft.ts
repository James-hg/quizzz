export type EditableOption = {
    id: string;
    text: string;
    correct: boolean;
};

export type EditableQuestion = {
    id: string;
    text: string;
    options: EditableOption[];
};

export type EditorDraft = {
    title: string;
    subject: string;
    folderId: string;
    questions: EditableQuestion[];
};

export type EditorSourceQuiz = {
    id: string;
    serverId?: string;
    title: string;
    subject: string;
    folderId?: string | null;
    items: EditableQuestion[];
};

export type EditorDocument = {
    sourceQuizId: string | null;
    sourceServerId: string | null;
    draft: EditorDraft;
};

export type EditorDocumentAction =
    | { type: "hydrate"; quiz: EditorSourceQuiz | null }
    | { type: "start_new_draft"; title?: string }
    | { type: "set_title"; title: string }
    | { type: "set_subject"; subject: string }
    | { type: "set_folder"; folderId: string }
    | { type: "add_question"; question?: EditableQuestion }
    | { type: "add_questions_batch"; questions: EditableQuestion[] }
    | { type: "delete_question"; questionId: string }
    | { type: "duplicate_question"; questionId: string }
    | { type: "set_question_text"; questionId: string; text: string }
    | { type: "set_option_text"; questionId: string; optionId: string; text: string }
    | { type: "set_correct_option"; questionId: string; optionId: string }
    | { type: "add_option"; questionId: string }
    | { type: "remove_option"; questionId: string; optionId: string }
    | { type: "replace_question"; questionId: string; question: EditableQuestion }
    | { type: "set_question_order"; questionIds: string[] }
    | {
          type: "set_choices_for_all";
          choicesByQuestionId: Record<string, EditableOption[]>;
      };

export function newEditorId() {
    return Math.random().toString(36).slice(2);
}

export function blankQuestion(id = newEditorId()): EditableQuestion {
    return {
        id,
        text: "",
        options: ["A", "B"].map((_, index) => ({
            id: newEditorId(),
            text: "",
            correct: index === 0,
        })),
    };
}

export function createQuestionFromTexts(input: {
    questionId?: string;
    questionText: string;
    optionTexts: string[];
    correctIndex: number;
}): EditableQuestion {
    const optionTexts = input.optionTexts.slice(0, 4);
    const boundedCorrectIndex =
        input.correctIndex >= 0 && input.correctIndex < optionTexts.length
            ? input.correctIndex
            : 0;

    return {
        id: input.questionId ?? newEditorId(),
        text: input.questionText,
        options: optionTexts.map((optionText, index) => ({
            id: newEditorId(),
            text: optionText,
            correct: index === boundedCorrectIndex,
        })),
    };
}

export function createEditorDocument(quiz: EditorSourceQuiz | null): EditorDocument {
    if (!quiz) {
        return {
            sourceQuizId: null,
            sourceServerId: null,
            draft: {
                title: "",
                subject: "",
                folderId: "",
                questions: [blankQuestion()],
            },
        };
    }

    return {
        sourceQuizId: quiz.id,
        sourceServerId: quiz.serverId ?? quiz.id,
        draft: {
            title: quiz.title,
            subject: quiz.subject,
            folderId: quiz.folderId ?? "",
            questions:
                quiz.items.length > 0
                    ? quiz.items.map((question) => cloneQuestion(question, false))
                    : [blankQuestion()],
        },
    };
}

export function editorDocumentReducer(
    state: EditorDocument,
    action: EditorDocumentAction,
): EditorDocument {
    switch (action.type) {
        case "hydrate":
            return createEditorDocument(action.quiz);
        case "start_new_draft":
            return {
                sourceQuizId: null,
                sourceServerId: null,
                draft: {
                    title: action.title?.trim() ?? "",
                    subject: "",
                    folderId: "",
                    questions: [blankQuestion()],
                },
            };
        case "set_title":
            return {
                ...state,
                draft: {
                    ...state.draft,
                    title: action.title,
                },
            };
        case "set_subject":
            return {
                ...state,
                draft: {
                    ...state.draft,
                    subject: action.subject,
                },
            };
        case "set_folder":
            return {
                ...state,
                draft: {
                    ...state.draft,
                    folderId: action.folderId,
                },
            };
        case "add_question":
            return {
                ...state,
                draft: {
                    ...state.draft,
                    questions: [...state.draft.questions, cloneQuestion(action.question ?? blankQuestion())],
                },
            };
        case "add_questions_batch": {
            const nextQuestions = action.questions.map((question) => sanitizeQuestion(question));
            if (nextQuestions.length === 0) {
                return state;
            }

            return {
                ...state,
                draft: {
                    ...state.draft,
                    questions: hasOnlyBlankPlaceholder(state.draft.questions)
                        ? nextQuestions
                        : [...state.draft.questions, ...nextQuestions],
                },
            };
        }
        case "delete_question": {
            if (state.draft.questions.length <= 1) {
                return state;
            }

            return {
                ...state,
                draft: {
                    ...state.draft,
                    questions: state.draft.questions.filter(
                        (question) => question.id !== action.questionId,
                    ),
                },
            };
        }
        case "duplicate_question": {
            const index = state.draft.questions.findIndex(
                (question) => question.id === action.questionId,
            );
            if (index < 0) {
                return state;
            }

            const copy = cloneQuestion(state.draft.questions[index]);
            const nextQuestions = [...state.draft.questions];
            nextQuestions.splice(index + 1, 0, copy);

            return {
                ...state,
                draft: {
                    ...state.draft,
                    questions: nextQuestions,
                },
            };
        }
        case "set_question_text":
            return {
                ...state,
                draft: {
                    ...state.draft,
                    questions: state.draft.questions.map((question) =>
                        question.id === action.questionId
                            ? { ...question, text: action.text }
                            : question,
                    ),
                },
            };
        case "set_option_text":
            return {
                ...state,
                draft: {
                    ...state.draft,
                    questions: state.draft.questions.map((question) =>
                        question.id !== action.questionId
                            ? question
                            : {
                                  ...question,
                                  options: question.options.map((option) =>
                                      option.id === action.optionId
                                          ? { ...option, text: action.text }
                                          : option,
                                  ),
                              },
                    ),
                },
            };
        case "set_correct_option":
            return {
                ...state,
                draft: {
                    ...state.draft,
                    questions: state.draft.questions.map((question) =>
                        question.id !== action.questionId
                            ? question
                            : {
                                  ...question,
                                  options: question.options.map((option) => ({
                                      ...option,
                                      correct: option.id === action.optionId,
                                  })),
                              },
                    ),
                },
            };
        case "add_option":
            return {
                ...state,
                draft: {
                    ...state.draft,
                    questions: state.draft.questions.map((question) =>
                        question.id !== action.questionId || question.options.length >= 4
                            ? question
                            : {
                                  ...question,
                                  options: [
                                      ...question.options,
                                      {
                                          id: newEditorId(),
                                          text: "",
                                          correct: false,
                                      },
                                  ],
                              },
                    ),
                },
            };
        case "remove_option":
            return {
                ...state,
                draft: {
                    ...state.draft,
                    questions: state.draft.questions.map((question) => {
                        if (
                            question.id !== action.questionId ||
                            question.options.length <= 2
                        ) {
                            return question;
                        }

                        return {
                            ...question,
                            options: normalizeOptions(
                                question.options.filter(
                                    (option) => option.id !== action.optionId,
                                ),
                            ),
                        };
                    }),
                },
            };
        case "replace_question":
            return {
                ...state,
                draft: {
                    ...state.draft,
                    questions: state.draft.questions.map((question) =>
                        question.id === action.questionId
                            ? sanitizeQuestion(action.question)
                            : question,
                    ),
                },
            };
        case "set_question_order": {
            if (
                action.questionIds.length !== state.draft.questions.length ||
                new Set(action.questionIds).size !== state.draft.questions.length
            ) {
                return state;
            }

            const byId = new Map(
                state.draft.questions.map((question) => [question.id, question]),
            );
            const nextQuestions = action.questionIds
                .map((questionId) => byId.get(questionId))
                .filter((question): question is EditableQuestion => Boolean(question));

            if (nextQuestions.length !== state.draft.questions.length) {
                return state;
            }

            return {
                ...state,
                draft: {
                    ...state.draft,
                    questions: nextQuestions,
                },
            };
        }
        case "set_choices_for_all":
            return {
                ...state,
                draft: {
                    ...state.draft,
                    questions: state.draft.questions.map((question) => {
                        const nextOptions = action.choicesByQuestionId[question.id];
                        if (!nextOptions) {
                            return question;
                        }

                        return {
                            ...question,
                            options: normalizeOptions(nextOptions.map((option) => ({ ...option }))),
                        };
                    }),
                },
            };
        default:
            return state;
    }
}

export function cloneQuestion(
    question: EditableQuestion,
    refreshIds = true,
): EditableQuestion {
    return {
        id: refreshIds ? newEditorId() : question.id,
        text: question.text,
        options: question.options.map((option) => ({
            id: refreshIds ? newEditorId() : option.id,
            text: option.text,
            correct: option.correct,
        })),
    };
}

export function hasOnlyBlankPlaceholder(questions: EditableQuestion[]) {
    return questions.length === 1 && isBlankPlaceholderQuestion(questions[0]);
}

export function isBlankPlaceholderQuestion(question: EditableQuestion) {
    return (
        question.text.trim() === "" &&
        question.options.length === 2 &&
        question.options[0]?.text.trim() === "" &&
        question.options[0]?.correct === true &&
        question.options[1]?.text.trim() === "" &&
        question.options[1]?.correct === false
    );
}

function sanitizeQuestion(question: EditableQuestion): EditableQuestion {
    return {
        ...question,
        options: normalizeOptions(question.options.map((option) => ({ ...option }))),
    };
}

function normalizeOptions(options: EditableOption[]): EditableOption[] {
    const trimmed = options.slice(0, 4);
    const firstCorrectIndex = trimmed.findIndex((option) => option.correct);

    return trimmed.map((option, index) => ({
        ...option,
        correct: firstCorrectIndex >= 0 ? index === firstCorrectIndex : index === 0,
    }));
}
