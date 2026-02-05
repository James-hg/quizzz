from app.main import app

# Vercel will handle this file as the entry point
# Export the FastAPI app directly without mounting
handler = app
