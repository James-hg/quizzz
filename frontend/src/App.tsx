import { useEffect, useMemo, useState } from "react";
import { NavBar } from "./components/NavBar";
import { HomePage } from "./components/HomePage";
import { EditorPage } from "./components/EditorPage";
import { PlaceholderPage } from "./components/PlaceholderPage";
import { ImportPage } from "./components/ImportPage";
import { PlayPage } from "./components/PlayPage";

// Quiz object type
type Quiz = {
    id: string;
    title: string;
    subject: string;
    lastPlayed: string;
    questions: number;
    folderId?: string;
    progress: number; // 0-100 %
};

// Folder object type
type Folder = {
    id: string;
    name: string;
    color: string;
    quizCount: number;
    updatedAt: string;
};

// Hardcoded folder data
const foldersSeed: Folder[] = [
    {
        id: "f1",
        name: "Biology",
        color: "#22c55e",
        quizCount: 4,
        updatedAt: "Jan 25",
    },
    {
        id: "f2",
        name: "Physics",
        color: "#f97316",
        quizCount: 3,
        updatedAt: "Jan 28",
    },
    {
        id: "f3",
        name: "History",
        color: "#06b6d4",
        quizCount: 2,
        updatedAt: "Jan 20",
    },
    {
        id: "f4",
        name: "Exam Prep",
        color: "#a855f7",
        quizCount: 6,
        updatedAt: "Feb 02",
    },
];

// Hardcoded quiz data
const quizzesSeed: Quiz[] = [
    {
        id: "q1",
        title: "Cell Structure & Function",
        subject: "Biology",
        lastPlayed: "2d ago",
        questions: 15,
        folderId: "f1",
        progress: 72,
    },
    {
        id: "q2",
        title: "Newton's Laws Drills",
        subject: "Physics",
        lastPlayed: "5d ago",
        questions: 12,
        folderId: "f2",
        progress: 38,
    },
    {
        id: "q3",
        title: "Renaissance Snapshot",
        subject: "History",
        lastPlayed: "1d ago",
        questions: 10,
        folderId: "f3",
        progress: 90,
    },
    {
        id: "q4",
        title: "Mock Exam #1",
        subject: "Exam Prep",
        lastPlayed: "3h ago",
        questions: 25,
        folderId: "f4",
        progress: 15,
    },
    {
        id: "q5",
        title: "Ecology Basics",
        subject: "Biology",
        lastPlayed: "6h ago",
        questions: 14,
        folderId: "f1",
        progress: 55,
    },
    {
        id: "q6",
        title: "Optics Quickfire",
        subject: "Physics",
        lastPlayed: "8h ago",
        questions: 9,
        folderId: "f2",
        progress: 0,
    },
];

// list of endpoint routes
type Route = "/" | "/editor" | "/settings" | "/import" | "/play";

function useRoute(): Route {
    const getRoute = () => {
        const hash = window.location.hash.replace("#", "") || "/";
        if (
            hash === "/editor" ||
            hash === "/settings" ||
            hash === "/import" ||
            hash === "/play"
        ) {
            return hash as Route;
        }
        return "/";
    };
    const [route, setRoute] = useState<Route>(getRoute());

    useEffect(() => {
        const onHash = () => setRoute(getRoute());
        window.addEventListener("hashchange", onHash);
        return () => window.removeEventListener("hashchange", onHash);
    }, []);

    return route;
}

export default function App() {
    const route = useRoute();
    // searching tools
    const [search, setSearch] = useState("");

    const filteredQuizzes = useMemo(() => {
        if (!search.trim()) return quizzesSeed;
        const term = search.toLowerCase();
        return quizzesSeed.filter(
            (q) =>
                q.title.toLowerCase().includes(term) ||
                q.subject.toLowerCase().includes(term),
        );
    }, [search]);

    // 5 most recent quizzes
    const recent = quizzesSeed.slice(0, 5);

    const handleQuizClick = (_quiz: Quiz) => {
        window.location.hash = "/play";
    };

    if (route === "/play") {
        return (
            <NavBar primaryLabel="Home" primaryHref="#/">
                <PlayPage />
            </NavBar>
        );
    }

    if (route === "/editor") {
        // in editor mode, change to import button
        return (
            <NavBar primaryLabel="Play" primaryHref="#/play">
                <EditorPage />
            </NavBar>
        );
    }

    if (route === "/settings") {
        return (
            <NavBar>
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
            <NavBar>
                <ImportPage />
            </NavBar>
        );
    }

    return (
        <NavBar>
            <HomePage
                recent={recent}
                quizzes={filteredQuizzes}
                folders={foldersSeed}
                search={search}
                setSearch={setSearch}
                onQuizClick={handleQuizClick}
            />
        </NavBar>
    );
}
