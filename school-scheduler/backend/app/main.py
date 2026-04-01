from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from .models import ScheduleRequest, ScheduleResponse
from .solver import generate_schedule

app = FastAPI(title="School Scheduler API", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",
        "http://127.0.0.1:3000",
    ],
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
