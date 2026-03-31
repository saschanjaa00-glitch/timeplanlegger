from __future__ import annotations

from typing import Dict, List, Literal, Optional

from pydantic import BaseModel, Field


class Subject(BaseModel):
    id: str
    name: str
    teacher_id: str
    teacher_ids: List[str] = Field(default_factory=list)
    class_ids: List[str]
    subject_type: str = "fellesfag"
    sessions_per_week: int = 1
    # Optional explicit A/B split in 45-minute units, e.g. "4/6".
    # Solver may place either as A=4,B=6 or A=6,B=4.
    alternating_week_split: Optional[str] = None
    allowed_timeslots: Optional[List[str]] = None
    # Optional extension to support blocks as grouped timeslot candidates.
    allowed_block_ids: Optional[List[str]] = None


class Teacher(BaseModel):
    id: str
    name: str
    preferred_avoid_timeslots: List[str] = Field(default_factory=list)
    unavailable_timeslots: List[str] = Field(default_factory=list)
    workload_percent: int = Field(default=100, ge=1, le=100)


class MeetingTeacherAssignment(BaseModel):
    teacher_id: str
    mode: Literal["preferred", "unavailable"]


class Meeting(BaseModel):
    id: str
    name: str
    timeslot_id: str
    teacher_assignments: List[MeetingTeacherAssignment] = Field(default_factory=list)


class Class(BaseModel):
    id: str
    name: str
    base_room_id: Optional[str] = None


class Timeslot(BaseModel):
    id: str
    day: str
    period: int
    start_time: Optional[str] = None
    end_time: Optional[str] = None
    excluded_from_generation: bool = False
    generation_allowed_class_ids: List[str] = Field(default_factory=list)


class BlockOccurrence(BaseModel):
    id: str
    day: str
    start_time: str
    end_time: str
    week_type: str = "both"  # "both", "A", or "B"


class BlockSubjectEntry(BaseModel):
    subject_id: str
    teacher_id: str = ""
    preferred_room_id: str = ""


class Block(BaseModel):
    id: str
    name: str
    occurrences: List[BlockOccurrence] = Field(default_factory=list)
    class_ids: List[str] = Field(default_factory=list)
    subject_entries: List[BlockSubjectEntry] = Field(default_factory=list)
    # Legacy fields kept for backwards compatibility
    timeslot_ids: List[str] = Field(default_factory=list)
    week_pattern: Optional[str] = None
    subject_ids: List[str] = Field(default_factory=list)


class Room(BaseModel):
    id: str
    name: str


class ScheduleRequest(BaseModel):
    subjects: List[Subject]
    teachers: List[Teacher]
    classes: List[Class]
    timeslots: List[Timeslot]
    blocks: List[Block] = Field(default_factory=list)
    meetings: List[Meeting] = Field(default_factory=list)
    rooms: List[Room] = Field(default_factory=list)
    alternating_weeks_enabled: bool = False
    alternate_non_block_subjects: bool = False


class ScheduledItem(BaseModel):
    subject_id: str
    subject_name: str
    teacher_id: str
    teacher_ids: List[str] = Field(default_factory=list)
    class_ids: List[str]
    timeslot_id: str
    day: str
    period: int
    start_time: Optional[str] = None
    end_time: Optional[str] = None
    week_type: Optional[str] = None
    room_id: Optional[str] = None


class ScheduleResponse(BaseModel):
    status: str
    message: str
    schedule: List[ScheduledItem]
    metadata: Dict[str, float] = Field(default_factory=dict)
