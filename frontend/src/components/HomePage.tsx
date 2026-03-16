import { useMemo, useState } from "react";
import { ProgressBar } from "./ProgressBar";

type Quiz = {
    id: string;
    title: string;
    subject: string;
    folderId?: string | null;
    lastPlayed: string;
    questions: number;
    progress: number;
};

type Folder = {
    id: string;
    parent_id: string | null;
    name: string;
    color: string;
    updated_at: string;
};

type Props = {
    recent: Quiz[];
    quizzes: Quiz[];
    folders: Folder[];
    search: string;
    setSearch: (v: string) => void;
    onQuizClick: (quiz: Quiz) => void;
    onDelete: (quizId: string) => void;
    onCreateFolder: (payload: {
        name: string;
        color: string;
        parent_id: string | null;
    }) => Promise<void>;
};

const folderPalette = ["#38bdf8", "#22c55e", "#f59e0b", "#f43f5e", "#a78bfa"];

type FolderOption = {
    id: string;
    label: string;
};

export function HomePage({
    recent,
    quizzes,
    folders,
    search,
    setSearch,
    onQuizClick,
    onDelete,
    onCreateFolder,
}: Props) {
    const [folderName, setFolderName] = useState("");
    const [folderParentId, setFolderParentId] = useState<string>("");
    const [folderColor, setFolderColor] = useState(folderPalette[0]);
    const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null);
    const [folderLoading, setFolderLoading] = useState(false);
    const [folderError, setFolderError] = useState<string | null>(null);

    const folderOptions = useMemo<FolderOption[]>(() => {
        const byParent = new Map<string | null, Folder[]>();
        for (const folder of folders) {
            const arr = byParent.get(folder.parent_id) ?? [];
            arr.push(folder);
            byParent.set(folder.parent_id, arr);
        }

        const options: FolderOption[] = [];
        const walk = (parentId: string | null, depth: number) => {
            const current = [...(byParent.get(parentId) ?? [])].sort((a, b) =>
                a.name.localeCompare(b.name),
            );
            for (const folder of current) {
                options.push({
                    id: folder.id,
                    label: `${"▸ ".repeat(depth)}${folder.name}`,
                });
                walk(folder.id, depth + 1);
            }
        };

        walk(null, 0);
        return options;
    }, [folders]);

    const folderQuizCount = useMemo(() => {
        const counts = new Map<string, number>();
        for (const quiz of quizzes) {
            if (!quiz.folderId) continue;
            counts.set(quiz.folderId, (counts.get(quiz.folderId) ?? 0) + 1);
        }
        return counts;
    }, [quizzes]);

    const folderCards = useMemo(() => {
        const byParent = new Map<string | null, Folder[]>();
        for (const folder of folders) {
            const arr = byParent.get(folder.parent_id) ?? [];
            arr.push(folder);
            byParent.set(folder.parent_id, arr);
        }

        const rows: Array<{ folder: Folder; depth: number }> = [];
        const walk = (parentId: string | null, depth: number) => {
            const current = [...(byParent.get(parentId) ?? [])].sort((a, b) =>
                a.name.localeCompare(b.name),
            );
            for (const folder of current) {
                rows.push({ folder, depth });
                walk(folder.id, depth + 1);
            }
        };

        walk(null, 0);
        return rows;
    }, [folders]);

    const selectedFolderAndDescendants = useMemo(() => {
        if (!selectedFolderId) return null;
        const childrenByParent = new Map<string, string[]>();
        for (const folder of folders) {
            if (!folder.parent_id) continue;
            const arr = childrenByParent.get(folder.parent_id) ?? [];
            arr.push(folder.id);
            childrenByParent.set(folder.parent_id, arr);
        }

        const ids = new Set<string>();
        const stack = [selectedFolderId];
        while (stack.length) {
            const current = stack.pop();
            if (!current || ids.has(current)) continue;
            ids.add(current);
            const children = childrenByParent.get(current) ?? [];
            for (const childId of children) stack.push(childId);
        }
        return ids;
    }, [folders, selectedFolderId]);

    const visibleQuizzes = useMemo(() => {
        if (!selectedFolderAndDescendants) return quizzes;
        return quizzes.filter(
            (quiz) => quiz.folderId && selectedFolderAndDescendants.has(quiz.folderId),
        );
    }, [quizzes, selectedFolderAndDescendants]);

    const selectedFolderName = useMemo(() => {
        if (!selectedFolderId) return null;
        return folders.find((f) => f.id === selectedFolderId)?.name ?? null;
    }, [folders, selectedFolderId]);

    const inProgressCount = useMemo(
        () => quizzes.filter((quiz) => quiz.progress > 0 && quiz.progress < 100).length,
        [quizzes],
    );

    const questionCount = useMemo(
        () => quizzes.reduce((total, quiz) => total + quiz.questions, 0),
        [quizzes],
    );

    const folderDepthCount = useMemo(
        () => folders.filter((folder) => folder.parent_id !== null).length,
        [folders],
    );

    const handleCreateFolder = async () => {
        const name = folderName.trim();
        if (!name) {
            setFolderError("Folder name is required.");
            return;
        }

        setFolderError(null);
        setFolderLoading(true);
        try {
            await onCreateFolder({
                name,
                color: folderColor,
                parent_id: folderParentId || null,
            });
            setFolderName("");
            setFolderParentId("");
            setFolderColor(folderPalette[0]);
        } catch (err) {
            setFolderError(err instanceof Error ? err.message : "Failed to create folder.");
        } finally {
            setFolderLoading(false);
        }
    };

    return (
        <div className="page home-layout">
            <aside className="sidebar left home-rail">
                <div className="sidebar-header">
                    <div className="dot" />
                    <div>
                        <div className="eyebrow">Recent Activity</div>
                        <div className="title">Jump back into your latest sets</div>
                    </div>
                </div>
                <div className="recent-list">
                    {recent.length === 0 ? (
                        <div className="muted">No recent quizzes yet.</div>
                    ) : (
                        recent.map((quiz) => {
                            const isInProgress = quiz.progress > 0 && quiz.progress < 100;
                            return (
                                <button
                                    key={quiz.id}
                                    className="quiz-card recent-rail-card"
                                    onClick={() => onQuizClick(quiz)}
                                >
                                    <div className="recent-title">
                                        {quiz.title || "Untitled quiz"}
                                        {isInProgress && (
                                            <span
                                                style={{
                                                    color: "#10b981",
                                                    marginLeft: "8px",
                                                    fontSize: "0.9em",
                                                }}
                                            >
                                                ⏸
                                            </span>
                                        )}
                                    </div>
                                    <div className="recent-meta">
                                        <span>{quiz.subject || "No subject"}</span>
                                        <span className="bullet">•</span>
                                        <span>{quiz.lastPlayed}</span>
                                    </div>
                                    <ProgressBar value={quiz.progress} />
                                </button>
                            );
                        })
                    )}
                </div>
                <div className="home-rail-summary">
                    <div className="eyebrow">Workspace</div>
                    <div className="home-rail-metric">
                        <strong>{quizzes.length}</strong>
                        <span>Total quizzes</span>
                    </div>
                    <div className="home-rail-metric">
                        <strong>{folders.length}</strong>
                        <span>Folders built</span>
                    </div>
                    <div className="home-rail-metric">
                        <strong>{inProgressCount}</strong>
                        <span>Sessions in motion</span>
                    </div>
                </div>
            </aside>

            <main className="main home-main">
                <header className="home-hero">
                    <div className="home-hero-copy">
                        <div className="eyebrow">Dashboard</div>
                        <h1>Build a sharper study system.</h1>
                        <p className="lede">
                            Organize quizzes into nested folders, surface the sets that still need work,
                            and keep your revision stack moving without digging through clutter.
                        </p>
                    </div>
                    <div className="home-hero-tools">
                        <div className="search hero-search">
                            <input
                                value={search}
                                onChange={(e) => setSearch(e.target.value)}
                                placeholder="Search quizzes or subjects"
                            />
                        </div>
                        <div className="home-filter-state">
                            {selectedFolderName ? (
                                <>
                                    <span className="home-filter-chip">
                                        Filtering: {selectedFolderName}
                                    </span>
                                    <button
                                        className="folder-back"
                                        type="button"
                                        onClick={() => setSelectedFolderId(null)}
                                    >
                                        ← Back to all quizzes
                                    </button>
                                </>
                            ) : (
                                <span className="home-filter-chip subdued">
                                    Browsing all folders and quizzes
                                </span>
                            )}
                        </div>
                    </div>
                </header>

                <section className="home-stats">
                    <article className="stat-card ocean">
                        <span className="eyebrow">Library</span>
                        <strong>{quizzes.length}</strong>
                        <p>{questionCount} total questions across your quiz collection.</p>
                    </article>
                    <article className="stat-card ember">
                        <span className="eyebrow">Momentum</span>
                        <strong>{inProgressCount}</strong>
                        <p>Quizzes are currently in progress and ready to resume.</p>
                    </article>
                    <article className="stat-card mint">
                        <span className="eyebrow">Structure</span>
                        <strong>{folders.length}</strong>
                        <p>{folderDepthCount} nested folders are already shaping your workspace.</p>
                    </article>
                </section>

                <section className="home-board">
                    <div className="grid-section home-folders-section">
                        <div className="section-heading">
                            <div>
                                <div className="eyebrow">Folders</div>
                                <h2>Organize your study map</h2>
                            </div>
                            <span className="muted">{folders.length} total</span>
                        </div>

                        <div className="folder-create-row">
                            <input
                                className="option-input"
                                placeholder="Folder name"
                                value={folderName}
                                onChange={(e) => setFolderName(e.target.value)}
                            />
                            <select
                                className="option-input"
                                value={folderParentId}
                                onChange={(e) => setFolderParentId(e.target.value)}
                            >
                                <option value="">Root folder</option>
                                {folderOptions.map((folder) => (
                                    <option key={folder.id} value={folder.id}>
                                        {folder.label}
                                    </option>
                                ))}
                            </select>
                            <div className="color-swatch-wrap">
                                <div className="color-swatch-row">
                                    {folderPalette.map((color) => (
                                        <button
                                            key={color}
                                            type="button"
                                            className={`color-swatch ${folderColor === color ? "selected" : ""}`}
                                            style={{ background: color }}
                                            onClick={() => setFolderColor(color)}
                                            aria-label={`Select ${color}`}
                                        />
                                    ))}
                                </div>
                                <div className="muted color-code">{folderColor}</div>
                            </div>
                            <button
                                className="btn secondary"
                                onClick={handleCreateFolder}
                                disabled={folderLoading}
                            >
                                {folderLoading ? "Creating..." : "New folder"}
                            </button>
                        </div>
                        {folderError && <div className="error-text">{folderError}</div>}

                        {folderCards.length === 0 ? (
                            <div className="muted">No folders yet.</div>
                        ) : (
                            <div className="folder-grid home-folder-grid">
                                {folderCards.map(({ folder, depth }) => (
                                    <button
                                        key={folder.id}
                                        className={`folder-card ${selectedFolderId === folder.id ? "selected" : ""}`}
                                        style={{
                                            borderColor: `${folder.color}55`,
                                            marginLeft: `${depth * 14}px`,
                                        }}
                                        onClick={() => setSelectedFolderId(folder.id)}
                                        type="button"
                                    >
                                        <div className="folder-dot" style={{ background: folder.color }} />
                                        <div className="folder-name">{folder.name}</div>
                                        <div className="folder-meta">
                                            <span>{folderQuizCount.get(folder.id) ?? 0} quizzes</span>
                                            <span className="bullet">•</span>
                                            <span>Updated {new Date(folder.updated_at).toLocaleDateString()}</span>
                                        </div>
                                    </button>
                                ))}
                            </div>
                        )}
                    </div>

                    <div className="grid-section home-quizzes-section">
                        <div className="section-heading">
                            <div>
                                <div className="eyebrow">
                                    {selectedFolderName ? `Folder: ${selectedFolderName}` : "All quizzes"}
                                </div>
                                <h2>Keep the streak going</h2>
                            </div>
                            <div className="quiz-section-actions">
                                <span className="muted">{visibleQuizzes.length} visible</span>
                            </div>
                        </div>

                        {visibleQuizzes.length === 0 ? (
                            <div className="muted">No quizzes yet. Create one to get started.</div>
                        ) : (
                            <div className="quiz-grid home-quiz-grid">
                                {visibleQuizzes.map((quiz) => {
                                    const isInProgress = quiz.progress > 0 && quiz.progress < 100;
                                    return (
                                        <button
                                            key={quiz.id}
                                            className="quiz-card home-quiz-card"
                                            onClick={() => onQuizClick(quiz)}
                                            type="button"
                                        >
                                            <div className="quiz-top">
                                                <span className="muted">
                                                    {isInProgress && (
                                                        <span style={{ color: "#10b981", marginRight: "8px" }}>
                                                            ⏸ In progress
                                                        </span>
                                                    )}
                                                    {quiz.lastPlayed}
                                                </span>
                                                <button
                                                    className="ghost small"
                                                    style={{ marginLeft: "auto" }}
                                                    onClick={(e) => {
                                                        e.stopPropagation();
                                                        onDelete(quiz.id);
                                                    }}
                                                    type="button"
                                                >
                                                    Delete
                                                </button>
                                            </div>
                                            <div className="quiz-title">{quiz.title || "Untitled quiz"}</div>
                                            <div className="quiz-meta">
                                                <span>{quiz.subject || "No subject"}</span>
                                                <span className="bullet">•</span>
                                                <span>{quiz.questions} questions</span>
                                                <span className="bullet">•</span>
                                                <span>{quiz.progress}% complete</span>
                                            </div>
                                            <ProgressBar value={quiz.progress} />
                                        </button>
                                    );
                                })}
                            </div>
                        )}
                    </div>
                </section>
            </main>
        </div>
    );
}
