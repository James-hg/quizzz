import { useCallback, useEffect, useMemo, useState } from "react";
import { NavBar } from "./components/NavBar";
import { HomePage } from "./components/HomePage";
import { EditorPage } from "./components/EditorPage";
import { ImportPage } from "./components/ImportPage";
import { PlayPage } from "./components/PlayPage";
import { StartPage } from "./components/StartPage";
import {
    AuthPage,
    AuthResponse,
    BootstrapFolder,
    BootstrapPayload,
    BootstrapQuiz,
    BootstrapStatus,
    BootstrapUser,
} from "./components/AuthPage";
import { SettingsPage } from "./components/SettingsPage";
import { apiRequest, TOKEN_STORAGE_KEY, UnauthorizedError } from "./apiClient";

type Option = { id: string; text: string; correct: boolean };
type Question = { id: string; text: string; options: Option[] };
type Quiz = {
    id: string;
    title: string;
    subject: string;
    folderId: string | null;
    lastPlayed: string;
    questions: number;
    progress: number;
    items: Question[];
    status: BootstrapStatus | null;
};

type Route =
    | "/"
    | "/editor"
    | "/settings"
    | "/import"
    | "/play"
    | "/launch"
    | "/login"
    | "/signup";

const parsePath = (): {
    route: Route;
    id: string | null;
    session: string | null;
} => {
    const parts = window.location.pathname.split("/").filter(Boolean);
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
        "/login",
        "/signup",
    ];
    const route = allowed.includes(path) ? path : "/";
    return { route, id, session };
};

const isUuid = (v: unknown): v is string => {
    if (typeof v !== "string") return false;
    return /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/.test(
        v,
    );
};

const mapQuiz = (data: BootstrapQuiz, status: BootstrapStatus | null): Quiz => {
    const totalQuestions = data.questions?.length ?? 0;
    const progress = status?.active_session_id
        ? Math.min(100, Math.round(((status.current_index ?? 0) / (totalQuestions || 1)) * 100))
        : status?.last_completed_at
          ? 100
          : 0;

    return {
        id: data.id,
        title: data.title ?? "Untitled quiz",
        subject: data.subject ?? "No subject",
        folderId: data.folder_id ?? null,
        lastPlayed: status?.last_completed_at
            ? new Date(status.last_completed_at).toLocaleString()
            : "never",
        questions: totalQuestions,
        progress,
        items: (data.questions ?? [])
            .sort((a, b) => a.position - b.position)
            .map((q) => ({
                id: q.id,
                text: q.text,
                options: (q.options ?? [])
                    .sort((a, b) => a.position - b.position)
                    .map((o) => ({
                        id: o.id,
                        text: o.text,
                        correct: o.is_correct ?? false,
                    })),
            })),
        status,
    };
};

export default function App() {
    const [{ route, id, session }, setRoute] = useState(parsePath());
    const [token, setToken] = useState<string | null>(() =>
        localStorage.getItem(TOKEN_STORAGE_KEY),
    );
    const [bootstrapping, setBootstrapping] = useState(false);
    const [currentUser, setCurrentUser] = useState<BootstrapUser | null>(null);
    const [search, setSearch] = useState("");
    const [folders, setFolders] = useState<BootstrapFolder[]>([]);
    const [quizzes, setQuizzes] = useState<Quiz[]>([]);
    const [editingQuizId, setEditingQuizId] = useState<string | null>(null);
    const [playingQuiz, setPlayingQuiz] = useState<Quiz | null>(null);
    const [playSessions, setPlaySessions] = useState<Record<string, string | null>>({});

    const navigate = useCallback((path: string, replace = false) => {
        if (replace) {
            window.history.replaceState({}, "", path);
        } else {
            window.history.pushState({}, "", path);
        }
        setRoute(parsePath());
    }, []);

    const applyBootstrap = useCallback((data: BootstrapPayload) => {
        setCurrentUser(data.user);
        setFolders(data.folders ?? []);

        const statusMap = new Map<string, BootstrapStatus>();
        for (const status of data.statuses ?? []) {
            statusMap.set(status.quiz_id, status);
        }

        const nextPlaySessions: Record<string, string | null> = {};
        for (const status of data.statuses ?? []) {
            if (status.active_session_id) {
                nextPlaySessions[status.quiz_id] = status.active_session_id;
            }
        }

        const mappedQuizzes = (data.quizzes ?? []).map((quiz) =>
            mapQuiz(quiz, statusMap.get(quiz.id) ?? null),
        );

        setPlaySessions(nextPlaySessions);
        setQuizzes(mappedQuizzes);
    }, []);

    const logout = useCallback(
        (redirect = true) => {
            localStorage.removeItem(TOKEN_STORAGE_KEY);
            setToken(null);
            setCurrentUser(null);
            setFolders([]);
            setQuizzes([]);
            setEditingQuizId(null);
            setPlayingQuiz(null);
            setPlaySessions({});
            if (redirect) {
                navigate("/login", true);
            }
        },
        [navigate],
    );

    const request = useCallback(
        async (path: string, init?: RequestInit): Promise<any> => {
            if (!token) {
                throw new Error("Not authenticated");
            }
            try {
                return await apiRequest(path, {
                    ...(init ?? {}),
                    token,
                });
            } catch (err) {
                if (err instanceof UnauthorizedError) {
                    logout();
                }
                throw err;
            }
        },
        [token, logout],
    );

    const refreshBootstrap = useCallback(async () => {
        if (!token) return;
        const data = await apiRequest<BootstrapPayload>("/auth/bootstrap", { token });
        applyBootstrap(data);
    }, [token, applyBootstrap]);

    useEffect(() => {
        const onPop = () => setRoute(parsePath());
        window.addEventListener("popstate", onPop);
        return () => window.removeEventListener("popstate", onPop);
    }, []);

    useEffect(() => {
        setEditingQuizId(id);
    }, [id]);

    useEffect(() => {
        const isAuthRoute = route === "/login" || route === "/signup";
        if (!token && !isAuthRoute) {
            navigate("/login", true);
        }
        if (token && isAuthRoute) {
            navigate("/", true);
        }
    }, [route, token, navigate]);

    useEffect(() => {
        if (!token) {
            setBootstrapping(false);
            return;
        }

        let cancelled = false;
        setBootstrapping(true);
        apiRequest<BootstrapPayload>("/auth/bootstrap", { token })
            .then((data) => {
                if (cancelled) return;
                applyBootstrap(data);
            })
            .catch((err) => {
                if (cancelled) return;
                if (err instanceof UnauthorizedError) {
                    logout();
                    return;
                }
                console.error("Failed to bootstrap", err);
            })
            .finally(() => {
                if (!cancelled) {
                    setBootstrapping(false);
                }
            });

        return () => {
            cancelled = true;
        };
    }, [token, applyBootstrap, logout]);

    const handleAuthSuccess = useCallback(
        (result: AuthResponse) => {
            localStorage.setItem(TOKEN_STORAGE_KEY, result.access_token);
            setToken(result.access_token);
            applyBootstrap(result.data);
            navigate("/", true);
        },
        [applyBootstrap, navigate],
    );

    const filteredQuizzes = useMemo(() => {
        if (!search.trim()) return quizzes;
        const term = search.toLowerCase();
        return quizzes.filter(
            (q) => q.title.toLowerCase().includes(term) || q.subject.toLowerCase().includes(term),
        );
    }, [search, quizzes]);

    const recent = useMemo(() => quizzes.slice(0, 5), [quizzes]);

    const handleQuizClick = (quiz: Quiz) => {
        setEditingQuizId(quiz.id);
        navigate(`/editor/${quiz.id}`);
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

    const handleSaveQuiz = async (quiz: {
        id: string;
        serverId?: string;
        title: string;
        subject: string;
        folderId?: string | null;
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
                subject: quiz.subject || null,
                folder_id: quiz.folderId || null,
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
                const data = await request(`/quizzes/${quiz.id}`, {
                    method: "PUT",
                    body: JSON.stringify(payload),
                });
                savedId = data.id;
            } else {
                const data = await request("/quizzes", {
                    method: "POST",
                    body: JSON.stringify(payload),
                });
                savedId = data.id;
            }

            if (!savedId) throw new Error("Save failed");
            setEditingQuizId(savedId);
            navigate(`/editor/${savedId}`, true);
            await refreshBootstrap();
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
        folderId?: string | null;
        questions: number;
        progress: number;
        lastPlayed: string;
        items: {
            id: any;
            text: string;
            options: { id: any; text: string; correct: boolean }[];
        }[];
    }) => {
        const clone = { ...quiz, id: "new", serverId: undefined };
        await handleSaveQuiz(clone);
    };

    const handleDeleteQuiz = async (quizId: string) => {
        try {
            await request(`/quizzes/${quizId}`, {
                method: "DELETE",
            });
        } catch {
            // ignore
        }
        setQuizzes((prev) => prev.filter((q) => q.id !== quizId));
        setEditingQuizId(null);
        setPlayingQuiz(null);
        navigate("/");
    };

    const handleCreateFolder = async (payload: {
        name: string;
        color: string;
        parent_id: string | null;
    }) => {
        await request("/folders", {
            method: "POST",
            body: JSON.stringify(payload),
        });
        await refreshBootstrap();
    };

    const handleProfileUpdate = async (payload: {
        display_name?: string | null;
        email?: string;
    }) => {
        const nextUser = await request("/users/me", {
            method: "PATCH",
            body: JSON.stringify(payload),
        });
        setCurrentUser(nextUser);
        return nextUser;
    };

    const handleChangePassword = async (payload: {
        current_password: string;
        new_password: string;
    }) => {
        await request("/users/me/password", {
            method: "PATCH",
            body: JSON.stringify(payload),
        });
    };

    const editingQuiz = useMemo(
        () => quizzes.find((q) => q.id === editingQuizId) || null,
        [quizzes, editingQuizId],
    );

    if (!token) {
        const mode = route === "/signup" ? "signup" : "login";
        return (
            <AuthPage
                mode={mode}
                onModeChange={(nextMode) => navigate(nextMode === "login" ? "/login" : "/signup")}
                onSuccess={handleAuthSuccess}
            />
        );
    }

    if (bootstrapping && !currentUser) {
        return (
            <div className="auth-shell">
                <div className="auth-card">
                    <h1>Loading your workspace...</h1>
                    <p className="muted">Fetching profile, folders, and quizzes.</p>
                </div>
            </div>
        );
    }

    if (route === "/play") {
        const playQuiz =
            playingQuiz ||
            (editingQuizId ? quizzes.find((q) => q.id === editingQuizId) : null) ||
            null;
        const sessionId = playQuiz ? playSessions[playQuiz.id] || session : session;
        return (
            <NavBar user={currentUser} primaryLabel="Home" primaryHref="/">
                <PlayPage
                    quiz={playQuiz}
                    sessionId={sessionId || undefined}
                    request={request}
                    onComplete={async () => {
                        if (playQuiz) {
                            setPlaySessions((prev) => {
                                const next = { ...prev };
                                delete next[playQuiz.id];
                                return next;
                            });
                            setPlayingQuiz(null);
                            await refreshBootstrap();
                        }
                    }}
                />
            </NavBar>
        );
    }

    if (route === "/launch") {
        const current =
            (editingQuizId && quizzes.find((q) => q.id === editingQuizId)) || editingQuiz || null;
        return (
            <NavBar user={currentUser} primaryLabel="Home" primaryHref="/">
                <StartPage
                    quiz={current}
                    request={request}
                    onBegin={async (mode, opts, resumeSessionId) => {
                        if (!current) return;
                        let sessionIdToUse: string | null = resumeSessionId || null;

                        if (mode === "new") {
                            const data = await request("/plays", {
                                method: "POST",
                                body: JSON.stringify({
                                    quiz_id: current.id,
                                }),
                            });
                            sessionIdToUse = data.id;
                            setPlaySessions((prev) => ({
                                ...prev,
                                [current.id]: data.id,
                            }));
                        } else if (mode === "resume" && resumeSessionId) {
                            setPlaySessions((prev) => ({
                                ...prev,
                                [current.id]: resumeSessionId,
                            }));
                        }

                        const toPlay = mode === "new" ? shuffleClone(current, opts) : current;
                        setPlayingQuiz(toPlay);
                        const dest = sessionIdToUse
                            ? `/play/${current.id}/${sessionIdToUse}`
                            : `/play/${current.id}`;
                        navigate(dest);
                    }}
                />
            </NavBar>
        );
    }

    if (route === "/editor") {
        return (
                <NavBar
                    user={currentUser}
                    primaryLabel="Play"
                    primaryHref={editingQuizId !== null ? `/launch/${editingQuizId}` : "/launch"}
                >
                <EditorPage
                    folders={folders}
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
        return (
            <NavBar user={currentUser} primaryLabel="Home" primaryHref="/">
                <SettingsPage
                    user={currentUser}
                    onLogout={() => logout()}
                    onUpdateProfile={handleProfileUpdate}
                    onChangePassword={handleChangePassword}
                />
            </NavBar>
        );
    }

    if (route === "/import") {
        return (
            <NavBar user={currentUser} primaryLabel="Editor" primaryHref="/editor">
                <ImportPage
                    request={request}
                    onExtract={async (draft) => {
                        let serverId: string | undefined;
                        try {
                            const payload = {
                                title: draft.title || "Imported Quiz",
                                subject: null,
                                folder_id: null,
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
                            const data = await request("/quizzes", {
                                method: "POST",
                                body: JSON.stringify(payload),
                            });
                            serverId = data.id;
                        } catch {
                            // ignore
                        }

                        if (!serverId) return;
                        await refreshBootstrap();
                        setEditingQuizId(serverId);
                        navigate(`/editor/${serverId}`);
                    }}
                />
            </NavBar>
        );
    }

    return (
        <NavBar user={currentUser}>
            <HomePage
                recent={recent}
                quizzes={filteredQuizzes}
                folders={folders}
                search={search}
                setSearch={setSearch}
                onQuizClick={handleQuizClick}
                onDelete={handleDeleteQuiz}
                onCreateFolder={handleCreateFolder}
            />
        </NavBar>
    );
}
