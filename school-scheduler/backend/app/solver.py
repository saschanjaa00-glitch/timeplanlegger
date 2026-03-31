from __future__ import annotations

from collections import defaultdict
from math import gcd
from pathlib import Path
import re
from typing import Dict, List, Set, Tuple

from ortools.sat.python import cp_model

from .models import Block, BlockOccurrence, ScheduleRequest, ScheduleResponse, ScheduledItem, Subject, Timeslot


MAX_WEEKLY_WORK_MINUTES_100_PERCENT = 29 * 60
PREFERRED_AVOID_WEIGHT = 20
DAY_IMBALANCE_WEIGHT = 1
BOUNDARY_SLOT_WEIGHT = 1
TEACHER_PRESENCE_EXCESS_WEIGHT = 5
TEACHER_WORKLOAD_EXCESS_WEIGHT = 10
FELLESFAG_SAME_DAY_PENALTY_WEIGHT = 3
NORSK_VG3_NO_DOUBLE90_PENALTY_WEIGHT = 12
SOLVER_LOG_PATH = Path(__file__).resolve().parents[1] / "solver_last_run.log"


def _solver_log(message: str, reset: bool = False) -> None:
    mode = "w" if reset else "a"
    try:
        with SOLVER_LOG_PATH.open(mode, encoding="utf-8") as f:
            f.write(message + "\n")
    except Exception:
        # Logging should never break scheduling.
        pass


def _normalize_workload_percent(value: int | None) -> int:
    if value is None:
        return 100
    return max(1, min(100, int(value)))


def _to_minutes(value: str | None) -> int | None:
    if not value or ":" not in value:
        return None
    parts = value.split(":")
    if len(parts) != 2:
        return None
    try:
        h = int(parts[0])
        m = int(parts[1])
    except ValueError:
        return None
    if h < 0 or h > 23 or m < 0 or m > 59:
        return None
    return h * 60 + m


def _minutes_to_hhmm(value: int) -> str:
    h = max(0, value // 60)
    m = max(0, value % 60)
    return f"{h:02d}:{m:02d}"


def _timeslot_45m_units(timeslot: Timeslot) -> int:
    # Convert slot duration to 45-minute units.
    # Example: 90 minutes -> 2 units, 45 minutes -> 1 unit.
    start = _to_minutes(timeslot.start_time)
    end = _to_minutes(timeslot.end_time)
    if start is not None and end is not None and end > start:
        duration = end - start
        units = int(round(duration / 45.0))
        return max(1, units)
    return 1


def _timeslot_bounds_minutes(timeslot: Timeslot) -> Tuple[int, int]:
    start = _to_minutes(timeslot.start_time)
    end = _to_minutes(timeslot.end_time)
    if start is not None and end is not None and end > start:
        return start, end

    fallback_start = max(0, (timeslot.period - 1) * 45)
    return fallback_start, fallback_start + 45


def _parse_alternating_week_split(value: str | None) -> Tuple[int, int] | None:
    if not value:
        return None
    text = str(value).strip()
    m = re.fullmatch(r"(\d+)\s*/\s*(\d+)", text)
    if not m:
        return None
    a = int(m.group(1))
    b = int(m.group(2))
    if a < 0 or b < 0:
        return None
    return (a, b)


def _timeslots_overlapping_occurrence(
    occurrence: BlockOccurrence,
    all_timeslots: List[Timeslot],
) -> Set[str]:
    """
    Return timeslot IDs whose day and time window overlaps the given block occurrence.
    Overlap means: the timeslot starts before the occurrence ends AND ends after the occurrence starts.
    """
    occ_start = _to_minutes(occurrence.start_time)
    occ_end = _to_minutes(occurrence.end_time)
    matched: Set[str] = set()
    for ts in all_timeslots:
        if ts.day.lower() != occurrence.day.lower():
            continue
        ts_start = _to_minutes(ts.start_time)
        ts_end = _to_minutes(ts.end_time)
        if ts_start is None or ts_end is None or occ_start is None or occ_end is None:
            # Fall back: if any time is missing, match by day only
            matched.add(ts.id)
            continue
        # Overlap: ts starts before occ ends AND ts ends after occ starts
        if ts_start < occ_end and ts_end > occ_start:
            matched.add(ts.id)
    return matched


def _compute_allowed_timeslots(
    subject: Subject,
    all_timeslot_ids: Set[str],
    block_to_timeslots: Dict[str, Set[str]],
) -> Set[str]:
    # Direct timeslot restriction has highest priority.
    if subject.allowed_timeslots:
        return set(subject.allowed_timeslots) & all_timeslot_ids

    # If blocks are provided on a subject, union all block timeslot sets.
    if subject.allowed_block_ids:
        block_slots: Set[str] = set()
        for block_id in subject.allowed_block_ids:
            block_slots |= block_to_timeslots.get(block_id, set())
        return block_slots & all_timeslot_ids

    return set(all_timeslot_ids)


def _subject_teacher_ids(subject: Subject) -> List[str]:
    # Support both legacy teacher_id and new teacher_ids.
    candidates: List[str] = []
    if getattr(subject, "teacher_id", ""):
        candidates.append(subject.teacher_id)
    candidates.extend(getattr(subject, "teacher_ids", []) or [])
    return list(dict.fromkeys([teacher_id for teacher_id in candidates if teacher_id]))


def _compute_allowed_weeks(
    subject: Subject,
    alternating_weeks_enabled: bool,
    blocks_by_id: Dict[str, Block],
    linked_block_ids: Dict[str, Set[str]],
) -> Set[str]:
    if not alternating_weeks_enabled:
        return {"base"}

    relevant_block_ids: Set[str] = set(subject.allowed_block_ids or [])
    relevant_block_ids |= linked_block_ids.get(subject.id, set())

    if not relevant_block_ids:
        return {"A", "B"}

    allowed_weeks: Set[str] = set()
    for block_id in relevant_block_ids:
        block = blocks_by_id.get(block_id)
        if not block:
            continue
        # Use occurrence week_types if available, else fall back to legacy week_pattern
        if block.occurrences:
            for occ in block.occurrences:
                wt = (occ.week_type or "both").lower()
                if wt == "a":
                    allowed_weeks.add("A")
                elif wt == "b":
                    allowed_weeks.add("B")
                else:
                    allowed_weeks.update({"A", "B"})
        else:
            week_pattern = (block.week_pattern or "both").upper()
            if week_pattern == "A":
                allowed_weeks.add("A")
            elif week_pattern == "B":
                allowed_weeks.add("B")
            else:
                allowed_weeks.update({"A", "B"})

    return allowed_weeks or {"A", "B"}


def _minimum_required_units_from_blocks(
    subject: Subject,
    all_timeslot_ids: Set[str],
    all_timeslots: List[Timeslot],
    alternating_weeks_enabled: bool,
    blocks_by_id: Dict[str, Block],
    linked_block_ids: Dict[str, Set[str]],
) -> int:
    relevant_block_ids: Set[str] = set(subject.allowed_block_ids or [])
    relevant_block_ids |= linked_block_ids.get(subject.id, set())
    if not relevant_block_ids:
        return 0

    if not alternating_weeks_enabled:
        forced_base_slots: Set[str] = set()
        for block_id in relevant_block_ids:
            block = blocks_by_id.get(block_id)
            if not block:
                continue
            has_occurrences = bool(block.occurrences)
            for occ in block.occurrences:
                wt = (occ.week_type or "both").upper()
                if wt in {"A", "B"}:
                    # In non-alternating mode, A/B distinctions collapse into base week.
                    forced_base_slots |= (_timeslots_overlapping_occurrence(occ, all_timeslots) & all_timeslot_ids)
                else:
                    forced_base_slots |= (_timeslots_overlapping_occurrence(occ, all_timeslots) & all_timeslot_ids)
            if not has_occurrences:
                for ts_id in block.timeslot_ids:
                    if ts_id in all_timeslot_ids:
                        forced_base_slots.add(ts_id)
        return len(forced_base_slots)

    forced_a_slots: Set[str] = set()
    forced_b_slots: Set[str] = set()
    for block_id in relevant_block_ids:
        block = blocks_by_id.get(block_id)
        if not block:
            continue
        has_occurrences = bool(block.occurrences)

        for occ in block.occurrences:
            matched_slots = _timeslots_overlapping_occurrence(occ, all_timeslots) & all_timeslot_ids
            wt = (occ.week_type or "both").upper()
            if wt == "A":
                forced_a_slots |= matched_slots
            elif wt == "B":
                forced_b_slots |= matched_slots
            else:
                forced_a_slots |= matched_slots
                forced_b_slots |= matched_slots

        if not has_occurrences:
            legacy_weeks = _block_active_weeks(block, True)
            for ts_id in block.timeslot_ids:
                if ts_id not in all_timeslot_ids:
                    continue
                if "A" in legacy_weeks:
                    forced_a_slots.add(ts_id)
                if "B" in legacy_weeks:
                    forced_b_slots.add(ts_id)

    return max(len(forced_a_slots), len(forced_b_slots))


def _assign_rooms_to_schedule(
    schedule_items: List[ScheduledItem],
    data: ScheduleRequest,
    subjects_by_id: Dict[str, Subject],
    class_to_base_room: Dict[str, str],
) -> List[ScheduledItem]:
    """
    Assign rooms to scheduled items with the following priorities:
    1. Fellesfag subjects with a base room for their class
    2. Other subjects using available rooms
    3. Handle conflicts by ensuring no room double-booking
    """
    if not data.rooms:
        return schedule_items

    rooms_by_id = {r.id: r for r in data.rooms}
    result_items: List[ScheduledItem] = []
    
    # Group items by (timeslot_id, week_type)
    items_by_slot: Dict[Tuple[str, str | None], List[ScheduledItem]] = defaultdict(list)
    for item in schedule_items:
        key = (item.timeslot_id, item.week_type)
        items_by_slot[key].append(item)
    
    # Assign rooms slot by slot, giving priority to fellesfag with base rooms
    room_usage: Dict[Tuple[str, str | None], Set[str]] = defaultdict(set)  # (timeslot, week) -> used room ids
    
    for (timeslot_id, week_type), items in items_by_slot.items():
        # Sort items: fellesfag with base room first
        def item_priority(item: ScheduledItem) -> Tuple[int, str]:
            subject = subjects_by_id.get(item.subject_id)
            if subject and subject.subject_type == "fellesfag" and item.class_ids:
                # Check if first class has a base room
                first_class_id = item.class_ids[0]
                if first_class_id in class_to_base_room:
                    return (0, item.subject_id)  # Priority 0: fellesfag with base room
            return (1, item.subject_id)  # Priority 1: other subjects
        
        sorted_items = sorted(items, key=item_priority)
        
        for item in sorted_items:
            subject = subjects_by_id.get(item.subject_id)
            assigned_room_id: str | None = None
            
            # First, try to assign base room if it's fellesfag
            if subject and subject.subject_type == "fellesfag" and item.class_ids:
                first_class_id = item.class_ids[0]
                if first_class_id in class_to_base_room:
                    base_room_id = class_to_base_room[first_class_id]
                    if base_room_id not in room_usage[(timeslot_id, week_type)]:
                        assigned_room_id = base_room_id
                        room_usage[(timeslot_id, week_type)].add(base_room_id)
            
            # If not assigned yet, try any available room
            if not assigned_room_id:
                for room_id in rooms_by_id.keys():
                    if room_id not in room_usage[(timeslot_id, week_type)]:
                        assigned_room_id = room_id
                        room_usage[(timeslot_id, week_type)].add(room_id)
                        break
            
            # Create new item with assigned room
            new_item = ScheduledItem(
                subject_id=item.subject_id,
                subject_name=item.subject_name,
                teacher_id=item.teacher_id,
                teacher_ids=item.teacher_ids,
                class_ids=item.class_ids,
                timeslot_id=item.timeslot_id,
                day=item.day,
                period=item.period,
                week_type=item.week_type,
                room_id=assigned_room_id,
            )
            result_items.append(new_item)
    
    return result_items


def _block_active_weeks(block: Block, alternating_weeks_enabled: bool) -> Set[str]:
    if not alternating_weeks_enabled:
        return {"base"}

    week_pattern = (block.week_pattern or "both").upper()
    if week_pattern == "A":
        return {"A"}
    if week_pattern == "B":
        return {"B"}
    return {"A", "B"}


def _generate_schedule_staged(data: ScheduleRequest) -> ScheduleResponse:
    _solver_log("[RUN] generate_schedule_staged", reset=True)

    active_timeslots = [t for t in data.timeslots if not getattr(t, "excluded_from_generation", False)]
    if not active_timeslots:
        return ScheduleResponse(status="infeasible", message="No active timeslots available.", schedule=[])

    timeslots_by_id: Dict[str, Timeslot] = {t.id: t for t in active_timeslots}
    all_timeslot_ids: Set[str] = set(timeslots_by_id.keys())
    timeslot_units_by_id: Dict[str, int] = {t.id: _timeslot_45m_units(t) for t in active_timeslots}

    teachers_by_id = {t.id: t for t in data.teachers}
    subjects_by_id: Dict[str, Subject] = {s.id: s for s in data.subjects}

    class_to_base_room: Dict[str, str] = {}
    for cls in data.classes:
        if cls.base_room_id:
            class_to_base_room[cls.id] = cls.base_room_id

    subject_to_room: Dict[str, str] = {}
    for subject in data.subjects:
        for class_id in subject.class_ids:
            if class_id in class_to_base_room:
                subject_to_room[subject.id] = class_to_base_room[class_id]
                break

    block_to_timeslots: Dict[str, Set[str]] = {}
    for block in data.blocks:
        slot_set: Set[str] = set()
        has_occurrences = bool(block.occurrences)
        for occ in block.occurrences:
            slot_set |= (_timeslots_overlapping_occurrence(occ, active_timeslots) & all_timeslot_ids)
        if not has_occurrences:
            slot_set |= (set(block.timeslot_ids) & all_timeslot_ids)
        block_to_timeslots[block.id] = slot_set

    linked_block_ids: Dict[str, Set[str]] = defaultdict(set)
    for block in data.blocks:
        for entry in block.subject_entries:
            if entry.subject_id in subjects_by_id:
                linked_block_ids[entry.subject_id].add(block.id)
        for subject_id in block.subject_ids:
            if subject_id in subjects_by_id:
                linked_block_ids[subject_id].add(block.id)

    subject_effective_teacher_ids: Dict[str, List[str]] = {s.id: _subject_teacher_ids(s) for s in data.subjects}
    for block in data.blocks:
        for entry in block.subject_entries:
            if entry.subject_id in subject_effective_teacher_ids and entry.teacher_id and not subject_effective_teacher_ids[entry.subject_id]:
                subject_effective_teacher_ids[entry.subject_id] = [entry.teacher_id]

    teacher_meeting_unavailable: Dict[str, Set[str]] = defaultdict(set)
    for meeting in data.meetings:
        if meeting.timeslot_id not in all_timeslot_ids:
            continue
        for assignment in meeting.teacher_assignments:
            if assignment.teacher_id in teachers_by_id:
                teacher_meeting_unavailable[assignment.teacher_id].add(meeting.timeslot_id)

    class_occupied: Set[Tuple[str, str]] = set()
    teacher_occupied: Set[Tuple[str, str]] = set()
    schedule_items: List[ScheduledItem] = []
    reduced_tail_span_by_class_slot: Dict[Tuple[str, str], Tuple[str, str]] = {}
    class_day_load_units: Dict[Tuple[str, str], int] = defaultdict(int)

    day_period_bounds: Dict[str, Tuple[int, int]] = {}
    for ts in active_timeslots:
        if ts.day not in day_period_bounds:
            day_period_bounds[ts.day] = (ts.period, ts.period)
        else:
            min_p, max_p = day_period_bounds[ts.day]
            day_period_bounds[ts.day] = (min(min_p, ts.period), max(max_p, ts.period))

    def _slot_sort_key(ts_id: str) -> Tuple[str, int]:
        ts = timeslots_by_id[ts_id]
        return (ts.day, ts.period)

    block_subject_ids: Set[str] = set(linked_block_ids.keys())

    for block in data.blocks:
        block_slots = sorted(block_to_timeslots.get(block.id, set()), key=_slot_sort_key)
        if not block_slots:
            continue

        slot_span_by_id: Dict[str, Tuple[str, str]] = {}
        for occ in block.occurrences:
            matched_slots = _timeslots_overlapping_occurrence(occ, active_timeslots) & all_timeslot_ids
            for ts_id in matched_slots:
                slot_span_by_id[ts_id] = (occ.start_time, occ.end_time)

            occ_start = _to_minutes(occ.start_time)
            occ_end = _to_minutes(occ.end_time)
            if occ_start is None or occ_end is None:
                continue

            # If an occurrence spills into the beginning of the next slot,
            # keep only the last 45 minutes of that slot available for these classes.
            for ts_id in matched_slots:
                ts = timeslots_by_id[ts_id]
                ts_start = _to_minutes(ts.start_time)
                ts_end = _to_minutes(ts.end_time)
                if ts_start is None or ts_end is None or ts_end <= ts_start:
                    continue
                if not (occ_start < ts_start < occ_end < ts_end):
                    continue

                reduced_start_min = ts_end - 45
                if reduced_start_min < ts_start:
                    continue
                if occ_end > reduced_start_min:
                    continue

                reduced_span = (_minutes_to_hhmm(reduced_start_min), _minutes_to_hhmm(ts_end))
                for class_id in block.class_ids:
                    reduced_tail_span_by_class_slot[(class_id, ts_id)] = reduced_span

        # Block windows reserve class capacity regardless of which block subject lands there.
        for class_id in block.class_ids:
            for ts_id in block_slots:
                if (class_id, ts_id) in reduced_tail_span_by_class_slot:
                    continue
                class_occupied.add((class_id, ts_id))

        subject_ids_for_block: Set[str] = set()
        subject_ids_for_block |= {entry.subject_id for entry in block.subject_entries if entry.subject_id in subjects_by_id}
        subject_ids_for_block |= {subject_id for subject_id in block.subject_ids if subject_id in subjects_by_id}

        relevant_subject_ids: List[str] = []
        block_classes = set(block.class_ids or [])
        for subject_id in subject_ids_for_block:
            subject = subjects_by_id[subject_id]
            if not subject.class_ids or not block_classes or any(cid in block_classes for cid in subject.class_ids):
                relevant_subject_ids.append(subject_id)

        for subject_id in sorted(relevant_subject_ids):
            subject = subjects_by_id[subject_id]
            teacher_ids = subject_effective_teacher_ids.get(subject_id, _subject_teacher_ids(subject))
            primary_teacher_id = teacher_ids[0] if teacher_ids else ""
            min_units_from_blocks = _minimum_required_units_from_blocks(
                subject,
                all_timeslot_ids,
                active_timeslots,
                False,
                {b.id: b for b in data.blocks},
                linked_block_ids,
            )
            required_units = max(1, int(subject.sessions_per_week or 1), min_units_from_blocks)
            subject_requires_odd_units = (required_units % 2) == 1

            subject_allowed_slots = _compute_allowed_timeslots(subject, all_timeslot_ids, block_to_timeslots)
            candidate_slots = [ts_id for ts_id in block_slots if ts_id in subject_allowed_slots]

            # If this block effectively maps to one subject, that subject must occupy
            # every block slot (not just enough units to satisfy sessions_per_week).
            fill_all_block_slots = len(relevant_subject_ids) == 1
            if fill_all_block_slots:
                required_units = sum(timeslot_units_by_id.get(ts_id, 1) for ts_id in candidate_slots)

            units_placed = 0
            rendered_span_keys: Set[str] = set()
            for ts_id in candidate_slots:
                if any((teacher_id, ts_id) in teacher_occupied for teacher_id in teacher_ids):
                    continue

                custom_span = slot_span_by_id.get(ts_id)
                custom_start = custom_span[0] if custom_span else None
                custom_end = custom_span[1] if custom_span else None

                # Enforce reduced-tail parity rule in block path as well.
                if custom_start and custom_end:
                    reduced_spans_for_subject = {
                        reduced_tail_span_by_class_slot[(class_id, ts_id)]
                        for class_id in subject.class_ids
                        if (class_id, ts_id) in reduced_tail_span_by_class_slot
                    }
                    has_subject_reduced_tail = len(reduced_spans_for_subject) > 0
                    if has_subject_reduced_tail:
                        all_classes_in_tail = len(subject.class_ids) == sum(
                            1 for class_id in subject.class_ids if (class_id, ts_id) in reduced_tail_span_by_class_slot
                        )
                        if all_classes_in_tail and not subject_requires_odd_units:
                            continue

                should_render_item = True
                if custom_start and custom_end:
                    span_key = f"{timeslots_by_id[ts_id].day}|{custom_start}|{custom_end}"
                    if span_key in rendered_span_keys:
                        should_render_item = False
                    else:
                        rendered_span_keys.add(span_key)

                if should_render_item:
                    schedule_items.append(
                        ScheduledItem(
                            subject_id=subject.id,
                            subject_name=subject.name,
                            teacher_id=primary_teacher_id,
                            teacher_ids=teacher_ids,
                            class_ids=subject.class_ids,
                            timeslot_id=ts_id,
                            day=timeslots_by_id[ts_id].day,
                            period=timeslots_by_id[ts_id].period,
                            start_time=custom_start,
                            end_time=custom_end,
                            week_type=None,
                            room_id=subject_to_room.get(subject.id),
                        )
                    )

                for class_id in subject.class_ids:
                    if (class_id, ts_id) not in reduced_tail_span_by_class_slot:
                        class_occupied.add((class_id, ts_id))
                if teacher_ids and not any(
                    (class_id, ts_id) in reduced_tail_span_by_class_slot for class_id in subject.class_ids
                ):
                    for teacher_id in teacher_ids:
                        teacher_occupied.add((teacher_id, ts_id))

                units_placed += timeslot_units_by_id.get(ts_id, 1)
                for class_id in subject.class_ids:
                    class_day_load_units[(class_id, timeslots_by_id[ts_id].day)] += timeslot_units_by_id.get(ts_id, 1)
                if not fill_all_block_slots and units_placed >= required_units:
                    break

            if units_placed < required_units:
                return ScheduleResponse(
                    status="infeasible",
                    message=(
                        f"No valid schedule found for block subject '{subject.name}' ({subject.id}). "
                        f"Required {required_units}u in block windows, placed {units_placed}u."
                    ),
                    schedule=[],
                )

    # Step 2: meetings lock teacher availability for the rest of planning.
    for teacher_id, slot_ids in teacher_meeting_unavailable.items():
        for ts_id in slot_ids:
            teacher_occupied.add((teacher_id, ts_id))

    # Step 3: place all remaining subjects in currently available slots.
    remaining_subjects = [s for s in data.subjects if s.id not in block_subject_ids]
    remaining_subjects.sort(key=lambda s: int(s.sessions_per_week or 1), reverse=True)

    for subject in remaining_subjects:
        teacher_ids = subject_effective_teacher_ids.get(subject.id, _subject_teacher_ids(subject))
        primary_teacher_id = teacher_ids[0] if teacher_ids else ""
        required_units = max(1, int(subject.sessions_per_week or 1))
        subject_requires_odd_units = (required_units % 2) == 1
        allowed_slots = _compute_allowed_timeslots(subject, all_timeslot_ids, block_to_timeslots)

        for teacher_id in teacher_ids:
            if teacher_id in teachers_by_id:
                allowed_slots -= set(teachers_by_id[teacher_id].unavailable_timeslots)
                allowed_slots -= teacher_meeting_unavailable.get(teacher_id, set())

        candidate_slots = sorted(allowed_slots, key=_slot_sort_key)
        units_placed = 0

        subject_days_used: Set[str] = set()
        allow_same_day = "norsk vg3" in subject.name.lower()
        relaxed_same_day = allow_same_day

        while units_placed < required_units:
            remaining_units = required_units - units_placed

            feasible_candidates: List[Tuple[Tuple[int, int, int, int, str, int], str, str | None, str | None, int]] = []

            for ts_id in candidate_slots:
                if any((teacher_id, ts_id) in teacher_occupied for teacher_id in teacher_ids):
                    continue
                if any((class_id, ts_id) in class_occupied for class_id in subject.class_ids):
                    continue

                ts = timeslots_by_id[ts_id]
                if not relaxed_same_day and ts.day in subject_days_used:
                    continue

                reduced_spans = {
                    reduced_tail_span_by_class_slot[(class_id, ts_id)]
                    for class_id in subject.class_ids
                    if (class_id, ts_id) in reduced_tail_span_by_class_slot
                }
                has_partial_tail = len(reduced_spans) > 0
                if has_partial_tail:
                    # Only allow reduced-tail placement when all classes for this subject
                    # share the same reduced span.
                    if len(reduced_spans) != 1 or len(subject.class_ids) != sum(
                        1 for class_id in subject.class_ids if (class_id, ts_id) in reduced_tail_span_by_class_slot
                    ):
                        continue

                    # Partial 45-minute spillover slots are only meaningful for
                    # subjects with odd weekly unit totals, and only when the
                    # remaining required units are odd.
                    if not subject_requires_odd_units or (remaining_units % 2) == 0:
                        continue

                custom_start: str | None = None
                custom_end: str | None = None
                units_for_placement = timeslot_units_by_id.get(ts_id, 1)
                if has_partial_tail:
                    custom_start, custom_end = next(iter(reduced_spans))
                    units_for_placement = 1

                would_overshoot = 1 if units_for_placement > remaining_units else 0
                exact_fit_penalty = 0 if units_for_placement == remaining_units else 1

                day_load = 0
                if subject.class_ids:
                    day_load = sum(class_day_load_units[(class_id, ts.day)] for class_id in subject.class_ids)

                min_p, max_p = day_period_bounds.get(ts.day, (ts.period, ts.period))
                boundary_penalty = 1 if ts.period in {min_p, max_p} else 0

                score = (
                    would_overshoot,
                    exact_fit_penalty,
                    boundary_penalty,
                    day_load,
                    ts.day,
                    ts.period,
                )
                feasible_candidates.append((score, ts_id, custom_start, custom_end, units_for_placement))

            if not feasible_candidates:
                if not relaxed_same_day:
                    # If strict no-same-day blocks feasibility, relax only for this subject.
                    relaxed_same_day = True
                    continue
                break

            feasible_candidates.sort(key=lambda x: x[0])
            _, chosen_ts_id, chosen_start, chosen_end, chosen_units = feasible_candidates[0]
            chosen_ts = timeslots_by_id[chosen_ts_id]

            schedule_items.append(
                ScheduledItem(
                    subject_id=subject.id,
                    subject_name=subject.name,
                    teacher_id=primary_teacher_id,
                    teacher_ids=teacher_ids,
                    class_ids=subject.class_ids,
                    timeslot_id=chosen_ts_id,
                    day=chosen_ts.day,
                    period=chosen_ts.period,
                    start_time=chosen_start,
                    end_time=chosen_end,
                    week_type=None,
                    room_id=subject_to_room.get(subject.id),
                )
            )

            for class_id in subject.class_ids:
                class_occupied.add((class_id, chosen_ts_id))
                class_day_load_units[(class_id, chosen_ts.day)] += chosen_units
            for teacher_id in teacher_ids:
                teacher_occupied.add((teacher_id, chosen_ts_id))

            subject_days_used.add(chosen_ts.day)
            units_placed += chosen_units

        if units_placed < required_units:
            return ScheduleResponse(
                status="infeasible",
                message=(
                    f"No valid schedule found for remaining subject '{subject.name}' ({subject.id}). "
                    f"Required {required_units}u, placed {units_placed}u."
                ),
                schedule=[],
            )

    return ScheduleResponse(
        status="success",
        message="Schedule generated with staged planner (blocks -> meetings -> remaining subjects).",
        schedule=schedule_items,
    )


def generate_schedule(data: ScheduleRequest) -> ScheduleResponse:
    # Temporary full rehaul path requested by user.
    # Uses single-week staged generation to isolate A/B interactions.
    return _generate_schedule_staged(data)

    model = cp_model.CpModel()
    _solver_log("[RUN] generate_schedule", reset=True)

    def _duplicate_ids(values: List[str]) -> List[str]:
        seen: Set[str] = set()
        duplicates: Set[str] = set()
        for value in values:
            if value in seen:
                duplicates.add(value)
            else:
                seen.add(value)
        return sorted(duplicates)

    duplicate_subject_ids = _duplicate_ids([s.id for s in data.subjects])
    duplicate_teacher_ids = _duplicate_ids([t.id for t in data.teachers])
    duplicate_class_ids = _duplicate_ids([c.id for c in data.classes])
    duplicate_timeslot_ids = _duplicate_ids([t.id for t in data.timeslots])
    duplicate_block_ids = _duplicate_ids([b.id for b in data.blocks])

    duplicate_messages: List[str] = []
    if duplicate_subject_ids:
        duplicate_messages.append("subject ids: " + ", ".join(duplicate_subject_ids[:10]))
    if duplicate_teacher_ids:
        duplicate_messages.append("teacher ids: " + ", ".join(duplicate_teacher_ids[:10]))
    if duplicate_class_ids:
        duplicate_messages.append("class ids: " + ", ".join(duplicate_class_ids[:10]))
    if duplicate_timeslot_ids:
        duplicate_messages.append("timeslot ids: " + ", ".join(duplicate_timeslot_ids[:10]))
    if duplicate_block_ids:
        duplicate_messages.append("block ids: " + ", ".join(duplicate_block_ids[:10]))

    if duplicate_messages:
        message = "Duplicate IDs detected in input data: " + " | ".join(duplicate_messages)
        _solver_log("[INFEASIBLE] " + message)
        return ScheduleResponse(
            status="infeasible",
            message=message,
            schedule=[],
        )

    active_timeslots = [t for t in data.timeslots if not getattr(t, "excluded_from_generation", False)]
    timeslots_by_id: Dict[str, Timeslot] = {t.id: t for t in active_timeslots}
    timeslot_bounds_by_id: Dict[str, Tuple[int, int]] = {
        t.id: _timeslot_bounds_minutes(t) for t in active_timeslots
    }
    timeslot_units_by_id: Dict[str, int] = {
        t.id: _timeslot_45m_units(t) for t in active_timeslots
    }
    all_timeslot_ids = set(timeslots_by_id.keys())
    day_slot_ids: Dict[str, List[str]] = defaultdict(list)
    for timeslot in active_timeslots:
        day_slot_ids[timeslot.day].append(timeslot.id)
    for day in day_slot_ids:
        day_slot_ids[day].sort(key=lambda ts_id: timeslots_by_id[ts_id].period)
    teachers_by_id = {t.id: t for t in data.teachers}

    # Build class_id -> base_room_id mapping
    class_to_base_room: Dict[str, str] = {}
    for cls in data.classes:
        if cls.base_room_id:
            class_to_base_room[cls.id] = cls.base_room_id

    # Build subject_id -> room_id mapping (use first class's base room if available)
    subject_to_room: Dict[str, str] = {}
    for subject in data.subjects:
        if subject.class_ids:
            for class_id in subject.class_ids:
                if class_id in class_to_base_room:
                    subject_to_room[subject.id] = class_to_base_room[class_id]
                    break

    teacher_meeting_unavailable: Dict[str, Set[str]] = defaultdict(set)
    teacher_meeting_preferred: Dict[str, Set[str]] = defaultdict(set)
    for meeting in data.meetings:
        if meeting.timeslot_id not in all_timeslot_ids:
            continue
        for assignment in meeting.teacher_assignments:
            if assignment.teacher_id not in teachers_by_id:
                continue
            if assignment.mode == "unavailable":
                teacher_meeting_unavailable[assignment.teacher_id].add(meeting.timeslot_id)
            elif assignment.mode == "preferred":
                teacher_meeting_preferred[assignment.teacher_id].add(meeting.timeslot_id)

    block_to_timeslots: Dict[str, Set[str]] = {}
    for b in data.blocks:
        slot_set: Set[str] = set()
        has_occurrences = bool(b.occurrences)
        # New format: occurrences with day/time
        for occ in b.occurrences:
            slot_set |= _timeslots_overlapping_occurrence(occ, data.timeslots)
        # Legacy format: explicit timeslot_ids
        if not has_occurrences:
            for ts_id in b.timeslot_ids:
                if ts_id in all_timeslot_ids:
                    slot_set.add(ts_id)
        block_to_timeslots[b.id] = slot_set

    blocks_by_id: Dict[str, Block] = {b.id: b for b in data.blocks}

    linked_block_ids: Dict[str, Set[str]] = defaultdict(set)
    for block in data.blocks:
        # New format: subject_entries
        for se in block.subject_entries:
            linked_block_ids[se.subject_id].add(block.id)
        # Legacy format: subject_ids
        for subject_id in block.subject_ids:
            linked_block_ids[subject_id].add(block.id)

    # Augment block subjects with block bindings while preserving each subject's own class_ids.
    # Don't override sessions_per_week - let the solver use the subject's pre-defined value
    # and choose from the available block timeslots.
    block_subject_ids: Set[str] = set(linked_block_ids.keys())
    augmented_subjects: List[Subject] = []
    for subject in data.subjects:
        if subject.id not in block_subject_ids:
            augmented_subjects.append(subject)
            continue
        merged_block_ids: List[str] = list(subject.allowed_block_ids or [])
        teacher_override: str = subject.teacher_id
        for block in data.blocks:
            for se in block.subject_entries:
                if se.subject_id != subject.id:
                    continue
                if block.id not in merged_block_ids:
                    merged_block_ids.append(block.id)
                if se.teacher_id and not teacher_override:
                    teacher_override = se.teacher_id
        augmented_subjects.append(Subject(
            id=subject.id,
            name=subject.name,
            teacher_id=teacher_override,
            class_ids=list(subject.class_ids),
            subject_type=subject.subject_type,
            sessions_per_week=subject.sessions_per_week,
            allowed_timeslots=subject.allowed_timeslots,
            allowed_block_ids=merged_block_ids if merged_block_ids else None,
        ))
    data = ScheduleRequest(
        subjects=augmented_subjects,
        teachers=data.teachers,
        classes=data.classes,
        timeslots=data.timeslots,
        blocks=data.blocks,
        meetings=data.meetings,
        rooms=data.rooms,
        alternating_weeks_enabled=data.alternating_weeks_enabled,
        alternate_non_block_subjects=data.alternate_non_block_subjects,
    )

    # Ignore template-only subjects in the solver.
    # A subject is schedulable only if it belongs to at least one class
    # or is explicitly linked to one or more blocks.
    schedulable_subjects = [
        s for s in data.subjects
        if s.class_ids or (s.allowed_block_ids and len(s.allowed_block_ids) > 0) or s.id in block_subject_ids
    ]
    data = ScheduleRequest(
        subjects=schedulable_subjects,
        teachers=data.teachers,
        classes=data.classes,
        timeslots=data.timeslots,
        blocks=data.blocks,
        meetings=data.meetings,
        rooms=data.rooms,
        alternating_weeks_enabled=data.alternating_weeks_enabled,
        alternate_non_block_subjects=data.alternate_non_block_subjects,
    )

    week_labels = ["A", "B"] if data.alternating_weeks_enabled else ["base"]

    # Decision variable x[(subject_id, timeslot_id, week_label)] == 1 when subject is placed there.
    x: Dict[Tuple[str, str, str], cp_model.IntVar] = {}

    subject_allowed: Dict[str, List[str]] = {}
    subject_allowed_weeks: Dict[str, List[str]] = {}
    subject_sessions_required: Dict[str, int] = {}
    subject_total_units_across_weeks: Dict[str, int] = {}
    for subject in data.subjects:
        requested_units = max(1, int(subject.sessions_per_week or 1))
        block_min_units = _minimum_required_units_from_blocks(
            subject,
            all_timeslot_ids,
            data.timeslots,
            data.alternating_weeks_enabled,
            blocks_by_id,
            linked_block_ids,
        )
        # For block-linked subjects, required load should follow block coverage
        # (number of block-covered slots per week), not stale sessions_per_week values.
        if subject.id in block_subject_ids and block_min_units > 0:
            required_units = block_min_units
        else:
            required_units = max(requested_units, block_min_units)
        subject_sessions_required[subject.id] = required_units

        allowed = _compute_allowed_timeslots(subject, all_timeslot_ids, block_to_timeslots)

        teacher = teachers_by_id.get(subject.teacher_id)
        if teacher:
            allowed -= set(teacher.unavailable_timeslots)
            allowed -= teacher_meeting_unavailable.get(subject.teacher_id, set())

        allowed_list = sorted(allowed)
        subject_allowed[subject.id] = allowed_list

        allowed_weeks = sorted(
            _compute_allowed_weeks(
                subject,
                data.alternating_weeks_enabled,
                blocks_by_id,
                linked_block_ids,
            )
        )
        subject_allowed_weeks[subject.id] = allowed_weeks

        allowed_weeks_set = set(allowed_weeks)
        if data.alternating_weeks_enabled and allowed_weeks_set == {"A", "B"}:
            # In alternating mode with both weeks available:
            # - even n: n units in A and n in B (2n total)
            # - odd n: n units in heavy week, n-1 in light week (2n-1 total)
            if required_units % 2 == 0:
                subject_total_units_across_weeks[subject.id] = required_units * 2
            else:
                subject_total_units_across_weeks[subject.id] = required_units * 2 - 1
        else:
            subject_total_units_across_weeks[subject.id] = required_units

        if not allowed_list:
            return ScheduleResponse(
                status="infeasible",
                message=f"No valid timeslots for subject '{subject.name}' ({subject.id}).",
                schedule=[],
            )

        if not allowed_weeks:
            return ScheduleResponse(
                status="infeasible",
                message=f"No valid A/B week assignment for subject '{subject.name}' ({subject.id}).",
                schedule=[],
            )

        for timeslot_id in allowed_list:
            for week_label in week_labels:
                if week_label not in allowed_weeks:
                    continue
                x[(subject.id, timeslot_id, week_label)] = model.NewBoolVar(
                    f"subject_{subject.id}_timeslot_{timeslot_id}_week_{week_label}"
                )

    # Search guidance: prioritize block subjects first, then decisions in meeting slots.
    meeting_timeslot_ids = {
        meeting.timeslot_id for meeting in data.meetings if meeting.timeslot_id in all_timeslot_ids
    }
    block_priority_vars: List[cp_model.IntVar] = []
    meeting_priority_vars: List[cp_model.IntVar] = []
    remaining_priority_vars: List[cp_model.IntVar] = []
    for (subject_id, timeslot_id, _week_label), decision_var in x.items():
        if subject_id in block_subject_ids:
            block_priority_vars.append(decision_var)
        elif timeslot_id in meeting_timeslot_ids:
            meeting_priority_vars.append(decision_var)
        else:
            remaining_priority_vars.append(decision_var)

    if block_priority_vars:
        model.AddDecisionStrategy(
            block_priority_vars,
            cp_model.CHOOSE_FIRST,
            cp_model.SELECT_MAX_VALUE,
        )
    if meeting_priority_vars:
        model.AddDecisionStrategy(
            meeting_priority_vars,
            cp_model.CHOOSE_FIRST,
            cp_model.SELECT_MIN_VALUE,
        )
    if remaining_priority_vars:
        model.AddDecisionStrategy(
            remaining_priority_vars,
            cp_model.CHOOSE_FIRST,
            cp_model.SELECT_MAX_VALUE,
        )

    # Allow block subjects to run in parallel for classes inside their block windows.
    # key = (class_id, subject_id, timeslot_id, week_label)
    block_parallel_allowed_keys: Set[Tuple[str, str, str, str]] = set()
    # key = (subject_id, timeslot_id, week_label)
    block_subject_slot_week_keys: Set[Tuple[str, str, str]] = set()
    forced_zero_keys: Set[Tuple[str, str, str]] = set()
    forced_one_reasons: Dict[Tuple[str, str, str], str] = {}
    forced_zero_reasons: Dict[Tuple[str, str, str], str] = {}
    force_conflicts: List[str] = []
    subjects_by_id: Dict[str, Subject] = {s.id: s for s in data.subjects}

    def _subject_is_relevant_to_block(subject_id: str, block: Block) -> bool:
        subject = subjects_by_id.get(subject_id)
        if not subject:
            return False
        # Classless subjects are treated as globally relevant (shared offerings).
        if not subject.class_ids:
            return True
        block_classes = set(block.class_ids or [])
        if not block_classes:
            return True
        return any(class_id in block_classes for class_id in subject.class_ids)

    def _force_key(key: Tuple[str, str, str], value: int, reason: str) -> None:
        if key not in x:
            return
        if value == 1:
            conflict_reason = forced_zero_reasons.get(key)
            if conflict_reason:
                force_conflicts.append(
                    f"{key} forced to 1 by {reason} but already forced to 0 by {conflict_reason}"
                )
                return
            existing_reason = forced_one_reasons.get(key)
            if existing_reason:
                return
            model.Add(x[key] == 1)
            forced_one_reasons[key] = reason
            return

        conflict_reason = forced_one_reasons.get(key)
        if conflict_reason:
            force_conflicts.append(
                f"{key} forced to 0 by {reason} but already forced to 1 by {conflict_reason}"
            )
            return
        existing_reason = forced_zero_reasons.get(key)
        if existing_reason:
            return
        model.Add(x[key] == 0)
        forced_zero_keys.add(key)
        forced_zero_reasons[key] = reason

    for block in data.blocks:
        block_timeslot_ids = block_to_timeslots.get(block.id, set())
        if not block_timeslot_ids:
            continue
        has_occurrences = bool(block.occurrences)

        occ_week_by_slot: Dict[str, Set[str]] = defaultdict(set)
        for occ in block.occurrences:
            matched_slots = _timeslots_overlapping_occurrence(occ, data.timeslots)
            wt = (occ.week_type or "both").upper()
            if wt == "A":
                weeks_for_occ = {"A"} if data.alternating_weeks_enabled else {"base"}
            elif wt == "B":
                weeks_for_occ = {"B"} if data.alternating_weeks_enabled else {"base"}
            else:
                weeks_for_occ = {"A", "B"} if data.alternating_weeks_enabled else {"base"}
            for ts_id in matched_slots:
                occ_week_by_slot[ts_id] |= weeks_for_occ

        if not has_occurrences:
            legacy_active_weeks = _block_active_weeks(block, data.alternating_weeks_enabled)
            for ts_id in block.timeslot_ids:
                occ_week_by_slot[ts_id] |= legacy_active_weeks

        block_subject_set = {
            subject_id
            for subject_id in ({se.subject_id for se in block.subject_entries} | set(block.subject_ids))
            if _subject_is_relevant_to_block(subject_id, block)
        }
        for subject_id in block_subject_set:
            for timeslot_id, blocked_weeks in occ_week_by_slot.items():
                if timeslot_id not in all_timeslot_ids:
                    continue
                for week_label in blocked_weeks:
                    block_subject_slot_week_keys.add((subject_id, timeslot_id, week_label))
        for class_id in block.class_ids:
            for subject in data.subjects:
                if subject.id not in block_subject_set:
                    continue
                subject_applies_to_class = (not subject.class_ids) or (class_id in subject.class_ids)
                if not subject_applies_to_class:
                    continue
                for timeslot_id, blocked_weeks in occ_week_by_slot.items():
                    if timeslot_id not in all_timeslot_ids:
                        continue
                    for week_label in blocked_weeks:
                        block_parallel_allowed_keys.add((class_id, subject.id, timeslot_id, week_label))

    # Constraint 1: session load per subject.

    # When alternating weeks are enabled and both weeks are available:
    # - even load n (45-min units): same load in A and B weeks (fully mirrored)
    # - odd load n: one heavy week n and one light week n-1,
    #   where light-week slots must be a subset of heavy-week slots.
    for subject in data.subjects:
        # Block-linked subjects are fully governed by block constraints
        # (forced slot/week membership), so skip generic load equations
        # that can conflict with asymmetric A/B block patterns.
        if subject.id in block_subject_ids:
            continue

        required_units = subject_sessions_required[subject.id]
        allowed_weeks_set = set(subject_allowed_weeks[subject.id])
        allowed_slot_ids = subject_allowed[subject.id]

        if data.alternating_weeks_enabled and allowed_weeks_set == {"A", "B"}:
            vars_a = [
                x[(subject.id, t_id, "A")]
                for t_id in allowed_slot_ids
                if (subject.id, t_id, "A") in x
            ]
            vars_b = [
                x[(subject.id, t_id, "B")]
                for t_id in allowed_slot_ids
                if (subject.id, t_id, "B") in x
            ]

            max_units_a = sum(timeslot_units_by_id.get(t_id, 1) for t_id in allowed_slot_ids)
            max_units_b = sum(timeslot_units_by_id.get(t_id, 1) for t_id in allowed_slot_ids)

            if max_units_a < required_units or max_units_b < required_units:
                return ScheduleResponse(
                    status="infeasible",
                    message=(
                        f"Not enough valid load capacity for subject '{subject.name}' ({subject.id}) "
                        f"to place {required_units}x45 in alternating weeks."
                    ),
                    schedule=[],
                )

            units_sum_a = sum(
                timeslot_units_by_id.get(t_id, 1) * x[(subject.id, t_id, "A")]
                for t_id in allowed_slot_ids
                if (subject.id, t_id, "A") in x
            )
            units_sum_b = sum(
                timeslot_units_by_id.get(t_id, 1) * x[(subject.id, t_id, "B")]
                for t_id in allowed_slot_ids
                if (subject.id, t_id, "B") in x
            )

            explicit_split = _parse_alternating_week_split(getattr(subject, "alternating_week_split", None))
            if explicit_split is not None:
                lo, hi = sorted(explicit_split)
                if max_units_a < lo or max_units_b < lo or max(max_units_a, max_units_b) < hi:
                    return ScheduleResponse(
                        status="infeasible",
                        message=(
                            f"Not enough valid load capacity for subject '{subject.name}' ({subject.id}) "
                            f"to place explicit alternating split {lo}/{hi}x45."
                        ),
                        schedule=[],
                    )

                units_a_var = model.NewIntVar(0, max_units_a, f"units_a_{subject.id}")
                units_b_var = model.NewIntVar(0, max_units_b, f"units_b_{subject.id}")
                model.Add(units_a_var == units_sum_a)
                model.Add(units_b_var == units_sum_b)
                model.AddAllowedAssignments(
                    [units_a_var, units_b_var],
                    [(lo, hi), (hi, lo)],
                )
                continue

            unit_gcd = 0
            for t_id in allowed_slot_ids:
                if (subject.id, t_id, "A") in x or (subject.id, t_id, "B") in x:
                    u = max(1, timeslot_units_by_id.get(t_id, 1))
                    unit_gcd = u if unit_gcd == 0 else gcd(unit_gcd, u)
            unit_gcd = max(1, unit_gcd)

            if not data.alternate_non_block_subjects:
                # When non-block alternation is off, keep weekly load equal for even subjects,
                # but for odd subjects allow a light/heavy split across A/B so week-specific
                # lockouts do not create false infeasibility.
                if required_units % 2 == 0 and required_units % unit_gcd == 0:
                    model.Add(units_sum_a >= max(0, required_units - 1))
                    model.Add(units_sum_a <= required_units + 1)
                    model.Add(units_sum_b >= max(0, required_units - 1))
                    model.Add(units_sum_b <= required_units + 1)
                    model.Add(units_sum_a + units_sum_b == required_units * 2)
                else:
                    lower_week = max(0, required_units - 1)
                    if required_units % 2 == 1 and unit_gcd == 1:
                        upper_week = required_units
                    else:
                        # With coarse slot units (e.g. 2-unit slots), odd totals may require
                        # one week to go slightly above n to hit a representable two-week sum.
                        upper_week = required_units + 1
                    model.Add(units_sum_a >= lower_week)
                    model.Add(units_sum_a <= upper_week)
                    model.Add(units_sum_b >= lower_week)
                    model.Add(units_sum_b <= upper_week)

                    preferred_total = required_units * 2 - (1 if required_units % 2 == 1 else 0)
                    lower_total = (preferred_total // unit_gcd) * unit_gcd
                    upper_total = ((preferred_total + unit_gcd - 1) // unit_gcd) * unit_gcd
                    target_total = upper_total if (upper_total - preferred_total) <= (preferred_total - lower_total) else lower_total
                    model.Add(units_sum_a + units_sum_b == target_total)
            elif required_units % 2 == 0:
                if max_units_a < required_units or max_units_b < required_units:
                    return ScheduleResponse(
                        status="infeasible",
                        message=(
                            f"Not enough valid load capacity for subject '{subject.name}' ({subject.id}) "
                            f"to place {required_units}x45 in alternating weeks."
                        ),
                        schedule=[],
                    )
                # Even load: keep balanced across weeks but do not require exact n/n,
                # since strict equality can create false infeasibility under tight
                # block/week interactions.
                model.Add(units_sum_a >= max(0, required_units - 1))
                model.Add(units_sum_a <= required_units + 1)
                model.Add(units_sum_b >= max(0, required_units - 1))
                model.Add(units_sum_b <= required_units + 1)
                model.Add(units_sum_a + units_sum_b == required_units * 2)
            else:
                light_week_units = max(0, required_units - 1)
                # Odd load: prefer 2n-1 total units with each week in [n-1, n].
                if max(max_units_a, max_units_b) < required_units or min(max_units_a, max_units_b) < light_week_units:
                    return ScheduleResponse(
                        status="infeasible",
                        message=(
                            f"Not enough valid load capacity for subject '{subject.name}' ({subject.id}) "
                            f"to place {required_units}x45 in alternating weeks."
                        ),
                        schedule=[],
                    )

                # If slot units are coarse (e.g. only 2-unit slots), exact 2n-1 can be impossible.
                # In that case, target the nearest feasible total and allow one-week +/-1 around n.
                preferred_total = required_units * 2 - 1
                if preferred_total % unit_gcd == 0:
                    target_total = preferred_total
                    model.Add(units_sum_a >= light_week_units)
                    model.Add(units_sum_a <= required_units)
                    model.Add(units_sum_b >= light_week_units)
                    model.Add(units_sum_b <= required_units)
                else:
                    # Example: n=5 with 2-unit slots => target 10 with bounds [4,6].
                    lower_total = (preferred_total // unit_gcd) * unit_gcd
                    upper_total = ((preferred_total + unit_gcd - 1) // unit_gcd) * unit_gcd
                    target_total = upper_total if (upper_total - preferred_total) <= (preferred_total - lower_total) else lower_total
                    model.Add(units_sum_a >= max(0, required_units - 1))
                    model.Add(units_sum_a <= required_units + 1)
                    model.Add(units_sum_b >= max(0, required_units - 1))
                    model.Add(units_sum_b <= required_units + 1)

                model.Add(units_sum_a + units_sum_b == target_total)
        else:
            vars_for_subject = [
                x[(subject.id, t_id, week_label)]
                for t_id in allowed_slot_ids
                for week_label in subject_allowed_weeks[subject.id]
                if (subject.id, t_id, week_label) in x
            ]
            unit_gcd = 0
            for t_id in allowed_slot_ids:
                for week_label in subject_allowed_weeks[subject.id]:
                    if (subject.id, t_id, week_label) in x:
                        u = max(1, timeslot_units_by_id.get(t_id, 1))
                        unit_gcd = u if unit_gcd == 0 else gcd(unit_gcd, u)
            unit_gcd = max(1, unit_gcd)

            max_units = sum(
                timeslot_units_by_id.get(t_id, 1)
                for t_id in allowed_slot_ids
                for week_label in subject_allowed_weeks[subject.id]
                if (subject.id, t_id, week_label) in x
            )
            if max_units < required_units:
                return ScheduleResponse(
                    status="infeasible",
                    message=(
                        f"Not enough valid load capacity for subject '{subject.name}' ({subject.id}) "
                        f"to place {required_units}x45."
                    ),
                    schedule=[],
                )
            units_expr = sum(
                timeslot_units_by_id.get(t_id, 1) * x[(subject.id, t_id, week_label)]
                for t_id in allowed_slot_ids
                for week_label in subject_allowed_weeks[subject.id]
                if (subject.id, t_id, week_label) in x
            )
            if required_units % unit_gcd == 0:
                model.Add(units_expr == required_units)
            else:
                # Exact load can be impossible with coarse slots (e.g., only 2-unit slots).
                lower_target = (required_units // unit_gcd) * unit_gcd
                upper_target = ((required_units + unit_gcd - 1) // unit_gcd) * unit_gcd

                feasible_targets: List[int] = []
                if 0 <= lower_target <= max_units:
                    feasible_targets.append(lower_target)
                if 0 <= upper_target <= max_units and upper_target != lower_target:
                    feasible_targets.append(upper_target)

                if not feasible_targets:
                    return ScheduleResponse(
                        status="infeasible",
                        message=(
                            f"No representable load for subject '{subject.name}' ({subject.id}). "
                            f"Required {required_units}x45 but available slot granularity is {unit_gcd}x45."
                        ),
                        schedule=[],
                    )

                target_units = min(feasible_targets, key=lambda v: abs(v - required_units))
                model.Add(units_expr == target_units)

    # Constraint 2: a teacher cannot teach multiple subjects in the same timeslot,
    # except block-subject placements inside their own block-covered slots.
    for teacher in data.teachers:
        teacher_subjects = [s for s in data.subjects if s.teacher_id == teacher.id]
        for week_label in week_labels:
            for timeslot_id in all_timeslot_ids:
                vars_same_slot = [
                    x[(s.id, timeslot_id, week_label)]
                    for s in teacher_subjects
                    if (s.id, timeslot_id, week_label) not in block_subject_slot_week_keys
                    if (s.id, timeslot_id, week_label) in x
                ]
                if vars_same_slot:
                    model.Add(sum(vars_same_slot) <= 1)

    # Constraint 2b: cap teacher load by their workload percentage.
    teacher_max_units_by_week: Dict[Tuple[str, str], int] = {}
    teacher_workload_excess_terms: List[cp_model.IntVar] = []
    for teacher in data.teachers:
        teacher_subjects = [s for s in data.subjects if s.teacher_id == teacher.id]
        if not teacher_subjects:
            continue

        unavailable_slots = set(teacher.unavailable_timeslots)
        unavailable_slots |= teacher_meeting_unavailable.get(teacher.id, set())
        available_slot_ids = [
            ts_id
            for ts_id in all_timeslot_ids
            if ts_id not in unavailable_slots
        ]
        available_capacity_units = sum(timeslot_units_by_id.get(ts_id, 1) for ts_id in available_slot_ids)
        workload_percent = _normalize_workload_percent(getattr(teacher, "workload_percent", 100))
        max_units_for_week = (available_capacity_units * workload_percent) // 100

        for week_label in week_labels:
            teacher_max_units_by_week[(teacher.id, week_label)] = max_units_for_week
            teacher_units = [
                timeslot_units_by_id.get(timeslot_id, 1) * x[(subject.id, timeslot_id, week_label)]
                for subject in teacher_subjects
                for timeslot_id in subject_allowed[subject.id]
                if (subject.id, timeslot_id, week_label) not in block_subject_slot_week_keys
                if (subject.id, timeslot_id, week_label) in x
            ]
            if teacher_units:
                teacher_units_sum = model.NewIntVar(
                    0,
                    available_capacity_units,
                    f"teacher_units_sum_{teacher.id}_{week_label}",
                )
                model.Add(teacher_units_sum == sum(teacher_units))
                teacher_excess = model.NewIntVar(
                    0,
                    available_capacity_units,
                    f"teacher_workload_excess_{teacher.id}_{week_label}",
                )
                model.Add(teacher_excess >= teacher_units_sum - max_units_for_week)
                teacher_workload_excess_terms.append(teacher_excess)

    # Constraint 2c: cap teacher on-site span (first lesson start to last lesson end each day).
    # Weekly total is the sum of daily spans. Keep as a soft cap to avoid hard infeasibility.
    teacher_presence_minutes_by_week: Dict[Tuple[str, str], cp_model.IntVar] = {}
    teacher_presence_excess_terms: List[cp_model.IntVar] = []
    teacher_meeting_presence_by_day_week: Dict[Tuple[str, str, str], List[Tuple[int, int]]] = defaultdict(list)
    for meeting in data.meetings:
        if meeting.timeslot_id not in timeslots_by_id:
            continue
        timeslot = timeslots_by_id[meeting.timeslot_id]
        start_min, end_min = timeslot_bounds_by_id[meeting.timeslot_id]
        for assignment in meeting.teacher_assignments:
            if assignment.teacher_id not in teachers_by_id:
                continue
            # "preferred" meeting assignments are treated as fixed presence for on-site time.
            if assignment.mode != "preferred":
                continue
            for week_label in week_labels:
                teacher_meeting_presence_by_day_week[(assignment.teacher_id, timeslot.day, week_label)].append(
                    (start_min, end_min)
                )

    days = sorted({t.day for t in data.timeslots})
    for teacher in data.teachers:
        teacher_subjects = [s for s in data.subjects if s.teacher_id == teacher.id]
        workload_percent = _normalize_workload_percent(getattr(teacher, "workload_percent", 100))
        max_week_minutes = (MAX_WEEKLY_WORK_MINUTES_100_PERCENT * workload_percent) // 100

        for week_label in week_labels:
            day_span_vars: List[cp_model.IntVar] = []

            for day in days:
                slot_ids_for_day = day_slot_ids.get(day, [])
                subject_slot_literals: List[Tuple[cp_model.IntVar, int, int]] = []
                for subject in teacher_subjects:
                    for timeslot_id in slot_ids_for_day:
                        key = (subject.id, timeslot_id, week_label)
                        if key not in x:
                            continue
                        if key in block_subject_slot_week_keys:
                            continue
                        start_min, end_min = timeslot_bounds_by_id[timeslot_id]
                        subject_slot_literals.append((x[key], start_min, end_min))

                fixed_presence = teacher_meeting_presence_by_day_week.get((teacher.id, day, week_label), [])
                if not subject_slot_literals and not fixed_presence:
                    continue

                has_presence = model.NewBoolVar(f"teacher_presence_{teacher.id}_{week_label}_{day}")
                if fixed_presence:
                    model.Add(has_presence == 1)
                else:
                    lesson_literals = [literal for literal, _, _ in subject_slot_literals]
                    if lesson_literals:
                        model.Add(sum(lesson_literals) >= 1).OnlyEnforceIf(has_presence)
                        model.Add(sum(lesson_literals) == 0).OnlyEnforceIf(has_presence.Not())
                    else:
                        model.Add(has_presence == 0)

                min_candidates: List[cp_model.IntVar] = []
                max_candidates: List[cp_model.IntVar] = []
                for idx, (literal, start_min, end_min) in enumerate(subject_slot_literals):
                    min_candidate = model.NewIntVar(0, 24 * 60, f"mincand_{teacher.id}_{week_label}_{day}_{idx}")
                    max_candidate = model.NewIntVar(0, 24 * 60, f"maxcand_{teacher.id}_{week_label}_{day}_{idx}")
                    model.Add(min_candidate == start_min).OnlyEnforceIf(literal)
                    model.Add(min_candidate == 24 * 60).OnlyEnforceIf(literal.Not())
                    model.Add(max_candidate == end_min).OnlyEnforceIf(literal)
                    model.Add(max_candidate == 0).OnlyEnforceIf(literal.Not())
                    min_candidates.append(min_candidate)
                    max_candidates.append(max_candidate)

                for fixed_start_min, fixed_end_min in fixed_presence:
                    min_candidates.append(model.NewConstant(fixed_start_min))
                    max_candidates.append(model.NewConstant(fixed_end_min))

                if not min_candidates or not max_candidates:
                    continue

                day_start = model.NewIntVar(0, 24 * 60, f"day_start_{teacher.id}_{week_label}_{day}")
                day_end = model.NewIntVar(0, 24 * 60, f"day_end_{teacher.id}_{week_label}_{day}")
                model.AddMinEquality(day_start, min_candidates)
                model.AddMaxEquality(day_end, max_candidates)

                day_span = model.NewIntVar(0, 24 * 60, f"day_span_{teacher.id}_{week_label}_{day}")
                model.Add(day_span == day_end - day_start).OnlyEnforceIf(has_presence)
                model.Add(day_span == 0).OnlyEnforceIf(has_presence.Not())
                day_span_vars.append(day_span)

            if day_span_vars:
                total_week_span = model.NewIntVar(
                    0,
                    len(days) * 24 * 60,
                    f"week_span_{teacher.id}_{week_label}",
                )
                model.Add(total_week_span == sum(day_span_vars))
                teacher_presence_minutes_by_week[(teacher.id, week_label)] = total_week_span

        if data.alternating_weeks_enabled and "A" in week_labels and "B" in week_labels:
            week_a_span = teacher_presence_minutes_by_week.get((teacher.id, "A"), model.NewConstant(0))
            week_b_span = teacher_presence_minutes_by_week.get((teacher.id, "B"), model.NewConstant(0))
            total_span = model.NewIntVar(0, 2 * len(days) * 24 * 60, f"presence_total_{teacher.id}")
            model.Add(total_span == week_a_span + week_b_span)

            presence_excess = model.NewIntVar(0, 2 * len(days) * 24 * 60, f"presence_excess_{teacher.id}")
            model.Add(presence_excess >= total_span - (2 * max_week_minutes))
            teacher_presence_excess_terms.append(presence_excess)
        else:
            for week_label in week_labels:
                week_span = teacher_presence_minutes_by_week.get((teacher.id, week_label), model.NewConstant(0))
                presence_excess = model.NewIntVar(0, len(days) * 24 * 60, f"presence_excess_{teacher.id}_{week_label}")
                model.Add(presence_excess >= week_span - max_week_minutes)
                teacher_presence_excess_terms.append(presence_excess)

    # Constraint 3 + 6: each class has at most one subject in each timeslot,
    # except block-subject placements inside their own block-covered slots.
    # Multi-class subjects naturally block all involved classes at that timeslot.
    for school_class in data.classes:
        class_subjects = [s for s in data.subjects if school_class.id in s.class_ids]
        for week_label in week_labels:
            for timeslot_id in all_timeslot_ids:
                vars_same_slot = [
                    x[(s.id, timeslot_id, week_label)]
                    for s in class_subjects
                    if (s.id, timeslot_id, week_label) not in block_subject_slot_week_keys
                    if (school_class.id, s.id, timeslot_id, week_label) not in block_parallel_allowed_keys
                    if (s.id, timeslot_id, week_label) in x
                ]
                if vars_same_slot:
                    model.Add(sum(vars_same_slot) <= 1)

    # Constraint 7: block lock.
    # For classes attached to a block, non-block subjects are not allowed in that block's slots/weeks.
    # Also, block subject_entries fix their subjects to those slots.
    for block in data.blocks:
        block_timeslot_ids = block_to_timeslots.get(block.id, set())
        if not block_timeslot_ids:
            continue
        has_occurrences = bool(block.occurrences)

        # Build set of which week_labels are covered, per timeslot (from occurrences)
        # occ_week_by_slot: slot_id -> set of week_labels blocked by this block
        occ_week_by_slot: Dict[str, Set[str]] = defaultdict(set)
        for occ in block.occurrences:
            matched_slots = _timeslots_overlapping_occurrence(occ, data.timeslots)
            wt = (occ.week_type or "both").upper()
            if wt == "A":
                weeks_for_occ = {"A"} if data.alternating_weeks_enabled else {"base"}
            elif wt == "B":
                weeks_for_occ = {"B"} if data.alternating_weeks_enabled else set()
            else:
                weeks_for_occ = {"A", "B"} if data.alternating_weeks_enabled else {"base"}
            for ts_id in matched_slots:
                occ_week_by_slot[ts_id] |= weeks_for_occ

        # Legacy timeslot_ids: block all week_labels active for this block
        if not has_occurrences:
            legacy_active_weeks = _block_active_weeks(block, data.alternating_weeks_enabled)
            for ts_id in block.timeslot_ids:
                occ_week_by_slot[ts_id] |= legacy_active_weeks

        # Subject IDs that belong to this block (new + legacy)
        block_subject_set = {
            subject_id
            for subject_id in ({se.subject_id for se in block.subject_entries} | set(block.subject_ids))
            if _subject_is_relevant_to_block(subject_id, block)
        }

        # Ensure each block-covered slot/week is populated by at least one block subject.
        for timeslot_id, blocked_weeks in occ_week_by_slot.items():
            if timeslot_id not in all_timeslot_ids:
                continue
            for week_label in blocked_weeks:
                block_vars = [
                    x[(subject_id, timeslot_id, week_label)]
                    for subject_id in block_subject_set
                    if (subject_id, timeslot_id, week_label) in x
                ]
                if block_vars:
                    model.Add(sum(block_vars) >= 1)

        # If there is exactly one relevant block subject, force it into all covered
        # slot/week pairs. For multi-subject blocks, forcing every subject into every
        # slot can overconstrain the model; keep only the per-slot "at least one"
        # block-subject requirement above.
        if len(block_subject_set) == 1:
            only_subject_id = next(iter(block_subject_set))
            for timeslot_id, blocked_weeks in occ_week_by_slot.items():
                if timeslot_id not in all_timeslot_ids:
                    continue
                for week_label in blocked_weeks:
                    key = (only_subject_id, timeslot_id, week_label)
                    _force_key(key, 1, f"block {block.id} active slot")

        # Enforce occurrence week_type per slot for all block subjects, regardless of class_ids.
        # This prevents block subjects from leaking into the wrong A/B week when class_ids differ.
        block_subjects = [s for s in data.subjects if s.id in block_subject_set]
        for subject in block_subjects:
            for timeslot_id, blocked_weeks in occ_week_by_slot.items():
                if timeslot_id not in all_timeslot_ids:
                    continue
                for week_label in week_labels:
                    if week_label in blocked_weeks:
                        continue
                    key = (subject.id, timeslot_id, week_label)
                    _force_key(key, 0, f"block {block.id} inactive week")

        # Block windows are reserved for block subjects for participating classes.
        for class_id in block.class_ids:
            class_subjects = [s for s in data.subjects if class_id in s.class_ids]
            disallowed_subjects = [s for s in class_subjects if s.id not in block_subject_set]

            class_block_subject_ids = [
                subject_id
                for subject_id in block_subject_set
                if subject_id in subjects_by_id
                and (
                    not subjects_by_id[subject_id].class_ids
                    or class_id in subjects_by_id[subject_id].class_ids
                )
            ]

            for subject in disallowed_subjects:
                for timeslot_id, blocked_weeks in occ_week_by_slot.items():
                    if timeslot_id not in all_timeslot_ids:
                        continue
                    for week_label in blocked_weeks:
                        # Only reserve this window if the class actually has a block-subject
                        # option in the same slot/week.
                        has_relevant_block_option = any(
                            (bs_id, timeslot_id, week_label) in x
                            for bs_id in class_block_subject_ids
                        )
                        if not has_relevant_block_option:
                            continue
                        key = (subject.id, timeslot_id, week_label)
                        _force_key(key, 0, f"block {block.id} class lock for {class_id}")

    if force_conflicts:
        preview = " | ".join(force_conflicts[:5])
        _solver_log(f"[INFEASIBLE] Contradictory forced block assignments: {preview}")
        return ScheduleResponse(
            status="infeasible",
            message="Contradictory forced block assignments. " + preview,
            schedule=[],
        )

    # Post-lock feasibility guard:
    # After block lock constraints set many decisions to zero, some subjects may no longer
    # have enough remaining unit capacity to satisfy their required weekly load.
    subject_capacity_issues: List[str] = []
    for subject in data.subjects:
        if subject.id in block_subject_ids:
            continue

        required_units = subject_sessions_required[subject.id]
        allowed_weeks_set = set(subject_allowed_weeks[subject.id])

        def _max_units_for_week(week_label: str) -> int:
            return sum(
                timeslot_units_by_id.get(ts_id, 1)
                for ts_id in subject_allowed[subject.id]
                if (subject.id, ts_id, week_label) in x
                and (subject.id, ts_id, week_label) not in forced_zero_keys
            )

        if data.alternating_weeks_enabled and allowed_weeks_set == {"A", "B"}:
            max_a = _max_units_for_week("A")
            max_b = _max_units_for_week("B")

            if not data.alternate_non_block_subjects:
                if required_units % 2 == 0:
                    min_a = max(0, required_units - 1)
                    min_b = max(0, required_units - 1)
                else:
                    min_a = max(0, required_units - 1)
                    min_b = max(0, required_units - 1)
            elif required_units % 2 == 0:
                min_a = max(0, required_units - 1)
                min_b = max(0, required_units - 1)
            else:
                min_a = max(0, required_units - 1)
                min_b = max(0, required_units - 1)

            if max_a < min_a:
                subject_capacity_issues.append(
                    f"{subject.name} ({subject.id}) week A needs >= {min_a}u but has {max_a}u"
                )
            if max_b < min_b:
                subject_capacity_issues.append(
                    f"{subject.name} ({subject.id}) week B needs >= {min_b}u but has {max_b}u"
                )
        else:
            for week_label in subject_allowed_weeks[subject.id]:
                max_units = _max_units_for_week(week_label)
                if max_units < required_units:
                    subject_capacity_issues.append(
                        f"{subject.name} ({subject.id}) week {week_label} needs {required_units}u but has {max_units}u"
                    )

    if subject_capacity_issues:
        preview = " | ".join(subject_capacity_issues[:8])
        _solver_log(f"[INFEASIBLE] Subject capacity after block lock: {preview}")
        return ScheduleResponse(
            status="infeasible",
            message="No valid schedule found after block lock. " + preview,
            schedule=[],
        )

    # Optional optimization: spread subjects for each class across days.
    class_day_counts: Dict[Tuple[str, str], cp_model.IntVar] = {}
    day_imbalance_terms: List[cp_model.IntVar] = []
    preferred_avoid_penalty_vars: List[cp_model.IntVar] = []
    boundary_slot_penalty_vars: List[cp_model.IntVar] = []

    for school_class in data.classes:
        class_subjects = [
            s for s in data.subjects
            if school_class.id in s.class_ids and s.id not in block_subject_ids
        ]
        total_load = sum(subject_total_units_across_weeks.get(s.id, 0) for s in class_subjects)
        if not days:
            continue

        min_target = total_load // len(days)
        max_target = (total_load + len(days) - 1) // len(days)

        for day in days:
            day_timeslot_ids = [t.id for t in data.timeslots if t.day == day]
            day_count = model.NewIntVar(0, total_load, f"count_{school_class.id}_{day}")
            class_day_counts[(school_class.id, day)] = day_count

            vars_for_day = [
                timeslot_units_by_id.get(ts_id, 1) * x[(s.id, ts_id, week_label)]
                    for s in class_subjects
                for ts_id in day_timeslot_ids
                for week_label in week_labels
                if (s.id, ts_id, week_label) in x
            ]
            if vars_for_day:
                model.Add(day_count == sum(vars_for_day))
            else:
                model.Add(day_count == 0)

            under = model.NewIntVar(0, total_load, f"under_{school_class.id}_{day}")
            over = model.NewIntVar(0, total_load, f"over_{school_class.id}_{day}")
            model.Add(day_count + under >= min_target)
            model.Add(day_count - over <= max_target)
            day_imbalance_terms.extend([under, over])

    # Soft preference: avoid assigning too much only to first/last slot of each day.
    boundary_slot_ids: Set[str] = set()
    for day in days:
        day_slots = [t for t in data.timeslots if t.day == day]
        if not day_slots:
            continue
        sorted_day_slots = sorted(day_slots, key=lambda t: t.period)
        boundary_slot_ids.add(sorted_day_slots[0].id)
        boundary_slot_ids.add(sorted_day_slots[-1].id)

    if boundary_slot_ids:
        for subject in data.subjects:
            for timeslot_id in boundary_slot_ids:
                for week_label in week_labels:
                    key = (subject.id, timeslot_id, week_label)
                    if key in x:
                        boundary_slot_penalty_vars.append(x[key])

    # Soft preference: avoid orange (preferred_avoid_timeslots) when possible.
    for subject in data.subjects:
        if subject.id in block_subject_ids:
            continue
        teacher = teachers_by_id.get(subject.teacher_id)
        if not teacher:
            continue

        preferred_avoid = set(teacher.preferred_avoid_timeslots)
        preferred_avoid |= teacher_meeting_preferred.get(subject.teacher_id, set())
        if not preferred_avoid:
            continue

        for timeslot_id in preferred_avoid:
            for week_label in week_labels:
                key = (subject.id, timeslot_id, week_label)
                if key in x:
                    preferred_avoid_penalty_vars.append(x[key])

    objective_parts = []
    if day_imbalance_terms:
        objective_parts.append(DAY_IMBALANCE_WEIGHT * sum(day_imbalance_terms))
    if preferred_avoid_penalty_vars:
        # Keep this as a soft penalty but prioritize it above generic balancing.
        objective_parts.append(PREFERRED_AVOID_WEIGHT * sum(preferred_avoid_penalty_vars))
    if boundary_slot_penalty_vars:
        objective_parts.append(BOUNDARY_SLOT_WEIGHT * sum(boundary_slot_penalty_vars))
    if teacher_presence_excess_terms:
        objective_parts.append(TEACHER_PRESENCE_EXCESS_WEIGHT * sum(teacher_presence_excess_terms))
    if teacher_workload_excess_terms:
        objective_parts.append(TEACHER_WORKLOAD_EXCESS_WEIGHT * sum(teacher_workload_excess_terms))

    # Soft preference:
    # - For fellesfag (except Norsk vg3), prefer distributing lessons across different days.
    # - For Norsk vg3, prefer at least one 2x90 consecutive pair per week.
    fellesfag_same_day_excess_terms: List[cp_model.IntVar] = []
    norsk_vg3_no_double90_terms: List[cp_model.IntVar] = []

    for subject in data.subjects:
        is_fellesfag = subject.subject_type == "fellesfag"
        is_norsk_vg3 = is_fellesfag and ("norsk vg3" in (subject.name or "").lower())
        if not is_fellesfag:
            continue

        relevant_weeks = subject_allowed_weeks.get(subject.id, [])
        for week_label in relevant_weeks:
            if week_label not in week_labels:
                continue

            if is_norsk_vg3:
                pair_literals: List[cp_model.IntVar] = []
                for day, slot_ids in day_slot_ids.items():
                    ordered = sorted(slot_ids, key=lambda sid: timeslots_by_id[sid].period)
                    for i in range(len(ordered) - 1):
                        ts_a = timeslots_by_id[ordered[i]]
                        ts_b = timeslots_by_id[ordered[i + 1]]
                        if ts_a.period + 1 != ts_b.period:
                            continue
                        if timeslot_units_by_id.get(ts_a.id, 1) < 2 or timeslot_units_by_id.get(ts_b.id, 1) < 2:
                            continue
                        key_a = (subject.id, ts_a.id, week_label)
                        key_b = (subject.id, ts_b.id, week_label)
                        if key_a not in x or key_b not in x:
                            continue
                        if key_a in forced_zero_keys or key_b in forced_zero_keys:
                            continue

                        pair_lit = model.NewBoolVar(f"norsk_vg3_pair_{subject.id}_{week_label}_{day}_{i}")
                        model.Add(pair_lit <= x[key_a])
                        model.Add(pair_lit <= x[key_b])
                        model.Add(pair_lit >= x[key_a] + x[key_b] - 1)
                        pair_literals.append(pair_lit)

                if pair_literals:
                    no_pair = model.NewBoolVar(f"norsk_vg3_no_pair_{subject.id}_{week_label}")
                    model.Add(sum(pair_literals) >= 1).OnlyEnforceIf(no_pair.Not())
                    model.Add(sum(pair_literals) == 0).OnlyEnforceIf(no_pair)
                    norsk_vg3_no_double90_terms.append(no_pair)
                continue

            # Non-Norsk vg3 fellesfag: penalize additional lessons on same day.
            for day, slot_ids in day_slot_ids.items():
                day_literals = [
                    x[(subject.id, ts_id, week_label)]
                    for ts_id in slot_ids
                    if (subject.id, ts_id, week_label) in x
                    if (subject.id, ts_id, week_label) not in forced_zero_keys
                ]
                if len(day_literals) <= 1:
                    continue

                day_count = model.NewIntVar(0, len(day_literals), f"fellesfag_day_count_{subject.id}_{week_label}_{day}")
                model.Add(day_count == sum(day_literals))
                day_excess = model.NewIntVar(0, len(day_literals), f"fellesfag_day_excess_{subject.id}_{week_label}_{day}")
                model.Add(day_excess >= day_count - 1)
                fellesfag_same_day_excess_terms.append(day_excess)

    if fellesfag_same_day_excess_terms:
        objective_parts.append(FELLESFAG_SAME_DAY_PENALTY_WEIGHT * sum(fellesfag_same_day_excess_terms))
    if norsk_vg3_no_double90_terms:
        objective_parts.append(NORSK_VG3_NO_DOUBLE90_PENALTY_WEIGHT * sum(norsk_vg3_no_double90_terms))

    if objective_parts:
        model.Minimize(sum(objective_parts))

    def _lower_bound_units_for_week(subject: Subject, week_label: str) -> int:
        required_units = subject_sessions_required[subject.id]
        allowed_weeks = set(subject_allowed_weeks[subject.id])
        if week_label not in allowed_weeks:
            return 0
        if data.alternating_weeks_enabled and allowed_weeks == {"A", "B"}:
            if not data.alternate_non_block_subjects:
                if required_units % 2 == 0:
                    return required_units
                return max(0, required_units - 1)
            if required_units % 2 == 0:
                return required_units
            return max(0, required_units - 1)
        return required_units

    def _build_infeasibility_hints() -> List[str]:
        hints: List[str] = []

        def _max_flow(capacity: List[List[int]], source: int, sink: int) -> int:
            n = len(capacity)
            flow = 0
            parent = [-1] * n

            while True:
                for i in range(n):
                    parent[i] = -1
                parent[source] = source
                queue = [source]
                q_idx = 0

                while q_idx < len(queue) and parent[sink] == -1:
                    u = queue[q_idx]
                    q_idx += 1
                    for v in range(n):
                        if parent[v] == -1 and capacity[u][v] > 0:
                            parent[v] = u
                            queue.append(v)

                if parent[sink] == -1:
                    break

                aug = 10**9
                v = sink
                while v != source:
                    u = parent[v]
                    aug = min(aug, capacity[u][v])
                    v = u

                v = sink
                while v != source:
                    u = parent[v]
                    capacity[u][v] -= aug
                    capacity[v][u] += aug
                    v = u

                flow += aug

            return flow

        class_issues: List[str] = []
        class_tight: List[Tuple[int, str]] = []
        class_slot_issues: List[str] = []
        focus_class_subject_issues: List[str] = []
        focus_class_subject_tight: List[Tuple[int, str]] = []
        focus_class_names = {"2STB", "2STC", "2TID"}
        focus_classes_seen: Set[str] = set()
        for school_class in data.classes:
            class_subjects = [s for s in data.subjects if school_class.id in s.class_ids]
            is_focus_class = (school_class.name or "").strip().upper() in focus_class_names
            if is_focus_class:
                focus_classes_seen.add((school_class.name or "").strip())
            for week_label in week_labels:
                demand = 0
                feasible_slot_ids: Set[str] = set()
                subject_demands: List[Tuple[Subject, int, Set[str]]] = []

                for subject in class_subjects:
                    lb = _lower_bound_units_for_week(subject, week_label)
                    if lb <= 0:
                        continue

                    consuming_slot_ids = {
                        ts_id
                        for ts_id in subject_allowed[subject.id]
                        if (subject.id, ts_id, week_label) in x
                        and (subject.id, ts_id, week_label) not in forced_zero_keys
                        and (school_class.id, subject.id, ts_id, week_label) not in block_parallel_allowed_keys
                    }
                    if not consuming_slot_ids:
                        if is_focus_class:
                            focus_class_subject_issues.append(
                                f"{school_class.name} ({week_label}) subject {subject.name} ({subject.id}): "
                                f"needs >= {lb}u, feasible 0u"
                            )
                        continue

                    demand += lb
                    feasible_slot_ids |= consuming_slot_ids
                    subject_demands.append((subject, lb, consuming_slot_ids))

                    if is_focus_class:
                        subject_capacity = sum(
                            timeslot_units_by_id.get(ts_id, 1)
                            for ts_id in consuming_slot_ids
                        )
                        focus_class_subject_tight.append(
                            (
                                subject_capacity - lb,
                                f"{school_class.name} ({week_label}) subject {subject.name} ({subject.id}): "
                                f"demand {lb}u / feasible {subject_capacity}u",
                            )
                        )
                        if subject_capacity < lb:
                            focus_class_subject_issues.append(
                                f"{school_class.name} ({week_label}) subject {subject.name} ({subject.id}): "
                                f"needs >= {lb}u, feasible {subject_capacity}u"
                            )

                capacity = sum(timeslot_units_by_id.get(ts_id, 1) for ts_id in feasible_slot_ids)
                if demand > 0:
                    class_tight.append((capacity - demand, f"class {school_class.name} ({week_label}): demand {demand}u / capacity {capacity}u"))
                if demand > capacity:
                    class_issues.append(
                        f"class {school_class.name} ({week_label}): demand {demand}u > feasible capacity {capacity}u"
                    )

                # Stronger necessary condition: can subject-level demands fit available class slots
                # given each subject's own allowed slot set?
                if subject_demands and feasible_slot_ids:
                    slot_list = sorted(feasible_slot_ids)
                    subj_count = len(subject_demands)
                    slot_count = len(slot_list)
                    source = 0
                    subj_offset = 1
                    slot_offset = subj_offset + subj_count
                    sink = slot_offset + slot_count
                    graph_size = sink + 1
                    cap = [[0 for _ in range(graph_size)] for _ in range(graph_size)]

                    for i, (_subject, lb, allowed_slots) in enumerate(subject_demands):
                        subj_node = subj_offset + i
                        cap[source][subj_node] = lb
                        for j, ts_id in enumerate(slot_list):
                            if ts_id not in allowed_slots:
                                continue
                            slot_units = max(1, timeslot_units_by_id.get(ts_id, 1))
                            cap[subj_node][slot_offset + j] = slot_units

                    for j, ts_id in enumerate(slot_list):
                        slot_units = max(1, timeslot_units_by_id.get(ts_id, 1))
                        cap[slot_offset + j][sink] = slot_units

                    max_assignable = _max_flow(cap, source, sink)
                    if max_assignable < demand:
                        class_slot_issues.append(
                            f"class {school_class.name} ({week_label}): subject-slot fit {max_assignable}u < demand {demand}u"
                        )

        if class_issues:
            hints.append("Class bottlenecks: " + "; ".join(class_issues[:5]))
        elif class_tight:
            class_tight_sorted = sorted(class_tight, key=lambda x: x[0])
            hints.append("Tightest classes: " + "; ".join(msg for _, msg in class_tight_sorted[:5]))

        if class_slot_issues:
            hints.append("Class slot bottlenecks: " + "; ".join(class_slot_issues[:5]))
        if focus_class_subject_issues:
            hints.append("Focus class subject fit: " + "; ".join(focus_class_subject_issues[:8]))
        elif focus_class_subject_tight:
            focus_sorted = sorted(focus_class_subject_tight, key=lambda x: x[0])
            hints.append("Focus class tightest subjects: " + "; ".join(msg for _, msg in focus_sorted[:8]))
        else:
            if focus_classes_seen:
                hints.append(
                    "Focus class scan: matched " + ", ".join(sorted(focus_classes_seen)) +
                    " but no subject demand survived filters"
                )
            else:
                hints.append("Focus class scan: no class-name match for 2STB/2STC/2TID")

        teacher_issues: List[str] = []
        teacher_tight: List[Tuple[int, str]] = []
        teacher_slot_issues: List[str] = []
        teacher_subject_slot_issues: List[str] = []
        teacher_block_load_info: List[str] = []
        for teacher in data.teachers:
            teacher_subjects = [s for s in data.subjects if s.teacher_id == teacher.id]
            if not teacher_subjects:
                continue
            for week_label in week_labels:
                constrained_subjects = [s for s in teacher_subjects if s.id not in block_subject_ids]
                block_subjects_for_teacher = [s for s in teacher_subjects if s.id in block_subject_ids]

                demand = sum(_lower_bound_units_for_week(s, week_label) for s in constrained_subjects)
                block_demand = sum(_lower_bound_units_for_week(s, week_label) for s in block_subjects_for_teacher)
                capacity = teacher_max_units_by_week.get((teacher.id, week_label), 0)
                if demand > 0:
                    teacher_tight.append((capacity - demand, f"teacher {teacher.name} ({week_label}): demand {demand}u / capacity {capacity}u"))
                if demand > capacity:
                    teacher_issues.append(
                        f"teacher {teacher.name} ({week_label}): demand {demand} > unit capacity {capacity}"
                    )

                if block_demand > 0:
                    teacher_block_load_info.append(
                        f"teacher {teacher.name} ({week_label}) block-load {block_demand}u (checked by block rules)"
                    )

                feasible_slot_ids: Set[str] = set()
                subject_demands: List[Tuple[Subject, int, Set[str]]] = []
                for subject in constrained_subjects:
                    lb = _lower_bound_units_for_week(subject, week_label)
                    if lb <= 0:
                        continue
                    consuming_slot_ids: Set[str] = set()
                    for ts_id in subject_allowed[subject.id]:
                        key = (subject.id, ts_id, week_label)
                        if key not in x:
                            continue
                        if key in block_subject_slot_week_keys:
                            continue
                        if key in forced_zero_keys:
                            continue
                        feasible_slot_ids.add(ts_id)
                        consuming_slot_ids.add(ts_id)
                    if consuming_slot_ids:
                        subject_demands.append((subject, lb, consuming_slot_ids))

                slot_capacity_units = sum(timeslot_units_by_id.get(ts_id, 1) for ts_id in feasible_slot_ids)
                if demand > slot_capacity_units:
                    teacher_slot_issues.append(
                        f"teacher {teacher.name} ({week_label}): demand {demand}u > feasible slot capacity {slot_capacity_units}u"
                    )

                if subject_demands and feasible_slot_ids:
                    slot_list = sorted(feasible_slot_ids)
                    subj_count = len(subject_demands)
                    slot_count = len(slot_list)
                    source = 0
                    subj_offset = 1
                    slot_offset = subj_offset + subj_count
                    sink = slot_offset + slot_count
                    graph_size = sink + 1
                    cap = [[0 for _ in range(graph_size)] for _ in range(graph_size)]

                    for i, (_subject, lb, allowed_slots) in enumerate(subject_demands):
                        subj_node = subj_offset + i
                        cap[source][subj_node] = lb
                        for j, ts_id in enumerate(slot_list):
                            if ts_id not in allowed_slots:
                                continue
                            slot_units = max(1, timeslot_units_by_id.get(ts_id, 1))
                            cap[subj_node][slot_offset + j] = slot_units

                    for j, ts_id in enumerate(slot_list):
                        slot_units = max(1, timeslot_units_by_id.get(ts_id, 1))
                        cap[slot_offset + j][sink] = slot_units

                    max_assignable = _max_flow(cap, source, sink)
                    if max_assignable < demand:
                        teacher_subject_slot_issues.append(
                            f"teacher {teacher.name} ({week_label}): subject-slot fit {max_assignable}u < demand {demand}u"
                        )

        if teacher_issues:
            hints.append("Teacher bottlenecks: " + "; ".join(teacher_issues[:5]))
        elif teacher_tight:
            teacher_tight_sorted = sorted(teacher_tight, key=lambda x: x[0])
            hints.append("Tightest teachers: " + "; ".join(msg for _, msg in teacher_tight_sorted[:5]))

        if teacher_slot_issues:
            hints.append("Teacher slot bottlenecks: " + "; ".join(teacher_slot_issues[:5]))
        if teacher_subject_slot_issues:
            hints.append("Teacher subject-slot bottlenecks: " + "; ".join(teacher_subject_slot_issues[:5]))
        elif teacher_block_load_info:
            hints.append("Teacher block-load info: " + "; ".join(teacher_block_load_info[:5]))

        block_issues: List[str] = []
        for block in data.blocks:
            has_occurrences = bool(block.occurrences)
            occ_week_by_slot: Dict[str, Set[str]] = defaultdict(set)

            for occ in block.occurrences:
                matched_slots = _timeslots_overlapping_occurrence(occ, data.timeslots)
                wt = (occ.week_type or "both").upper()
                if wt == "A":
                    weeks_for_occ = {"A"} if data.alternating_weeks_enabled else {"base"}
                elif wt == "B":
                    weeks_for_occ = {"B"} if data.alternating_weeks_enabled else set()
                else:
                    weeks_for_occ = {"A", "B"} if data.alternating_weeks_enabled else {"base"}
                for ts_id in matched_slots:
                    if ts_id in all_timeslot_ids:
                        occ_week_by_slot[ts_id] |= weeks_for_occ

            if not has_occurrences:
                legacy_active_weeks = _block_active_weeks(block, data.alternating_weeks_enabled)
                for ts_id in block.timeslot_ids:
                    if ts_id in all_timeslot_ids:
                        occ_week_by_slot[ts_id] |= legacy_active_weeks

            block_subject_set = {
                subject_id
                for subject_id in ({se.subject_id for se in block.subject_entries} | set(block.subject_ids))
                if _subject_is_relevant_to_block(subject_id, block)
            }

            for timeslot_id, blocked_weeks in occ_week_by_slot.items():
                for week_label in blocked_weeks:
                    eligible = [
                        subject_id
                        for subject_id in block_subject_set
                        if (subject_id, timeslot_id, week_label) in x
                        and (subject_id, timeslot_id, week_label) not in forced_zero_keys
                    ]
                    if not eligible:
                        ts = timeslots_by_id.get(timeslot_id)
                        day = ts.day if ts else "?"
                        period = ts.period if ts else "?"
                        block_issues.append(
                            f"block {block.name} has no eligible subject at {day} p{period} ({week_label})"
                        )

        if block_issues:
            hints.append("Block eligibility issues: " + "; ".join(block_issues[:5]))

        return hints

    print("[DEBUG] === Pre-solve summary ===")
    _solver_log("[DEBUG] === Pre-solve summary ===")
    print(f"[DEBUG] alternating_weeks_enabled={data.alternating_weeks_enabled}, week_labels={week_labels}")
    _solver_log(f"[DEBUG] alternating_weeks_enabled={data.alternating_weeks_enabled}, week_labels={week_labels}")
    for subject in data.subjects:
        line = (
            f"[DEBUG] subject={subject.id!r} name={subject.name!r} teacher={subject.teacher_id!r}"
            f" class_ids={subject.class_ids} allowed_block_ids={subject.allowed_block_ids}"
            f" sessions_req={subject_sessions_required[subject.id]}"
            f" allowed_weeks={subject_allowed_weeks[subject.id]}"
            f" allowed_slots({len(subject_allowed[subject.id])})={subject_allowed[subject.id]}"
        )
        print(line)
        _solver_log(line)
    print(f"[DEBUG] block_parallel_allowed_keys ({len(block_parallel_allowed_keys)}):")
    _solver_log(f"[DEBUG] block_parallel_allowed_keys ({len(block_parallel_allowed_keys)}):")
    for key in sorted(block_parallel_allowed_keys):
        line = f"  {key}"
        print(line)
        _solver_log(line)
    print(f"[DEBUG] block_to_timeslots:")
    _solver_log("[DEBUG] block_to_timeslots:")
    for bid, slots in block_to_timeslots.items():
        line = f"  {bid}: {sorted(slots)}"
        print(line)
        _solver_log(line)
    forced_line = f"[DEBUG] forced_zero_keys={len(forced_zero_keys)}"
    print(forced_line)
    _solver_log(forced_line)

    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = 60.0
    solver.parameters.num_search_workers = 8
    solver.parameters.search_branching = cp_model.FIXED_SEARCH

    status = solver.Solve(model)
    status_line = f"[SOLVER] status={status} (OPTIMAL={cp_model.OPTIMAL}, FEASIBLE={cp_model.FEASIBLE}, INFEASIBLE={cp_model.INFEASIBLE}, UNKNOWN={cp_model.UNKNOWN})"
    print(status_line)
    _solver_log(status_line)

    if status == cp_model.UNKNOWN:
        return ScheduleResponse(
            status="infeasible",
            message="Schedule generation timed out. Try removing some constraints or reducing the number of subjects.",
            schedule=[],
        )

    if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        hints = _build_infeasibility_hints()
        message = "No valid schedule found for the provided constraints. [diag:v2]"
        if hints:
            message = message + " " + " | ".join(hints)
        print("[INFEASIBLE]", message)
        _solver_log(f"[INFEASIBLE] {message}")
        return ScheduleResponse(
            status="infeasible",
            message=message,
            schedule=[],
        )

    schedule_items: List[ScheduledItem] = []
    for subject in data.subjects:
        for timeslot_id in subject_allowed[subject.id]:
            if data.alternating_weeks_enabled and set(subject_allowed_weeks[subject.id]) == {"A", "B"}:
                key_a = (subject.id, timeslot_id, "A")
                key_b = (subject.id, timeslot_id, "B")
                in_a = key_a in x and solver.Value(x[key_a]) == 1
                in_b = key_b in x and solver.Value(x[key_b]) == 1

                if not in_a and not in_b:
                    continue

                ts = timeslots_by_id[timeslot_id]
                if in_a and in_b:
                    schedule_items.append(
                        ScheduledItem(
                            subject_id=subject.id,
                            subject_name=subject.name,
                            teacher_id=subject.teacher_id,
                            class_ids=subject.class_ids,
                            timeslot_id=timeslot_id,
                            day=ts.day,
                            period=ts.period,
                            week_type=None,
                            room_id=subject_to_room.get(subject.id),
                        )
                    )
                elif in_a:
                    schedule_items.append(
                        ScheduledItem(
                            subject_id=subject.id,
                            subject_name=subject.name,
                            teacher_id=subject.teacher_id,
                            class_ids=subject.class_ids,
                            timeslot_id=timeslot_id,
                            day=ts.day,
                            period=ts.period,
                            week_type="A",
                            room_id=subject_to_room.get(subject.id),
                        )
                    )
                else:
                    schedule_items.append(
                        ScheduledItem(
                            subject_id=subject.id,
                            subject_name=subject.name,
                            teacher_id=subject.teacher_id,
                            class_ids=subject.class_ids,
                            timeslot_id=timeslot_id,
                            day=ts.day,
                            period=ts.period,
                            week_type="B",
                            room_id=subject_to_room.get(subject.id),
                        )
                    )
            else:
                for week_label in subject_allowed_weeks[subject.id]:
                    if (subject.id, timeslot_id, week_label) in x and solver.Value(
                        x[(subject.id, timeslot_id, week_label)]
                    ) == 1:
                        ts = timeslots_by_id[timeslot_id]
                        schedule_items.append(
                            ScheduledItem(
                                subject_id=subject.id,
                                subject_name=subject.name,
                                teacher_id=subject.teacher_id,
                                class_ids=subject.class_ids,
                                timeslot_id=timeslot_id,
                                day=ts.day,
                                period=ts.period,
                                week_type=None if week_label == "base" else week_label,
                                room_id=subject_to_room.get(subject.id),
                            )
                        )

    schedule_items.sort(
        key=lambda item: (
            item.week_type or "",
            item.day,
            item.period,
            item.subject_name,
        )
    )

    preferred_avoid_by_teacher = {
        teacher.id: set(teacher.preferred_avoid_timeslots) for teacher in data.teachers
    }
    preferred_avoid_assignments = sum(
        1
        for item in schedule_items
        if item.timeslot_id in preferred_avoid_by_teacher.get(item.teacher_id, set())
    )

    # Assign rooms to schedule items
    subjects_by_id = {s.id: s for s in data.subjects}
    schedule_items = _assign_rooms_to_schedule(
        schedule_items,
        data,
        subjects_by_id,
        class_to_base_room,
    )

    return ScheduleResponse(
        status="success",
        message="Schedule generated successfully.",
        schedule=schedule_items,
        metadata={
            "objective_value": float(solver.ObjectiveValue()) if objective_parts else 0.0,
            "wall_time_seconds": solver.WallTime(),
            "preferred_avoid_assignments": preferred_avoid_assignments,
        },
    )
