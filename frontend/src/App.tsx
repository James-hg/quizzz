import { useEffect, useState } from "react";

type UploadState = "idle" | "uploading";

type Option = {
    text: string;
    isCorrect: boolean;
};

type Question = {
    text: string;
    options: Option[];
};

type ParsedQuiz = {
    title?: string;
    questions: Question[];
    warnings?: string[];
};

function App() {
    const apiBase = import.meta.env.VITE_API_URL ?? "http://localhost:8000";

    const [backendStatus, setBackendStatus] = useState("Checking backend...");
    const [file, setFile] = useState<File | null>(null);
    const [parsed, setParsed] = useState<ParsedQuiz | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [uploadState, setUploadState] = useState<UploadState>("idle");

    useEffect(() => {
        fetch(`${apiBase}/`)
            .then((response) => response.json())
            .then((data) => setBackendStatus(data.message ?? "Backend ready"))
            .catch(() => setBackendStatus("Failed to reach FastAPI"));
    }, [apiBase]);

    const handleFileChange = (evt: React.ChangeEvent<HTMLInputElement>) => {
        const picked = evt.target.files?.[0] ?? null;
        setFile(picked);
        setParsed(null);
        setError(null);
    };

    const handleUpload = async () => {
        if (!file) {
            setError("Please choose a .docx file first.");
            return;
        }

        const formData = new FormData();
        formData.append("file", file);

        setUploadState("uploading");
        setError(null);
        setParsed(null);

        try {
            const resp = await fetch(`${apiBase}/upload`, {
                method: "POST",
                body: formData,
            });

            if (!resp.ok) {
                const detail = await resp.json().catch(() => ({}));
                throw new Error(detail.detail ?? "Upload failed");
            }

            const data = (await resp.json()) as ParsedQuiz;
            setParsed(data);
        } catch (err) {
            const message =
                err instanceof Error ? err.message : "Unexpected error";
            setError(message);
        } finally {
            setUploadState("idle");
        }
    };

    return (
        <main
            style={{
                minHeight: "100vh",
                background: "linear-gradient(135deg, #667eea 0%, #764ba2 100%)",
                display: "flex",
                flexDirection: "column",
                padding: "2rem",
            }}
        >
            {/* Header */}
            <header style={{ textAlign: "center", marginBottom: "3rem" }}>
                <h1
                    style={{
                        color: "white",
                        fontSize: "4rem",
                        fontWeight: 800,
                        letterSpacing: "0.1em",
                        margin: 0,
                        textShadow: "0 4px 12px rgba(0,0,0,0.2)",
                    }}
                >
                    QUIZZZ
                </h1>
                <p
                    style={{
                        color: "rgba(255,255,255,0.9)",
                        fontSize: "1.2rem",
                        marginTop: "1rem",
                        fontWeight: 300,
                    }}
                >
                    Upload a DOCX file to begin
                </p>
            </header>

            {/* Upload Section */}
            <div
                style={{
                    flex: 1,
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: "2rem",
                }}
            >
                <div
                    style={{
                        display: "flex",
                        gap: "1.5rem",
                        alignItems: "center",
                        flexWrap: "wrap",
                        justifyContent: "center",
                    }}
                >
                    <label
                        style={{
                            padding: "1.25rem 2.5rem",
                            background: "rgba(255,255,255,0.95)",
                            color: "#333",
                            borderRadius: 50,
                            cursor: "pointer",
                            fontSize: "1.1rem",
                            fontWeight: 600,
                            transition: "all 0.3s",
                            boxShadow: "0 8px 20px rgba(0,0,0,0.15)",
                            border: "3px solid white",
                            minWidth: "200px",
                            textAlign: "center",
                        }}
                        onMouseEnter={(e) => {
                            e.currentTarget.style.transform =
                                "translateY(-2px)";
                            e.currentTarget.style.boxShadow =
                                "0 12px 28px rgba(0,0,0,0.25)";
                        }}
                        onMouseLeave={(e) => {
                            e.currentTarget.style.transform = "translateY(0)";
                            e.currentTarget.style.boxShadow =
                                "0 8px 20px rgba(0,0,0,0.15)";
                        }}
                    >
                        {file ? `📄 ${file.name}` : "📁 Choose File"}
                        <input
                            type="file"
                            accept=".docx"
                            onChange={handleFileChange}
                            disabled={uploadState === "uploading"}
                            style={{ display: "none" }}
                        />
                    </label>
                    <button
                        onClick={handleUpload}
                        disabled={!file || uploadState === "uploading"}
                        style={{
                            padding: "1.25rem 3rem",
                            background:
                                !file || uploadState === "uploading"
                                    ? "rgba(255,255,255,0.3)"
                                    : "rgba(255,255,255,1)",
                            color:
                                !file || uploadState === "uploading"
                                    ? "rgba(255,255,255,0.6)"
                                    : "#764ba2",
                            border: "3px solid white",
                            borderRadius: 50,
                            cursor:
                                !file || uploadState === "uploading"
                                    ? "not-allowed"
                                    : "pointer",
                            fontSize: "1.2rem",
                            fontWeight: 700,
                            boxShadow:
                                !file || uploadState === "uploading"
                                    ? "none"
                                    : "0 8px 20px rgba(0,0,0,0.2)",
                            transition: "all 0.3s ease",
                            textTransform: "uppercase",
                            letterSpacing: "0.05em",
                        }}
                        onMouseEnter={(e) => {
                            if (file && uploadState !== "uploading") {
                                e.currentTarget.style.transform = "scale(1.05)";
                                e.currentTarget.style.boxShadow =
                                    "0 12px 28px rgba(0,0,0,0.3)";
                            }
                        }}
                        onMouseLeave={(e) => {
                            e.currentTarget.style.transform = "scale(1)";
                            e.currentTarget.style.boxShadow =
                                "0 8px 20px rgba(0,0,0,0.2)";
                        }}
                    >
                        {uploadState === "uploading"
                            ? "⏳ Uploading..."
                            : "🚀 Upload"}
                    </button>
                </div>

                {error && (
                    <div
                        style={{
                            padding: "1rem 2rem",
                            background: "rgba(220, 38, 38, 0.95)",
                            color: "white",
                            borderRadius: 12,
                            fontSize: "1rem",
                            fontWeight: 500,
                            boxShadow: "0 4px 12px rgba(0,0,0,0.2)",
                        }}
                    >
                        ⚠️ {error}
                    </div>
                )}
            </div>

            {/* Results Section */}
            {parsed && (
                <div
                    style={{
                        marginTop: "3rem",
                        padding: "2rem",
                        background: "rgba(255,255,255,0.95)",
                        borderRadius: 16,
                        boxShadow: "0 8px 24px rgba(0,0,0,0.2)",
                        maxWidth: "1200px",
                        width: "100%",
                        margin: "3rem auto 0",
                        overflowX: "auto",
                    }}
                >
                    <h2
                        style={{
                            color: "#764ba2",
                            fontSize: "1.8rem",
                            marginBottom: "1.5rem",
                            fontWeight: 700,
                        }}
                    >
                        📊 Parsed Questions
                    </h2>
                    {parsed.warnings?.length ? (
                        <div
                            style={{
                                background: "#fff8e1",
                                color: "#a86b00",
                                border: "1px solid #ffe0a3",
                                padding: "0.75rem 1rem",
                                borderRadius: 8,
                                marginBottom: "1rem",
                            }}
                        >
                            <strong>Warnings:</strong>
                            <ul style={{ margin: "0.5rem 0 0 1.25rem" }}>
                                {parsed.warnings.map((w, i) => (
                                    <li key={i}>{w}</li>
                                ))}
                            </ul>
                        </div>
                    ) : null}

                    <ol style={{ paddingLeft: "1.25rem", margin: 0 }}>
                        {parsed.questions.map((q, qi) => (
                            <li key={qi} style={{ marginBottom: "1.25rem" }}>
                                <div
                                    style={{
                                        fontWeight: 700,
                                        fontSize: "1.1rem",
                                        marginBottom: "0.4rem",
                                    }}
                                >
                                    Question {qi + 1}: {q.text}
                                </div>
                                <div style={{ fontWeight: 600 }}>Options:</div>
                                <ul style={{ margin: "0.35rem 0 0 1.1rem" }}>
                                    {q.options.map((opt, oi) => (
                                        <li key={oi} style={{ margin: "0.2rem 0" }}>
                                            {opt.text}{" "}
                                            {opt.isCorrect ? (
                                                <strong style={{ color: "#0f9153" }}>
                                                    True
                                                </strong>
                                            ) : null}
                                        </li>
                                    ))}
                                </ul>
                            </li>
                        ))}
                    </ol>
                </div>
            )}
        </main>
    );
}

export default App;
