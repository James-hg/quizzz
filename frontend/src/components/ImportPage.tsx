import { useRef, useState } from "react";

type DraftQuiz = {
    title?: string;
    questions: {
        text: string;
        options: { text: string; isCorrect: boolean }[];
    }[];
};

type Props = {
    onExtract: (draft: DraftQuiz) => void;
};

export function ImportPage({ onExtract }: Props) {
    const fileInputRef = useRef<HTMLInputElement | null>(null);
    const [fileName, setFileName] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const apiBase = import.meta.env.VITE_API_URL ?? "http://localhost:8000";

    const handleUploadClick = () => {
        fileInputRef.current?.click();
    };

    const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (file) {
            setFileName(file.name);
        }
    };

    const handleExtract = async () => {
        if (!fileInputRef.current || !fileInputRef.current.files?.[0]) {
            setError("Please choose a file first.");
            return;
        }
        const file = fileInputRef.current.files[0];
        const formData = new FormData();
        formData.append("file", file);
        setLoading(true);
        setError(null);
        try {
            const resp = await fetch(`${apiBase}/upload`, {
                method: "POST",
                body: formData,
            });
            if (!resp.ok) {
                const detail = await resp.json().catch(() => ({}));
                throw new Error(detail.detail || "Extract failed");
            }
            const data = (await resp.json()) as DraftQuiz;
            onExtract(data);
        } catch (err) {
            const msg = err instanceof Error ? err.message : "Extract failed";
            setError(msg);
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="page import-page">
            <div className="modal">
                <div className="modal-header">
                    <div className="eyebrow">Import</div>
                    <h2>Bring your quiz files</h2>
                </div>

                <div className="modal-actions">
                    <button className="btn primary" onClick={handleUploadClick}>
                        Upload file
                    </button>
                    <button
                        className="btn secondary"
                        onClick={handleExtract}
                        disabled={loading}
                    >
                        {loading ? "Extracting..." : "Extract"}
                    </button>
                </div>

                <div className="muted">
                    <ul>The importer reads the document from top to bottom.</ul>
                    <ul>
                        A paragraph is treated as a question if it:
                        <ul>Starts with a number such as 1. or 1), or</ul>
                        <ul>Begins with Question 1, Question 1:, or Q1.</ul>
                    </ul>
                    <ul>
                        A paragraph is treated as a choice if it:
                        <ul>Is a nested Word list item under a question, or</ul>
                        <ul>
                            Starts with a letter such as A. or B)
                            (case-insensitive).
                        </ul>
                    </ul>
                    <ul>
                        Lines that do not start a new question or choice are
                        appended to the previous entry.
                    </ul>
                    <ul>
                        The correct answer must be bold, with exactly one bold
                        choice.
                    </ul>
                </div>

                <div className="file-note">
                    {fileName ? `Selected: ${fileName}` : "No file chosen yet."}
                </div>
                {error && <div className="error-text">⚠ {error}</div>}
                <input
                    ref={fileInputRef}
                    type="file"
                    accept=".docx,.pdf,.csv,.xlsx,.xls"
                    style={{ display: "none" }}
                    onChange={handleFileChange}
                />
            </div>
        </div>
    );
}
