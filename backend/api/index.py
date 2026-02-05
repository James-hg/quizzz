from fastapi import FastAPI
from app.main import app as fastapi_app

# Mount the main FastAPI app under /api so requests to /api/* route correctly.
app = FastAPI()
app.mount("/api", fastapi_app)
