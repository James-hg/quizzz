import { EditableOption, EditableQuestion, EditorDraft } from "../editor/draft";

export type EditorIntentKind =
    | "chat"
    | "create_quiz"
    | "add_question"
    | "remove_question"
    | "update_question"
    | "randomize_question"
    | "shuffle_questions"
    | "shuffle_choices";

export type QuestionTargetReference =
    | { type: "ordinal"; value: number | "first" | "last" }
    | { type: "text"; value: string };

export type ParsedEditorIntent = {
    kind: EditorIntentKind;
    raw: string;
    title?: string;
    questionText?: string;
    options?: string[];
    correctAnswer?: string | number;
    target?: QuestionTargetReference;
    changes?: {
        questionText?: string;
        options?: string[];
        correctAnswer?: string | number;
    };
};

export type ResolvedQuestionTarget = {
    question: EditableQuestion;
    index: number;
};

export type QuestionTargetResolution =
    | { status: "missing" }
    | { status: "ambiguous"; candidates: ResolvedQuestionTarget[] }
    | { status: "match"; target: ResolvedQuestionTarget };

export function parseEditorIntent(input: string): ParsedEditorIntent {
    const text = input.trim();
    const lowered = text.toLowerCase();

    if (/\bshuffle\b.*\b(choices|options|answers)\b/.test(lowered)) {
        return { kind: "shuffle_choices", raw: text };
    }

    if (/\bshuffle\b.*\bquestions\b/.test(lowered)) {
        return { kind: "shuffle_questions", raw: text };
    }

    if (/\b(randomize|randomise|rewrite|rephrase)\b.*\bquestion\b/.test(lowered)) {
        return {
            kind: "randomize_question",
            raw: text,
            target: extractQuestionTarget(text),
        };
    }

    if (/\b(remove|delete)\b.*\bquestion\b/.test(lowered)) {
        return {
            kind: "remove_question",
            raw: text,
            target: extractQuestionTarget(text),
        };
    }

    if (/\b(update|edit|change)\b.*\bquestion\b/.test(lowered)) {
        return {
            kind: "update_question",
            raw: text,
            target: extractQuestionTarget(text),
            changes: extractUpdateChanges(text),
        };
    }

    if (/\badd\b.*\bquestion\b/.test(lowered)) {
        return {
            kind: "add_question",
            raw: text,
            questionText: extractAddQuestionText(text),
        };
    }

    if (/\b(create|start|make)\b.*\bquiz\b/.test(lowered)) {
        return {
            kind: "create_quiz",
            raw: text,
            title: extractQuizTitle(text),
        };
    }

    return {
        kind: "chat",
        raw: text,
    };
}

export function resolveQuestionTarget(
    draft: EditorDraft,
    reference?: QuestionTargetReference,
): QuestionTargetResolution {
    if (!reference) {
        return { status: "missing" };
    }

    if (reference.type === "ordinal") {
        if (reference.value === "first") {
            const question = draft.questions[0];
            return question
                ? { status: "match", target: { question, index: 0 } }
                : { status: "missing" };
        }

        if (reference.value === "last") {
            const index = draft.questions.length - 1;
            const question = draft.questions[index];
            return question
                ? { status: "match", target: { question, index } }
                : { status: "missing" };
        }

        const index = reference.value - 1;
        const question = draft.questions[index];
        return question
            ? { status: "match", target: { question, index } }
            : { status: "missing" };
    }

    const normalizedNeedle = normalizeText(reference.value);
    if (!normalizedNeedle) {
        return { status: "missing" };
    }

    const exactMatches = draft.questions
        .map((question, index) => ({ question, index }))
        .filter(({ question }) => normalizeText(question.text) === normalizedNeedle);

    if (exactMatches.length === 1) {
        return { status: "match", target: exactMatches[0] };
    }

    if (exactMatches.length > 1) {
        return { status: "ambiguous", candidates: exactMatches };
    }

    const fuzzyMatches = draft.questions
        .map((question, index) => ({ question, index }))
        .filter(({ question }) => {
            const haystack = normalizeText(question.text);
            return haystack.includes(normalizedNeedle) || normalizedNeedle.includes(haystack);
        });

    if (fuzzyMatches.length === 1) {
        return { status: "match", target: fuzzyMatches[0] };
    }

    if (fuzzyMatches.length > 1) {
        return { status: "ambiguous", candidates: fuzzyMatches.slice(0, 4) };
    }

    return { status: "missing" };
}

export function parseOptionList(input: string): string[] {
    const cleaned = input.trim();
    if (!cleaned) {
        return [];
    }

    const withoutPrefix = cleaned.replace(/^(?:options|choices)\s*:\s*/i, "");
    const delimiter = withoutPrefix.includes("\n")
        ? "\n"
        : withoutPrefix.includes("|")
          ? "|"
          : withoutPrefix.includes(";")
            ? ";"
            : ",";

    return withoutPrefix
        .split(delimiter)
        .map((entry) => entry.replace(/^\d+[\).\s-]*/, "").trim())
        .filter(Boolean);
}

export function parseCorrectAnswer(input: string, options: string[]): number | null {
    const text = input.trim();
    if (!text) {
        return null;
    }

    const numeric = text.match(/\b(\d+)\b/);
    if (numeric) {
        const value = Number(numeric[1]) - 1;
        if (value >= 0 && value < options.length) {
            return value;
        }
    }

    const normalized = normalizeText(text.replace(/^(?:answer|correct answer)\s*(?:is|to)?\s*/i, ""));
    if (!normalized) {
        return null;
    }

    const exactIndex = options.findIndex((option) => normalizeText(option) === normalized);
    if (exactIndex >= 0) {
        return exactIndex;
    }

    const fuzzyIndex = options.findIndex((option) => normalizeText(option).includes(normalized));
    return fuzzyIndex >= 0 ? fuzzyIndex : null;
}

export function buildShuffledQuestionOrder(
    draft: EditorDraft,
): { questionIds: string[]; summary: string[] } {
    const shuffled = ensureChangedShuffle(draft.questions);
    return {
        questionIds: shuffled.map((question) => question.id),
        summary: shuffled.map((question, index) => summarizeQuestion(question, index)),
    };
}

export function buildShuffledChoices(
    draft: EditorDraft,
): {
    choicesByQuestionId: Record<string, EditableOption[]>;
    summary: string[];
} {
    const choicesByQuestionId: Record<string, EditableOption[]> = {};
    const summary: string[] = [];

    for (const [index, question] of draft.questions.entries()) {
        const shuffledOptions = ensureChangedShuffle(question.options).map((option) => ({
            ...option,
        }));
        choicesByQuestionId[question.id] = shuffledOptions;
        const optionPreview = shuffledOptions
            .map((option) => option.text.trim() || "Blank choice")
            .slice(0, 4)
            .join(" / ");
        summary.push(`${index + 1}. ${truncate(question.text, 44)} -> ${optionPreview}`);
    }

    return { choicesByQuestionId, summary };
}

export function summarizeQuestion(question: EditableQuestion, index: number) {
    return `${index + 1}. ${truncate(question.text, 72)}`;
}

function extractQuizTitle(input: string): string | undefined {
    const match =
        input.match(/\b(?:quiz\s+name|named|called)\s*[:\-]?\s*(.+)$/i) ??
        input.match(/\bname\s+(.+)$/i);
    return match?.[1]?.trim() || undefined;
}

function extractAddQuestionText(input: string): string | undefined {
    const match = input.match(/\badd\b.*\bquestion\b[:\s-]*(.+)$/i);
    const value = match?.[1]?.trim();
    return value ? value : undefined;
}

function extractQuestionTarget(input: string): QuestionTargetReference | undefined {
    const ordinalMatch =
        input.match(/\bquestion\s+(\d+)\b/i) ??
        input.match(/\b(\d+)(?:st|nd|rd|th)\s+question\b/i);
    if (ordinalMatch?.[1]) {
        return {
            type: "ordinal",
            value: Number(ordinalMatch[1]),
        };
    }

    if (/\bfirst\b/.test(input.toLowerCase())) {
        return { type: "ordinal", value: "first" };
    }

    if (/\blast\b/.test(input.toLowerCase())) {
        return { type: "ordinal", value: "last" };
    }

    const quoted = input.match(/"([^"]+)"/);
    if (quoted?.[1]) {
        return {
            type: "text",
            value: quoted[1].trim(),
        };
    }

    const remainder = input
        .replace(
            /^.*?(?:remove|delete|update|edit|change|randomize|randomise|rewrite|rephrase)\s+(?:the\s+)?question\b/i,
            "",
        )
        .trim()
        .replace(/^[\s:,-]+/, "");

    return remainder ? { type: "text", value: remainder } : undefined;
}

function extractUpdateChanges(input: string): ParsedEditorIntent["changes"] | undefined {
    const changes: NonNullable<ParsedEditorIntent["changes"]> = {};

    const questionTextMatch =
        input.match(/\b(?:question text|question)\s*(?:to|=|is)\s*"([^"]+)"/i) ??
        input.match(/\btext\s*(?:to|=|is)\s*"([^"]+)"/i);
    if (questionTextMatch?.[1]) {
        changes.questionText = questionTextMatch[1].trim();
    }

    const optionsMatch = input.match(/\b(?:options|choices)\s*[:=]\s*(.+)$/i);
    if (optionsMatch?.[1]) {
        const options = parseOptionList(optionsMatch[1]);
        if (options.length >= 2) {
            changes.options = options;
        }
    }

    const correctAnswerMatch = input.match(
        /\b(?:correct answer|answer)\s*(?:to|=|is)?\s*("?[^"]+"?|\d+)\b/i,
    );
    if (correctAnswerMatch?.[1]) {
        const raw = correctAnswerMatch[1].replace(/^"|"$/g, "").trim();
        changes.correctAnswer = /^\d+$/.test(raw) ? Number(raw) : raw;
    }

    return Object.keys(changes).length > 0 ? changes : undefined;
}

function ensureChangedShuffle<T>(items: T[]): T[] {
    if (items.length <= 1) {
        return [...items];
    }

    const copy = [...items];
    for (let index = copy.length - 1; index > 0; index -= 1) {
        const swapIndex = Math.floor(Math.random() * (index + 1));
        [copy[index], copy[swapIndex]] = [copy[swapIndex], copy[index]];
    }

    const unchanged = copy.every((item, index) => item === items[index]);
    if (unchanged) {
        const rotated = [...copy];
        const first = rotated.shift();
        if (first !== undefined) {
            rotated.push(first);
        }
        return rotated;
    }

    return copy;
}

function normalizeText(input: string) {
    return input.trim().toLowerCase().replace(/\s+/g, " ");
}

function truncate(input: string, length: number) {
    const value = input.trim() || "Untitled question";
    return value.length > length ? `${value.slice(0, length - 3)}...` : value;
}
