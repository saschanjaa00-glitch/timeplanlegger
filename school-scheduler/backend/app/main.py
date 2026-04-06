import os
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pathlib import Path

from .models import ScheduleRequest, ScheduleResponse
from .solver import generate_schedule


LAST_REQUEST_PATH = Path(__file__).resolve().parents[1] / "last_generate_request.json"

app = FastAPI(title="School Scheduler API", version="0.1.0")

_default_origins = [
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://localhost:3001",
    "http://127.0.0.1:3001",
]
_env_origins = [o.strip() for o in os.environ.get("CORS_ORIGINS", "").split(",") if o.strip()]
_allowed_origins = list(dict.fromkeys(_default_origins + _env_origins))

app.add_middleware(
    CORSMiddleware,
    allow_origins=_allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/generate-schedule", response_model=ScheduleResponse)
def generate_schedule_endpoint(payload: ScheduleRequest) -> ScheduleResponse:
    try:
        try:
            payload_json = ""
            if hasattr(payload, "model_dump_json"):
                payload_json = payload.model_dump_json(indent=2)  # Pydantic v2
            else:
                payload_json = payload.json(indent=2)  # Pydantic v1
            LAST_REQUEST_PATH.write_text(
                payload_json,
                encoding="utf-8",
            )
        except Exception:
            pass

        print(
            "[API] /generate-schedule alternating_weeks_enabled=",
            payload.alternating_weeks_enabled,
            "alternate_non_block_subjects=",
            payload.alternate_non_block_subjects,
        )
        response = generate_schedule(payload)
        counts: dict[str, int] = {}
        for item in response.schedule:
            key = item.week_type or "None"
            counts[key] = counts.get(key, 0) + 1
        print(
            "[API] response status=",
            response.status,
            "message=",
            response.message,
            "items=",
            len(response.schedule),
            "week_counts=",
            counts,
        )
        return response
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
