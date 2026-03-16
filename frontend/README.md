# Frontend (React + Vite)

## Setup

```bash
npm install
npm run dev
```

For local/frontend Docker config, start from:

```bash
cp frontend/.env.example frontend/.env
```

## AI Coach (Gemini)

Set these in your frontend environment (for Vite):

- `VITE_AI_PROVIDER=gemini`
- `VITE_GEMINI_API_KEY=your_google_ai_api_key`
- `VITE_GEMINI_MODEL=gemini-2.0-flash` (optional; defaults to this)

If `VITE_GEMINI_API_KEY` is missing, the UI falls back to a local mock responder so the panel still works.
