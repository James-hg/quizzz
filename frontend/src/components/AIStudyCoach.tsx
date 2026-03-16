import { FormEvent, useMemo, useState } from "react";
import { createChatProvider } from "../ai/chatClient";
import { ChatMessage } from "../ai/types";

const provider = createChatProvider();

const initialMessage: ChatMessage = {
    id: "welcome",
    role: "assistant",
    content:
        "I am your study coach. Ask for quiz ideas, revision plans, or question improvements.",
    createdAt: Date.now(),
};

export function AIStudyCoach() {
    const [messages, setMessages] = useState<ChatMessage[]>([initialMessage]);
    const [draft, setDraft] = useState("");
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const hasGemini = useMemo(() => provider.name === "gemini", []);

    const submit = async (event: FormEvent) => {
        event.preventDefault();
        const text = draft.trim();
        if (!text || pending) return;

        const userMessage: ChatMessage = {
            id: `${Date.now()}-u`,
            role: "user",
            content: text,
            createdAt: Date.now(),
        };

        setError(null);
        setDraft("");
        setMessages((prev) => [...prev, userMessage]);
        setPending(true);

        try {
            const reply = await provider.generateReply({
                messages,
                userMessage: text,
            });
            const assistantMessage: ChatMessage = {
                id: `${Date.now()}-a`,
                role: "assistant",
                content: reply,
                createdAt: Date.now(),
            };
            setMessages((prev) => [...prev, assistantMessage]);
        } catch (err) {
            setError(err instanceof Error ? err.message : "Failed to get AI response.");
        } finally {
            setPending(false);
        }
    };

    return (
        <div className="ai-coach">
            <div className="ai-coach-head">
                <div className="eyebrow">AI Study Coach</div>
                <div className={`ai-badge ${hasGemini ? "live" : "fallback"}`}>
                    {hasGemini ? "Gemini Live" : "Fallback"}
                </div>
            </div>
            <h3>Ask for help</h3>
            <p className="muted ai-hint">
                {hasGemini
                    ? "Gemini is active. Responses are generated in real-time."
                    : "Set VITE_GEMINI_API_KEY to enable Gemini responses."}
            </p>

            <div className="ai-thread">
                {messages.map((message) => (
                    <div key={message.id} className={`ai-msg ${message.role}`}>
                        <span className="ai-role">{message.role === "assistant" ? "AI" : "You"}</span>
                        <p>{message.content}</p>
                    </div>
                ))}
                {pending && <div className="ai-msg assistant typing">Thinking...</div>}
            </div>

            {error && <div className="error-text">{error}</div>}

            <form className="ai-form" onSubmit={submit}>
                <textarea
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    placeholder="Ask: create me a 7-day revision plan for biology"
                    rows={3}
                />
                <button className="btn secondary" type="submit" disabled={pending || !draft.trim()}>
                    {pending ? "Sending..." : "Send"}
                </button>
            </form>
        </div>
    );
}
