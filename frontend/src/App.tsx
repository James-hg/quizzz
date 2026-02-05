import { useEffect, useMemo, useState } from "react";
import { NavBar } from "./components/NavBar";
import { HomePage } from "./components/HomePage";
import { EditorPage } from "./components/EditorPage";
import { PlaceholderPage } from "./components/PlaceholderPage";
import { ImportPage } from "./components/ImportPage";
import { PlayPage } from "./components/PlayPage";
import { StartPage } from "./components/StartPage";

type Option = { id: string; text: string; correct: boolean };
type Question = { id: string; text: string; options: Option[] };
type Quiz = {
    id: string; // server id
    title: string;
    subject: string;
    lastPlayed: string;
    questions: number;
    progress: number;
    items: Question[];
};

// routes list
type Route = "/" | "/editor" | "/settings" | "/import" | "/play" | "/launch";

// extract route, id, session from URL pathname
const parsePath = (): {
    route: Route;
    id: string | null;
    session: string | null;
} => {
    const parts = window.location.pathname.split("/").filter(Boolean); // ["play","id","session"]
    const path = (parts[0] ? `/${parts[0]}` : "/") as Route;
    const id = parts[1] ?? null;
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
    return { route, id, session };
};

// map backend quiz format to frontend quiz type
const mapQuiz = (data: any): Quiz => ({
    id: data.id,
    title: data.title ?? "Untitled quiz",
    subject: data.subject ?? "No subject",
    lastPlayed: "never",
    questions: data.questions?.length ?? 0,
    progress: 0,
    items: (data.questions ?? []).map((q: any) => ({
        id: q.id,
        text: q.text,
        options: (q.options ?? []).map((o: any) => ({
            id: o.id,
            text: o.text,
            correct: o.is_correct ?? o.correct ?? false,
        })),
    })),
});

// validate UUID format
const isUuid = (v: unknown): v is string => {
    if (typeof v !== "string") return false;
    return /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/.test(
        v,
    );
};

export default function App() {
    const [{ route, id, session }, setRoute] = useState(parsePath());
    const apiBase = import.meta.env.VITE_API_URL ?? "http://localhost:8000";
    const [search, setSearch] = useState("");
    const [quizzes, setQuizzes] = useState<Quiz[]>([]);
    const [loading, setLoading] = useState(false);
    const [editingQuizId, setEditingQuizId] = useState<string | null>(null);
    const [playingQuiz, setPlayingQuiz] = useState<Quiz | null>(null);
    const [playSessions, setPlaySessions] = useState<
        Record<string, string | null>
    >({});
    const [playIndex, setPlayIndex] = useState(0);

    console.log("VITE_API_URL =", import.meta.env.VITE_API_URL);
    // routing
    useEffect(() => {
        const onPop = () => setRoute(parsePath());
        window.addEventListener("popstate", onPop);
        return () => window.removeEventListener("popstate", onPop);
    }, []);

    useEffect(() => {
        setEditingQuizId(id);
    }, [id]);

    // fetch quizzes from backend
    const loadQuizzes = async () => {
        setLoading(true);
        try {
            const resp = await fetch(`${apiBase}/quizzes`);
            if (!resp.ok) throw new Error("Failed to list quizzes");
            const summaries = await resp.json();
            const full = await Promise.all(
                summaries.map(async (s: any) => {
                    if (!isUuid(s.id)) return null;
                    const qResp = await fetch(`${apiBase}/quizzes/${s.id}`);
                    if (!qResp.ok) return null;
                    const data = await qResp.json();
                    const quiz = mapQuiz(data);

                    // attach history + active session info
                    try {
                        const hResp = await fetch(
                            `${apiBase}/quizzes/${quiz.id}/history`,
                        );
                        if (hResp.ok) {
                            const hist = await hResp.json();
                            if (hist.length) {
                                const last = hist[0];
                                quiz.lastPlayed = last.completed_at
                                    ? new Date(
                                          last.completed_at,
                                      ).toLocaleString()
                                    : "recently";
                                quiz.progress = 100;
                            }
                        } else if (hResp.status === 422) {
                            // skip invalid id cases
                        }
                    } catch {
                        // ignore history errors
                    }
                    try {
                        const sResp = await fetch(
                            `${apiBase}/quizzes/${quiz.id}/session`,
                        );
                        if (sResp.ok) {
                            // load session if one exists
                            const sess = await sResp.json();
                            const total = quiz.items.length || 1;
                            quiz.progress = Math.round(
                                (Number(sess.current_index ?? 0) / total) * 100,
                            );
                            setPlaySessions((prev) => ({
                                ...prev,
                                [quiz.id]: sess.id,
                            }));
                        } else if (sResp.status === 422) {
                            // skip invalid id cases
                        }
                    } catch {
                        // ignore session errors
                    }
                    return quiz;
                }),
            );
            setQuizzes(full.filter(Boolean) as Quiz[]);
        } catch (err) {
            console.error(err);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        loadQuizzes();
    }, []);

    const filteredQuizzes = useMemo(() => {
        if (!search.trim()) return quizzes;
        const term = search.toLowerCase();
        return quizzes.filter(
            (q) =>
                q.title.toLowerCase().includes(term) ||
                q.subject.toLowerCase().includes(term),
        );
    }, [search, quizzes]);

    const recent = useMemo(() => quizzes.slice(0, 5), [quizzes]); // store recent quizzes for sidebar

    const handleQuizClick = (quiz: Quiz) => {
        setEditingQuizId(quiz.id);
        window.history.pushState({}, "", `/editor/${quiz.id}`);
        setRoute(parsePath());
    };

    const handlePlayClick = (quiz: Quiz) => {
        setEditingQuizId(quiz.id);
        window.history.pushState({}, "", `/launch/${quiz.id}`);
        setRoute(parsePath());
    };

    const shuffleClone = (
        quiz: Quiz,
        opts: { shuffleQuestions: boolean; shuffleChoices: boolean },
    ): Quiz => {
        const clone: Quiz = JSON.parse(JSON.stringify(quiz));
        if (opts.shuffleQuestions) {
            for (let i = clone.items.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [clone.items[i], clone.items[j]] = [
                    clone.items[j],
                    clone.items[i],
                ];
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

    const handleSaveQuiz = async (quiz: {
        id: string;
        serverId?: string;
        title: string;
        subject: string;
        questions: number;
        progress: number;
        lastPlayed: string;
        items: {
            id: any;
            text: string;
            options: { id: any; text: string; correct: boolean }[];
        }[];
    }) => {
        try {
            const payload = {
                title: quiz.title,
                owner_id: null,
                questions: quiz.items.map((q, idx) => ({
                    text: q.text,
                    position: idx,
                    options: q.options.map((o, oi) => ({
                        text: o.text,
                        is_correct: o.correct,
                        position: oi,
                    })),
                })),
            };

            let savedId: string | null = null;

            if (quiz.id && isUuid(quiz.id)) {
                // update existing
                const resp = await fetch(`${apiBase}/quizzes/${quiz.id}`, {
                    method: "PUT",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(payload),
                });
                if (!resp.ok) throw new Error("Failed to update quiz");
                const data = await resp.json();
                savedId = data.id;
            } else {
                // create new
                const resp = await fetch(`${apiBase}/quizzes`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(payload),
                });
                if (!resp.ok) throw new Error("Failed to save quiz");
                const data = await resp.json();
                savedId = data.id;
            }

            if (!savedId) throw new Error("Save failed");

            const fullResp = await fetch(`${apiBase}/quizzes/${savedId}`);
            const fullQuiz = mapQuiz(await fullResp.json());

            setQuizzes((prev) => {
                const withoutOld = prev.filter((q) => q.id !== quiz.id);
                return [...withoutOld, fullQuiz];
            });
            setEditingQuizId(savedId);
            return true;
        } catch (err) {
            console.error(err);
            return false;
        }
    };

    const handleDuplicateQuiz = async (quiz: {
        id: string;
        serverId?: string;
        title: string;
        subject: string;
        questions: number;
        progress: number;
        lastPlayed: string;
        items: {
            id: any;
            text: string;
            options: { id: any; text: string; correct: boolean }[];
        }[];
    }) => {
        // force create new
        const clone = { ...quiz, id: "new", serverId: undefined };
        await handleSaveQuiz(clone);
    };

    const handleDeleteQuiz = async (quizId: string, serverId?: string) => {
        if (quizId) {
            await fetch(`${apiBase}/quizzes/${quizId}`, {
                method: "DELETE",
            }).catch(() => {});
        } else if (serverId) {
            await fetch(`${apiBase}/quizzes/${serverId}`, {
                method: "DELETE",
            }).catch(() => {});
        }
        setQuizzes((prev) => prev.filter((q) => q.id !== quizId));
        setEditingQuizId(null);
        window.history.pushState({}, "", `/`);
        setRoute(parsePath());
    };

    const editingQuiz = useMemo(
        () => quizzes.find((q) => q.id === editingQuizId) || null,
        [quizzes, editingQuizId],
    );

    // --- routes ---
    if (route === "/play") {
        // check if a quiz is being played
        const playQuiz =
            playingQuiz ||
            (editingQuizId
                ? quizzes.find((q) => q.id === editingQuizId)
                : null) ||
            null;
        // get session id for this quiz
        const sessionId = playQuiz
            ? playSessions[playQuiz.id] || session
            : session;
        return (
            <NavBar primaryLabel="Home" primaryHref="/">
                <PlayPage
                    quiz={playQuiz}
                    sessionId={sessionId || undefined}
                    apiBase={apiBase}
                    onProgressChange={setPlayIndex}
                    onComplete={async () => {
                        if (playQuiz && sessionId) {
                            await fetch(
                                `${apiBase}/plays/${sessionId}/complete`,
                                {
                                    method: "PATCH",
                                },
                            ).catch(() => {});
                            setPlaySessions((prev) => {
                                const next = { ...prev };
                                delete next[playQuiz.id];
                                return next;
                            });
                        }
                        setPlayingQuiz(null);
                    }}
                />
            </NavBar>
        );
    }

    if (route === "/launch") {
        // get current editing quiz to load to play page
        const current =
            (editingQuizId && quizzes.find((q) => q.id === editingQuizId)) ||
            editingQuiz ||
            null;
        return (
            <NavBar primaryLabel="Home" primaryHref="/">
                <StartPage
                    quiz={current}
                    apiBase={apiBase}
                    onBegin={async (mode, opts, resumeSessionId) => {
                        if (!current) return;
                        let sessionIdToUse: string | null =
                            resumeSessionId || null;

                        if (mode === "new") {
                            const resp = await fetch(`${apiBase}/plays`, {
                                method: "POST",
                                headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({
                                    quiz_id: current.id,
                                    user_id: null,
                                }),
                            }).catch(() => null);
                            if (resp && resp.ok) {
                                const data = await resp.json();
                                sessionIdToUse = data.id;
                                setPlaySessions((prev) => ({
                                    ...prev,
                                    [current.id]: data.id,
                                }));
                            }
                        } else if (mode === "resume" && resumeSessionId) {
                            setPlaySessions((prev) => ({
                                ...prev,
                                [current.id]: resumeSessionId,
                            }));
                        }

                        const toPlay =
                            mode === "new"
                                ? shuffleClone(current, opts)
                                : current;
                        setPlayingQuiz(toPlay);
                        const dest = sessionIdToUse
                            ? `/play/${current.id}/${sessionIdToUse}`
                            : `/play/${current.id}`;
                        window.history.pushState({}, "", dest);
                        setRoute(parsePath());
                    }}
                />
            </NavBar>
        );
    }

    if (route === "/editor") {
        return (
            <NavBar
                primaryLabel="Play"
                primaryHref={
                    editingQuizId !== null
                        ? `/launch/${editingQuizId}`
                        : "/launch"
                }
            >
                <EditorPage
                    onSave={handleSaveQuiz}
                    onDuplicate={handleDuplicateQuiz}
                    onDelete={handleDeleteQuiz}
                    quiz={
                        editingQuiz
                            ? {
                                  ...editingQuiz,
                                  serverId: editingQuiz.id,
                              }
                            : null
                    }
                />
            </NavBar>
        );
    }

    if (route === "/settings") {
        // to be implemented (user page)
        return (
            <NavBar primaryLabel="Home" primaryHref="/">
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
            <NavBar primaryLabel="Editor" primaryHref="/editor">
                <ImportPage
                    onExtract={async (draft) => {
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
                            // ignore
                        }

                        if (!serverId) return;
                        const fullResp = await fetch(
                            `${apiBase}/quizzes/${serverId}`,
                        );
                        if (!fullResp.ok) return;
                        const mapped = mapQuiz(await fullResp.json());
                        setQuizzes((prev) => [...prev, mapped]);
                        setEditingQuizId(mapped.id);
                        window.history.pushState(
                            {},
                            "",
                            `/editor/${mapped.id}`,
                        );
                        setRoute(parsePath());
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
                folders={[]}
                search={search}
                setSearch={setSearch}
                onQuizClick={handleQuizClick}
                onPlayClick={handlePlayClick}
                onDelete={(quizId) => handleDeleteQuiz(quizId, quizId)}
            />
        </NavBar>
    );
}
