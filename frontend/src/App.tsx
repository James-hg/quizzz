import { useEffect, useMemo, useState } from "react";
import { NavBar } from "./components/NavBar";
import { HomePage } from "./components/HomePage";
import { EditorPage } from "./components/EditorPage";
import { PlaceholderPage } from "./components/PlaceholderPage";
import { ImportPage } from "./components/ImportPage";
import { PlayPage } from "./components/PlayPage";
import { StartPage } from "./components/StartPage";

// Quiz object type
type Quiz = {
    id: number;
    title: string;
    subject: string;
    lastPlayed: string;
    questions: number;
    folderId?: string;
    progress: number; // 0-100 %
    serverId?: string;
    items: {
        id: number;
        text: string;
        options: { id: number; text: string; correct: boolean }[];
    }[];
};

// Folder object type
type Folder = {
    id: string;
    name: string;
    color: string;
    quizCount: number;
    updatedAt: string;
};

const normalizeQuizzes = (raw: Quiz[]): Quiz[] =>
    raw.map((quiz, qIndex) => ({
        ...quiz,
        id: qIndex,
        serverId: quiz.serverId,
        items: (quiz.items ?? []).map((q, qi) => ({
            ...q,
            id: q.id ?? String(qi),
            options: (q.options ?? []).map((o, oi) => ({
                ...o,
                id: o.id ?? String(oi),
            })),
        })),
    }));

// list of endpoint routes
type Route = "/" | "/editor" | "/settings" | "/import" | "/play" | "/launch";

const parseHash = (): {
    route: Route;
    id: number | null;
    session: string | null;
} => {
    const raw = window.location.hash.replace("#", "") || "/";
    const parts = raw.split("/").filter(Boolean); // ["play","id","session"]
    const path = (parts[0] ? `/${parts[0]}` : "/") as Route;
    const id = parts[1] ? Number(parts[1]) : null;
    const session = parts[2] ?? null;
    const allowed: Route[] = [
        "/",
        "/editor",
        "/settings",
        "/import",
        "/play",
        "/launch",
    ];
    const route = allowed.includes(path) ? path : "/";
    return { route, id: Number.isFinite(id) ? id : null, session };
};

export default function App() {
    const [{ route, id, session }, setRoute] = useState(parseHash());
    const apiBase = import.meta.env.VITE_API_URL ?? "http://localhost:8000";
    const [search, setSearch] = useState("");
    const [quizzes, setQuizzes] = useState<Quiz[]>(() => {
        const cached = localStorage.getItem("quizzes");
        if (!cached) return [];
        try {
            const raw = JSON.parse(cached) as Quiz[];
            return normalizeQuizzes(raw);
        } catch {
            return [];
        }
    });
    const [folders] = useState<Folder[]>([]);
    const [editingQuizId, setEditingQuizId] = useState<number | null>(null);
    const [playingQuiz, setPlayingQuiz] = useState<Quiz | null>(null);
    const [playIndex, setPlayIndex] = useState(0);
    const [playSessions, setPlaySessions] = useState<Record<number, string>>(
        () => {
            const cached = localStorage.getItem("playSessions");
            return cached ? (JSON.parse(cached) as Record<number, string>) : {};
        },
    );

    useEffect(() => {
        const onHash = () => setRoute(parseHash());
        window.addEventListener("hashchange", onHash);
        return () => window.removeEventListener("hashchange", onHash);
    }, []);

    useEffect(() => {
        setEditingQuizId(id);
    }, [id]);

    const filteredQuizzes = useMemo(() => {
        if (!search.trim()) return quizzes;
        const term = search.toLowerCase();
        return quizzes.filter(
            (q) =>
                q.title.toLowerCase().includes(term) ||
                q.subject.toLowerCase().includes(term),
        );
    }, [search, quizzes]);

    // 5 most recent quizzes
    const recent = useMemo(() => quizzes.slice(0, 5), [quizzes]);

    const handleQuizClick = (quiz: Quiz) => {
        setEditingQuizId(quiz.id);
        window.location.hash = `#/editor/${quiz.id}`;
    };

    const handlePlayClick = (quiz: Quiz) => {
        setEditingQuizId(quiz.id);
        window.location.hash = `#/launch/${quiz.id}`;
    };

    const fetchFullQuiz = async (serverId: string): Promise<Quiz | null> => {
        try {
            const resp = await fetch(`${apiBase}/quizzes/${serverId}`);
            if (!resp.ok) return null;
            const data = await resp.json() as {
                id: string;
                title: string;
                questions: {
                    id: string;
                    text: string;
                    options: { id: string; text: string; is_correct: boolean; position: number; }[];
                }[];
            };
            return {
                id: editingQuizId ?? 0,
                serverId: data.id,
                title: data.title,
                subject: "Imported",
                lastPlayed: "never",
                questions: data.questions.length,
                progress: 0,
                items: data.questions.map((q, qi) => ({
                    id: q.id,
                    text: q.text,
                    options: q.options.map((o, oi) => ({
                        id: o.id,
                        text: o.text,
                        correct: o.is_correct,
                    })),
                })),
            };
        } catch {
            return null;
        }
    };

    const shuffleClone = (
        quiz: Quiz,
        opts: { shuffleQuestions: boolean; shuffleChoices: boolean },
    ): Quiz => {
        const clone: Quiz = JSON.parse(JSON.stringify(quiz));
        if (opts.shuffleQuestions) {
            for (let i = clone.items.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [clone.items[i], clone.items[j]] = [clone.items[j], clone.items[i]];
            }
        }
        if (opts.shuffleChoices) {
            clone.items = clone.items.map((q) => {
                const optsArr = [...q.options];
                for (let i = optsArr.length - 1; i > 0; i--) {
                    const j = Math.floor(Math.random() * (i + 1));
                    [optsArr[i], optsArr[j]] = [optsArr[j], optsArr[i]];
                }
                return { ...q, options: optsArr };
            });
        }
        return clone;
    };

    const handleSaveQuiz = async (quiz: Quiz) => {
        // persist to backend first
        try {
            const payload = {
                title: quiz.title,
                owner_id: null,
                questions: quiz.items.map((q, qi) => ({
                    text: q.text,
                    position: qi,
                    options: q.options.map((o, oi) => ({
                        text: o.text,
                        is_correct: o.correct,
                        position: oi,
                    })),
                })),
            };
            const resp = await fetch(`${apiBase}/quizzes`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload),
            });
            if (!resp.ok) {
                throw new Error("Failed to save quiz");
            }
            const data = (await resp.json()) as { id: string; title: string };
            quiz = { ...quiz, serverId: data.id };
        } catch {
            return false;
        }

        setQuizzes((prev) => {
            const existingIndex = prev.findIndex((q) => q.id === quiz.id);
            let next: Quiz[];
            if (existingIndex >= 0) {
                next = [...prev];
                next[existingIndex] = quiz;
            } else {
                const newQuiz = { ...quiz, id: prev.length };
                next = [...prev, newQuiz];
            }
            const normalized = normalizeQuizzes(next);
            localStorage.setItem("quizzes", JSON.stringify(normalized));
            return normalized;
        });
        const targetId = quiz.id >= 0 ? quiz.id : quizzes.length;
        setEditingQuizId(targetId);
        window.location.hash = `#/launch/${targetId}`;
        return true;
    };

    const handleDeleteQuiz = async (id: number, serverId?: string) => {
        if (serverId) {
            await fetch(`${apiBase}/quizzes/${serverId}`, {
                method: "DELETE",
            }).catch(() => {});
        }
        setQuizzes((prev) => {
            const next = prev.filter((q) => q.id !== id);
            const normalized = normalizeQuizzes(next);
            localStorage.setItem("quizzes", JSON.stringify(normalized));
            return normalized;
        });
        setEditingQuizId(null);
        window.location.hash = "/";
    };

    const editingQuiz = useMemo(
        () => quizzes.find((q) => q.id === editingQuizId) || null,
        [quizzes, editingQuizId],
    );

    if (route === "/play") {
        const current =
            (editingQuizId !== null &&
                quizzes.find((q) => q.id === editingQuizId)) ||
            editingQuiz ||
            null;
        const playQuiz = playingQuiz || current;
        const sessionId = playQuiz ? playSessions[playQuiz.id] || null : null;
        return (
            <NavBar
                primaryLabel="Home"
                primaryHref="#/"
                onSaveExit={async () => {
                    if (playQuiz && sessionId) {
                        await fetch(
                            `${apiBase}/plays/${sessionId}/progress?current_index=${playIndex}`,
                            { method: "PATCH" },
                        ).catch(() => {});
                    }
                    if (playQuiz) {
                        window.location.hash = `#/launch/${playQuiz.id}`;
                    }
                }}
            >
                <PlayPage
                    quiz={playQuiz}
                    sessionId={sessionId}
                    onProgressChange={setPlayIndex}
                    onComplete={async () => {
                        if (playQuiz) {
                            if (sessionId) {
                                await fetch(
                                    `${apiBase}/plays/${sessionId}/complete`,
                                    {
                                        method: "PATCH",
                                    },
                                ).catch(() => {});
                                setPlaySessions((prev) => {
                                    const next = { ...prev };
                                    if (playQuiz) delete next[playQuiz.id];
                                    localStorage.setItem(
                                        "playSessions",
                                        JSON.stringify(next),
                                    );
                                    return next;
                                });
                            }
                        }
                        setPlayingQuiz(null);
                    }}
                />
            </NavBar>
        );
    }
    if (route === "/launch") {
        const current =
            (editingQuizId !== null &&
                quizzes.find((q) => q.id === editingQuizId)) ||
            editingQuiz ||
            null;
        return (
            <NavBar primaryLabel="Home" primaryHref="#/">
                <StartPage
                    quiz={current}
                    hasResume={
                        current ? Boolean(playSessions[current.id]) : false
                    }
                    onBegin={async (mode, opts) => {
                        if (!current) return;
                        const targetId = current.id;
                        let sessionToUse = playSessions[current.id] || null;
                        let quizToPlay: Quiz | null = current;

                        // fetch full quiz with server IDs
                        if (current.serverId) {
                            const full = await fetchFullQuiz(current.serverId);
                            if (full) {
                                quizToPlay = normalizeQuizzes([full])[0];
                                quizToPlay.id = current.id; // keep local index
                            }
                        }

                        // start new session
                        if (mode === "new" && current.serverId) {
                            const resp = await fetch(`${apiBase}/plays`, {
                                method: "POST",
                                headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({
                                    quiz_id: current.serverId,
                                    user_id: null,
                                }),
                            }).catch(() => null);
                            if (resp && resp.ok) {
                                const data = await resp.json();
                                sessionToUse = data.id;
                                setPlaySessions((prev) => {
                                    const next = {
                                        ...prev,
                                        [current.id]: data.id,
                                    };
                                    localStorage.setItem(
                                        "playSessions",
                                        JSON.stringify(next),
                                    );
                                    return next;
                                });
                            }
                        }

                        const toPlay =
                            mode === "new"
                                ? shuffleClone(quizToPlay, opts)
                                : quizToPlay;
                        setPlayingQuiz(toPlay);
                        window.location.hash = sessionToUse
                            ? `#/play/${targetId}/${sessionToUse}`
                            : `#/play/${targetId}`;
                    }}
                />
            </NavBar>
        );
    }

    if (route === "/editor") {
        // in editor mode, change to import button
        return (
            <NavBar
                primaryLabel="Play"
                primaryHref={
                    editingQuizId !== null
                        ? `#/launch/${editingQuizId}`
                        : "#/launch"
                }
            >
                <EditorPage
                    onSave={handleSaveQuiz}
                    onDelete={handleDeleteQuiz}
                    quiz={editingQuiz}
                />
            </NavBar>
        );
    }

    if (route === "/settings") {
        return (
            <NavBar primaryLabel="Home" primaryHref="#/">
                <PlaceholderPage
                    eyebrow="Settings"
                    heading="Coming soon"
                    body="User profile, notification preferences, and study streaks will live here."
                />
            </NavBar>
        );
    }

    if (route === "/import") {
        return (
            <NavBar primaryLabel="Editor" primaryHref="#/editor">
                <ImportPage
                    onExtract={async (draft) => {
                        // create on backend to obtain serverId
                        let serverId: string | undefined;
                        try {
                            const payload = {
                                title: draft.title || "Imported Quiz",
                                owner_id: null,
                                questions: draft.questions.map((q, qi) => ({
                                    text: q.text,
                                    position: qi,
                                    options: q.options.map((o, oi) => ({
                                        text: o.text,
                                        is_correct: o.isCorrect,
                                        position: oi,
                                    })),
                                })),
                            };
                            const resp = await fetch(`${apiBase}/quizzes`, {
                                method: "POST",
                                headers: { "Content-Type": "application/json" },
                                body: JSON.stringify(payload),
                            });
                            if (resp.ok) {
                                const data = await resp.json();
                                serverId = data.id;
                            }
                        } catch {
                            // fall back to local only if backend fails
                        }

                        const nextId = quizzes.length;
                        const mapped: Quiz = {
                            id: nextId,
                            title: draft.title || "Imported Quiz",
                            subject: "Imported",
                            lastPlayed: "never",
                            questions: draft.questions.length,
                            progress: 0,
                            serverId,
                            items: draft.questions.map((q, qi) => ({
                                id: q.id ? String(q.id) : String(qi),
                                text: q.text,
                                options: q.options.map((o, oi) => ({
                                    id: o.id ? String(o.id) : String(oi),
                                    text: o.text,
                                    correct: o.isCorrect,
                                })),
                            })),
                        };

                        const normalized = normalizeQuizzes([
                            ...quizzes,
                            mapped,
                        ]);
                        setQuizzes(normalized);
                        localStorage.setItem(
                            "quizzes",
                            JSON.stringify(normalized),
                        );
                        setEditingQuizId(mapped.id);
                        window.location.hash = `#/editor/${mapped.id}`;
                    }}
                />
            </NavBar>
        );
    }

    return (
        <NavBar>
            <HomePage
                recent={recent}
                quizzes={filteredQuizzes}
                folders={folders}
                search={search}
                setSearch={setSearch}
                onQuizClick={handleQuizClick}
                onPlayClick={handlePlayClick}
            />
        </NavBar>
    );
}
