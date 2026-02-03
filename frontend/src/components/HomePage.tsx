import { ProgressBar } from "./ProgressBar";

type Quiz = {
    id: string;
    title: string;
    subject: string;
    lastPlayed: string;
    questions: number;
    progress: number;
};

type Folder = {
    id: string;
    name: string;
    color: string;
    quizCount: number;
    updatedAt: string;
};

type Props = {
    recent: Quiz[];
    quizzes: Quiz[];
    folders: Folder[];
    search: string;
    setSearch: (v: string) => void;
    onQuizClick: (quiz: Quiz) => void;
};

export function HomePage({
    recent,
    quizzes,
    folders,
    search,
    setSearch,
    onQuizClick,
}: Props) {
    return (
        <div className="page">
            <aside className="sidebar left">
                <div className="sidebar-header">
                    <div className="dot" />
                    <div>
                        <div className="eyebrow">Recent</div>
                        <div className="title">Your last 5 quizzes</div>
                    </div>
                </div>
                <div className="recent-list">
                    {recent.map((quiz) => (
                        <button
                            key={quiz.id}
                            className="recent-card"
                            onClick={() => onQuizClick(quiz)}
                        >
                            <div className="recent-title">{quiz.title}</div>
                            <div className="recent-meta">
                                <span>{quiz.subject}</span>
                                <span className="bullet">•</span>
                                <span>{quiz.lastPlayed}</span>
                            </div>
                            <ProgressBar value={quiz.progress} />
                        </button>
                    ))}
                </div>
            </aside>

            <main className="main">
                <header className="main-header">
                    <div>
                        <div className="eyebrow">Dashboard</div>
                        <h1>Welcome back, learner</h1>
                        <p className="lede">
                            Pick up where you left off or spin up a new quiz.
                            Organize with folders and keep everything tidy
                            before you play.
                        </p>
                    </div>
                </header>

                <section className="toolbar">
                    <div className="search">
                        <input
                            value={search}
                            onChange={(e) => setSearch(e.target.value)}
                            placeholder="Search quizzes or subjects"
                        />
                    </div>
                    <div className="filters">
                        <button className="chip active">All</button>
                        <button className="chip">In progress</button>
                        <button className="chip">Completed</button>
                    </div>
                </section>

                <section className="grid-section">
                    <div className="section-heading">
                        <div>
                            <div className="eyebrow">Folders</div>
                            <h2>Organize your study sets</h2>
                        </div>
                        <button className="ghost">New folder</button>
                    </div>
                    <div className="folder-grid">
                        {folders.map((folder) => (
                            <div
                                key={folder.id}
                                className="folder-card"
                                style={{ borderColor: `${folder.color}33` }}
                            >
                                <div
                                    className="folder-dot"
                                    style={{ background: folder.color }}
                                />
                                <div className="folder-name">{folder.name}</div>
                                <div className="folder-meta">
                                    <span>{folder.quizCount} quizzes</span>
                                    <span className="bullet">•</span>
                                    <span>Updated {folder.updatedAt}</span>
                                </div>
                            </div>
                        ))}
                    </div>
                </section>

                <section className="grid-section">
                    <div className="section-heading">
                        <div>
                            <div className="eyebrow">All quizzes</div>
                            <h2>Keep the streak going</h2>
                        </div>
                        <span className="muted">{quizzes.length} total</span>
                    </div>

                    <div className="quiz-grid">
                        {quizzes.map((quiz) => (
                            <button
                                key={quiz.id}
                                className="quiz-card"
                                onClick={() => onQuizClick(quiz)}
                            >
                                <div className="quiz-top">
                                    <div className="pill">{quiz.subject}</div>
                                    <span className="muted">
                                        {quiz.lastPlayed}
                                    </span>
                                </div>
                                <div className="quiz-title">{quiz.title}</div>
                                <div className="quiz-meta">
                                    <span>{quiz.questions} questions</span>
                                    <span className="bullet">•</span>
                                    <span>{quiz.progress}% complete</span>
                                </div>
                                <ProgressBar value={quiz.progress} />
                            </button>
                        ))}
                    </div>
                </section>
            </main>

            <aside className="sidebar right sticky">
                <div className="eyebrow">AI Study Coach</div>
                <h3>Coming soon</h3>
                <p className="muted">
                    Chat with an AI assistant to review tricky questions,
                    request targeted drills, or generate fresh quizzes on the
                    fly. This placeholder will house the chatbot panel once it's
                    built.
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
