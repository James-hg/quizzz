import { useRef, useState } from "react";

export function ImportPage() {
    const fileInputRef = useRef<HTMLInputElement | null>(null);
    const [fileName, setFileName] = useState<string | null>(null);

    const handleUploadClick = () => {
        fileInputRef.current?.click();
    };

    const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (file) {
            setFileName(file.name);
        }
    };

    return (
        <div className="page import-page">
            <div className="modal">
                <div className="modal-header">
                    <div className="eyebrow">Import</div>
                    <h2>Bring your quiz files</h2>

                    <div className="modal-actions">
                        <button
                            className="btn primary"
                            onClick={handleUploadClick}
                        >
                            Upload file
                        </button>
                        <button className="btn secondary" disabled>
                            Extract (coming soon)
                        </button>
                    </div>
                    <div className="muted">
                        <ul>
                            The importer reads the document from top to bottom.
                        </ul>
                        <ul>
                            A paragraph is treated as a question if it:
                            <ul>Starts with a number such as 1. or 1), or</ul>
                            <ul>Begins with Question 1, Question 1:, or Q1.</ul>
                        </ul>
                        <ul>
                            A paragraph is treated as a choice if it:
                            <ul>
                                Is a nested Word list item under a question, or
                            </ul>
                            <ul>
                                Starts with a letter such as A. or B)
                                (case-insensitive).
                            </ul>
                        </ul>
                        <ul>
                            Lines that do not start a new question or choice are
                            automatically appended to the previous question or
                            choice.
                        </ul>
                        <ul>
                            The correct answer must be bold, and each question
                            should have exactly one bold choice.
                        </ul>
                        <ul>
                            Mixed formatting styles (lists and typed text) are
                            supported in the same document.
                        </ul>
                        <ul>
                            If any ambiguity is detected (missing choices,
                            multiple bold answers, unclear structure), the quiz
                            will still import and can be fixed in the review
                            screen before saving.
                        </ul>
                    </div>
                </div>
                <div className="file-note">
                    {fileName ? `Selected: ${fileName}` : "No file chosen yet."}
                </div>
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
