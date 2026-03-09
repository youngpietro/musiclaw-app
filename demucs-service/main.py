"""
MusiClaw Stem Splitter — FastAPI + Demucs htdemucs_6s
Accepts async stem-split requests, processes on CPU via CLI,
uploads to Supabase Storage, and calls back stems-callback with results.
"""

import os
import uuid
import asyncio
import tempfile
import subprocess
from pathlib import Path

import httpx
from fastapi import FastAPI, BackgroundTasks, HTTPException, Header
from pydantic import BaseModel

# ── Config ──────────────────────────────────────────────────────────────
MODEL_NAME = os.environ.get("DEMUCS_MODEL", "htdemucs_6s")
SUPABASE_URL = os.environ.get("SUPABASE_URL", "")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
API_SECRET = os.environ.get("DEMUCS_API_SECRET", "")
MAX_CONCURRENT = int(os.environ.get("MAX_CONCURRENT", "1"))
MAX_JOBS = 200  # keep last N jobs in memory

# ── Globals ─────────────────────────────────────────────────────────────
processing_semaphore = None
jobs: dict = {}


app = FastAPI(title="MusiClaw Stem Splitter")


@app.on_event("startup")
async def startup():
    global processing_semaphore
    processing_semaphore = asyncio.Semaphore(MAX_CONCURRENT)
    print(f"Demucs model: {MODEL_NAME}, max concurrent: {MAX_CONCURRENT}")


# ── Request/Response Models ─────────────────────────────────────────────
class SeparateRequest(BaseModel):
    audio_url: str
    beat_id: str
    callback_url: str | None = None


# ── Endpoints ───────────────────────────────────────────────────────────
@app.get("/health")
async def health():
    active = sum(1 for j in jobs.values() if j["status"] in ("queued", "processing"))
    return {
        "status": "ok",
        "model": MODEL_NAME,
        "device": "cpu",
        "active_jobs": active,
        "total_jobs": len(jobs),
    }


@app.post("/separate", status_code=202)
async def separate(
    req: SeparateRequest,
    background_tasks: BackgroundTasks,
    x_api_secret: str = Header(default=""),
):
    if API_SECRET and x_api_secret != API_SECRET:
        raise HTTPException(status_code=401, detail="Invalid API secret")

    job_id = str(uuid.uuid4())
    jobs[job_id] = {"status": "queued", "stems": None, "error": None}

    # Prune old jobs if over limit
    if len(jobs) > MAX_JOBS:
        finished = [
            k for k, v in jobs.items() if v["status"] in ("complete", "failed")
        ]
        for k in finished[: len(finished) // 2]:
            del jobs[k]

    background_tasks.add_task(
        process_separation, job_id, req.audio_url, req.beat_id, req.callback_url
    )
    return {"job_id": job_id, "status": "queued"}


@app.get("/status/{job_id}")
async def get_status(job_id: str):
    if job_id not in jobs:
        raise HTTPException(status_code=404, detail="Job not found")
    return {"job_id": job_id, **jobs[job_id]}


# ── Background Processing ──────────────────────────────────────────────
async def process_separation(
    job_id: str, audio_url: str, beat_id: str, callback_url: str | None
):
    tag = job_id[:8]

    async with processing_semaphore:
        jobs[job_id]["status"] = "processing"
        try:
            with tempfile.TemporaryDirectory() as tmpdir:
                tmpdir_path = Path(tmpdir)
                input_path = tmpdir_path / "input.mp3"
                output_dir = tmpdir_path / "output"
                output_dir.mkdir()

                # ── 1. Download audio ───────────────────────────────────
                print(f"[{tag}] Downloading: {audio_url[:100]}...")
                async with httpx.AsyncClient(
                    timeout=120, follow_redirects=True
                ) as client:
                    resp = await client.get(audio_url)
                    resp.raise_for_status()
                    input_path.write_bytes(resp.content)
                size_mb = input_path.stat().st_size / 1024 / 1024
                print(f"[{tag}] Downloaded {size_mb:.1f} MB")

                # ── 2. Demucs separation via CLI (CPU) ────────────────
                print(f"[{tag}] Running {MODEL_NAME} separation...")
                loop = asyncio.get_event_loop()
                result = await loop.run_in_executor(
                    None,
                    lambda: subprocess.run(
                        [
                            "python", "-m", "demucs",
                            "-n", MODEL_NAME,
                            "--mp3",
                            "--mp3-bitrate", "192",
                            "-o", str(output_dir),
                            str(input_path),
                        ],
                        capture_output=True,
                        text=True,
                    ),
                )

                if result.returncode != 0:
                    raise RuntimeError(
                        f"Demucs CLI failed (exit {result.returncode}): "
                        f"{result.stderr[:500]}"
                    )

                # Output is at output_dir/{model_name}/input/*.mp3
                stems_dir = output_dir / MODEL_NAME / "input"
                if not stems_dir.exists():
                    # Try alternative path patterns
                    candidates = list(output_dir.rglob("*.mp3"))
                    if candidates:
                        stems_dir = candidates[0].parent
                    else:
                        raise RuntimeError(
                            f"No stem files found in {output_dir}. "
                            f"stdout: {result.stdout[:300]}"
                        )

                stem_files = {p.stem: p for p in stems_dir.glob("*.mp3")}
                print(f"[{tag}] Separated: {list(stem_files.keys())}")

                # ── 3. Upload stems to Supabase Storage ─────────────────
                stems_urls: dict[str, str] = {}
                async with httpx.AsyncClient(timeout=60) as client:
                    for stem_name, mp3_path in stem_files.items():
                        storage_path = (
                            f"beats/{beat_id}/stems/{stem_name}.mp3"
                        )
                        file_data = mp3_path.read_bytes()
                        file_kb = len(file_data) // 1024
                        print(f"[{tag}] Uploading {stem_name}: {file_kb} KB")

                        resp = await client.put(
                            f"{SUPABASE_URL}/storage/v1/object/audio/{storage_path}",
                            content=file_data,
                            headers={
                                "Authorization": f"Bearer {SUPABASE_KEY}",
                                "Content-Type": "audio/mpeg",
                                "x-upsert": "true",
                            },
                        )

                        if resp.status_code in (200, 201):
                            public_url = f"{SUPABASE_URL}/storage/v1/object/public/audio/{storage_path}"
                            stems_urls[stem_name] = public_url
                            print(f"[{tag}] Uploaded {stem_name}")
                        else:
                            print(
                                f"[{tag}] Upload failed {stem_name}: "
                                f"{resp.status_code} {resp.text[:200]}"
                            )

                # ── 4. Call stems-callback ───────────────────────────────
                if callback_url and stems_urls:
                    payload = {
                        "code": 200,
                        "data": {
                            "task_id": beat_id,
                            "vocal_removal_info": {
                                f"{k}_url": v for k, v in stems_urls.items()
                            },
                        },
                        "msg": f"Stems separated via Demucs {MODEL_NAME}",
                    }
                    async with httpx.AsyncClient(timeout=30) as client:
                        cb = await client.post(callback_url, json=payload)
                        print(f"[{tag}] Callback: {cb.status_code}")

                jobs[job_id] = {
                    "status": "complete",
                    "stems": stems_urls,
                    "error": None,
                }
                print(f"[{tag}] Done: {len(stems_urls)} stems")

        except Exception as e:
            err = str(e)
            print(f"[{tag}] Error: {err}")
            jobs[job_id] = {"status": "failed", "stems": None, "error": err}

            # Notify callback of failure
            if callback_url:
                try:
                    async with httpx.AsyncClient(timeout=10) as client:
                        await client.post(
                            callback_url,
                            json={
                                "code": 500,
                                "data": {"task_id": beat_id},
                                "msg": f"Failed: {err}",
                            },
                        )
                except Exception:
                    pass
