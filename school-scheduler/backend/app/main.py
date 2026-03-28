from fastapi import FastAPI
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
    return generate_schedule(payload)
