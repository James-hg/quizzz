import os
import tempfile

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware

from .docx_extract import docx_extract

app = FastAPI(title="Quizzz API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/")
async def root() -> dict[str, str]:
    return {"message": "FastAPI backend is up"}


@app.post("/upload")
async def upload_docx(file: UploadFile = File(...)):
    """
    Accepts a .docx file upload, extracts quiz structure, and returns JSON.
    """
    if not file.filename.lower().endswith(".docx"):
        raise HTTPException(
            status_code=400, detail="Only .docx files are supported.")

    content = await file.read()
    if not content:
        raise HTTPException(status_code=400, detail="Uploaded file is empty.")

    # python-docx expects a filesystem path, so persist to a temp file
    tmp_path = None
    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=".docx") as tmp:
            tmp.write(content)
            tmp_path = tmp.name

        return docx_extract(tmp_path)
    except Exception as exc:  # broad: parsing can fail for malformed docs
        raise HTTPException(
            status_code=400, detail=f"Failed to parse DOCX: {exc}") from exc
    finally:
        if tmp_path:
            try:
                os.remove(tmp_path)
            except OSError:
                pass
