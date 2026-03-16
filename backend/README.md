# Backend (FastAPI)

## Start the server

```bash
pip install -r requirements.txt
uvicorn app.main:app --reload
```

For local/backend Docker config, start from:

```bash
cp backend/.env.example backend/.env
```

## Required environment variables

- `DATABASE_URL` (PostgreSQL async URL)
- `JWT_SECRET_KEY`

Optional:

- `JWT_EXPIRES_MINUTES` (default `10080`)
- `ADMIN_EMAIL`
- `ADMIN_PASSWORD`
- `ADMIN_DISPLAY_NAME`

Example admin default:

- `ADMIN_EMAIL=admin@quizzz.dev`
