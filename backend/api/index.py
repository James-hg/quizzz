from mangum import Mangum
from app.main import app

# Wrap FastAPI with Mangum for serverless deployment
handler = Mangum(app, lifespan="off")
