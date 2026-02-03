import { useEffect, useState } from "react";

function App() {
    const [message, setMessage] = useState("Loading...");
    const apiBase = import.meta.env.VITE_API_URL ?? "http://localhost:8000";

    useEffect(() => {
        fetch(`${apiBase}/`)
            .then((response) => response.json())
            .then((data) => setMessage(data.message))
            .catch(() => setMessage("Failed to reach FastAPI"));
    }, [apiBase]);

    return (
        <main>
            <h1>Quizzz</h1>
            <p>{message}</p>
        </main>
    );
}

export default App;
