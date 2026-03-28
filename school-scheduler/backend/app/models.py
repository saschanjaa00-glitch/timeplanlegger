from __future__ import annotations

from typing import Dict, List, Optional

from pydantic import BaseModel, Field


class Subject(BaseModel):
    id: str
    name: str
    teacher_id: str
    class_ids: List[str]
    allowed_timeslots: Optional[List[str]] = None
    # Optional extension to support blocks as grouped timeslot candidates.
    allowed_block_ids: Optional[List[str]] = None


class Teacher(BaseModel):
    id: str
    name: str
    unavailable_timeslots: List[str] = Field(default_factory=list)


class Class(BaseModel):
    id: str
    name: str


class Timeslot(BaseModel):
    id: str
    day: str
    period: int


class Block(BaseModel):
    id: str
    name: str
    timeslot_ids: List[str]
    week_pattern: Optional[str] = None
    class_ids: List[str] = Field(default_factory=list)
    subject_ids: List[str] = Field(default_factory=list)


class ScheduleRequest(BaseModel):
    subjects: List[Subject]
    teachers: List[Teacher]
    classes: List[Class]
    timeslots: List[Timeslot]
    blocks: List[Block] = Field(default_factory=list)
    alternating_weeks_enabled: bool = False


class ScheduledItem(BaseModel):
    subject_id: str
    subject_name: str
    teacher_id: str
    class_ids: List[str]
    timeslot_id: str
    day: str
    period: int
    week_type: Optional[str] = None


class ScheduleResponse(BaseModel):
    status: str
    message: str
    schedule: List[ScheduledItem]
    metadata: Dict[str, float] = Field(default_factory=dict)
