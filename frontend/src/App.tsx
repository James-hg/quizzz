import { useEffect, useState } from "react";

function App() {
    const [message, setMessage] = useState("Loading...");

    useEffect(() => {
        fetch("http://localhost:8000/")
            .then((response) => response.json())
            .then((data) => setMessage(data.message))
            .catch(() => setMessage("Failed to reach FastAPI"));
    }, []);

    return (
        <main>
            <h1>Quizzz</h1>
            <p>{message}</p>
        </main>
    );
}

export default App;
