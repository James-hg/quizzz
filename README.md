# Quizzz

A quiz app to revise for exams

## Next steps

1. Install backend dependencies and run `uvicorn app.main:app --reload`
2. `npm install` inside the frontend and run `npm run dev`
3. Adjust `fetch` in `frontend/src/App.tsx` if the API URL changes

## Docker

### One-shot with Compose

```sh
docker compose up --build
```

- Backend: <http://localhost:8000>
- Frontend: <http://localhost:5173> (talks to backend via `VITE_API_URL`)

### Manual builds

```sh
# Backend
docker build -t quizzz-backend ./backend
docker run -p 8000:8000 quizzz-backend

# Frontend (serves built assets with `serve`)
docker build -t quizzz-frontend ./frontend
docker run -p 5173:5173 quizzz-frontend
```

### Truncate command

- Run docker-compose normally

```sh
docker compose exec db psql -U postgres -d quizzz -c "
TRUNCATE responses, quiz_sessions, options, questions, quizzes CASCADE;"
```
