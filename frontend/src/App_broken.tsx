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

// list of endpoint routes
type Route = "/" | "/editor" | "/settings" | "/import" | "/play" | "/launch";

const parseHash = (): {
    route: Route;
    quizId: string | null;
    sessionId: string | null;
} => {
    const raw = window.location.hash.replace("#", "") || "/";
    const parts = raw.split("/").filter(Boolean); // ["play","quizId","sessionId"]
    const path = (parts[0] ? `/${parts[0]}` : "/") as Route;
    const quizId = parts[1] ?? null;
    const sessionId = parts[2] ?? null;
    const allowed: Route[] = [
        "/",
        "/editor",
        "/settings",
        "/import",
        "/play",
        "/launch",
    ];
    const route = allowed.includes(path) ? path : "/";
    return { route, quizId, sessionId };
};

export default function App() {
    const [{ route, quizId, sessionId }, setRoute] = useState(parseHash());
    const apiBase = import.meta.env.VITE_API_URL ?? "http://localhost:8000";
    const [search, setSearch] = useState("");
    const [quizzes, setQuizzes] = useState<Quiz[]>([]);
    const [folders] = useState<Folder[]>([]);
    const [loading, setLoading] = useState(true);
    const [currentQuiz, setCurrentQuiz] = useState<Quiz | null>(null);

    // Load quizzes from backend on mount
    useEffect(() => {
        fetch(`${apiBase}/quizzes`)
            .then((res) => res.json())
            .then((data) => {
                const normalized = data.map((q: any, idx: number) => ({
                    id: idx,
                    serverId: q.id,
                    title: q.title || "Untitled",
                    subject: "",
                    lastPlayed: "",
                    questions: 0,
                    progress: 0,
                    items: [],
                }));
                setQuizzes(normalized);
            })
            .catch(() => setQuizzes([]))
            .finally(() => setLoading(false));
    }, [apiBase]);

    useEffect(() => {
        const onHash = () => setRoute(parseHash());
        window.addEventListener("hashchange", onHash);
        return () => window.removeEventListener("hashchange", onHash);
    }, []);

    // Load full quiz when quizId changes
    useEffect(() => {
        if (!quizId) {
            setCurrentQuiz(null);
            return;
        }
        fetch(`${apiBase}/quizzes/${quizId}`)
            .then((res) => res.json())
            .then((data) => {
                const quiz: Quiz = {
                    id: 0,
                    serverId: data.id,
                    title: data.title,
                    subject: "",
                    lastPlayed: "",
                    questions: data.questions?.length || 0,
                    progress: 0,
                    items: (data.questions || []).map((q: any, qi: number) => ({
                        id: qi,
                        text: q.text,
                        options: (q.options || []).map(
                            (o: any, oi: number) => ({
                                id: oi,
                                text: o.text,
                                correct: o.is_correct,
                            }),
                        ),
                    })),
                };
                setCurrentQuiz(quiz);
            })
            .catch(() => setCurrentQuiz(null));
    }, [quizId, apiBase]);

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
        window.location.hash = `#/editor/${quiz.serverId}`;
    };

    const handlePlayClick = (quiz: Quiz) => {
        window.location.hash = `#/launch/${quiz.serverId}`;
    };

    const handleSaveQuiz = async (quiz: Quiz) => {
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

            // Refresh quiz list
            const listResp = await fetch(`${apiBase}/quizzes`);
            const allQuizzes = await listResp.json();
            const normalized = allQuizzes.map((q: any, idx: number) => ({
                id: idx,
                serverId: q.id,
                title: q.title || "Untitled",
                subject: "",
                lastPlayed: "",
                questions: 0,
                progress: 0,
                items: [],
            }));
            setQuizzes(normalized);

            window.location.hash = `#/launch/${data.id}`;
            return true;
        } catch {
            return false;
        }
    };

    const handleDeleteQuiz = async (serverId: string) => {
        // TODO: Implement DELETE /quizzes/{id} endpoint
        // For now, just refresh the list
        try {
            const resp = await fetch(`${apiBase}/quizzes`);
            const data = await resp.json();
            const normalized = data.map((q: any, idx: number) => ({
                id: idx,
                serverId: q.id,
                title: q.title || "Untitled",
                subject: "",
                lastPlayed: "",
                questions: 0,
                progress: 0,
                items: [],
            }));
            setQuizzes(normalized);
        } catch {}
        window.location.hash = "/";
    };

    if (route === "/play") {
        return (
            <NavBar primaryLabel="Home" primaryHref="#/">
                <PlayPage
                    quiz={currentQuiz}
                    sessionId={sessionId}
                    apiBase={apiBase}
                    onComplete={() => {
                        window.location.hash = currentQuiz?.serverId
                            ? `#/launch/${currentQuiz.serverId}`
                            : "/";
                    }}
                />
            </NavBar>
        );
    }

    if (route === "/launch") {
        return (
            <NavBar primaryLabel="Home" primaryHref="#/">
                <StartPage
                    quiz={currentQuiz}
                    quizId={quizId}
                    apiBase={apiBase}
                    onBegin={(mode, newSessionId) => {
                        if (!quizId) return;
                        window.location.hash = `#/play/${quizId}/${newSessionId}`;
                    }}
                />
            </NavBar>
        );
    }

    if (route === "/editor") {
        return (
            <NavBar
                primaryLabel="Play"
                primaryHref={quizId ? `#/launch/${quizId}` : "#/launch"}
            >
                <EditorPage
                    onSave={handleSaveQuiz}
                    onDelete={handleDeleteQuiz}
                    quiz={currentQuiz}
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

                        try {
                            const resp = await fetch(`${apiBase}/quizzes`, {
                                method: "POST",
                                headers: { "Content-Type": "application/json" },
                                body: JSON.stringify(payload),
                            });
                            if (resp.ok) {
                                const data = await resp.json();
                                // Refresh list
                                const listResp = await fetch(
                                    `${apiBase}/quizzes`,
                                );
                                const allQuizzes = await listResp.json();
                                const normalized = allQuizzes.map(
                                    (q: any, idx: number) => ({
                                        id: idx,
                                        serverId: q.id,
                                        title: q.title || "Untitled",
                                        subject: "",
                                        lastPlayed: "",
                                        questions: 0,
                                        progress: 0,
                                        items: [],
                                    }),
                                );
                                setQuizzes(normalized);
                                window.location.hash = `#/editor/${data.id}`;
                            }
                        } catch {}
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
